// Logs the user out after 5 minutes of no activity in ANY open tab.
// The page must set window.__idleLogoutUrl first or this does nothing.
(function () {
    var IDLE_LIMIT_MS = 5 * 60 * 1000;
    var WRITE_THROTTLE_MS = 1000;
    var logoutUrl = window.__idleLogoutUrl;
    if (!logoutUrl) return;

    // The session cookie is shared by every tab, so activity has to be shared too.
    // Otherwise an idle background tab logs out the whole session while the user is
    // busy in another tab. Keyed per logout URL so admin, office and client don't mix.
    var STORAGE_KEY = 'cqa_last_activity:' + logoutUrl;
    var lastLocal = Date.now();
    var lastWrite = 0;
    var timer = null;

    function readShared() {
        try {
            var v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
            return isNaN(v) ? 0 : v;
        } catch (e) { return 0; }
    }

    function lastActivity() {
        return Math.max(lastLocal, readShared());
    }

    function schedule(delay) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, delay);
    }

    // Fires when the timer elapses. Only logs out if no tab has been active since;
    // otherwise waits out whatever is left of the idle window.
    function check() {
        var remaining = IDLE_LIMIT_MS - (Date.now() - lastActivity());
        if (remaining <= 0) {
            window.location.href = logoutUrl;
        } else {
            schedule(remaining);
        }
    }

    function markActive() {
        var now = Date.now();
        lastLocal = now;
        if (now - lastWrite >= WRITE_THROTTLE_MS) {
            lastWrite = now;
            try { localStorage.setItem(STORAGE_KEY, String(now)); } catch (e) {}
        }
        schedule(IDLE_LIMIT_MS);
    }

    // Listens in the capture phase so activity is still caught even if something
    // stops propagation, including scroll events that don't bubble to window.
    [
        'mousemove', 'mousedown', 'keydown', 'scroll', 'wheel',
        'touchstart', 'touchmove', 'pointerdown', 'pointermove',
        'click', 'input'
    ].forEach(function (evt) {
        document.addEventListener(evt, markActive, { passive: true, capture: true });
    });

    // Coming back to a tab (or waking the laptop) re-checks right away, since
    // background timers are throttled and can fire late or not at all.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) check();
    });

    // Network requests deliberately do NOT count as activity: the notification and
    // dashboard pollers fire on their own, which would keep an untouched page alive forever.

    markActive();
})();
