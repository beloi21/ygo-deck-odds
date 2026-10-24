// Offline support for the installed app.
// Pages and the banlist file: network first, so updates show up as soon as you are online.
// Built files (their names change with every build) and fonts: cache first.
// Card-database and banlist-refresh requests are never cached here (the app keeps its own card cache).
// Scan files: the manifest network first; the model and art index carry their hash in the address (?v=…), so they
// are cache first, and saving a new version drops the old one, keeping one copy of each.
const CACHE = 'oh-mi-yu-gi-v13';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './banlists.json'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(request)) ?? (await cache.match('./index.html')) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

async function scanFile(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) {
    const path = new URL(request.url).pathname;
    for (const old of await cache.keys()) if (new URL(old.url).pathname === path) await cache.delete(old);
    await cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !fonts) return;
  if (url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/scan/') && url.searchParams.has('v')) {
    event.respondWith(scanFile(request));
  } else if (request.mode === 'navigate' || url.pathname.endsWith('/banlists.json') || url.pathname.endsWith('/scan/manifest.json')) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});
