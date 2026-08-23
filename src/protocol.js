/* Wire protocol. Control messages are JSON strings; payload is binary frames
   belonging to whichever item was last announced with `begin`.

   Both peers speak the same protocol — either side may offer a batch. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.protocol = (function () {
  const VERSION = 2;

  const T = {
    HELLO:    'hello',
    MANIFEST: 'manifest',  // here is a batch of items I would like to send
    ACCEPT:   'accept',
    DECLINE:  'decline',
    BEGIN:    'begin',     // payload after this belongs to itemId
    BEGIN_ACK: 'beginack', // receiver is listening; safe to stream
    RESUME:    'resume',   // where had you got to with this item?
    RESUME_AT: 'resumeat',
    END:      'end',
    TEXT:     'text',      // small payload carried inline, no binary frames
    DONE:     'done',
    HOLD:     'hold',      // receiver is behind — stop sending
    GO:       'go',
    AUTH:     'auth',     // here is my nonce, prove you hold the secret
    PROOF:    'proof',
    BYE:      'bye',
  };

  // `client` is a stable per-browser id, so a host can tell a returning device
  // from a new one -- PeerJS hands guests a fresh peer id on every connection.
  function hello(name, stripes, client) {
    return JSON.stringify({ t: T.HELLO, v: VERSION, name, stripes, client });
  }

  // `entries` are {name, size, mime, kind}. Names are made unique and stripped
  // of path separators here so the receiver can trust them.
  function manifest(batchId, entries) {
    const util = DL.util;
    const names = util.dedupeNames(entries.map((e) => util.safeName(e.name)));
    const items = entries.map((e, i) => ({
      id: `${batchId}-${i}`,
      kind: e.kind || 'file',
      name: names[i],
      path: util.safePath(e.path || ''),   // relative folder, [] when flat
      size: e.size || 0,
      mime: e.mime || '',
      gzip: !!e.gzip,
    }));
    return { batchId, items, wire: JSON.stringify({ t: T.MANIFEST, batchId, items }) };
  }

  const accept  = (batchId) => JSON.stringify({ t: T.ACCEPT, batchId });
  const decline = (batchId, reason) => JSON.stringify({ t: T.DECLINE, batchId, reason });
  // `at` is a byte offset into the plaintext: zero for a fresh item, and the
  // receiver's committed length when picking a transfer back up.
  const begin    = (itemId, at) => JSON.stringify({ t: T.BEGIN, itemId, at: at || 0 });
  const beginAck = (itemId) => JSON.stringify({ t: T.BEGIN_ACK, itemId });
  const resume   = (itemId) => JSON.stringify({ t: T.RESUME, itemId });
  const resumeAt = (itemId, at, crc) => JSON.stringify({ t: T.RESUME_AT, itemId, at, crc });
  const end     = (itemId, crc, bytes, chunks) => JSON.stringify({ t: T.END, itemId, crc, bytes, chunks });
  const done    = (batchId) => JSON.stringify({ t: T.DONE, batchId });
  const hold    = () => JSON.stringify({ t: T.HOLD });
  const go      = () => JSON.stringify({ t: T.GO });
  const bye     = () => JSON.stringify({ t: T.BYE });
  const auth    = (nonce) => JSON.stringify({ t: T.AUTH, nonce });
  const proof   = (value) => JSON.stringify({ t: T.PROOF, value });
  const text    = (itemId, body) => JSON.stringify({ t: T.TEXT, itemId, body });

  // Never let a malformed or hostile message throw inside an event handler.
  function parse(raw) {
    if (typeof raw !== 'string') return null;
    let msg;
    try { msg = JSON.parse(raw); } catch { return null; }
    if (!msg || typeof msg.t !== 'string') return null;
    if (msg.t === T.MANIFEST) {
      if (!Array.isArray(msg.items) || !msg.items.length) return null;
      if (msg.items.length > 500) return null;
      msg.items = msg.items.map((it) => ({
        id: String(it.id || ''),
        kind: it.kind === 'text' ? 'text' : 'file',
        name: DL.util.safeName(it.name),
        path: DL.util.safePath(Array.isArray(it.path) ? it.path.join('/') : it.path),
        size: Math.max(0, Number(it.size) || 0),
        mime: typeof it.mime === 'string' ? it.mime.slice(0, 120) : '',
        gzip: !!it.gzip,
      }));
    }
    if (msg.t === T.TEXT && typeof msg.body !== 'string') return null;
    if (msg.t === T.BEGIN || msg.t === T.RESUME_AT) {
      msg.at = Math.max(0, Number(msg.at) || 0);
    }
    if (msg.t === T.HELLO && typeof msg.client !== 'string') msg.client = null;
    return msg;
  }

  const totalBytes = (items) =>
    items.reduce((sum, it) => sum + (it.kind === 'file' ? it.size : 0), 0);

  return {
    VERSION, T, hello, manifest, accept, decline, begin, beginAck, end, done,
    hold, go, bye, auth, proof, text, resume, resumeAt, parse, totalBytes,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DL.protocol;
