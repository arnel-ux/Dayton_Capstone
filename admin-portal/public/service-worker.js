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

// v18: offline-db.js gained the active-survey-draft store (IndexedDB schema
// v2->v3) and pwa-client.js's queueSurveyOffline() gained an optional
// preferred-id parameter — both files are in CRITICAL_PRECACHE_URLS, so
// clients must discard v17's precached copies to pick up the "Continue
// Survey" bridge (see client-survey.ejs). No IndexedDB data is lost by this
// bump — the *service worker* cache version is unrelated to and does not
// clear the IndexedDB database itself (a separate, unversioned-by-this
// mechanism origin store); onupgradeneeded only ever adds the new object
// store alongside the existing ones.
// v24: added the admin-path bypass below (isAdminProtectedPath) — bumped so
// activate's cache-name purge (see below) discards any authenticated admin
// page snapshot a v23-or-earlier install may have already cached into
// RUNTIME_CACHE before this bypass existed.
// v25: client-survey.ejs mobile-responsiveness pass (SQD emoji hidden on
// phones, Thank You page's Submit Again/Logout buttons resized) — bumped so
// a v24-or-earlier install's precached copy of that file is discarded.
// v26: index.ejs mobile-centering fix (.kpi-strip grid tracks were pushing
// the page wider than the viewport on narrow phones; .bg-image/.bg-overlay
// and the dashboard decorative glow no longer depend on 100vw/a global
// overflow-x:hidden band-aid to stay on-screen) — bumped so a v25-or-earlier
// install's precached copy of '/' (see PRECACHE_URLS) is discarded.
// v27: client-survey.ejs logged-in user panel pass — Survey History's
// .history-item/.history-detail-head no longer let the "Completed"/status
// badge float mid-line or get squeezed by a long office name, and the
// mobile header's English/Tagalog toggle moved from the right to the left
// (row 2, under the title) — bumped so a v26-or-earlier install's
// precached copy of that file is discarded.
// v28: Online-vs-Offline canonical-precedence fix — offline-db.js's
// runOfflineSurveySync() and pwa-client.js's notifySyncResult() now handle
// the new 'retry_later' (keep queued, don't drop) and 'superseded_by_online'
// (resolved, but not a real sync — accurate message, never "submitted
// successfully") statuses from /sync-surveys; this file's own background
// sync handler passes supersededCount through to the page. Bumped so a
// v27-or-earlier install's precached copies of offline-db.js/pwa-client.js
// (both in CRITICAL_PRECACHE_URLS) are discarded — those old copies would
// otherwise silently drop a 'retry_later' item from the outbox forever.
// v29: (1) pwa-client.js's automatic offline-verification flow no longer
// ever pops the "Account Verification Required" password prompt on
// reconnect (only ever used the RAM-cached password silently; a missing
// cache now just leaves the record untouched instead of re-prompting) —
// the manual "Verify Account" retry button/prompt was removed too. (2)
// client-survey.ejs/theme-toggle.ejs mobile-first compaction pass (header,
// Home, Terms, survey banner, progress stepper, Citizen's Charter, SQD,
// History badge, nav buttons, floating theme button all resized to target
// mobile scale; the View-Profile min-height/centering rule that was
// reintroducing a blank-gap-under-header effect was removed). Bumped so a
// v28-or-earlier install's precached copies of pwa-client.js,
// client-survey.ejs, and theme-toggle.ejs are discarded.
//
// v30: second mobile-density pass tightening client-survey.ejs's <=576px
// header/language-selector/stepper/CSM-banner/Client-Profile/Citizen's
// Charter/SQD rules, login.ejs + client-login.ejs's <=480/600px hero/badge/
// card/input/button rules, and theme-toggle.ejs's floating button offsets —
// bumped again so a v29-or-earlier install's precached copies of these three
// views are discarded in favor of the new CSS.
// v31: round-2 mobile-density pass (client-survey.ejs Home/History/CC/SQD/
// stage2/progress-stepper, login.ejs + client-login.ejs card/field/button
// spacing) — bumped so v30-or-earlier installs pick up the tighter CSS.
// v32: index.ejs (public landing page, precached via '/' in PRECACHE_URLS)
// mobile-density pass — header hamburger, hero profile card/avatar, Who We
// Are heading/paragraph/badges, footer socials/headings/contact text, Our
// Services cluster tabs/office accordion rows, and Transparency Dashboard
// KPI value/label + chart card header all tightened for phone widths.
// Bumped so a v31-or-earlier install's precached copy of '/' is discarded.
// v33: icon webfonts (bootstrap-icons.woff2/.woff, Font Awesome's
// all.min.css + fa-solid/regular/brands woff2) added to CDN_PRECACHE_URLS,
// and login.ejs gained the offline layout/steps block. Only the install
// handler populates CDN_PRECACHE_URLS, so without this bump an existing
// install would keep its v32 RUNTIME_CACHE and never fetch the fonts — the
// offline tofu boxes would persist on every device that has already visited
// the site, which is all of them.
const STATIC_CACHE = 'cspc-static-v33';
const RUNTIME_CACHE = 'cspc-runtime-v33';
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
    // ---- ICON WEBFONTS ----
    // The two icon CSS files are useless offline on their own: they only
    // declare @font-face, and every `bi bi-*` / `fas fa-*` glyph lives in the
    // binary font file the CSS points at. Precaching the CSS but not the font
    // is what made /survey-offline render empty tofu boxes where the sidebar,
    // hamburger, fullscreen and section icons should be — the CSS was cached,
    // the font was not, so the browser had a font-family it could not load.
    // (The theme toggle's moon kept working throughout precisely because it's
    // an inline <svg>, not a webfont glyph — that contrast is the tell.)
    //
    // These were reaching the cache only by luck before: cdn.jsdelivr.net and
    // cdnjs.cloudflare.com are in RUNTIME_CACHE_HOSTS, so a font fetched
    // during an online visit WHILE this worker already controlled the page got
    // runtime-cached. On a first visit the worker isn't controlling yet, so
    // the font request bypasses it entirely and nothing is stored. Listing
    // them here makes it deterministic at install time instead.
    //
    // The ?dd670… on the Bootstrap Icons URLs is the cache-buster baked into
    // bootstrap-icons.css's own @font-face src — the Cache API matches on the
    // FULL url including the query, so the entries must carry it verbatim or
    // the browser's request would miss them. cacheFirst() also falls back to
    // an ignoreSearch match for font files, so a future version bump that
    // changes this hash degrades to a stale-but-working glyph set rather than
    // silently returning the tofu boxes.
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2?dd67030699838ea613ee6dbda90effa6',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff?dd67030699838ea613ee6dbda90effa6',
    // Font Awesome — used by the views that include layout/header.ejs, which
    // is how /login (precached above) draws its icons, including the offline
    // card's own wifi/clipboard/sync glyphs. The CSS itself was never listed
    // here at all. fa-solid carries ~249 of the ~255 icons used across the
    // views; regular and brands are 3 each but are cheap and complete the set.
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

// This worker registers with root scope ('/'), inherited from whichever
// public/client page (client-login, index, login, client-survey) happened to
// register it first — so it just as happily intercepts navigations to
// authenticated admin pages in the same browser, even though no admin page
// itself references this file. handleNavigation's cache.put() below does not
// consult the server's own Cache-Control: no-store header (the Cache API
// never does), so without this bypass a stale, still-"logged in"-looking
// admin page could survive in RUNTIME_CACHE past logout/session invalidation
// and get served back the next time a live fetch to that same URL fails
// (offline/timeout) — a gap the server's no-store headers and the client-side
// bfcache pageshow guard (public/js/main.js) don't cover, since neither one
// runs for a response the Cache API hands back directly. Treated the same as
// /api/ and /logout above: never read from or written to any SW cache.
const ADMIN_PROTECTED_PATH_PREFIXES = [
    '/dashboard', '/report', '/profile', '/password', '/print',
    '/survey-records', '/offices', '/manage-admins', '/survey',
    '/cluster', '/clusters', '/services', '/admins', '/settings',
    '/period-covered', '/office-approvals', '/office-logout'
];

function isAdminProtectedPath(pathname) {
    // Exact match or a real sub-path only — startsWith alone would also
    // match unrelated public routes that share a prefix, e.g. '/survey'
    // must not swallow '/survey-offline' (the unauthenticated offline entry
    // point, precached above specifically so it works with zero prior login).
    return ADMIN_PROTECTED_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

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

    // /logout must always reach the live network directly, same reasoning
    // as /api/ above — it's a plain GET (not request.mode:'navigate' when
    // called via fetch() from attemptPendingClientLogout() in
    // offline-db.js), so without this bypass it would otherwise fall
    // through to the generic same-origin staleWhileRevalidate handler
    // below. That path still works correctly today (it guards against
    // caching a redirected response), but session termination is exactly
    // the kind of request that should never be anywhere near a cache layer
    // — this removes the ambiguity outright instead of relying on that
    // guard continuing to hold.
    if (url.origin === self.location.origin && url.pathname === '/logout') {
        return;
    }

    // Authenticated admin/office pages: never cache, never serve from cache.
    // See ADMIN_PROTECTED_PATH_PREFIXES/isAdminProtectedPath above.
    if (url.origin === self.location.origin && isAdminProtectedPath(url.pathname)) {
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

// Icon/text webfonts are routinely served with a cache-busting query string
// that belongs to the STYLESHEET's version, not the font's (Bootstrap Icons'
// ?dd670… is the live example — see CDN_PRECACHE_URLS). The Cache API matches
// on the full URL, so bumping the icon package to a version with a different
// hash would turn every precached font into a miss and bring the tofu boxes
// straight back. For a font file specifically, the same path with a different
// query is the same typeface, so falling back to an ignoreSearch match is
// safe and keeps icons rendering offline across such a bump.
//
// Deliberately NOT applied to every CDN request: fonts.googleapis.com serves
// completely different stylesheets off the single path /css2, distinguished
// only by ?family=… — an unscoped ignoreSearch there would happily return the
// Inter stylesheet for a Plus Jakarta Sans request.
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
