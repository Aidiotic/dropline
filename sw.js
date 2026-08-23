/* Offline app shell.
 *
 * Caching a static site is normally how you end up serving stale code, and an
 * earlier version of dropline was bitten by exactly that. It is safe here only
 * because the build fingerprints its output: dropline.<hash>.js and
 * style.<hash>.css are immutable by construction, so cache-first is not merely
 * an optimisation, it is correct.
 *
 * Everything else — the HTML that names those files, and config.js which is
 * meant to be editable on a live deploy — is network-first, so a deploy is
 * picked up on the next load with the network available.
 */

const VERSION = 'dropline-v3';
const SHELL = `${VERSION}-shell`;
const IMMUTABLE = `${VERSION}-assets`;

const FINGERPRINTED = /\/(?:dropline|style)\.[0-9a-f]{6,}\.(?:js|css)$/;
const SHELL_URLS = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {})           // offline at install time is not fatal
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch the CDN or a TURN endpoint

  if (FINGERPRINTED.test(url.pathname)) {
    event.respondWith(cacheFirst(req, IMMUTABLE));
    return;
  }

  // HTML and config must never go stale: try the network, fall back to cache
  // only when there isn't one.
  event.respondWith(networkFirst(req, SHELL));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req) || await cache.match('./');
    if (hit) return hit;
    throw err;
  }
}
