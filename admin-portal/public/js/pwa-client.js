// Registers the service worker and exposes the offline queue helpers
// queueSurveyOffline() and syncOfflineSurveysFromPage() to the survey form.
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

    // Shows a toast for a sync outcome from the page fallback or the service worker.
    function notifySyncResult(result) {
        if (!window.AppAlert) {
            console.error('[Offline Sync] AppAlert unavailable — sync result not shown to user:', result);
            return;
        }
        if (result.syncedCount > 0) {
            AppAlert.success(
                `${result.syncedCount} offline survey${result.syncedCount > 1 ? 's' : ''} synced and analyzed successfully.`,
                'Sync Complete'
            );
        }
        // Discarded because an online submission for the same service already existed.
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

    // Saves a survey into the IndexedDB outbox and registers a background sync if supported.
    // Used for the authenticated offline flow only.
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
        } else {
            console.error('[Offline Sync] AppAlert unavailable — "saved offline" confirmation not shown to user.');
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

    // Fallback replay path for browsers without Background Sync support, triggered by the 'online' event.
    // Uses the same batch /sync-surveys request as the service worker.
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

    // Unauthenticated offline flow. Surveys from /survey-offline get verified once back online
    // through POST /api/offline-surveys/verify-and-sync using the account password.

    function normalizeIdentifier(identifier) {
        return (identifier || '').trim().toLowerCase();
    }

    // RAM only credential store. Keeps an offline survey's account password in page memory,
    // never in IndexedDB, storage, cookies, logs, or a survey payload.
    const DEFAULT_OFFLINE_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
    const temporaryOfflineCredentials = new Map(); // normalized identifier to { password, expiresAt }

    function rememberOfflineCredential(identifier, password) {
        const key = normalizeIdentifier(identifier);
        if (!key || !password) return;
        temporaryOfflineCredentials.set(key, { password, expiresAt: Date.now() + DEFAULT_OFFLINE_CREDENTIAL_TTL_MS });
        // A fresh password means verification should start clean, so reset any retry state.
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

    // Retry and backoff state, separate from the credential store. Temporary failures get a
    // timed backoff and retry automatically; a confirmed wrong password blocks retries until
    // a fresh credential is remembered.
    const identifierRetryState = new Map(); // normalized identifier to { failureCount, nextRetryAt, automaticBlocked }
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

    // Resets temporary backoff timers on reconnect but leaves blocked (401) entries alone.
    function resetTemporaryBackoffs() {
        for (const [key, entry] of identifierRetryState) {
            if (!entry.automaticBlocked) identifierRetryState.delete(key);
        }
    }

    // Masks an identifier for display in the UI while the real value is still used internally.
    function maskIdentifierForDisplay(identifier) {
        const id = identifier || '';
        const at = id.indexOf('@');
        if (at <= 0) return '***';
        const user = id.slice(0, at);
        const domain = id.slice(at);
        return user.slice(0, Math.min(2, user.length)) + '***' + domain;
    }

    // Refreshes the verification failed banner with every identifier that failed on reconnect.
    // Informational only, does nothing if the banner container isn't on the page.
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

    // Refreshes the eligibility conflict banner with one row per queued conflict record.
    // Not an auth problem, so it never shows a password retry. Does nothing if the banner container isn't on the page.
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

            // Uses the server's timestamp, not the offline device's clock.
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
                // The one destructive action in the offline flow, so it needs an explicit confirm.
                const confirmed = await AppAlert.confirm(
                    'This offline response will be permanently removed from this device. This cannot be undone.',
                    { title: 'Discard this response?', confirmText: 'Discard', danger: true }
                );
                if (!confirmed) return;

                discardBtn.disabled = true;
                try {
                    // Removes only this one record, everything else in the outbox stays untouched.
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
                // Resets only the current form, doesn't touch this or any other queued record.
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
        if (!window.AppAlert) {
            console.error('[Offline Sync] AppAlert unavailable — outcome not shown to user:', status, message);
            return;
        }
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

    // Verifies and syncs every survey queued under one identifier using the password held in RAM.
    // Never prompts for a password, so a group with no credential is just left alone.
    async function verifyAndSyncGroup(identifier, records) {
        const password = getOfflineCredential(identifier);
        console.log('[Offline Sync] Temporary credential available:', password ? 'yes' : 'no');

        if (!password) {
            // Leaves every record as is. Picked up again once the credential is remembered.
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
                    // A temporary failure, not a wrong password. Leaves the group retryable and keeps the credential.
                    console.error('[Offline Sync] Network request failed:', networkErr);
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
                    notifyOfflineVerifyOutcome('sync_failed', null);
                    return;
                }

                let data = null;
                try { data = await res.json(); } catch (parseErr) { /* falls through to the generic failure branch below */ }

                if (res.ok && data && data.success) {
                    await removeSurveyFromOutbox(record.localId);
                    console.log('[Offline Sync] Local record removed');
                    // Refreshes the cached eligibility snapshot, best effort, never blocks the sync.
                    if (data.offlineContext && typeof saveOfflineAccountContext === 'function') {
                        saveOfflineAccountContext(data.offlineContext).catch((err) => console.error('[Offline Context] Failed to cache refreshed context:', err));
                    }
                    notifyOfflineVerifyOutcome(data.status, data.message);
                    continue;
                }

                if (res.status === 409 && data && data.status === 'eligibility_conflict') {
                    // The account is fine, the office or service is just on cooldown. Not an auth problem,
                    // so this stays queued for the user instead of retrying automatically.
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
                    // Wrong password or unknown account. Marks the rest of this group failed,
                    // drops the credential from RAM, and blocks further automatic attempts.
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
                    // Rate limited. Leaves it queued, tells the user to wait, keeps the credential.
                    console.log('[Offline Sync] Endpoint returned 429');
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
                    notifyOfflineVerifyOutcome('rate_limited', data && data.message);
                    return;
                }

                if (res.status >= 500) {
                    // Server trouble, temporary and retryable. Stops this group, keeps the credential.
                    console.log('[Offline Sync] Endpoint returned', res.status);
                    await setOutboxSyncStatus(record.localId, 'sync_failed');
                    recordTemporaryFailure(identifier);
                    notifyOfflineVerifyOutcome('sync_failed', data && data.message);
                    return;
                }

                // Any other error is a permanent problem with this survey's data, not the account.
                // Stays in the outbox for review but doesn't block the rest of the group.
                await setOutboxSyncStatus(record.localId, 'submission_rejected');
                notifyOfflineVerifyOutcome('submission_rejected', data && data.message);
            }

            // Every record synced or was permanently rejected, so the credential is no longer needed.
            forgetOfflineCredential(identifier);
            clearRetryState(identifier);
        } finally {
            // Drops this function's reference to the password once the group is done.
            password = null;
        }
    }

    // Entry point that finds every unverified record, groups them by account, and syncs each group.
    // Safe to call repeatedly.
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
                if (!navigator.onLine) break; // connection dropped mid flow, stop and retry later
                // Skips identifiers that are blocked or still backing off.
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

    // Checks real server reachability via /api/health before attempting verification,
    // since navigator.onLine can be true while the server is still unreachable.
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
            console.log('[Offline Sync] All pending identifiers are blocked or backing off, skipping health check');
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
        // Keeps an eligibility conflict record from an earlier session visible on return.
        updateEligibilityConflictBanner();
    });

    // Periodic fallback in case the 'online' event never fires, only acts if records are pending.
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
