/* dropline — browser-to-browser file transfer over a WebRTC data channel.
 *
 * The sender holds the file in its own tab and streams it directly to the
 * receiver. A signalling server is used only to introduce the two peers;
 * the file bytes never pass through it.
 */

const SIGNAL = {
  // PeerJS's free public broker. Swap in your own host here if it gets flaky.
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

const CHUNK_SIZE  = 64 * 1024;        // what we slice off the file per send()
const BUFFER_HIGH = 4 * 1024 * 1024;  // pause once this much is queued
const BUFFER_LOW  = 512 * 1024;       // resume once it drains to here
const ID_PREFIX   = 'dropline-';      // namespaced, since the broker is shared

const $ = (id) => document.getElementById(id);

const els = {
  panels:   ['panel-pick', 'panel-share', 'panel-receive', 'panel-error'].map($),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  shareName: $('share-name'),
  shareSize: $('share-size'),
  shareLink: $('share-link'),
  shareLinkBox: $('share-link-box'),
  shareStatus: $('share-status'),
  shareProgress: $('share-progress'),
  copyBtn: $('copy-btn'),
  sendFill: $('send-fill'),
  sendStatus: $('send-status'),
  recvName: $('recv-name'),
  recvSize: $('recv-size'),
  recvFill: $('recv-fill'),
  recvStatus: $('recv-status'),
  saveBtn: $('save-btn'),
  errorMsg: $('error-msg'),
};

let peer = null;          // active PeerJS instance
let objectUrl = null;     // held so we can revoke it on reset

/* ── small helpers ────────────────────────────────────────────── */

function show(id) {
  for (const p of els.panels) p.hidden = p.id !== id;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function fail(message) {
  els.errorMsg.textContent = message;
  show('panel-error');
}

function newId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alike chars
  const rand = crypto.getRandomValues(new Uint8Array(12));
  return ID_PREFIX + Array.from(rand, (b) => alphabet[b % alphabet.length]).join('');
}

function teardown() {
  if (peer) { peer.destroy(); peer = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

// PeerJS hands binary back in a few shapes depending on version and browser.
async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Blob) return data.arrayBuffer();
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

/* ── sending ──────────────────────────────────────────────────── */

function startSharing(file) {
  teardown();

  els.shareName.textContent = file.name;
  els.shareSize.textContent = bytes(file.size);
  els.shareLinkBox.hidden = false;
  els.shareProgress.hidden = true;
  els.sendFill.classList.remove('done');
  show('panel-share');

  const id = newId();
  let claimed = false; // set once a receiver has taken this link
  peer = new Peer(id, SIGNAL);

  peer.on('open', () => {
    const url = `${location.origin}${location.pathname}#${id}`;
    els.shareLink.value = url;
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      startSharing(file); // astronomically unlikely; just roll a new id
      return;
    }
    fail(`Could not reach the signalling server (${err.type}). Check your connection and try again.`);
  });

  peer.on('connection', (conn) => {
    // One transfer per link. Turn away anyone who shows up late.
    if (claimed) {
      conn.on('open', () => conn.close());
      return;
    }
    claimed = true;
    els.shareStatus.innerHTML = '<span class="pulse"></span> Connected — negotiating…';
    conn.on('open', () => sendFile(conn, file));
    conn.on('error', () => fail('The connection dropped mid-transfer.'));
  });
}

async function sendFile(conn, file) {
  els.shareLinkBox.hidden = true;
  els.shareProgress.hidden = false;

  conn.send(JSON.stringify({ kind: 'meta', name: file.name, size: file.size, mime: file.type }));

  const channel = conn.dataChannel;
  const started = performance.now();
  let offset = 0;

  try {
    while (offset < file.size) {
      if (channel && channel.bufferedAmount > BUFFER_HIGH) await drain(channel);
      if (!conn.open) throw new Error('closed');

      const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      conn.send(buf);
      offset += buf.byteLength;

      const pct = (offset / file.size) * 100;
      const rate = offset / ((performance.now() - started) / 1000);
      els.sendFill.style.width = `${pct}%`;
      els.sendStatus.textContent = `Sending — ${pct.toFixed(0)}% · ${bytes(rate)}/s`;
    }
  } catch {
    fail('The transfer stopped early — the other side probably closed their tab.');
    return;
  }

  conn.send(JSON.stringify({ kind: 'done' }));
  els.sendFill.classList.add('done');
  els.sendStatus.textContent = `Sent ${bytes(file.size)}. You can close this tab.`;
}

// Wait for the outgoing queue to drain before pushing more at it.
function drain(channel) {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.addEventListener('bufferedamountlow', function once() {
      channel.removeEventListener('bufferedamountlow', once);
      resolve();
    }, { once: true });
  });
}

/* ── receiving ────────────────────────────────────────────────── */

function startReceiving(hostId) {
  teardown();
  show('panel-receive');

  peer = new Peer(SIGNAL);

  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      fail('That link is no longer active. Ask the sender to keep their tab open and send you a fresh link.');
    } else {
      fail(`Could not connect (${err.type}). Check your connection and try again.`);
    }
  });

  peer.on('open', () => {
    const conn = peer.connect(hostId, { reliable: true });
    let meta = null;
    let received = 0;
    let started = 0;
    const chunks = [];

    conn.on('open', () => {
      els.recvStatus.innerHTML = '<span class="pulse"></span> Connected — waiting for the file…';
    });

    conn.on('data', async (data) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);

        if (msg.kind === 'meta') {
          meta = msg;
          started = performance.now();
          els.recvName.textContent = msg.name;
          els.recvSize.textContent = bytes(msg.size);
          els.recvStatus.innerHTML = '<span class="pulse"></span> Receiving…';
        } else if (msg.kind === 'done') {
          finish();
        }
        return;
      }

      const buf = await toArrayBuffer(data);
      if (!buf || !meta) return;

      chunks.push(buf);
      received += buf.byteLength;

      const pct = (received / meta.size) * 100;
      const rate = received / ((performance.now() - started) / 1000);
      els.recvFill.style.width = `${pct}%`;
      els.recvStatus.textContent = `Receiving — ${pct.toFixed(0)}% · ${bytes(rate)}/s`;
    });

    conn.on('close', () => {
      if (meta && received < meta.size) {
        fail('The sender disconnected before the file finished.');
      }
    });

    function finish() {
      const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
      objectUrl = URL.createObjectURL(blob);

      els.recvFill.style.width = '100%';
      els.recvFill.classList.add('done');
      els.recvStatus.textContent = `Done — ${bytes(meta.size)} received.`;
      els.saveBtn.href = objectUrl;
      els.saveBtn.download = meta.name;
      els.saveBtn.hidden = false;
      els.saveBtn.click(); // browsers may block this; the button stays as a fallback
    }
  });
}

/* ── wiring ───────────────────────────────────────────────────── */

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) startSharing(els.fileInput.files[0]);
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
    els.shareLink.select(); // clipboard API needs https; fall back to selecting
    document.execCommand('copy');
  }
  els.copyBtn.textContent = 'Copied';
  setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1600);
});

for (const id of ['share-reset', 'error-reset']) {
  $(id).addEventListener('click', () => {
    teardown();
    els.fileInput.value = '';
    history.replaceState(null, '', location.pathname);
    show('panel-pick');
  });
}

window.addEventListener('beforeunload', (e) => {
  const sending = !els.shareProgress.hidden && !els.sendFill.classList.contains('done');
  if (sending) { e.preventDefault(); e.returnValue = ''; }
});

// A link with #<id> means we're the receiver; otherwise show the picker.
const hash = location.hash.slice(1);
if (hash.startsWith(ID_PREFIX)) {
  startReceiving(hash);
} else {
  show('panel-pick');
}
