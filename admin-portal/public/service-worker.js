// Service worker for the CSPC CSM Survey PWA — caches the app shell so the
// client survey loads offline, and replays queued offline survey submissions
// (IndexedDB outbox, see /js/offline-db.js) via the Background Sync API.

importScripts('/js/offline-db.js');

const STATIC_CACHE = 'cspc-static-v2';
const RUNTIME_CACHE = 'cspc-runtime-v2';
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// Same-origin app-shell assets that are always safe to precache.
const PRECACHE_URLS = [
    '/manifest.json',
    '/offline.html',
    '/js/alerts.js',
    '/js/offline-db.js',
    '/js/pwa-client.js',
    '/icons/icon.svg',
    '/client-login',
    '/login'
];

// Third-party libraries the survey/login pages load from a CDN. Cached
// individually (not via cache.addAll) so one failure doesn't abort install.
const CDN_PRECACHE_URLS = [
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11',
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap'
];

const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(PRECACHE_URLS);

        const runtimeCache = await caches.open(RUNTIME_CACHE);
        await Promise.allSettled(
            CDN_PRECACHE_URLS.map((url) =>
                runtimeCache.add(url).catch((err) => console.warn('[SW] Failed to precache', url, err))
            )
        );
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // API calls always need live, authenticated data — never a cache-first
    // snapshot from whenever a given endpoint happened to be fetched for
    // the first time.
    // This service worker is registered with root scope ('/'), so without
    // this early bypass it would just as happily intercept and permanently
    // stale-cache admin-portal API calls as it does the public survey's.
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
        return;
    }

    // Full-page navigations (e.g. opening /client-survey, /login): try the
    // network first so authenticated/dynamic content stays fresh, but fall
    // back to whatever was last cached — or the offline fallback page —
    // when there's no connection.
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    // Same-origin static assets (CSS/JS/images): serve the cached copy
    // instantly if there is one, but always refetch in the background and
    // update the cache — so a deployed CSS/JS change reaches clients on
    // their very next load instead of being frozen forever like cacheFirst.
    if (url.origin === self.location.origin) {
        event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
        return;
    }

    if (RUNTIME_CACHE_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    }
});

async function handleNavigation(request) {
    try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, response.clone());
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fallback = await caches.match('/offline.html');
        return fallback || Response.error();
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const networkFetch = fetch(request)
        .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => cached);
    return cached || networkFetch;
}

async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const fallback = await caches.match(request);
        if (fallback) return fallback;
        throw err;
    }
}

// ==========================================
// BACKGROUND SYNC — batch-replays the offline outbox to /sync-surveys once
// connectivity returns. That route awaits AI sentiment/topic analysis for
// every survey before inserting it, so by the time this resolves each synced
// survey is already fully analyzed — see runOfflineSurveySync() in
// /js/offline-db.js for the shared request/cleanup logic.
// ==========================================
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-surveys') {
        event.waitUntil(handleBackgroundSync());
    }
});

async function handleBackgroundSync() {
    let result;
    try {
        result = await runOfflineSurveySync();
    } catch (err) {
        // Still offline, or the request otherwise failed — leave the outbox
        // untouched, the next 'sync' event (or the page's 'online' fallback)
        // will retry it.
        console.error('[SW] Offline survey sync failed:', err);
        return;
    }

    if (result.syncedCount > 0 || result.failedResults.length > 0) {
        const clientsList = await self.clients.matchAll({ type: 'window' });
        clientsList.forEach((client) => client.postMessage({
            type: 'SURVEYS_SYNCED',
            count: result.syncedCount,
            failed: result.failedResults
        }));
    }
}
