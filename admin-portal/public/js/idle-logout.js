// Logs the user out after 5 minutes of no activity.
// The page must set window.__idleLogoutUrl first or this does nothing.
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

    // Listens in the capture phase so activity is still caught even if something
    // stops propagation, including scroll events that don't bubble to window.
    [
        'mousemove', 'mousedown', 'keydown', 'scroll', 'wheel',
        'touchstart', 'touchmove', 'pointerdown', 'pointermove',
        'click', 'input'
    ].forEach(function (evt) {
        document.addEventListener(evt, resetTimer, { passive: true, capture: true });
    });

    // Network requests count as activity too, not just mouse and keyboard input.
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
