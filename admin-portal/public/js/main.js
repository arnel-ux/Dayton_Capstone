// Some browsers can restore this page straight from cache on back/forward nav, skipping a real request to the server.
// This forces a reload when that happens, and sends the user back to the login page if this tab visited it before.
window.addEventListener('pageshow', function (event) {
    var navEntries = (window.performance && performance.getEntriesByType) ? performance.getEntriesByType('navigation') : [];
    var isBackForwardNav = navEntries.length > 0 && navEntries[0].type === 'back_forward';
    var loginBoundary = null;
    try { loginBoundary = sessionStorage.getItem('__loginBoundary'); } catch (e) {}

    if (event.persisted || isBackForwardNav) {
        if (loginBoundary) {
            window.location.replace(loginBoundary);
        } else {
            window.location.reload();
        }
    } else if (loginBoundary) {
        try { sessionStorage.removeItem('__loginBoundary'); } catch (e) {}
    }
});

// An empty unload listener opts this page out of the back/forward cache entirely, backing up the guard above.
window.addEventListener('unload', function () {});

document.addEventListener("DOMContentLoaded", function() {
    const currentPath = window.location.pathname;
    const sidebar = document.getElementById('sidebar');

    // Sidebar toggle: collapses to an icon rail on desktop, slides in as an overlay drawer on mobile.
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
    // Closes the drawer when a nav link is tapped on mobile.
    if (sidebar) {
        sidebar.querySelectorAll('a[href]:not([data-bs-toggle])').forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 768) closeMobileDrawer();
            });
        });
    }

    // Active link styling is set server side. This just reads it back to set the navbar's page title.
    const activeLink = sidebar && sidebar.querySelector('.nav-item a.active:not(.dropdown-toggle)');
    if (activeLink) {
        // Reads the title attribute since the label text is hidden when the sidebar loads collapsed.
        const pageTitle = (activeLink.getAttribute('title') || activeLink.innerText).trim();
        const titleElement = document.getElementById('pageTitle');
        if (titleElement) titleElement.innerText = pageTitle;
    }

    // Fakes a crossfade transition by fading out the content before the real page navigation happens.
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