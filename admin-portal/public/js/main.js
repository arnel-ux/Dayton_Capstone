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
});