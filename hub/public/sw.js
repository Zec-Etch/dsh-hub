// Offline shell only. Backend pages and every API stay network-only: a cached session
// view would look live while the backend is unreachable.
const CACHE = 'dsh-hub-shell-3';
const SHELL = ['/', '/index.html', '/app.js', '/lib.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/favicon.svg', '/icons/favicon-dark.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  if (url.pathname.startsWith('/h/')) {
    // A dropped connection lands on the picker, which explains the state and reconnects.
    if (request.mode === 'navigate') event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/shell/')) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && SHELL.includes(url.pathname)) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(async () => (await caches.match(request)) ?? (request.mode === 'navigate' ? caches.match('/') : Response.error())));
});
