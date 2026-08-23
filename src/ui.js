/* DOM rendering and wiring. The only file that touches the document. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.ui = (function () {
  const U = DL.util;
  const $ = (id) => document.getElementById(id);

  const el = {};
  let session = null;
  const items = new Map();   // itemId -> latest state, both directions
  let announceTimer = null;

  function cache() {
    ['view-invite', 'view-session', 'view-error', 'qr', 'share-link', 'copy-btn',
     'invite-status', 'conn-status', 'offer-card', 'offer-summary', 'offer-accept',
     'offer-decline', 'drop', 'file-input', 'folder-input', 'pick-files',
     'pick-folder', 'text-input', 'send-text', 'transfer-list', 'empty-note',
     'error-msg', 'error-reset', 'live', 'invite-again', 'session-link',
     'session-copy'].forEach((id) => { el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id); });
  }

  /* ── announcements for assistive tech ── */

  function announce(text) {
    if (!el.live) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { el.live.textContent = text; }, 120);
  }

  /* ── views ── */

  function show(name) {
    el.viewInvite.hidden = name !== 'invite';
    el.viewSession.hidden = name !== 'session';
    el.viewError.hidden = name !== 'error';
  }

  function fail(message) {
    el.errorMsg.textContent = message;
    show('error');
    announce(`Error. ${message}`);
  }

  const STATUS_TEXT = {
    idle: 'Starting…',
    waiting: 'Waiting for someone to open the link',
    connecting: 'Connecting…',
    reconnecting: 'Connection lost — reconnecting…',
    connected: 'Connected',
    failed: 'Could not connect',
    closed: 'The other device left',
  };

  function setStatus(state) {
    const text = STATUS_TEXT[state] || state;
    const live = state === 'connected';

    if (el.inviteStatus) {
      el.inviteStatus.innerHTML = '';
      if (!live && state !== 'failed') el.inviteStatus.append(dot());
      el.inviteStatus.append(text);
    }
    if (el.connStatus) {
      el.connStatus.innerHTML = '';
      el.connStatus.append(live ? okDot() : dot());
      el.connStatus.append(text);
      el.connStatus.dataset.state = state;
    }

    if (state === 'connected') show('session');
    announce(text);
  }

  const dot = () => Object.assign(document.createElement('span'), { className: 'dot' });
  const okDot = () => Object.assign(document.createElement('span'), { className: 'dot dot-ok' });

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
    setTimeout(() => { button.textContent = original; }, 1600);
  }

  /* ── transfer list ── */

  function upsert(item) {
    const previous = items.get(item.id) || {};
    const merged = { ...previous, ...item };
    items.set(item.id, merged);
    render(merged);

    if (merged.state === 'done' && previous.state !== 'done') {
      announce(`${merged.dir === 'in' ? 'Received' : 'Sent'} ${merged.name}`);
    }
    if (merged.state === 'failed' && previous.state !== 'failed') {
      announce(`Failed: ${merged.name}`);
    }
  }

  function render(item) {
    let row = document.getElementById(`row-${item.id}`);
    if (!row) {
      row = document.createElement('li');
      row.id = `row-${item.id}`;
      row.className = 'row';
      row.innerHTML = `
        <div class="row-head">
          <span class="row-dir" aria-hidden="true"></span>
          <span class="row-name"></span>
          <span class="row-meta"></span>
        </div>
        <div class="row-bar"><div class="row-fill"></div></div>
        <div class="row-foot"><span class="row-state"></span><span class="row-actions"></span></div>`;
      el.transferList.prepend(row);
      el.emptyNote.hidden = true;
    }

    const pct = item.size ? Math.min(100, (item.done || 0) / item.size * 100) : (item.state === 'done' ? 100 : 0);
    const bar = row.querySelector('.row-bar');
    const fill = row.querySelector('.row-fill');

    row.querySelector('.row-dir').textContent = item.dir === 'in' ? '↓' : '↑';
    row.dataset.dir = item.dir;
    row.dataset.state = item.state;
    row.querySelector('.row-name').textContent =
      (item.path && item.path.length ? item.path.join('/') + '/' : '') + item.name;
    row.querySelector('.row-meta').textContent = item.kind === 'text' ? 'text' : U.bytes(item.size);

    fill.style.width = `${pct}%`;
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    bar.setAttribute('aria-label', `${item.name} ${item.dir === 'in' ? 'download' : 'upload'}`);

    row.querySelector('.row-state').textContent = stateText(item, pct);
    renderActions(row.querySelector('.row-actions'), item);
  }

  function stateText(item, pct) {
    switch (item.state) {
      case 'offered':  return item.dir === 'in' ? 'Offered' : 'Waiting for them to accept…';
      case 'declined': return 'Declined';
      case 'failed':   return item.detail || 'Failed';
      case 'active': {
        const secs = item.startedAt ? (Date.now() - item.startedAt) / 1000 : 0;
        const rate = secs > 0 && item.done ? `${U.bytes(item.done / secs)}/s` : '';
        const left = U.eta(item.done, item.size, secs);
        return [`${pct.toFixed(0)}%`, rate, left ? `${U.duration(left)} left` : '']
          .filter(Boolean).join(' · ');
      }
      case 'done': {
        if (item.kind === 'text') return 'Received';
        const rate = item.elapsed ? ` · ${U.bytes(item.size / item.elapsed)}/s` : '';
        const shrunk = item.wire && item.wire < item.size ? ` · ${U.bytes(item.wire)} on the wire` : '';
        if (item.dir === 'out') return `Sent${rate}${shrunk}`;
        return (item.savedToDisk ? 'Saved to disk' : 'Ready') + rate;
      }
      default: return '';
    }
  }

  function renderActions(box, item) {
    box.innerHTML = '';
    if (item.state !== 'done') return;

    if (item.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'snippet';
      pre.textContent = item.body || '';
      box.parentElement.after(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => copy(item.body || '', btn, 'Copy'));
      box.append(btn);
      return;
    }

    if (item.dir === 'in' && item.blob && !item.savedToDisk) {
      const link = document.createElement('a');
      link.className = 'mini mini-strong';
      link.textContent = 'Download';
      link.download = item.name;
      link.href = URL.createObjectURL(item.blob);
      box.append(link);
    }
  }

  /* ── offers ── */

  function showOffer(batch) {
    const files = batch.items.filter((i) => i.kind === 'file');
    const total = DL.protocol.totalBytes(batch.items);
    const names = batch.items.slice(0, 3).map((i) => i.name).join(', ');
    const more = batch.items.length > 3 ? ` and ${batch.items.length - 3} more` : '';

    el.offerSummary.textContent = files.length
      ? `${batch.items.length} item${batch.items.length > 1 ? 's' : ''} · ${U.bytes(total)} — ${names}${more}`
      : `${names}${more}`;

    el.offerAccept.textContent = files.length > 1 && DL.transfer.HAS_DIR
      ? 'Choose a folder & accept'
      : (files.length === 1 && DL.transfer.HAS_SAVE ? 'Choose where to save' : 'Accept');

    el.offerCard.hidden = false;
    batch.items.forEach((i) => upsert(i));
    announce(`Incoming: ${el.offerSummary.textContent}`);
    el.offerAccept.focus();
  }

  /* ── input collection ── */

  // Folder drops arrive as directory entries, which have to be walked.
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
    if (!picked.length) return;
    const entries = picked.map(({ file, path }) => ({
      kind: 'file', file, name: file.name, size: file.size, mime: file.type, path,
    }));
    session.sendFiles(entries);
  }

  /* ── wiring ── */

  function wire() {
    el.copyBtn.addEventListener('click', () => copy(el.shareLink.value, el.copyBtn, 'Copy link'));
    if (el.sessionCopy) {
      el.sessionCopy.addEventListener('click', () => copy(el.sessionLink.value, el.sessionCopy, 'Copy link'));
    }

    el.pickFiles.addEventListener('click', () => el.fileInput.click());
    el.pickFolder.addEventListener('click', () => el.folderInput.click());

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

    el.drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });
    el.drop.addEventListener('click', () => el.fileInput.click());

    for (const type of ['dragenter', 'dragover']) {
      el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('hot'); });
    }
    for (const type of ['dragleave', 'drop']) {
      el.drop.addEventListener(type, () => el.drop.classList.remove('hot'));
    }
    el.drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      offerLocal(await filesFromDrop(e.dataTransfer));
    });

    el.sendText.addEventListener('click', () => {
      if (session.sendText(el.textInput.value)) el.textInput.value = '';
    });
    el.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (session.sendText(el.textInput.value)) el.textInput.value = '';
      }
    });

    // Paste a screenshot or a snippet straight into the page.
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
    el.offerDecline.addEventListener('click', () => {
      session.declineOffer();
      el.offerCard.hidden = true;
    });

    el.errorReset.addEventListener('click', () => { location.href = location.pathname; });

    window.addEventListener('beforeunload', (e) => {
      const busy = [...items.values()].some((i) => i.state === 'active');
      if (busy) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ── boot ── */

  function boot() {
    cache();
    wire();

    const hash = location.hash.slice(1);
    const isGuest = hash.startsWith(DL.session.ID_PREFIX);

    show(isGuest ? 'session' : 'invite');
    setStatus(isGuest ? 'connecting' : 'idle');

    // The host learns its link from the session; a guest already has it in the
    // address bar, and without this its Copy button would copy an empty string.
    if (isGuest && el.sessionLink) {
      el.sessionLink.value = `${location.origin}${location.pathname}#${hash}`;
    }

    session = DL.session.create({
      role: isGuest ? 'guest' : 'host',
      hostId: isGuest ? hash : null,
      on: {
        link(url) {
          el.shareLink.value = url;
          if (el.sessionLink) el.sessionLink.value = url;
          drawQr(url);
        },
        status: setStatus,
        offer: showOffer,
        item: upsert,
        error: (msg) => {
          if (el.viewSession.hidden && el.viewInvite.hidden) fail(msg);
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
