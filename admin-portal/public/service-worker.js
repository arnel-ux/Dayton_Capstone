// Service worker for the CSPC CSM Survey site. Caches the app shell so the
// survey works offline and replays queued offline submissions through
// Background Sync. Not an installable PWA on purpose, no page links a manifest.

importScripts('/js/offline-db.js');

// Cache version bumps whenever a precached file changes, so old installs drop
// their stale copy and refetch instead of serving it forever.
const STATIC_CACHE = 'cspc-static-v52';
const RUNTIME_CACHE = 'cspc-runtime-v52';
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// Same-origin app-shell assets that are always safe to precache.
const PRECACHE_URLS = [
    '/',
    '/js/alerts.js',
    '/css/alerts.css',
    '/css/style.css',
    '/css/auth.css',
    '/css/offline-pill.css',
    '/js/offline-db.js',
    '/js/pwa-client.js',
    '/icons/icon.svg',
    '/images/cspc-logo.png',
    // Shared login/survey/landing-page backdrop, hosted locally so it's a
    // same-origin asset the browser precaches and keeps fresh itself.
    '/images/campus-monument.jpg',
    '/client-login',
    '/login',
    // The unauthenticated "Take Survey Offline" entry point. Works offline
    // after one prior visit to the site, no login required.
    '/survey-offline'
];

// Resources the offline survey needs to work. Precached with strict
// validation, and failures here are logged loudly unlike the best-effort lists below.
const CRITICAL_PRECACHE_URLS = ['/survey-offline', '/js/pwa-client.js', '/js/offline-db.js', '/js/connection-prompt.js', '/js/alerts.js', '/css/alerts.css', '/css/auth.css', '/css/offline-pill.css'];

// Third-party libraries the survey/login pages load from a CDN. Cached
// individually so one failure doesn't abort install.
const CDN_PRECACHE_URLS = [
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css',
    // Icon webfonts. The CSS files alone are useless offline since the actual
    // glyphs live in these font files, so they're listed here too.
    // Query string is part of the cache key, keep it as is.
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2?dd67030699838ea613ee6dbda90effa6',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff?dd67030699838ea613ee6dbda90effa6',
    // Font Awesome, used wherever layout/header.ejs is included.
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-regular-400.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/webfonts/fa-brands-400.woff2',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11',
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap'
];

const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'spims.cspc.edu.ph'];

// This worker has root scope, so it also intercepts admin/office page
// navigations even though those pages never register it. These paths are
// never read from or written to any SW cache.
const ADMIN_PROTECTED_PATH_PREFIXES = [
    '/dashboard', '/report', '/profile', '/password', '/print',
    '/survey-records', '/offices', '/manage-admins', '/survey',
    '/cluster', '/clusters', '/services', '/admins', '/settings',
    '/period-covered', '/office-approvals', '/office-dashboard', '/office-logout',
    '/user-accounts'
];

function isAdminProtectedPath(pathname) {
    // Exact match or a real sub-path only, so '/survey' doesn't swallow '/survey-offline'.
    return ADMIN_PROTECTED_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// Fetches and validates a critical URL before storing it. Rejects anything
// that isn't an unredirected 200 for the exact path asked for.
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

        // Critical resources get validated individually and failures are logged loudly.
        await Promise.allSettled(
            CRITICAL_PRECACHE_URLS.map((url) =>
                cacheCriticalUrl(cache, url).catch((err) => console.error('[SW] Failed to precache critical resource', url, err))
            )
        );

        // Each URL is cached independently instead of cache.addAll, so one bad
        // resource doesn't fail the whole install.
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

    // API calls always need live data, never served from cache.
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
        return;
    }

    // Logout always goes straight to the network, never through the cache layer.
    if (url.origin === self.location.origin && url.pathname === '/logout') {
        return;
    }

    // Authenticated admin/office pages: never cache, never serve from cache.
    if (url.origin === self.location.origin && isAdminProtectedPath(url.pathname)) {
        return;
    }

    // Full page navigations try the network first and fall back to that exact
    // page's cached copy when offline. No generic offline fallback page, a
    // page that was never cached just fails the navigation.
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    // Same-origin static assets serve the cached copy instantly, then refetch
    // in the background to keep the cache fresh for next time.
    if (url.origin === self.location.origin) {
        event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
        return;
    }

    if (RUNTIME_CACHE_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    }
});

// Timeouts before falling back to cache on a flaky connection.
const NAVIGATION_TIMEOUT_MS = 4000;
const ASSET_TIMEOUT_MS = 6000;

async function handleNavigation(request) {
    let serverError = null;
    try {
        const response = await fetchWithTimeout(request, {}, NAVIGATION_TIMEOUT_MS);

        // Treat a 5xx like being offline, serve the last good cached copy instead.
        if (response.status >= 500) {
            serverError = response;
            throw new Error('server error ' + response.status);
        }

        // Only cache a genuine, unredirected 200 for the exact URL requested,
        // so a redirect (like an auth bounce to /login) never gets cached
        // under the original page's key.
        if (response.ok && !response.redirected) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        // Check RUNTIME_CACHE before STATIC_CACHE so a page that's been
        // fetched fresh always wins over its frozen install-time snapshot.
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

        if (serverError) return serverError;

        // No cached copy and no network, the navigation just fails naturally.
        throw err;
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const networkFetch = fetchWithTimeout(request, {}, ASSET_TIMEOUT_MS)
        .then((response) => {
            // Never cache a redirected response under a different asset's key.
            if (response && response.ok && !response.redirected) cache.put(request, response.clone());
            return response;
        })
        .catch(() => cached);
    return cached || networkFetch;
}

// Font files match ignoring their query string, since a version bump to the
// icon package changes the hash but not the typeface. Not used for other CDN
// requests since some of those serve different content off the same path.
const FONT_FILE_RE = /\.(woff2?|ttf|otf|eot)$/i;

async function matchFontIgnoringQuery(request) {
    if (!FONT_FILE_RE.test(new URL(request.url).pathname)) return undefined;
    return caches.match(request, { ignoreSearch: true });
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
        const fontFallback = await matchFontIgnoringQuery(request);
        if (fontFallback) return fontFallback;
        throw err;
    }
}

// Replays the offline outbox to /sync-surveys once connectivity returns.
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
        // Still offline or the request failed, leave the outbox untouched for the next retry.
        console.error('[SW] Offline survey sync failed:', err);
        return;
    }

    if (result.syncedCount > 0 || result.supersededCount > 0 || result.failedResults.length > 0) {
        const clientsList = await self.clients.matchAll({ type: 'window' });
        clientsList.forEach((client) => client.postMessage({
            type: 'SURVEYS_SYNCED',
            count: result.syncedCount,
            supersededCount: result.supersededCount || 0,
            failed: result.failedResults
        }));
    }
}
