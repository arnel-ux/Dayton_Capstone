// Centralized alert helpers so every page — online or offline, phone or
// desktop, light or dark — shares one look and one behavior.
//
// The public API (success/error/info/warning/confirm/toast*/loading/
// setButtonLoading/restoreButton/autoShowFromQuery) is UNCHANGED in
// signature and return type; many pages already call it.
//
// What changed underneath:
//
// 1. NOTHING IS SILENT OFFLINE ANY MORE. SweetAlert2 is loaded from a CDN
//    and only precached best-effort by the service worker, so a device
//    that first opens the app offline (or whose CDN cache entry failed)
//    has no `Swal` at all. Every AppAlert.* call then threw, and the user
//    was told nothing — including about a survey that had just been
//    queued or had failed to sync. Every method now falls back to a
//    dependency-free renderer (`_fallback` below, styled by alerts.css to
//    match the SweetAlert2 version) whenever Swal is missing.
//
// 2. All appearance lives in /css/alerts.css, not in per-page <style>
//    blocks, so the same alert looks the same on every page and device.
//
// 3. Connection changes (going offline, coming back online) report
//    through the same toasts as everything else instead of each feature
//    inventing its own banner.

const AppAlert = {
    theme: {
        confirmButtonColor: '#251d3a',
        cancelButtonColor: '#6b7280',
        danger: '#dc3545',
        success: '#198754',
        warning: '#b45309',
        info: '#0d6efd'
    },

    // ------------------------------------------------------------------
    // ENGINE SELECTION
    // ------------------------------------------------------------------
    // True only when SweetAlert2 actually finished loading. Checked at
    // CALL time, never cached: on a slow connection the library can still
    // arrive after the first alert has already been shown by the fallback.
    get hasSwal() {
        return typeof window !== 'undefined' && typeof window.Swal !== 'undefined' && typeof window.Swal.fire === 'function';
    },

    // ------------------------------------------------------------------
    // FALLBACK RENDERER — plain DOM, zero dependencies. Used only when
    // hasSwal is false. Deliberately mirrors the SweetAlert2 markup's
    // shape so /css/alerts.css can style the two identically; a user who
    // is offline should not be able to tell which one they are looking at.
    // ------------------------------------------------------------------
    _fallback: {
        // Text-only symbols, because the icon fonts (Font Awesome /
        // Bootstrap Icons) are themselves CDN-loaded and may be just as
        // missing as SweetAlert2 is in this code path.
        _symbol: { success: '✓', error: '✕', warning: '!', info: 'i', question: '?' },

        _open: null, // the single container currently on screen, if any

        close() {
            if (this._open && this._open.parentNode) this._open.parentNode.removeChild(this._open);
            this._open = null;
            if (this._restoreFocus && typeof this._restoreFocus.focus === 'function') {
                try { this._restoreFocus.focus(); } catch (e) { /* element may be gone */ }
            }
            this._restoreFocus = null;
        },

        // Returns a Promise<boolean>: true only when the confirm button was
        // used, matching AppAlert.confirm's contract.
        show(opts) {
            const o = opts || {};
            const self = this;
            this.close(); // never stack two fallback dialogs

            const container = document.createElement('div');
            container.className = 'appalert-fallback-container' + (o.toast ? ' is-toast' : '');

            const popup = document.createElement('div');
            popup.className = 'appalert-fallback-popup';
            popup.setAttribute('data-type', o.type || 'info');
            popup.setAttribute('role', o.type === 'error' ? 'alertdialog' : 'dialog');
            popup.setAttribute('aria-modal', o.toast ? 'false' : 'true');
            popup.setAttribute('aria-live', o.type === 'error' || o.type === 'warning' ? 'assertive' : 'polite');

            const icon = document.createElement('span');
            icon.className = 'appalert-fallback-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = this._symbol[o.type] || this._symbol.info;
            popup.appendChild(icon);

            if (o.title) {
                const h = document.createElement('h2');
                h.className = 'appalert-fallback-title';
                h.textContent = o.title; // textContent, never innerHTML — messages can carry server text
                popup.appendChild(h);
            }
            if (o.text) {
                const p = document.createElement('p');
                p.className = 'appalert-fallback-text';
                p.textContent = o.text;
                popup.appendChild(p);
            }

            return new Promise((resolve) => {
                let settled = false;
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    document.removeEventListener('keydown', onKey, true);
                    self.close();
                    resolve(value);
                };

                if (o.showCancel || o.showConfirm !== false) {
                    const actions = document.createElement('div');
                    actions.className = 'appalert-fallback-actions';

                    if (o.showCancel) {
                        const cancel = document.createElement('button');
                        cancel.type = 'button';
                        cancel.className = 'appalert-fallback-btn is-cancel';
                        cancel.textContent = o.cancelText || 'Cancel';
                        cancel.addEventListener('click', () => finish(false));
                        actions.appendChild(cancel);
                    }

                    const confirm = document.createElement('button');
                    confirm.type = 'button';
                    confirm.className = 'appalert-fallback-btn' + (o.danger ? ' is-danger' : '');
                    confirm.textContent = o.confirmText || 'OK';
                    confirm.addEventListener('click', () => finish(true));
                    actions.appendChild(confirm);

                    popup.appendChild(actions);
                    // Focus the SAFE action on a destructive confirm, so a
                    // stray Enter keypress can never destroy anything.
                    setTimeout(() => {
                        const target = (o.showCancel && o.danger) ? actions.firstChild : confirm;
                        if (target && target.focus) target.focus();
                    }, 0);
                }

                const onKey = (e) => {
                    if (e.key === 'Escape' && !o.blocking) finish(false);
                };
                document.addEventListener('keydown', onKey, true);

                // Clicking the dimmed backdrop dismisses, except while a
                // blocking/loading dialog is up.
                if (!o.toast && !o.blocking) {
                    container.addEventListener('click', (e) => { if (e.target === container) finish(false); });
                }

                container.appendChild(popup);
                self._restoreFocus = document.activeElement;
                (document.body || document.documentElement).appendChild(container);
                self._open = container;

                if (o.timer) setTimeout(() => finish(false), o.timer);
            });
        }
    },

    // ------------------------------------------------------------------
    // MODAL ALERTS — unchanged signatures.
    // ------------------------------------------------------------------
    _modal(type, message, title, extra) {
        if (!this.hasSwal) {
            return this._fallback.show({
                type,
                title,
                text: message,
                confirmText: 'OK',
                timer: (extra && extra.timer) || undefined
            });
        }
        return Swal.fire(Object.assign({
            icon: type,
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor,
            // Buttons stack on narrow screens (see alerts.css); reversed
            // order keeps the primary action nearest the thumb.
            reverseButtons: true
        }, extra || {}));
    },

    success(message, title = 'Success') {
        return this._modal('success', message, title, { timer: 2500, timerProgressBar: true });
    },

    error(message, title = 'Error') {
        return this._modal('error', message, title);
    },

    info(message, title = 'Info') {
        return this._modal('info', message, title);
    },

    warning(message, title = 'Warning') {
        return this._modal('warning', message, title);
    },

    // Resolves to true only if the user confirms.
    async confirm(message, { title = 'Are you sure?', confirmText = 'Yes, proceed!', danger = true } = {}) {
        if (!this.hasSwal) {
            // Previously the only no-Swal path in the app was a raw
            // window.confirm(), which is unstyled, unbrandable, and on
            // some mobile browsers can be suppressed entirely — meaning a
            // destructive action either looked broken or silently did
            // nothing. This renders the same dialog as everywhere else.
            return this._fallback.show({
                type: 'warning',
                title,
                text: message,
                showCancel: true,
                confirmText,
                cancelText: 'Cancel',
                danger
            });
        }
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
    // (record saved, approved, declined, logged out, etc). Desktop:
    // top-right. Mobile (<576px): top-center full-width strip, clear of
    // the notch (see alerts.css). Success/info auto-dismiss; error/warning
    // need a manual close so the user has time to read them.
    // ------------------------------------------------------------------
    _toastIcon: { success: 'success', error: 'error', warning: 'warning', info: 'info' },

    // The offline sync loop retries on an interval, so without this the
    // same "couldn't sync" toast could stack several deep. A repeat of the
    // identical message within 4s is dropped.
    _lastToast: { key: '', at: 0 },

    toast(type, message, opts = {}) {
        const key = type + '|' + (opts.title || '') + '|' + message;
        const now = Date.now();
        if (key === this._lastToast.key && now - this._lastToast.at < 4000) return Promise.resolve();
        this._lastToast = { key, at: now };

        const isMobile = window.innerWidth < 576;
        const autoClose = opts.autoClose !== undefined ? opts.autoClose : (type === 'success' || type === 'info');
        const duration = opts.duration || (type === 'success' ? 3500 : 5000);

        if (!this.hasSwal) {
            return this._fallback.show({
                type,
                title: opts.title,
                text: message,
                toast: true,
                showConfirm: false,
                // A non-auto-closing fallback toast still has to be
                // dismissible, and it has no close button of its own, so
                // it gets a generous timer rather than sticking forever.
                timer: autoClose ? duration : 10000
            });
        }

        const Toast = Swal.mixin({
            toast: true,
            position: isMobile ? 'top' : 'top-end',
            showConfirmButton: false,
            showCloseButton: true,
            timer: autoClose ? duration : undefined,
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
        if (!this.hasSwal) {
            return this._fallback.show({
                type: 'info',
                title,
                text: message,
                showConfirm: false,
                blocking: true // no Escape, no backdrop click
            });
        }
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
        if (this.hasSwal && Swal.isVisible()) Swal.close();
        this._fallback.close();
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
    // NETWORK-AWARE HELPERS
    // Every feature that talks to the server needs to say the same thing
    // when the request fails, and the right thing depends on whether the
    // device is offline. Routing those through here means the offline
    // survey, the login page and the admin tables all word it identically.
    // ------------------------------------------------------------------
    get isOnline() {
        // navigator.onLine only proves a link exists, not that the server
        // is reachable — so it is trusted for the NEGATIVE case only
        // (false really does mean offline), which is how it is used here.
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    },

    // Standard message for an action that cannot run without a connection.
    offline(message = 'You are currently offline. This action will be available again once your connection returns.', title = 'No Connection') {
        return this.toast('warning', message, { title, autoClose: false });
    },

    // Call from a catch block around any fetch(). Picks the offline wording
    // or the server-error wording automatically, so no caller has to
    // re-implement that check.
    //
    // Deliberately does NOT surface err.message by default: a fetch() that
    // fails because the network died rejects with a TypeError whose message
    // is "Failed to fetch" / "NetworkError when attempting to fetch
    // resource" — browser-internal wording that means nothing to a survey
    // respondent. The caller's own fallbackMessage describes what the user
    // was actually trying to do, so that wins. An error carrying an
    // explicit `userMessage` (set by us, already user-facing) is preferred
    // over both.
    fromError(err, fallbackMessage = 'Something went wrong. Please try again.') {
        if (!this.isOnline) {
            return this.offline('You appear to be offline, so this could not be saved. Please check your connection and try again.');
        }
        const message = (err && err.userMessage) ? err.userMessage : fallbackMessage;
        return this.toast('error', message, { autoClose: false });
    },

    // ------------------------------------------------------------------
    // CONNECTION STATUS — one consistent notification for going offline
    // and coming back, instead of each page inventing its own banner.
    // Opt-in per page via AppAlert.watchConnection(); auto-enabled below
    // for pages that opt in with <body data-connection-alerts>.
    // ------------------------------------------------------------------
    _connectionWatching: false,

    watchConnection(opts = {}) {
        if (this._connectionWatching) return;
        this._connectionWatching = true;

        const offlineMessage = opts.offlineMessage || 'You are offline. Your work is saved on this device and will sync automatically when the connection returns.';
        const onlineMessage = opts.onlineMessage || 'Your connection is back. Syncing your saved work now.';

        window.addEventListener('offline', () => {
            this.toast('warning', offlineMessage, { title: 'Offline', autoClose: false });
        });

        window.addEventListener('online', () => {
            this.toast('success', onlineMessage, { title: 'Back Online' });
        });

        // Say so on load too — a user who opens the app already offline
        // otherwise gets no indication at all, because 'offline' only
        // fires on a TRANSITION.
        if (!this.isOnline && opts.announceOnLoad !== false) {
            this.toast('warning', offlineMessage, { title: 'Offline', autoClose: false });
        }
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

// ---------------------------------------------------------------------
// EXPLICIT GLOBAL EXPORTS — load-bearing, do not remove.
//
// `const AppAlert = {...}` at the top level of a classic <script> creates
// a binding in the global LEXICAL scope, which is NOT the same as a
// property on `window`. So `AppAlert` resolved fine, but `window.AppAlert`
// was permanently `undefined` — and pwa-client.js gates every one of its
// offline-sync notifications on exactly that check:
//
//     if (!window.AppAlert) return;
//
// which meant the entire offline path — "saved locally, will submit when
// you're back online", "N surveys synced", "couldn't be verified",
// "rejected", "please wait" — silently showed the user NOTHING. The alerts
// were written and wired up correctly; they simply never ran.
//
// Assigning here makes those guards true, and keeps the `window.` form
// working from any other script regardless of load order.
// ---------------------------------------------------------------------
window.AppAlert = AppAlert;
window.showAlert = showAlert;

// Announce connection changes through the standard toasts on any page that
// opts in with <body data-connection-alerts>. Opt-in rather than automatic
// so pages that deliberately render their own richer offline UI (login's
// offline overlay, the offline survey's own status strip) don't end up
// showing two notices for the same event.
document.addEventListener('DOMContentLoaded', () => {
    if (document.body && document.body.hasAttribute('data-connection-alerts')) {
        AppAlert.watchConnection();
    }
});
