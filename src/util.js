/* Pure helpers — no DOM, no network. Everything here is unit tested by test.js,
   which is why it deliberately avoids touching browser globals at load time. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.util = (function () {
  // Formats that are already compressed: gzipping them burns CPU and can make
  // the payload marginally larger. SVG is text despite the image/ prefix.
  const PACKED = /^(image\/(?!svg)|video\/|audio\/)|^application\/(zip|gzip|x-7z-compressed|x-rar|x-xz|x-bzip2|epub\+zip|x-apple-diskimage)/;

  function bytes(n) {
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1000) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
  }

  function duration(secs) {
    if (!isFinite(secs) || secs < 0) return '—';
    if (secs < 60) return `${Math.max(1, Math.round(secs))}s`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  // Human-readable id, minus the glyphs people misread when typing one out.
  function newId(prefix, randomBytes) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    const rand = randomBytes(12);
    let out = '';
    for (let i = 0; i < rand.length; i++) out += alphabet[rand[i] % alphabet.length];
    return prefix + out;
  }

  const GZIP_FLOOR = 8 * 1024;

  // A cheap first filter. A type known to be packed already is never worth a
  // measurement, and a tiny file is never worth a gzip header.
  function shouldCompress(mime, size, hasCompressionStream) {
    if (!hasCompressionStream) return false;
    if (size <= GZIP_FLOOR) return false;
    return !PACKED.test(mime || '');
  }

  // Once a sample has actually been compressed, the ratio decides. Anything
  // that only shaves a few percent is not worth the CPU on either end, and on
  // a weak device that cost is the difference between smooth and stuttering.
  function worthCompressing(ratio) {
    if (typeof ratio !== 'number' || !isFinite(ratio) || ratio <= 0) return false;
    return ratio < 0.9;
  }

  // Sample from a quarter in rather than the head: containers put headers and
  // metadata at the front, which compress unlike the payload behind them.
  function sampleWindow(size, sampleBytes) {
    if (size <= sampleBytes) return { start: 0, end: size };
    const start = Math.floor(size / 4);
    return { start, end: Math.min(start + sampleBytes, size) };
  }

  // Blob sealing interval. Small devices seal more often so less sits in the
  // heap at once; capable ones seal less often for fewer allocations.
  function sealSize(deviceMemoryGb) {
    const gb = deviceMemoryGb || 4;
    if (gb <= 2) return 2 * 1024 * 1024;
    if (gb <= 4) return 4 * 1024 * 1024;
    return 8 * 1024 * 1024;
  }

  // The transport advertises a maximum message size; leave headroom for the
  // SCTP framing rather than sending exactly at the limit.
  function chunkSize(maxMessageSize) {
    const limit = maxMessageSize || 65536;
    return Math.max(16 * 1024, Math.min(256 * 1024, limit - 2048));
  }

  function throttle(fn, ms) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn.apply(null, args);
    };
  }

  // Two files in one batch can share a name; the receiver must not silently
  // overwrite one with the other.
  function dedupeNames(names) {
    const seen = new Map();
    return names.map((name) => {
      if (!seen.has(name)) { seen.set(name, 1); return name; }
      const n = seen.get(name);
      seen.set(name, n + 1);
      const dot = name.lastIndexOf('.');
      return dot > 0
        ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
        : `${name} (${n})`;
    });
  }

  // Strip anything that would let a sender write outside the chosen folder.
  function safeName(name) {
    const base = String(name || 'file').split(/[/\\]/).pop().replace(/^\.+/, '');
    return base.slice(0, 180) || 'file';
  }

  // Folder structure is worth preserving, but a relative path arriving from
  // the far end is untrusted input: every segment is sanitised and anything
  // that could climb out of the chosen directory is dropped.
  function safePath(path) {
    const parts = String(path || '')
      .split(/[/\\]/)
      .map((p) => p.replace(/^\.+/, '').trim())
      .filter((p) => p && p !== '.' && p !== '..')
      .map((p) => p.slice(0, 120));
    return parts.slice(0, 16); // absurdly deep trees are not worth honouring
  }

  /* ── integrity ──
     Web Crypto has no streaming digest, and hashing a file whole would put it
     back in memory — the exact thing the streaming design avoids. CRC32 is
     incremental, costs almost nothing, and catches what actually goes wrong
     here: truncation, reordering, a dropped chunk. It is a corruption check,
     not a tamper check, and is not relied on for security. */

  // Slicing-by-8: eight tables let this consume eight bytes per iteration
  // instead of one. At transfer speeds the byte-at-a-time loop is real time.
  const CRC_TABLES = (function () {
    const tables = [];
    const first = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      first[i] = c >>> 0;
    }
    tables.push(first);
    for (let n = 1; n < 8; n++) {
      const prev = tables[n - 1];
      const next = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        const v = prev[i];
        next[i] = (first[v & 0xFF] ^ (v >>> 8)) >>> 0;
      }
      tables.push(next);
    }
    return tables;
  })();

  const T0 = CRC_TABLES[0], T1 = CRC_TABLES[1], T2 = CRC_TABLES[2], T3 = CRC_TABLES[3];
  const T4 = CRC_TABLES[4], T5 = CRC_TABLES[5], T6 = CRC_TABLES[6], T7 = CRC_TABLES[7];

  const crcInit = () => 0xFFFFFFFF;

  function crcUpdate(state, bytes) {
    let c = state >>> 0;
    const len = bytes.length;
    let i = 0;
    while (len - i >= 8) {
      c = (c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))) >>> 0;
      c = (T7[c & 0xFF]
         ^ T6[(c >>> 8) & 0xFF]
         ^ T5[(c >>> 16) & 0xFF]
         ^ T4[(c >>> 24) & 0xFF]
         ^ T3[bytes[i + 4]]
         ^ T2[bytes[i + 5]]
         ^ T1[bytes[i + 6]]
         ^ T0[bytes[i + 7]]) >>> 0;
      i += 8;
    }
    while (i < len) c = (T0[(c ^ bytes[i++]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return c >>> 0;
  }

  const crcFinal = (state) => ((state ^ 0xFFFFFFFF) >>> 0);

  function crc32(bytes) {
    return crcFinal(crcUpdate(crcInit(), bytes));
  }

  // Exponential moving average. A naive total/elapsed rate keeps reporting a
  // number from thirty seconds ago; this tracks what the link is doing now.
  function ema(previous, sample, alpha) {
    if (previous === null || previous === undefined || !isFinite(previous)) return sample;
    const a = alpha === undefined ? 0.3 : alpha;
    return previous + a * (sample - previous);
  }

  function eta(doneBytes, totalBytes, elapsedSecs) {
    if (doneBytes <= 0 || elapsedSecs <= 0) return null;
    const rate = doneBytes / elapsedSecs;
    if (rate <= 0) return null;
    return (totalBytes - doneBytes) / rate;
  }

  return {
    PACKED, bytes, duration, newId, shouldCompress, sealSize,
    chunkSize, throttle, dedupeNames, safeName, safePath, eta, ema,
    worthCompressing, sampleWindow, GZIP_FLOOR,
    crc32, crcInit, crcUpdate, crcFinal,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DL.util;
