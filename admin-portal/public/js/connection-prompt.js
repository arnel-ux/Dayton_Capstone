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
//     full signal but no working route — 4G bars, "No internet connection" in
//     the status bar, and the page unable to reach anything.
//
// So this module treats two observations as the same user-facing problem —
// "you cannot reach the survey right now":
//
//   1. navigator.onLine === false                  -> STATE_OFFLINE
//   2. /api/health repeatedly unreachable or slow  -> STATE_WEAK
//
// A server that ANSWERS with an error is deliberately neither: the network is
// fine, and an offline survey would only queue behind the same failing
// server. That reports STATE_SERVER_DOWN and raises no prompt.
//
// HOW (2) IS JUDGED — AND WHY IT IS NOT A SINGLE TIMED REQUEST
// The first version of this took one /api/health round trip during page
// bootstrap and called anything over 2000ms weak. On a perfectly good 4G
// connection that produced a dialog over a landing page whose dashboard had
// already rendered and whose reCAPTCHA had already loaded — and then never
// retracted it. A flat threshold measures the SERVER's baseline as much as
// the user's connection, and page-load is the one moment when the probe is
// queued behind everything else the page is fetching.
//
// What replaced it is slow to accuse and quick to acquit: the first sample
// only seeds a baseline and can never convict, a sample counts as slow only
// if it is slow in absolute terms AND relative to this server's own best
// showing, it takes two bad samples in a row to declare weak, and a single
// good sample clears it at once. The asymmetry is the point — a false
// positive puts an alarming dialog over a working site, while a false
// negative merely means the offline survey is not OFFERED, with the button
// that reaches it still on the page. See the constants below.
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

    // ---- WHAT COUNTS AS A BAD SAMPLE, AND HOW MANY IT TAKES ----------------
    //
    // The first version of this judged the connection on ONE /api/health
    // round trip against a flat 2000ms bar, taken during page bootstrap. On a
    // perfectly good 4G connection that reported "weak" and then never let go
    // of it: the landing page's dashboard had fully rendered and reCAPTCHA had
    // loaded, and the dialog was still up. Two separate mistakes:
    //
    //   1. A FLAT THRESHOLD ASSUMES A BASELINE NOBODY MEASURED. 2000ms is only
    //      meaningful next to what this server normally answers in. A host
    //      that takes 1.5s on its best day fails a 2s bar for every visitor
    //      alive, and no amount of signal strength can fix that — the verdict
    //      was about the server, while the text blamed the user's internet.
    //
    //   2. THE WORST POSSIBLE MOMENT TO MEASURE IS PAGE LOAD. The probe was
    //      queued behind the dashboard API call, the fonts, the chart library
    //      and reCAPTCHA, on a cold TLS connection. That sample says nothing
    //      about the network and everything about what else was in flight.
    //
    // So: the first sample only seeds the baseline and can never convict; a
    // sample is slow relative to the fastest one this session as well as in
    // absolute terms; and it takes two bad samples in a row to declare weak.
    // One good sample clears it instantly.
    //
    // The asymmetry is deliberate. A false positive puts an alarming dialog
    // over a working site; a false negative just means the visitor is not
    // OFFERED the offline survey, while the button that reaches it is still
    // right there on the page. So this is slow to accuse and quick to acquit.

    // Hard budget. A probe that does not finish in this long has not finished
    // at all, and that — unlike mild slowness — is unambiguous.
    var PROBE_TIMEOUT_MS = 4000;

    // Absolute floor for "slow". Below this, nothing is ever called slow no
    // matter what the baseline is, so a server that answers in 40ms can't have
    // a 200ms blip counted against it.
    var SLOW_ABSOLUTE_MS = 3000;

    // ...and relative to this server's own demonstrated best. Both must be
    // exceeded, so a habitually slow host raises its own bar instead of
    // condemning every visitor.
    var SLOW_BASELINE_MULTIPLE = 4;

    // Consecutive bad samples required before the dialog is allowed to appear.
    // One blip is a blip.
    var REQUIRED_BAD_SAMPLES = 2;

    // Recheck cadence. Faster while something is wrong, because "it should go
    // away by itself once my internet is fine again" is the whole point;
    // slower when everything is fine, so a healthy page isn't chattering at
    // the server for no reason.
    var RECHECK_OK_MS = 30000;
    var RECHECK_BAD_MS = 8000;

    // Let the page finish loading before measuring anything. See mistake (2).
    var FIRST_PROBE_SETTLE_MS = 1500;

    var state = STATE_UNKNOWN;
    var dismissed = false;
    var overlay = null;
    var titleEl = null;
    var bodyEl = null;
    var secondaryBtn = null;
    var recheckTimer = null;
    var recheckEveryMs = null;
    var probeInFlight = null;
    // Set the first time this page load reaches STATE_WEAK, and never cleared.
    //
    // "Stay Online" must not be a dead end. The visitor was told their
    // connection is too weak to reach the survey and chose to keep waiting —
    // if the page then quietly withdraws the offline route, the only thing
    // that choice accomplished was closing the door they were just shown. And
    // a connection that has proved this bad once is likely to be bad again a
    // minute later, when the dialog will not be on screen to offer it.
    //
    // So the DIALOG is a one-time question and the BUTTON is a standing offer.
    // The amber notice deliberately does NOT follow this flag — it is a claim
    // about the connection right now, and leaving it up after recovery would
    // be the false alarm this was already fixed for once. A button is only an
    // option; a warning is an assertion.
    var offlineRouteEarned = false;
    var badStreak = 0;
    var fastestSampleMs = Infinity;
    var sampledOnce = false;
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

    // WEAK ONLY — there is deliberately no copy for the offline case.
    //
    // A dialog is for a decision, and being completely disconnected does not
    // present one. With no network at all the page has exactly one thing it
    // can offer, it already offers it in place (the "Viewing Offline" chip and
    // the "Take Survey Offline" button both appear on their own), and putting
    // a modal in front of that only adds a tap between the visitor and the
    // single route still open to them. So: no data and no Wi-Fi drops the page
    // straight into its offline state with no interruption.
    //
    // A WEAK connection is the opposite — there really are two reasonable
    // answers, keep waiting or go offline, and the visitor is the only one who
    // can pick. That is the one case that earns a dialog.
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
        // STATE_OFFLINE never reaches here — see the comment on COPY.
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
            // Still weak and the dialog was never dismissed (e.g. it was
            // raised before body existed) — make sure it is actually up.
            if (next === STATE_WEAK) showPrompt();
            return;
        }
        state = next;
        if (state === STATE_OK) dismissed = false;
        if (typeof options.onState === 'function') {
            try { options.onState(state); } catch (e) { /* a page's own UI bug must not stop the prompt */ }
        }

        if (state === STATE_WEAK) {
            offlineRouteEarned = true;
            showPrompt();
            // Check back sooner while something is wrong, so "my internet is
            // fine again, why is this still here?" is answered in seconds.
            scheduleRecheck(RECHECK_BAD_MS);
        } else if (state === STATE_OFFLINE) {
            // No dialog here, by design. The page drops into its own offline
            // state (chip + offline-survey route) via the onState callback
            // above, with nothing in the way. If a weak-connection dialog was
            // already up when the connection died completely, it is taken
            // down rather than left standing over a question that no longer
            // has two answers.
            hidePrompt();
            scheduleRecheck(RECHECK_BAD_MS);
        } else {
            hidePrompt();
            scheduleRecheck(RECHECK_OK_MS);
        }
    }

    // A sample is bad if the probe did not complete, or if it completed but
    // was slow BOTH in absolute terms and relative to this server's best
    // showing this session. Returns true for bad.
    function sampleIsBad(failed, elapsedMs) {
        if (failed) return true;
        if (elapsedMs <= SLOW_ABSOLUTE_MS) return false;
        return elapsedMs > (fastestSampleMs * SLOW_BASELINE_MULTIPLE);
    }

    // Folds one observation into the verdict. Good samples acquit immediately
    // and reset the streak; bad ones only convict once REQUIRED_BAD_SAMPLES
    // have landed in a row, and never on the very first sample of the session
    // (which exists to establish the baseline — see the comment on the
    // constants above).
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

        // The warmup sample still seeds the baseline above, but cannot by
        // itself put a dialog on the screen. It does start the streak, so a
        // genuinely dead connection is caught on the very next probe rather
        // than being given a free pass.
        badStreak++;
        if (isFirst) return false;
        return badStreak >= REQUIRED_BAD_SAMPLES;
    }

    function probe() {
        if (!global.navigator.onLine) {
            // Not a measurement — the interface itself is down. No streak, no
            // baseline; this is directly observable and needs no corroboration.
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

                // A response came back, so the network works. A server that
                // answers with an error is a server problem, not a connection
                // problem, and an offline survey would only queue behind the
                // same failing server — so it never raises the dialog. It also
                // does not pollute the latency baseline.
                if (!res.ok) {
                    badStreak = 0;
                    setState(STATE_SERVER_DOWN);
                    return STATE_SERVER_DOWN;
                }

                if (recordSample(false, elapsed)) { setState(STATE_WEAK); return STATE_WEAK; }
                setState(STATE_OK);
                return STATE_OK;
            },
            function () {
                probeInFlight = null;
                // The connection can drop entirely while this probe is in
                // flight — and it then fails for that reason, not because the
                // link is merely weak. Reporting weak here is what put the
                // amber "slow or unstable" chip on screen underneath a "No
                // internet connection" status bar, saying two different things
                // about one connection.
                if (!global.navigator.onLine) { setState(STATE_OFFLINE); return STATE_OFFLINE; }
                // Aborted at PROBE_TIMEOUT_MS, or failed outright, while
                // navigator.onLine still claims we are online.
                if (recordSample(true, null)) { setState(STATE_WEAK); return STATE_WEAK; }
                // Suspicious but unconfirmed: say nothing yet. The faster
                // recheck cadence below means the second opinion arrives
                // within seconds, not half a minute.
                scheduleRecheck(RECHECK_BAD_MS);
                return state;
            }
        );
        return probeInFlight;
    }

    // The Network Information API, where it exists (Chrome/Android), reports
    // the radio's own view of the link. Deliberately NOT a verdict on its own:
    // it is an estimate, it lags, and acting on it directly is how a dialog
    // ends up over a page that is visibly working. It only shortens the wait
    // for a real measurement.
    function connectionApiSuggestsWeak() {
        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (!c) return false;
        if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
        // downlink is in Mbit/s; 0 means "unknown" on some builds, so only a
        // positive-but-tiny reading counts.
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
        // This was missing, and it is why the landing page's dialog rendered
        // in the light skin over a navy page: the theme was accepted into the
        // defaults object but never read off the caller's options.
        if (opts.theme) options.theme = opts.theme;

        wireOfflineIntentLinks();

        global.addEventListener('offline', function () { setState(STATE_OFFLINE); });
        global.addEventListener('online', function () {
            // Coming back from a real outage: forget the old baseline and
            // streak, they describe a connection that no longer exists.
            badStreak = 0;
            fastestSampleMs = Infinity;
            sampledOnce = false;
            probe();
        });

        var c = global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection;
        if (c && typeof c.addEventListener === 'function') {
            // Fires when the radio changes generation (LTE -> 3G -> 2G). Not a
            // verdict — just a reason to go and measure sooner than the timer
            // would have.
            c.addEventListener('change', function () { probe(); });
        }

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) probe();
        });

        // Deliberately NOT measured during page bootstrap: the first probe
        // waits for load plus a short settle, so it is timing the network
        // rather than the queue behind the dashboard fetch, the fonts, the
        // charts and reCAPTCHA. Until then the page simply says nothing, which
        // is the correct thing to say when nothing is known yet.
        function startProbing() {
            setTimeout(function () {
                probe();
                scheduleRecheck(RECHECK_OK_MS);
            }, FIRST_PROBE_SETTLE_MS);
        }

        // navigator.onLine === false needs no measurement and no settle — it
        // is directly observable, so report it at once.
        if (!global.navigator.onLine) setState(STATE_OFFLINE);
        // A radio that already says 2g is worth probing sooner than the full
        // settle, but still gets a real measurement before anything is shown.
        else if (connectionApiSuggestsWeak()) setTimeout(probe, 300);

        if (document.readyState === 'complete') startProbing();
        else global.addEventListener('load', startProbing);
    }

    // Pure reachability check: no state change, no UI, no prompt. For a page
    // that needs the answer but must never raise the dialog — /survey-offline
    // IS the offline survey, so asking "would you like the offline survey?"
    // there is meaningless, but it still needs to know whether its "You're
    // Back Online" banner is telling the truth.
    function isReachable() {
        if (!global.navigator.onLine) return Promise.resolve(false);
        // No latency test here, unlike the weak-connection verdict. This
        // answers a different and much simpler question — "is the server
        // actually there?" — for /survey-offline's "You're Back Online"
        // banner. A slow answer is still an answer, and being back online on
        // a slow connection is true.
        return fetchWithBudget('/api/health', PROBE_TIMEOUT_MS).then(
            function (res) { return !!res.ok; },
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
        // What a page should key its "Take Survey Offline" button on — as
        // opposed to isUnusable(), which is the live state and is what the
        // amber notice and the offline layout follow. Once the connection has
        // proved unusable on this page load, the route stays on offer even if
        // a later probe comes back clean. See offlineRouteEarned.
        offerOfflineRoute: function () {
            return offlineRouteEarned || state === STATE_WEAK || state === STATE_OFFLINE;
        },
        STATE_OK: STATE_OK,
        STATE_WEAK: STATE_WEAK,
        STATE_OFFLINE: STATE_OFFLINE,
        STATE_SERVER_DOWN: STATE_SERVER_DOWN
    };
})(window);
