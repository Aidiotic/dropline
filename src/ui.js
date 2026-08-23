/* DOM rendering and wiring. The only file that touches the document. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.ui = (function () {
  const U = DL.util;
  const $ = (id) => document.getElementById(id);

  const el = {};
  let session = null;
  const items = new Map();
  let announceTimer = null;
  let wakeLock = null;
  let autoAccept = false;
  const objectUrls = [];

  const IDS = ['app', 'statusline', 'live', 'view-invite', 'view-session', 'view-error',
    'qr', 'share-link', 'copy-btn', 'share-btn', 'offer-card', 'offer-summary',
    'offer-accept', 'offer-decline', 'drop', 'file-input', 'folder-input',
    'act-files', 'act-folder', 'act-text', 'auto-accept', 'text-wrap', 'text-input',
    'send-text', 'transfer-list', 'empty-note', 'session-stats', 'error-msg',
    'error-reset', 'veil'];

  const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

  /* ── announcements ── */

  function announce(text) {
    if (!el.live) return;
    clearTimeout(announceTimer);
    // Re-announce identical text by clearing first; screen readers ignore a
    // live region whose content did not change.
    el.live.textContent = '';
    announceTimer = setTimeout(() => { el.live.textContent = text; }, 120);
  }

  /* ── views and state ── */

  function show(name) {
    const swap = () => {
      el.viewInvite.hidden = name !== 'invite';
      el.viewSession.hidden = name !== 'session';
      el.viewError.hidden = name !== 'error';
    };
    // View Transitions where available; a plain swap everywhere else.
    if (document.startViewTransition && !prefersReducedMotion()) {
      document.startViewTransition(swap);
    } else {
      swap();
    }
  }

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setAppState(state) { el.app.dataset.state = state; }

  const STATUS_TEXT = {
    idle: 'Starting up',
    waiting: 'Waiting for the other device',
    connecting: 'Connecting',
    reconnecting: 'Connection lost — reconnecting',
    connected: 'Connected',
    failed: 'Could not connect',
    closed: 'The other device left',
  };

  let connState = 'idle';

  function setStatus(state) {
    connState = state;
    el.statusline.textContent = STATUS_TEXT[state] || state;
    setAppState(state === 'connected' && anyActive() ? 'busy' : state);
    if (state === 'connected') show('session');
    if (state === 'failed') show('error');
    announce(STATUS_TEXT[state] || state);
  }

  const anyActive = () => [...items.values()].some((i) => i.state === 'active');

  function refreshBusy() {
    if (connState !== 'connected') return;
    setAppState(anyActive() ? 'busy' : 'connected');
  }

  function fail(message) {
    el.errorMsg.textContent = message;
    setAppState('failed');
    show('error');
    announce(`Error. ${message}`);
  }

  /* ── screen wake lock ──
     A phone that sleeps mid-transfer drops the connection and loses the file.
     Holding the lock only while bytes are moving is the whole point. */

  async function updateWakeLock() {
    const needed = anyActive();
    try {
      if (needed && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!needed && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      // Denied or unsupported. Nothing breaks; the screen may just sleep.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateWakeLock();
  });

  /* ── document title as a progress readout ── */

  function updateTitle() {
    const active = [...items.values()].filter((i) => i.state === 'active' && i.size);
    if (!active.length) { document.title = 'dropline'; return; }
    const done = active.reduce((n, i) => n + (i.done || 0), 0);
    const total = active.reduce((n, i) => n + i.size, 0);
    const pct = total ? Math.floor((done / total) * 100) : 0;
    document.title = `${pct}% · dropline`;
  }

  /* ── QR ── */

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
    el.qr.innerHTML =
      `<svg viewBox="0 0 ${span} ${span}" xmlns="http://www.w3.org/2000/svg" ` +
      `shape-rendering="crispEdges" role="img" aria-label="QR code for this session">` +
      `<path d="${path}" fill="currentColor"/></svg>`;
  }

  async function copy(text, button, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      document.body.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    const original = label || button.textContent;
    button.textContent = 'Copied';
    announce('Link copied');
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  /* ── transfer rows ── */

  function upsert(item) {
    const previous = items.get(item.id) || {};
    const merged = { ...previous, ...item };
    items.set(item.id, merged);
    render(merged);

    if (merged.state !== previous.state) {
      if (merged.state === 'done') {
        announce(`${merged.dir === 'in' ? 'Received' : 'Sent'} ${merged.name}`);
      } else if (merged.state === 'failed') {
        announce(`Failed: ${merged.name}. ${merged.detail || ''}`);
      }
      refreshBusy();
      updateWakeLock();
      renderStats();
    }
    updateTitle();
  }

  function render(item) {
    let row = $(`row-${item.id}`);
    if (!row) {
      row = document.createElement('li');
      row.id = `row-${item.id}`;
      row.className = 'row-item';
      row.innerHTML =
        '<div class="item-head">' +
          '<span class="item-dir" aria-hidden="true"></span>' +
          '<span class="item-name"></span>' +
          '<span class="item-size"></span>' +
        '</div>' +
        '<div class="bar"><div class="bar-fill"></div></div>' +
        '<div class="item-foot"><span class="item-state"></span><span class="item-actions"></span></div>';
      el.transferList.prepend(row);
      el.emptyNote.hidden = true;
    }

    const pct = item.size
      ? Math.min(100, ((item.done || 0) / item.size) * 100)
      : (item.state === 'done' ? 100 : 0);

    row.dataset.dir = item.dir;
    row.dataset.state = item.state;
    row.querySelector('.item-dir').textContent = item.dir === 'in' ? '↓' : '↑';
    row.querySelector('.item-name').textContent =
      (item.path && item.path.length ? item.path.join('/') + '/' : '') + item.name;
    row.querySelector('.item-size').textContent =
      item.kind === 'text' ? 'text' : U.bytes(item.size);

    const bar = row.querySelector('.bar');
    row.querySelector('.bar-fill').style.width = `${pct}%`;
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    bar.setAttribute('aria-label', `${item.name} ${item.dir === 'in' ? 'download' : 'upload'}`);

    row.querySelector('.item-state').innerHTML = stateHtml(item, pct);
    renderActions(row, item);
    renderThumb(row, item);
  }

  // Rate is smoothed: a running total/elapsed average reports a number from
  // half a minute ago and jitters wildly at the start.
  function liveRate(item) {
    const now = Date.now();
    if (!item.rateAt) { item.rateAt = now; item.rateBytes = item.done || 0; return item.rate || 0; }
    const dt = (now - item.rateAt) / 1000;
    if (dt < 0.25) return item.rate || 0;
    const sample = ((item.done || 0) - item.rateBytes) / dt;
    item.rate = U.ema(item.rate, sample, 0.35);
    item.rateAt = now;
    item.rateBytes = item.done || 0;
    return item.rate;
  }

  function stateHtml(item, pct) {
    switch (item.state) {
      case 'offered':
        return item.dir === 'in' ? 'Offered' : 'Waiting for them to accept';
      case 'declined': return 'Declined';
      case 'failed':   return escape(item.detail || 'Failed');
      case 'active': {
        const rate = liveRate(item);
        const left = rate > 0 ? (item.size - (item.done || 0)) / rate : null;
        return [
          `${pct.toFixed(0)}%`,
          rate > 0 ? `${U.bytes(rate)}/s` : '',
          left && isFinite(left) && left > 0.5 ? `${U.duration(left)} left` : '',
        ].filter(Boolean).join(' · ');
      }
      case 'done': {
        if (item.kind === 'text') return 'Received';
        const rate = item.elapsed ? ` · ${U.bytes(item.size / item.elapsed)}/s` : '';
        const shrunk = item.wire && item.wire < item.size
          ? ` · ${U.bytes(item.wire)} sent` : '';
        if (item.dir === 'out') return `Sent${rate}${shrunk}`;
        const tick = item.verified ? '<span class="check">✓</span> ' : '';
        return `${tick}${item.savedToDisk ? 'Saved' : 'Ready'}${rate}`;
      }
      default: return '';
    }
  }

  const escape = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderActions(row, item) {
    const box = row.querySelector('.item-actions');
    if (item.state !== 'done' || box.dataset.filled) return;

    if (item.kind === 'text') {
      if (!row.querySelector('.snippet')) {
        const pre = document.createElement('pre');
        pre.className = 'snippet';
        pre.textContent = item.body || '';
        row.append(pre);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'act';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => copy(item.body || '', btn, 'Copy'));
      box.append(btn);
      box.dataset.filled = '1';
      return;
    }

    if (item.dir === 'in' && item.blob && !item.savedToDisk) {
      const url = URL.createObjectURL(item.blob);
      objectUrls.push(url);
      const link = document.createElement('a');
      link.className = 'act act-strong';
      link.textContent = 'Download';
      link.download = item.name;
      link.href = url;
      box.append(link);
      box.dataset.filled = '1';
    }
  }

  // A received image is far more recognisable than its filename.
  function renderThumb(row, item) {
    if (item.dir !== 'in' || item.state !== 'done' || !item.blob) return;
    if (!/^image\//.test(item.mime || '') || row.querySelector('.item-thumb')) return;
    const url = URL.createObjectURL(item.blob);
    objectUrls.push(url);
    const img = document.createElement('img');
    img.className = 'item-thumb';
    img.alt = '';
    img.src = url;
    row.querySelector('.item-head').insertBefore(img, row.querySelector('.item-name'));
  }

  function renderStats() {
    const done = [...items.values()].filter((i) => i.state === 'done' && i.kind === 'file');
    if (!done.length) { el.sessionStats.hidden = true; return; }
    const bytes = done.reduce((n, i) => n + (i.size || 0), 0);
    const sent = done.filter((i) => i.dir === 'out').length;
    const got = done.length - sent;
    el.sessionStats.hidden = false;
    el.sessionStats.textContent =
      `${done.length} file${done.length > 1 ? 's' : ''} · ${U.bytes(bytes)} · ` +
      `${sent} sent, ${got} received`;
  }

  /* ── offers ── */

  function showOffer(batch) {
    const files = batch.items.filter((i) => i.kind === 'file');
    const total = DL.protocol.totalBytes(batch.items);
    const names = batch.items.slice(0, 2).map((i) => i.name).join(', ');
    const more = batch.items.length > 2 ? ` +${batch.items.length - 2} more` : '';

    el.offerSummary.textContent = files.length
      ? `${names}${more} — ${U.bytes(total)}`
      : `${names}${more}`;

    el.offerAccept.textContent = files.length > 1 && DL.transfer.HAS_DIR
      ? 'Choose folder & accept'
      : (files.length === 1 && DL.transfer.HAS_SAVE ? 'Choose where to save' : 'Accept');

    batch.items.forEach((i) => upsert(i));

    if (autoAccept) {
      // No picker without a gesture, so this lands via the sealing path.
      session.acceptOffer({ silent: true });
      announce(`Accepting ${el.offerSummary.textContent}`);
      return;
    }

    el.offerCard.hidden = false;
    announce(`Incoming: ${el.offerSummary.textContent}`);
    el.offerAccept.focus();
  }

  /* ── input collection ── */

  async function filesFromDrop(dataTransfer) {
    const entries = Array.from(dataTransfer.items || [])
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);

    if (!entries.length) {
      return Array.from(dataTransfer.files).map((file) => ({ file, path: '' }));
    }
    const out = [];
    for (const entry of entries) await walk(entry, '', out);
    return out;
  }

  async function walk(entry, prefix, out) {
    if (out.length >= 500) return; // matches the protocol's manifest cap
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (file) out.push({ file, path: prefix });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }

  function offerLocal(picked) {
    if (!picked.length || !session) return;
    session.sendFiles(picked.map(({ file, path }) => ({
      kind: 'file', file, name: file.name, size: file.size, mime: file.type, path,
    })));
  }

  /* ── wiring ── */

  function wire() {
    el.copyBtn.addEventListener('click', () => copy(el.shareLink.value, el.copyBtn, 'Copy link'));

    // Native share sheet is the natural way to get a link onto a phone.
    if (navigator.share) {
      el.shareBtn.hidden = false;
      el.shareBtn.addEventListener('click', () => {
        navigator.share({ title: 'dropline', url: el.shareLink.value }).catch(() => {});
      });
    }

    el.actFiles.addEventListener('click', () => el.fileInput.click());
    el.actFolder.addEventListener('click', () => el.folderInput.click());

    el.actText.addEventListener('click', () => {
      const open = el.textWrap.hidden;
      el.textWrap.hidden = !open;
      el.actText.setAttribute('aria-expanded', String(open));
      if (open) el.textInput.focus();
    });

    el.autoAccept.addEventListener('change', () => {
      autoAccept = el.autoAccept.checked;
      announce(autoAccept ? 'Auto-accept on' : 'Auto-accept off');
    });

    el.fileInput.addEventListener('change', () => {
      offerLocal(Array.from(el.fileInput.files).map((file) => ({ file, path: '' })));
      el.fileInput.value = '';
    });

    el.folderInput.addEventListener('change', () => {
      offerLocal(Array.from(el.folderInput.files).map((file) => ({
        file,
        path: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
      })));
      el.folderInput.value = '';
    });

    el.drop.addEventListener('click', () => el.fileInput.click());
    el.drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });

    // Drag anywhere on the page, not just onto the box.
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      offerLocal(await filesFromDrop(e.dataTransfer));
    });

    el.sendText.addEventListener('click', sendText);
    el.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); }
    });

    window.addEventListener('paste', (e) => {
      if (!session || document.activeElement === el.textInput) return;
      const files = Array.from(e.clipboardData.files || []);
      if (files.length) {
        e.preventDefault();
        offerLocal(files.map((file) => ({ file, path: '' })));
      }
    });

    el.offerAccept.addEventListener('click', async () => {
      el.offerAccept.disabled = true;
      try { await session.acceptOffer(); } finally { el.offerAccept.disabled = false; }
      el.offerCard.hidden = true;
    });

    el.offerDecline.addEventListener('click', declineOffer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.offerCard.hidden) declineOffer();
    });

    el.errorReset.addEventListener('click', () => { location.href = location.pathname; });

    window.addEventListener('beforeunload', (e) => {
      if (anyActive()) { e.preventDefault(); e.returnValue = ''; }
    });

    window.addEventListener('pagehide', () => {
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    });
  }

  const hasFiles = (e) =>
    e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function sendText() {
    if (session.sendText(el.textInput.value)) {
      el.textInput.value = '';
      el.textWrap.hidden = true;
      el.actText.setAttribute('aria-expanded', 'false');
    }
  }

  function declineOffer() {
    session.declineOffer();
    el.offerCard.hidden = true;
    announce('Declined');
  }

  /* ── boot ── */

  function boot() {
    IDS.forEach((id) => { el[key(id)] = $(id); });
    wire();

    const hash = location.hash.slice(1);
    const isGuest = hash.startsWith(DL.session.ID_PREFIX);

    show(isGuest ? 'session' : 'invite');
    setStatus(isGuest ? 'connecting' : 'idle');

    if (isGuest) el.shareLink.value = `${location.origin}${location.pathname}#${hash}`;

    session = DL.session.create({
      role: isGuest ? 'guest' : 'host',
      hostId: isGuest ? hash : null,
      on: {
        link(url) { el.shareLink.value = url; drawQr(url); },
        status: setStatus,
        offer: showOffer,
        item: upsert,
        error(msg) {
          if (connState === 'failed') fail(msg);
          else announce(msg);
        },
      },
    });

    DL.session.active = session;
  }

  return { boot, upsert, setStatus, announce };
})();

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', DL.ui.boot);
  } else {
    DL.ui.boot();
  }
}
