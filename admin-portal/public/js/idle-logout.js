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

    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function (evt) {
        window.addEventListener(evt, resetTimer, { passive: true });
    });

    resetTimer();
})();
