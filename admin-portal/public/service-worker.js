// Service worker for the CSPC CSM Survey PWA — caches the app shell so the
// client survey loads offline, and replays queued offline survey submissions
// (IndexedDB outbox, see /js/offline-db.js) via the Background Sync API.

importScripts('/js/offline-db.js');

const STATIC_CACHE = 'cspc-static-v6';
const RUNTIME_CACHE = 'cspc-runtime-v6';
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// Same-origin app-shell assets that are always safe to precache.
const PRECACHE_URLS = [
    '/',
    '/manifest.json',
    '/offline.html',
    '/js/alerts.js',
    '/js/offline-db.js',
    '/js/pwa-client.js',
    '/icons/icon.svg',
    '/images/cspc-logo.png',
    // Shared login/survey/landing-page backdrop — now hosted locally
    // (used to point at spims.cspc.edu.ph, a separate domain outside this
    // app's control whose content changed out from under us) so it's a
    // same-origin asset the browser precaches and keeps fresh itself,
    // same as cspc-logo.png above, with no separate CDN entry needed.
    '/images/campus-monument.jpg',
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

const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'spims.cspc.edu.ph'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil((async () => {
        // Deliberately NOT cache.addAll(PRECACHE_URLS) — addAll is all-or-nothing,
        // so a single transient failure (one blip on one resource, a session-state
        // redirect on /client-login, ...) would silently fail the ENTIRE install
        // and leave nothing precached at all, with offline support then depending
        // entirely on whatever incidental runtime caching happened to occur later.
        // Precaching every URL independently means one bad resource costs only
        // that resource.
        const cache = await caches.open(STATIC_CACHE);
        await Promise.allSettled(
            PRECACHE_URLS.map((url) =>
                cache.add(url).catch((err) => console.warn('[SW] Failed to precache', url, err))
            )
        );

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

// 4s is generous for a live connection (the app shell is small, same-origin)
// but short enough that a flaky/partial connection — Wi-Fi still "connected"
// with no real route out, a captive portal, a hung TCP handshake — fails
// over to the cache quickly instead of leaving the tab on a spinner until the
// browser's own multi-second-to-tens-of-seconds connection timeout fires
// (which surfaces as the browser's native "took too long to respond" page,
// never even reaching the offline fallback below).
const NAVIGATION_TIMEOUT_MS = 4000;
const ASSET_TIMEOUT_MS = 6000;

async function handleNavigation(request) {
    try {
        const response = await fetchWithTimeout(request, {}, NAVIGATION_TIMEOUT_MS);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, response.clone());
        return response;
    } catch (err) {
        // Check RUNTIME_CACHE before STATIC_CACHE. Pages like '/', '/login',
        // '/client-login' are baked into STATIC_CACHE once at install time
        // and never touched again after that — only a successful network
        // fetch above ever rewrites a page, and that always lands in
        // RUNTIME_CACHE. Plain caches.match() with no cache name checks
        // every cache and can return whichever one it opened first, which
        // in practice kept surfacing that frozen install-time snapshot
        // (an old footer layout, say) even after this exact page had
        // already been fetched fresh and cached in RUNTIME_CACHE during a
        // later online visit. Checking RUNTIME_CACHE explicitly first means
        // any page that's ever been fetched fresh always wins over the
        // stale precached copy.
        const runtimeCache = await caches.open(RUNTIME_CACHE);
        const freshCached = await runtimeCache.match(request);
        if (freshCached) return freshCached;

        const cached = await caches.match(request);
        if (cached) return cached;
        const fallback = await caches.match('/offline.html');
        return fallback || Response.error();
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const networkFetch = fetchWithTimeout(request, {}, ASSET_TIMEOUT_MS)
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
        const response = await fetchWithTimeout(request, {}, ASSET_TIMEOUT_MS);
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
