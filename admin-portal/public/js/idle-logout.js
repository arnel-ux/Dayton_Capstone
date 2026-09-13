// Auto-logout after 5 minutes of no user activity. The page that includes this
// script must set window.__idleLogoutUrl to the correct scoped logout link
// (e.g. '/logout?scope=admin', '/logout?scope=client', '/office-logout')
// before loading this file; without it, nothing runs.
(function () {
    var IDLE_LIMIT_MS = 5 * 60 * 1000;
    var logoutUrl = window.__idleLogoutUrl;
    if (!logoutUrl) return;

    var timer = null;

    function doLogout() {
        window.location.href = logoutUrl;
    }

    function resetTimer() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(doLogout, IDLE_LIMIT_MS);
    }

    // Capture phase so activity is still seen even if a component (modal,
    // dropdown, data table, etc.) calls stopPropagation() on the bubble
    // phase, and so scroll events inside inner scrollable containers (which
    // don't bubble to window at all) are still caught.
    [
        'mousemove', 'mousedown', 'keydown', 'scroll', 'wheel',
        'touchstart', 'touchmove', 'pointerdown', 'pointermove',
        'click', 'input'
    ].forEach(function (evt) {
        document.addEventListener(evt, resetTimer, { passive: true, capture: true });
    });

    // Any network request the admin's own actions trigger (saving a form,
    // loading a record, etc.) also counts as activity, even during stretches
    // with no mouse/keyboard input in between.
    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function () {
            resetTimer();
            return originalFetch.apply(this, arguments);
        };
    }
    if (window.XMLHttpRequest) {
        var originalOpen = window.XMLHttpRequest.prototype.open;
        window.XMLHttpRequest.prototype.open = function () {
            resetTimer();
            return originalOpen.apply(this, arguments);
        };
    }

    resetTimer();
})();
