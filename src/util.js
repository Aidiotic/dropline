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

  function shouldCompress(mime, size, hasCompressionStream) {
    if (!hasCompressionStream) return false;
    if (size <= 8 * 1024) return false; // header costs more than it saves
    return !PACKED.test(mime || '');
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

  function eta(doneBytes, totalBytes, elapsedSecs) {
    if (doneBytes <= 0 || elapsedSecs <= 0) return null;
    const rate = doneBytes / elapsedSecs;
    if (rate <= 0) return null;
    return (totalBytes - doneBytes) / rate;
  }

  return {
    PACKED, bytes, duration, newId, shouldCompress, sealSize,
    chunkSize, throttle, dedupeNames, safeName, safePath, eta,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DL.util;
