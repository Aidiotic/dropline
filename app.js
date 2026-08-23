/* dropline — browser-to-browser file transfer over a WebRTC data channel.
 *
 * The file is streamed, never buffered whole:
 *   sender    File.stream() -> [gzip] -> re-chunk -> data channel
 *   receiver  data channel -> [gunzip] -> File System Access writable (-> disk)
 *
 * That keeps memory flat regardless of file size, and lets the receiver write
 * straight to disk instead of holding a Blob. Where the File System Access API
 * is missing (Firefox, Safari) it falls back to assembling a Blob in memory.
 *
 * Chunk size is negotiated from the peer connection's SCTP maxMessageSize
 * rather than hard-coded, which on current browsers is 256 KB instead of 64.
 */

const SIGNAL = {
  // PeerJS's free public broker. Only ever sees the handshake, never the file.
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

const ID_PREFIX = 'dropline-';
const MIN_CHUNK = 16 * 1024;
const MAX_CHUNK = 256 * 1024;
const GZIP_FLOOR = 8 * 1024; // below this the header costs more than it saves

// Already-compressed formats: running them through gzip burns CPU for nothing.
const PACKED = /^(image\/(?!svg)|video\/|audio\/)|^application\/(zip|gzip|x-7z|x-rar|x-xz|x-bzip2|epub)/;

const HAS_COMPRESSION = typeof CompressionStream === 'function';
const HAS_FS_ACCESS = typeof window.showSaveFilePicker === 'function';

const $ = (id) => document.getElementById(id);

const els = {
  panels: ['panel-pick', 'panel-share', 'panel-receive', 'panel-error'].map($),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  qr: $('qr'),
  shareName: $('share-name'),
  shareSub: $('share-sub'),
  shareLink: $('share-link'),
  shareHandoff: $('share-handoff'),
  shareStatus: $('share-status'),
  shareProgress: $('share-progress'),
  copyBtn: $('copy-btn'),
  sendFill: $('send-fill'),
  sendStatus: $('send-status'),
  recvName: $('recv-name'),
  recvSub: $('recv-sub'),
  recvProgress: $('recv-progress'),
  recvFill: $('recv-fill'),
  recvStatus: $('recv-status'),
  acceptBtn: $('accept-btn'),
  saveLink: $('save-link'),
  errorMsg: $('error-msg'),
};

let peer = null;
let objectUrl = null;

/* ── helpers ──────────────────────────────────────────────────── */

const show = (id) => els.panels.forEach((p) => { p.hidden = p.id !== id; });

function bytes(n) {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function live(el, text) {
  el.innerHTML = '<span class="dot"></span>';
  el.append(text);
}

function fail(message) {
  els.errorMsg.textContent = message;
  show('panel-error');
}

function newId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alike glyphs
  const rand = crypto.getRandomValues(new Uint8Array(12));
  return ID_PREFIX + Array.from(rand, (b) => alphabet[b % alphabet.length]).join('');
}

function teardown() {
  if (peer) { peer.destroy(); peer = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

// PeerJS hands binary back as ArrayBuffer, Blob or a view depending on browser.
async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// Counts bytes flowing past a point in a pipeline without buffering them.
const meter = (onCount) => new TransformStream({
  transform(chunk, ctrl) { onCount(chunk.byteLength); ctrl.enqueue(chunk); },
});

// At 100 MB/s a chunk lands every few ms; repainting that often is what would
// actually make the transfer slow. Cap the DOM writes to ~15/second.
function throttle(fn, ms = 66) {
  let last = 0;
  return () => {
    const now = performance.now();
    if (now - last < ms) return;
    last = now;
    fn();
  };
}

function drawQr(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  const n = qr.getModuleCount();
  const quiet = 2;
  const span = n + quiet * 2;
  let path = '';

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  els.qr.innerHTML =
    `<svg viewBox="0 0 ${span} ${span}" xmlns="http://www.w3.org/2000/svg" ` +
    `shape-rendering="crispEdges" role="img"><path d="${path}" fill="currentColor"/></svg>`;
}

/* ── sending ──────────────────────────────────────────────────── */

function startSharing(file) {
  teardown();

  const gzip = HAS_COMPRESSION && file.size > GZIP_FLOOR && !PACKED.test(file.type || '');

  els.shareName.textContent = file.name;
  els.shareSub.textContent = bytes(file.size) + (gzip ? ' · compressed in flight' : '');
  els.shareHandoff.hidden = false;
  els.shareProgress.hidden = true;
  els.sendFill.classList.remove('done');
  els.sendFill.style.width = '0';
  els.shareLink.value = '';
  els.qr.innerHTML = '';
  live(els.shareStatus, 'Opening a line…');
  show('panel-share');

  const id = newId();
  let claimed = false;
  peer = new Peer(id, SIGNAL);

  peer.on('open', () => {
    const url = `${location.origin}${location.pathname}#${id}`;
    els.shareLink.value = url;
    drawQr(url);
    live(els.shareStatus, 'Waiting for someone to open it');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') { startSharing(file); return; } // reroll
    fail(`Could not reach the signalling server (${err.type}). Check your connection and try again.`);
  });

  peer.on('connection', (conn) => {
    if (claimed) { conn.on('open', () => conn.close()); return; } // one per link
    claimed = true;

    conn.on('open', () => {
      live(els.shareStatus, 'Connected — waiting for them to accept');
      conn.send(JSON.stringify({
        kind: 'meta', name: file.name, size: file.size, mime: file.type, gzip,
      }));
    });

    conn.on('data', (data) => {
      if (typeof data !== 'string') return;
      if (JSON.parse(data).kind === 'ready') streamOut(conn, file, gzip);
    });

    conn.on('error', () => fail('The connection dropped mid-transfer.'));
  });
}

async function streamOut(conn, file, gzip) {
  els.shareHandoff.hidden = true;
  els.shareProgress.hidden = false;

  // Ask the transport how much it can take per message instead of guessing.
  const sctp = conn.peerConnection && conn.peerConnection.sctp;
  const limit = (sctp && sctp.maxMessageSize) || 65536;
  const chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, limit - 2048));
  const highWater = Math.max(1 << 20, chunkSize * 8);
  const channel = conn.dataChannel;

  let read = 0;  // uncompressed, straight off disk — matches file.size
  let wire = 0;  // what actually goes over the connection
  const t0 = performance.now();

  const tick = throttle(() => {
    const pct = (read / file.size) * 100;
    els.sendFill.style.width = `${pct}%`;
    els.sendStatus.textContent =
      `${pct.toFixed(0)}% · ${bytes(read / ((performance.now() - t0) / 1000))}/s`;
  });

  let stream = file.stream().pipeThrough(meter((n) => { read += n; tick(); }));
  if (gzip) stream = stream.pipeThrough(new CompressionStream('gzip'));

  const reader = stream.getReader();
  let pending = new Uint8Array(0);

  const push = async (view) => {
    if (channel && channel.bufferedAmount > highWater) await drain(channel, highWater >> 1);
    if (!conn.open) throw new Error('closed');
    conn.send(view.slice().buffer); // copy: the view aliases a reused buffer
    wire += view.byteLength;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      pending = pending.byteLength ? concat(pending, value) : value;
      let off = 0;
      while (pending.byteLength - off >= chunkSize) {
        await push(pending.subarray(off, off + chunkSize));
        off += chunkSize;
      }
      pending = off ? pending.slice(off) : pending;
    }
    if (pending.byteLength) await push(pending);
  } catch {
    fail('The transfer stopped early — the other side probably closed their tab.');
    return;
  }

  conn.send(JSON.stringify({ kind: 'done' }));

  const secs = (performance.now() - t0) / 1000;
  els.sendFill.style.width = '100%';
  els.sendFill.classList.add('done');
  els.sendStatus.textContent = gzip && wire < read
    ? `Sent ${bytes(file.size)} as ${bytes(wire)} · ${bytes(file.size / secs)}/s`
    : `Sent ${bytes(file.size)} · ${bytes(file.size / secs)}/s`;
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// Let the send queue drain so a fast disk can't outrun a slow network.
const drain = (channel, low) => new Promise((resolve) => {
  channel.bufferedAmountLowThreshold = low;
  channel.addEventListener('bufferedamountlow', resolve, { once: true });
});

/* ── receiving ────────────────────────────────────────────────── */

function startReceiving(hostId) {
  teardown();
  show('panel-receive');
  live(els.recvSub, 'Reaching the sender…');

  peer = new Peer(SIGNAL);

  peer.on('error', (err) => {
    fail(err.type === 'peer-unavailable'
      ? 'That link is no longer active. The sender needs to keep their tab open — ask them for a fresh one.'
      : `Could not connect (${err.type}). Check your connection and try again.`);
  });

  peer.on('open', () => {
    const conn = peer.connect(hostId, { reliable: true });
    let meta = null;
    let sink = null; // ReadableStream controller, once the user has accepted

    // Messages are handled through a promise chain, never concurrently:
    // converting a Blob is async, and two overlapping handlers would enqueue
    // chunks out of order and silently corrupt the file.
    let chain = Promise.resolve();

    async function handle(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.kind === 'meta') {
          meta = msg;
          els.recvName.textContent = msg.name;
          els.recvSub.textContent = bytes(msg.size) +
            (msg.gzip ? ' · compressed in flight' : '');
          els.acceptBtn.hidden = false;
          els.acceptBtn.textContent = HAS_FS_ACCESS ? 'Choose where to save' : 'Save file';
        } else if (msg.kind === 'done' && sink) {
          sink.close();
        }
        return;
      }
      if (!sink) return; // bytes before accept shouldn't happen, but don't crash
      const view = await toBytes(data);
      if (view && sink) sink.enqueue(view);
    }

    conn.on('data', (data) => {
      chain = chain.then(() => handle(data)).catch(() => {});
    });

    conn.on('close', () => {
      if (sink) sink.error(new Error('sender disconnected'));
    });

    els.acceptBtn.onclick = async () => {
      // showSaveFilePicker must be the first await — it needs the user gesture.
      let handle = null;
      if (HAS_FS_ACCESS) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        } catch (err) {
          if (err.name === 'AbortError') return; // they cancelled; leave the button
          handle = null;                          // otherwise fall back to memory
        }
      }

      els.acceptBtn.hidden = true;
      els.recvProgress.hidden = false;
      await receiveInto(conn, meta, handle, (c) => { sink = c; });
    };
  });
}

async function receiveInto(conn, meta, handle, exposeSink) {
  const t0 = performance.now();
  let got = 0;

  const incoming = new ReadableStream({ start: exposeSink });

  const tick = throttle(() => {
    const pct = (got / meta.size) * 100;
    els.recvFill.style.width = `${pct}%`;
    els.recvStatus.textContent =
      `${pct.toFixed(0)}% · ${bytes(got / ((performance.now() - t0) / 1000))}/s`;
  });

  let stream = incoming;
  if (meta.gzip) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  stream = stream.pipeThrough(meter((n) => { got += n; tick(); }));

  conn.send(JSON.stringify({ kind: 'ready' }));

  try {
    if (handle) {
      await stream.pipeTo(await handle.createWritable());
    } else {
      const blob = await new Response(stream).blob();
      objectUrl = URL.createObjectURL(blob);
      els.saveLink.href = objectUrl;
      els.saveLink.download = meta.name;
      els.saveLink.hidden = false;
    }
  } catch {
    fail('The transfer did not finish — the sender may have closed their tab.');
    return;
  }

  const secs = (performance.now() - t0) / 1000;
  els.recvFill.style.width = '100%';
  els.recvFill.classList.add('done');
  els.recvStatus.textContent = handle
    ? `Saved ${bytes(meta.size)} to disk · ${bytes(meta.size / secs)}/s`
    : `${bytes(meta.size)} received · ${bytes(meta.size / secs)}/s`;
}

/* ── wiring ───────────────────────────────────────────────────── */

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) startSharing(els.fileInput.files[0]);
});

els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});

for (const evt of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('hot');
  });
}

for (const evt of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(evt, () => els.dropzone.classList.remove('hot'));
}

els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) startSharing(e.dataTransfer.files[0]);
});

els.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.shareLink.value);
  } catch {
    els.shareLink.select();          // clipboard API needs a secure context
    document.execCommand('copy');
  }
  els.copyBtn.textContent = 'Copied';
  setTimeout(() => { els.copyBtn.textContent = 'Copy link'; }, 1600);
});

for (const id of ['share-reset', 'error-reset']) {
  $(id).addEventListener('click', () => {
    teardown();
    els.fileInput.value = '';
    els.saveLink.hidden = true;
    els.acceptBtn.hidden = true;
    els.recvProgress.hidden = true;
    els.recvFill.classList.remove('done');
    history.replaceState(null, '', location.pathname);
    show('panel-pick');
  });
}

window.addEventListener('beforeunload', (e) => {
  const midSend = !els.shareProgress.hidden && !els.sendFill.classList.contains('done');
  if (midSend) { e.preventDefault(); e.returnValue = ''; }
});

const hash = location.hash.slice(1);
if (hash.startsWith(ID_PREFIX)) startReceiving(hash);
else show('panel-pick');
