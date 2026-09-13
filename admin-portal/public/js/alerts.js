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
// exposed on window so dynamically-created password inputs (e.g. any
// SweetAlert2 modal) can call it against just their own root element once
// rendered. Never reads, logs, copies, or persists the value anywhere — the
// click handler only ever flips the input's own `type` attribute back and
// forth.
// Which icon font this page actually loaded. The toggle used to hard-code
// Bootstrap Icons ("bi bi-eye"), but only client-survey.ejs loads that font —
// every other page here loads Font Awesome, so the <i> rendered as nothing and
// the toggle showed up as an empty bordered box that read as a stray divider
// line inside the password field. Detected once, per page.
function pwIconSet() {
    const hasBootstrapIcons = !!document.querySelector('link[href*="bootstrap-icons"]');
    return hasBootstrapIcons
        ? { shown: 'bi bi-eye', hidden: 'bi bi-eye-slash' }
        : { shown: 'fas fa-eye', hidden: 'fas fa-eye-slash' };
}

// Accessible show/hide toggle for every password input on client/office
// pages that load this shared file (admin pages don't load it, so this
// never touches admin forms). Auto-runs on DOMContentLoaded below; also
// exposed on window so dynamically-created password inputs (e.g. any
// SweetAlert2 modal) can call it against just their own root element once
// rendered. Never reads, logs, copies, or persists the value anywhere — the
// click handler only ever flips the input's own `type` attribute back and
// forth.
function initPasswordToggles(root) {
    root = root || document;
    const icons = pwIconSet();
    root.querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.dataset.pwToggleInit) return;
        input.dataset.pwToggleInit = '1';

        const btn = document.createElement('button');
        btn.type = 'button'; // never a submit trigger
        // Both classes: `password-toggle` is what page CSS styles, and
        // `pw-toggle-btn` is kept so any existing selector still matches.
        btn.className = 'password-toggle pw-toggle-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('title', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        // The icon shows the CURRENT STATE, not the action it would perform:
        // a slashed eye means "hidden right now", an open eye means "visible
        // right now". The field starts hidden, so it starts slashed.
        btn.innerHTML = '<i class="' + icons.hidden + '"></i>';
        btn.addEventListener('click', () => {
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            const icon = btn.querySelector('i');
            if (icon) icon.className = showing ? icons.hidden : icons.shown;
            const label = showing ? 'Show password' : 'Hide password';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
            btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
            // Flipping `type` sends the caret to the end in some browsers,
            // which is jarring mid-word — put it back where it was.
            const pos = input.value.length;
            input.focus();
            try { input.setSelectionRange(pos, pos); } catch (e) { /* not supported on every input type */ }
        });

        // .input-modern (this app's own custom field wrapper) and Bootstrap's
        // .input-group are both already flex + built to hold a trailing
        // addon — appended directly as a sibling of the input, never
        // wrapping it, so their existing CSS (including .input-group's
        // direct-child flex-sizing selectors) stays intact.
        const group = input.closest('.input-modern') || input.closest('.input-group');
        if (group) {
            // Deliberately NOT Bootstrap's .btn-outline-secondary here: its
            // own left/right borders are what made the field look chopped in
            // two. `.password-toggle` in style.css renders it as a plain icon
            // that blends into the field instead.
            if (group.classList.contains('input-group')) {
                btn.classList.add('password-toggle-grouped');
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
        btn.classList.add('password-toggle-floating');
        wrap.appendChild(btn);
    });
}

// Opt-in password strength meter. Only attaches to inputs that explicitly ask
// for it with `data-pw-strength`, so it never shows up on a plain sign-in
// field that didn't request it. Feedback only — it never blocks submission,
// because an existing account may legitimately have a weak password and
// refusing to submit would lock that user out of their own account.
function initPasswordStrength(root) {
    root = root || document;
    root.querySelectorAll('input[data-pw-strength]').forEach((input) => {
        if (input.dataset.pwStrengthInit) return;
        input.dataset.pwStrengthInit = '1';

        const meter = document.createElement('div');
        meter.className = 'pw-strength is-empty';
        meter.setAttribute('data-level', '0');
        meter.innerHTML =
            '<div class="pw-strength-track" aria-hidden="true"><div class="pw-strength-fill"></div></div>' +
            '<p class="pw-strength-label" aria-live="polite">' +
            '<span class="pw-strength-badge"><i class="fas pw-strength-icon"></i><span class="pw-strength-text"></span></span>' +
            '<span class="pw-strength-hint"></span></p>';

        // Sits directly under the whole field (the wrapper, when there is
        // one), never inside it — dropping it inside an .input-group would
        // make Bootstrap treat it as another addon and lay it out on the
        // same row as the input.
        const field = input.closest('.input-modern') || input.closest('.input-group') || input;
        field.parentNode.insertBefore(meter, field.nextSibling);

        const textEl = meter.querySelector('.pw-strength-text');
        const hintEl = meter.querySelector('.pw-strength-hint');
        const iconEl = meter.querySelector('.pw-strength-icon');
        const ICONS = ['', 'fa-triangle-exclamation', 'fa-shield-halved', 'fa-shield-halved', 'fa-shield-halved'];

        // Score 0-4. Length carries the most weight (it's what actually costs
        // an attacker time), with character variety on top.
        function score(v) {
            if (!v) return { level: 0, text: '', hint: '' };
            const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
                .reduce((n, re) => n + (re.test(v) ? 1 : 0), 0);
            let n = 0;
            if (v.length >= 8) n++;
            if (v.length >= 12) n++;
            if (variety >= 2) n++;
            if (variety >= 3 && v.length >= 8) n++;
            if (v.length < 8) n = Math.min(n, 1);   // short is weak regardless of variety
            if (variety === 1) n = Math.min(n, 2);  // one character class only
            const level = Math.max(1, Math.min(4, n));

            let hint = '';
            if (level < 4) {
                if (v.length < 8) hint = 'Use at least 8 characters';
                else if (v.length < 12) hint = 'Longer is stronger';
                else if (variety < 3) hint = 'Mix letters, numbers & symbols';
            }
            return { level: level, text: ['', 'Weak', 'Fair', 'Good', 'Strong'][level], hint: hint };
        }

        function render() {
            const r = score(input.value);
            meter.classList.toggle('is-empty', !input.value);
            meter.setAttribute('data-level', String(r.level));
            textEl.textContent = r.text;
            hintEl.textContent = r.hint;
            iconEl.className = 'fas pw-strength-icon ' + (ICONS[r.level] || '');
        }

        input.addEventListener('input', render);
        render(); // autofilled/restored values never fire `input`
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initPasswordToggles();
    initPasswordStrength();
});

// Exposed so dynamically-rendered password inputs (e.g. inside a SweetAlert2
// modal, which doesn't exist yet at DOMContentLoaded) can be wired up against
// just their own root once they're in the DOM. Both are idempotent — the
// data-* guards mean re-running over an already-initialised field is a no-op.
window.initPasswordToggles = initPasswordToggles;
window.initPasswordStrength = initPasswordStrength;

// Requested global convenience API: showAlert({ type, title, message }).
// Thin wrapper around AppAlert so both call styles are available everywhere
// AppAlert is (i.e. everywhere layout/footer.ejs or a page's own script tags
// load this file).
function showAlert({ type = 'info', title, message, toast = false } = {}) {
    if (toast) return AppAlert.toast(type, message, { title });
    const fn = AppAlert[type] || AppAlert.info;
    return title ? fn.call(AppAlert, message, title) : fn.call(AppAlert, message);
}
