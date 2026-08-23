/* dropline download worker.
 *
 * Browsers without the File System Access API (Firefox, Safari, iOS) otherwise
 * have to assemble the whole file in memory before offering it as a Blob, which
 * is exactly the ceiling that breaks large transfers on a phone. Instead the
 * page hands bytes to this worker, which serves them as the body of a synthetic
 * attachment response — so the browser's own download manager writes to disk and
 * memory stays flat.
 *
 * Deliberately caches nothing. It intercepts its own __dl__ URLs and ignores
 * every other request, so it can never serve a stale app.js.
 */

const pending = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'register') return;

  const port = event.ports[0];
  if (!port) return;

  let ctrl = null;

  // pull() is the backpressure signal: the worker only asks the page for more
  // once the download has actually consumed what it already has.
  const body = new ReadableStream({
    start(c) { ctrl = c; },
    pull() { port.postMessage({ type: 'pull' }); },
    cancel() {
      pending.delete(msg.id);
      port.postMessage({ type: 'cancel' });
    },
  });

  port.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === 'chunk') ctrl.enqueue(new Uint8Array(m.chunk));
      else if (m.type === 'end') ctrl.close();
      else if (m.type === 'abort') ctrl.error(new Error('sender aborted'));
    } catch {
      // stream already closed or errored — nothing useful to do
    }
  };

  pending.set(msg.id, { body, name: msg.name, size: msg.size });
  port.postMessage({ type: 'ready' });

  // Don't leak a stream if the download is never started.
  setTimeout(() => pending.delete(msg.id), 60000);
});

self.addEventListener('fetch', (event) => {
  const match = new URL(event.request.url).pathname.match(/__dl__\/([^/]+)$/);
  if (!match) return; // leave every other request completely alone

  const entry = pending.get(match[1]);
  if (!entry) return;
  pending.delete(match[1]);

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Security-Policy': "default-src 'none'",
    'Content-Disposition':
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
  });
  if (entry.size) headers.set('Content-Length', String(entry.size));

  event.respondWith(new Response(entry.body, { headers }));
});
