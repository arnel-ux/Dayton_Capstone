// =============================================================================
// Mobile auto-fullscreen
// =============================================================================
// Goal: on a phone, give the page the whole screen so the browser's address bar
// isn't eating vertical space while the user scrolls.
//
// IMPORTANT — why this fires on the first tap and not on page load:
// requestFullscreen() requires "transient activation", i.e. it must run inside
// a real user gesture. Calling it on DOMContentLoaded/load is rejected by every
// current browser ("API can only be initiated by a user gesture"). There is no
// flag, permission or workaround that changes that — it's a deliberate
// anti-hijacking rule. So the earliest legitimate moment is the visitor's first
// tap, which is what this listens for.
//
// Platform reality:
//   - Android Chrome/Edge/Samsung Internet: works.
//   - iOS Safari (iPhone): the Fullscreen API does not exist for ordinary
//     elements — only <video>. This will simply do nothing there, by design,
//     not by failure. iPhone users still get the browser's own address-bar
//     auto-hide when they scroll down.
//
// It deliberately tries ONCE per tab. If the visitor leaves fullscreen (back
// gesture, the browser's own exit affordance), that's an explicit choice and
// the page does not drag them back in.
(function () {
    'use strict';

    var ONCE_KEY = 'cqa_fs_attempted';

    // Phones and small tablets only. A desktop browser gets nothing: taking over
    // someone's whole monitor because they clicked a link would be hostile, and
    // the address bar costs nothing there.
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
        try { sessionStorage.setItem(ONCE_KEY, '1'); } catch (e) { /* private mode — just means it may retry next load */ }
    }

    function request() {
        var el = document.documentElement;
        var fn = el.requestFullscreen ||
                 el.webkitRequestFullscreen ||
                 el.msRequestFullscreen;
        if (!fn) return; // iOS Safari and anything else without the API
        try {
            var result = fn.call(el);
            // Chrome returns a promise that rejects if the gesture wasn't
            // accepted; an unhandled rejection would show up as a console error
            // on a perfectly normal page, so it's swallowed here.
            if (result && typeof result.catch === 'function') {
                result.catch(function () { /* denied — nothing to do, page works fine windowed */ });
            }
        } catch (e) { /* older WebKit throws synchronously instead */ }
    }

    function arm() {
        if (!isHandheld() || attempted() || alreadyFullscreen()) return;

        function onFirstGesture(e) {
            // Ignore taps on things whose own behaviour would be confused by a
            // viewport change mid-interaction, and on anything that deliberately
            // opts out via data-no-fullscreen.
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

        // Capture phase so this still runs when a handler further down calls
        // stopPropagation (the landing page's hamburger does exactly that).
        document.addEventListener('click', onFirstGesture, true);
        document.addEventListener('touchend', onFirstGesture, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arm);
    } else {
        arm();
    }
})();
