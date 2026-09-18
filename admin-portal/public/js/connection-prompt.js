// ==========================================================================
// connection-prompt.js — "your connection can't get you through the survey;
// do you want to take it offline instead?" for every public entry point
// (/, /login, /client-login).
//
// WHY THIS IS A SHARED FILE AND NOT A FOURTH COPY
// Each of those three pages had grown its own private copy of the same two
// things: an updateOfflineIndicator() keyed on navigator.onLine, and a
// checkServerHealth() that probes /api/health. They drifted, and the drift
// was the bug: a fix applied to two of the three left the third — /login,
// the page a client actually lands on from the survey link — still silently
// stranding people. One module, three call sites.
//
// WHAT COUNTS AS "CAN'T GET THROUGH", AND WHY navigator.onLine ISN'T ENOUGH
// navigator.onLine is a two-state signal about the network INTERFACE, and it
// is wrong in both directions for this question:
//
//   - It says "online" for a phone holding one bar of mobile data that in
//     practice moves nothing. This is the literal case this prompt was asked
//     for: signal bars showing, sign-in never completing.
//   - On Android it also flips to "offline" for a connection that still has
//     full signal but no working route — which is what the reported
//     screenshots actually show: 4G bars, "No internet connection" in the
//     status bar, and both the "Viewing Offline" chip and the amber "slow or
//     unstable" chip up at the same time.
//
// So this module treats THREE observations as the same user-facing problem —
// "you cannot reach the survey right now" — and asks the same question for
// all of them:
//
//   1. navigator.onLine === false            -> STATE_OFFLINE
//   2. /api/health unreachable within 4s     -> STATE_WEAK
//   3. /api/health answers, but SLOWLY       -> STATE_WEAK
//
// (3) is the one that was missing entirely, and it is why a "mahina" data
// connection produced no prompt at all: /api/health returns about twenty
// bytes, so it completes inside a 4s abort on connections far too slow to
// carry a Google sign-in redirect or the survey page. Round-trip TIME, not
// just success, is the signal. See WEAK_LATENCY_MS.
//
// A server that ANSWERS with an error is deliberately not one of these: the
// network is fine, and an offline survey would only queue behind the same
// failing server. That case reports STATE_SERVER_DOWN and raises no prompt.
//
// NOTHING HERE EVER NAVIGATES ON ITS OWN. The visitor picks, exactly like the
// "Take Survey Offline" buttons these pages already had. That rule predates
// this file and is not relaxed by it.
// ==========================================================================

(function (global) {
    'use strict';

    var STATE_UNKNOWN = 'unknown';
    var STATE_OK = 'ok';
    var STATE_WEAK = 'weak';
    var STATE_OFFLINE = 'offline';
    var STATE_SERVER_DOWN = 'server-down';

    // Abort budget for the probe. Same 4s the pages used before, and the same
    // 4s the service worker gives a navigation — so if the probe times out,
    // the actual page loads this visitor is about to attempt would have been
    // falling back to cache anyway.
    var PROBE_TIMEOUT_MS = 4000;

    // Round-trip above which a SUCCESSFUL probe still counts as weak.
    //
    // /api/health is a bare `{"status":"ok"}` — a couple of packets, no
    // database, no rendering. On any connection worth calling usable it comes
    // back in well under 300ms. Two full seconds for that means the transport
    // itself is the bottleneck, and everything this visitor actually needs
    // (an OAuth redirect to Google and back, the survey page and its assets)
    // is one to two orders of magnitude larger. Set low enough to catch the
    // connection that "works" but cannot finish a sign-in, high enough that
    // an ordinary mobile network on a bad day doesn't trip it.
    var WEAK_LATENCY_MS = 2000;

    // Re-probe cadence. A connection degrades without firing any event at all
    // — that is exactly what walking out of Wi-Fi range onto bad data does —
    // so waiting for 'online'/'offline' is not enough. Paused while the tab is
    // hidden (see the visibilitychange handler) so a backgrounded tab isn't
    // polling the server for nothing.
    var RECHECK_MS = 20000;

    var state = STATE_UNKNOWN;
    var dismissed = false;
    var overlay = null;
    var titleEl = null;
    var bodyEl = null;
    var secondaryBtn = null;
    var recheckTimer = null;
    var probeInFlight = null;
    var options = { context: 'landing', onState: null, theme: 'auto' };

    // One-shot, tab-scoped marker meaning "the visitor deliberately chose the
    // offline survey just now".
    //
    // /survey-offline greets an arrival with "You're Back Online" whenever
    // navigator.onLine is true at load — and on the phone this was reported
    // on, navigator.onLine is true while the OS status bar says "No internet
    // connection". So tapping Take Offline Survey landed on the offline
    // survey and was immediately told the opposite, over the top of the thing
    // that had just been asked for. Choosing the offline survey is an answer;
    // the page must not re-open the question on arrival.
    var OFFLINE_INTENT_KEY = '__cqaOfflineSurveyIntent';
    // Generous enough for a slow cache-served navigation, short enough that a
    // marker can never outlive the navigation it was set for. It is removed on
    // read regardless, so this only guards the crash/abandon case.
    var OFFLINE_INTENT_TTL_MS = 120000;

    // Self-sufficient rather than depending on offline-db.js's copy: this
    // module is precached for the offline case and must not be one script-load
    // failure away from silently never probing.
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

    // The Network Information API, where it exists (Chrome/Android — i.e. the
    // browser this was reported on), already knows the connection is bad
    // without spending a request to find out. Treated as a shortcut TO the
    // weak state only, never as a veto: an absent or optimistic
    // effectiveType just means we fall through to the probe, which is the
    // authoritative signal either way.
    function connectionApiSaysWeak() {
        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (!c) return false;
        if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
        // downlink is in Mbit/s. 0 is "unknown" on some builds, so only a
        // positive-but-tiny reading counts.
        if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.15) return true;
        return false;
    }

    // Two sentences, not four. The reported card ran to five lines of body
    // text on a phone, which pushed the two buttons — the only thing being
    // asked — most of the way down the screen. What the visitor needs is what
    // is wrong and what happens to their answers; the rest was reassurance
    // nobody reads at the moment their connection has just died.
    var COPY = {
        landing: {
            weak: 'Your internet is too slow to load the survey right now. Answer it offline instead — your answers save on this device and submit automatically once you reconnect.',
            offline: 'You have no internet connection right now. You can still answer the survey offline — it saves on this device and submits automatically once you reconnect.'
        },
        login: {
            weak: 'Your internet is too slow to sign in right now. Answer the survey offline instead — your answers save on this device and submit automatically once you reconnect.',
            offline: 'You have no internet connection, so signing in cannot work. You can still answer the survey offline — it saves on this device and submits automatically once you reconnect.'
        }
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
        try { sessionStorage.setItem(OFFLINE_INTENT_KEY, String(Date.now())); } catch (e) { /* private mode — the banner just isn't suppressed */ }
    }

    // Delegated rather than bound to the dialog's own button alone: every page
    // here also carries its own "Take Survey Offline" button, and tapping that
    // one means exactly the same thing. One listener covers both, and any
    // future link to the same place, instead of three that can drift apart.
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
        // The skin is declared by the page, not guessed. /login and
        // /client-login render forceLightMode (white cards, navy buttons);
        // the landing page is permanently navy. A white dialog dropped on the
        // navy landing page is what looked foreign in the report — so each
        // page names the one that belongs to it, and 'auto' is only the
        // fallback for a page that says nothing.
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
        if (state !== STATE_WEAK && state !== STATE_OFFLINE) return;
        if (!document.body) return;
        buildOverlay();
        var copy = COPY[options.context] || COPY.landing;
        if (state === STATE_OFFLINE) {
            titleEl.textContent = 'No Internet Connection';
            bodyEl.textContent = copy.offline;
            // "Stay Online" is a promise this page cannot keep when there is
            // no connection at all — the honest label is the one that only
            // describes what the button actually does.
            secondaryBtn.textContent = 'Stay on This Page';
        } else {
            titleEl.textContent = 'Your Connection Is Weak';
            bodyEl.textContent = copy.weak;
            secondaryBtn.textContent = 'Stay Online';
        }
        overlay.hidden = false;
    }

    function hidePrompt() {
        if (overlay) overlay.hidden = true;
    }

    // "Stay Online" / "Stay on This Page". Only suppresses the dialog from
    // re-opening by itself; each page keeps its own "Take Survey Offline"
    // button visible for as long as the connection stays unusable, so the
    // route is still one tap away and the dialog does not nag. Re-armed by
    // setState() as soon as the connection actually recovers, so a LATER drop
    // on the same page load can still ask.
    function dismiss() {
        dismissed = true;
        hidePrompt();
        probe();
    }

    function setState(next) {
        if (next === state) {
            // Still unusable and the dialog was never dismissed (e.g. it was
            // raised before body existed) — make sure it is actually up.
            if (next === STATE_WEAK || next === STATE_OFFLINE) showPrompt();
            return;
        }
        state = next;
        if (state === STATE_OK) dismissed = false;
        if (typeof options.onState === 'function') {
            try { options.onState(state); } catch (e) { /* a page's own UI bug must not stop the prompt */ }
        }
        if (state === STATE_WEAK || state === STATE_OFFLINE) showPrompt();
        else hidePrompt();
    }

    function probe() {
        if (!global.navigator.onLine) {
            setState(STATE_OFFLINE);
            return Promise.resolve(STATE_OFFLINE);
        }
        if (connectionApiSaysWeak()) {
            setState(STATE_WEAK);
            return Promise.resolve(STATE_WEAK);
        }
        if (probeInFlight) return probeInFlight;
        var started = now();
        probeInFlight = fetchWithBudget('/api/health', PROBE_TIMEOUT_MS).then(
            function (res) {
                probeInFlight = null;
                var elapsed = now() - started;
                // Order matters: a slow response is a weak connection even
                // when the server answered perfectly well, so latency is
                // checked before res.ok. A slow FAILING server is reported as
                // weak too, which is the safer of the two — the offline route
                // still works for the visitor either way.
                if (elapsed > WEAK_LATENCY_MS) { setState(STATE_WEAK); return STATE_WEAK; }
                if (!res.ok) { setState(STATE_SERVER_DOWN); return STATE_SERVER_DOWN; }
                setState(STATE_OK);
                return STATE_OK;
            },
            function () {
                probeInFlight = null;
                // Aborted at 4s, or failed outright, while navigator.onLine
                // still claims we are online. This is the case the pages used
                // to render as an amber chip and nothing more.
                setState(STATE_WEAK);
                return STATE_WEAK;
            }
        );
        return probeInFlight;
    }

    function startRecheckTimer() {
        stopRecheckTimer();
        recheckTimer = setInterval(function () {
            if (document.hidden) return;
            probe();
        }, RECHECK_MS);
    }

    function stopRecheckTimer() {
        if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
    }

    function init(opts) {
        opts = opts || {};
        if (opts.context) options.context = opts.context;
        if (opts.onState) options.onState = opts.onState;

        wireOfflineIntentLinks();

        global.addEventListener('offline', function () { setState(STATE_OFFLINE); });
        global.addEventListener('online', function () { probe(); });

        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (c && typeof c.addEventListener === 'function') {
            // Fires when the radio changes generation (LTE -> 3G -> 2G), which
            // is the exact moment a working connection becomes an unusable one
            // without any online/offline event being dispatched.
            c.addEventListener('change', function () { probe(); });
        }

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) probe();
        });

        if (document.body) probe();
        else document.addEventListener('DOMContentLoaded', probe);

        startRecheckTimer();
    }

    // Pure reachability check: no state change, no UI, no prompt. For a page
    // that needs the answer but must never raise the dialog — /survey-offline
    // IS the offline survey, so asking "would you like the offline survey?"
    // there is meaningless, but it still needs to know whether its "You're
    // Back Online" banner is telling the truth.
    function isReachable() {
        if (!global.navigator.onLine) return Promise.resolve(false);
        var started = now();
        return fetchWithBudget('/api/health', PROBE_TIMEOUT_MS).then(
            function (res) { return !!res.ok && (now() - started) <= WEAK_LATENCY_MS; },
            function () { return false; }
        );
    }

    // Reads AND clears the marker — it answers exactly one page load, so a
    // genuine reconnect later in the same visit still gets its banner.
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
        // What each page keys its own "Take Survey Offline" button on. Both
        // unusable states count — the whole point is that "offline" and
        // "online but hopeless" are the same problem to the person holding
        // the phone.
        isUnusable: function () { return state === STATE_WEAK || state === STATE_OFFLINE; },
        STATE_OK: STATE_OK,
        STATE_WEAK: STATE_WEAK,
        STATE_OFFLINE: STATE_OFFLINE,
        STATE_SERVER_DOWN: STATE_SERVER_DOWN
    };
})(window);
