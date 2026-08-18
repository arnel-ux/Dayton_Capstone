// Shared IndexedDB "outbox" helper for queued offline survey submissions.
// Loaded both as a plain <script> in the page and via importScripts() inside
// service-worker.js, so it only uses APIs available in both contexts
// (indexedDB) and defines plain global functions — no ES module syntax.

var OFFLINE_DB_NAME = 'cspc-survey-offline';
var OFFLINE_DB_VERSION = 1;
var OUTBOX_STORE = 'unsent-surveys';

function openOfflineDB() {
    return new Promise(function (resolve, reject) {
        var req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'localId' });
            }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

function addSurveyToOutbox(record) {
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(OUTBOX_STORE, 'readwrite');
            tx.objectStore(OUTBOX_STORE).put(record);
            tx.oncomplete = function () { resolve(record); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

function getAllOutboxSurveys() {
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(OUTBOX_STORE, 'readonly');
            var req = tx.objectStore(OUTBOX_STORE).getAll();
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function () { reject(req.error); };
        });
    });
}

function removeSurveyFromOutbox(localId) {
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(OUTBOX_STORE, 'readwrite');
            tx.objectStore(OUTBOX_STORE).delete(localId);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

// Sends every queued survey to the backend in one batch (POST /sync-surveys),
// which awaits AI sentiment/topic analysis for each one before inserting it
// and only replies once every survey has been analyzed and written to the
// database. Shared by service-worker.js (Background Sync) and pwa-client.js
// (the 'online'-event fallback for browsers without Background Sync) — it
// only touches indexedDB/fetch/Promise, all available in both contexts.
// Resolves { syncedCount, failedResults }.
function runOfflineSurveySync() {
    return getAllOutboxSurveys().then(function (surveys) {
        if (!surveys.length) return { syncedCount: 0, failedResults: [] };

        return fetch('/sync-surveys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                surveys: surveys.map(function (s) { return { localId: s.localId, payload: s.payload }; })
            })
        }).then(function (response) {
            if (!response.ok) return { syncedCount: 0, failedResults: [] };
            return response.json();
        }).then(function (data) {
            var results = (data && Array.isArray(data.results)) ? data.results : [];
            var syncedCount = 0;
            var failedResults = [];

            // Every item here got an explicit success/fail verdict from the server
            // (synced, or a permanent rejection like "already evaluated this
            // office") — either way it's removed from the outbox so it doesn't
            // retry forever; failures are surfaced to the user instead.
            var removals = results.map(function (result) {
                return removeSurveyFromOutbox(result.localId).then(function () {
                    if (result.success) {
                        syncedCount++;
                    } else {
                        failedResults.push(result);
                    }
                }).catch(function (err) {
                    console.error('[Sync] Failed to remove synced survey from outbox:', err);
                });
            });

            return Promise.all(removals).then(function () {
                return { syncedCount: syncedCount, failedResults: failedResults };
            });
        });
    });
}
