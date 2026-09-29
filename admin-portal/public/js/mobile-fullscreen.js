// Puts the page into fullscreen on phones so the address bar doesn't eat screen space.
// Only fires on the visitor's first tap since fullscreen requires a real user gesture, and only tries once per tab.
(function () {
    'use strict';

    var ONCE_KEY = 'cqa_fs_attempted';

    // Phones and small tablets only, desktop stays windowed.
    function isHandheld() {
        var narrow = window.matchMedia('(max-width: 62rem)').matches;
        var coarse = window.matchMedia('(pointer: coarse)').matches;
        return narrow && coarse;
    }

    function alreadyFullscreen() {
        return !!(document.fullscreenElement ||
                  document.webkitFullscreenElement ||
                  document.msFullscreenElement);
    }

    function attempted() {
        try { return sessionStorage.getItem(ONCE_KEY) === '1'; } catch (e) { return false; }
    }

    function markAttempted() {
        try { sessionStorage.setItem(ONCE_KEY, '1'); } catch (e) { /* private mode, may retry next load */ }
    }

    function request() {
        var el = document.documentElement;
        var fn = el.requestFullscreen ||
                 el.webkitRequestFullscreen ||
                 el.msRequestFullscreen;
        if (!fn) return; // iOS Safari and anything else without the API
        try {
            var result = fn.call(el);
            // Swallows the rejection when the browser denies the request, so it doesn't show as a console error.
            if (result && typeof result.catch === 'function') {
                result.catch(function () { /* denied, page works fine windowed */ });
            }
        } catch (e) { /* older WebKit throws synchronously instead */ }
    }

    function arm() {
        if (!isHandheld() || attempted() || alreadyFullscreen()) return;

        function onFirstGesture(e) {
            // Skips elements that opt out with data-no-fullscreen, plus form inputs.
            if (e.target && e.target.closest &&
                e.target.closest('[data-no-fullscreen], input, select, textarea')) {
                return;
            }
            markAttempted();
            detach();
            request();
        }

        function detach() {
            document.removeEventListener('click', onFirstGesture, true);
            document.removeEventListener('touchend', onFirstGesture, true);
        }

        // Uses the capture phase so this still runs even if a handler further down stops propagation.
        document.addEventListener('click', onFirstGesture, true);
        document.addEventListener('touchend', onFirstGesture, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arm);
    } else {
        arm();
    }
})();
