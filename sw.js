/* Offline-first shell: cache-first + short network timeout.
   Weak elevator networks must not hang on white screen. */
const CACHE_NAME = 'schedule-app-v8';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './sw.js'
];

const NETWORK_TIMEOUT_MS = 2000;
const CDN_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Precache skip', url, err);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((names) =>
        Promise.all(names.map((name) => (name !== CACHE_NAME ? caches.delete(name) : null)))
      )
    ])
  );
});

function networkWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timer);
      return res;
    })
    .catch((err) => {
      clearTimeout(timer);
      throw err;
    });
}

async function putInCache(request, response) {
  if (!response || !response.ok) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (e) {
    /* ignore quota / opaque issues */
  }
}

async function matchCache(request) {
  const direct = await caches.match(request);
  if (direct) return direct;
  const url = new URL(request.url);
  // Navigate fallbacks for different path forms
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    return (
      (await caches.match('./index.html')) ||
      (await caches.match('/index.html')) ||
      (await caches.match('./')) ||
      (await caches.match(url.pathname)) ||
      null
    );
  }
  return null;
}

/** Same-origin: serve cache immediately, refresh in background; cold miss → network with timeout */
async function handleSameOrigin(request) {
  const cached = await matchCache(request);

  if (cached) {
    // Background revalidate (do not block response)
    networkWithTimeout(request, NETWORK_TIMEOUT_MS)
      .then((res) => putInCache(request, res))
      .catch(() => {});
    return cached;
  }

  try {
    const res = await networkWithTimeout(request, NETWORK_TIMEOUT_MS);
    putInCache(request, res);
    return res;
  } catch (e) {
    const fallback = await matchCache(request);
    if (fallback) return fallback;
    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/** CDN (e.g. Firebase): prefer cache, else network with longer timeout, then cache */
async function handleCrossOrigin(request) {
  const cached = await caches.match(request);
  if (cached) {
    networkWithTimeout(request, CDN_TIMEOUT_MS)
      .then((res) => putInCache(request, res))
      .catch(() => {});
    return cached;
  }

  try {
    const res = await networkWithTimeout(request, CDN_TIMEOUT_MS);
    putInCache(request, res);
    return res;
  } catch (e) {
    const again = await caches.match(request);
    if (again) return again;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only intercept http(s)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    event.respondWith(handleSameOrigin(event.request));
    return;
  }

  // Cache Firebase / gstatic modules when possible so weak net can reuse them
  if (
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebase')
  ) {
    event.respondWith(handleCrossOrigin(event.request));
  }
});
