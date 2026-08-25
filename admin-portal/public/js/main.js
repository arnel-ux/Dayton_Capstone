// BFCache guard: Chrome/Safari/Firefox can restore a page instantly from the
// back/forward cache on Back/Forward navigation, completely skipping a fresh
// request to the server — meaning our Cache-Control/session middleware never
// even runs. `pageshow`'s event.persisted (and, as a fallback for engines that
// don't set it consistently, the Navigation Timing API's back_forward type)
// both indicate the page came from that cache rather than the network, so we
// force a hard reload — that reload IS a real request, so /login redirects and
// no-cache headers apply normally again.
window.addEventListener('pageshow', function (event) {
    var navEntries = (window.performance && performance.getEntriesByType) ? performance.getEntriesByType('navigation') : [];
    var isBackForwardNav = navEntries.length > 0 && navEntries[0].type === 'back_forward';
    if (event.persisted || isBackForwardNav) {
        window.location.reload();
    }
});

document.addEventListener("DOMContentLoaded", function() {
    // Sidebar Toggle
    const sidebarCollapse = document.getElementById('sidebarCollapse');
    const sidebar = document.getElementById('sidebar');
    if (sidebarCollapse && sidebar) {
        sidebarCollapse.addEventListener('click', () => sidebar.classList.toggle('active'));
    }

    // Active Link Highlighting
    const currentPath = window.location.pathname;
    document.querySelectorAll('#sidebar .nav-item a').forEach(link => {
        if(link.getAttribute('href') === currentPath) {
            link.parentElement.classList.add('active');
            const pageTitle = link.innerText.trim();
            const titleElement = document.getElementById('pageTitle');
            if(titleElement) titleElement.innerText = pageTitle;
        }
    });

    // Smooth page transitions: every sidebar link is a real page load (no SPA
    // router), so we fake a crossfade by fading #content out before letting
    // the navigation happen, and #content fades in on arrival via CSS.
    const content = document.getElementById('content');
    if (content) {
        document.querySelectorAll('#sidebar a[href]:not([data-bs-toggle])').forEach(link => {
            link.addEventListener('click', function(e) {
                const href = link.getAttribute('href');
                const isSamePage = href === currentPath;
                const isModifiedClick = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
                if (isSamePage || isModifiedClick || link.target === '_blank') return;

                e.preventDefault();
                content.classList.add('page-fade-out');
                setTimeout(() => { window.location.href = href; }, 180);
            });
        });
    }
});