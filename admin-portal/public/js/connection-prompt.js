// Shows a "your connection is too weak, take the survey offline?" prompt on /, /login, and /client-login.
// Shared so the offline detection logic lives in one place instead of three drifting copies.

(function (global) {
    'use strict';

    var STATE_UNKNOWN = 'unknown';
    var STATE_OK = 'ok';
    var STATE_WEAK = 'weak';
    var STATE_OFFLINE = 'offline';
    var STATE_SERVER_DOWN = 'server-down';

    // Tuning for how a "weak connection" gets detected and confirmed.

    // A probe that takes longer than this counts as timed out.
    var PROBE_TIMEOUT_MS = 4000;

    // Minimum response time to even consider calling a sample slow.
    var SLOW_ABSOLUTE_MS = 3000;

    // A sample also has to be this many times slower than the fastest one seen to count as slow.
    var SLOW_BASELINE_MULTIPLE = 4;

    // How many bad samples in a row before the dialog shows.
    var REQUIRED_BAD_SAMPLES = 2;

    // How often to recheck the connection when things are fine vs when something's wrong.
    var RECHECK_OK_MS = 30000;
    var RECHECK_BAD_MS = 8000;

    // Wait this long after page load before probing at all.
    var FIRST_PROBE_SETTLE_MS = 1500;

    // Wait this long before taking the confirming sample after a bad one.
    var CONFIRM_DELAY_MS = 1800;

    var state = STATE_UNKNOWN;
    var dismissed = false;
    var overlay = null;
    var titleEl = null;
    var bodyEl = null;
    var secondaryBtn = null;
    var recheckTimer = null;
    var recheckEveryMs = null;
    var probeInFlight = null;
    // True once this page load has seen STATE_WEAK. Keeps the offline survey button showing
    // even after the connection recovers, since it can easily drop again.
    var offlineRouteEarned = false;

    // Persisted in sessionStorage so the flag survives navigating between pages in the same tab.
    var OFFLINE_ROUTE_KEY = '__cqaOfflineRouteEarned';
    var OFFLINE_ROUTE_TTL_MS = 1800000; // 30 minutes

    function rememberOfflineRouteEarned() {
        offlineRouteEarned = true;
        try { sessionStorage.setItem(OFFLINE_ROUTE_KEY, String(Date.now())); } catch (e) { /* private mode, falls back to in-memory only */ }
    }

    function forgetOfflineRouteEarned() {
        offlineRouteEarned = false;
        try { sessionStorage.removeItem(OFFLINE_ROUTE_KEY); } catch (e) { /* nothing to clear */ }
    }

    function restoreOfflineRouteEarned() {
        var raw = null;
        try { raw = sessionStorage.getItem(OFFLINE_ROUTE_KEY); } catch (e) { return; }
        if (!raw) return;
        var when = parseInt(raw, 10);
        if (!when || isNaN(when) || (Date.now() - when) > OFFLINE_ROUTE_TTL_MS) {
            forgetOfflineRouteEarned();
            return;
        }
        // Restores the flag quietly, no dialog or banner, this page's own probe decides the rest.
        offlineRouteEarned = true;
    }
    var badStreak = 0;
    var fastestSampleMs = Infinity;
    var sampledOnce = false;
    var options = { context: 'landing', onState: null, theme: 'auto' };

    // One-shot marker meaning the visitor just chose to go to the offline survey.
    var OFFLINE_INTENT_KEY = '__cqaOfflineSurveyIntent';
    // How long the marker stays valid before it's ignored.
    var OFFLINE_INTENT_TTL_MS = 120000;

    // Doesn't reuse offline-db.js's copy, this module needs to work standalone.
    function fetchWithBudget(url, timeoutMs) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var opts = { cache: 'no-store' };
        if (controller) opts.signal = controller.signal;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);
        return fetch(url, opts).then(
            function (res) { clearTimeout(timer); return res; },
            function (err) { clearTimeout(timer); throw err; }
        );
    }

    function now() {
        return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    }

    // Only the weak state gets a dialog. Fully offline just drops the page into its own
    // offline UI (chip and button) with nothing to decide, so no prompt is needed there.
    var COPY = {
        landing: 'Your internet is too slow to load the survey right now. Answer it offline instead — your answers save on this device and submit automatically once you reconnect.',
        login: 'Your internet is too slow to sign in right now. Answer the survey offline instead — your answers save on this device and submit automatically once you reconnect.'
    };

    function resolveTheme() {
        if (options.theme === 'dark' || options.theme === 'light') return options.theme;
        var attr = document.documentElement.getAttribute('data-bs-theme');
        if (attr === 'dark') return 'dark';
        if (attr === 'light') return 'light';
        if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
    }

    function markOfflineIntent() {
        try { sessionStorage.setItem(OFFLINE_INTENT_KEY, String(Date.now())); } catch (e) { /* private mode, banner just isn't suppressed */ }
    }

    // One listener for every "Take Survey Offline" link on the page, not just the dialog's own.
    function wireOfflineIntentLinks() {
        document.addEventListener('click', function (e) {
            var link = e.target && e.target.closest ? e.target.closest('a[href^="/survey-offline"]') : null;
            if (link) markOfflineIntent();
        }, true);
    }

    function buildOverlay() {
        if (overlay) return overlay;
        var el = document.createElement('div');
        el.id = 'connectionPrompt';
        // Each page passes in its own theme (light or dark) so the dialog matches it.
        el.className = 'weak-connection-overlay wc-theme-' + resolveTheme();
        el.hidden = true;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', 'connectionPromptTitle');
        el.innerHTML =
            '<div class="weak-connection-card">' +
                '<div class="weak-connection-icon"><i class="fas fa-wifi"></i></div>' +
                '<h4 id="connectionPromptTitle">Your Connection Is Weak</h4>' +
                '<p id="connectionPromptBody"></p>' +
                '<div class="weak-connection-actions">' +
                    '<a href="/survey-offline" class="wc-btn-primary"><i class="fas fa-clipboard-list"></i> Take Offline Survey</a>' +
                    '<button type="button" class="wc-btn-secondary" id="connectionPromptStayBtn">Stay Online</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(el);
        overlay = el;
        titleEl = el.querySelector('#connectionPromptTitle');
        bodyEl = el.querySelector('#connectionPromptBody');
        secondaryBtn = el.querySelector('#connectionPromptStayBtn');
        secondaryBtn.addEventListener('click', dismiss);
        return el;
    }

    function showPrompt() {
        if (dismissed) return;
        // Offline never reaches here, only weak gets a dialog.
        if (state !== STATE_WEAK) return;
        if (!document.body) return;
        buildOverlay();
        titleEl.textContent = 'Your Connection Is Weak';
        bodyEl.textContent = COPY[options.context] || COPY.landing;
        secondaryBtn.textContent = 'Stay Online';
        overlay.hidden = false;
    }

    function hidePrompt() {
        if (overlay) overlay.hidden = true;
    }

    // Dismissing just hides the dialog, the offline survey button stays visible on the page.
    function dismiss() {
        dismissed = true;
        hidePrompt();
        probe();
    }

    function setState(next) {
        if (next === state) {
            // Still weak and the dialog somehow isn't showing, make sure it is.
            if (next === STATE_WEAK) showPrompt();
            return;
        }
        state = next;
        if (state === STATE_OK) {
            dismissed = false;
            // Connection is fine again, withdraw the standing offline offer.
            forgetOfflineRouteEarned();
        }
        if (typeof options.onState === 'function') {
            try { options.onState(state); } catch (e) { /* a page's own UI bug must not stop the prompt */ }
        }

        if (state === STATE_WEAK) {
            rememberOfflineRouteEarned();
            showPrompt();
            scheduleRecheck(RECHECK_BAD_MS);
        } else if (state === STATE_OFFLINE) {
            rememberOfflineRouteEarned();
            // No dialog here, the page's own offline UI already covers it.
            hidePrompt();
            scheduleRecheck(RECHECK_BAD_MS);
        } else {
            hidePrompt();
            scheduleRecheck(RECHECK_OK_MS);
        }
    }

    // A sample is bad if it failed, or if it was slow both in absolute terms and relative
    // to the fastest sample seen so far.
    function sampleIsBad(failed, elapsedMs) {
        if (failed) return true;
        if (elapsedMs <= SLOW_ABSOLUTE_MS) return false;
        return elapsedMs > (fastestSampleMs * SLOW_BASELINE_MULTIPLE);
    }

    // Tracks bad samples in a row and decides when that's enough to call the connection weak.
    function recordSample(failed, elapsedMs) {
        if (!failed && typeof elapsedMs === 'number' && elapsedMs < fastestSampleMs) {
            fastestSampleMs = elapsedMs;
        }

        var bad = sampleIsBad(failed, elapsedMs);
        var isFirst = !sampledOnce;
        sampledOnce = true;

        if (!bad) {
            badStreak = 0;
            return false;
        }

        // The first sample only sets the baseline, it can't trigger weak on its own.
        badStreak++;
        if (isFirst) return false;
        return badStreak >= REQUIRED_BAD_SAMPLES;
    }

    function probe() {
        if (!global.navigator.onLine) {
            // Directly observable, no need to measure anything.
            setState(STATE_OFFLINE);
            return Promise.resolve(STATE_OFFLINE);
        }
        if (probeInFlight) return probeInFlight;

        var started = now();
        probeInFlight = fetchWithBudget('/api/health', PROBE_TIMEOUT_MS).then(
            function (res) {
                probeInFlight = null;
                if (!global.navigator.onLine) { setState(STATE_OFFLINE); return STATE_OFFLINE; }
                var elapsed = now() - started;

                // Got a response, so the network is fine. An error response means the server
                // is down, not the connection, so it doesn't count as weak.
                if (!res.ok) {
                    badStreak = 0;
                    setState(STATE_SERVER_DOWN);
                    return STATE_SERVER_DOWN;
                }

                if (recordSample(false, elapsed)) { setState(STATE_WEAK); return STATE_WEAK; }
                // Slow but not yet confirmed weak, keep the current state and recheck soon.
                if (badStreak > 0) { setTimeout(probe, CONFIRM_DELAY_MS); return state; }
                setState(STATE_OK);
                return STATE_OK;
            },
            function () {
                probeInFlight = null;
                // If the connection dropped entirely while this was in flight, report offline instead.
                if (!global.navigator.onLine) { setState(STATE_OFFLINE); return STATE_OFFLINE; }
                if (recordSample(true, null)) { setState(STATE_WEAK); return STATE_WEAK; }
                setTimeout(probe, CONFIRM_DELAY_MS);
                return state;
            }
        );
        return probeInFlight;
    }

    // Reads the browser's own connection estimate, where available, just to probe sooner.
    // Never trusted on its own since it's laggy and can be wrong.
    function connectionApiSuggestsWeak() {
        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (!c) return false;
        if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
        // downlink is in Mbit/s, 0 means unknown on some builds.
        if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.15) return true;
        return false;
    }

    function scheduleRecheck(ms) {
        if (recheckTimer && recheckEveryMs === ms) return;
        if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
        recheckEveryMs = ms;
        recheckTimer = setInterval(function () {
            if (document.hidden) return;
            probe();
        }, ms);
    }


    function init(opts) {
        opts = opts || {};
        if (opts.context) options.context = opts.context;
        if (opts.onState) options.onState = opts.onState;
        if (opts.theme) options.theme = opts.theme;

        // Restore any earlier "weak connection" flag before probing so the offer shows right away.
        restoreOfflineRouteEarned();
        if (offlineRouteEarned && typeof options.onState === 'function') {
            try { options.onState(state); } catch (e) { /* page UI bug must not stop the probe */ }
        }

        wireOfflineIntentLinks();

        global.addEventListener('offline', function () { setState(STATE_OFFLINE); });
        global.addEventListener('online', function () {
            // Reset the baseline and streak, they describe a connection that no longer applies.
            badStreak = 0;
            fastestSampleMs = Infinity;
            sampledOnce = false;
            probe();
        });

        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (c && typeof c.addEventListener === 'function') {
            // Just a hint to probe sooner when the radio's connection type changes.
            c.addEventListener('change', function () { probe(); });
        }

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) probe();
        });

        // First probe waits for the page to finish loading plus a short settle time,
        // so it measures the network instead of everything else the page is fetching.
        function startProbing() {
            setTimeout(function () {
                probe();
                scheduleRecheck(RECHECK_OK_MS);
            }, FIRST_PROBE_SETTLE_MS);
        }

        if (!global.navigator.onLine) setState(STATE_OFFLINE);
        else if (connectionApiSuggestsWeak()) setTimeout(probe, 300);

        if (document.readyState === 'complete') startProbing();
        else global.addEventListener('load', startProbing);
    }

    // Just checks reachability, no state change or dialog. Used by /survey-offline for its
    // own "you're back online" banner.
    function isReachable() {
        if (!global.navigator.onLine) return Promise.resolve(false);
        return fetchWithBudget('/api/health', PROBE_TIMEOUT_MS).then(
            function (res) { return !!res.ok; },
            function () { return false; }
        );
    }

    // Reads and clears the offline intent marker in one go.
    function consumeOfflineIntent() {
        var raw = null;
        try {
            raw = sessionStorage.getItem(OFFLINE_INTENT_KEY);
            sessionStorage.removeItem(OFFLINE_INTENT_KEY);
        } catch (e) { return false; }
        if (!raw) return false;
        var when = parseInt(raw, 10);
        if (!when || isNaN(when)) return false;
        return (Date.now() - when) < OFFLINE_INTENT_TTL_MS;
    }

    global.ConnectionPrompt = {
        init: init,
        probe: probe,
        dismiss: dismiss,
        isReachable: isReachable,
        markOfflineIntent: markOfflineIntent,
        consumeOfflineIntent: consumeOfflineIntent,
        getState: function () { return state; },
        // What a page uses to know if the connection is currently unusable.
        isUnusable: function () { return state === STATE_WEAK || state === STATE_OFFLINE; },
        // What a page uses to decide whether to keep showing the offline survey button.
        offerOfflineRoute: function () {
            return offlineRouteEarned || state === STATE_WEAK || state === STATE_OFFLINE;
        },
        STATE_OK: STATE_OK,
        STATE_WEAK: STATE_WEAK,
        STATE_OFFLINE: STATE_OFFLINE,
        STATE_SERVER_DOWN: STATE_SERVER_DOWN
    };
})(window);
