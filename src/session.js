/* Session: peer lifecycle, reconnection, message routing, and the send/receive
   state machines. Symmetric — either peer may offer a batch at any time. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.session = (function () {
  const P = DL.protocol;
  const ID_PREFIX = 'dropline-';

  const RETRY_DELAYS = [800, 1600, 3200, 6000, 10000];

  const DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // TURN credentials, if configured, are short-lived and fetched at runtime so
  // nothing long-lived is baked into a public static file.
  async function iceServers() {
    const cfg = (typeof window !== 'undefined' && window.DROPLINE_CONFIG) || {};
    const base = (cfg.iceServers && cfg.iceServers.length) ? cfg.iceServers.slice() : DEFAULT_ICE.slice();
    if (!cfg.turnCredentialsUrl) return base;
    try {
      // Bounded: this sits in front of every session, so a slow or dead
      // endpoint must not become a slow or dead app.
      const res = await fetch(cfg.turnCredentialsUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(cfg.turnTimeoutMs || 4000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint || data.error || `turn endpoint ${res.status}`);
      const extra = data.iceServers || (data.urls ? [data] : []);
      if (!extra.length) throw new Error('turn endpoint returned no iceServers');
      return base.concat(extra);
    } catch (err) {
      // A missing relay costs reliability, not correctness — carry on with
      // STUN. Roughly 10-20% of network pairs will fail to connect without it.
      console.warn('dropline: TURN unavailable, continuing with STUN only —', err.message || err);
      return base;
    }
  }

  function peerOptions(ice) {
    const cfg = (typeof window !== 'undefined' && window.DROPLINE_CONFIG) || {};
    const opts = { debug: 1, config: { iceServers: ice } };
    if (cfg.peerServer) Object.assign(opts, cfg.peerServer);
    return opts;
  }

  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  function newSessionId() {
    return DL.util.newId(ID_PREFIX, rand);
  }

  // The fragment is never sent to a server, so a secret placed there is shared
  // by the two people holding the link and by nobody else -- including the
  // broker, which only ever learns the peer id.
  function newSecret() {
    return Array.from(rand(16), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function digest(text) {
    const data = new TextEncoder().encode(text);
    return hex(await crypto.subtle.digest('SHA-256', data));
  }

  // Short, human-comparable confirmation that both ends hold the same secret.
  async function shortCode(secret) {
    const d = await digest(`dropline-code:${secret}`);
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let out = '';
    for (let i = 0; i < 4; i++) out += alphabet[parseInt(d.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
    return out;
  }

  // A small ring of recent protocol events. Costs nothing, and turns "it
  // didn't connect" into something answerable without a redeploy.
  const trace = [];
  function note(event, detail) {
    trace.push({ t: Date.now(), event, ...detail });
    if (trace.length > 120) trace.shift();
  }

  function create(options) {
    const on = options.on || {};
    const isHost = options.role === 'host';
    const hostId = isHost ? newSessionId() : options.hostId;
    const secret = isHost ? newSecret() : (options.secret || null);

    // With no secret in the link (an older link, or one hand-edited) the
    // session still works but cannot be authenticated. Say so rather than
    // implying a guarantee that is not there.
    let authed = !secret;
    let myNonce = null;

    let peer = null;
    let conn = null;
    let closed = false;
    let retry = 0;
    let helloSeen = false;

    // Outbound gate, driven by the far end's hold/go.
    const gate = {
      held: false,
      waiter: null,
      hold() { this.held = true; },
      release() {
        this.held = false;
        if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
      },
      async wait() {
        while (this.held && !closed) {
          await new Promise((resolve) => { this.waiter = resolve; });
        }
      },
    };

    // Inbound backpressure bookkeeping.
    const inbound = { held: false, sink: null };

    // Striped payload transport; null until the extra channels are open, and
    // everything falls back to the single control channel if they never are.
    let stripeWriter = null;
    let stripeReader = null;
    let stripeCount = 0;
    let beginAckWaiter = null;

    const outQueue = [];
    let sending = false;

    let offer = null;   // batch awaiting the user's decision
    let incoming = null; // batch being received

    const emit = (name, ...args) => { if (on[name]) on[name](...args); };
    const live = () => !!conn && conn.open && !closed;

    /* ── connection lifecycle ── */

    async function start() {
      const ice = await iceServers();
      if (closed) return;

      peer = isHost ? new Peer(hostId, peerOptions(ice)) : new Peer(peerOptions(ice));

      peer.on('open', () => {
        if (isHost) {
          emit('link', `${location.origin}${location.pathname}#${hostId}~${secret}`, hostId);
          emit('status', 'waiting');
        } else {
          dial();
        }
      });

      peer.on('connection', (incomingConn) => {
        if (!isHost) return;
        if (conn && conn.open) { incomingConn.on('open', () => incomingConn.close()); return; }
        adopt(incomingConn);
      });

      peer.on('disconnected', () => {
        if (closed) return;
        emit('status', 'reconnecting');
        try { peer.reconnect(); } catch { /* destroyed underneath us */ }
      });

      peer.on('error', (err) => {
        if (closed) return;
        const type = err && err.type;
        if (type === 'unavailable-id' && isHost) { emit('error', 'That session id is taken. Reload to get a new one.'); return; }
        if (type === 'peer-unavailable') { scheduleRetry(); return; }
        if (type === 'network' || type === 'socket-error' || type === 'server-error') { scheduleRetry(); return; }
        emit('error', `Connection problem (${type || 'unknown'}).`);
      });
    }

    function dial() {
      note('dial', { retry });
      if (closed || !peer || peer.destroyed) return;
      emit('status', retry ? 'reconnecting' : 'connecting');
      // 'raw' hands bytes straight to the data channel. The default 'binary'
      // mode BinaryPacks every message and re-splits it into 16 KB pieces,
      // which undoes the negotiated chunk size and costs a full encode/decode
      // pass per chunk. The key really is 'raw' -- PeerJS registers no
      // serializer under 'none', and asking for one throws at connect time.
      adopt(peer.connect(hostId, { reliable: true, serialization: 'raw' }));
    }

    function scheduleRetry() {
      if (closed || isHost) return;
      if (retry >= RETRY_DELAYS.length) {
        emit('status', 'failed');
        emit('error', 'Could not reach the other device. They may have closed the tab.');
        return;
      }
      const wait = RETRY_DELAYS[retry++];
      emit('status', 'reconnecting', wait);
      setTimeout(() => { if (!closed) dial(); }, wait);
    }

    function adopt(c) {
      conn = c;
      let chain = Promise.resolve();
      let handshakeDone = false;
      shieldWhenReady(c);

      c.on('open', async () => {
        note('open', { role: isHost ? 'host' : 'guest', repeat: handshakeDone });
        if (handshakeDone) { flushOutbox(); return; }   // never redo the handshake
        handshakeDone = true;
        retry = 0;
        helloSeen = false;
        authed = !secret;
        gate.release();
        c.send(P.hello(options.name || 'someone', DL.stripe.countFor()));

        if (secret) {
          myNonce = newSecret();
          c.send(P.auth(myNonce));
          emit('code', await shortCode(secret));
        }

        setupStripes(c);

        flushOutbox();
        emit('status', 'connected');
        describeLink().then((link) => { if (link) emit('link-quality', link); });
        setTimeout(() => describeLink().then((l) => { if (l) emit('link-quality', l); }), 2500);
        pump(); // anything queued while disconnected
      });

      // Serialised: converting a Blob is async, and overlapping handlers would
      // enqueue chunks out of order and silently corrupt a file.
      c.on('data', (data) => {
        chain = chain.then(() => route(data)).catch((err) => {
          emit('error', `Transfer failed: ${err && err.message ? err.message : err}`);
        });
      });

      c.on('close', () => {
        note('close');
        if (closed) return;
        failActiveTransfers('The connection dropped.');
        conn = null;
        gate.release();
        if (isHost) emit('status', 'waiting');
        else scheduleRetry();
      });

      c.on('error', () => { /* close follows; handled there */ });
    }

    // PeerJS's negotiator installs pc.ondatachannel and treats whatever
    // arrives as *its* connection's channel, re-initialising the
    // DataConnection and re-firing 'open'. Our stripe channels would each
    // trigger that, which both restarts the handshake and hands PeerJS the
    // wrong channel to send control messages on. Keep ours away from it;
    // addEventListener listeners still fire, so collection is unaffected.
    function shieldPeerJs(c) {
      const pc = c && c.peerConnection;
      if (!pc || pc.__droplineShielded) return !!pc;
      pc.__droplineShielded = true;

      // Capture whatever PeerJS has already installed, then take ownership of
      // the property so later assignments land in `inner` instead of the
      // platform's handler slot. The wrapper is registered explicitly, because
      // once the accessor is overridden the platform no longer dispatches to
      // the on-property itself.
      let inner = pc.ondatachannel;
      const wrapper = (ev) => {
        const label = ev && ev.channel && ev.channel.label;
        if (label && label.startsWith(DL.stripe.LABEL)) return;   // ours, not PeerJS's
        if (typeof inner === 'function') inner.call(pc, ev);
      };

      Object.defineProperty(pc, 'ondatachannel', {
        configurable: true,
        get() { return inner; },
        set(fn) { inner = fn; },
      });
      pc.addEventListener('datachannel', wrapper);
      return true;
    }

    // peerConnection may not exist the instant a connection is created, and
    // the shield has to be in place before any stripe channel arrives.
    function shieldWhenReady(c) {
      if (shieldPeerJs(c)) return;
      let tries = 0;
      const timer = setInterval(() => {
        if (shieldPeerJs(c) || ++tries > 40) clearInterval(timer);
      }, 25);
    }

    // One side creates the channels and the other adopts them; both may then
    // send, since a data channel is duplex. Failure here is not fatal -- the
    // transfer simply runs on the control channel as before.
    function setupStripes(c) {
      const pc = c.peerConnection;
      if (!pc) return;
      shieldPeerJs(c);
      stripeCount = DL.stripe.countFor();

      const attach = (channels) => {
        if (!channels) return;
        stripeWriter = DL.stripe.writer(channels, { high: 2 * 1024 * 1024 });
        stripeReader = DL.stripe.reader(channels, (chunk) => {
          if (incoming && incoming.sink) incoming.sink.enqueue(chunk);
        });
        emit('transport', { stripes: channels.length });
      };

      if (isHost) {
        DL.stripe.create(pc, stripeCount)
          .then(attach)
          .catch(() => { stripeCount = 0; });
      } else {
        DL.stripe.collect(pc, stripeCount, attach);
      }
    }

    function failActiveTransfers(reason) {
      if (incoming) {
        try { incoming.sink && incoming.sink.error(new Error(reason)); } catch { /* already gone */ }
        incoming.items.forEach((it) => {
          if (it.state === 'active') emit('item', { ...it, state: 'failed', detail: reason });
        });
        incoming = null;
      }
      sending = false;
    }

    async function describeLink() {
      try {
        const pc = conn && conn.peerConnection;
        if (!pc || !pc.getStats) return null;
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
        });
        if (!pair) return null;
        let local = null;
        let remote = null;
        stats.forEach((r) => {
          if (r.id === pair.localCandidateId) local = r;
          if (r.id === pair.remoteCandidateId) remote = r;
        });
        const relayed = (local && local.candidateType === 'relay')
          || (remote && remote.candidateType === 'relay');
        return {
          relayed: !!relayed,
          rtt: typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null,
          localType: local ? local.candidateType : null,
          remoteType: remote ? remote.candidateType : null,
        };
      } catch {
        return null;
      }
    }

    /* ── inbound ── */

    async function route(raw) {
      if (typeof raw !== 'string') {
        if (!incoming || !incoming.sink) return;
        const view = await DL.transfer.toBytes(raw);
        if (!view) return;
        incoming.sink.enqueue(view);
        if (!inbound.held && incoming.sink.desiredSize !== null && incoming.sink.desiredSize <= 0) {
          inbound.held = true;
          send(P.hold());
        }
        return;
      }

      const msg = P.parse(raw);
      if (!msg) { note('rx-unparsed'); return; }
      note('rx', { type: msg.t });

      switch (msg.t) {
        case P.T.HELLO:
          helloSeen = true;
          emit('peer', { name: msg.name, version: msg.v });
          break;

        case P.T.AUTH:
          if (secret && typeof msg.nonce === 'string') {
            send(P.proof(await digest(`${secret}:${msg.nonce}`)));
          }
          break;

        case P.T.PROOF: {
          // Ignore anything we did not ask for: a late reply from a previous
          // connection is not an impostor, and tearing the session down for
          // one would be worse than the problem.
          if (!secret || !myNonce) break;
          const want = await digest(`${secret}:${myNonce}`);
          myNonce = null;
          if (msg.value === want) {
            note('auth-ok');
            authed = true;
            emit('authenticated', true);
          } else {
            note('auth-mismatch', { got: String(msg.value).slice(0, 8), want: want.slice(0, 8) });
            emit('error', 'The other device could not prove it holds this link.');
            close();
          }
          break;
        }

        case P.T.HOLD: gate.hold(); break;
        case P.T.GO:   gate.release(); break;

        case P.T.MANIFEST:
          if (!authed) { send(P.decline(msg.batchId, 'unauthenticated')); break; }
          offer = {
            batchId: msg.batchId,
            items: msg.items.map((it) => ({ ...it, dir: 'in', state: 'offered', done: 0 })),
          };
          emit('offer', offer);
          break;

        case P.T.ACCEPT:
          if (pendingOut && pendingOut.batchId === msg.batchId) {
            pendingOut.resolve(true);
            pendingOut = null;
          }
          break;

        case P.T.DECLINE:
          if (pendingOut && pendingOut.batchId === msg.batchId) {
            pendingOut.resolve(false);
            pendingOut = null;
          }
          break;

        case P.T.TEXT: {
          const item = incoming && incoming.items.find((i) => i.id === msg.itemId);
          const name = item ? item.name : 'Text';
          emit('item', { id: msg.itemId, dir: 'in', kind: 'text', name, body: msg.body, state: 'done', size: msg.body.length });
          break;
        }

        case P.T.BEGIN:
          await beginItem(msg.itemId);
          send(P.beginAck(msg.itemId));   // control and payload are separate
          break;                          // channels; never assume an order

        case P.T.BEGIN_ACK:
          if (beginAckWaiter) { const w = beginAckWaiter; beginAckWaiter = null; w(); }
          break;
        case P.T.END:   await endItem(msg.itemId, msg.crc, msg.bytes, msg.chunks); break;

        case P.T.DONE:
          if (incoming) { emit('batchDone', incoming); incoming = null; }
          break;

        case P.T.BYE:
          emit('status', 'closed');
          break;

        default: break;
      }
    }

    async function beginItem(itemId) {
      if (!incoming) return;
      const item = incoming.items.find((i) => i.id === itemId);
      if (!item) return;

      incoming.current = item;
      item.state = 'active';
      item.startedAt = Date.now();
      emit('item', { ...item });

      let sink = null;
      const readable = new ReadableStream(
        { start(c) { sink = c; } },
        new ByteLengthQueuingStrategy({ highWaterMark: DL.device.profile.watermark }),
      );
      incoming.sink = sink;
      inbound.sink = sink;
      inbound.held = false;
      if (stripeReader) stripeReader.reset();

      const tick = DL.util.throttle(() => emit('item', { ...item }), DL.device.profile.repaintMs);

      item.crc = DL.util.crcInit();

      let stream = readable;
      if (item.gzip) stream = stream.pipeThrough(new DecompressionStream('gzip'));

      // Checksum after decompression, so this hashes the same plaintext the
      // sender hashed before compressing it.
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) {
          item.done += chunk.byteLength;
          item.crc = DL.util.crcUpdate(item.crc, chunk);
          tick();
          if (inbound.held && inbound.sink && inbound.sink.desiredSize > 0) {
            inbound.held = false;
            send(P.go());
          }
          ctrl.enqueue(chunk);
        },
      }));

      let blob = null;
      const dest = await DL.transfer.sinkFor(incoming.dest, item, (b) => { blob = b; });
      incoming.pipe = stream.pipeTo(dest).then(() => {
        item.blob = blob;
        item.elapsed = (Date.now() - item.startedAt) / 1000;
        item.savedToDisk = incoming.dest.kind !== 'seal';
        // State is settled in endItem, once the sender's checksum has arrived.
      });
    }

    async function endItem(itemId, expectedCrc, expectedBytes, chunkCount) {
      if (!incoming) return;

      // Payload rode the stripes, so wait for the reported number of chunks to
      // be reassembled before closing the stream.
      if (stripeReader && typeof chunkCount === 'number') {
        await Promise.race([
          stripeReader.complete(chunkCount),
          new Promise((r) => setTimeout(r, 15000)),
        ]);
      }
      const item = incoming.items.find((i) => i.id === itemId);

      if (incoming.sink) {
        try { incoming.sink.close(); } catch { /* already closed */ }
        incoming.sink = null;
      }
      inbound.sink = null;
      if (inbound.held) { inbound.held = false; send(P.go()); }

      try {
        await incoming.pipe;
      } catch {
        if (item) emit('item', { ...item, state: 'failed', detail: 'Could not write the file.' });
        return;
      }
      if (!item) return;

      // The transport is reliable and ordered, so a mismatch means a bug on one
      // side rather than a lossy link — which is exactly why it is worth
      // checking. Silent corruption is the one failure nobody notices.
      const got = DL.util.crcFinal(item.crc);
      const sizeOk = expectedBytes === undefined || item.done === expectedBytes;
      const crcOk = expectedCrc === undefined || got === expectedCrc;

      if (crcOk && sizeOk) {
        item.state = 'done';
        item.verified = expectedCrc !== undefined;
      } else {
        item.state = 'failed';
        item.detail = sizeOk
          ? 'Checksum mismatch — the file arrived corrupted.'
          : `Incomplete — expected ${expectedBytes} bytes, got ${item.done}.`;
      }
      emit('item', { ...item });
    }

    // Called from a click: the file pickers need a user gesture.
    async function acceptOffer(opts) {
      if (!offer) return;
      const files = offer.items.filter((i) => i.kind === 'file');
      // Auto-accept has no user gesture, so no picker may be opened; those
      // transfers land via the sealing path and a download link.
      const dest = (opts && opts.silent)
        ? { kind: 'seal' }
        : await DL.transfer.chooseDestination(files);
      if (!dest) return; // cancelled — leave the offer standing
      incoming = { ...offer, dest, sink: null, pipe: null };
      offer = null;
      send(P.accept(incoming.batchId));
      emit('accepted', incoming);
    }

    function declineOffer() {
      if (!offer) return;
      send(P.decline(offer.batchId, 'declined'));
      emit('declined', offer);
      offer = null;
    }

    /* ── outbound ── */

    let pendingOut = null;

    // Control messages can be produced before the channel reports open --
    // a peer's auth challenge routinely arrives first -- and dropping them
    // silently strands the handshake. Queue instead, and flush on open.
    const outbox = [];

    function send(raw) {
      let type = '?';
      try { type = JSON.parse(raw).t; } catch { /* not control */ }
      if (live()) { note('tx', { type }); conn.send(raw); return; }
      if (!closed) { note('queued', { type }); outbox.push(raw); }
    }

    function flushOutbox() {
      while (outbox.length && live()) conn.send(outbox.shift());
    }

    function enqueue(entries) {
      outQueue.push(entries);
      pump();
    }

    async function pump() {
      if (sending || !outQueue.length || !live()) return;
      sending = true;
      const entries = outQueue.shift();

      try {
        await sendBatch(entries);
      } catch (err) {
        emit('error', `Send failed: ${err && err.message ? err.message : err}`);
        entries.forEach((e) => emit('item', {
          id: e.tempId, dir: 'out', kind: e.kind, name: e.name, size: e.size,
          state: 'failed', detail: 'Send failed.',
        }));
      } finally {
        sending = false;
        if (outQueue.length) pump();
      }
    }

    async function sendBatch(entries) {
      const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const withGzip = entries.map((e) => ({
        ...e,
        gzip: e.kind === 'file' && DL.util.shouldCompress(e.mime, e.size, DL.transfer.HAS_GZIP),
      }));
      const { items, wire } = P.manifest(batchId, withGzip);

      items.forEach((it) => emit('item', { ...it, dir: 'out', state: 'offered', done: 0 }));
      send(wire);

      const accepted = await new Promise((resolve) => {
        pendingOut = { batchId, resolve };
        setTimeout(() => {
          if (pendingOut && pendingOut.batchId === batchId) { pendingOut = null; resolve(false); }
        }, 120000);
      });

      if (!accepted) {
        items.forEach((it) => emit('item', { ...it, dir: 'out', state: 'declined' }));
        return;
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = withGzip[i];
        if (!live()) throw new Error('connection lost');

        if (item.kind === 'text') {
          send(P.text(item.id, entry.body));
          emit('item', { ...item, dir: 'out', state: 'done', done: item.size, body: entry.body });
          continue;
        }

        const started = Date.now();
        emit('item', { ...item, dir: 'out', state: 'active', done: 0 });
        const tick = DL.util.throttle(
          (n) => emit('item', { ...item, dir: 'out', state: 'active', done: n }),
          DL.device.profile.repaintMs);

        // The receiver must be listening before payload starts, because it
        // travels on different channels from this message.
        const acked = new Promise((resolve) => { beginAckWaiter = resolve; });
        send(P.begin(item.id));
        await Promise.race([acked, new Promise((r) => setTimeout(r, 8000))]);
        beginAckWaiter = null;

        const sctp = conn.peerConnection && conn.peerConnection.sctp;
        const chunkSize = Math.min(
          DL.util.chunkSize(sctp && sctp.maxMessageSize),
          DL.device.profile.chunkCap,
        );

        const write = stripeWriter
          ? (buf) => stripeWriter.send(buf)
          : (buf) => { conn.send(buf); };

        const { wire: onWire, crc, chunks } = await DL.transfer.pumpFile(entry.file, {
          gzip: entry.gzip,
          flow: gate,
          isLive: live,
          onProgress: tick,
          chunkSize,
          write,
        });

        if (stripeWriter) await stripeWriter.flush();
        send(P.end(item.id, crc, item.size, stripeWriter ? chunks : undefined));

        emit('item', {
          ...item, dir: 'out', state: 'done', done: item.size,
          elapsed: (Date.now() - started) / 1000, wire: onWire,
        });
      }

      send(P.done(batchId));
      emit('batchSent', items);
    }

    /* ── public surface ── */

    // Accepts either prepared entries (with a relative path) or bare Files.
    function sendFiles(input) {
      const entries = Array.from(input).map((e) => (e && e.file ? e : {
        kind: 'file', file: e, name: e.name, size: e.size, mime: e.type, path: '',
      }));
      if (entries.length) enqueue(entries);
      return entries.length;
    }

    function sendText(body) {
      if (!body || !body.trim()) return 0;
      const trimmed = body.slice(0, 100000);
      enqueue([{ kind: 'text', body: trimmed, name: 'Text snippet', size: trimmed.length, mime: 'text/plain' }]);
      return 1;
    }

    function close() {
      closed = true;
      try { send(P.bye()); } catch { /* connection already gone */ }
      try { if (peer) peer.destroy(); } catch { /* already destroyed */ }
      peer = null;
      conn = null;
    }

    start();

    return {
      sendFiles, sendText, acceptOffer, declineOffer, close,
      get hostId() { return hostId; },
      get secret() { return secret; },
      get authenticated() { return authed; },
      get trace() { return trace.slice(); },
      describeLink,
      get connected() { return live() && helloSeen; },
    };
  }

  // `#dropline-<id>~<secret>` — the secret half never leaves the browser.
  function parseHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw.startsWith(ID_PREFIX)) return null;
    const cut = raw.indexOf('~');
    return cut === -1
      ? { hostId: raw, secret: null }
      : { hostId: raw.slice(0, cut), secret: raw.slice(cut + 1) || null };
  }

  return { create, ID_PREFIX, newSessionId, newSecret, shortCode, parseHash, DEFAULT_ICE };
})();
