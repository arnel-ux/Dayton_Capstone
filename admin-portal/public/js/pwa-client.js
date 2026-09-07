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
                    supersededCount: event.data.supersededCount || 0,
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
        // Accurate, distinct message — these were NOT submitted as a second
        // response. An online submission for the exact same office/service
        // already existed, so the offline copy was correctly discarded
        // rather than double-counted (see the server's Online-vs-Offline
        // precedence rule). Never phrased as "submitted successfully."
        if (result.supersededCount > 0) {
            AppAlert.info(
                `${result.supersededCount} offline response${result.supersededCount > 1 ? 's were' : ' was'} not needed — your online submission for that service was already received.`,
                'Already Submitted Online'
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
    //
    // `preferredLocalId` (optional): lets a caller that already generated a
    // stable attempt ID for this survey (see the active-draft autosave in
    // client-survey.ejs) carry that SAME id into the outbox record instead
    // of a brand new one — "one survey attempt = one ID" end to end, from
    // the first autosave through to the queued submission.
    async function queueSurveyOffline(payload, clientEmail, preferredLocalId) {
        const record = {
            localId: preferredLocalId || generateLocalId(),
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

    function normalizeIdentifier(identifier) {
        return (identifier || '').trim().toLowerCase();
    }

    // ------------------------------------------------------------------
    // RAM-only credential store. Holds an offline survey's account
    // password ONLY in page memory (this closure's Map) — never written to
    // IndexedDB/localStorage/sessionStorage/cookies/any cache, never
    // logged, never included in a survey payload. Cleared on successful
    // sync, on a confirmed-wrong-password (401), after its TTL expires, or
    // whenever this page/tab is closed or reloaded (memory simply goes
    // away). Only these four functions touch the Map; only `remember` and
    // `forget` are exposed on window (client-survey.ejs needs both).
    // ------------------------------------------------------------------
    const DEFAULT_OFFLINE_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000; // 2h default (3h absolute max never enforced beyond this — TTL is fixed at 2h)
    const temporaryOfflineCredentials = new Map(); // normalized identifier -> { password, expiresAt }

    function rememberOfflineCredential(identifier, password) {
        const key = normalizeIdentifier(identifier);
        if (!key || !password) return;
        temporaryOfflineCredentials.set(key, { password, expiresAt: Date.now() + DEFAULT_OFFLINE_CREDENTIAL_TTL_MS });
        // A freshly remembered credential means the user just supplied a
        // (presumably corrected) password for this identifier — clear any
        // stale retry/block state so verification is attempted fresh.
        clearRetryState(key);
    }

    function getOfflineCredential(identifier) {
        const key = normalizeIdentifier(identifier);
        const entry = temporaryOfflineCredentials.get(key);
        if (!entry) return null;
        if (Date.now() >= entry.expiresAt) {
            temporaryOfflineCredentials.delete(key);
            return null;
        }
        return entry.password;
    }

    function forgetOfflineCredential(identifier) {
        temporaryOfflineCredentials.delete(normalizeIdentifier(identifier));
    }

    function clearExpiredOfflineCredentials() {
        const now = Date.now();
        for (const [key, entry] of temporaryOfflineCredentials) {
            if (now >= entry.expiresAt) temporaryOfflineCredentials.delete(key);
        }
    }

    setInterval(clearExpiredOfflineCredentials, 5 * 60 * 1000);

    // ------------------------------------------------------------------
    // Retry/backoff state — separate from the credential store. Distinguishes
    // TEMPORARY failures (network drop, 429, 5xx — timed backoff, retried
    // automatically) from a CONFIRMED-WRONG-PASSWORD 401 (automaticBlocked —
    // never retried automatically again; only clears if a fresh credential
    // for this identifier is remembered again, e.g. a brand-new offline
    // submission for the same account).
    // ------------------------------------------------------------------
    const identifierRetryState = new Map(); // normalized identifier -> { failureCount, nextRetryAt, automaticBlocked }
    const RETRY_BACKOFF_MS = [5000, 15000, 30000];

    function recordTemporaryFailure(identifier) {
        const key = normalizeIdentifier(identifier);
        const entry = identifierRetryState.get(key) || { failureCount: 0, automaticBlocked: false };
        entry.failureCount++;
        entry.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[Math.min(entry.failureCount, RETRY_BACKOFF_MS.length) - 1];
        entry.automaticBlocked = false;
        identifierRetryState.set(key, entry);
    }

    function markVerificationBlocked(identifier) {
        identifierRetryState.set(normalizeIdentifier(identifier), { failureCount: 0, nextRetryAt: 0, automaticBlocked: true });
    }

    function clearRetryState(identifier) {
        identifierRetryState.delete(normalizeIdentifier(identifier));
    }

    function canAttemptNow(identifier) {
        const entry = identifierRetryState.get(normalizeIdentifier(identifier));
        if (!entry) return true;
        if (entry.automaticBlocked) return false;
        return Date.now() >= (entry.nextRetryAt || 0);
    }

    // A genuine 'online' transition resets TEMPORARY backoff timers (no
    // reason to make a fresh reconnect wait out a stale delay) but
    // deliberately leaves automaticBlocked (401) entries untouched — those
    // only clear via rememberOfflineCredential (i.e. a deliberate manual
    // retry with a corrected password).
    function resetTemporaryBackoffs() {
        for (const [key, entry] of identifierRetryState) {
            if (!entry.automaticBlocked) identifierRetryState.delete(key);
        }
    }

    // ------------------------------------------------------------------
    // Masked identifier for any user-visible UI (verification-failed
    // banner). The real identifier is still used internally for matching
    // records/calling the server — only the rendered text is masked, and
    // it is built with DOM APIs only (never innerHTML) since the
    // identifier is user-controlled data.
    // ------------------------------------------------------------------
    function maskIdentifierForDisplay(identifier) {
        const id = identifier || '';
        const at = id.indexOf('@');
        if (at <= 0) return '***';
        const user = id.slice(0, at);
        const domain = id.slice(at);
        return user.slice(0, Math.min(2, user.length)) + '***' + domain;
    }

    // Renders/refreshes the "Verification failed" banner listing every
    // identifier confirmed to have failed verification (wrong password on
    // reconnect). Informational only — no retry button, no password prompt
    // of any kind. The client is notified of the actual outcome through the
    // existing Notification Bell (server-created on the 401 response); this
    // banner just surfaces the same fact on the page itself. No-op if the
    // banner container isn't present on this page.
    async function updateVerificationFailedBanner() {
        const container = document.getElementById('offlineVerifyFailedBanner');
        if (!container) return;

        let unverified;
        try {
            unverified = await getUnverifiedOutboxSurveys();
        } catch (err) {
            console.error('[Offline Sync] Failed to read outbox for banner update:', err);
            return;
        }

        const failedIdentifiers = new Set();
        for (const record of unverified) {
            if (record.syncStatus === 'verification_failed' && record.registeredIdentifier) {
                failedIdentifiers.add(normalizeIdentifier(record.registeredIdentifier));
            }
        }

        if (!failedIdentifiers.size) {
            container.replaceChildren();
            container.hidden = true;
            return;
        }

        const rows = [];
        failedIdentifiers.forEach((identifier) => {
            const row = document.createElement('div');
            row.className = 'offline-verify-failed-row';
            row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;padding:0.15rem 0;';

            const label = document.createElement('span');
            label.textContent = 'Your offline survey for ' + maskIdentifierForDisplay(identifier) + ' was not synced because the password entered was incorrect. See your notifications for details.';
            row.appendChild(label);

            rows.push(row);
        });

        container.replaceChildren(...rows);
        container.hidden = false;
    }

    // Renders/refreshes the terminal "eligibility conflict" notification —
    // one row per still-queued eligibility_conflict record (not grouped by
    // identifier like the verification-failed banner, since each record can
    // name a different office/service and nextEligibleAt). This is NOT an
    // authentication problem (the account and password already verified
    // successfully) — never shows a password-retry action, never re-enters
    // getUnverifiedOutboxSurveys/the automatic retry pool. No-op if the
    // banner container isn't present on this page.
    async function updateEligibilityConflictBanner() {
        const container = document.getElementById('offlineEligibilityConflictBanner');
        if (!container) return;

        let conflicts;
        try {
            conflicts = await getEligibilityConflictSurveys();
        } catch (err) {
            console.error('[Offline Sync] Failed to read outbox for conflict banner update:', err);
            return;
        }

        if (!conflicts.length) {
            container.replaceChildren();
            container.hidden = true;
            return;
        }

        const rows = conflicts.map((record) => {
            const row = document.createElement('div');
            row.className = 'offline-eligibility-conflict-row';
            row.style.cssText = 'display:flex;flex-direction:column;gap:0.35rem;padding:0.6rem 0;border-bottom:1px solid #f0d9b5;';

            const title = document.createElement('div');
            title.style.fontWeight = '600';
            title.textContent = 'Offline Response Could Not Be Submitted';
            row.appendChild(title);

            const identLine = document.createElement('span');
            identLine.style.fontSize = '0.8rem';
            identLine.style.color = '#6b5a1e';
            identLine.textContent = 'Account: ' + maskIdentifierForDisplay(record.registeredIdentifier || '');
            row.appendChild(identLine);

            const message = document.createElement('div');
            message.textContent = record.conflictMessage || 'This service is currently unavailable for another response.';
            row.appendChild(message);

            const notSubmitted = document.createElement('div');
            notSubmitted.style.cssText = 'font-size:0.78rem;font-style:italic;';
            notSubmitted.textContent = 'Not submitted — this response was not added to the official survey records.';
            row.appendChild(notSubmitted);

            // Absolute server timestamp, never the offline device's own
            // clock — see nextEligibleAt in checkResubmissionEligibility
            // (server.js). Formatted in the viewer's local timezone, same
            // as every other date shown on this page.
            if (record.nextEligibleAt) {
                const nextDate = new Date(record.nextEligibleAt);
                if (!isNaN(nextDate.getTime())) {
                    const nextLine = document.createElement('div');
                    nextLine.style.fontSize = '0.8rem';
                    nextLine.textContent = 'You may submit another response for this service after: ' +
                        nextDate.toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });
                    row.appendChild(nextLine);
                }
            }

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.25rem;flex-wrap:wrap;';

            const discardBtn = document.createElement('button');
            discardBtn.type = 'button';
            discardBtn.className = 'btn btn-sm btn-outline-danger';
            discardBtn.textContent = 'Discard Local Response';
            discardBtn.addEventListener('click', async () => {
                if (discardBtn.disabled) return;
                let confirmed;
                if (window.Swal) {
                    const result = await Swal.fire({
                        title: 'Discard this response?',
                        text: 'This offline response will be permanently removed from this device. This cannot be undone.',
                        icon: 'warning',
                        showCancelButton: true,
                        confirmButtonText: 'Discard',
                        confirmButtonColor: '#dc3545'
                    });
                    confirmed = result.isConfirmed;
                } else {
                    confirmed = window.confirm('Discard this offline response? This cannot be undone.');
                }
                if (!confirmed) return;

                discardBtn.disabled = true;
                try {
                    // Removes ONLY this one record — every other queued
                    // survey, offlineAccountContext, other accounts' data,
                    // and the Service Worker cache are all untouched.
                    await removeSurveyFromOutbox(record.localId);
                    await updateEligibilityConflictBanner();
                } catch (err) {
                    console.error('[Offline Sync] Failed to discard eligibility_conflict record:', err);
                    discardBtn.disabled = false;
                }
            });
            actions.appendChild(discardBtn);

            const newSurveyBtn = document.createElement('button');
            newSurveyBtn.type = 'button';
            newSurveyBtn.className = 'btn btn-sm btn-outline-primary';
            newSurveyBtn.textContent = 'Take New Survey';
            newSurveyBtn.title = 'Starts a fresh survey — this terminal response stays exactly as-is until you discard it';
            newSurveyBtn.addEventListener('click', () => {
                // Resets the CURRENT form only (see startNewSurvey in
                // client-survey.ejs) — never touches this or any other
                // queued record, never auto-picks a different service for
                // the old response.
                if (typeof window.startNewSurvey === 'function') window.startNewSurvey();
            });
            actions.appendChild(newSurveyBtn);

            row.appendChild(actions);
            return row;
        });

        container.replaceChildren(...rows);
        container.hidden = false;
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
        } else if (status === 'eligibility_conflict') {
            AppAlert.warning(message || 'This service is currently unavailable for another response. Your offline response has not been submitted. Please choose an eligible service when available.', 'Currently Unavailable');
        } else if (status === 'rate_limited') {
            AppAlert.warning(message || 'Too many verification attempts. Please wait a few minutes before trying again.', 'Please Wait');
        } else {
            AppAlert.error(message || 'Could not sync this offline survey. It remains saved on this device and will be retried.', 'Sync Issue');
        }
    }

    // Verifies+syncs every survey queued under ONE identifier, using the
    // password captured (in RAM only) at the moment the survey was
    // originally submitted offline. Never prompts for a password here —
    // automatic reconnect verification is silent by design: if the RAM
    // credential is gone (its TTL expired, or the page/tab was closed and
    // reopened, wiping page memory), this group is simply left untouched
    // for now rather than resurrecting any password popup. Stops the group
    // (without touching any other group) the instant the password is
    // proven wrong — trying it again against the remaining surveys in the
    // same group would just fail identically, since they share the same
    // account.
    async function verifyAndSyncGroup(identifier, records) {
        const password = getOfflineCredential(identifier);
        console.log('[Offline Sync] Temporary credential available:', password ? 'yes' : 'no');

        if (!password) {
            // No password popup, no automatic guess — leave every record
            // exactly as it was (still 'pending_sync'/whatever it already
            // was). It will be picked up automatically the moment this
            // identifier's credential is remembered again (i.e. the user
            // submits a fresh offline survey for the same account within
            // this page session).
            return;
        }

        console.log('[Offline Sync] Starting verification');

        try {
            for (const record of records) {
                await setOutboxSyncStatus(record.localId, 'verifying');

                let res;
                try {
                    console.log('[Offline Sync] Calling verify-and-sync endpoint');
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
                    // group here rather than guessing at the rest. The
                    // RAM credential is deliberately NOT cleared here — a
                    // temporary network problem says nothing about whether
                    // the password itself was correct.
                    console.error('[Offline Sync] Network request failed:', networkErr);
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
                    notifyOfflineVerifyOutcome('sync_failed', null);
                    return;
                }

                let data = null;
                try { data = await res.json(); } catch (parseErr) { /* fall through to the generic-failure branch below */ }

                if (res.ok && data && data.success) {
                    await removeSurveyFromOutbox(record.localId);
                    console.log('[Offline Sync] Local record removed');
                    // Cooldown/profile eligibility may have just changed (the
                    // service just synced is now on cooldown) — the sync
                    // response includes a freshly-rebuilt, non-secret
                    // snapshot for exactly this purpose (see
                    // buildClientOfflineContext in server.js). Best-effort:
                    // never blocks marking the survey synced above.
                    if (data.offlineContext && typeof saveOfflineAccountContext === 'function') {
                        saveOfflineAccountContext(data.offlineContext).catch((err) => console.error('[Offline Context] Failed to cache refreshed context:', err));
                    }
                    notifyOfflineVerifyOutcome(data.status, data.message);
                    continue;
                }

                if (res.status === 409 && data && data.status === 'eligibility_conflict') {
                    // The account and survey data are both valid — only the
                    // office/service is currently on cooldown (recalculated
                    // server-side just now). This is NOT an auth problem:
                    // never touch the RAM credential or the 401 automatic-
                    // block state, and never re-enter the automatic retry
                    // pool (see getUnverifiedOutboxSurveys in offline-db.js,
                    // which excludes 'eligibility_conflict' the same way it
                    // already excludes 'submission_rejected') — retrying the
                    // exact same office/service later cannot succeed on its
                    // own; it stays queued for the user to review or remove.
                    console.log('[Offline Sync] Endpoint returned 409 eligibility_conflict');
                    await setOutboxSyncStatus(record.localId, 'eligibility_conflict', {
                        conflictMessage: data.message || null,
                        nextEligibleAt: data.nextEligibleAt || null
                    });
                    notifyOfflineVerifyOutcome('eligibility_conflict', data.message);
                    await updateEligibilityConflictBanner();
                    continue;
                }

                if (res.status === 401) {
                    // Wrong password (or the account doesn't exist —
                    // identical, generic response either way, see the
                    // server route). This SAME password will fail for every
                    // remaining record in this group too (same account), so
                    // mark the rest failed and stop the group — but never
                    // touch any OTHER identifier's group. The password is
                    // now confirmed wrong (or unusable): drop it from RAM
                    // and block further AUTOMATIC attempts for this
                    // identifier until a deliberate manual retry supplies a
                    // corrected password.
                    console.log('[Offline Sync] Endpoint returned 401');
                    const remainingFromHere = records.slice(records.indexOf(record));
                    for (const remaining of remainingFromHere) {
                        await setOutboxSyncStatus(remaining.localId, 'verification_failed');
                    }
                    forgetOfflineCredential(identifier);
                    markVerificationBlocked(identifier);
                    notifyOfflineVerifyOutcome('verification_failed', data && data.message);
                    await updateVerificationFailedBanner();
                    return;
                }

                if (res.status === 429) {
                    // Rate-limited — temporary, but deliberately NOT
                    // retried immediately (that would just get rate-limited
                    // again). Leave queued, tell the user to wait, stop the
                    // whole flow for now. Credential kept — this says
                    // nothing about whether the password was correct.
                    console.log('[Offline Sync] Endpoint returned 429');
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
                    notifyOfflineVerifyOutcome('rate_limited', data && data.message);
                    return;
                }

                if (res.status >= 500) {
                    // Server/infra trouble — temporary, retryable. Stop
                    // this group (continuing would likely fail identically
                    // for the rest); the outer flow retries on the next
                    // 'online' event or app load. Credential kept.
                    console.log('[Offline Sync] Endpoint returned', res.status);
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
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
                // doesn't block the rest of this account's queue. Credential
                // and retry-state both untouched.
                await setOutboxSyncStatus(record.localId, 'submission_rejected');
                notifyOfflineVerifyOutcome('submission_rejected', data && data.message);
            }

            // Every record in this group either synced or was permanently
            // rejected for its own data reasons — none remain that need
            // this password again. The account is proven correct: forget
            // the credential (no reason to keep it in RAM once its job is
            // done) and clear any stale retry state.
            forgetOfflineCredential(identifier);
            clearRetryState(identifier);
        } finally {
            // Deliberate: drop this function's only reference to the
            // password as soon as the group is done, rather than letting it
            // linger for the rest of the closure's lifetime. JS strings are
            // immutable (this can't force the underlying memory to be
            // overwritten), but the reference itself is cleared immediately
            // rather than left reachable — the smallest amount of "deliberate"
            // available at the language level. This is independent of (and
            // in addition to) the RAM credential store above, which manages
            // its own lifecycle across multiple calls to this function.
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
            console.log('[Offline Sync] Pending surveys found:', unverified.length);
            if (!unverified.length) return;
            const groups = groupUnverifiedByIdentifier(unverified);
            for (const identifier of Object.keys(groups)) {
                if (!navigator.onLine) break; // connection dropped mid-flow — stop, retry later
                // An identifier currently automaticBlocked (a confirmed
                // wrong password) or still inside its temporary backoff
                // window is skipped here — no popup, no automatic retry of
                // a known-wrong password. Bell notification for the
                // failure was already created server-side on the original
                // 401 response.
                if (!canAttemptNow(identifier)) continue;
                await verifyAndSyncGroup(identifier, groups[identifier]);
            }
            await updateVerificationFailedBanner();
            await updateEligibilityConflictBanner();
        } catch (err) {
            console.error('[Offline Verify] Verification flow failed:', err);
        } finally {
            offlineVerificationFlowRunning = false;
        }
    }

    // navigator.onLine turning true is necessary but not sufficient — it can
    // be true while the server (or the wider network path to it) is still
    // unreachable (flaky Wi-Fi, captive portal, server restart in
    // progress). This checks actual server reachability via /api/health
    // before attempting verification, and skips that round-trip entirely
    // when nothing pending is currently eligible for an automatic attempt.
    async function attemptReconnectSync() {
        if (!navigator.onLine) return;

        let pending;
        try {
            pending = await getUnverifiedOutboxSurveys();
        } catch (err) {
            console.error('[Offline Sync] Failed to read outbox:', err);
            return;
        }
        if (!pending.length) {
            console.log('[Offline Sync] No pending records found');
            return;
        }

        const groups = groupUnverifiedByIdentifier(pending);
        const eligible = Object.keys(groups).some((id) => canAttemptNow(id));
        if (!eligible) {
            console.log('[Offline Sync] All pending identifiers are blocked or backing off — skipping health check');
            return;
        }

        console.log('[Offline Sync] Checking server reachability');
        try {
            const res = await fetchWithTimeout('/api/health', {}, 4000);
            if (!res.ok) {
                console.log('[Offline Sync] Health check failed');
                return;
            }
        } catch (err) {
            console.log('[Offline Sync] Health check failed');
            return;
        }

        await runOfflineVerificationFlow();
    }

    window.addEventListener('online', () => {
        console.log('[Offline Sync] Browser online event detected');
        resetTemporaryBackoffs();
        attemptReconnectSync();
        syncOfflineSurveysFromPage();
    });
    window.addEventListener('load', () => {
        if (navigator.onLine) {
            attemptReconnectSync();
        }
        // A terminal eligibility_conflict record from an earlier session
        // must stay visible on return — never wait for the next sync
        // attempt (there may not be one, since it's excluded from the
        // automatic retry pool by design).
        updateEligibilityConflictBanner();
    });

    // Periodic fallback in case the 'online' event never fires (some
    // browsers/OSes don't reliably dispatch it on every real reconnect) —
    // only does anything while pending unverified records actually exist,
    // and attemptReconnectSync's own eligibility/health checks keep this
    // from hammering the server. offlineVerificationFlowRunning prevents
    // any overlap with a run already in progress.
    setInterval(async () => {
        let pending;
        try {
            pending = await getUnverifiedOutboxSurveys();
        } catch (err) {
            return;
        }
        if (pending.length) attemptReconnectSync();
    }, 12000);

    window.queueSurveyOffline = queueSurveyOffline;
    window.syncOfflineSurveysFromPage = syncOfflineSurveysFromPage;
    window.runOfflineVerificationFlow = runOfflineVerificationFlow;
    window.attemptReconnectSync = attemptReconnectSync;
    window.rememberOfflineCredential = rememberOfflineCredential;
    window.forgetOfflineCredential = forgetOfflineCredential;
    window.updateEligibilityConflictBanner = updateEligibilityConflictBanner;
})();
