// Shared IndexedDB "outbox" helper for queued offline survey submissions.
// Loaded both as a plain <script> in the page and via importScripts() inside
// service-worker.js, so it only uses APIs available in both contexts
// (indexedDB) and defines plain global functions — no ES module syntax.

var OFFLINE_DB_NAME = 'cspc-survey-offline';
var OFFLINE_DB_VERSION = 1;
var OUTBOX_STORE = 'unsent-surveys';

// Plain fetch() has no built-in timeout, so on a flaky/partial connection
// (Wi-Fi still "connected" but no route to the internet, a captive portal, a
// stale DNS entry, etc.) it can hang for the browser's full connection
// timeout — tens of seconds — before ever rejecting. That's fatal for any
// offline-first fallback (serve from cache/queue locally instead), which
// only runs once the live request fails. This forces a fast, predictable
// failure via AbortController so the fallback kicks in promptly instead of
// leaving the user staring at a spinner (or the browser's own "took too
// long to respond" page, for navigations — see handleNavigation below).
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

// Two kinds of record share this one store, distinguished by `mode`:
// 'authenticated' (queued while an already-logged-in session went offline —
// the pre-existing behavior, synced via /sync-surveys using that session,
// no password ever involved) and 'unverified' (queued from the
// unauthenticated /survey-offline flow — synced via
// /api/offline-surveys/verify-and-sync, which requires the account's
// password, asked for once verification runs, never stored). A record with
// no `mode` at all predates this distinction entirely and is treated as
// 'authenticated' for backward compatibility with anything already queued
// before this was added.
function getAuthenticatedOutboxSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) { return !r.mode || r.mode === 'authenticated'; });
    });
}

// Every retryable state: a fresh record (pending_sync), one shown the
// verification modal but not yet answered (verification_required), one
// whose password attempt failed (verification_failed — must ask again, not
// silently retry the same failed password), and one that failed for a
// transient network/server reason during the actual sync call
// (sync_failed — must NOT be permanently stranded, so it stays retryable
// too). Only a terminal 'synced'/'pending_approval' record is excluded —
// those are removed from the store once the caller confirms the server
// accepted them.
function getUnverifiedOutboxSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) {
            return r.mode === 'unverified' &&
                (r.syncStatus === 'pending_sync' || r.syncStatus === 'verification_required' ||
                 r.syncStatus === 'verification_failed' || r.syncStatus === 'sync_failed');
        });
    });
}

// Groups unverified records by normalized registeredIdentifier — a device
// can hold offline surveys for more than one account (e.g. a shared kiosk),
// and a password entered for one account must never be attempted against
// another's. Returns a plain object: { identifier: [records] }.
function groupUnverifiedByIdentifier(records) {
    var groups = {};
    records.forEach(function (r) {
        var key = String(r.registeredIdentifier || '').trim().toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });
    return groups;
}

// Explicit allowlist of the only fields ever persisted from an offline
// survey submission. Defense in depth on top of "the offline form simply
// has no password field": even if a future edit to the survey form, a
// hidden field, or a programming mistake ever put something else into the
// payload object, this store only ever writes to IndexedDB whatever is
// named here — nothing else, named password/credential/token or otherwise,
// can reach disk through this function.
var OFFLINE_SURVEY_PAYLOAD_FIELD_ALLOWLIST = [
    'email', 'respondent_name', 'client_type', 'age', 'gender', 'region',
    'office_id', 'service_availed', 'office_visited_time', 'survey_date', 'topic',
    'cc1', 'cc2', 'cc3',
    'sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8',
    'comments'
];
// Belt-and-suspenders on top of the allowlist above — none of the
// allowlisted keys should ever match this, but a key is still checked
// against it before being copied, never trusting the allowlist alone.
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

// RFC4122-ish v4 UUID. Prefers crypto.randomUUID(); where that's
// unavailable (older browsers, or a non-HTTPS/non-localhost origin in some
// of them), falls back to building one from crypto.getRandomValues() —
// still cryptographically strong randomness, just assembled by hand — and
// only drops to Math.random() as an absolute last resort on a browser with
// neither API (effectively unheard of today). This value is an idempotency
// key, not a secret, but there's no reason to accept weaker collision
// resistance than the browser can actually provide.
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

// Saves a completed offline survey from the UNAUTHENTICATED /survey-offline
// flow. Deliberately takes only the survey payload — never a password; see
// buildSafeOfflineSurveyPayload above for how that's enforced at the
// storage layer itself, not just by the offline form having no password
// field. `payload.email` (the form's "Registered CSPC Email / Gmail" field)
// becomes registeredIdentifier, the value later verified server-side
// against the real account.
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
    return addSurveyToOutbox(record).then(function () { return record; });
}

// Updates just the syncStatus of one outbox record in place (put() requires
// the full object, so this reads-modifies-writes rather than patching).
function setOutboxSyncStatus(localId, syncStatus) {
    return openOfflineDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(OUTBOX_STORE, 'readwrite');
            var store = tx.objectStore(OUTBOX_STORE);
            var getReq = store.get(localId);
            getReq.onsuccess = function () {
                var record = getReq.result;
                if (!record) { resolve(); return; }
                record.syncStatus = syncStatus;
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

// Sends every queued AUTHENTICATED survey to the backend in one batch
// (POST /sync-surveys, which relies on this browser's existing session —
// see getAuthenticatedOutboxSurveys), awaiting AI sentiment/topic analysis
// for each one before inserting it and only replying once every survey has
// been analyzed and written to the database. Shared by service-worker.js
// (Background Sync) and pwa-client.js (the 'online'-event fallback for
// browsers without Background Sync) — it only touches indexedDB/fetch/
// Promise, all available in both contexts. Resolves
// { syncedCount, failedResults }. Unverified (unauthenticated-flow) records
// are handled entirely separately — see runOfflineVerificationFlow in
// pwa-client.js — since that endpoint needs a password this function never
// has.
function runOfflineSurveySync() {
    return getAuthenticatedOutboxSurveys().then(function (surveys) {
        if (!surveys.length) return { syncedCount: 0, failedResults: [] };

        // Generous timeout — the server awaits AI sentiment/topic analysis for
        // every queued survey before replying, which can legitimately take a
        // while for a large batch. This guards against a hung connection, not
        // against a slow-but-working one.
        return fetchWithTimeout('/sync-surveys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                surveys: surveys.map(function (s) { return { localId: s.localId, payload: s.payload }; })
            })
        }, 30000).then(function (response) {
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
