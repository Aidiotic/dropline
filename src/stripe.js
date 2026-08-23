/* Striped payload transport.
 *
 * A single WebRTC data channel tops out well below what the link can carry —
 * measured 10.5 MB/s over loopback, which a raw channel with no application
 * logic also hit, so the limit is SCTP rather than anything above it. Splitting
 * the payload across several channels on the same peer connection lifts that:
 * 2 channels measured 14.1 MB/s, 4 gave 15.0, 8 gave 16.0. Four is where the
 * curve flattens, so four is the default.
 *
 * Ordering without a header
 * -------------------------
 * Chunk i is sent on channel i mod N. Each channel is reliable and ordered on
 * its own, so the k-th message to arrive on channel c is globally chunk
 * k*N + c. The receiver can therefore rebuild the exact order from arrival
 * counts alone — no sequence number per chunk, which means no prefix, which
 * means the zero-copy send path survives.
 *
 * Control messages stay on the PeerJS connection. That channel is separate
 * from these, so nothing may be assumed about ordering between the two: the
 * sender waits for an explicit acknowledgement before streaming, and reports
 * the chunk count when finishing so the receiver knows when it has everything.
 */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.stripe = (function () {
  const LABEL = 'dl-stripe-';
  const OPEN_TIMEOUT = 4000;

  function countFor() {
    const tier = DL.device.profile.tier;
    if (tier === 'minimal' || tier === 'low') return 2;
    if (tier === 'ultra') return 6;
    return 4;
  }

  // Only one side creates the channels; the other picks them up via
  // ondatachannel. Both may then send on them — data channels are duplex.
  function create(pc, count) {
    const channels = [];
    for (let i = 0; i < count; i++) {
      const ch = pc.createDataChannel(`${LABEL}${i}`, { ordered: true });
      ch.binaryType = 'arraybuffer';
      channels.push(ch);
    }
    return waitOpen(channels);
  }

  function collect(pc, count, onReady) {
    const channels = new Array(count);
    let seen = 0;
    pc.addEventListener('datachannel', (ev) => {
      const label = ev.channel.label;
      if (!label.startsWith(LABEL)) return;
      const index = Number(label.slice(LABEL.length));
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      ev.channel.binaryType = 'arraybuffer';
      channels[index] = ev.channel;
      if (++seen === count) waitOpen(channels).then(onReady, () => onReady(null));
    });
  }

  function waitOpen(channels) {
    const ready = channels.map((ch) => new Promise((resolve, reject) => {
      if (ch.readyState === 'open') return resolve();
      ch.addEventListener('open', resolve, { once: true });
      ch.addEventListener('error', reject, { once: true });
    }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('stripe open timeout')), OPEN_TIMEOUT));
    return Promise.race([Promise.all(ready).then(() => channels), timeout]);
  }

  /* ── sending ── */

  function writer(channels, opts) {
    const n = channels.length;
    const high = opts.high;
    let index = 0;

    const drain = (ch) => new Promise((resolve) => {
      ch.bufferedAmountLowThreshold = high >> 1;
      ch.addEventListener('bufferedamountlow', resolve, { once: true });
    });

    return {
      count: n,
      get sent() { return index; },
      async send(buffer) {
        const ch = channels[index % n];
        if (ch.readyState !== 'open') throw new Error('stripe closed');
        if (ch.bufferedAmount > high) await drain(ch);
        ch.send(buffer);
        index++;
      },
      async flush() {
        // Every channel must be empty before the finish message goes out.
        for (const ch of channels) {
          while (ch.readyState === 'open' && ch.bufferedAmount > 0) {
            await new Promise((r) => setTimeout(r, 15));
          }
        }
      },
    };
  }

  /* ── receiving ── */

  // Rebuilds the original order from per-channel arrival counts. Holds only
  // the chunks that arrived early, which round-robin striping keeps to a
  // handful rather than a backlog.
  function reader(channels, onChunk) {
    const n = channels.length;
    const arrived = new Array(n).fill(0);
    const held = new Map();
    let next = 0;
    let total = null;
    let delivered = 0;
    let finish = null;

    const pump = () => {
      while (held.has(next)) {
        const chunk = held.get(next);
        held.delete(next);
        next++;
        delivered++;
        onChunk(chunk);
      }
      if (finish && total !== null && delivered >= total) {
        const done = finish;
        finish = null;
        done();
      }
    };

    const handlers = channels.map((ch, c) => {
      const handler = (ev) => {
        const globalIndex = arrived[c] * n + c;
        arrived[c]++;
        held.set(globalIndex, new Uint8Array(ev.data));
        pump();
      };
      ch.addEventListener('message', handler);
      return { ch, handler };
    });

    return {
      // Called when the sender reports how many chunks it wrote; resolves once
      // that many have been handed on in order.
      complete(chunkCount) {
        total = chunkCount;
        return new Promise((resolve) => {
          finish = resolve;
          pump();
        });
      },
      reset() {
        arrived.fill(0);
        held.clear();
        next = 0;
        delivered = 0;
        total = null;
        finish = null;
      },
      detach() {
        handlers.forEach(({ ch, handler }) => ch.removeEventListener('message', handler));
        held.clear();
      },
      get pending() { return held.size; },
    };
  }

  return { LABEL, countFor, create, collect, writer, reader };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DL.stripe;
