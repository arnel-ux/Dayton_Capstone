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
    const currentPath = window.location.pathname;
    const sidebar = document.getElementById('sidebar');

    // Sidebar Toggle: desktop collapses to an icon-only rail (state persisted
    // so it survives this app's full page reloads between routes), mobile
    // slides the sidebar in/out as an overlay drawer with a dimmed backdrop.
    const sidebarCollapse = document.getElementById('sidebarCollapse');
    const overlay = document.getElementById('sidebar-overlay');

    function openMobileDrawer() {
        sidebar.classList.add('active');
        if (overlay) overlay.classList.add('active');
        document.body.classList.add('sidebar-open');
    }
    function closeMobileDrawer() {
        sidebar.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
        document.body.classList.remove('sidebar-open');
    }

    if (sidebarCollapse && sidebar) {
        if (window.innerWidth > 768) {
            sidebarCollapse.title = sidebar.classList.contains('collapsed') ? 'Expand sidebar' : 'Collapse sidebar';
        }
        sidebarCollapse.addEventListener('click', () => {
            if (window.innerWidth > 768) {
                const isCollapsed = sidebar.classList.toggle('collapsed');
                try { localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0'); } catch (e) {}
                sidebarCollapse.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
            } else if (sidebar.classList.contains('active')) {
                closeMobileDrawer();
            } else {
                openMobileDrawer();
            }
        });
    }
    if (overlay) overlay.addEventListener('click', closeMobileDrawer);
    // Tapping a nav link on mobile should close the drawer, not leave it open
    // behind the page-transition fade.
    if (sidebar) {
        sidebar.querySelectorAll('a[href]:not([data-bs-toggle])').forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 768) closeMobileDrawer();
            });
        });
    }

    // Active link styling is fully server-rendered (layout/sidebar.ejs sets
    // `.active` on the matching <a> from `currentPath` at render time) — that
    // is the single source of truth, so this just reads it back to set the
    // navbar's page title. (This used to also add `.active` to the <li>
    // independently via a client-side href match, which could disagree with
    // the server's own class and momentarily show two "active-looking" items
    // at once — removed in favor of one authority.)
    const activeLink = sidebar && sidebar.querySelector('.nav-item a.active:not(.dropdown-toggle)');
    if (activeLink) {
        // Read from the title attribute, not innerText: when the sidebar
        // restores already collapsed, the label <span> is display:none and
        // innerText would come back empty.
        const pageTitle = (activeLink.getAttribute('title') || activeLink.innerText).trim();
        const titleElement = document.getElementById('pageTitle');
        if (titleElement) titleElement.innerText = pageTitle;
    }

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