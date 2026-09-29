// Shared alert helpers so every page looks and behaves the same, online or offline.
// Falls back to a plain DOM renderer when SweetAlert2 hasn't loaded yet.

const AppAlert = {
    theme: {
        confirmButtonColor: '#251d3a',
        cancelButtonColor: '#6b7280',
        danger: '#dc3545',
        success: '#198754',
        warning: '#b45309',
        info: '#0d6efd'
    },

    // True when SweetAlert2 has actually loaded. Checked fresh every call, not cached.
    get hasSwal() {
        return typeof window !== 'undefined' && typeof window.Swal !== 'undefined' && typeof window.Swal.fire === 'function';
    },

    // Plain DOM alert renderer with no dependencies, used only when hasSwal is false.
    // Mirrors SweetAlert2's markup so alerts.css can style both the same way.
    _fallback: {
        // Text symbols instead of icon fonts, since those can be missing too.
        _symbol: { success: '✓', error: '✕', warning: '!', info: 'i', question: '?' },

        _open: null, // the container currently on screen, if any

        close() {
            if (this._open && this._open.parentNode) this._open.parentNode.removeChild(this._open);
            this._open = null;
            // Restores focus without scrolling the page. Skipped when _returnFocus is false,
            // for callers that handle focus themselves after closing.
            if (this._returnFocus !== false && this._restoreFocus && typeof this._restoreFocus.focus === 'function') {
                try { this._restoreFocus.focus({ preventScroll: true }); }
                catch (e) {
                    try { this._restoreFocus.focus(); } catch (e2) { /* element may be gone */ }
                }
            }
            this._restoreFocus = null;
            this._returnFocus = undefined;
        },

        // Returns a Promise<boolean> that resolves true only when confirm was clicked.
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
                h.textContent = o.title; // textContent only, since messages can carry server text
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
                    // Focuses the safe (cancel) button on a destructive confirm.
                    setTimeout(() => {
                        const target = (o.showCancel && o.danger) ? actions.firstChild : confirm;
                        if (target && target.focus) target.focus();
                    }, 0);
                }

                const onKey = (e) => {
                    if (e.key === 'Escape' && !o.blocking) finish(false);
                };
                document.addEventListener('keydown', onKey, true);

                // Clicking the backdrop dismisses, unless the dialog is blocking.
                if (!o.toast && !o.blocking) {
                    container.addEventListener('click', (e) => { if (e.target === container) finish(false); });
                }

                container.appendChild(popup);
                self._restoreFocus = document.activeElement;
                self._returnFocus = o.returnFocus;
                (document.body || document.documentElement).appendChild(container);
                self._open = container;

                if (o.timer) setTimeout(() => finish(false), o.timer);
            });
        }
    },

    // Shows a modal alert, using SweetAlert2 or the plain fallback.
    _modal(type, message, title, extra) {
        if (!this.hasSwal) {
            return this._fallback.show({
                type,
                title,
                text: message,
                confirmText: 'OK',
                timer: (extra && extra.timer) || undefined,
                // Keeps returnFocus behavior consistent between the fallback and SweetAlert2.
                returnFocus: extra ? extra.returnFocus : undefined
            });
        }
        return Swal.fire(Object.assign({
            icon: type,
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor,
            reverseButtons: true // keeps the primary button nearest the thumb on mobile
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

    // extra is passed straight through, including returnFocus: false for callers
    // that move focus themselves after the alert closes.
    warning(message, title = 'Warning', extra) {
        return this._modal('warning', message, title, extra);
    },

    // Resolves to true only if the user confirms.
    async confirm(message, { title = 'Are you sure?', confirmText = 'Yes, proceed!', danger = true } = {}) {
        if (!this.hasSwal) {
            // Renders the same styled confirm dialog as everywhere else, instead of a raw window.confirm().
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

    // Short corner notifications for routine confirmations. Success and info
    // auto-dismiss, error and warning stay until closed manually.
    _toastIcon: { success: 'success', error: 'error', warning: 'warning', info: 'info' },

    // Drops a repeat of the same toast message within 4 seconds so retries don't stack up.
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
                // Fallback toasts have no close button, so non-auto-closing ones still get a long timer.
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

    // For fetch() flows with no natural page navigation to show progress.
    // Always pair with stopLoading() in a finally block.
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

    // Disables a submit button and swaps its label for a spinner to block double clicks.
    // Call restoreButton() if the action fails.
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

    // Network aware helpers so offline vs server error messaging stays consistent everywhere.
    get isOnline() {
        // navigator.onLine only tells us the negative case reliably, so we only trust it when it says offline.
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    },

    // Standard message for an action that cannot run without a connection.
    offline(message = 'You are currently offline. This action will be available again once your connection returns.', title = 'No Connection') {
        return this.toast('warning', message, { title, autoClose: false });
    },

    // Call from a catch block around a fetch(). Picks offline or server error wording automatically.
    fromError(err, fallbackMessage = 'Something went wrong. Please try again.') {
        if (!this.isOnline) {
            return this.offline('You appear to be offline, so this could not be saved. Please check your connection and try again.');
        }
        const message = (err && err.userMessage) ? err.userMessage : fallbackMessage;
        return this.toast('error', message, { autoClose: false });
    },

    // One consistent notification for going offline and coming back. Opt in per page with AppAlert.watchConnection().
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

        // Also announce on load, since the offline event only fires on a transition.
        if (!this.isOnline && opts.announceOnLoad !== false) {
            this.toast('warning', offlineMessage, { title: 'Offline', autoClose: false });
        }
    },

    // Reads ?success=/?error=/?warning=/?info= from the URL, shows the matching toast once, then strips it so a refresh doesn't repeat it.
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

// Figures out which icon font the page loaded so the toggle icon actually renders.
function pwIconSet() {
    const hasBootstrapIcons = !!document.querySelector('link[href*="bootstrap-icons"]');
    return hasBootstrapIcons
        ? { shown: 'bi bi-eye', hidden: 'bi bi-eye-slash' }
        : { shown: 'fas fa-eye', hidden: 'fas fa-eye-slash' };
}

// Adds a show/hide toggle to every password input on client and office pages. Only flips the input's type attribute, never reads the value.
function initPasswordToggles(root) {
    root = root || document;
    const icons = pwIconSet();
    root.querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.dataset.pwToggleInit) return;
        input.dataset.pwToggleInit = '1';

        const btn = document.createElement('button');
        btn.type = 'button'; // never a submit trigger
        // Keeps both class names so old and new CSS selectors both match.
        btn.className = 'password-toggle pw-toggle-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('title', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        // Icon shows the current state: slashed means hidden, open means visible.
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
            // Flipping type can move the caret to the end in some browsers, so restore its position.
            const pos = input.value.length;
            input.focus();
            try { input.setSelectionRange(pos, pos); } catch (e) { /* not supported on every input type */ }
        });

        // Appends the toggle as a sibling inside the existing field wrapper instead of wrapping the input.
        const group = input.closest('.input-modern') || input.closest('.input-group');
        if (group) {
            // Uses the plain password-toggle style instead of Bootstrap's outline button.
            if (group.classList.contains('input-group')) {
                btn.classList.add('password-toggle-grouped');
            }
            group.appendChild(btn);
            return;
        }

        // No existing wrapper, so wrap just the input itself, not its label or siblings.
        const wrap = document.createElement('span');
        wrap.style.cssText = 'position:relative;display:block;';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.style.paddingRight = '3rem';
        btn.classList.add('password-toggle-floating');
        wrap.appendChild(btn);
    });
}

// Password strength meter for inputs marked with data-pw-strength. Shows feedback only, never blocks submission.
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

        // Sits under the whole field wrapper, not inside it, so Bootstrap doesn't treat it as another addon.
        const field = input.closest('.input-modern') || input.closest('.input-group') || input;
        field.parentNode.insertBefore(meter, field.nextSibling);

        const textEl = meter.querySelector('.pw-strength-text');
        const hintEl = meter.querySelector('.pw-strength-hint');
        const iconEl = meter.querySelector('.pw-strength-icon');
        const ICONS = ['', 'fa-triangle-exclamation', 'fa-shield-halved', 'fa-shield-halved', 'fa-shield-halved'];

        // Scores 0 to 4, weighted mostly by length with character variety added on top.
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

// Exposed so password inputs rendered later, like inside a SweetAlert2 modal, can be wired up too. Safe to call more than once.
window.initPasswordToggles = initPasswordToggles;
window.initPasswordStrength = initPasswordStrength;

// Convenience wrapper around AppAlert: showAlert({ type, title, message }).
function showAlert({ type = 'info', title, message, toast = false } = {}) {
    if (toast) return AppAlert.toast(type, message, { title });
    const fn = AppAlert[type] || AppAlert.info;
    return title ? fn.call(AppAlert, message, title) : fn.call(AppAlert, message);
}

// Puts AppAlert and showAlert on window explicitly since a top level const isn't a window property on its own. Other scripts like pwa-client.js depend on window.AppAlert existing.
window.AppAlert = AppAlert;
window.showAlert = showAlert;

// Announces connection changes as toasts on pages that opt in with <body data-connection-alerts>.
document.addEventListener('DOMContentLoaded', () => {
    if (document.body && document.body.hasAttribute('data-connection-alerts')) {
        AppAlert.watchConnection();
    }
});
