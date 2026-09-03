// Service worker for the CSPC CSM Survey site — caches the app shell so the
// client survey loads offline, and replays queued offline survey submissions
// (IndexedDB outbox, see /js/offline-db.js) via the Background Sync API.
//
// Deliberately NOT an installable PWA: no page links a web app manifest (see
// the comment in client-login.ejs/client-survey.ejs's <head>), which is what
// Chrome/Edge actually key "Add to Home Screen" / the install prompt on —
// this worker's offline caching works independently of that. Don't add a
// <link rel="manifest"> back to any page without checking that constraint
// first.

importScripts('/js/offline-db.js');

// v11: hardens precaching against ever storing a redirected/non-200 response
// under a route's cache key (see the CRITICAL_PRECACHE_URLS validation below
// and the redirect checks added to every runtime caching path) — a stale v10
// install could otherwise be holding a poisoned /survey-offline entry from
// before that validation existed. Bumping forces every client to discard v9/
// v10 (see the activate handler's existing cleanup, unchanged) and re-fetch
// everything fresh under the new cache names.
const STATIC_CACHE = 'cspc-static-v11';
const RUNTIME_CACHE = 'cspc-runtime-v11';
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// Same-origin app-shell assets that are always safe to precache.
const PRECACHE_URLS = [
    '/',
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
    '/login',
    // The unauthenticated "Take Survey Offline" entry point — precaching it
    // is the actual fix for offline access working without ever having
    // logged in first: a visitor only needs ONE prior online visit to the
    // site (any page), not a prior login, before this works offline.
    '/survey-offline'
];

// Resources the offline survey cannot function without — precached with
// strict validation (see cacheCriticalUrl below): a redirected, non-200, or
// wrong-path response is refused rather than silently cached under the
// wrong key. A failure here is logged loudly, unlike the best-effort
// PRECACHE_URLS/CDN_PRECACHE_URLS entries below (e.g. a decorative image),
// where one bad resource staying uncached is harmless.
const CRITICAL_PRECACHE_URLS = ['/survey-offline', '/js/pwa-client.js', '/js/offline-db.js', '/js/alerts.js'];

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

// Fetches and validates one CRITICAL_PRECACHE_URLS entry before storing it —
// unlike plain cache.add(url), which stores whatever response it gets
// (including one that silently followed a redirect elsewhere), this refuses
// anything that isn't a genuine, unredirected 200 for the exact path asked
// for. Never lets a redirected/login/error page get cached under a critical
// route's own key.
async function cacheCriticalUrl(cache, url) {
    console.log('[SW] Precaching', url);
    const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });

    if (!response.ok) {
        throw new Error('non-OK status ' + response.status);
    }
    if (response.redirected) {
        console.warn('[SW] Refused redirected precache response for', url);
        throw new Error('response was redirected');
    }
    if (new URL(response.url).pathname !== url) {
        console.warn('[SW] Refused precache response with unexpected path for', url);
        throw new Error('response path mismatch');
    }

    await cache.put(url, response.clone());
    console.log('[SW] Cached', url, 'successfully');
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);

        // Critical resources: validated individually (see cacheCriticalUrl)
        // and loudly logged on failure — the offline survey depends on
        // these actually being correct, not just present.
        await Promise.allSettled(
            CRITICAL_PRECACHE_URLS.map((url) =>
                cacheCriticalUrl(cache, url).catch((err) => console.error('[SW] Failed to precache critical resource', url, err))
            )
        );

        // Deliberately NOT cache.addAll(PRECACHE_URLS) — addAll is all-or-nothing,
        // so a single transient failure (one blip on one resource, a session-state
        // redirect on /client-login, ...) would silently fail the ENTIRE install
        // and leave nothing precached at all, with offline support then depending
        // entirely on whatever incidental runtime caching happened to occur later.
        // Precaching every URL independently means one bad resource costs only
        // that resource. The remaining (non-critical, best-effort) entries here
        // may include duplicates of the critical URLs above — cache.add() simply
        // overwrites with an equally-fresh copy in that case, which is harmless.
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

    // Full-page navigations (e.g. opening /survey-offline, /client-survey,
    // /login): try the network first so authenticated/dynamic content stays
    // fresh, but fall back to that EXACT page's own cached copy when
    // there's no connection — /survey-offline included, since it's
    // precached above specifically so it works with zero prior
    // authentication. There is deliberately no generic "you're offline"
    // fallback page for anything not already cached: a page that was never
    // cached simply fails the navigation, same as any ordinary broken/
    // unreachable request — this worker doesn't paper over that with a
    // substitute page.
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

        // Only cache a genuine, unredirected 200 for the exact URL requested.
        // fetch() transparently follows redirects (e.g. ensureClientAuth's
        // res.redirect(302, '/login') for an unauthenticated /client-survey
        // request) — without this check, that redirected login page would
        // get cached under the ORIGINAL request's key, so a later offline
        // navigation to that original page would silently serve the wrong
        // cached page instead of failing naturally. The response is still
        // returned to the browser normally either way (an online user's
        // redirect must still work) — this only refuses to cache it.
        if (response.ok && !response.redirected) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, response.clone());
        }
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
        console.log('[SW] Navigation network failed; checking exact cache');
        const runtimeCache = await caches.open(RUNTIME_CACHE);
        const freshCached = await runtimeCache.match(request);
        if (freshCached) {
            console.log('[SW] Serving cached', new URL(request.url).pathname);
            return freshCached;
        }

        const cached = await caches.match(request);
        if (cached) {
            console.log('[SW] Serving cached', new URL(request.url).pathname);
            return cached;
        }

        // No generic offline fallback page anymore — a navigation to a page
        // that was never cached (and the network is unreachable) simply
        // fails naturally here. The browser shows its own native offline
        // error for that case, which is correct: there is nothing this
        // worker can substitute in that isn't misleading (see the comment
        // on the fetch handler above for why that page was removed).
        throw err;
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const networkFetch = fetchWithTimeout(request, {}, ASSET_TIMEOUT_MS)
        .then((response) => {
            // !response.redirected: same reasoning as handleNavigation above —
            // never let a redirected response get cached under a different
            // asset's key.
            if (response && response.ok && !response.redirected) cache.put(request, response.clone());
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
        if (response && response.ok && !response.redirected) {
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
