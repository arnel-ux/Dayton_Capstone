// Shared IndexedDB "outbox" helper for queued offline survey submissions.
// Plain script, also loaded via importScripts() in service-worker.js, so no ES modules.

var OFFLINE_DB_NAME = 'cspc-survey-offline';
// v2 added the cached account context store, v3 added the active draft store.
var OFFLINE_DB_VERSION = 3;
var OUTBOX_STORE = 'unsent-surveys';
var ACCOUNT_CONTEXT_STORE = 'offlineAccountContext';
var ACTIVE_DRAFT_STORE = 'activeSurveyDraft';

// Wraps fetch() with a timeout via AbortController.
function fetchWithTimeout(resource, options, timeoutMs) {
    options = options || {};
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (controller) {
        options = Object.assign({}, options, { signal: controller.signal });
    }
    var timer = setTimeout(function () {
        if (controller) controller.abort();
    }, timeoutMs);
    return fetch(resource, options).then(
        function (response) { clearTimeout(timer); return response; },
        function (err) { clearTimeout(timer); throw err; }
    );
}

// Timestamp marker in localStorage for a pending client logout, shared across pages.
var CLIENT_PENDING_LOGOUT_KEY = 'cspc_client_pending_logout';

function setPendingClientLogout() {
    try { localStorage.setItem(CLIENT_PENDING_LOGOUT_KEY, String(Date.now())); } catch (e) { /* localStorage unavailable, offline overlay still works */ }
}

function hasPendingClientLogout() {
    try { return !!localStorage.getItem(CLIENT_PENDING_LOGOUT_KEY); } catch (e) { return false; }
}

function clearPendingClientLogout() {
    try { localStorage.removeItem(CLIENT_PENDING_LOGOUT_KEY); } catch (e) { /* ignore */ }
}

// Tries the real server logout for a flagged offline session and clears the marker once confirmed.
function attemptPendingClientLogout() {
    if (!hasPendingClientLogout()) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);

    return fetchWithTimeout('/logout?scope=client', { credentials: 'same-origin' }, 8000)
        .then(function (res) {
            var confirmedLoggedOut = false;
            try {
                confirmedLoggedOut = !!(res && res.ok && res.redirected && new URL(res.url).pathname === '/login');
            } catch (e) { /* malformed/unexpected res.url — treat as not confirmed */ }
            if (confirmedLoggedOut) clearPendingClientLogout();
            return confirmedLoggedOut;
        })
        .catch(function () {
            // Still offline or timed out, leave the marker in place.
            return false;
        });
}

function openOfflineDB() {
    return new Promise(function (resolve, reject) {
        var req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'localId' });
            }
            // One record per account, keyed by normalized identifier.
            if (!db.objectStoreNames.contains(ACCOUNT_CONTEXT_STORE)) {
                db.createObjectStore(ACCOUNT_CONTEXT_STORE, { keyPath: 'identifier' });
            }
            // One in-progress draft per account, overwritten on each autosave.
            if (!db.objectStoreNames.contains(ACTIVE_DRAFT_STORE)) {
                db.createObjectStore(ACTIVE_DRAFT_STORE, { keyPath: 'clientEmailKey' });
            }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

// Saves an account context snapshot (profile plus office/service eligibility, never a credential).
// Overwrites any existing record for this identifier.
function saveOfflineAccountContext(context) {
    if (!context || !context.accountIdentifier) return Promise.resolve();
    var identifier = String(context.accountIdentifier).trim().toLowerCase();
    var record = {
        identifier: identifier,
        profile: context.profile || null,
        offices: context.offices || [],
        services: context.services || [],
        cachedAt: context.cachedAt || new Date().toISOString(),
        schemaVersion: 1
    };
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(ACCOUNT_CONTEXT_STORE, 'readwrite');
            tx.objectStore(ACCOUNT_CONTEXT_STORE).put(record);
            tx.oncomplete = function () {
                console.log('[Offline Context] Account context cached');
                resolve(record);
            };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

// Returns the cached context record for one normalized identifier, or null if none is cached yet.
function getOfflineAccountContext(identifier) {
    var key = String(identifier || '').trim().toLowerCase();
    if (!key) return Promise.resolve(null);
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(ACCOUNT_CONTEXT_STORE, 'readonly');
            var req = tx.objectStore(ACCOUNT_CONTEXT_STORE).get(key);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { reject(req.error); };
        });
    });
}

// ==========================================
// ACTIVE (IN-PROGRESS) ONLINE SURVEY DRAFT
//
// Holds a survey that's still being filled out, so a refresh doesn't lose it.
// Moves into the outbox only once the user clicks Submit.
// ==========================================
function normalizeDraftAccountKey(clientEmail) {
    return (clientEmail || '').trim().toLowerCase();
}

function saveActiveSurveyDraft(clientEmail, draft) {
    var key = normalizeDraftAccountKey(clientEmail);
    if (!key) return Promise.resolve(null);
    var record = Object.assign({}, draft, { clientEmailKey: key, updatedAt: Date.now() });
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(ACTIVE_DRAFT_STORE, 'readwrite');
            tx.objectStore(ACTIVE_DRAFT_STORE).put(record);
            tx.oncomplete = function () { resolve(record); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

function getActiveSurveyDraft(clientEmail) {
    var key = normalizeDraftAccountKey(clientEmail);
    if (!key) return Promise.resolve(null);
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(ACTIVE_DRAFT_STORE, 'readonly');
            var req = tx.objectStore(ACTIVE_DRAFT_STORE).get(key);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { reject(req.error); };
        });
    });
}

// Called once the draft becomes a real queued submission or the user discards it.
function clearActiveSurveyDraft(clientEmail) {
    var key = normalizeDraftAccountKey(clientEmail);
    if (!key) return Promise.resolve();
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(ACTIVE_DRAFT_STORE, 'readwrite');
            tx.objectStore(ACTIVE_DRAFT_STORE).delete(key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
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

// Two kinds of record share this store, told apart by `mode`: 'authenticated' for a logged-in
// session going offline, 'unverified' for the unauthenticated flow. No `mode` counts as authenticated.
function getAuthenticatedOutboxSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) { return !r.mode || r.mode === 'authenticated'; });
    });
}

// Returns records still in a retryable state (pending_sync, verification_required,
// verification_failed, sync_failed). Terminal states like synced or eligibility_conflict are excluded.
function getUnverifiedOutboxSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) {
            return r.mode === 'unverified' &&
                (r.syncStatus === 'pending_sync' || r.syncStatus === 'verification_required' ||
                 r.syncStatus === 'verification_failed' || r.syncStatus === 'sync_failed');
        });
    });
}

// Returns records stuck on an eligibility conflict, kept separate from the retryable query above.
function getEligibilityConflictSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) { return r.mode === 'unverified' && r.syncStatus === 'eligibility_conflict'; });
    });
}

// Groups unverified records by normalized registeredIdentifier. Returns { identifier: [records] }.
function groupUnverifiedByIdentifier(records) {
    var groups = {};
    records.forEach(function (r) {
        var key = String(r.registeredIdentifier || '').trim().toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });
    return groups;
}

// Allowlist of the only fields ever persisted from an offline survey submission.
var OFFLINE_SURVEY_PAYLOAD_FIELD_ALLOWLIST = [
    'email', 'respondent_name', 'client_type', 'age', 'gender', 'region',
    'office_id', 'service_availed', 'office_visited_time', 'survey_date', 'topic',
    'cc1', 'cc2', 'cc3',
    'sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8',
    'comments'
];
// Extra check run against every key before it's copied, on top of the allowlist above.
var OFFLINE_SURVEY_FORBIDDEN_FIELD_PATTERN = /password|passwordhash|password_hash|credential|token|authorization/i;

function buildSafeOfflineSurveyPayload(payload) {
    var safe = {};
    if (!payload) return safe;
    OFFLINE_SURVEY_PAYLOAD_FIELD_ALLOWLIST.forEach(function (key) {
        if (!(key in payload)) return;
        if (OFFLINE_SURVEY_FORBIDDEN_FIELD_PATTERN.test(key)) return;
        safe[key] = payload[key];
    });
    return safe;
}

// Builds an RFC4122-ish v4 UUID. Prefers crypto.randomUUID(), falls back to
// crypto.getRandomValues(), and Math.random() as a last resort.
function generateOfflineSubmissionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();

    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
        var hex = Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Saves a completed offline survey from the unauthenticated /survey-offline flow.
// `payload.email` becomes registeredIdentifier, verified server-side later.
function queueUnverifiedOfflineSurvey(payload) {
    var record = {
        localId: 'offline-survey-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
        offlineSubmissionId: generateOfflineSubmissionId(),
        registeredIdentifier: (payload && payload.email) ? String(payload.email).trim().toLowerCase() : '',
        payload: buildSafeOfflineSurveyPayload(payload),
        mode: 'unverified',
        syncStatus: 'pending_sync',
        createdOfflineAt: new Date().toISOString(),
        savedAt: Date.now()
    };
    return addSurveyToOutbox(record).then(function () {
        console.log('[Offline Queue] Survey queued');
        console.log('[Offline Queue] Submission ID:', record.offlineSubmissionId);
        console.log('[Offline Queue] Mode:', record.mode);
        return record;
    });
}

// Updates just the syncStatus of one outbox record in place. `extra` (optional) is
// shallow-merged onto the record for small display fields.
function setOutboxSyncStatus(localId, syncStatus, extra) {
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(OUTBOX_STORE, 'readwrite');
            var store = tx.objectStore(OUTBOX_STORE);
            var getReq = store.get(localId);
            getReq.onsuccess = function () {
                var record = getReq.result;
                if (!record) { resolve(); return; }
                record.syncStatus = syncStatus;
                if (extra) {
                    Object.keys(extra).forEach(function (key) { record[key] = extra[key]; });
                }
                store.put(record);
            };
            getReq.onerror = function () { reject(getReq.error); };
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
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

// Sends every queued authenticated survey to the backend in one batch via POST /sync-surveys.
// Shared by service-worker.js and pwa-client.js. Resolves { syncedCount, failedResults }.
function runOfflineSurveySync() {
    return getAuthenticatedOutboxSurveys().then(function (surveys) {
        if (!surveys.length) return { syncedCount: 0, supersededCount: 0, failedResults: [] };

        // Generous timeout since the server runs AI analysis on every queued survey before replying.
        return fetchWithTimeout('/sync-surveys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                // createdOfflineAt is when the respondent finished the survey, not when it synced.
                surveys: surveys.map(function (s) {
                    var when = s.createdOfflineAt || (s.savedAt ? new Date(s.savedAt).toISOString() : null);
                    return { localId: s.localId, payload: s.payload, createdOfflineAt: when };
                })
            })
        }, 30000).then(function (response) {
            if (!response.ok) return { syncedCount: 0, supersededCount: 0, failedResults: [] };
            return response.json();
        }).then(function (data) {
            var results = (data && Array.isArray(data.results)) ? data.results : [];
            var syncedCount = 0;
            var supersededCount = 0;
            var failedResults = [];

            // Each item's `status` decides whether it's resolved and removed from the outbox
            // or left queued for retry. Only 'retry_later' stays queued.
            var removals = results.map(function (result) {
                if (result.status === 'retry_later') {
                    // Leave queued, the next sync attempt will retry it.
                    return Promise.resolve();
                }
                return removeSurveyFromOutbox(result.localId).then(function () {
                    if (result.status === 'superseded_by_online') {
                        // Already covered by an online submission, so it doesn't count as a new sync.
                        supersededCount++;
                    } else if (result.success) {
                        syncedCount++;
                    } else {
                        failedResults.push(result);
                    }
                }).catch(function (err) {
                    console.error('[Sync] Failed to remove synced survey from outbox:', err);
                });
            });

            return Promise.all(removals).then(function () {
                return { syncedCount: syncedCount, supersededCount: supersededCount, failedResults: failedResults };
            });
        });
    });
}
