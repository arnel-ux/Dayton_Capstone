// Registers the service worker and provides the offline-queue helpers used by
// the client survey form: queueSurveyOffline() (called when a submission
// can't reach the server) and syncOfflineSurveysFromPage() (the fallback
// replay path for browsers without Background Sync support, e.g. iOS Safari).
(function () {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/service-worker.js')
                .catch((err) => console.error('[PWA] Service worker registration failed:', err));
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'SURVEYS_SYNCED') {
                notifySyncResult({
                    syncedCount: event.data.count || 0,
                    failedResults: event.data.failed || []
                });
            }
        });
    }

    // Shows the SweetAlert2 toasts for a sync outcome — used both for the
    // page-side fallback sync below and for results reported back by the
    // Service Worker's Background Sync via postMessage.
    function notifySyncResult(result) {
        if (!window.AppAlert) return;
        if (result.syncedCount > 0) {
            AppAlert.success(
                `${result.syncedCount} offline survey${result.syncedCount > 1 ? 's' : ''} synced and analyzed successfully.`,
                'Sync Complete'
            );
        }
        if (result.failedResults && result.failedResults.length > 0) {
            AppAlert.error(
                `${result.failedResults.length} offline survey${result.failedResults.length > 1 ? 's' : ''} could not be synced: ${result.failedResults[0].message || 'Unknown error'}`,
                'Sync Issue'
            );
        }
    }

    function generateLocalId() {
        return 'survey-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    // Saves a survey payload into the IndexedDB outbox and asks for a
    // Background Sync when it's supported. Used by the AUTHENTICATED flow
    // only (an already-logged-in session that went offline) — see
    // queueUnverifiedOfflineSurvey in offline-db.js for the unauthenticated
    // /survey-offline flow's own queuing function.
    async function queueSurveyOffline(payload, clientEmail) {
        const record = {
            localId: generateLocalId(),
            mode: 'authenticated',
            payload: buildSafeOfflineSurveyPayload(payload),
            clientEmail: clientEmail || (payload && payload.email) || null,
            savedAt: Date.now()
        };
        await addSurveyToOutbox(record);

        if (window.AppAlert) {
            AppAlert.info(
                'You are currently offline. Your survey has been saved locally and will submit automatically when your connection returns.',
                'Saved Offline'
            );
        }

        if ('serviceWorker' in navigator && 'SyncManager' in window) {
            try {
                const reg = await navigator.serviceWorker.ready;
                await reg.sync.register('sync-surveys');
            } catch (err) {
                console.warn('[PWA] Background sync registration failed, relying on the online fallback instead:', err);
            }
        }

        return record;
    }

    // Fallback replay path for browsers that don't support the Background
    // Sync API (e.g. iOS Safari) — triggered by the 'online' event below.
    // Uses the same batch /sync-surveys request as the Service Worker, so
    // AI analysis is awaited server-side either way.
    async function syncOfflineSurveysFromPage() {
        let result;
        try {
            result = await runOfflineSurveySync();
        } catch (err) {
            console.error('[PWA] Offline survey sync failed:', err);
            return;
        }
        notifySyncResult(result);
    }

    window.addEventListener('online', syncOfflineSurveysFromPage);
    window.addEventListener('load', () => {
        if (navigator.onLine) syncOfflineSurveysFromPage();
    });

    // ==========================================
    // UNAUTHENTICATED offline flow — /survey-offline surveys, verified only
    // once back online via POST /api/offline-surveys/verify-and-sync (which
    // requires that account's password). Entirely separate from the
    // authenticated sync above: different endpoint, different outbox
    // subset (getUnverifiedOutboxSurveys, mode:'unverified'), and — unlike
    // the authenticated path — never auto-submits without asking for a
    // password first.
    // ==========================================

    // Password entry ONLY ever happens through SweetAlert2's own masked
    // `input: 'password'` field — never window.prompt(), which is a plain
    // text prompt with no masking and no guarantee about how the browser
    // displays/logs it. If SweetAlert2 hasn't loaded (itself possible while
    // offline — this could be the very first page ever opened in this
    // browser), verification is simply NOT attempted this run — returns
    // `undefined` (distinct from `null`, "the user cancelled") so the
    // caller leaves every record untouched rather than guessing a password
    // through a downgraded, insecure input.
    // Returns: a password string, `null` (cancelled), or `undefined`
    // (verification UI unavailable — nothing was ever shown).
    function promptForOfflineVerificationPassword(identifier) {
        if (!window.Swal) {
            try {
                window.alert('Account verification is available once the verification interface has loaded. Please reload the page and try again.');
            } catch (e) { /* even window.alert can theoretically be blocked — nothing more to do */ }
            return Promise.resolve(undefined);
        }
        return Swal.fire({
            title: 'Account Verification Required',
            html: '<p style="margin:0 0 0.75rem;color:#475569;font-size:0.9rem;">Enter the password for <strong>' + escapeHtmlForSwal(identifier) + '</strong> to sync your offline survey.</p>',
            input: 'password',
            inputPlaceholder: 'Password',
            inputAttributes: { autocapitalize: 'off', autocomplete: 'current-password' },
            showCancelButton: true,
            confirmButtonText: 'Verify & Sync',
            confirmButtonColor: '#2554c7',
            allowOutsideClick: false,
            inputValidator: (value) => (value ? undefined : 'Please enter your password.'),
            // Belt-and-suspenders on top of SweetAlert2's own DOM teardown —
            // explicitly blank the input before the popup unmounts, so
            // nothing password-shaped lingers in the DOM even momentarily.
            didClose: (popupEl) => {
                const input = popupEl && popupEl.querySelector('input');
                if (input) input.value = '';
            }
        }).then((result) => (result.isConfirmed ? result.value : null));
    }

    function escapeHtmlForSwal(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function notifyOfflineVerifyOutcome(status, message) {
        if (!window.AppAlert) return;
        if (status === 'synced') {
            AppAlert.success(message || 'Survey successfully submitted.', 'Sync Complete');
        } else if (status === 'pending_approval') {
            AppAlert.info(message || 'Survey synchronized and is pending office approval.', 'Pending Approval');
        } else if (status === 'rejected') {
            AppAlert.warning(message || 'This submission was reviewed and was not included in the official results.', 'Submission Reviewed');
        } else if (status === 'verification_failed') {
            AppAlert.error(message || 'Unable to verify the registered account information provided.', "Can't Verify Offline Survey");
        } else if (status === 'submission_rejected') {
            AppAlert.warning(message || 'This survey could not be accepted as submitted. It remains saved on this device for review.', 'Survey Rejected');
        } else if (status === 'rate_limited') {
            AppAlert.warning(message || 'Too many verification attempts. Please wait a few minutes before trying again.', 'Please Wait');
        } else {
            AppAlert.error(message || 'Could not sync this offline survey. It remains saved on this device and will be retried.', 'Sync Issue');
        }
    }

    // Verifies+syncs every survey queued under ONE identifier, using ONE
    // password entered once for the whole group. Stops the group (without
    // touching any other group) the instant that password is proven wrong —
    // trying it again against the remaining surveys in the same group would
    // just fail identically, since they share the same account.
    async function verifyAndSyncGroup(identifier, records) {
        let password = await promptForOfflineVerificationPassword(identifier);

        if (password === undefined) {
            // Verification UI wasn't available — nothing was shown, nothing
            // attempted. Leave every record exactly as it was; this simply
            // retries on the next 'online'/load event once things have
            // loaded.
            return;
        }
        if (password === null) {
            // Explicitly cancelled — mark "a prompt was shown but not
            // completed," distinct from a record that's never been
            // attempted at all.
            for (const record of records) {
                await setOutboxSyncStatus(record.localId, 'verification_required');
            }
            return;
        }

        try {
            for (const record of records) {
                await setOutboxSyncStatus(record.localId, 'verifying');

                let res;
                try {
                    res = await fetchWithTimeout('/api/offline-surveys/verify-and-sync', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            offlineSubmissionId: record.offlineSubmissionId,
                            registeredIdentifier: identifier,
                            password,
                            createdOfflineAt: record.createdOfflineAt,
                            survey: record.payload
                        })
                    }, 15000);
                } catch (networkErr) {
                    // Network dropped mid-loop, or the request itself timed
                    // out — a TEMPORARY failure, not a wrong password and
                    // not a rejected survey. Leave this (and every
                    // remaining record in the group) retryable; stop the
                    // group here rather than guessing at the rest.
                    console.error('[Offline Verify] Request failed:', networkErr);
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    notifyOfflineVerifyOutcome('sync_failed', null);
                    return;
                }

                let data = null;
                try { data = await res.json(); } catch (parseErr) { /* fall through to the generic-failure branch below */ }

                if (res.ok && data && data.success) {
                    await removeSurveyFromOutbox(record.localId);
                    notifyOfflineVerifyOutcome(data.status, data.message);
                    continue;
                }

                if (res.status === 401) {
                    // Wrong password (or the account doesn't exist —
                    // identical, generic response either way, see the
                    // server route). This SAME password will fail for every
                    // remaining record in this group too (same account), so
                    // mark the rest failed and stop the group — but never
                    // touch any OTHER identifier's group.
                    const remainingFromHere = records.slice(records.indexOf(record));
                    for (const remaining of remainingFromHere) {
                        await setOutboxSyncStatus(remaining.localId, 'verification_failed');
                    }
                    notifyOfflineVerifyOutcome('verification_failed', data && data.message);
                    return;
                }

                if (res.status === 429) {
                    // Rate-limited — temporary, but deliberately NOT
                    // retried immediately (that would just get rate-limited
                    // again). Leave queued, tell the user to wait, stop the
                    // whole flow for now.
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    notifyOfflineVerifyOutcome('rate_limited', data && data.message);
                    return;
                }

                if (res.status >= 500) {
                    // Server/infra trouble — temporary, retryable. Stop
                    // this group (continuing would likely fail identically
                    // for the rest); the outer flow retries on the next
                    // 'online' event or app load.
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    notifyOfflineVerifyOutcome('sync_failed', data && data.message);
                    return;
                }

                // Everything else (400 validation, 409 duplicate/not-
                // eligible, or any other 4xx) is a PERMANENT problem with
                // THIS specific survey's data, not the account/password —
                // which just proved correct. Retrying the exact same data
                // later cannot succeed, so this must NOT re-enter the
                // auto-retry pool (see getUnverifiedOutboxSurveys in
                // offline-db.js, which does not include 'submission_rejected').
                // It stays in IndexedDB for the user to review, but the
                // group otherwise continues — this one survey's problem
                // doesn't block the rest of this account's queue.
                await setOutboxSyncStatus(record.localId, 'submission_rejected');
                notifyOfflineVerifyOutcome('submission_rejected', data && data.message);
            }
        } finally {
            // Deliberate: drop this function's only reference to the
            // password as soon as the group is done, rather than letting it
            // linger for the rest of the closure's lifetime. JS strings are
            // immutable (this can't force the underlying memory to be
            // overwritten), but the reference itself is cleared immediately
            // rather than left reachable — the smallest amount of "deliberate"
            // available at the language level.
            password = null;
        }
    }

    // Entry point: finds every unverified record still needing attention,
    // groups by account, and runs one verification prompt per group in
    // turn. Safe to call repeatedly (on 'online', on load, after each
    // group finishes) — a group with nothing left simply resolves
    // immediately. 'submission_rejected' records are never included here
    // (see getUnverifiedOutboxSurveys) — they don't trigger further
    // password prompts on their own.
    let offlineVerificationFlowRunning = false;
    async function runOfflineVerificationFlow() {
        if (!navigator.onLine || offlineVerificationFlowRunning) return;
        offlineVerificationFlowRunning = true;
        try {
            const unverified = await getUnverifiedOutboxSurveys();
            if (!unverified.length) return;
            const groups = groupUnverifiedByIdentifier(unverified);
            for (const identifier of Object.keys(groups)) {
                if (!navigator.onLine) break; // connection dropped mid-flow — stop, retry later
                await verifyAndSyncGroup(identifier, groups[identifier]);
            }
        } catch (err) {
            console.error('[Offline Verify] Verification flow failed:', err);
        } finally {
            offlineVerificationFlowRunning = false;
        }
    }

    window.addEventListener('online', runOfflineVerificationFlow);
    window.addEventListener('load', () => {
        if (navigator.onLine) runOfflineVerificationFlow();
    });

    window.queueSurveyOffline = queueSurveyOffline;
    window.syncOfflineSurveysFromPage = syncOfflineSurveysFromPage;
    window.runOfflineVerificationFlow = runOfflineVerificationFlow;
})();
