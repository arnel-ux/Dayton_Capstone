// Centralized SweetAlert2 helpers so every page shares the same look & feel.
//
// Existing methods (success/error/info/warning/confirm) are UNCHANGED in
// behavior/signature — many pages already call them. Everything below that
// line is additive: toasts, loading state, button-loading helpers, and a
// query-param flash-message reader so server-side redirects (?success=...
// / ?error=...) get the same consistent notification as fetch()-driven pages.
const AppAlert = {
    theme: {
        confirmButtonColor: '#251d3a',
        cancelButtonColor: '#6b7280',
        danger: '#dc3545',
        success: '#198754',
        warning: '#b45309',
        info: '#0d6efd'
    },

    success(message, title = 'Success') {
        return Swal.fire({
            icon: 'success',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor,
            timer: 2500,
            timerProgressBar: true
        });
    },

    error(message, title = 'Error') {
        return Swal.fire({
            icon: 'error',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    info(message, title = 'Info') {
        return Swal.fire({
            icon: 'info',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    warning(message, title = 'Warning') {
        return Swal.fire({
            icon: 'warning',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    // Resolves to true only if the user confirms.
    async confirm(message, { title = 'Are you sure?', confirmText = 'Yes, proceed!', danger = true } = {}) {
        const result = await Swal.fire({
            icon: 'warning',
            title,
            text: message,
            showCancelButton: true,
            confirmButtonText: confirmText,
            cancelButtonText: 'Cancel',
            confirmButtonColor: danger ? '#dc3545' : this.theme.confirmButtonColor,
            cancelButtonColor: this.theme.cancelButtonColor,
            reverseButtons: true,
            focusCancel: true
        });
        return result.isConfirmed;
    },

    // ------------------------------------------------------------------
    // TOASTS — short-lived corner notifications for routine confirmations
    // (record saved, approved, declined, logged out, etc). Desktop: top-right.
    // Mobile (<576px): top-center, full-width-ish, so it never gets clipped
    // or overlaps content. Success/info auto-dismiss; error/warning need a
    // manual close (or a longer timer) so the user has time to read them.
    // ------------------------------------------------------------------
    _toastIcon: { success: 'success', error: 'error', warning: 'warning', info: 'info' },

    toast(type, message, opts = {}) {
        const isMobile = window.innerWidth < 576;
        const autoClose = opts.autoClose !== undefined ? opts.autoClose : (type === 'success' || type === 'info');
        const Toast = Swal.mixin({
            toast: true,
            position: isMobile ? 'top' : 'top-end',
            showConfirmButton: false,
            showCloseButton: true,
            timer: autoClose ? (opts.duration || (type === 'success' ? 3500 : 5000)) : undefined,
            timerProgressBar: !!autoClose,
            didOpen: (el) => {
                el.addEventListener('mouseenter', Swal.stopTimer);
                el.addEventListener('mouseleave', Swal.resumeTimer);
            }
        });
        return Toast.fire({
            icon: this._toastIcon[type] || 'info',
            title: opts.title,
            text: message
        });
    },

    toastSuccess(message, opts) { return this.toast('success', message, opts); },
    toastError(message, opts) { return this.toast('error', message, { autoClose: false, ...opts }); },
    toastWarning(message, opts) { return this.toast('warning', message, { autoClose: false, ...opts }); },
    toastInfo(message, opts) { return this.toast('info', message, opts); },

    // ------------------------------------------------------------------
    // LOADING — for requests with no natural page-navigation loading state
    // (fetch()-based flows). Always pair with AppAlert.stopLoading() in a
    // finally block so it can never get stuck open.
    // ------------------------------------------------------------------
    loading(message = 'Processing your request...', title = 'Please wait') {
        return Swal.fire({
            title,
            text: message,
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            didOpen: () => Swal.showLoading()
        });
    },

    stopLoading() {
        if (Swal.isVisible()) Swal.close();
    },

    // ------------------------------------------------------------------
    // BUTTON LOADING STATE — disables a submit button and swaps its label
    // for a spinner, guarding against duplicate/double-click submissions.
    // Call restoreButton() if the action fails; on success the page usually
    // navigates away or re-renders, so restoring isn't always necessary.
    // ------------------------------------------------------------------
    setButtonLoading(button, loadingText = 'Processing...') {
        if (!button || button.dataset.loading === '1') return;
        button.dataset.loading = '1';
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + loadingText;
    },

    restoreButton(button) {
        if (!button || button.dataset.loading !== '1') return;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.innerHTML = button.dataset.originalHtml || button.innerHTML;
        delete button.dataset.loading;
        delete button.dataset.originalHtml;
    },

    // ------------------------------------------------------------------
    // SERVER-SIDE FLASH MESSAGES — reads ?success=/?error=/?warning=/?info=
    // from the current URL (the convention used by redirect-based POST
    // handlers throughout the app), shows the matching toast once, then
    // strips the param from the address bar so a refresh doesn't repeat it.
    // Opt-in per page (call it explicitly) so pages with their own bespoke
    // query-param handling (e.g. login.ejs's session_expired special-case)
    // are never double-handled.
    // ------------------------------------------------------------------
    autoShowFromQuery(paramMap = { success: 'success', error: 'error', warning: 'warning', info: 'info' }) {
        const params = new URLSearchParams(window.location.search);
        let shown = false;
        ['success', 'error', 'warning', 'info'].forEach((type) => {
            const key = paramMap[type];
            if (!key || shown) return;
            const value = params.get(key);
            if (value) {
                this.toast(type, value);
                params.delete(key);
                shown = true;
            }
        });
        if (shown) {
            const cleanedSearch = params.toString();
            const cleanedUrl = window.location.pathname + (cleanedSearch ? '?' + cleanedSearch : '') + window.location.hash;
            window.history.replaceState({}, '', cleanedUrl);
        }
    }
};

// Accessible show/hide toggle for every password input on client/office
// pages that load this shared file (admin pages don't load it, so this
// never touches admin forms). Auto-runs on DOMContentLoaded below; also
// exposed on window so dynamically-created password inputs (e.g. the
// SweetAlert2 "Verify Account" modal in pwa-client.js) can call it against
// just their own root element once rendered. Never reads, logs, copies, or
// persists the value anywhere — the click handler only ever flips the
// input's own `type` attribute back and forth.
function initPasswordToggles(root) {
    root = root || document;
    root.querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.dataset.pwToggleInit) return;
        input.dataset.pwToggleInit = '1';

        const btn = document.createElement('button');
        btn.type = 'button'; // never a submit trigger
        btn.className = 'pw-toggle-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.innerHTML = '<i class="bi bi-eye"></i>';
        btn.addEventListener('click', () => {
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            const icon = btn.querySelector('i');
            if (icon) icon.className = showing ? 'bi bi-eye' : 'bi bi-eye-slash';
            btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        });

        // .input-modern (this app's own custom field wrapper) and Bootstrap's
        // .input-group are both already flex + built to hold a trailing
        // addon — appended directly as a sibling of the input, never
        // wrapping it, so their existing CSS (including .input-group's
        // direct-child flex-sizing selectors) stays intact.
        const group = input.closest('.input-modern') || input.closest('.input-group');
        if (group) {
            if (group.classList.contains('input-group')) {
                btn.className += ' btn btn-outline-secondary';
            } else {
                btn.style.cssText = 'background:none;border:none;padding:0 0.75rem;color:#6b7280;display:flex;align-items:center;';
            }
            group.appendChild(btn);
            return;
        }

        // No existing icon-field wrapper — wrap just the input itself
        // (never its <label> or any sibling, and never its `name`
        // attribute — some client-facing password inputs deliberately
        // have none so they can never end up in a form's FormData).
        const wrap = document.createElement('span');
        wrap.style.cssText = 'position:relative;display:block;';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.style.paddingRight = '3rem';
        // min 44px tap target (mobile accessibility guideline) without the
        // icon itself looking oversized — padding provides the extra hit area.
        btn.style.cssText = 'position:absolute;right:0.2rem;top:50%;transform:translateY(-50%);border:none;background:none;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;line-height:1;color:#6b7280;cursor:pointer;';
        wrap.appendChild(btn);
    });
}
document.addEventListener('DOMContentLoaded', () => initPasswordToggles());

// Requested global convenience API: showAlert({ type, title, message }).
// Thin wrapper around AppAlert so both call styles are available everywhere
// AppAlert is (i.e. everywhere layout/footer.ejs or a page's own script tags
// load this file).
function showAlert({ type = 'info', title, message, toast = false } = {}) {
    if (toast) return AppAlert.toast(type, message, { title });
    const fn = AppAlert[type] || AppAlert.info;
    return title ? fn.call(AppAlert, message, title) : fn.call(AppAlert, message);
}
