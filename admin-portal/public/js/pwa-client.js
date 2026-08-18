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
    // Background Sync when it's supported.
    async function queueSurveyOffline(payload, clientEmail) {
        const record = {
            localId: generateLocalId(),
            payload,
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

    window.queueSurveyOffline = queueSurveyOffline;
    window.syncOfflineSurveysFromPage = syncOfflineSurveysFromPage;
})();
