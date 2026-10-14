/* SalesMesh service worker.
 * Caches only the public shell: /_next/static/*, /icons/*, /offline and /. Never /api/* and never
 * authenticated HTML (dashboards are fetched from the network every time). Offline navigations
 * fall back to /offline. Source of truth for public/sw.js, which scripts/stamp-sw.mjs generates
 * (prebuild / predev) with BUILD_ID stamped in. Edit this file, not public/sw.js. */
const BUILD_ID = 'dev';
const CACHE = `salesmesh-shell-${BUILD_ID}`;
const PRECACHE = ['/', '/offline', '/icons/192', '/icons/512'];

/** Same-origin /_next/static/* URLs referenced by an HTML page (its CSS, JS and fonts). */
const staticAssetsIn = (html) => [...new Set(html.match(/\/_next\/static\/[^"'\s\\)]+/g) || [])];

async function install() {
  const cache = await caches.open(CACHE);
  await cache.addAll(PRECACHE);
  // The first visit's chunks load before this SW controls the page, so /offline's own assets are
  // cached here; otherwise the offline page would render unstyled and without JS.
  const offline = await cache.match('/offline');
  if (offline) await cache.addAll(staticAssetsIn(await offline.text()));
  await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('salesmesh-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStaticAsset = (path) => path.startsWith('/_next/static/') || path.startsWith('/icons/');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only, never cached

  if (isStaticAsset(url.pathname)) {
    // Content-hashed and immutable: cache first.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
            }
            return res;
          })
      )
    );
    return;
  }

  if (request.mode === 'navigate') {
    // Network first, no HTML is written to the cache here; offline gets the precached shell.
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        const fallback = url.pathname === '/' ? await cache.match('/') : null;
        return fallback || (await cache.match('/offline')) || Response.error();
      })
    );
  }
});
