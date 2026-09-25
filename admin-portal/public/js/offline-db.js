// Shared IndexedDB "outbox" helper for queued offline survey submissions.
// Loaded both as a plain <script> in the page and via importScripts() inside
// service-worker.js, so it only uses APIs available in both contexts
// (indexedDB) and defines plain global functions — no ES module syntax.

var OFFLINE_DB_NAME = 'cspc-survey-offline';
// v2 adds the offlineAccountContext store (see below) — a non-secret
// (personal account information, but never a credential) per-account
// profile/eligibility snapshot cached after authenticated online logins,
// used to improve the /survey-offline UI. Never contains a password, hash,
// token, or session identifier — see saveOfflineAccountContext.
// v3 adds ACTIVE_DRAFT_STORE (see below) — an in-progress, NOT-YET-SUBMITTED
// online survey attempt, autosaved so a sudden internet loss (or an
// accidental refresh/reopen while offline) can restore it. Deliberately a
// separate store from OUTBOX_STORE: that store holds completed submissions
// already queued for sync (runOfflineSurveySync would otherwise happily
// try to sync a half-finished draft the moment it saw one there).
var OFFLINE_DB_VERSION = 3;
var OUTBOX_STORE = 'unsent-surveys';
var ACCOUNT_CONTEXT_STORE = 'offlineAccountContext';
var ACTIVE_DRAFT_STORE = 'activeSurveyDraft';

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

// ==========================================
// PENDING CLIENT LOGOUT — shared across every page that might need to
// finish an offline-triggered logout (client-survey.ejs, login.ejs,
// index.ejs, client-login.ejs). Lives here (not duplicated per-page)
// because this file is already loaded by all of them, unlike
// pwa-client.js/alerts.js which aren't universal.
//
// Uses localStorage, not sessionStorage: the marker must survive the user
// navigating away from client-survey.ejs entirely (e.g. choosing "Login" or
// "Dashboard" from the offline overlay while still offline, landing on a
// different page/tab by the time connectivity actually returns) — plain
// per-tab sessionStorage would not reliably follow them there.
//
// IMPORTANT: this is a non-sensitive UI hint only — a timestamp, nothing
// else. It is never treated as proof of anything and never gates access to
// any route; the server's own session/cookie check (ensureClientAuth) is
// the only real authority on whether a request is authenticated. This
// marker only decides whether a background page should retry telling the
// server "please destroy that session" and whether client-survey.ejs should
// show its offline/back-online overlay instead of the authenticated view.
//
// SAFE IN THE SERVICE WORKER TOO: these are plain function declarations —
// nothing here runs at import time, and the service worker never calls any
// of them (only page scripts do), so referencing `localStorage`/`navigator`
// inside their bodies never executes in that context.
// ==========================================
var CLIENT_PENDING_LOGOUT_KEY = 'cspc_client_pending_logout';

function setPendingClientLogout() {
    try { localStorage.setItem(CLIENT_PENDING_LOGOUT_KEY, String(Date.now())); } catch (e) { /* localStorage unavailable — the offline overlay itself still works, just without surviving a navigation/refresh */ }
}

function hasPendingClientLogout() {
    try { return !!localStorage.getItem(CLIENT_PENDING_LOGOUT_KEY); } catch (e) { return false; }
}

function clearPendingClientLogout() {
    try { localStorage.removeItem(CLIENT_PENDING_LOGOUT_KEY); } catch (e) { /* ignore */ }
}

// Attempts the real server-side logout for a previously-flagged offline
// session. Resolves true ONLY once the server has actually confirmed the
// session is gone — a network failure, timeout, or any response that
// doesn't look like a genuine completed logout leaves the marker in place
// for the next call (a later page load or 'online' event elsewhere) to
// retry. No retry loop of its own — callers invoke this once per
// load/online event, which is enough; see the callers in each page.
//
// Detecting success: GET /logout?scope=client (server.js) destroys the
// session and 302-redirects to /login. fetch() follows that redirect
// transparently and reports the FINAL response, but exposes
// response.redirected (true) and response.url (the final URL) — so
// "redirected, and ended up on /login, with a normal 200" is what a real,
// server-processed logout looks like from here. A network error/timeout
// rejects the promise outright (never reaches .then), which is treated as
// failure, not success — the marker is only ever cleared in the one branch
// that actually observed the server's response.
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
            // Still offline, a captive portal, a timeout, etc. — leave the
            // marker in place; nothing here claims the session was closed.
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
            // Keyed by the normalized (trim().toLowerCase()) account
            // identifier — one record per account, overwritten on every
            // refresh. Deliberately a separate store from OUTBOX_STORE: this
            // holds account-level display context, not queued submissions.
            if (!db.objectStoreNames.contains(ACCOUNT_CONTEXT_STORE)) {
                db.createObjectStore(ACCOUNT_CONTEXT_STORE, { keyPath: 'identifier' });
            }
            // One in-progress draft per account (keyed by the same normalized
            // email convention as ACCOUNT_CONTEXT_STORE) — a fresh autosave
            // simply overwrites the previous one for that account.
            if (!db.objectStoreNames.contains(ACTIVE_DRAFT_STORE)) {
                db.createObjectStore(ACTIVE_DRAFT_STORE, { keyPath: 'clientEmailKey' });
            }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

// Saves a non-secret account context snapshot (profile + office/service
// eligibility — personal account information, but never a credential) —
// see buildClientOfflineContext in server.js for the exact
// shape. `context` must never contain a password, password hash, session
// token, or cookie; callers only ever pass what GET /api/client/offline-
// context (or a sync response's offlineContext field) returned, which
// structurally cannot include those. Overwrites any existing record for
// this identifier — always the most-recently-known snapshot, never merged
// with a stale one.
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

// Returns the cached context record for one normalized identifier, or null
// if this device has never cached one for that account (see item 22/23 of
// the offline-profile spec — a missing snapshot is expected and must not
// block offline survey use, only skip the read-only-profile/known-cooldown
// UX improvements).
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
// Distinct from the outbox above: this is a survey attempt that hasn't been
// submitted yet — captured continuously while the authenticated /client-
// survey form is being filled out (and immediately the instant 'offline'
// fires), so it survives an accidental refresh/reopen. It only ever moves
// into the outbox once the user actually clicks Submit; this store is
// cleared at that point (see queueSurveyOffline's caller in
// client-survey.ejs), never synced directly by runOfflineSurveySync.
//
// Reuses buildSafeOfflineSurveyPayload (below) for the field allowlist —
// the exact same one already used for completed offline submissions — so
// there is exactly one canonical field list for "what a survey payload
// contains," not two schemas to keep in sync.
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

// Called only once the draft has either become a real queued submission
// (moved into the outbox) or the user explicitly discarded it — never just
// because connectivity changed, sync started, or a request was sent.
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
// too). A terminal 'synced'/'pending_approval' record is excluded (removed
// from the store once the caller confirms the server accepted it), and so
// are 'submission_rejected' and 'eligibility_conflict' — both are permanent
// problems with the survey's data/timing, not the account, so retrying the
// identical request on a timer cannot succeed; they stay in the store only
// for the user to review/edit/remove, never re-entering automatic sync.
function getUnverifiedOutboxSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) {
            return r.mode === 'unverified' &&
                (r.syncStatus === 'pending_sync' || r.syncStatus === 'verification_required' ||
                 r.syncStatus === 'verification_failed' || r.syncStatus === 'sync_failed');
        });
    });
}

// Deliberately separate from getUnverifiedOutboxSurveys — a terminal
// eligibility_conflict record must never re-enter the automatic sync/retry
// pool (the account and password already proved correct; only the office/
// service was on cooldown), so it's never included in that query's result.
// This is the ONLY read path for these records — the conflict banner
// (updateEligibilityConflictBanner in pwa-client.js) uses it to render the
// terminal-state UI (§7 of the offline-context hardening spec), and the
// only other thing that ever touches one of these rows again is an
// explicit "Discard Local Response" click (removeSurveyFromOutbox).
function getEligibilityConflictSurveys() {
    return getAllOutboxSurveys().then(function (all) {
        return all.filter(function (r) { return r.mode === 'unverified' && r.syncStatus === 'eligibility_conflict'; });
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
    return addSurveyToOutbox(record).then(function () {
        console.log('[Offline Queue] Survey queued');
        console.log('[Offline Queue] Submission ID:', record.offlineSubmissionId);
        console.log('[Offline Queue] Mode:', record.mode);
        return record;
    });
}

// Updates just the syncStatus of one outbox record in place (put() requires
// the full object, so this reads-modifies-writes rather than patching).
// `extra` (optional) is shallow-merged onto the record — used only for
// small, safe display fields (e.g. the eligibility_conflict message/
// nextEligibleAt from POST /api/offline-surveys/verify-and-sync), never a
// credential; callers only ever pass server-returned display strings here.
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
        if (!surveys.length) return { syncedCount: 0, supersededCount: 0, failedResults: [] };

        // Generous timeout — the server awaits AI sentiment/topic analysis for
        // every queued survey before replying, which can legitimately take a
        // while for a large batch. This guards against a hung connection, not
        // against a slow-but-working one.
        return fetchWithTimeout('/sync-surveys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                // createdOfflineAt is when the respondent finished the survey
                // (savedAt is stamped when it was queued), so the server can
                // record THAT time instead of the moment this sync ran.
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

            // Each item's `status` (see /sync-surveys -> syncOneSurvey server-side)
            // decides whether it's resolved (removed from the outbox — synced,
            // pending office review, or superseded by an Online submission that
            // already covers this exact office/account/service) or left queued
            // for a later retry. 'retry_later' (the server was momentarily busy
            // serializing a conflicting submission for this same logical survey)
            // is the ONLY status that must NOT be treated as resolved — removing
            // it here would silently drop a real, still-unsynced survey after a
            // single transient lock contention.
            var removals = results.map(function (result) {
                if (result.status === 'retry_later') {
                    // Leave queued — next sync attempt (auto or manual) will
                    // retry it. Not surfaced as a failure to the user; this is
                    // expected to resolve itself within seconds.
                    return Promise.resolve();
                }
                return removeSurveyFromOutbox(result.localId).then(function () {
                    if (result.status === 'superseded_by_online') {
                        // Resolved, but NOT a new sync — an Online submission
                        // for this exact survey was already received, so this
                        // offline copy was correctly never counted as a second
                        // response. Tracked separately so the UI never claims
                        // "N offline surveys synced" for something that wasn't
                        // actually inserted.
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
