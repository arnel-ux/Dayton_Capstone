require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const { spawn } = require('child_process');
const { promisify } = require('util');
const session = require('express-session');
const cookieLib = require('cookie');
const cookieSignature = require('cookie-signature');
const onHeaders = require('on-headers');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { TOPIC_TAXONOMY, SENTIMENT_VALUES, splitTopic, combineTopic } = require('./shared/topicTaxonomy');
const { isNoFeedbackComment, prepareReportComment, maskProfanity } = require('./shared/commentFilter');
const app = express();
const port = 3000;

// All report/dashboard computation formulas (SQD scoring, bucket breakdowns,
// period normalization, effective topic/sentiment resolution, AI-analysis
// gating, sentiment tone, topic badge coloring) live in one place — see
// views/layout/report_computation/report_formula.js for the full list, each
// under its own clearly-labeled section. Extracted from here 2026-09-28 so
// each formula is easy to find and change without searching this whole file;
// every name below is used identically to before, just no longer defined
// inline here.
const {
    sqdScoreExpr, ALL_SQD_COLS,
    sqdBucketExprs, SQD_DIMENSIONS, buildSqdBucketRow,
    NO_DATA, scoreCell, CLUSTER_REPORT_ORDER, buildOrderedClusterReport,
    OFFICE_REPORT_NAME_EXPR,
    normalizePeriodStr, periodNormExpr,
    EFFECTIVE_TOPIC_SQL, EFFECTIVE_SENTIMENT_SQL,
    NO_FEEDBACK_LABEL, NO_AI_RESULT_TOPIC_SQL, HAS_AI_ANALYSIS_SQL,
    REPORT_TOPIC_SQL, REPORT_SENTIMENT_SQL, HAS_REAL_COMMENT_SQL,
    sentimentTone,
    topicBadgeClassFor,
} = require('./views/layout/report_computation/report_formula');

// In production nginx sits in front of this process and forwards to
// 127.0.0.1 (see deploy/nginx-cqa.conf). Without this, Express reports that
// loopback address as req.ip for EVERY visitor — so the per-IP login throttle
// was not per-IP at all, it was one shared bucket for the whole institution,
// and the college's eleventh sign-in of any ten-minute window was refused no
// matter whose it was or whether the password was right.
//
// 'loopback' rather than `true`: it trusts the X-Forwarded-For header only
// when the connection itself came from 127.0.0.1/::1, which is exactly the
// nginx-on-the-same-host shape. Trusting every proxy would let anyone on the
// internet set that header themselves and hand themselves a fresh rate-limit
// bucket per request, which is worse than having no limiter at all.
// TRUST_PROXY overrides it for a different topology (a CDN in front, say).
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Exposes the current request path to every EJS view so layout partials
// (e.g. the sidebar) can highlight/expand based on where the admin is.
app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
});

// Exposes the landing page's hero background photo to EVERY view, so every
// page that paints a photo backdrop (login, client-login,
// forgot/reset-password, complete-google-registration, client-survey) shows
// the same image as index.ejs instead of each one hardcoding
// '/images/campus-monument.jpg'. Admins can change the hero image from the
// landing-content editor, and before this the landing page was the only page
// that followed the change — the rest kept rendering the old default photo.
app.use((req, res, next) => {
    try {
        res.locals.heroImageUrl = loadLandingContent().hero.imageUrl;
    } catch (err) {
        res.locals.heroImageUrl = DEFAULT_LANDING_CONTENT.hero.imageUrl;
    }
    next();
});

// ==========================================
// SESSION & PASSPORT (Google OAuth for clients)
// ==========================================
// Admin logins and client logins need to be on separate cookies ('admin.sid' /
// 'client.sid') instead of sharing one — a browser's cookie jar is shared
// across every tab (not scoped per-tab), so with a single shared cookie,
// logging in as an admin in one tab and as a client in another tab of the
// SAME browser stomped on each other: whichever login happened most recently
// (admin login also calls session.regenerate(), which swaps in a brand-new
// cookie value) would silently overwrite the cookie the other tab still had
// open, so refreshing that other tab suddenly picked up the newer login's
// identity instead of its own.
//
// This CANNOT be done by mounting two express-session instances, even with
// different cookie names/stores: express-session has a hard-coded
// "self-awareness" guard (`if (req.session) { next(); return }`) that makes
// the SECOND instance a complete no-op the moment it sees req.session already
// set by the first — verified by an isolated repro. So the client session
// stays on a normal, single express-session instance (req.session /
// req.sessionID, exactly as passport expects — its req.login/req.logout/
// req.isAuthenticated read those properties directly). The admin session is a
// small hand-rolled cookie+store implementation below (req.adminSession /
// req.adminSessionID) that doesn't go through express-session at all, so
// there's no guard for it to trip.
app.use(session({
    name: 'client.sid',
    store: new session.MemoryStore(),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
        // secure:true means the browser will never send this cookie over
        // plain HTTP — only turn it on once the app is actually served over
        // HTTPS (NODE_ENV=production is this project's existing convention
        // for that), otherwise local http://localhost dev would silently
        // never receive the session cookie at all.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

const ADMIN_COOKIE_NAME = 'admin.sid';
// Office logins get their OWN cookie, for exactly the same reason admin and
// client got separate cookies above: an admin tab and an office tab open at
// once in the same browser used to both ride on 'admin.sid'. Logging into
// the office panel in one tab called regenerateAdminSession(), which swapped
// the browser's 'admin.sid' cookie to the office login's new value — so the
// still-open admin tab silently started sending the OFFICE session's cookie
// on its next request, failed the `user.type === 'admin'` check, and bounced
// to a false "Session Expired" even though nothing about the admin session
// itself had actually expired. Same fix as admin/client: separate cookie,
// separate req.officeSession/req.officeSessionID, so the two can coexist.
const OFFICE_COOKIE_NAME = 'office.sid';
const ADMIN_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 hours
// Shared by both cookies above — session ids are independent random tokens
// (newAdminSessionId), so one map can hold admin and office sessions side by
// side without them ever colliding.
const adminSessions = new Map(); // sessionId -> { data: {}, expiresAt: number }

function newAdminSessionId() {
    return crypto.randomBytes(24).toString('base64url');
}

function readSessionIdFromCookie(req, cookieName) {
    const cookies = cookieLib.parse(req.headers.cookie || '');
    const raw = cookies[cookieName];
    if (!raw || raw.slice(0, 2) !== 's:') return null;
    const id = cookieSignature.unsign(raw.slice(2), process.env.SESSION_SECRET);
    return id || null; // unsign() returns false on a missing/tampered signature
}
function readAdminSessionIdFromCookie(req) { return readSessionIdFromCookie(req, ADMIN_COOKIE_NAME); }
function readOfficeSessionIdFromCookie(req) { return readSessionIdFromCookie(req, OFFICE_COOKIE_NAME); }

function writeSessionCookie(res, cookieName, id) {
    res.cookie(cookieName, 's:' + cookieSignature.sign(id, process.env.SESSION_SECRET), {
        httpOnly: true,
        maxAge: ADMIN_SESSION_MAX_AGE_MS,
        path: '/',
        // Same reasoning as the client session cookie above: only require
        // HTTPS-only transport once actually deployed behind HTTPS.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
}
function writeAdminSessionCookie(res, id) { writeSessionCookie(res, ADMIN_COOKIE_NAME, id); }
function writeOfficeSessionCookie(res, id) { writeSessionCookie(res, OFFICE_COOKIE_NAME, id); }

// Regenerates the admin session (new id, blank data) — used at login to
// prevent session fixation, mirroring express-session's Session#regenerate().
// Doesn't touch the store/cookie directly: the request's onHeaders hook
// (below) persists whatever ends up in req.adminSession once the route
// handler is done with it (login always populates req.adminSession.user
// right after calling this, so it's never mistaken for "still anonymous").
function regenerateAdminSession(req, res) {
    if (req.adminSessionID) adminSessions.delete(req.adminSessionID);
    req.adminSessionID = newAdminSessionId();
    req.adminSession = {};
    req._adminSessionHadExisting = false;
}

// Same as regenerateAdminSession, but for the separate office-session id/cookie.
function regenerateOfficeSession(req, res) {
    if (req.officeSessionID) adminSessions.delete(req.officeSessionID);
    req.officeSessionID = newAdminSessionId();
    req.officeSession = {};
    req._officeSessionHadExisting = false;
}

// Destroys an admin session by id — used to force-invalidate another
// tab/device's still-open session (see the "one active session per admin
// account" enforcement in /auth-login below). The caller doesn't have to be
// the request that owns that session.
function destroyAdminSessionById(id) {
    if (id) adminSessions.delete(id);
}

// Marks a session id as deliberately replaced by a REAL newer login (never
// inferred merely from a session being gone) — this is what lets
// ensureAdminAuth tell a genuine "signed in from another device/tab" event
// apart from an ordinary session timeout / store-restart, which otherwise
// look IDENTICAL from the store's point of view (in both cases the old
// session id simply resolves to nothing).
//
// Implemented as a TOMBSTONE in the SAME adminSessions map the real session
// lived in — replacing its data with `{ replaced: true }` rather than
// deleting the entry outright — so the evidence survives for exactly as
// long as that session could have plausibly still been presented (its own
// original expiresAt), not an arbitrary short window. An earlier version
// used a separate 60s-TTL side table: too short — an admin who steps away
// from a genuinely-replaced session for more than a minute would have come
// back to a false "session expired" instead of the true "signed in
// elsewhere", since the evidence had already timed out while the session
// itself (rolling 8h expiry) was still very much a plausible return target.
// Consumed (deleted) the first time it's actually read, in the cookie-
// parsing middleware below — so a dead session explains itself as
// "replaced" exactly once.
function markAdminSessionReplaced(id) {
    if (!id) return;
    const existing = adminSessions.get(id);
    const expiresAt = (existing && existing.expiresAt) || (Date.now() + ADMIN_SESSION_MAX_AGE_MS);
    adminSessions.set(id, { replaced: true, expiresAt });
}

// Destroys THIS request's admin session and clears its cookie (stale-token
// kick-out in ensureAdminAuth, and /logout). Flags the request so the
// onHeaders hook below doesn't resurrect the cookie it just cleared.
function destroyAdminSession(req, res) {
    destroyAdminSessionById(req.adminSessionID);
    res.clearCookie(ADMIN_COOKIE_NAME, { path: '/' });
    req.adminSession = {};
    req.adminSessionID = null;
    req._adminSessionDestroyed = true;
}

// Same as destroyAdminSession, but for the separate office-session id/cookie
// (used by /office-logout).
function destroyOfficeSession(req, res) {
    destroyAdminSessionById(req.officeSessionID);
    res.clearCookie(OFFICE_COOKIE_NAME, { path: '/' });
    req.officeSession = {};
    req.officeSessionID = null;
    req._officeSessionDestroyed = true;
}

// Loads req.adminSession/req.adminSessionID from the 'admin.sid' cookie (if
// any) on every request, but only actually WRITES a store entry / Set-Cookie
// at response time, and only if this request either already had a valid
// admin session (refreshing its rolling expiry) or populated req.adminSession
// with something (e.g. an admin login). Every other request — every
// anonymous visitor to a public/client page who never touches anything
// admin-related — gets neither a store entry nor an 'admin.sid' cookie at
// all, matching express-session's saveUninitializedSession:false behavior
// (this middleware can't rely on express-session itself for that, since it
// deliberately avoids ever calling into a second express-session instance —
// see the big comment above).
app.use((req, res, next) => {
    const existingId = readAdminSessionIdFromCookie(req);
    let existingEntry = existingId && adminSessions.get(existingId);
    if (existingEntry && existingEntry.expiresAt <= Date.now()) {
        adminSessions.delete(existingId);
        existingEntry = null;
    }

    // Read BEFORE req.adminSessionID is possibly replaced below — see
    // ensureAdminAuth's "session missing" branch for how this is used to
    // choose an accurate alert (session_replaced vs session_expired vs
    // login_required) instead of guessing "another device" from the mere
    // absence of a session. A tombstone (see markAdminSessionReplaced) is
    // real evidence of a newer login, valid for as long as the session
    // itself would have been — never an arbitrary short window — and is
    // consumed (deleted) the moment it's actually observed here, so this
    // exact session id only ever explains itself as "replaced" once.
    let missingReason = null;
    if (existingEntry && existingEntry.replaced) {
        adminSessions.delete(existingId);
        missingReason = 'replaced';
        existingEntry = null;
    } else if (existingId && !existingEntry) {
        missingReason = 'expired';
    }
    req._adminSessionMissingReason = missingReason;

    req.adminSessionID = existingEntry ? existingId : newAdminSessionId();
    req.adminSession = existingEntry ? existingEntry.data : {};
    req._adminSessionHadExisting = !!existingEntry;
    req._adminSessionDestroyed = false;

    onHeaders(res, () => {
        if (req._adminSessionDestroyed) return;
        const isModified = Object.keys(req.adminSession || {}).length > 0;
        if (!req._adminSessionHadExisting && !isModified) return; // still anonymous — nothing to persist
        adminSessions.set(req.adminSessionID, { data: req.adminSession, expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_MS });
        writeAdminSessionCookie(res, req.adminSessionID);
    });

    next();
});

// Same as the 'admin.sid' middleware above, but for the separate 'office.sid'
// cookie — see the OFFICE_COOKIE_NAME comment for why office logins need
// their own cookie instead of sharing 'admin.sid'. Office sessions don't use
// the "replaced" tombstone (offices have no single-active-session
// enforcement, unlike admin accounts — see /auth-login), so there's no
// missingReason tracking to mirror here.
app.use((req, res, next) => {
    const existingId = readOfficeSessionIdFromCookie(req);
    let existingEntry = existingId && adminSessions.get(existingId);
    if (existingEntry && (existingEntry.expiresAt <= Date.now() || existingEntry.replaced)) {
        adminSessions.delete(existingId);
        existingEntry = null;
    }

    req.officeSessionID = existingEntry ? existingId : newAdminSessionId();
    req.officeSession = existingEntry ? existingEntry.data : {};
    req._officeSessionHadExisting = !!existingEntry;
    req._officeSessionDestroyed = false;

    onHeaders(res, () => {
        if (req._officeSessionDestroyed) return;
        const isModified = Object.keys(req.officeSession || {}).length > 0;
        if (!req._officeSessionHadExisting && !isModified) return; // still anonymous — nothing to persist
        adminSessions.set(req.officeSessionID, { data: req.officeSession, expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_MS });
        writeOfficeSessionCookie(res, req.officeSessionID);
    });

    next();
});

// Used by both the periodic sweep and the "Active Now" render check
// (admin_logs) to tell whether a given admin session id is still live.
function isSessionAlive(sessionId) {
    if (!sessionId) return false;
    const entry = adminSessions.get(sessionId);
    // A tombstoned entry (see markAdminSessionReplaced) intentionally keeps
    // its original expiresAt so the "replaced" evidence survives as long as
    // the real session would have — but it is no longer a usable session,
    // so it must not count as "Active Now" here.
    return !!(entry && !entry.replaced && entry.expiresAt > Date.now());
}

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Feeds the "Admin Logs" modal (layout/navbar.ejs) on every admin page with the
// most recent login sessions, each carrying a live duration for the row that's
// still active (logout_time NULL). Only queried for actual admin sessions so
// public/client pages don't pay for it. Must run AFTER the session middleware
// above — req.session doesn't exist yet before that.
app.use((req, res, next) => {
    res.locals.adminLogs = [];
    res.locals.currentAdmin = (req.adminSession && req.adminSession.admin) || null;
    if (!(req.adminSession && req.adminSession.user && req.adminSession.user.type === 'admin')) {
        return next();
    }

    db.query(`
        SELECT
            id, username, session_id, login_time, logout_time,
            DATE_FORMAT(login_time, '%b %d, %Y') AS login_date,
            DATE_FORMAT(login_time, '%h:%i %p') AS login_time_fmt,
            DATE_FORMAT(logout_time, '%h:%i %p') AS logout_time_fmt,
            TIMESTAMPDIFF(SECOND, login_time, IFNULL(logout_time, NOW())) AS duration_seconds
        FROM admin_logs
        ORDER BY login_time DESC
        LIMIT 20
    `, async (err, rows) => {
        if (err) {
            console.error('❌ Error loading admin logs:', err);
            return next();
        }

        // A row with logout_time IS NULL only counts as "Active Now" if its session_id
        // still resolves to a live entry in the session store — this is what lets several
        // logins for the same admin account (different tabs/devices) each show their own
        // accurate status instead of all going stale together or staying "active" forever
        // after an abandoned browser tab's cookie silently expires.
        res.locals.adminLogs = await Promise.all((rows || []).map(async r => {
            const totalSeconds = r.duration_seconds || 0;
            const hrs = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const isActive = !r.logout_time && await isSessionAlive(r.session_id);

            return {
                username: r.username,
                login_date: r.login_date,
                login_time_fmt: r.login_time_fmt,
                logout_time_fmt: r.logout_time_fmt,
                duration_text: hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`,
                isActive,
                login_time_iso: r.login_time.toISOString()
            };
        }));
        next();
    });
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
}, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    if (!email) return done(null, false);
    const photo = profile.photos && profile.photos[0] ? profile.photos[0].value : null;
    return done(null, { email, name: profile.displayName, photo });
}));

// Resolves the signed-in client's email from either Google OAuth (passport) or the
// unified email/password login form (req.session.clientEmail) — the two ways a
// registered client can end up authenticated.
// @cspc.edu.ph and @my.cspc.edu.ph accounts are institutional — trusted
// automatically. Any other (personal) email must be verified by the office
// the client claims to have visited before it counts as a real submission —
// see /submit-survey.
function isCspcEmail(email) {
    if (typeof email !== 'string') return false;
    const normalized = email.toLowerCase().trim();
    return normalized.endsWith('@cspc.edu.ph') || normalized.endsWith('@my.cspc.edu.ph');
}

// Whether enough time has passed since `lastEventAt` (the most recent APPROVED
// submission for a given office+service+account) for that account to submit
// again, based on the service's configured cadence (services.availability),
// which is one of daily/weekly/monthly/yearly (column is NOT NULL, default 'daily').
function isEligibleForResubmission(lastEventAt, availability) {
    if (!lastEventAt) return true;
    const diffDays = (Date.now() - new Date(lastEventAt).getTime()) / 86400000;
    switch (availability) {
        case 'daily':   return diffDays >= 1;
        case 'weekly':  return diffDays >= 7;
        case 'monthly': return diffDays >= 30;
        case 'yearly':  return diffDays >= 365;
        default:        return false;
    }
}

// Epoch ms this account becomes eligible again for a cadence-based service,
// or null for a one-time-only (or unset) service, which is never eligible
// again. Shared math behind nextEligibleDateText (server-rendered message)
// and the client-side live countdown (see /client-survey's blockedUntil).
function nextEligibleTimestamp(lastEventAt, availability) {
    const stepDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 }[availability];
    if (!stepDays || !lastEventAt) return null;
    return new Date(lastEventAt).getTime() + stepDays * 86400000;
}

// Human-readable date the client becomes eligible again, or null for a
// one-time-only (or unset) service, which is never eligible again.
function nextEligibleDateText(lastEventAt, availability) {
    const ts = nextEligibleTimestamp(lastEventAt, availability);
    if (!ts) return null;
    return new Date(ts).toLocaleDateString('en-PH', { dateStyle: 'long', timeZone: DISPLAY_TIME_ZONE });
}

// The non-atomic SELECT-then-INSERT eligibility gate that used to live here
// (checkResubmissionEligibility/checkResubmissionEligibilityAsync) has been
// replaced by resolveSubmissionPrecedence, which runs the identical pending/
// cadence logic but INSIDE the per-logical-key GET_LOCK (see
// withLogicalSurveyLock below) and additionally makes the Online-vs-Offline
// precedence decision — removed here so there is no second, lock-free
// eligibility path a future change could accidentally call instead.

// Looks up a survey_responses row by its client-generated submission id
// (see finalizeVerifiedSurvey's clientSubmissionId param and the
// unique_client_submission_id migration). Used to short-circuit BOTH the
// resubmission-eligibility check and the insert itself for an idempotent
// replay — resolves null (not an error) when nothing matches or no id was
// given, which every caller treats as "proceed normally."
function findSurveyByClientSubmissionId(clientSubmissionId) {
    if (!clientSubmissionId) return Promise.resolve(null);
    return dbQuery('SELECT id FROM survey_responses WHERE client_submission_id = ? LIMIT 1', [clientSubmissionId])
        .then(rows => (rows && rows.length) ? rows[0] : null)
        .catch(err => {
            console.error("❌ [Idempotency] Lookup by client_submission_id failed:", err);
            return null; // fail open to the normal flow rather than blocking a legitimate submission
        });
}

// Inserted survey rows previously went through a standalone
// finalizeVerifiedSurvey()/finalizeVerifiedSurveyAsync() pair (plain pooled
// db.query, no precedence awareness) — removed. Every canonical insert now
// goes through submitCanonicalSurvey() below, which wraps this same core
// insert logic (survey_responses + client_profiles + client_accounts
// upsert) with the Online-vs-Offline precedence lock, so there is no
// second, unguarded path back into survey_responses that could bypass it.

// Core survey_responses + client_profiles + client_accounts insert, shared
// by every canonical-insert path (online, offline sync, office approval) —
// the writes that must commit/rollback atomically together with a caller's
// other transactional writes (offline_survey_submissions tracking rows, the
// pending_survey_submissions status flip on office approval). Runs every
// transactional writes (offline_survey_submissions tracking rows, the
// pending_survey_submissions status flip on office approval). Runs every
// query on the SAME dedicated pooled connection the caller passes in
// (never the shared `db`/`dbQuery`), so it participates correctly in that
// connection's transaction. Deliberately does NOT send a receipt email or
// run AI analysis — both are slow/non-DB operations that must happen after
// commit, outside the transaction; callers handle them themselves.
//
// `submissionSource` ('online' | 'offline_sync') is ALWAYS supplied by the
// caller from the route/workflow itself (see submitCanonicalSurvey below),
// never read from client JSON — this is what lets
// resolveSubmissionPrecedence trust it later. The `|| 'legacy_unknown'`
// fallback below should never actually fire (every real caller passes one
// explicitly) — it exists only so a future caller that forgets the
// parameter fails toward "unknown, dominable by Online" rather than
// silently toward "online" (the same reasoning as submission_source's
// ALTER TABLE default — see there). Every row this function writes starts
// life as canonical_status='canonical' (the column default); a caller that
// just superseded an older canonical row does that as a separate UPDATE in
// the same transaction (see submitCanonicalSurvey).
// Bulk-inserts a comment's EXTRA topics (everything beyond the primary,
// which lives on survey_responses.topic itself — see
// createSurveyResponseTopicsTableQuery's comment) on an existing transactional
// connection. No-op for an empty/undefined list. sort_order preserves the
// array order Gemini/the lexicon returned, so display always matches how the
// classifier itself ranked them.
async function insertExtraTopicsOnConnection(conn, surveyResponseId, extraTopics) {
    if (!extraTopics || !extraTopics.length) return;
    const values = [];
    const placeholders = extraTopics.map((topic, i) => {
        values.push(surveyResponseId, topic, i);
        return '(?, ?, ?)';
    }).join(', ');
    await conn.query(
        `INSERT INTO survey_response_topics (survey_response_id, topic, sort_order) VALUES ${placeholders}`,
        values
    );
}

// Same as above, but on the shared pooled `db` (callback-style, not a
// transactional connection) — used by the fire-and-forget async
// classification callbacks (see /submit-survey and
// /office-approvals/:id/approve), which run well after their own insert's
// transaction already committed.
function insertExtraTopics(surveyResponseId, extraTopics) {
    if (!extraTopics || !extraTopics.length) return;
    const values = [];
    const placeholders = extraTopics.map((topic, i) => {
        values.push(surveyResponseId, topic, i);
        return '(?, ?, ?)';
    }).join(', ');
    db.query(
        `INSERT INTO survey_response_topics (survey_response_id, topic, sort_order) VALUES ${placeholders}`,
        values,
        (err) => { if (err) console.error('❌ Error inserting extra topics:', err); }
    );
}

async function insertVerifiedSurveyOnConnection(conn, googleEmail, fields, submissionSource) {
    const {
        officeId, respondentName, topics, sentiment, region, cc1, cc2, cc3,
        sqdValues, comments, serviceAvailed, clientType, age, gender, officeVisitedTime, period,
        clientSubmissionId, submittedAt, analysisPending
    } = fields;

    // Same reasoning as finalizeVerifiedSurvey above — a no-feedback comment
    // gets NULL, never the placeholder default, since nothing ever corrects
    // it afterward for a comment that has no real content to (re-)analyze.
    const noFeedback = isNoFeedbackComment(comments);
    // `topics` is a list (multi-topic tagging project, 2026-09-25) — only
    // the FIRST/primary one is stored on this row itself; any extras are
    // inserted into survey_response_topics below once the id is known. A
    // caller whose analysis hasn't run yet (analysisPending — see below)
    // passes no topics at all here, same as before.
    const topicsList = Array.isArray(topics) ? topics.filter(Boolean) : (topics ? [topics] : []);
    const finalTopic = noFeedback ? null : (topicsList[0] || 'General Feedback');
    const finalSentiment = noFeedback ? null : (sentiment || 'Neutral');
    // `analysisPending` is set by a caller that hasn't run AI analysis yet
    // and will fire it asynchronously AFTER this insert (see /submit-survey
    // and /office-approvals/:id/approve) — those rows start 'pending' so
    // they're excluded from every admin-facing display until the later
    // UPDATE flips them to 'completed' (see HAS_AI_ANALYSIS_SQL). A
    // no-feedback comment is always 'completed' immediately regardless —
    // there is no analysis coming for it, ever. Every other caller
    // (offline sync, offline verify-and-sync) already awaited analysis
    // BEFORE calling this function, so its rows are 'completed' from the
    // start too.
    const finalAnalysisStatus = (!noFeedback && analysisPending) ? 'pending' : 'completed';
    // `submittedAt` is WHEN THE CLIENT SUBMITTED, supplied only by a caller
    // that is replaying an already-submitted survey — today that is the office
    // approval route, which passes the pending row's own server-stamped
    // created_at. Without it, created_at defaulted to the moment of the
    // INSERT, so approving a survey silently re-dated it to the approval:
    // the office's Pending list showed one time, the admin's records showed
    // another, and the client's receipt agreed with neither. COALESCE keeps
    // the ordinary live-submission path (which passes nothing) on
    // CURRENT_TIMESTAMP exactly as before.
    //
    // This is the survey's time everywhere it is displayed. It is NOT what
    // orders the admin's notification bell — that reads recorded_at below,
    // which is always the moment the row was actually written, so a survey
    // approved days after it was submitted still announces itself as newly
    // arrived instead of landing silently in the past.
    const [insertResult] = await conn.query(
        `INSERT INTO survey_responses
         (office_id, respondent_name, topic, sentiment, region, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, period_year_quarter, google_email, service_availed, client_submission_id, submission_source, analysis_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [
            officeId, respondentName, finalTopic, finalSentiment, region,
            cc1, cc2, cc3,
            sqdValues[0], sqdValues[1], sqdValues[2], sqdValues[3], sqdValues[4], sqdValues[5], sqdValues[6], sqdValues[7], sqdValues[8],
            comments || 'N/A', period, googleEmail, serviceAvailed, clientSubmissionId || null, submissionSource || 'legacy_unknown',
            finalAnalysisStatus,
            submittedAt || null
        ]
    );
    const surveyResponseId = insertResult.insertId;

    // Any topics beyond the primary — only ever populated here for a caller
    // that already has the full list at insert time (offline sync paths,
    // which await analysis before calling this function); the live/approval
    // paths pass no topics yet and add extras later via insertExtraTopics
    // once their own async analysis resolves.
    if (!noFeedback) {
        await insertExtraTopicsOnConnection(conn, surveyResponseId, topicsList.slice(1));
    }

    // Same timestamp as its survey_responses row, for the same reason — the
    // two are one submission and must never disagree about when it happened.
    await conn.query(
        `INSERT INTO client_profiles (survey_response_id, respondent_name, client_type, age, gender, region, email, office_visited_time, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [surveyResponseId, respondentName, clientType, age, gender, region, googleEmail, officeVisitedTime, submittedAt || null]
    );

    // Same reasoning as finalizeVerifiedSurvey's identical upsert above:
    // respondent_name is never referenced here at all — a survey submission
    // (verified/approved through this transactional path too) must not
    // create, seed, or repair the account's real Profile name. region/age/
    // gender remain COALESCE'd (write-once-if-still-NULL) by the same
    // demographic-lock design documented on client_accounts' table comment.
    await conn.query(
        `INSERT INTO client_accounts (email, region, age, gender)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            region = COALESCE(region, VALUES(region)),
            age = COALESCE(age, VALUES(age)),
            gender = COALESCE(gender, VALUES(gender))`,
        [googleEmail, region, age, gender]
    );

    return surveyResponseId;
}

// =========================================================================
// ONLINE-VS-OFFLINE CANONICAL PRECEDENCE
// =========================================================================
// Business rule: for the same logical survey opportunity (one authenticated
// Client account, one office, one service — the exact identity
// checkResubmissionEligibility already used to decide "is this too soon"),
// a successfully-committed ONLINE submission is ALWAYS the authoritative
// one. An Offline submission can create a canonical row when nothing else
// exists yet, but it can never defeat, duplicate, or outlive a canonical
// Online row — and if Offline happens to reach the server FIRST, a later
// Online submission for the same key must supersede it, not merely
// coexist. Arrival order never decides Online-vs-Offline; only the source
// does.
//
// This is enforced with a MySQL named lock (GET_LOCK), not a permanent
// UNIQUE constraint — resubmission eligibility is a moving time window
// (services.availability: daily/weekly/monthly/yearly), so "office +
// account + service" is NOT a permanently-unique identity the way
// client_submission_id is; a client legitimately submits again once the
// cooldown elapses. GET_LOCK serializes the "read current canonical state,
// decide, write" critical section for one logical key across ALL THREE
// insert entry points (/submit-survey, /sync-surveys, verify-and-sync,
// and office-approval), closing the TOCTOU race that let an Online and an
// Offline submission both pass their own independent eligibility check
// before either had committed.
const LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS = 8;

function logicalSurveyLockName(officeId, googleEmail, serviceAvailed) {
    const raw = `${officeId}|${String(googleEmail || '').toLowerCase()}|${serviceAvailed || ''}`;
    // MySQL named-lock names are capped at 64 chars; a fixed-length hash
    // keeps this well under that regardless of email/service length.
    return 'cspc_survey_' + crypto.createHash('sha1').update(raw).digest('hex');
}

// Runs `work(conn)` while holding a session-scoped named lock for one
// logical survey key, on a SINGLE dedicated pooled connection (the same
// connection both holds the lock and does the work) — deliberately not two
// separate connections, since under a 500-submission burst this pool is
// small (see DB_CONNECTION_LIMIT) and a design needing 2 connections per
// request would halve effective throughput and risk pool exhaustion/
// deadlock (every request holding its 1st connection while waiting for a
// 2nd that never frees). If the lock can't be acquired within
// LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS, throws an Error with
// `.code === 'LOCK_TIMEOUT'` — callers should treat this as transient/
// retryable (503), never as a data error.
async function withLogicalSurveyLock(officeId, googleEmail, serviceAvailed, work) {
    const lockName = logicalSurveyLockName(officeId, googleEmail, serviceAvailed);
    const conn = await db.promise().getConnection();
    try {
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // GET_LOCK returns exactly 1 (acquired), 0 (timed out — someone else
        // holds it), or NULL (a real error, e.g. the session was killed or
        // MySQL ran out of memory for the lock structure) — never anything
        // else. Only 1 may proceed into the critical section; both 0 and
        // NULL are treated as the SAME safe, retriable outcome (never a
        // silent "proceed anyway"), but logged distinctly so a NULL
        // (genuine DB-side problem) doesn't get mistaken for ordinary lock
        // contention if it starts happening often.
        const rawLockResult = (lockRows && lockRows[0]) ? lockRows[0].acquired : undefined;
        const acquired = rawLockResult === 1 || rawLockResult === '1';
        if (!acquired) {
            if (rawLockResult === null) {
                console.error(`❌ [Survey Lock] GET_LOCK('${lockName}') returned NULL (DB-side error, not ordinary contention).`);
            }
            const timeoutErr = new Error('Timed out waiting to process this submission — please try again.');
            timeoutErr.code = 'LOCK_TIMEOUT';
            timeoutErr.lockResult = rawLockResult;
            throw timeoutErr;
        }
        try {
            return await work(conn);
        } finally {
            // Best-effort release — if this fails, the lock still dies with
            // the connection (RELEASE_LOCK/GET_LOCK are session-scoped), so
            // a stuck lock can't outlive conn.release() below regardless.
            await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch((releaseErr) => {
                console.error('❌ [Survey Lock] RELEASE_LOCK failed (harmless — dies with the connection):', releaseErr);
            });
        }
    } finally {
        conn.release();
    }
}

// Must run on the connection currently holding the logical-survey lock
// (see withLogicalSurveyLock), BEFORE any insert. Mirrors
// checkResubmissionEligibility's identity/cadence logic exactly (same
// service-availability lookup, same pending-submission check, same
// last-response cadence window) but adds source-awareness on top:
//   - A PENDING row for the SAME key blocks the incoming submission unless
//     the incoming is 'online' and the pending row's source is NOT 'online'
//     (i.e. 'offline_sync', or the historical-migration 'legacy_unknown' —
//     see submission_source's ALTER TABLE comment) — an Online submission
//     may proceed past a merely-pending (not yet approved) non-Online one;
//     that pending row is left untouched here and resolved at approval
//     time instead (see /office-approvals/:id/approve), so it can never
//     become a second canonical row once an Online one exists.
//   - A CANONICAL survey_responses row for the SAME key:
//       * cooldown ALREADY elapsed (per the service's cadence) → the old
//         row belongs to a completed, separate survey opportunity — this
//         is a legitimately NEW one, unconditionally, regardless of
//         source. Inserted as its own new canonical row; the old row is
//         left exactly as it is (still canonical, still counted — it was
//         never in conflict with this submission to begin with). Online
//         dominance is scoped to "the SAME logical survey opportunity /
//         active cadence window" — it must never reach back and supersede
//         an old, already-settled Offline row from a prior, expired cycle
//         (e.g. a monthly service's August Offline response must not be
//         superseded by a September Online one; September is a new
//         opportunity, not a conflict with August).
//       * cooldown STILL ACTIVE (same opportunity as `last`):
//           - incoming='online' and existing.source is NOT 'online' → the
//             non-Online row is superseded (Online dominance within the
//             SAME opportunity is not first-arrival-based; treating
//             'legacy_unknown' the same as 'offline_sync' here is the safe
//             direction either way a historical row's real origin turns
//             out to be — see submission_source's ALTER TABLE comment).
//           - any other combination → normal cadence rejection (matches
//             the pre-existing single-channel behavior exactly; a
//             non-Online incoming submission never preempts a canonical
//             Online row, and same-source duplicates within the cooldown
//             are still rejected as before).
// `options.ignorePending` skips the "already has one awaiting review" gate
// below. It exists for exactly one caller: the office-approval route, which
// is REVIEWING a queued row rather than adding a new one. There, other
// still-pending rows for the same office/account/service are siblings in
// the very queue the office is working through — not a conflict — and
// letting them match here made Approve resolve to 'reject_pending' and
// decline the submission instead of approving it. Every "is a new
// submission allowed?" caller leaves this off and keeps the gate.
async function resolveSubmissionPrecedence(conn, officeId, googleEmail, serviceAvailed, incomingSource, options = {}) {
    const [svcRows] = await conn.query(
        'SELECT availability FROM services WHERE office_id = ? AND service_name <=> ? LIMIT 1',
        [officeId, serviceAvailed]
    );
    const availability = (svcRows && svcRows[0]) ? svcRows[0].availability : null;

    const [pendRows] = options.ignorePending ? [[]] : await conn.query(
        "SELECT id, submission_source FROM pending_survey_submissions WHERE office_id = ? AND google_email = ? AND service_availed <=> ? AND status = 'pending' LIMIT 1",
        [officeId, googleEmail, serviceAvailed]
    );
    if (pendRows && pendRows.length > 0) {
        // Treat anything that isn't KNOWN to be 'online' (i.e. 'offline_sync'
        // or the historical-migration 'legacy_unknown' — see the
        // submission_source ALTER TABLE comment) as dominable by an
        // incoming Online submission. Falling back to 'online' here would
        // be the unsafe direction (it would make an unknown-origin row
        // immune to Online dominance); falling back to 'offline_sync'/
        // treating unknown as non-online is the safe direction in both
        // possible-truths cases (see that same comment).
        const pendingSource = pendRows[0].submission_source || 'legacy_unknown';
        const onlineOverridesPendingNonOnline = (incomingSource === 'online' && pendingSource !== 'online');
        if (!onlineOverridesPendingNonOnline) {
            return { decision: 'reject_pending', message: "You already have a submission for this service awaiting the office's review." };
        }
        // Fall through — incoming Online is allowed to proceed past a
        // merely-pending non-Online submission.
    }

    const [lastRows] = await conn.query(
        `SELECT id, created_at, submission_source FROM survey_responses
         WHERE office_id = ? AND google_email = ? AND service_availed <=> ? AND canonical_status = 'canonical'
         ORDER BY created_at DESC LIMIT 1`,
        [officeId, googleEmail, serviceAvailed]
    );
    const last = (lastRows && lastRows[0]) || null;
    if (!last) return { decision: 'insert_canonical' };

    // Cooldown check FIRST, before any source comparison — an incoming
    // submission only conflicts with `last` at all if they belong to the
    // SAME active cadence opportunity. Once the cooldown has elapsed, `last`
    // is a settled, separate opportunity: this is a fresh submission, full
    // stop, regardless of either row's source. Online dominance (below)
    // must never fire against an already-expired Offline row — that would
    // incorrectly reach back and erase a completed prior period's response.
    if (isEligibleForResubmission(last.created_at, availability)) {
        return { decision: 'insert_canonical' };
    }

    // Same "anything not KNOWN online is dominable" rule as the pending
    // check above — covers both 'offline_sync' and a historical
    // 'legacy_unknown' row equally.
    if (incomingSource === 'online' && last.submission_source !== 'online') {
        return { decision: 'insert_canonical', supersede: last.id };
    }

    const nextDate = nextEligibleDateText(last.created_at, availability);
    const message = nextDate
        ? `You can retake this survey for this service starting ${nextDate}.`
        : "You have already evaluated this service. You cannot submit again.";
    const nextTs = nextEligibleTimestamp(last.created_at, availability);
    return { decision: 'reject', message, nextEligibleAt: nextTs ? new Date(nextTs).toISOString() : null };
}

// Shared by both precedence-aware funnels below — throws the right typed
// Error for a 'reject'/'reject_pending' decision, no-ops for anything else.
function throwIfSubmissionRejected(precedence) {
    if (precedence.decision === 'reject_pending') {
        const err = new Error(precedence.message);
        err.code = 'PENDING_REJECTED';
        err.rejectMessage = precedence.message;
        throw err;
    }
    if (precedence.decision === 'reject') {
        const err = new Error(precedence.message);
        err.code = 'ELIGIBILITY_REJECTED';
        err.rejectMessage = precedence.message;
        err.nextEligibleAt = precedence.nextEligibleAt;
        throw err;
    }
}

// Single funnel for every CSPC-trusted (auto-approved) survey insert —
// /submit-survey, /sync-surveys, and both the offline-verify and
// office-approval paths that previously called insertVerifiedSurveyOnConnection
// directly. Runs the whole "acquire lock -> resolve precedence -> insert
// (+ supersede the losing row if applicable) -> release lock" sequence
// atomically. Does NOT send email or run AI analysis — callers do that
// themselves, after this resolves, outside the lock (see the module
// comment on withLogicalSurveyLock for why: keep locked/transactional
// sections short, never call slow external services while holding one).
//
// `submissionSource` must be supplied by the CALLER based on the route it
// came from (never trusted from client JSON — see module rule #13).
// Resolves to { surveyResponseId, supersededId } on success. Rejects with
// an Error whose `.code` is one of 'ELIGIBILITY_REJECTED' (cadence cooldown
// active, `.rejectMessage`/`.nextEligibleAt`), 'PENDING_REJECTED'
// (`.rejectMessage`), or 'LOCK_TIMEOUT'.
async function submitCanonicalSurvey(googleEmail, fields, submissionSource) {
    return withLogicalSurveyLock(fields.officeId, googleEmail, fields.serviceAvailed, async (conn) => {
        const precedence = await resolveSubmissionPrecedence(conn, fields.officeId, googleEmail, fields.serviceAvailed, submissionSource);
        throwIfSubmissionRejected(precedence);

        await conn.beginTransaction();
        try {
            const surveyResponseId = await insertVerifiedSurveyOnConnection(conn, googleEmail, fields, submissionSource);

            if (precedence.supersede) {
                await conn.query(
                    "UPDATE survey_responses SET canonical_status = 'superseded', superseded_by_id = ? WHERE id = ? AND canonical_status = 'canonical'",
                    [surveyResponseId, precedence.supersede]
                );
            }

            await conn.commit();
            return { surveyResponseId, supersededId: precedence.supersede || null };
        } catch (err) {
            await conn.rollback().catch(() => {});
            // Last-resort idempotency net: unique_client_submission_id firing
            // here means a retry of the SAME attempt raced in on a different
            // key (extremely unlikely now that same-key attempts are fully
            // serialized by the lock above) — resolve it to the existing row
            // exactly like the pre-existing behavior, never as an error.
            if (err.code === 'ER_DUP_ENTRY' && fields.clientSubmissionId) {
                const existing = await findSurveyByClientSubmissionId(fields.clientSubmissionId);
                if (existing) return { surveyResponseId: existing.id, supersededId: null, alreadyRecorded: true };
            }
            throw err;
        }
    });
}

// Same precedence gate as submitCanonicalSurvey, for the personal/external-
// email branch that queues a pending_survey_submissions row for office
// review instead of inserting straight into survey_responses. Recording
// `submissionSource` on the pending row itself is what lets a LATER Online
// submission for the same key preempt a merely-pending Offline one (see
// resolveSubmissionPrecedence), and lets the office-approval route re-check
// precedence at approval time (an Online canonical row may have appeared
// while this was still awaiting review).
//
// `submittedAt` (optional Date) is when the client actually answered — only
// the offline paths pass it, so a survey filled in at 9:05 with no signal and
// synced at 2:40 shows 9:05 in the office's Pending list instead of the sync
// time. Omitted, the row is stamped at insert exactly as before.
async function queuePendingSurveyWithPrecedence(officeId, googleEmail, serviceAvailed, payloadObj, submissionSource, submittedAt) {
    return withLogicalSurveyLock(officeId, googleEmail, serviceAvailed, async (conn) => {
        const precedence = await resolveSubmissionPrecedence(conn, officeId, googleEmail, serviceAvailed, submissionSource);
        throwIfSubmissionRejected(precedence);

        const [result] = await conn.query(
            'INSERT INTO pending_survey_submissions (office_id, google_email, service_availed, payload, submission_source, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))',
            [officeId, googleEmail, serviceAvailed, JSON.stringify(payloadObj), submissionSource, submittedAt || null]
        );
        return { pendingSubmissionId: result.insertId };
    });
}

function getClientEmail(req) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.email) return req.user.email;
    if (req.session && req.session.clientEmail) return req.session.clientEmail;
    return null;
}

// Ensures only an authenticated client (Google OR unified login) can view/submit the survey.
// Treats a null/undefined/destroyed session exactly like "not logged in" — there is no
// implicit trust of anything the browser sends except the (now cache-busted) cookie.
function ensureClientAuth(req, res, next) {
    const email = getClientEmail(req);
    if (email) {
        req.clientEmail = email;
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please sign in before submitting the survey." });
    }
    // A 'client.sid' cookie only ever gets set once this browser actually
    // authenticated (express-session's saveUninitialized:false — see the
    // session() call above), so seeing one here despite no valid session
    // behind it means this browser WAS logged in and that session has since
    // expired/been cleared (8h maxAge, server restart, store eviction) — as
    // opposed to a visitor who never logged in at all (no cookie sent). Same
    // reasoning as ensureAdminAuth's hadSessionCookie check below; the server
    // genuinely can't tell "expired" from "never logged in" any other way,
    // so this is the one piece of real evidence available for that distinction.
    const hadSessionCookie = !!(req.headers.cookie && req.headers.cookie.includes('client.sid='));
    return res.redirect(302, hadSessionCookie ? '/login?status=session_expired' : '/login?status=login_required');
}

// Ensures only a logged-in admin (set at /auth-login) can view/use admin pages & CRUD routes.
// Same null/undefined/destroyed-session handling as ensureClientAuth above.
function ensureAdminAuth(req, res, next) {
    if (req.adminSession && req.adminSession.user && req.adminSession.user.type === 'admin') {
        // Two admin tabs in the same browser share one 'admin.sid' cookie, so a
        // fresh login in Tab 2 can't be told apart from Tab 1 by session/cookie
        // alone. login_token is the tie-breaker: /auth-login stamps a brand new
        // one on admins.login_token AND req.adminSession.login_token on every
        // login, so whichever tab's session was NOT the most recent login
        // (regenerate() also gives it a fresh sessionID, invalidating this copy)
        // fails this comparison on its very next request.
        return db.query('SELECT login_token FROM admins WHERE id = ?', [req.adminSession.user.id], (err, rows) => {
            if (err) {
                console.error('❌ Error verifying login_token:', err);
                return res.redirect(302, '/login?error=' + encodeURIComponent('Server error. Please try again.'));
            }

            const dbToken = rows && rows[0] ? rows[0].login_token : null;
            if (!dbToken || dbToken !== req.adminSession.login_token) {
                // A structurally-intact admin session whose stored token no
                // longer matches the account's current one. login_token is
                // ONLY ever overwritten by a real, successful /auth-login —
                // so unlike the "session missing entirely" branch below, this
                // IS solid evidence of an actual newer login, not a guess.
                destroyAdminSession(req, res);
                return res.redirect(302, '/login?status=session_replaced');
            }

            res.locals.loginToken = dbToken; // read by the cross-tab BroadcastChannel sync script (layout/header.ejs)

            // Powers the sidebar's "All Cluster" submenu — queried per-request (rather
            // than passed by every single route handler) so a newly added cluster
            // shows up there immediately without touching every res.render() call.
            db.query('SELECT id, cluster_name FROM clusters WHERE is_archived = 0 ORDER BY cluster_name', (err, clusters) => {
                res.locals.sidebarClusters = err ? [] : clusters;
                next();
            });
        });
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please log in as admin first." });
    }

    // A session cookie was sent but no admin session was found behind it.
    // ROOT CAUSE of the old false "logged in on another device/tab" alert:
    // this exact state (cookie present, store entry gone) is ALSO exactly
    // what an ordinary session timeout, a server restart (adminSessions is
    // an in-memory Map — restarting the process empties it), or the store
    // simply evicting an expired entry look like. None of those are evidence
    // of another login. The ONLY reliable evidence is req._adminSessionMissingReason
    // === 'replaced', set above by the cookie-parsing middleware, which is
    // itself only ever true when /auth-login's real "kick out this admin's
    // other sessions" step (see markAdminSessionReplaced) actually ran for
    // this exact session id. Anything else is classified as plain expiration —
    // never asserted as a concurrent login without real proof.
    if (req._adminSessionMissingReason === 'replaced') {
        return res.redirect(302, '/login?status=session_replaced');
    }
    const hadSessionCookie = !!(req.headers.cookie && req.headers.cookie.includes('admin.sid='));
    if (hadSessionCookie) {
        return res.redirect(302, '/login?status=session_expired');
    }
    return res.redirect(302, '/login?status=login_required');
}

// Ensures only a logged-in office account (set at /auth-login) can view/use the
// office approval panel. Reuses the same hand-rolled session mechanics as
// ensureAdminAuth, but on its own req.officeSession/'office.sid' cookie (see
// OFFICE_COOKIE_NAME) so an admin tab and an office tab open at once in the
// same browser don't stomp on each other's cookie.
// Two spellings of the signed-in office's own name, for the portal header.
//
// `offices` stores the name two different ways depending on the office, and
// both have to end up looking the same in the header:
//   - office_name spelled out, full_name NULL   ("Student Testing and Admission")
//   - office_name as the acronym, full_name spelled out ("CCS" / "College of
//     Computer Studies") — see migrations/add_office_full_name.sql
// So the FULL spelling is full_name when it exists and office_name otherwise,
// and the SHORT spelling is office_name when it is already the acronym, and a
// derived one when it is not.
// The spelled-out name of every office whose `office_name` is stored as the
// acronym staff use day to day. This is the same table as
// migrations/add_office_full_name.sql, kept here as well because a .sql file
// only ever runs on the database somebody runs it against: it had been applied
// to the development database and never to the deployed one, so in production
// every office below still introduced itself as "CCS" or "CEA" in the portal
// header, on desktop included, however many times the code was committed and
// redeployed. Applied on boot instead (see the offices table setup), the way
// the services table's `availability` backfill is, so every environment ends
// up spelling these out without anyone having to remember a manual step.
const OFFICE_FULL_NAMES = {
    'RFOIU': 'Records and Freedom of Information Unit',
    'CEA': 'College of Engineering and Architecture',
    'CAS': 'College of Arts and Sciences',
    'CTDE': 'College of Technological and Development Education',
    'CCS': 'College of Computer Studies',
    'CHS': 'College of Health Sciences',
    'CTHBM': 'College of Tourism, Hospitality, and Business Management',
    'GRADUATE SCHOOL': 'Graduate School',
    'BUHI CAMPUS': 'Buhi Campus',
    'VPAA': 'Vice President for Academic Affairs Office',
    'VPAF': 'Vice President for Administration and Finance Office',
    'VPRIC': 'Vice President for Research, Innovation, and Collaboration Office',
    'PAxS': 'Public Affairs and Special Concerns Office'
};

// One idempotent statement, run once per boot. Two deliberate limits on what
// it may touch:
//   - matched on office_name, never on id, because the ids in the deployed
//     database are not guaranteed to be the ids here;
//   - only ever fills a full_name that is MISSING, so a spelling a super admin
//     corrected by hand is never overwritten on the next restart.
function backfillOfficeFullNames() {
    const names = Object.keys(OFFICE_FULL_NAMES);
    if (!names.length) return;
    const cases = names.map(() => 'WHEN ? THEN ?').join(' ');
    const params = [];
    names.forEach((n) => params.push(n, OFFICE_FULL_NAMES[n]));
    names.forEach((n) => params.push(n));
    const sql = `UPDATE offices SET full_name = CASE office_name ${cases} ELSE full_name END
                 WHERE office_name IN (${names.map(() => '?').join(', ')})
                   AND (full_name IS NULL OR TRIM(full_name) = '')`;
    db.query(sql, params, (err, result) => {
        if (err) return console.error('❌ Error filling in office full names:', err);
        if (result && result.affectedRows) console.log(`✅ Office full names filled in for ${result.affectedRows} office(s).`);
    });
}

const OFFICE_ACRONYM_STOPWORDS = new Set(['and', 'of', 'for', 'the', 'in', 'on', 'at', 'to', 'a', 'an', '&']);

// Some office names carry their own acronym in the name itself — "National
// Service Training Program (NSTP)". That trailing "(NSTP)" is the SHORT
// spelling wearing the long one's clothes: printed inside the full name it
// says the same thing twice, in the one place there is already least room for
// it. So the full spelling drops it, and it is used only where the short
// spelling is wanted.
//
// Only an acronym-shaped parenthetical is removed — no spaces, 2-15
// characters — so a name that uses parentheses for actual words keeps them,
// and a name that is NOTHING but a parenthetical keeps itself.
function stripParentheticalAcronym(name) {
    const raw = String(name || '').trim();
    const stripped = raw.replace(/\s*\(([^)\s]{2,15})\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return stripped || raw;
}

function deriveOfficeShortName(officeName, fullName) {
    const stored = String(officeName || '').trim();
    const full = String(fullName || '').trim();
    if (!stored) return '';

    // full_name is only ever filled in for an office whose office_name is
    // ALREADY the acronym staff use day to day, so that stored value is the
    // short form — no need to invent one.
    if (full && full.toLowerCase() !== stored.toLowerCase()) return stored;

    // An acronym the name carries in its own parentheses beats a derived one,
    // because it is the office's own choice of abbreviation — e.g. "Center for
    // Gender and Development (CGAD)" is known as CGAD, not CFGAD.
    const parenthesized = stored.match(/\(([^)]{2,15})\)/);
    if (parenthesized) return parenthesized[1].trim();

    // Otherwise build initials from the words that carry meaning. Dropping the
    // linking words is what makes these match the acronyms the offices already
    // use elsewhere: "Student Testing and Admission" -> STA and "Student
    // Registration and Records Office" -> SRRO are exactly the acronyms in
    // those two offices' own email addresses (sta@, srro@).
    const words = stored
        .replace(/\([^)]*\)/g, ' ')
        .split(/[\s/,\-]+/)
        .filter(Boolean)
        .filter((w) => !OFFICE_ACRONYM_STOPWORDS.has(w.toLowerCase()));
    const initials = words.map((w) => w.charAt(0).toUpperCase()).join('');

    // A single initial is not a name — a one-word office keeps its word.
    return initials.length >= 2 ? initials : stored;
}

// What the office pages pass to the shell. officeName stays the key the three
// views already use, so it keeps meaning "the name to show", now always the
// full one; officeNameShort is the fallback the header swaps in when the full
// one cannot fit (see office-shell.ejs).
function officeHeaderNames(user) {
    const stored = String((user && user.office_name) || '').trim();
    const full = String((user && user.full_name) || '').trim() || stored;
    return {
        // Spelled out and nothing else: no acronym tacked on the end, on any
        // screen. The acronym is a fallback for when this cannot fit, not a
        // decoration to carry alongside it.
        officeName: stripParentheticalAcronym(full),
        officeNameShort: deriveOfficeShortName(stored, user && user.full_name)
    };
}

function ensureOfficeAuth(req, res, next) {
    if (req.officeSession && req.officeSession.user && req.officeSession.user.type === 'office') {
        // Sessions opened before offices started carrying full_name have no
        // copy of it, and the header needs it to spell the office out. Fill it
        // in once, here, so an office already signed in on some device gets
        // the proper header without having to log out and back in first.
        //
        // "Once" means once SUCCESSFULLY, which is why the marker is a
        // separate flag rather than the value itself. An empty full_name is
        // not proof that the question was ever answered: it is equally what a
        // session carries when it was opened before the offices table had the
        // column filled in, and what this very query leaves behind when it
        // errors. Treating that emptiness as the answer is what pinned the
        // header to the acronym ("CCS") for the whole life of such a session,
        // on desktop included, where the full name is supposed to be
        // unconditional. So the lookup is retried while the name is still
        // missing, and the flag — set only when the database actually
        // answered — stops the retries for the offices whose full_name really
        // is empty (those whose office_name is already spelled out).
        const officeUser = req.officeSession.user;
        if (!officeUser.full_name && !officeUser.fullNameResolved) {
            return db.query('SELECT full_name FROM offices WHERE id = ? LIMIT 1', [officeUser.id], (err, rows) => {
                if (err) {
                    console.error('❌ Error loading this office full name:', err);
                    // Left unresolved on purpose: the next page load asks again.
                    officeUser.full_name = officeUser.full_name || null;
                    return next();
                }
                officeUser.full_name = (rows && rows[0] && rows[0].full_name) || null;
                officeUser.fullNameResolved = true;
                return next();
            });
        }
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please log in as your office first." });
    }
    // status=login_required so the login page can say WHY it is asking —
    // an unexplained bounce back to a login form reads as a failure.
    // Offices sign in through the SAME '/login' form as admins and clients
    // (see handleOfficeLogin in /auth-login); there is no separate office
    // login page any more.
    return res.redirect(302, '/login?status=login_required');
}

// Tells the browser (and any proxy/CDN in front of it) to never cache a restricted
// page/response and never serve it from the bfcache — otherwise, after logging
// out, hitting the browser's Back button can re-display a stale cached copy of a
// protected page even though the session behind it is destroyed server-side.
function noCache(req, res, next) {
    res.set('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
}

// ==========================================
// DATABASE CONNECTION (MySQL)
// ==========================================
// A pool (not a single createConnection) so a dropped connection — MySQL
// restart, network blip, or hitting wait_timeout after sitting idle — gets
// silently replaced on the next query instead of leaving `db` permanently
// broken. Just as important: a pool's per-query errors surface through that
// query's own callback, so they can never become an unhandled 'error' event
// with zero listeners — which is what crashes the whole Node process outright.
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'cqa_db',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    // Clever Cloud's free DEV MySQL plan caps max_user_connections at 5 total
    // — a pool of 10 would routinely exceed that under any concurrent load.
    connectionLimit: process.env.DB_CONNECTION_LIMIT ? parseInt(process.env.DB_CONNECTION_LIMIT, 10) : 4,
    queueLimit: 0,
    // A pooled connection can sit idle for minutes between queries (e.g. the
    // 5-minute abandoned-session sweep). Over a long cross-region hop — this
    // app's VM and Clever Cloud's DB host are on different continents — an
    // intermediate router/firewall can silently drop that idle TCP connection
    // without either side knowing, so the next query hangs until it hits
    // ETIMEDOUT instead of failing fast. TCP keep-alive pings the connection
    // periodically so it's never idle long enough to look dead to anything
    // in between.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// Defense in depth: still listen for pool-level errors (e.g. a failure while
// establishing a brand new connection) so that, too, can never crash the
// process via an unhandled 'error' event.
db.on('error', (err) => {
    console.error('❌ MySQL pool error:', err);
});

db.query('SELECT 1', (err) => {
    if (err) {
        console.error('❌ Error connecting to MySQL:', err);
        return;
    }
    console.log('✅ Connected to cqa_db database successfully!');
    loadOfficeNameCache();
});

// Promise wrapper around db.query — used by the offline-sync route so it can
// `await` each step (duplicate check → AI analysis → insert) in sequence.
const dbQuery = promisify(db.query).bind(db);

// office_id -> "office_name, cluster_name" cache, used only to give the AI
// topic classifier a soft office/cluster hint (see topic_common.py's
// office_hint_topics). Offices change rarely, so a cache refreshed at
// startup and lazily on a cache miss is plenty fresh — this is never more
// than a small tie-break nudge, not something that needs to be transaction-
// consistent with the offices table.
const officeNameCache = new Map();
function loadOfficeNameCache() {
    db.query('SELECT id, office_name, cluster_name FROM offices', (err, rows) => {
        if (err) {
            console.error("❌ [Office Cache] Failed to load office names:", err);
            return;
        }
        officeNameCache.clear();
        (rows || []).forEach((row) => {
            officeNameCache.set(row.id, `${row.office_name}, ${row.cluster_name || ''}`.trim());
        });
    });
}
function getOfficeHint(officeId) {
    return officeNameCache.get(officeId) || null;
}

// ==========================================
// AI MODEL SERVER (persistent, keeps ~1GB of transformer weights loaded in
// memory for the lifetime of the admin portal, instead of reloading them
// from disk on every single comment). Spawned once here and reused for
// every live /submit-survey comment. See ai_scripts/model_server.py.
// ==========================================
const MODEL_SERVER_PORT = process.env.AI_MODEL_SERVER_PORT || 8765;
const MODEL_SERVER_URL = `http://127.0.0.1:${MODEL_SERVER_PORT}`;
let modelServerProcess = null;
let modelServerReady = false;

// The AI scripts need google-genai, which requires Python 3.9+. If a venv
// was set up under ai_scripts/venv (see ai_scripts/requirements.txt), prefer
// its python.exe over whatever "python" resolves to on PATH, since that may
// be an older system Python missing the dependency.
function getPythonExecutable() {
    const venvPython = path.join(__dirname, 'ai_scripts', 'venv', 'Scripts', 'python.exe');
    return fs.existsSync(venvPython) ? venvPython : 'python';
}

function startModelServer() {
    const scriptPath = path.join(__dirname, 'ai_scripts', 'model_server.py');
    modelServerProcess = spawn(getPythonExecutable(), [scriptPath], {
        env: { ...process.env, AI_MODEL_SERVER_PORT: String(MODEL_SERVER_PORT) }
    });

    modelServerProcess.on('error', (err) => {
        console.error("❌ [AI Model Server] Could not start Python. Is it installed?", err);
    });

    modelServerProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        process.stdout.write(`[AI Model Server] ${text}`);
        if (text.includes('READY')) {
            modelServerReady = true;
            console.log(`✅ [AI Model Server] Warm and ready on ${MODEL_SERVER_URL}`);
        }
    });
    modelServerProcess.stderr.on('data', (chunk) => {
        process.stdout.write(`[AI Model Server] ${chunk.toString()}`);
    });

    modelServerProcess.on('close', (code) => {
        modelServerReady = false;
        console.error(`❌ [AI Model Server] Exited (code ${code}). Live comment analysis will fall back to the slower per-comment path until it's restarted.`);
    });
}

function stopModelServer() {
    if (modelServerProcess && !modelServerProcess.killed) {
        modelServerProcess.kill();
    }
}
process.on('exit', stopModelServer);
process.on('SIGINT', () => { stopModelServer(); process.exit(0); });
process.on('SIGTERM', () => { stopModelServer(); process.exit(0); });

// Last-resort safety net: log and keep serving instead of letting one bad
// request (a stray throw, a rejected promise nobody awaited) kill the entire
// server for every logged-in admin and client. This does NOT replace fixing
// the underlying bug — it just stops a single mistake from becoming a
// full outage.
process.on('uncaughtException', (err) => {
    console.error('❌ [FATAL] Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ [FATAL] Unhandled promise rejection (server kept running):', reason);
});

// ==========================================
// LANDING PAGE CONTENT (CMS-editable, index.ejs)
// ==========================================
// Stored as one JSON blob (single row, id = 1) rather than one column per
// field — the CMS only ever reads/writes whole "sections" at a time (branding,
// hero, about, org, services, footer), so a flat SQL table would just mean a
// migration every time a field is added. DEFAULT_LANDING_CONTENT mirrors the
// text that used to be hardcoded in index.ejs, so a fresh DB (no row saved
// yet) renders an identical page to before this feature existed.
const DEFAULT_LANDING_CONTENT = {
    branding: {
        title: 'Center For Quality Assurance',
        subtitle: 'Public Transparency Portal • Satisfaction Survey',
        loginLabel: 'Login Portal',
        logoUrl: '/images/cspc-logo.png'
    },
    hero: {
        eyebrow: 'Camarines Sur Polytechnic Colleges',
        titleLine1: 'Center for Quality Assurance',
        titleLine2: 'Public Transparency Portal',
        subtext: "A live window into our institution's governance, services, and client satisfaction performance — built on data, driven by continuous quality improvement.",
        cta1Text: 'Explore Dashboard',
        cta1Link: '#dashboard',
        cta2Text: 'View Our Services',
        cta2Link: '#services',
        imageUrl: '/images/campus-monument.jpg'
    },
    about: {
        eyebrow: 'Who We Are',
        title: 'Center for Quality Assurance',
        paragraph: "The Center for Quality Assurance is where the College's quality assurance mechanisms and processes are vested. The office is in-charge of all international, national and local quality assurance mechanisms, while working closely with top management in setting up quality assurance procedures. Its main responsibility is to coordinate, assist, and monitor the different units to strengthen their academic and administrative management and processes so that they are better able to achieve their quality goals and educational objectives.",
        badge1: 'ISO 9001:2015 Certified',
        badge2: 'Institutional Accreditation',
        badge3: 'Continuous Quality Monitoring',
        headName: 'JUVY M. BUSTAMANTE, JD',
        headRole: 'Head, Center for Quality Assurance',
        headEmail: 'qams@cspc.edu.ph',
        headPhone: '(054) 2884421 to 23 loc. 123'
    },
    org: {
        eyebrow: 'Governance',
        title: 'Organizational Structure',
        lead1Name: 'Amado A. Oliva Jr., PhD', lead1Role: 'SUC President III',
        lead2Name: 'Dr. Jocelyn O. Jintalan', lead2Role: 'Vice President of Academic Affairs',
        lead3Name: 'Mr. Juvy M. Bustamante, JD', lead3Role: 'AO V · Head, Center for Quality Assurance',
        team1Name: 'Angielyn L. Patricio', team1Role: 'AA VI / Program Accreditation and Assessment Coordinator',
        team2Name: 'Marian Beatrize O. Tabalos', team2Role: 'AO II / Institutional Accreditations Person-in-Charge',
        team3Name: 'Lea Laarni B. Albeza-Arines', team3Role: 'AO IV / QMS and EOMS Person-in-Charge',
        team4Name: 'Chrena Joyce I. Brutas', team4Role: 'Technical Writer / CSM Focal Person',
        team5Name: 'Christine Joy L. Taburnal', team5Role: 'AA II / Office Clerk / Clerical Support Staff',
        team6Name: 'Lawrence A. Rebulado', team6Role: 'Layout Artist / Databank Manager',
        aideLabel: 'Student Aide'
    },
    services: {
        eyebrow: 'Client Satisfaction Measurement',
        title: 'Our Services',
        desc: 'Every frontline service across the College, organized by Cluster → Office. Pick a cluster, then expand an office to see what it offers.'
    },
    footer: {
        desc: 'Committed to upholding transparency and accountability by providing open access to institutional quality assurance data, governance structures, and public satisfaction survey results.',
        address: 'Center for Quality Assurance, Camarines Sur Polytechnic Colleges, Nabua, Camarines Sur, Philippines',
        email: 'qams@cspc.edu.ph',
        phone: '(054) 2884421 to 23 loc. 123',
        hours: 'Mon – Fri, 8:00 AM – 5:00 PM',
        facebook: 'https://facebook.com',
        twitter: 'https://twitter.com',
        linkedin: 'https://linkedin.com',
        spims: 'https://spims.cspc.edu.ph'
    }
};

// Deliberately NOT exposed here: the Cluster → Office → Service directory
// (services-section tab only edits the intro text above it) and the
// Transparency Dashboard — both are out of scope per the CMS design.
const LANDING_SECTION_KEYS = Object.keys(DEFAULT_LANDING_CONTENT);

// ---- Plain JSON-file storage (no MySQL) -----------------------------------
// admin-portal/data/landing-data.json — one flat file, read/written with
// fs.*Sync so every request sees the latest write immediately (no async
// driver, no connection pool, nothing that can silently fail to persist).
const LANDING_DATA_DIR = path.join(__dirname, 'data');
const LANDING_DATA_FILE = path.join(LANDING_DATA_DIR, 'landing-data.json');

// Runs once at startup: make sure the data/ folder and the JSON file exist so
// every route below can assume the file is always there.
fs.mkdirSync(LANDING_DATA_DIR, { recursive: true });
if (!fs.existsSync(LANDING_DATA_FILE)) {
    fs.writeFileSync(LANDING_DATA_FILE, JSON.stringify(DEFAULT_LANDING_CONTENT, null, 2), 'utf8');
    console.log('✅ Created data/landing-data.json with default landing page content.');
}

// Reads landing-data.json off disk and merges it over the defaults one
// section at a time, so a partially-saved file (or one missing a brand-new
// field added later in DEFAULT_LANDING_CONTENT) still renders every section
// correctly instead of leaving something blank/undefined.
function loadLandingContent() {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(LANDING_DATA_FILE, 'utf8'));
    } catch (err) {
        console.error('❌ Error reading/parsing data/landing-data.json — falling back to defaults:', err);
        saved = {};
    }
    const merged = {};
    for (const key of LANDING_SECTION_KEYS) {
        merged[key] = { ...DEFAULT_LANDING_CONTENT[key], ...(saved[key] || {}) };
    }
    return merged;
}

// Persists one section's fields, merged over whatever was already saved (so
// saving "hero" never wipes out "about", "footer", etc.) — read the whole
// file, patch one key, write the whole file back out. Synchronous on purpose:
// this is an infrequent admin action, not a hot path, so there's no reason to
// risk two concurrent writes racing each other.
function saveLandingSection(section, fields) {
    const current = loadLandingContent();
    current[section] = { ...current[section], ...fields };
    fs.writeFileSync(LANDING_DATA_FILE, JSON.stringify(current, null, 2), 'utf8');
    return current[section];
}

// Runs a comment through analyze.py, spawning a fresh Python process. This
// loads the Gemini client fresh every call, so it's slower than the
// persistent model server — used as a fallback for the live path (model
// server unreachable) and as the normal path for every offline-synced
// comment (see analyzeComment below), which (as of 2026-09-25) gets the
// exact same pure-Gemini classification as a live comment, just via this
// per-comment process instead of the persistent model server.
function analyzeViaPythonScript(comment, offline, officeHint) {
    return new Promise((resolve) => {
        try {
            const pythonScriptPath = path.join(__dirname, 'ai_scripts', 'analyze.py');
            const pythonProcess = spawn(getPythonExecutable(), [pythonScriptPath]);

            pythonProcess.on('error', (err) => {
                console.error("❌ [AI] Could not start Python. Is it installed?", err);
                resolve({ sentiment: 'Neutral', topics: ['General Feedback'] });
            });

            pythonProcess.stdin.write(JSON.stringify({ comment: String(comment), offline: !!offline, office: officeHint || '' }));
            pythonProcess.stdin.end();

            let aiOutput = '';
            pythonProcess.stdout.on('data', (chunk) => { aiOutput += chunk.toString(); });
            pythonProcess.stderr.on('data', (chunk) => { process.stdout.write(chunk.toString()); });

            pythonProcess.on('close', () => {
                try {
                    const jsonMatch = aiOutput.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const aiResult = JSON.parse(jsonMatch[0]);
                        // topics is a non-empty array (multi-topic tagging project,
                        // 2026-09-25) — see gemini_model.classify's docstring.
                        if (aiResult.sentiment && Array.isArray(aiResult.topics) && aiResult.topics.length) {
                            return resolve({ sentiment: aiResult.sentiment, topics: aiResult.topics });
                        }
                    }
                    console.error("❌ [AI Parsing Error]: Could not find JSON.\nRaw Output:", aiOutput);
                    resolve({ sentiment: 'Neutral', topics: ['General Feedback'] });
                } catch (e) {
                    console.error("❌ [AI Execution Error]:", e.message);
                    resolve({ sentiment: 'Neutral', topics: ['General Feedback'] });
                }
            });
        } catch (err) {
            console.error("❌ [AI] Unexpected error launching analysis:", err);
            resolve({ sentiment: 'Neutral', topics: ['General Feedback'] });
        }
    });
}

// Mirrors ai_scripts/topic_common.py's is_no_feedback() exactly (same
// normalized phrase set) — checked here FIRST, before ever spawning Python
// or calling the model server, so a blank/placeholder comment costs nothing
// beyond a string comparison. Kept as a plain, independent JS function
// (not shelling out to Python just to check this) since server.js is the
// actual gatekeeper every comment passes through before analysis of any
// kind — see analyzeComment below and finalizeVerifiedSurvey/
// insertVerifiedSurveyOnConnection, which both use this too.
// pending_survey_submissions.payload is a real MySQL JSON column, so mysql2
// already hands it back as a parsed OBJECT — calling JSON.parse() on that
// stringifies it to "[object Object]" first and then throws a SyntaxError.
// That was silently emptying the payload everywhere it was read (every
// pending row rendering as "Anonymous") and, in the approve route, throwing
// inside the transaction so every approval failed with "Unable to process
// the submission." Accept both shapes: an object passes through untouched,
// a string (older rows, or a driver/column type that returns text) is
// parsed. Never throws — an unusable payload comes back as {} so callers
// fall back to their own defaults instead of failing the whole request.
function parsePendingPayload(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
    try {
        const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

// isNoFeedbackComment now lives in shared/commentFilter.js, next to the two
// rules it is always applied alongside when a report is built (the gibberish
// test and profanity masking). It was here, and the report-time rules were
// nowhere, which is how a report could be generated with all three rules
// meaning to apply and only this one actually running.

// Resolves { sentiment, topics } for a comment. Used by both the live
// /submit-survey route (fire-and-forget, applied via an UPDATE after the
// fact) and the /sync-surveys batch route (awaited before the row is even
// inserted). Never rejects — a missing/blank/no-feedback comment resolves
// with nulls (so the DB gets NULL, not a fabricated "General Feedback"/
// "Neutral" — see isNoFeedbackComment above), and any failure resolves
// with the "Neutral" / "General Feedback" fallback instead of throwing, so
// one bad comment can never crash a batch sync.
//
// `offline` should be true for comments coming from the /sync-surveys queue
// (submitted while the client was offline, synced later in bulk) — as of
// 2026-09-25 these get the exact same pure-Gemini classification as a live
// comment (see analyze.py's module comment for why the offline-only
// keyword-lexicon hybrid was reverted), just via a fresh analyze.py
// subprocess per comment rather than the persistent model server. Live
// comments (`offline` false) go to the persistent model server for
// near-instant analysis, only falling back to spawning analyze.py (slower —
// loads the Gemini client fresh) if the model server is unreachable.
// officeId: optional office_id whose cached office/cluster name is passed to
// the classifier as a soft topic hint (see topic_common.py's
// office_hint_topics) — never a hard override, just a tie-break nudge.
function analyzeComment(comment, offline = false, officeId = null) {
    return new Promise((resolve) => {
        if (isNoFeedbackComment(comment)) {
            return resolve({ sentiment: null, topics: null });
        }

        const officeHint = officeId != null ? getOfficeHint(officeId) : null;

        if (offline) {
            return resolve(analyzeViaPythonScript(comment, true, officeHint));
        }

        if (!modelServerReady) {
            return resolve(analyzeViaPythonScript(comment, false, officeHint));
        }

        fetch(`${MODEL_SERVER_URL}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment: String(comment), office: officeHint || '' }),
            // heavy_model.py's fallback is now Gemini (see 2026-08-29 mDeBERTa
            // removal), not a local model — normally a 1-3s network round
            // trip on a lexicon miss. But Gemini's free tier caps at 15
            // requests/minute, and gemini_model.py's client-side throttle
            // will sleep out a full rate-limit window (up to ~60s) rather
            // than risk a 429, on top of up to 3 retries with up to 20s
            // backoff each if one slips through anyway. 45s was sized for
            // mDeBERTa's very different (CPU-bound, no rate limit) profile
            // and is too tight for Gemini's worst case, so this is sized to
            // comfortably clear one full throttle wait plus a retry.
            signal: AbortSignal.timeout(90000)
        })
            .then((res) => res.ok ? res.json() : Promise.reject(new Error(`Model server responded ${res.status}`)))
            .then((aiResult) => {
                // topics is a non-empty array (multi-topic tagging project,
                // 2026-09-25) — see gemini_model.classify's docstring.
                if (aiResult.sentiment && Array.isArray(aiResult.topics) && aiResult.topics.length) {
                    return resolve({ sentiment: aiResult.sentiment, topics: aiResult.topics });
                }
                throw new Error('Model server response missing sentiment/topics');
            })
            .catch((err) => {
                console.error("❌ [AI Model Server] Request failed, falling back to per-comment script:", err.message);
                resolve(analyzeViaPythonScript(comment, false, officeHint));
            });
    });
}

// ==========================================
// EMAIL RECEIPT (NodeMailer)
// ==========================================
// Entirely optional and non-blocking: if MAIL_USER/MAIL_PASS aren't set in
// .env, sending is skipped (logged once at startup) and survey submission
// itself is completely unaffected either way — this never throws into a
// request handler and never delays the client's "Thank You" response.
//
// Configure in .env either:
//   MAIL_USER=you@gmail.com
//   MAIL_PASS=<a Gmail App Password, not your normal password>
// ...for Gmail, or add MAIL_HOST / MAIL_PORT / MAIL_SECURE for any other SMTP
// provider. Optionally set MAIL_FROM to override the display "From" name.
let mailTransporter = null;
if (process.env.MAIL_USER && process.env.MAIL_PASS) {
    mailTransporter = nodemailer.createTransport(
        process.env.MAIL_HOST
            ? {
                host: process.env.MAIL_HOST,
                port: parseInt(process.env.MAIL_PORT, 10) || 587,
                secure: process.env.MAIL_SECURE === 'true',
                auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
            }
            : {
                service: 'gmail',
                auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
            }
    );
    console.log('✅ Mail transporter configured — survey receipt emails are ON.');
} else {
    console.log('ℹ️  MAIL_USER/MAIL_PASS not set in .env — survey receipt emails are OFF (submissions still work normally).');
}

// Local logo, embedded via inline CID attachment (RFC 2392 — the standard,
// universally-supported way to put an image inside an email body without
// it appearing as a downloadable attachment). contentDisposition:'inline'
// on the attachment object is what actually suppresses Gmail's attachment
// chip — Nodemailer does NOT infer that from the presence of `cid` alone.
const RECEIPT_LOGO_PATH = path.join(__dirname, 'public', 'images', 'cspc-logo.png');

// Official Citizen's Charter SQD statements (matches client-survey.ejs's
// sqd_items) — keyed by index so the email table can show the full
// statement instead of just "SQD0".
const SQD_STATEMENTS = [
    'I am satisfied with the service that I availed.',
    'I spent a reasonable amount of time for my transaction.',
    "The office followed the transaction's requirements and steps based on the information provided.",
    'The steps (including payment) I needed to do for my transaction were easy and simple.',
    'I easily found information about my transaction from the office or its website.',
    'I paid a reasonable amount of fees for my transaction.',
    "I feel the office was fair to everyone, or 'walang palakasan', during my transaction.",
    'I was treated courteously by the staff.',
    'I got what I needed from the government office.'
];
// Free-text client input (respondent name, CSM comments) lands straight in
// email HTML below — escape it so a comment like "<img src=x onerror=...>"
// can't inject markup into the message.
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// client-survey.ejs's age/gender/region fields are all fixed <select>/radio
// option sets (never free text) — but that only constrains the normal
// browser form UI, not a direct POST to /submit-survey or /sync-surveys.
// Without a matching server-side allowlist, an attacker could POST an
// arbitrary string for one of these, which gets saved to client_accounts and
// later rendered back into client-survey.ejs's `savedClientProfile` via an
// unescaped `JSON.stringify()` inside an inline <script> tag — since
// JSON.stringify doesn't escape "/", a value containing "</script><script>…"
// breaks out of the script element and executes. Validating against the
// same fixed option sets the form actually offers closes that off entirely
// (invalid values fall through to the safe 'Not Specified' default) instead
// of trying to escape "/" as a workaround.
const VALID_AGE_BRACKETS = new Set(['18 and below', '19-24', '25-39', '40-59', '60 and above']);
const VALID_GENDERS = new Set(['Male', 'Female', 'Prefer not to say']);
const VALID_REGIONS = new Set([
    'NCR - National Capital Region', 'CAR - Cordillera Administrative Region',
    'Region I - Ilocos Region', 'Region II - Cagayan Valley', 'Region III - Central Luzon',
    'Region IV-A - CALABARZON', 'MIMAROPA Region', 'Region V - Bicol Region',
    'Region VI - Western Visayas', 'Region VII - Central Visayas', 'Region VIII - Eastern Visayas',
    'Region IX - Zamboanga Peninsula', 'Region X - Northern Mindanao', 'Region XI - Davao Region',
    'Region XII - SOCCSKSARGEN', 'Region XIII - Caraga', 'BARMM - Bangsamoro'
]);
function allowlisted(value, allowedSet) {
    const v = value == null ? null : String(value).trim();
    return (v && allowedSet.has(v)) ? v : null;
}

// Citizen's Charter option sets — mirrors the exact radio button values in
// client-survey.ejs's CC1/CC2/CC3 fieldsets. Used by
// POST /api/offline-surveys/verify-and-sync (an unauthenticated endpoint) to
// coerce any out-of-set value to null via allowlisted(), same
// fallback-to-null philosophy already used above for age/gender/region.
const VALID_CC1 = new Set([
    "I know what a CC is and I saw this office's CC.",
    "I know what a CC is but I did not see this office's CC.",
    "I learned of the CC only when I saw this office's CC.",
    "I do not know what a CC is and I did not see one in this office"
]);
const VALID_CC2 = new Set(['Easy to see', 'Somewhat easy to see', 'Difficult to see', 'Not visible at all', 'N/A']);
const VALID_CC3 = new Set(['Helped very much', 'Did not help', 'Somewhat helped', 'N/A']);

// Same offline-verify-only cap — comments has no length ceiling elsewhere in
// the app (an authenticated user typing too much is their own business);
// this specific endpoint is unauthenticated, so it gets one.
const OFFLINE_SURVEY_MAX_COMMENTS_LENGTH = 2000;

const sqdStatementFor = (label) => {
    const idx = parseInt(String(label).replace(/[^0-9]/g, ''), 10);
    return Number.isInteger(idx) && SQD_STATEMENTS[idx] ? `${label}. ${SQD_STATEMENTS[idx]}` : label;
};

// ==========================================
// SQD Score Formula, SQD Bucket Breakdown Formula, Cluster/Office Score-Cell
// Formula, and Office Display Name Formula — all now in
// views/layout/report_computation/report_formula.js (see the require at the
// top of this file for the full list of formulas extracted there).

// ==========================================
// DISPLAY TIME ZONE
// ==========================================
// Every timestamp this app shows describes something that happened on a
// Philippine campus, so it is rendered in Philippine time no matter where the
// server itself runs. Formatting with the server's own local zone (the default
// for toLocaleTimeString) is only correct while the server happens to BE in
// that zone: the same survey then reads 11:42 PM on a machine in Manila and
// 3:42 PM on the UTC cloud VM it is deployed to.
//
// This changes only how stored instants are PRINTED. Nothing here rewrites
// what is stored, and the stored value is unambiguous either way, because
// mysql2 reads a DATETIME using the Node process's zone and MySQL writes it
// using its own (both 'SYSTEM' on the same host) — the two always agree, so
// the Date object is the right instant and only its presentation was wrong.
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Asia/Manila';

// Templates format a few timestamps inline (the office's Pending and History
// lists), and need the same zone for the same reason.
app.locals.displayTimeZone = DISPLAY_TIME_ZONE;

// Cache-busting query string for report.css (views/layout/report-*.ejs's
// <link>), so a CSS edit shows up on refresh instead of the browser silently
// keeping the old stylesheet (static files carry no Cache-Control here, but
// browsers still heuristically cache them). Changes once per server start/
// deploy, which is the only time report.css can actually change.
app.locals.assetVersion = Date.now();

// The zone's UTC offset at a given instant, derived by formatting the same
// instant both ways and differencing them. The Philippines has no DST, so this is a
// constant +08:00 in practice; computing it per-instant keeps the helpers
// correct anyway if DISPLAY_TIME_ZONE is ever pointed at a zone that does.
function zonedOffsetMs(date) {
    const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const asZone = new Date(date.toLocaleString('en-US', { timeZone: DISPLAY_TIME_ZONE }));
    return asZone.getTime() - asUtc.getTime();
}

// 'YYYY-MM-DD' for the calendar day this instant falls on in the display zone.
// en-CA is used purely because it formats as ISO, which compares as a plain
// string — this is what decides whether two submissions group under the same
// day heading, and whether that heading is "Today".
function zonedDayKey(date) {
    return date.toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE });
}

// The exact instant midnight began, in the display zone, on the day this
// instant falls on. Used for "today"/"last 7 days" counting so those totals
// agree with the day headings beside them instead of silently rolling over at
// the server's midnight.
function startOfZonedDay(date) {
    const offset = zonedOffsetMs(date);
    const shifted = new Date(date.getTime() + offset);
    shifted.setUTCHours(0, 0, 0, 0);
    return new Date(shifted.getTime() - offset);
}

function formatZonedTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: DISPLAY_TIME_ZONE });
}

function formatZonedDayLabel(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: DISPLAY_TIME_ZONE
    });
}

// The compact 'Sep 18, 2026' form, for places that print a date beside its
// time in a fixed-width column (the registered-accounts list) and cannot
// afford the weekday-and-full-month version above.
function formatZonedDateShort(date) {
    return date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: DISPLAY_TIME_ZONE
    });
}

// 'September 05, 2026' / 'September 05, 2026 03:42 PM' — the exact shapes the
// SQL DATE_FORMAT(created_at, '%M %d, %Y [%h:%i %p]') calls used to produce,
// but computed from the instant in the display zone. DATE_FORMAT prints the
// DATABASE SESSION's wall clock, so on a MySQL running in UTC every survey
// record read 8 hours behind Philippine time while the office's Pending list
// (formatted here in Node) read correctly — two different times for the same
// submission. Returns '' for a missing/invalid value.
function formatZonedDateLong(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const p = {};
    new Intl.DateTimeFormat('en-US', {
        month: 'long', day: '2-digit', year: 'numeric', timeZone: DISPLAY_TIME_ZONE
    }).formatToParts(d).forEach(part => { p[part.type] = part.value; });
    return `${p.month} ${p.day}, ${p.year}`;
}

function formatZonedDateTimeLong(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const t = {};
    new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true, timeZone: DISPLAY_TIME_ZONE
    }).formatToParts(d).forEach(part => { t[part.type] = part.value; });
    return `${formatZonedDateLong(d)} ${t.hour}:${t.minute} ${String(t.dayPeriod || '').toUpperCase()}`;
}

// ==========================================
// PERIOD COVERED HELPERS
// ==========================================
// Submission tagging stays dynamic (server date -> period string) since the
// client can't tamper with it. The filter dropdown, however, is a fixed,
// known set of periods -- kept as a static list rather than derived from
// whatever happens to be in the database, to avoid legacy/inconsistent
// strings leaking into the UI.
function getPeriodCovered(date = new Date()) {
    // Year and month as they are in the display zone, not the server's: on a
    // UTC host, a survey answered at 6 AM Manila on July 1 is still June 30
    // there and would be filed under the wrong half-year.
    const parts = {};
    new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', timeZone: DISPLAY_TIME_ZONE })
        .formatToParts(date).forEach(p => { parts[p.type] = p.value; });
    const year = Number(parts.year);
    const month = Number(parts.month) - 1; // 0 = Jan ... 11 = Dec
    return month <= 5 ? `Jan to June ${year}` : `July to Dec ${year}`;
}

// Validates/normalizes the client-submitted "Date & Time of Office Visit"
// (from <input type="datetime-local">, e.g. "2026-08-28T15:00") into a MySQL
// DATETIME literal. The visit can be an earlier day than the survey is
// actually submitted on (client answers it later), so this is stored as its
// own date+time rather than assumed to match the submission's created_at.
// Anything that doesn't match is dropped to NULL rather than rejected
// outright, since client_profiles.office_visited_time is nullable for
// legacy records.
function cleanTime(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    const match = /^(\d{4}-\d{2}-\d{2})[T ]([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(str);
    if (!match) return null;
    const date = match[1];
    const hh = match[2].padStart(2, '0');
    const mm = match[3];
    const ss = match[4] || '00';
    return `${date} ${hh}:${mm}:${ss}`;
}

// Period Normalization Formula (normalizePeriodStr, periodNormExpr) — now in
// views/layout/report_computation/report_formula.js.

// Only the periods that have actually come around are listed here — the
// current one and the ones already behind it. Future years used to be
// pre-seeded (2027 was listed here), which put empty periods in front of
// both the public landing page's dashboard and the admin filter with no
// data to show. An admin adds the next period when it arrives, via
// /period-covered/add (see getMergedPeriodOptions below).
const PERIOD_COVERED_OPTIONS = [
    { value: 'Jan to June 2026', label: 'Jan to June 2026' },
    { value: 'July to Dec 2026', label: 'July to Dec 2026' }
];

// Admin-added periods on top of the fixed list above, stored in the existing
// generic survey_settings lookup table (category = 'period_covered') rather
// than a new table. Lets an admin extend the dropdown (e.g. seed a future
// year ahead of time) without a code change/redeploy. Merged and de-duped
// against normalizePeriodStr() so a custom entry that collides with a static
// one (different spelling of the same range) never shows up twice.
function getMergedPeriodOptions(callback) {
    db.query(
        "SELECT content FROM survey_settings WHERE category = 'period_covered' AND is_archived = 0 ORDER BY id ASC",
        (err, rows) => {
            if (err) { console.error('❌ Error loading custom period covered options:', err); return callback(PERIOD_COVERED_OPTIONS); }
            const seen = new Set(PERIOD_COVERED_OPTIONS.map(o => normalizePeriodStr(o.value)));
            const custom = (rows || []).reduce((acc, r) => {
                const value = String(r.content || '').trim();
                const norm = normalizePeriodStr(value);
                if (!value || seen.has(norm)) return acc;
                seen.add(norm);
                acc.push({ value, label: value });
                return acc;
            }, []);
            callback(PERIOD_COVERED_OPTIONS.concat(custom));
        }
    );
}

function periodCoveredOk(msg) { return '/dashboard?success=' + encodeURIComponent(msg); }
function periodCoveredErr(msg) { return '/dashboard?error=' + encodeURIComponent(msg); }

// Sends the client a proof-of-completion receipt of exactly what they just
// submitted. Fire-and-forget: called AFTER the client already got its
// success response, so a slow or failed send can never hold up the survey.
function sendSurveyReceiptEmail(toEmail, receipt) {
    if (!mailTransporter || !toEmail || toEmail === 'Not Specified') return;

    const sqdRowsHtml = receipt.sqd.map((r, idx) => `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;color:#334155;">${sqdStatementFor(r.label)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};text-align:center;font-weight:700;font-size:13px;color:#251d3a;width:70px;">${r.value === null ? 'N/A' : (r.value === 0 ? 'N/A' : r.value + ' / 5')}</td>
        </tr>`).join('');

    const detailRow = (label, value) => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:13px;font-weight:700;color:#64748b;width:42%;vertical-align:top;">${label}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:14px;font-weight:600;color:#0f172a;vertical-align:top;">${value}</td>
        </tr>`;

    const ccRowsHtml = ['cc1', 'cc2', 'cc3'].map((key, idx) => `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;font-weight:700;color:#251d3a;width:60px;">${key.toUpperCase()}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;color:#334155;">${escapeHtml(receipt[key] || 'N/A')}</td>
        </tr>`).join('');

    const commentsHtml = receipt.comments && receipt.comments !== 'N/A'
        ? `<h3 style="margin:20px 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Your Comment</h3>
           <p style="margin:0;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13.5px;color:#334155;line-height:1.6;">${escapeHtml(receipt.comments)}</p>`
        : '';

    // Only reference the logo (both the <img> tag and the attachment below) if
    // the file actually exists — a missing/renamed logo should never break the
    // whole receipt email, just silently omit the image.
    const hasLogo = fs.existsSync(RECEIPT_LOGO_PATH);
    const logoHtml = hasLogo
        ? `<img src="cid:cspc-logo" alt="CSPC Logo" width="72" style="display:block;margin:0 auto 12px;max-width:72px;width:72px;height:auto;">`
        : '';

    // Full standalone HTML document (not just a fragment) so Gmail's mobile app
    // and web client both respect the <meta viewport> tag and the <style>
    // block's @media query below — that's what makes the layout genuinely
    // reflow on a phone screen instead of just being a narrow div.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CSM Survey Receipt</title>
<style>
    body { margin:0; padding:0; background:#eef1f6; }
    table { border-collapse:collapse; }
    .receipt-wrap { width:100%; max-width:600px; margin:0 auto; }
    .receipt-outer { padding:24px 16px; }
    @media only screen and (max-width:600px) {
        .receipt-outer { padding:16px 8px !important; }
        .receipt-card { border-radius:0 !important; }
        .receipt-header { padding:24px 20px !important; }
        .receipt-body { padding:20px !important; }
        .receipt-header h1 { font-size:18px !important; }
        .receipt-header p { font-size:12px !important; }
    }
</style>
</head>
<body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
        <tr>
            <td class="receipt-outer" align="center">
                <table role="presentation" class="receipt-wrap" cellpadding="0" cellspacing="0">
                    <tr>
                        <td class="receipt-card" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">

                            <!-- Header -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-header" style="background:#251d3a;padding:32px 28px;text-align:center;">
                                        ${logoHtml}
                                        <p style="margin:0 0 2px;color:#dbe4fb;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;">Republic of the Philippines</p>
                                        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Camarines Sur Polytechnic Colleges</h1>
                                        <p style="margin:6px 0 0;color:#dbe4fb;font-size:13px;">Client Satisfaction Measurement (CSM) Survey — Official Receipt</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Reference strip -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="padding:14px 28px;border-bottom:1px dashed #cbd5e1;background:#f8fafc;text-align:center;">
                                        <span style="font-size:11px;color:#64748b;letter-spacing:.04em;text-transform:uppercase;">Reference No.</span>
                                        <span style="display:block;font-size:16px;font-weight:700;color:#251d3a;font-family:'Courier New',monospace;letter-spacing:.03em;">CSM-${receipt.surveyResponseId}</span>
                                    </td>
                                </tr>
                            </table>

                            <!-- Body -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-body" style="padding:28px;color:#1e293b;">
                                        <p style="margin:0 0 8px;font-size:15px;">Hi <strong>${escapeHtml(receipt.name)}</strong>,</p>
                                        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">Thank you for completing the CSM survey. This email is your official, system-generated proof of submission — no further action or signature is required.</p>

                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                            ${detailRow('Name', escapeHtml(receipt.name))}
                                            ${detailRow('Office Visited', receipt.officeName)}
                                            ${detailRow('Service Availed', escapeHtml(receipt.serviceAvailed))}
                                            ${detailRow('Date Submitted', receipt.submittedAt)}
                                            ${detailRow('Cluster', receipt.clusterName || 'N/A')}
                                            ${detailRow('Client Type', escapeHtml(receipt.clientType))}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Citizen's Charter (CC)</h3>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;">
                                            ${ccRowsHtml}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Service Quality Dimension Ratings</h3>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                                            ${sqdRowsHtml}
                                        </table>

                                        ${commentsHtml}

                                        <p style="margin:24px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.6;">This is an automated message from the CSPC Center for Quality Assurance. If you did not take this survey, please disregard this email. No file is attached — this email in full is your receipt.</p>
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    // contentDisposition:'inline' is the critical field — without it Gmail
    // lists this as a separate downloadable attachment chip even though the
    // HTML only ever references it inline via cid:cspc-logo.
    const attachments = hasLogo ? [{
        filename: 'cspc-logo.png',
        path: RECEIPT_LOGO_PATH,
        cid: 'cspc-logo',
        contentDisposition: 'inline'
    }] : [];

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: `CSM Survey Receipt — ${receipt.officeName} (Ref: CSM-${receipt.surveyResponseId})`,
        html,
        attachments
    }).then(() => {
        console.log(`✅ [Mail] Survey receipt sent to ${toEmail}`);
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send survey receipt to ${toEmail}:`, err.message);
    });
}

// Sent instead of the generic receipt (see skipReceiptEmail in the
// /office-approvals/:id/approve route) when a personal-email submission held
// in pending_survey_submissions is reviewed and approved by the office the
// client claims to have visited. Distinct from sendSurveyReceiptEmail above:
// that one confirms "we received your answers", this one confirms "the office
// reviewed and approved them" — and, per the client's request, shows the full
// result INSIDE the Gmail message itself (same SQD table layout as the
// receipt email) instead of linking out to the system, so there's no
// redirect/login step standing between "View Result" and actually seeing it.
// Fire-and-forget, same reasoning as sendSurveyReceiptEmail.
function sendSurveyApprovedEmail(toEmail, details) {
    if (!mailTransporter || !toEmail || toEmail === 'Not Specified') return;

    const sqdRowsHtml = details.sqd.map((r, idx) => `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;color:#334155;">${sqdStatementFor(r.label)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};text-align:center;font-weight:700;font-size:13px;color:#251d3a;width:70px;">${r.value === null ? 'N/A' : (r.value === 0 ? 'N/A' : r.value + ' / 5')}</td>
        </tr>`).join('');

    const detailRow = (label, value) => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:13px;font-weight:700;color:#64748b;width:42%;vertical-align:top;">${label}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:14px;font-weight:600;color:#0f172a;vertical-align:top;">${value}</td>
        </tr>`;

    const hasLogo = fs.existsSync(RECEIPT_LOGO_PATH);
    const logoHtml = hasLogo
        ? `<img src="cid:cspc-logo" alt="CSPC Logo" width="72" style="display:block;margin:0 auto 12px;max-width:72px;width:72px;height:auto;">`
        : '';

    const ccRowsHtml = ['cc1', 'cc2', 'cc3'].map((key, idx) => `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;font-weight:700;color:#251d3a;width:60px;">${key.toUpperCase()}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;color:#334155;">${escapeHtml(details[key] || 'N/A')}</td>
        </tr>`).join('');

    const commentsHtml = details.comments && details.comments !== 'N/A'
        ? `<h3 style="margin:20px 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Your Comment</h3>
           <p style="margin:0;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13.5px;color:#334155;line-height:1.6;">${escapeHtml(details.comments)}</p>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Survey Has Been Approved</title>
<style>
    body { margin:0; padding:0; background:#eef1f6; }
    table { border-collapse:collapse; }
    .receipt-wrap { width:100%; max-width:600px; margin:0 auto; }
    .receipt-outer { padding:24px 16px; }
    @media only screen and (max-width:600px) {
        .receipt-outer { padding:16px 8px !important; }
        .receipt-card { border-radius:0 !important; }
        .receipt-header { padding:24px 20px !important; }
        .receipt-body { padding:20px !important; }
        .receipt-header h1 { font-size:18px !important; }
        .receipt-header p { font-size:12px !important; }
    }
</style>
</head>
<body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
        <tr>
            <td class="receipt-outer" align="center">
                <table role="presentation" class="receipt-wrap" cellpadding="0" cellspacing="0">
                    <tr>
                        <td class="receipt-card" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">

                            <!-- Header -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-header" style="background:#251d3a;padding:32px 28px;text-align:center;">
                                        ${logoHtml}
                                        <p style="margin:0 0 2px;color:#dbe4fb;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;">Republic of the Philippines</p>
                                        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Camarines Sur Polytechnic Colleges</h1>
                                        <p style="margin:6px 0 0;color:#dbe4fb;font-size:13px;">Client Satisfaction Measurement (CSM) Survey</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Approved banner -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="padding:18px 28px;border-bottom:1px dashed #cbd5e1;background:#f0fdf4;text-align:center;">
                                        <span style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:50%;background:#dcfce7;color:#16a34a;font-size:18px;font-weight:700;margin-bottom:6px;">&#10003;</span>
                                        <div style="font-size:15px;font-weight:700;color:#166534;">Your survey has been approved</div>
                                        <div style="font-size:11px;color:#64748b;letter-spacing:.04em;text-transform:uppercase;margin-top:4px;">Reference No. CSM-${details.surveyResponseId}</div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Body -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-body" style="padding:28px;color:#1e293b;">
                                        <p style="margin:0 0 8px;font-size:15px;">Hi <strong>${escapeHtml(details.name)}</strong>,</p>
                                        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;"><strong>${details.officeName}</strong> has reviewed and approved the CSM survey you submitted${details.serviceAvailed ? ` for <strong>${escapeHtml(details.serviceAvailed)}</strong>` : ''}. Below is the full result of what you answered — no need to sign in anywhere to see it.</p>

                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                            ${detailRow('Name', escapeHtml(details.name))}
                                            ${detailRow('Office Visited', details.officeName)}
                                            ${detailRow('Service Availed', escapeHtml(details.serviceAvailed))}
                                            ${detailRow('Date Submitted', details.submittedAt)}
                                            ${detailRow('Cluster', details.clusterName || 'N/A')}
                                            ${detailRow('Client Type', escapeHtml(details.clientType))}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Citizen's Charter (CC)</h3>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;">
                                            ${ccRowsHtml}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Service Quality Dimension Ratings</h3>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                                            ${sqdRowsHtml}
                                        </table>

                                        ${commentsHtml}

                                        <p style="margin:24px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.6;">This is an automated message from the CSPC Center for Quality Assurance. This email in full is your result — no further action is required.</p>
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const attachments = hasLogo ? [{
        filename: 'cspc-logo.png',
        path: RECEIPT_LOGO_PATH,
        cid: 'cspc-logo',
        contentDisposition: 'inline'
    }] : [];

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: `Your CSM Survey Was Approved — ${details.officeName} (Ref: CSM-${details.surveyResponseId})`,
        html,
        attachments
    }).then(() => {
        console.log(`✅ [Mail] Approval notification sent to ${toEmail}`);
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send approval notification to ${toEmail}:`, err.message);
    });
}

// The decline-side counterpart to sendSurveyApprovedEmail above. Personal
// (non-@cspc.edu.ph) accounts are the only ones whose submissions ever sit in
// pending_survey_submissions at all — see isCspcEmail — so every caller of
// this is by construction a personal-email client, and Gmail is the only
// place they'd otherwise never hear about the outcome: before this, a decline
// only produced an in-app notification (createClientNotification), which a
// client who never signs back in would simply never see.
// Deliberately does NOT echo the SQD/CC answers back the way the approval
// email does — nothing was recorded, so there is no "result" to show; what
// the client actually needs is the office, the service, the reason, and what
// to do next. Fire-and-forget, same reasoning as sendSurveyApprovedEmail: a
// slow or failed send must never affect the office's decline response.
function sendSurveyDeclinedEmail(toEmail, details) {
    if (!mailTransporter || !toEmail || toEmail === 'Not Specified') return;

    const detailRow = (label, value) => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:13px;font-weight:700;color:#64748b;width:42%;vertical-align:top;">${label}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:14px;font-weight:600;color:#0f172a;vertical-align:top;">${value}</td>
        </tr>`;

    const hasLogo = fs.existsSync(RECEIPT_LOGO_PATH);
    const logoHtml = hasLogo
        ? `<img src="cid:cspc-logo" alt="CSPC Logo" width="72" style="display:block;margin:0 auto 12px;max-width:72px;width:72px;height:auto;">`
        : '';

    // A blank decline_reason is normal — the office isn't required to type
    // one — so fall back to a neutral sentence instead of an empty red box.
    const reasonText = (details.reason && String(details.reason).trim())
        ? String(details.reason).trim()
        : 'No specific reason was provided by the office.';

    const serviceLine = (details.serviceAvailed && details.serviceAvailed !== 'Not specified')
        ? ` for <strong>${escapeHtml(details.serviceAvailed)}</strong>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Survey Was Not Approved</title>
<style>
    body { margin:0; padding:0; background:#eef1f6; }
    table { border-collapse:collapse; }
    .receipt-wrap { width:100%; max-width:600px; margin:0 auto; }
    .receipt-outer { padding:24px 16px; }
    @media only screen and (max-width:600px) {
        .receipt-outer { padding:16px 8px !important; }
        .receipt-card { border-radius:0 !important; }
        .receipt-header { padding:24px 20px !important; }
        .receipt-body { padding:20px !important; }
        .receipt-header h1 { font-size:18px !important; }
        .receipt-header p { font-size:12px !important; }
    }
</style>
</head>
<body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
        <tr>
            <td class="receipt-outer" align="center">
                <table role="presentation" class="receipt-wrap" cellpadding="0" cellspacing="0">
                    <tr>
                        <td class="receipt-card" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">

                            <!-- Header -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-header" style="background:#251d3a;padding:32px 28px;text-align:center;">
                                        ${logoHtml}
                                        <p style="margin:0 0 2px;color:#dbe4fb;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;">Republic of the Philippines</p>
                                        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Camarines Sur Polytechnic Colleges</h1>
                                        <p style="margin:6px 0 0;color:#dbe4fb;font-size:13px;">Client Satisfaction Measurement (CSM) Survey</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Declined banner -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="padding:18px 28px;border-bottom:1px dashed #cbd5e1;background:#fef2f2;text-align:center;">
                                        <span style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:50%;background:#fee2e2;color:#dc2626;font-size:20px;font-weight:700;margin-bottom:6px;">&#33;</span>
                                        <div style="font-size:15px;font-weight:700;color:#991b1b;">Your survey was not approved</div>
                                        <div style="font-size:11px;color:#64748b;letter-spacing:.04em;text-transform:uppercase;margin-top:4px;">Submission Ref. PSS-${details.submissionId}</div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Body -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-body" style="padding:28px;color:#1e293b;">
                                        <p style="margin:0 0 8px;font-size:15px;">Hi <strong>${escapeHtml(details.name)}</strong>,</p>
                                        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;"><strong>${escapeHtml(details.officeName)}</strong> reviewed the CSM survey you submitted${serviceLine} and did <strong>not</strong> approve it, so your answers were not added to the office's records.</p>

                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                            ${detailRow('Name', escapeHtml(details.name))}
                                            ${detailRow('Office Visited', escapeHtml(details.officeName))}
                                            ${detailRow('Service Availed', escapeHtml(details.serviceAvailed))}
                                            ${detailRow('Date Reviewed', details.reviewedAt)}
                                            ${detailRow('Status', '<span style="color:#b91c1c;">Not Approved</span>')}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Reason From The Office</h3>
                                        <p style="margin:0 0 24px;padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;font-size:13.5px;color:#7f1d1d;line-height:1.6;">${escapeHtml(reasonText)}</p>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">What You Can Do Next</h3>
                                        <p style="margin:0;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13.5px;color:#334155;line-height:1.6;">If you believe this was a mistake, you may answer the CSM survey again for this office and service, or contact the office directly to confirm your visit before re-submitting.</p>

                                        <p style="margin:24px 0 0;font-size:11.5px;color:#94a3b8;line-height:1.6;">This is an automated message from the CSPC Center for Quality Assurance. Please do not reply to this email.</p>
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const attachments = hasLogo ? [{
        filename: 'cspc-logo.png',
        path: RECEIPT_LOGO_PATH,
        cid: 'cspc-logo',
        contentDisposition: 'inline'
    }] : [];

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: `Your CSM Survey Was Not Approved — ${details.officeName}`,
        html,
        attachments
    }).then(() => {
        console.log(`✅ [Mail] Decline notification sent to ${toEmail}`);
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send decline notification to ${toEmail}:`, err.message);
    });
}

// Looks up the office name for a declined submission and sends the decline
// email — shared by BOTH decline paths (the office's own
// /office-approvals/:id/decline, and the approve route's
// superseded-by-an-online-submission branch, which also ends in a decline) so
// the client gets the same Gmail message either way. Kept as a callback query
// rather than an awaited one because both call sites fire it AFTER their
// response has already been sent, and neither may block on it.
function notifyClientOfDecline(toEmail, officeId, details) {
    if (!mailTransporter || !toEmail) return;
    db.query('SELECT office_name FROM offices WHERE id = ? LIMIT 1', [officeId], (officeErr, officeRows) => {
        const office = (!officeErr && officeRows && officeRows[0]) ? officeRows[0] : null;
        sendSurveyDeclinedEmail(toEmail, {
            name: details.name || 'Client',
            officeName: office ? office.office_name : 'Selected Office',
            serviceAvailed: details.serviceAvailed || 'Not specified',
            reviewedAt: new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE }),
            reason: details.reason,
            submissionId: details.submissionId
        });
    });
}

// Sends a client a one-time password-reset link (see /forgot-password below).
// Fire-and-forget, same reasoning as sendSurveyReceiptEmail — a slow/failed
// send should never surface as an error to the person requesting the reset
// (that response is intentionally generic either way, to avoid confirming
// whether a given email has an account at all).
function sendPasswordResetEmail(toEmail, resetUrl) {
    if (!mailTransporter || !toEmail) return;

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#eef1f6;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px -12px rgba(15,23,42,.15);">
                    <tr>
                        <td style="background:#251d3a;padding:20px 28px;">
                            <span style="color:#ffffff;font-weight:700;font-size:16px;">CSPC Center for Quality Assurance</span>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:28px;">
                            <h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;">Reset your password</h2>
                            <p style="margin:0 0 20px;color:#475569;font-size:13.5px;line-height:1.6;">
                                We received a request to reset the password for your CQA Client Satisfaction Survey account (${toEmail}).
                                This link is valid for 30 minutes and can only be used once.
                            </p>
                            <p style="text-align:center;margin:0 0 20px;">
                                <a href="${resetUrl}" style="display:inline-block;background:#251d3a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;">Reset Password</a>
                            </p>
                            <p style="margin:0;color:#94a3b8;font-size:11.5px;line-height:1.6;">
                                If you didn't request this, you can safely ignore this email — your password will not be changed.
                                If the button above doesn't work, copy and paste this link into your browser:<br>
                                <span style="word-break:break-all;">${resetUrl}</span>
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: 'Reset your CQA Survey account password',
        html
    }).then(() => {
        console.log(`✅ [Mail] Password reset link sent to ${toEmail}`);
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send password reset link to ${toEmail}:`, err.message);
    });
}

// Sent only after a CSPC-institutional offline survey has been verified
// (password matched) AND already inserted into survey_responses — see
// POST /api/offline-surveys/verify-and-sync. Never sent to an address that
// hasn't just proven ownership via a correct password, so this can't be used
// to spam an arbitrary typed-in address.
function sendOfflineSurveySyncedEmail(toEmail, details) {
    if (!mailTransporter || !toEmail) return;
    console.log('[Mailer] Sending offline survey email');

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#eef1f6;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px -12px rgba(15,23,42,.15);">
                    <tr>
                        <td style="background:#251d3a;padding:20px 28px;">
                            <span style="color:#ffffff;font-weight:700;font-size:16px;">CSPC Center for Quality Assurance</span>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:28px;">
                            <h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;">CQA Survey Submission Successful</h2>
                            <p style="margin:0 0 20px;color:#475569;font-size:13.5px;line-height:1.6;">
                                Your Client Satisfaction Survey response — completed offline and verified once your device reconnected — has been successfully synchronized and submitted to the CQA system.
                            </p>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#334155;margin-bottom:20px;">
                                <tr><td style="padding:4px 0;color:#64748b;">Office Visited:</td><td style="padding:4px 0;font-weight:600;">${details.officeName}</td></tr>
                                <tr><td style="padding:4px 0;color:#64748b;">Service Availed:</td><td style="padding:4px 0;font-weight:600;">${details.serviceAvailed}</td></tr>
                                <tr><td style="padding:4px 0;color:#64748b;">Date Submitted:</td><td style="padding:4px 0;font-weight:600;">${details.submittedAt}</td></tr>
                                <tr><td style="padding:4px 0;color:#64748b;">Reference Number:</td><td style="padding:4px 0;font-weight:600;">CSM-${details.surveyResponseId}</td></tr>
                            </table>
                            <p style="margin:0;color:#94a3b8;font-size:11.5px;line-height:1.6;">Thank you for providing your feedback. This is an automated message — no further action is required.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: `CQA Survey Submission Successful (Ref: CSM-${details.surveyResponseId})`,
        html
    }).then(() => {
        console.log(`✅ [Mail] Offline sync success notification sent to ${toEmail}`);
        console.log('[Mailer] Email accepted');
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send offline sync success notification to ${toEmail}:`, err.message);
        console.error('[Mailer] Send failed:', err.message);
    });
}

// Sent only after an external/Gmail offline survey has been verified
// (password matched) AND already queued into pending_survey_submissions —
// same non-abuse reasoning as sendOfflineSurveySyncedEmail above.
function sendOfflineSurveyPendingEmail(toEmail, details) {
    if (!mailTransporter || !toEmail) return;
    console.log('[Mailer] Sending offline survey email');

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#eef1f6;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px -12px rgba(15,23,42,.15);">
                    <tr>
                        <td style="background:#251d3a;padding:20px 28px;">
                            <span style="color:#ffffff;font-weight:700;font-size:16px;">CSPC Center for Quality Assurance</span>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:28px;">
                            <h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;">CQA Survey Submission Pending Verification</h2>
                            <p style="margin:0 0 12px;color:#475569;font-size:13.5px;line-height:1.6;">
                                Your survey — completed offline and verified once your device reconnected — has been successfully synchronized.
                            </p>
                            <p style="margin:0 0 20px;color:#475569;font-size:13.5px;line-height:1.6;">
                                Because your account is not a CSPC institutional account, your response has been forwarded to <strong>${details.officeName}</strong> for review. You will be notified once the review is complete.
                            </p>
                            <p style="margin:0;color:#94a3b8;font-size:11.5px;line-height:1.6;">This is an automated message — no further action is required at this time.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: 'CQA Survey Submission Pending Verification',
        html
    }).then(() => {
        console.log(`✅ [Mail] Offline sync pending-approval notification sent to ${toEmail}`);
        console.log('[Mailer] Email accepted');
    }).catch((err) => {
        console.error(`❌ [Mail] Failed to send offline sync pending-approval notification to ${toEmail}:`, err.message);
        console.error('[Mailer] Send failed:', err.message);
    });
}

// ==========================================
// IN-APP CLIENT NOTIFICATIONS
// ==========================================
// Creates one client notification for a real server event — never for a
// purely local/browser condition (offline, network unavailable, a
// temporary 429/5xx, a retry still pending) since the server never
// observes those and cannot truthfully report an event it didn't receive.
//
// Idempotent via `dedupe_key`'s UNIQUE constraint: INSERT IGNORE silently
// no-ops on a repeat (an offline sync retry, a race between two requests)
// instead of erroring or duplicating — and because a soft-deleted
// notification's row still physically exists (only deleted_at is set), the
// same dedupe_key also can never resurrect one the user already deleted.
//
// Deliberately fire-and-forget / non-blocking: this is always called AFTER
// its caller's own core transaction (survey insert, office approval) has
// already committed, so a failure here must never roll that back — it's
// logged and swallowed, exactly like the mailer calls right above it.
function createClientNotification({
    clientEmail, type, title, message,
    surveyResponseId = null, pendingSubmissionId = null, offlineSubmissionId = null,
    dedupeKey
}) {
    if (!clientEmail || !dedupeKey) return;
    db.query(
        `INSERT IGNORE INTO client_notifications
         (client_email, type, title, message, survey_response_id, pending_submission_id, offline_submission_id, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientEmail, type, title, message, surveyResponseId, pendingSubmissionId, offlineSubmissionId, dedupeKey],
        (err) => {
            if (err) console.error('❌ [Notifications] Failed to create notification:', err.message);
        }
    );
}

// ==========================================
// AUTO-CREATE TABLES & AUTO-UPDATE
// ==========================================

// 1. Table para sa mga Clusters
const createClustersTableQuery = `
CREATE TABLE IF NOT EXISTS clusters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cluster_name VARCHAR(150) NOT NULL UNIQUE,
    is_archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

// 2. Table para sa mga Offices
const createOfficesTableQuery = `
CREATE TABLE IF NOT EXISTS offices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cluster_name VARCHAR(150) NOT NULL,
    office_name VARCHAR(255) NOT NULL,
    head_director VARCHAR(255) DEFAULT 'Not Assigned',
    email_address VARCHAR(255) NOT NULL,
    is_archived TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

// 3. Table para sa Survey Responses
const createSurveyTableQuery = `
CREATE TABLE IF NOT EXISTS survey_responses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    respondent_name VARCHAR(255) DEFAULT 'Anonymous',
    topic VARCHAR(100) DEFAULT 'General',
    sentiment VARCHAR(50) DEFAULT 'Neutral',
    region VARCHAR(100) NULL,
    cc1 VARCHAR(100) NULL, 
    cc2 VARCHAR(100) NULL, 
    cc3 VARCHAR(100) NULL,
    sqd0 INT NULL, sqd1 INT NULL, sqd2 INT NULL, sqd3 INT NULL, 
    sqd4 INT NULL, sqd5 INT NULL, sqd6 INT NULL, sqd7 INT NULL, sqd8 INT NULL,
    comments TEXT NULL,
    period_year_quarter VARCHAR(50) DEFAULT 'Jan to June 2026',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);`;

// Multi-topic tagging project (2026-09-25): a comment that clearly names
// multiple distinct things (see gemini_model.py's MAX_TOPICS) gets more than
// one topic. survey_responses.topic stays the PRIMARY/first topic exactly as
// before — every existing dashboard/report/notification query keeps working
// unchanged against it — and this table holds only the EXTRA topics beyond
// the first, so "all topics for this comment" is `topic` UNION this table's
// rows (ordered by sort_order, which preserves Gemini's own array order).
// A no-feedback/junk comment never gets a row here (no analysis to name a
// second topic from).
const createSurveyResponseTopicsTableQuery = `
CREATE TABLE IF NOT EXISTS survey_response_topics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_response_id INT NOT NULL,
    topic VARCHAR(150) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);`;

// 3b. Table para sa Services ng bawat Office (ginagamit ng dependent
// "Service Availed" dropdown sa client-survey.ejs — see #serviceSelect)
const createServicesTableQuery = `
CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);`;

// Holds survey submissions from non-@cspc.edu.ph accounts until the office the
// client claims to have visited verifies and approves them — see /office-approvals.
// Approved rows get replayed into survey_responses (see finalizeVerifiedSurvey) and
// this row is kept (status flipped) as an audit trail rather than deleted.
const createPendingSurveySubmissionsTableQuery = `
CREATE TABLE IF NOT EXISTS pending_survey_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    google_email VARCHAR(255) NOT NULL,
    service_availed VARCHAR(255) NULL,
    payload JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    decline_reason VARCHAR(255) NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);`;

// Tracks outcomes of the unauthenticated offline-survey verify-and-sync flow
// (see POST /api/offline-surveys/verify-and-sync). Two jobs: (1) the
// UNIQUE key on offline_submission_id is the idempotency guard — a retried
// or duplicated sync request for the same client-generated UUID is answered
// from this row instead of re-inserting: (2) a lightweight record of the
// outcome. Deliberately holds NO password/hash/credential of any kind —
// only ever written after a password has already been verified and
// discarded, never on a failed attempt (nothing to be idempotent about, and
// nothing worth recording tied to a guess).
const createOfflineSurveySubmissionsTableQuery = `
CREATE TABLE IF NOT EXISTS offline_survey_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    offline_submission_id VARCHAR(64) NOT NULL,
    registered_identifier VARCHAR(255) NOT NULL,
    office_id INT NULL,
    verification_status ENUM('verified','external_account') NOT NULL,
    -- 'pending' -> 'approved'/'rejected' once the visited office acts on the
    -- linked pending_survey_submissions row — see the /office-approvals
    -- approve/decline routes, which keep this column in sync.
    approval_status ENUM('not_required','pending','approved','rejected') NOT NULL DEFAULT 'not_required',
    survey_response_id INT NULL,
    pending_submission_id INT NULL,
    created_offline_at DATETIME NULL,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_offline_submission_id (offline_submission_id)
);`;

// In-app client notification inbox. `client_email` matches this app's
// existing stable account identifier (client_accounts.email — the same
// value req.clientEmail/googleEmail/verifiedEmail carries everywhere else
// in this file; no separate numeric account id is used consistently enough
// elsewhere to prefer it here). dedupe_key's UNIQUE constraint is what
// makes notification creation idempotent — see createClientNotification
// below: an offline sync retry (or a race between two tabs) safely no-ops
// via INSERT IGNORE instead of creating a duplicate, and critically, this
// also means a notification the user already soft-deleted (deleted_at set,
// row still physically present) is never recreated by a later replay of
// the same event, since the UNIQUE constraint still matches the existing
// row regardless of deleted_at. Soft delete only (deleted_at) — a
// notification is never physically removed by this app.
const createClientNotificationsTableQuery = `
CREATE TABLE IF NOT EXISTS client_notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_email VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    survey_response_id INT NULL,
    pending_submission_id INT NULL,
    offline_submission_id VARCHAR(64) NULL,
    dedupe_key VARCHAR(191) NOT NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP NULL DEFAULT NULL,
    deleted_at TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY unique_client_notification_dedupe (dedupe_key),
    INDEX idx_client_notifications_email (client_email),
    INDEX idx_client_notifications_inbox (client_email, deleted_at, created_at),
    INDEX idx_client_notifications_unread (client_email, is_read, deleted_at)
);`;

const createSettingsTableQuery = `
CREATE TABLE IF NOT EXISTS survey_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const createClientTypesTableQuery = `
CREATE TABLE IF NOT EXISTS client_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type_name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const createClientProfilesTableQuery = `
CREATE TABLE IF NOT EXISTS client_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_response_id INT NOT NULL,
    respondent_name VARCHAR(255) DEFAULT 'Anonymous',
    client_type VARCHAR(100) DEFAULT 'Citizen',
    age VARCHAR(50) NULL,
    gender VARCHAR(50) NULL,
    region VARCHAR(100) NULL,
    email VARCHAR(255) NULL,
    office_visited_time DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);`;

// Bookkeeping for one-off DATA migrations (as opposed to the ALTER TABLEs
// above, which are idempotent by nature and can safely re-run every boot). A
// data backfill is not idempotent in the same way: once an admin edits or
// deletes what it seeded, re-running it undoes that edit. One row per migration
// name records that it has happened.
const createSchemaMigrationsTableQuery = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

// Calls back with true on the single startup that gets to run `name`, and false
// on every startup after it. Claiming the marker IS the check -- INSERT IGNORE
// reports affectedRows 1 only for the process that actually inserted the row,
// so two server processes booting at the same time can never both run the
// migration (a SELECT-then-INSERT pair would let them). The marker is written
// BEFORE the work, so a migration that fails is not retried on the next boot:
// deliberate, because a half-applied backfill re-running is how rows an admin
// has since deleted come back.
function runOnce(name, callback) {
    db.query(createSchemaMigrationsTableQuery, (createErr) => {
        if (createErr) {
            console.error(`❌ Could not create schema_migrations — skipping one-time migration '${name}':`, createErr.message);
            return callback(false);
        }
        db.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [name], (claimErr, result) => {
            if (claimErr) {
                console.error(`❌ Could not claim one-time migration '${name}':`, claimErr.message);
                return callback(false);
            }
            callback(!!result && result.affectedRows === 1);
        });
    });
}

// One row per Google/registered-client account. Holds the demographic details
// (region, age, gender) locked-in from that account's FIRST survey submission,
// plus lets registered clients log in via the regular /login form.
const createClientAccountsTableQuery = `
CREATE TABLE IF NOT EXISTS client_accounts (
    email VARCHAR(255) PRIMARY KEY,
    respondent_name VARCHAR(255) NULL,
    password VARCHAR(255) NULL,
    google_photo_url VARCHAR(500) NULL,
    region VARCHAR(100) NULL,
    age VARCHAR(50) NULL,
    gender VARCHAR(50) NULL,
    onboarding_completed TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;

// ==========================================
// ACCOUNT DELETION -> PURGE EVERYTHING IT OWNS
// ==========================================
// client_accounts.email is this app's account identifier, and every
// per-account row elsewhere stores that email as a plain column, not as a
// foreign key (see client_notifications' table comment). So deleting an
// account — which today only ever happens by hand in the DB, there is no
// delete-account route — left its surveys, its pending/offline submission
// records and its whole notification inbox behind. Registering the same
// email again silently inherited all of it: a brand-new account opening its
// bell to "Survey Approved" notices from the deleted account (and, because
// client_notifications.dedupe_key is UNIQUE and soft-deletes keep the row,
// the leftovers can even suppress the new account's real notifications).
//
// Two parts, because the delete happens outside this app:
//   1. An AFTER DELETE trigger on client_accounts, so a DELETE issued from
//      phpMyAdmin/CLI/anywhere purges the owned rows in the same statement.
//      This is the actual fix — an app-side helper cannot see a hand-made
//      DELETE at all.
//   2. A startup sweep for rows orphaned by deletes that happened BEFORE
//      the trigger existed (i.e. what is already in the DB right now).
//
// Rows with a NULL/blank email are untouched by both: those are the
// anonymous/walk-in submissions, which belong to no account.

// Ordered children-first. client_profiles is purged by email directly as
// well as cascading from survey_responses, so a profile row whose survey
// was already deleted doesn't survive the account it names.
// `stamp` is the column saying when the row was written on THIS server —
// used by the sweep below to spot rows that predate the account that now
// owns their email. offline_survey_submissions uses synced_at, not
// created_offline_at: the latter is client-supplied (when the survey was
// filled in while offline) and is not a claim about this server's clock.
const CLIENT_ACCOUNT_OWNED_ROWS = [
    { table: 'client_notifications',       column: 'client_email',          stamp: 'created_at' },
    { table: 'offline_survey_submissions', column: 'registered_identifier', stamp: 'synced_at' },
    { table: 'pending_survey_submissions', column: 'google_email',          stamp: 'created_at' },
    { table: 'client_profiles',            column: 'email',                 stamp: 'created_at' },
    { table: 'survey_responses',           column: 'google_email',          stamp: 'created_at' }
];

const clientAccountPurgeTriggerBody = CLIENT_ACCOUNT_OWNED_ROWS
    .map(({ table, column }) => `    DELETE FROM ${table} WHERE ${column} = OLD.email;`)
    .join('\n');

const createClientAccountPurgeTriggerQuery = `
CREATE TRIGGER trg_client_accounts_purge_owned_rows
AFTER DELETE ON client_accounts
FOR EACH ROW
BEGIN
${clientAccountPurgeTriggerBody}
END`;

// Dropped and recreated on every boot so the trigger in the DB always
// matches the list above (adding a table here is otherwise invisible to a
// database that already has the old trigger installed).
function installClientAccountPurgeTrigger() {
    db.query('DROP TRIGGER IF EXISTS trg_client_accounts_purge_owned_rows', (dropErr) => {
        if (dropErr) {
            // Most likely cause: the DB user has no TRIGGER privilege (common on
            // shared/managed hosting). Say so loudly — without the trigger, a
            // hand-made account delete only gets cleaned up at the NEXT restart,
            // by the sweep below.
            console.error('❌ Could not drop client_accounts purge trigger:', dropErr.message);
            return;
        }
        db.query(createClientAccountPurgeTriggerQuery, (createErr) => {
            if (createErr) console.error('❌ Could not install client_accounts purge trigger — deleting an account will leave its surveys/notifications behind until the next restart:', createErr.message);
            else console.log('✅ client_accounts purge trigger verified/created successfully!');
        });
    });
}

// Fresh-start guard for a re-registration. The trigger above handles a
// delete made from now on, but the account this app is most likely to meet
// in that state is one deleted BEFORE it was installed: the email signs up
// again and its new account row silently adopts the old one's surveys and
// notification inbox. Nothing an account owns can predate the account, so
// anything older than the row just inserted belonged to the deleted one and
// goes. Called only when registration actually INSERTED a new account row
// (see /complete-google-registration) — never when an existing account
// simply re-saved its details.
function purgeRowsPredatingAccount(email, callback) {
    let remaining = CLIENT_ACCOUNT_OWNED_ROWS.length;
    const finish = () => { if (--remaining === 0 && callback) callback(); };
    CLIENT_ACCOUNT_OWNED_ROWS.forEach(({ table, column, stamp }) => {
        db.query(
            `DELETE child FROM ${table} child
             JOIN client_accounts ca ON ca.email = child.${column}
             WHERE child.${column} = ? AND child.${stamp} < ca.created_at - INTERVAL 1 MINUTE`,
            [email],
            (err, result) => {
                // Logged and swallowed: a leftover row must never be the reason
                // a registration fails — the startup sweep below catches
                // whatever this missed.
                if (err) console.error(`❌ [Account] Could not clear old ${table} rows for ${email}:`, err.message);
                else if (result && result.affectedRows > 0) console.log(`🧹 [Account] Cleared ${result.affectedRows} ${table} row(s) from a previous account under ${email}.`);
                finish();
            }
        );
    });
}

// Cleans up what deletes made before the trigger existed left behind. Two
// distinct leftovers, both belonging to an account that no longer exists:
//
//   orphaned — the email has no client_accounts row at all.
//     Safe against legacy pre-account-system data: every authenticated
//     survey upserts client_accounts (see insertVerifiedSurveyOnConnection),
//     and the one-time client_profiles backfill above already seeded
//     accounts for older rows, so "no account row" really does mean "that
//     account was deleted".
//
//   inherited — the email HAS an account row, but the child row predates
//     it. This is the re-registration case: delete the account, sign up
//     again with the same email, and the new account adopts the old one's
//     surveys and notification inbox. Nothing an account owns can exist
//     before that account was created, so anything older belongs to the
//     deleted one. The one-minute grace guards the only case where the two
//     timestamps legitimately coincide: the account row and its first
//     survey are written in the SAME transaction (again, see
//     insertVerifiedSurveyOnConnection), and both columns are second-
//     precision, so they can land a tick apart in either order.
function sweepOrphanedClientAccountRows() {
    CLIENT_ACCOUNT_OWNED_ROWS.forEach(({ table, column, stamp }) => {
        db.query(
            `DELETE child FROM ${table} child
             LEFT JOIN client_accounts ca ON ca.email = child.${column}
             WHERE child.${column} IS NOT NULL AND child.${column} <> ''
               AND (ca.email IS NULL
                    OR child.${stamp} < ca.created_at - INTERVAL 1 MINUTE)`,
            (err, result) => {
                if (err) console.error(`❌ Could not sweep ${table} rows left by deleted client account(s):`, err.message);
                else if (result && result.affectedRows > 0) console.log(`🧹 Removed ${result.affectedRows} ${table} row(s) left behind by deleted client account(s).`);
            }
        );
    });
}

// One row per admin user account — replaces the old hardcoded admin/admin123 login.
const createAdminsTableQuery = `
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    fullname VARCHAR(255) NOT NULL,
    gender VARCHAR(50) DEFAULT 'Male',
    role VARCHAR(50) DEFAULT 'Admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

// One row per admin login session — closed off (logout_time filled in) on
// /logout or when /login treats an active session as an implicit logout.
const createAdminLogsTableQuery = `
CREATE TABLE IF NOT EXISTS admin_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL DEFAULT 'admin',
    login_time DATETIME NOT NULL,
    logout_time DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

db.query(createAdminsTableQuery, (err) => {
    if (err) {
        console.error("❌ Error creating admins table:", err);
        return;
    }
    console.log('✅ admins table verified/created successfully!');

    // Seed the two original accounts once, so a fresh database still boots with
    // working admin logins (existing databases keep whatever's already in there).
    // Stored as bcrypt hashes (not plaintext) so a leaked DB dump/backup alone
    // doesn't hand over working credentials — verifyAdminPassword already
    // supports bcrypt rows via isBcryptHash(), same as any password changed
    // through Manage Admins. The default password VALUES are still fixed and
    // documented here for first-login purposes only — deployers MUST change
    // both immediately after first login (see the console warning below).
    db.query('SELECT COUNT(*) AS count FROM admins', (err, result) => {
        if (!err && result[0].count === 0) {
            (async () => {
                try {
                    const hash1 = await bcrypt.hash('francis123', 10);
                    const hash2 = await bcrypt.hash('arnel123', 10);
                    db.query(
                        `INSERT INTO admins (username, password, fullname, gender, role) VALUES
                         (?, ?, 'Francis James Obis', 'Male', 'Super Admin'),
                         (?, ?, 'Arnel Marquina', 'Male', 'Admin')`,
                        ['admin1', hash1, 'admin2', hash2],
                        (seedErr) => {
                            if (seedErr) {
                                console.error('❌ Error seeding default admin accounts:', seedErr);
                                return;
                            }
                            console.log('✅ Default admin accounts seeded.');
                            console.warn('⚠️  SECURITY: default admin1/admin2 passwords are the ones documented in server.js — change both via Manage Admins before/immediately after going live.');
                        }
                    );
                } catch (hashErr) {
                    console.error('❌ Error hashing default admin passwords:', hashErr);
                }
            })();
        }
    });

    // admin_logs is created only after admins exists, so its admin_id FK below can resolve.
    db.query(createAdminLogsTableQuery, (err) => {
        if (err) {
            console.error("❌ Error creating admin_logs table:", err);
            return;
        }
        console.log('✅ admin_logs table verified/created successfully!');

        db.query("ALTER TABLE admin_logs ADD COLUMN admin_id INT NULL", () => {
            db.query("ALTER TABLE admin_logs ADD CONSTRAINT fk_admin_logs_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL", () => {});
        });

        // Ties each admin_logs row to the exact browser/device session (req.adminSessionID)
        // that created it, instead of just a free-text username — this is what lets the
        // same admin account log in from multiple tabs/devices and have each show up as
        // its own independent "Active Now" row instead of overwriting one shared row.
        db.query("ALTER TABLE admin_logs ADD COLUMN session_id VARCHAR(255) NULL", () => {});

        // Lets an admin set a custom profile photo (see /api/profile/photo) instead of
        // always falling back to the auto-generated ui-avatars.com initials avatar.
        db.query("ALTER TABLE admins ADD COLUMN photo_url VARCHAR(500) NULL", () => {});

        // Single-active-session enforcement (see ensureAdminAuth / /auth-login):
        // stamped fresh on every admin login, compared against req.adminSession.login_token
        // on every request so a displaced tab/device gets caught even though it shares
        // the same admin.sid cookie as wherever the newer login happened.
        db.query("ALTER TABLE admins ADD COLUMN login_token VARCHAR(255) NULL", () => {});

        // Watermark for the navbar's notification bell: the moment this admin
        // last opened the panel. Anything in survey_responses newer than this
        // counts as unseen (see /api/admin/notifications). Kept as a column on
        // `admins` rather than a per-survey notification row because the surveys
        // themselves already ARE the feed — there is nothing extra to store per
        // event, only "how far has this admin read".
        //
        // The backfill runs ONLY on the request that actually adds the column
        // (a duplicate-column error on every later restart means it's already
        // there), so an existing deployment's entire survey history doesn't
        // land in the bell as unseen the first time an admin logs in after
        // this deploys. An admin added afterwards gets NULL and is read as
        // "seen everything up to when the account was created" — see the
        // COALESCE in /api/admin/notifications.
        db.query("ALTER TABLE admins ADD COLUMN notifications_seen_at DATETIME NULL", (alterErr) => {
            if (alterErr) return;
            db.query("UPDATE admins SET notifications_seen_at = NOW()", () => {});
        });

        // Admin sessions live in an in-memory Map (see the admin session setup near
        // the top of this file) — a server restart wipes every one of them, including
        // req.adminSession.adminLogId, so no browser can ever close these rows via
        // /logout anymore. Left alone they'd
        // show as "Active now" forever. Close them out at the moment of restart,
        // since that's effectively when those sessions actually ended.
        db.query('UPDATE admin_logs SET logout_time = NOW() WHERE logout_time IS NULL', (err, result) => {
            if (err) console.error("❌ Error closing orphaned admin_logs rows:", err);
            else if (result.affectedRows > 0) console.log(`✅ Closed ${result.affectedRows} orphaned admin_logs row(s) from before this restart.`);
        });
    });
});

// ==========================================
// ABANDONED ADMIN SESSION SWEEP
// ==========================================
// Catches the case /logout can never handle: a browser closed, laptop shut, or
// tab left open past its 8h cookie expiry without ever hitting /logout. Every
// few minutes, close out any admin_logs row that still claims to be open but
// whose session_id no longer resolves to anything in the session store.
const ADMIN_LOG_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function sweepAbandonedAdminSessions() {
    db.query('SELECT id, session_id FROM admin_logs WHERE logout_time IS NULL AND session_id IS NOT NULL', async (err, rows) => {
        if (err) return console.error('❌ Error loading open admin_logs rows for the abandoned-session sweep:', err);

        for (const row of (rows || [])) {
            const alive = await isSessionAlive(row.session_id);
            if (!alive) {
                db.query('UPDATE admin_logs SET logout_time = NOW() WHERE id = ? AND logout_time IS NULL', [row.id], (err) => {
                    if (err) console.error(`❌ Error auto-closing abandoned admin_logs row ${row.id}:`, err);
                });
            }
        }
    });
}

setInterval(sweepAbandonedAdminSessions, ADMIN_LOG_SWEEP_INTERVAL_MS);

// SINKRONISADONG PAGGAWA NG MGA TABLE (Para maiwasan ang Foreign Key Errors)
db.query(createClustersTableQuery, (err) => {
    if (err) {
        console.error("❌ Error creating clusters table:", err);
    } else {
        console.log('✅ clusters table verified/created successfully!');
        db.query("ALTER TABLE clusters ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0", () => {});
        // Seed default clusters kung walang laman
        db.query("SELECT COUNT(*) AS count FROM clusters", (err, result) => {
            if (!err && result[0].count === 0) {
                const seedClusters = `INSERT IGNORE INTO clusters (cluster_name) VALUES 
                    ('Office of the President Cluster'),
                    ('Administrative and Finance Cluster'),
                    ('Academic Cluster'),
                    ('Research, Innovation and Collaboration Cluster');`;
                db.query(seedClusters, () => console.log('✅ Default clusters seeded.'));
            }
        });

        // Isunod ang Offices Table
        db.query(createOfficesTableQuery, (err) => {
            if (err) {
                console.error("❌ Error creating offices table:", err);
            } else {
                console.log('✅ offices table verified/created successfully!');
                db.query("ALTER TABLE offices ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0", () => {});
                // Office-side login for the approval panel (offices sign in at /login) — bcrypt
                // hash, set by the super admin via /offices/add or /offices/edit. NULL
                // means this office has no login set up yet.
                db.query("ALTER TABLE offices ADD COLUMN password VARCHAR(255) NULL", () => {});
                // Complete office name for printed reports. Thirteen offices are stored
                // under the acronym staff use day to day (CCS, VPAA, RFOIU, ...) — fine in
                // dropdowns and charts, but the official CSM report has to spell the office
                // out. NULL/blank means office_name is already the full name, and reports
                // fall back to it. Backfilled by migrations/add_office_full_name.sql.
                // The column is added here whether or not the migration ever ran;
                // the backfill right after it is what actually puts the spelled-out
                // names in a database that has only ever seen the acronyms.
                db.query("ALTER TABLE offices ADD COLUMN full_name VARCHAR(255) NULL", () => {
                    backfillOfficeFullNames();
                });

                // Services table (per office) — powers the dependent "Service Availed" dropdown
                db.query(createServicesTableQuery, (err) => {
                    if (err) console.error("❌ Error creating services table:", err);
                    else {
                        console.log('✅ services table verified/created successfully!');
                        // How often the same account may re-survey this service: daily/weekly/
                        // monthly/yearly — see isEligibleForResubmission(). Defaults to 'daily'
                        // for every service, existing or new.
                        db.query("ALTER TABLE services ADD COLUMN availability VARCHAR(20) NOT NULL DEFAULT 'daily'", () => {
                            // Column already existed (pre-migration DBs): backfill NULLs and
                            // enforce the NOT NULL DEFAULT 'daily' constraint on it too.
                            db.query("UPDATE services SET availability = 'daily' WHERE availability IS NULL", () => {});
                            db.query("ALTER TABLE services MODIFY COLUMN availability VARCHAR(20) NOT NULL DEFAULT 'daily'", () => {});
                        });
                    }
                });

                db.query(createPendingSurveySubmissionsTableQuery, (err) => {
                    if (err) console.error("❌ Error creating pending_survey_submissions table:", err);
                    else console.log('✅ pending_survey_submissions table verified/created successfully!');
                    // Which channel queued this pending (office-review) submission —
                    // read by resolveSubmissionPrecedence so a merely-PENDING Offline
                    // row can be preempted by an incoming Online submission for the
                    // same office+account+service, without needing a canonical
                    // survey_responses row to exist yet. Server-derived, same as
                    // survey_responses.submission_source. Historical (pre-fix) rows
                    // default to 'legacy_unknown', NOT 'online' — see the identical
                    // reasoning on survey_responses.submission_source above; never
                    // retroactively reclassified.
                    db.query("ALTER TABLE pending_survey_submissions ADD COLUMN submission_source ENUM('online','offline_sync','legacy_unknown') NOT NULL DEFAULT 'legacy_unknown'", () => {});
                });

                db.query(createOfflineSurveySubmissionsTableQuery, (err) => {
                    if (err) console.error("❌ Error creating offline_survey_submissions table:", err);
                    else console.log('✅ offline_survey_submissions table verified/created successfully!');
                });

                db.query(createClientNotificationsTableQuery, (err) => {
                    if (err) console.error("❌ Error creating client_notifications table:", err);
                    else console.log('✅ client_notifications table verified/created successfully!');
                });

                // Isunod ang Survey Responses Table
                db.query(createSurveyTableQuery, (err) => {
                    if (err) {
                        console.error("❌ Error creating survey_responses table:", err);
                    } else {
                        db.query("ALTER TABLE survey_responses ADD COLUMN respondent_name VARCHAR(255) DEFAULT 'Anonymous'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN topic VARCHAR(100) DEFAULT 'General'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN sentiment VARCHAR(50) DEFAULT 'Neutral'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN region VARCHAR(100) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN google_email VARCHAR(255) NULL", () => {
                            // Replaced by the frequency-aware resubmission check (see
                            // isEligibleForResubmission) — a client may now legitimately submit
                            // more than once per office if the service allows it, so the old
                            // "once ever per office" DB constraint no longer holds.
                            // unique_office_google_email(office_id, google_email) is also the only
                            // index backing the office_id -> offices FK, so MySQL refuses to drop it
                            // until a plain index on office_id exists to take over that job.
                            db.query("CREATE INDEX idx_survey_responses_office_id ON survey_responses(office_id)", () => {
                                db.query("ALTER TABLE survey_responses DROP INDEX unique_office_google_email", () => {});
                            });
                        });
                        // Which service this submission was for — collected by the form since
                        // day one but never persisted until now (see /submit-survey). Drives the
                        // per-service resubmission cooldown.
                        db.query("ALTER TABLE survey_responses ADD COLUMN service_availed VARCHAR(255) NULL", () => {});

                        // Idempotency guard for the ONLINE authenticated survey path (both
                        // direct /submit-survey and queued /sync-surveys retries) — the old
                        // unique_office_google_email constraint above was correctly dropped
                        // because a client CAN legitimately submit the same office more than
                        // once now (different services, or the same service after its cooldown
                        // elapses); it can never come back for that purpose. This is a
                        // different, narrower guarantee: the SAME client-generated submission
                        // ID (see client_submission_id in finalizeVerifiedSurvey) can never
                        // create two rows, whether from a lost-response retry or two
                        // near-simultaneous sync attempts racing each other. NULL is allowed
                        // and multiple NULLs never collide (older rows, or a request that
                        // genuinely didn't send one), so this is purely additive.
                        db.query("ALTER TABLE survey_responses ADD COLUMN client_submission_id VARCHAR(64) NULL", () => {
                            db.query("ALTER TABLE survey_responses ADD UNIQUE KEY unique_client_submission_id (client_submission_id)", () => {});
                        });

                        // Admin manual-correction columns for the AI's sentiment/topic/subtopic
                        // read on a comment (see /api/admin/survey-response/:id/analysis).
                        // Deliberately separate from the existing `topic`/`sentiment` columns
                        // (which stay the raw, untouched AI output) rather than overwriting them,
                        // so an admin correction never destroys what the AI originally predicted.
                        // NULL means "no admin override yet" — the AI value is used as-is.
                        db.query("ALTER TABLE survey_responses ADD COLUMN topic_override VARCHAR(150) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN subtopic_override VARCHAR(100) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN sentiment_override VARCHAR(20) NULL", () => {});

                        // Pure-AI classification project (2026-09-22): a live comment is
                        // inserted with a placeholder topic/sentiment while Gemini analyzes
                        // it in the background (see insertVerifiedSurveyOnConnection's
                        // analysisPending handling) — 'pending' rows are excluded from every
                        // admin-facing display (survey-records, dashboard/report topic &
                        // sentiment breakdowns, the notification bell — see
                        // HAS_AI_ANALYSIS_SQL) until the async classification UPDATE flips
                        // them to 'completed', so an admin never sees a placeholder result
                        // that's about to change. Historical rows default to 'completed' —
                        // they were already fully analyzed (or are genuine no-feedback rows)
                        // long before this column existed, so none of them should newly
                        // disappear from any view.
                        db.query("ALTER TABLE survey_responses ADD COLUMN analysis_status ENUM('pending','completed') NOT NULL DEFAULT 'completed'", () => {});

                        // Multi-topic tagging project (2026-09-25) — see
                        // createSurveyResponseTopicsTableQuery's own comment.
                        db.query(createSurveyResponseTopicsTableQuery, (err) => {
                            if (err) console.error('❌ Error creating survey_response_topics table:', err);
                            else console.log('✅ survey_response_topics table verified/created successfully!');
                        });
                        db.query("CREATE INDEX idx_survey_response_topics_response_id ON survey_response_topics(survey_response_id)", () => {});

                        // ---- Online-vs-Offline canonical precedence (data-consistency fix) ----
                        // Which channel actually created this row, server-derived at insert
                        // time (see insertVerifiedSurveyOnConnection's submissionSource
                        // param) — never trusted from client JSON. Every INSERT this app
                        // performs now always passes an explicit 'online' or 'offline_sync'
                        // (see submitCanonicalSurvey / queuePendingSurveyWithPrecedence), so
                        // the column DEFAULT below is only ever actually used for rows that
                        // existed BEFORE this ALTER TABLE ran — i.e. genuinely unknown-origin
                        // historical rows. Defaulting those to 'legacy_unknown' (NOT 'online')
                        // is deliberate: an earlier version of this fix defaulted them to
                        // 'online', which silently made resolveSubmissionPrecedence treat
                        // every pre-fix row as definitively online — so a real historical
                        // Offline row, mislabeled 'online', could never be superseded by a
                        // genuinely later Online submission for the same still-in-cooldown
                        // opportunity (the new Online submission would be wrongly REJECTED as
                        // "already evaluated" instead of correctly winning). 'legacy_unknown'
                        // is treated the same as 'offline_sync' by resolveSubmissionPrecedence
                        // (i.e. "not known to be online" — Online may still supersede it) —
                        // safe in both directions: if the old row really was online, the new
                        // one still ends up canonical and the old one is merely marked
                        // superseded (preserved, not deleted); if it really was offline, this
                        // is exactly the correct outcome. This ALTER is a no-op if the column
                        // already exists (e.g. from an earlier deployment of this fix, already
                        // defaulted to 'online') — existing values are NEVER rewritten here;
                        // see the migration file's note for how to audit/backfill manually.
                        db.query("ALTER TABLE survey_responses ADD COLUMN submission_source ENUM('online','offline_sync','legacy_unknown') NOT NULL DEFAULT 'legacy_unknown'", () => {});
                        // 'canonical' = counts everywhere (dashboards/reports/records/history).
                        // 'superseded' = a losing row that lost to a later-arriving canonical
                        // Online row for the same office+account+service — kept for audit,
                        // excluded from every analytics/report/history query. DEFAULT
                        // 'canonical' is intentional and safe for historical rows too: nothing
                        // has determined any pre-existing row to be superseded, so every one
                        // of them keeps counting exactly as before until/unless a NEW
                        // submission going forward legitimately supersedes it through the
                        // normal precedence flow — this migration itself never marks any
                        // existing row superseded.
                        db.query("ALTER TABLE survey_responses ADD COLUMN canonical_status ENUM('canonical','superseded') NOT NULL DEFAULT 'canonical'", () => {});
                        // Points at the canonical row that superseded this one (NULL for
                        // every canonical row, and for any row with no known supersession).
                        db.query("ALTER TABLE survey_responses ADD COLUMN superseded_by_id INT NULL", () => {});
                        // Backs resolveSubmissionPrecedence's canonical-row lookup (WHERE
                        // office_id = ? AND google_email = ? AND service_availed <=> ? AND
                        // canonical_status = 'canonical' ORDER BY created_at DESC LIMIT 1) —
                        // without this, that query (run once per submission, inside the
                        // logical-survey lock) would fall back to the existing plain
                        // idx_survey_responses_office_id index and scan every row for that
                        // office, which does not scale to a 500-submission burst.
                        db.query("CREATE INDEX idx_survey_responses_logical_key ON survey_responses(office_id, google_email, service_availed, canonical_status)", () => {});

                        // When this ROW was written, as opposed to created_at, which is
                        // when the CLIENT SUBMITTED (see insertVerifiedSurveyOnConnection).
                        // The two are the same for a live submission and differ for one
                        // replayed later by an office approval. Splitting them is what
                        // lets the survey keep one true submission time everywhere it is
                        // displayed while the admin's notification bell still orders and
                        // counts by actual arrival — otherwise approving a week-old
                        // submission would file it a week back in the feed and never
                        // badge it at all.
                        //
                        // The backfill runs ONLY on the request that actually adds the
                        // column (a duplicate-column error on every later restart means
                        // it is already there). It must run, because MySQL fills existing
                        // rows with the column DEFAULT — i.e. the moment of the ALTER —
                        // which would otherwise stamp the entire archive as having
                        // arrived at deploy time.
                        db.query("ALTER TABLE survey_responses ADD COLUMN recorded_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP", (recordedErr) => {
                            if (!recordedErr) {
                                db.query("UPDATE survey_responses SET recorded_at = created_at", (backfillErr, backfillResult) => {
                                    if (backfillErr) console.error('\u274c Error backfilling survey_responses.recorded_at:', backfillErr);
                                    else console.log(`\u2705 Backfilled recorded_at on ${backfillResult.affectedRows} survey_responses row(s).`);
                                });
                            }
                            // Backs the notification bell's ORDER BY/range scan (see
                            // /api/admin/notifications), which is polled every 30s by
                            // every signed-in admin.
                            db.query("CREATE INDEX idx_survey_responses_recorded_at ON survey_responses(canonical_status, recorded_at)", () => {});
                        });

                        // Pinakahuli ang Client Profiles
                        db.query(createClientProfilesTableQuery, (err) => {
                            if (err) console.error("❌ Error creating client_profiles table:", err);
                            else console.log('✅ client_profiles table verified/created successfully!');
                            // Older deployments created this table before office_visited_time
                            // existed — add it now, nullable, so existing rows keep working.
                            db.query("ALTER TABLE client_profiles ADD COLUMN office_visited_time DATETIME NULL", () => {
                                // Older deployments still on the original TIME-only column: widen it to
                                // DATETIME so the visit's own date (which can precede the survey's
                                // submission date) is stored instead of assumed from created_at. A
                                // no-op once the column is already DATETIME; MySQL backfills existing
                                // TIME values onto today's date, matching the old same-day assumption.
                                db.query("ALTER TABLE client_profiles MODIFY COLUMN office_visited_time DATETIME NULL", () => {});
                            });
                        });

                        // Client accounts (locked demographics + unified login lookup)
                        db.query(createClientAccountsTableQuery, (err) => {
                            if (err) console.error("❌ Error creating client_accounts table:", err);
                            else console.log('✅ client_accounts table verified/created successfully!');
                            // Older deployments created this table before the `password` column
                            // existed (Google sign-in used to log clients in directly, no local
                            // password) — add it now so existing rows can be upgraded in place.
                            // These ADD COLUMNs are expected to fail with ER_DUP_FIELDNAME on
                            // every boot after the first — that is the steady state, not a
                            // problem, so it stays silent. Anything ELSE means the column is
                            // genuinely missing (a dropped connection against Clever Cloud's
                            // 5-connection cap is enough to lose one), and a missing column
                            // breaks writes that name it for as long as it stays missing. They
                            // used to be fire-and-forget `() => {}`, which hid exactly that:
                            // registration would fail on every attempt with nothing in the log.
                            const alterClientAccounts = (sql, column) => {
                                db.query(sql, (alterErr) => {
                                    if (alterErr && alterErr.code !== 'ER_DUP_FIELDNAME') {
                                        console.error(`❌ Could not add client_accounts.${column} — writes naming that column will fail:`, alterErr.message);
                                    }
                                });
                            };

                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN password VARCHAR(255) NULL", 'password');
                            // Captured from the Google account's own profile photo on every Google
                            // sign-in (see /auth/google/callback and /complete-google-registration) —
                            // there's nothing to capture for the plain email/password login path, so
                            // this simply keeps whichever photo was last seen from Google.
                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN google_photo_url VARCHAR(500) NULL", 'google_photo_url');
                            // "Forgot Password" (email link) support: a short-lived, single-use
                            // token, stored only as a SHA-256 hash (never the raw token — the raw
                            // value only ever exists in the emailed link itself) plus its expiry.
                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN reset_token_hash VARCHAR(255) NULL", 'reset_token_hash');
                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN reset_token_expires DATETIME NULL", 'reset_token_expires');
                            // Drives the one-time setup wizard shown on /client-survey right after
                            // registration. DEFAULT 1 here so this ALTER TABLE marks every EXISTING
                            // account as already onboarded (they never asked to see a first-run
                            // tour) — new accounts explicitly insert 0 in
                            // /complete-google-registration so only genuinely new signups see it.
                            // The backfill below NAMES onboarding_completed, so it must not be
                            // issued until this ALTER has actually landed. `db` is a pool: two
                            // queries fired back-to-back go out on two different connections and
                            // are not ordered relative to each other, so the un-nested version of
                            // this raced the ALTER and failed with ER_BAD_FIELD_ERROR on any
                            // deployment whose client_accounts predates the column. Nesting the
                            // backfill in the callback is what guarantees the ordering.
                            db.query("ALTER TABLE client_accounts ADD COLUMN onboarding_completed TINYINT(1) NOT NULL DEFAULT 1", (alterErr) => {
                                // ER_DUP_FIELDNAME here is the normal steady state (the CREATE
                                // TABLE above already declares the column on fresh installs), so
                                // the backfill still runs. Anything else means the column really
                                // is missing and the backfill would only fail again.
                                if (alterErr && alterErr.code !== 'ER_DUP_FIELDNAME') {
                                    console.error("❌ Could not add client_accounts.onboarding_completed — skipping backfill:", alterErr.message);
                                    return;
                                }

                                // Backfill: clients who submitted surveys before client_accounts existed
                                // have no row here, so My Profile/autofill show "Not set yet" forever.
                                // Seed one row per email from that email's most recent client_profiles
                                // submission. INSERT IGNORE skips emails that already have an account row.
                                //
                                // ONE-TIME. This used to run on every single startup, which made
                                // deleting an account impossible: client_profiles keeps a row per past
                                // submission, so an account deleted from client_accounts was silently
                                // re-created from that history on the next restart and reappeared in
                                // /user-accounts. A row in schema_migrations marks it as done, so a
                                // deletion now stays deleted.
                                const backfillAccountsQuery = `
                                    INSERT IGNORE INTO client_accounts (email, respondent_name, region, age, gender, onboarding_completed)
                                    SELECT cp.email, cp.respondent_name, cp.region, cp.age, cp.gender, 1
                                    FROM client_profiles cp
                                    INNER JOIN (
                                        SELECT email, MAX(id) AS max_id
                                        FROM client_profiles
                                        WHERE email IS NOT NULL AND email <> ''
                                        GROUP BY email
                                    ) latest ON cp.id = latest.max_id
                                `;
                                runOnce('backfill_client_accounts_from_client_profiles', (proceed) => {
                                    if (!proceed) return;

                                    // A deployment that already has accounts has also already been
                                    // running the old every-startup version of this backfill, so its
                                    // pre-account-system clients are long since seeded. Re-running it
                                    // here would only resurrect accounts an admin has deleted since,
                                    // so the marker is recorded and the query skipped. On a fresh
                                    // install client_accounts is empty and the backfill runs (where,
                                    // with no client_profiles either, it is simply a no-op).
                                    db.query('SELECT EXISTS(SELECT 1 FROM client_accounts LIMIT 1) AS has_accounts', (existsErr, existsRows) => {
                                        if (existsErr) return console.error("❌ Could not check client_accounts before backfill:", existsErr.message);
                                        if (existsRows && existsRows[0] && Number(existsRows[0].has_accounts) === 1) {
                                            console.log('ℹ️  client_accounts backfill marked as already applied (existing accounts present) — deleted accounts stay deleted.');
                                            return;
                                        }

                                        db.query(backfillAccountsQuery, (backfillErr, backfillResult) => {
                                            if (backfillErr) console.error("❌ Error backfilling client_accounts:", backfillErr);
                                            else if (backfillResult.affectedRows > 0) console.log(`✅ Backfilled ${backfillResult.affectedRows} client_accounts row(s) from client_profiles.`);
                                        });
                                    });
                                });
                            });

                            // Deleting an account must take everything that account owns with
                            // it — its surveys, its pending/offline submission records and its
                            // notification inbox — so re-registering the same email starts
                            // genuinely empty. The trigger covers deletes made from anywhere
                            // (including phpMyAdmin); the sweep clears what earlier deletes,
                            // made before the trigger existed, already left behind.
                            installClientAccountPurgeTrigger();
                            sweepOrphanedClientAccountRows();

                            // NOTE: a second-pass "fill any still-NULL region/age/gender from this
                            // email's most recent client_profiles row" migration used to run here on
                            // EVERY server startup (not just once). Removed: it kept silently stamping
                            // a brand-new account's demographics from old/unrelated client_profiles
                            // rows (e.g. a stale anonymous test submission under the same email) every
                            // time the server restarted, even for accounts that had never submitted a
                            // survey under this account system yet. Region/age/gender are now locked
                            // in exactly once, at that account's own first real submission — see
                            // upsertAccountQuery in /submit-survey and /sync-surveys — and nowhere else.
                        });
                    }
                });
            }
        });
    }
});

db.query(createClientTypesTableQuery, (err) => {
    if (err) {
        console.error("❌ Error creating client_types table:", err);
    } else {
        console.log('✅ client_types table verified/created successfully!');
        db.query("SELECT COUNT(*) AS count FROM client_types", (err, result) => {
            if (!err && result[0].count === 0) {
                const seedClientTypes = `INSERT IGNORE INTO client_types (type_name) VALUES
                    ('Citizen'),
                    ('Business'),
                    ('Government'),
                    ('Student');`;
                db.query(seedClientTypes, () => console.log('✅ Default client types seeded.'));
            }
        });
    }
});

db.query(createSettingsTableQuery, (err) => {
    if (err) {
        console.error("❌ Error creating survey_settings table:", err);
    } else {
        db.query("ALTER TABLE survey_settings ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0", () => {});
        db.query("SELECT COUNT(*) AS count FROM survey_settings", (err, result) => {
            if (!err && result[0].count === 0) {
                const defaultSeedData = `
                    INSERT INTO survey_settings (category, content) VALUES
                    ('sqd', 'I am satisfied with the service that I availed.'),
                    ('sqd', 'I spent a reasonable amount of time for my transaction.'),
                    ('sqd', 'The office followed the transaction''s requirements and steps based on the information provided.'),
                    ('sqd', 'The steps (including payment) I needed to do for my transaction were easy and simple.'),
                    ('sqd', 'I easily found information about my transaction from the office or its website.'),
                    ('sqd', 'I paid a reasonable amount of fees for my transaction.'),
                    ('sqd', 'I feel the office was fair to everyone, or "walang palakasan", during my transaction.'),
                    ('sqd', 'I was treated courteously by the staff, and (if asked for help) the staff was helpful.'),
                    ('sqd', 'I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.'),
                    ('cc', 'Which of the following best describes your awareness of a CC?'),
                    ('cc', 'If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was...?'),
                    ('cc', 'If aware of CC (answered 1-3 in CC1), how much did the CC help you in your transaction?');
                `;
                db.query(defaultSeedData, () => console.log('✅ Original content successfully seeded into the database!'));
            }
        });
    }
});

// ==========================================
// 1. Public Routes
// ==========================================
app.get('/', (req, res) => {
    // loadLandingContent() reads data/landing-data.json synchronously (see the
    // "LANDING PAGE CONTENT" block above) — by the time this line returns, the
    // file has already been fully read and parsed, so whatever the admin last
    // saved through the CMS is guaranteed to be what gets rendered here.
    const landingContent = loadLandingContent();
    res.render('index', { landingContent });
});

// Closes THIS browser session's own admin_logs row — never anyone else's. Matches
// by id first (the fast path, set at login), falling back to session_id so a
// session that somehow lost req.adminSession.logId (e.g. an older cookie from
// before this column existed) still gets closed out correctly instead of hanging open.
function closeAdminLogRow(req, callback) {
    const logId = req.adminSession && (req.adminSession.logId || req.adminSession.adminLogId);
    if (logId) {
        return db.query('UPDATE admin_logs SET logout_time = NOW() WHERE id = ? AND logout_time IS NULL', [logId], (err) => {
            if (err) console.error('❌ Error recording admin logout:', err);
            callback();
        });
    }
    if (req.adminSessionID) {
        return db.query('UPDATE admin_logs SET logout_time = NOW() WHERE session_id = ? AND logout_time IS NULL', [req.adminSessionID], (err) => {
            if (err) console.error('❌ Error recording admin logout (session_id fallback):', err);
            callback();
        });
    }
    callback();
}

// Landing on /login always just renders the login form — no side effects, no
// state-dependent redirect. It must NOT destroy any session (the cookie is
// shared by every tab in the browser, so destroying it here would silently
// log out every OTHER tab too; the Back/Forward-button "cached protected
// page" concern that used to justify destroying it is already handled by the
// noCache middleware on every protected route, which stops the browser from
// ever showing a stale cached copy in the first place).
//
// It also must NOT auto-bounce an already-signed-in visitor to /dashboard or
// /client-survey, even though that sounds like harmless convenience: admin
// and client sessions live on separate cookies, so a single browser can
// easily be "logged out of the client" in one tab while still validly logged
// in as admin from a different tab. Auto-bouncing based on whichever role's
// cookie happens to still be valid means an explicit client logout (or simply
// an expired/failed client session redirecting here) would silently hand
// that tab the ADMIN dashboard instead of a login form — which is exactly
// the bug this replaced. Always rendering the form is side-effect-free and
// immune to that: if someone resubmits credentials while already logged in,
// /auth-login just re-authenticates them, which is harmless.
app.get('/login', noCache, (req, res) => {
    return res.render('login', { recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY });
});

// Verifies a g-recaptcha-response token against Google's siteverify endpoint.
// Used server-side so the check can't be bypassed by skipping the widget on
// the client (e.g. a direct POST to /auth-login).
function verifyRecaptcha(token, remoteIp) {
    return new Promise((resolve) => {
        // Gate on RECAPTCHA_SITE_KEY, not RECAPTCHA_SECRET_KEY: login.ejs's
        // client-side fallback decides whether to render the widget at all
        // based on RECAPTCHA_SITE_KEY (see the /login route above), so the
        // server-side bypass has to key off that same variable or the two
        // can desync — e.g. secret key set but site key missing/typo'd would
        // otherwise skip the widget client-side while still requiring a
        // token server-side, permanently locking out every login with no
        // visible widget to ever complete.
        if (!process.env.RECAPTCHA_SITE_KEY) {
            return resolve(true);
        }
        if (!token) {
            return resolve(false);
        }

        const postData = querystring.stringify({
            secret: process.env.RECAPTCHA_SECRET_KEY,
            response: token,
            remoteip: remoteIp
        });

        const req = https.request({
            hostname: 'www.google.com',
            path: '/recaptcha/api/siteverify',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(!!JSON.parse(body).success);
                } catch (e) {
                    resolve(false);
                }
            });
        });

        req.on('error', () => resolve(false));
        req.write(postData);
        req.end();
    });
}

// ==========================================
// UNIFIED LOGIN (Admin OR registered Client)
// ==========================================
// The main /login form posts here. Admin credentials still work as before;
// additionally, any email already known in client_accounts (i.e. someone who has
// signed in with Google and submitted at least one survey) can log back in from
// this same form instead of clicking "Sign in with Google" again.
// Plain-text passwords are only ever seen for the original seed rows inserted
// directly into the database (see createAdminsTableQuery above); anything added
// or edited through Manage Admins is always stored as a bcrypt hash. Detecting
// by the bcrypt prefix lets both kinds of rows log in through the same form.
function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]?\$/.test(value);
}

// Simple in-memory login-attempt throttle — neither /auth-login nor
// the old /office-login had any brute-force/credential-stuffing protection before
// this (reCAPTCHA only covers /auth-login, and only blocks scripted
// automation, not slow/manual guessing). Not a substitute for a proper
// distributed rate limiter behind a load balancer, but this admin portal
// runs as a single Node process, so a per-IP in-memory counter is a real,
// meaningful mitigation for this deployment shape without adding a new
// dependency. Counts ALL attempts (not just failures) — simpler, and a
// legitimate admin typing their own password wrong a handful of times in
// 10 minutes is not meaningfully burdened by this ceiling.
const loginAttempts = new Map(); // ip -> { count, windowStart }
const LOGIN_RATE_LIMIT_MAX = 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// FAILED attempts only — this used to count every attempt, successful ones
// included, and that was a real lockout: ten people signing in correctly from
// one address exhausted the window for everyone behind it, and the eleventh
// was told "too many login attempts" while typing the right password. An
// office shares a building, a network and often a single public address, so
// this was reached on ordinary mornings, not under attack.
//
// Counting failures loses nothing defensively: guessing a password IS failing
// at it, so a brute-force run fills this bucket just as fast as before, while
// a room full of staff logging in normally never touches it.
//
// The middleware only READS the bucket. The route handler is what knows
// whether the credentials were good, so it reports the outcome back through
// the two helpers hung on `req` below.
function loginRateLimiter(redirectPath) {
    return (req, res, next) => {
        const ip = req.ip;
        const now = Date.now();
        const entry = loginAttempts.get(ip);
        const live = entry && now - entry.windowStart <= LOGIN_RATE_LIMIT_WINDOW_MS ? entry : null;
        if (!live) loginAttempts.delete(ip);

        if (live && live.count >= LOGIN_RATE_LIMIT_MAX) {
            return res.redirect(redirectPath + '?error=' + encodeURIComponent('Too many login attempts. Please try again in a few minutes.'));
        }

        req.noteLoginFailure = () => {
            const at = Date.now();
            let e = loginAttempts.get(ip);
            if (!e || at - e.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) e = { count: 0, windowStart: at };
            e.count++;
            loginAttempts.set(ip, e);
        };
        // A correct password is proof this address is not the one being
        // guessed against, so its failures are forgiven — otherwise a single
        // typo earlier in the morning would still be held against every
        // colleague signing in from the same office an hour later.
        req.clearLoginFailures = () => { loginAttempts.delete(ip); };

        next();
    };
}

// Periodic sweep so stale IP entries don't accumulate in the Map forever.
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
        if (now - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) loginAttempts.delete(ip);
    }
}, LOGIN_RATE_LIMIT_WINDOW_MS).unref();

// JSON-response counterpart to loginRateLimiter — same per-IP sliding-window
// Map pattern, but for API routes (offline sync/verify) where a redirect
// makes no sense; returns the standardized 429 shape instead.
function jsonRateLimiter(name, { windowMs, max }) {
    const attempts = new Map(); // ip -> { count, windowStart }
    setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of attempts) {
            if (now - entry.windowStart > windowMs) attempts.delete(ip);
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const ip = req.ip;
        const now = Date.now();
        let entry = attempts.get(ip);
        if (!entry || now - entry.windowStart > windowMs) {
            entry = { count: 0, windowStart: now };
            attempts.set(ip, entry);
        }
        entry.count++;
        if (entry.count > max) {
            return res.status(429).json({ success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' });
        }
        next();
    };
}

// Offline sync (no password involved — just writing already-verified
// results) gets a generous IP-based ceiling; many CSPC students can
// legitimately be reconnecting from the same building's shared IP/NAT at
// once.
const offlineSyncLimiter = jsonRateLimiter('offline-sync', { windowMs: 15 * 60 * 1000, max: 30 });

// Offline VERIFICATION accepts a password, so it needs to be much stricter —
// but IP alone is the wrong axis here too (same NAT concern), so this is
// primarily ACCOUNT-aware: failed attempts are tracked per normalized
// registeredIdentifier, independent of loginAttempts/failedLoginsByAccount
// above (which are scoped to /auth-login and are not reused here). A looser
// IP ceiling sits alongside it purely as a sweep/abuse backstop.
const offlineVerifyFailuresByIdentifier = new Map(); // identifier -> { count, windowStart }
const OFFLINE_VERIFY_ACCOUNT_MAX = 8;
const OFFLINE_VERIFY_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

function isOfflineVerifyIdentifierLocked(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (!key) return false;
    const entry = offlineVerifyFailuresByIdentifier.get(key);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > OFFLINE_VERIFY_ACCOUNT_WINDOW_MS) {
        offlineVerifyFailuresByIdentifier.delete(key);
        return false;
    }
    return entry.count >= OFFLINE_VERIFY_ACCOUNT_MAX;
}

function recordOfflineVerifyFailure(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (!key) return;
    const now = Date.now();
    let entry = offlineVerifyFailuresByIdentifier.get(key);
    if (!entry || now - entry.windowStart > OFFLINE_VERIFY_ACCOUNT_WINDOW_MS) {
        entry = { count: 0, windowStart: now };
    }
    entry.count++;
    offlineVerifyFailuresByIdentifier.set(key, entry);
}

function clearOfflineVerifyFailures(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (key) offlineVerifyFailuresByIdentifier.delete(key);
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of offlineVerifyFailuresByIdentifier) {
        if (now - entry.windowStart > OFFLINE_VERIFY_ACCOUNT_WINDOW_MS) offlineVerifyFailuresByIdentifier.delete(key);
    }
}, OFFLINE_VERIFY_ACCOUNT_WINDOW_MS).unref();

// Same non-revealing message as a normal verification failure — never
// distinguishes "locked out" from "wrong credentials" in the response text.
const OFFLINE_VERIFY_GENERIC_MESSAGE = 'Unable to verify the registered account information provided.';

const offlineVerifyLimiter = jsonRateLimiter('offline-verify', { windowMs: 15 * 60 * 1000, max: 40 });

// Per-ACCOUNT login lockout — separate from the per-IP limiter above. That one
// caps request volume from a single IP; this one protects one specific
// account (admin username, or client/office email) from being guessed at
// all, even if the attempts are spread across many different IPs. Keyed by
// the identifier typed into the login form, lowercased so 'Admin' and
// 'admin' share one counter.
const failedLoginsByAccount = new Map(); // identifier -> { count, firstAttempt, lockedUntil }
// Five, not the two this was set to. Two is one typo and one retry — the
// most ordinary thing a person does at a login form — and it cost them a
// five-minute lockout on a password they knew. Five still stops guessing
// cold (a real attacker needs thousands of tries, not five), and it is the
// account-level limit that does the actual work here now that the per-IP one
// only counts failures.
const ACCOUNT_LOCKOUT_THRESHOLD = 5;
const ACCOUNT_LOCKOUT_WINDOW_MS = 5 * 60 * 1000; // failed attempts older than this no longer count
const ACCOUNT_LOCKOUT_DURATION_MS = 5 * 60 * 1000; // how long the account stays locked once tripped

// Returns the active lockout entry for this identifier, or null if it isn't
// currently locked (also clears it out of the Map once expired).
function getAccountLockout(identifier) {
    // Re-enabled. This was switched off with an early `return null` because it
    // was locking people out of correct passwords — which it was, at a
    // threshold of 2: one typo and one retry tripped it. The cause was the
    // threshold, not the mechanism, so the threshold is what changed (see
    // ACCOUNT_LOCKOUT_THRESHOLD), and the guard is back on.
    //
    // It matters more here than in most apps: every office account is seeded
    // with the same password, so until those are changed, an unlimited guess
    // rate against a known office email is the whole door.
    const key = String(identifier || '').trim().toLowerCase();
    if (!key) return null;
    const entry = failedLoginsByAccount.get(key);
    if (!entry) return null;
    if (entry.lockedUntil) {
        if (entry.lockedUntil > Date.now()) return entry;
        failedLoginsByAccount.delete(key);
        return null;
    }
    if (Date.now() - entry.firstAttempt > ACCOUNT_LOCKOUT_WINDOW_MS) {
        failedLoginsByAccount.delete(key);
        return null;
    }
    return null;
}

function recordFailedLogin(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (!key) return;
    const now = Date.now();
    let entry = failedLoginsByAccount.get(key);
    if (!entry || now - entry.firstAttempt > ACCOUNT_LOCKOUT_WINDOW_MS) {
        entry = { count: 0, firstAttempt: now, lockedUntil: null };
    }
    entry.count++;
    if (entry.count >= ACCOUNT_LOCKOUT_THRESHOLD) {
        entry.lockedUntil = now + ACCOUNT_LOCKOUT_DURATION_MS;
    }
    failedLoginsByAccount.set(key, entry);
}

function clearFailedLogins(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (key) failedLoginsByAccount.delete(key);
}

function accountLockoutMessage(entry) {
    const minutesLeft = Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 60000));
    return `Too many failed login attempts for this account. Please wait ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} and try again.`;
}

// Periodic sweep, mirroring the IP-limiter one above.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failedLoginsByAccount) {
        const expired = entry.lockedUntil ? entry.lockedUntil <= now : (now - entry.firstAttempt > ACCOUNT_LOCKOUT_WINDOW_MS);
        if (expired) failedLoginsByAccount.delete(key);
    }
}, ACCOUNT_LOCKOUT_WINDOW_MS).unref();

async function verifyAdminPassword(admin, passwordInput) {
    if (isBcryptHash(admin.password)) {
        return bcrypt.compare(passwordInput, admin.password);
    }
    return admin.password === passwordInput;
}

app.post('/auth-login', loginRateLimiter('/login'), async (req, res) => {
    const { username, password } = req.body;
    const usernameInput = String(username || '').trim();

    const existingLockout = getAccountLockout(usernameInput);
    if (existingLockout) {
        return res.redirect('/login?error=' + encodeURIComponent(accountLockoutMessage(existingLockout)));
    }

    const captchaOk = await verifyRecaptcha(req.body['g-recaptcha-response'], req.ip);
    if (!captchaOk) {
        return res.redirect('/login?error=' + encodeURIComponent('Please complete the "I\'m not a robot" verification.'));
    }

    if (usernameInput && password) {
        // Not `return db.query(...)`: db.query() returns a mysql2 Query command
        // object, and this handler is `async` — an async function's `return`
        // resolution treats any thenable it returns as a promise to adopt, which
        // calls .then() on that Query object. mysql2 defines .then() purely as a
        // guard that throws (it's not a real promise), turning that call into an
        // unhandled rejection every time a request reaches this branch.
        db.query('SELECT * FROM admins WHERE username = ? LIMIT 1', [usernameInput], async (err, rows) => {
            if (err) {
                console.error('❌ Error looking up admin:', err);
                return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
            }
            if (!rows || rows.length === 0) {
                // Not an admin username — fall through to the client-account login below.
                return handleClientLogin();
            }

            const admin = rows[0];
            const passwordMatches = await verifyAdminPassword(admin, password);
            if (!passwordMatches) {
                recordFailedLogin(usernameInput);
                if (req.noteLoginFailure) req.noteLoginFailure();
                return res.redirect('/login?error=' + encodeURIComponent('Invalid admin credentials!'));
            }
            clearFailedLogins(usernameInput);
            if (req.clearLoginFailures) req.clearLoginFailures();

            const loginToken = crypto.randomUUID();

            // regenerate() issues a brand new session ID/cookie for THIS login. This
            // matters even for two tabs in the SAME browser sharing the same 'admin.sid'
            // cookie: it's what makes the old cookie value (still sitting unused in
            // Tab 1's rendered page) resolve to nothing once the store's old entry
            // is gone, and it's also what invalidates session fixation from the
            // pre-login request.
            regenerateAdminSession(req, res);

            req.adminSession.user = {
                id: admin.id,
                username: admin.username,
                fullname: admin.fullname,
                gender: admin.gender,
                role: admin.role, // kept for server-side access control (ensureSuperAdmin) — not shown in the UI
                created_at: admin.created_at,
                photo_url: admin.photo_url || null,
                type: 'admin' // stable auth flag — distinct from the access-control `role` field
            };
            req.adminSession.admin = req.adminSession.user;
            req.adminSession.login_token = loginToken;

            // ONE active session per admin account — including two tabs in the
            // SAME browser (which share one 'admin.sid' cookie, so ensureAdminAuth
            // can't tell them apart by session ID alone). admins.login_token is the
            // source of truth: whichever tab's login_token stops matching it on
            // its next request gets kicked to /login there. The admin_logs
            // session_id destroy below additionally force-invalidates any OTHER
            // browser/device immediately, without waiting for its next request.
            db.query('UPDATE admins SET login_token = ? WHERE id = ?', [loginToken, admin.id], (tokenErr) => {
                if (tokenErr) console.error('❌ Error saving login_token:', tokenErr);
            });

            db.query('SELECT session_id FROM admin_logs WHERE admin_id = ? AND logout_time IS NULL', [admin.id], (err, openRows) => {
                if (err) console.error('❌ Error loading this admin\'s open sessions:', err);

                // Destroying the session in the store is what actually forces the other
                // tab/device out — ensureAdminAuth will find no session there on its next
                // request and redirect to /login.
                (openRows || [])
                    .map(r => r.session_id)
                    .filter(sid => sid && sid !== req.adminSessionID)
                    .forEach(sid => {
                        // Tombstones sid (replaces its data with a "replaced"
                        // marker instead of deleting it outright) — this is
                        // the one real "another login happened" event
                        // ensureAdminAuth's session-missing branch checks
                        // for, so that tab/device gets an accurate "signed
                        // in elsewhere" message instead of being lumped in
                        // with ordinary expiration. This already fully
                        // invalidates the old session for auth purposes
                        // (see the cookie-parsing middleware) — no separate
                        // destroyAdminSessionById call needed/wanted here,
                        // since that would just delete the tombstone right
                        // back out again.
                        markAdminSessionReplaced(sid);
                    });

                db.query('UPDATE admin_logs SET logout_time = NOW() WHERE admin_id = ? AND logout_time IS NULL', [admin.id], (err) => {
                    if (err) console.error('❌ Error closing this admin\'s previous admin_logs rows:', err);
                    db.query('INSERT INTO admin_logs (admin_id, username, login_time, session_id) VALUES (?, ?, NOW(), ?)', [admin.id, admin.username, req.adminSessionID], (err, result) => {
                        if (err) console.error('❌ Error recording admin login:', err);
                        else {
                            req.adminSession.adminLogId = result.insertId;
                            req.adminSession.logId = result.insertId;
                        }
                        // ?loggedin=1 lets layout/header.ejs's new-tab guard mark THIS
                        // tab (via sessionStorage) as one that actually authenticated,
                        // as opposed to a different tab merely inheriting the cookie.
                        res.redirect('/dashboard?loggedin=1');
                    });
                });
            });
        });
        return;
    }

    return handleClientLogin();

    function handleClientLogin() {
    const emailInput = String(username || '').trim().toLowerCase();
    if (!emailInput || !password) {
        return res.redirect('/login?error=' + encodeURIComponent('Please enter both your email and password.'));
    }

    // One address can legitimately BE two different accounts here. Office
    // staff sign in to the panel with their office's address and the office's
    // password — and the same person may also have taken a survey, which
    // creates a client account under that very same address.
    //
    // This used to stop at the first table that recognised the address: a
    // client account whose password did not match ended the attempt with
    // "Invalid email or password", and the offices table was never consulted
    // at all. The office's own password was correct and the office could
    // still never get in, from any device, with no way to tell why — the
    // message blamed the credentials rather than the lookup order.
    //
    // So a table that knows the address but rejects the password is no longer
    // an answer, only a miss. Every identity this address could be is tried,
    // and the attempt fails only when all of them have.
    db.query('SELECT email, password FROM client_accounts WHERE email = ? LIMIT 1', [emailInput], async (err, rows) => {
        if (err) {
            return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
        }

        const account = rows && rows[0];
        // Known here, but this password is not the one — carried through so
        // the final message can say "wrong password" rather than "no account".
        if (!account) return handleOfficeLogin({ knownAsClient: false });
        // A client account created by signing in with Google has no password
        // of its own yet. That is not a rejection of what was typed; it just
        // means this identity cannot answer, so the others still get their turn.
        if (!account.password) return handleOfficeLogin({ knownAsClient: true, noClientPassword: true });

        const passwordMatches = await bcrypt.compare(password, account.password);
        if (!passwordMatches) return handleOfficeLogin({ knownAsClient: true });

        clearFailedLogins(emailInput);
        if (req.clearLoginFailures) req.clearLoginFailures();

        // Regenerate before assigning identity to prevent session fixation
        // (an attacker who planted a known session id on the victim's
        // browser — e.g. via a shared/kiosk machine — must not have that id
        // become authenticated once the victim logs in). Mirrors
        // regenerateAdminSession's use on the admin/office login paths.
        req.session.regenerate((err) => {
            if (err) {
                return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
            }
            req.session.clientEmail = account.email;
            // ?loggedin=1 lets client-survey.ejs's new-tab guard mark THIS tab
            // (via sessionStorage) as one that actually authenticated, as
            // opposed to a different tab merely inheriting the shared
            // 'client.sid' cookie.
            return res.redirect('/client-survey?loggedin=1');
        });
    });

    // The last identity this address can be, so this is where the attempt
    // finally succeeds or fails. `fromClient` carries what the client-account
    // lookup already established, purely so the failure message is truthful
    // about WHICH thing went wrong.
    function handleOfficeLogin(fromClient) {
        fromClient = fromClient || {};

        // Every way of failing from here ends in one of two honest answers,
        // recorded once — not once per table consulted, which would have
        // spent a person's lockout allowance at two or three times the rate
        // they were actually typing.
        const rejectUnknown = () => {
            if (req.noteLoginFailure) req.noteLoginFailure();
            if (fromClient.knownAsClient) {
                // The address is real, so sending them to Register would be
                // wrong — the password is what did not match.
                recordFailedLogin(emailInput);
                const message = fromClient.noClientPassword
                    ? 'This account has no password set yet. Please sign in with Google once to create one.'
                    : 'Invalid email or password.';
                return res.redirect('/login?error=' + encodeURIComponent(message));
            }
            return res.redirect('/login?tab=register&error=' + encodeURIComponent('No account found for that email. Open the Register tab and sign up with your CSPC or personal email first.'));
        };

        db.query('SELECT id, office_name, full_name, cluster_name, email_address, password FROM offices WHERE email_address = ? LIMIT 1', [emailInput], async (officeErr, officeRows) => {
            if (officeErr) {
                return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
            }
            const office = officeRows && officeRows[0];
            if (!office || !office.password) return rejectUnknown();

            const passwordMatches = await bcrypt.compare(password, office.password);
            if (!passwordMatches) {
                recordFailedLogin(emailInput);
                if (req.noteLoginFailure) req.noteLoginFailure();
                return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
            }
            clearFailedLogins(emailInput);
            if (req.clearLoginFailures) req.clearLoginFailures();

            regenerateOfficeSession(req, res);
            req.officeSession.user = {
                id: office.id,
                office_name: office.office_name,
                // Carried on the session so every office page can spell the
                // office out in its header without a query per page load
                // (see officeHeaderNames / ensureOfficeAuth's backfill).
                full_name: office.full_name || null,
                cluster_name: office.cluster_name,
                email_address: office.email_address,
                type: 'office'
            };
            // Straight to the Dashboard: an office opening the panel wants the
            // state of its work first (how many waiting, how many this
            // period), and Pending is one tap away in the sidebar.
            // ?loggedin=1 lets the page's new-tab guard mark THIS tab (via
            // sessionStorage) as one that actually authenticated, matching the
            // same pattern used for the admin dashboard and /client-survey.
            return res.redirect('/office-dashboard?loggedin=1');
        });
    }
    }
});

// Same "landing here = logout" treatment as /login above, for the client's
// dedicated Google sign-in entry point.
// Same "already signed in -> bounce, don't destroy" treatment as /login above:
// destroying the session here would silently log out every OTHER tab sharing
// this same cookie the moment this tab merely navigated to /client-login.
app.get('/client-login', noCache, (req, res) => {
    const hasActiveSession = !!(req.session && req.session.clientEmail)
        || (req.isAuthenticated && req.isAuthenticated());

    if (!hasActiveSession) {
        return res.render('client-login');
    }

    return res.redirect('/client-survey');
});

// ==========================================
// OFFICE LOGIN & APPROVAL PANEL
// ==========================================
// Office staff (not an admin, not a client) sign in through the SAME '/login'
// form as everyone else — see handleOfficeLogin inside /auth-login, which is
// tried after the admin and client lookups both miss. The panel behind that
// login reviews survey submissions from non-@cspc.edu.ph accounts that claim
// to have visited THIS office, and approves or declines them (see
// checkResubmissionEligibility / finalizeVerifiedSurvey for how an approved
// submission is replayed into survey_responses). An office session uses the
// same hand-rolled session mechanics as an admin login, but its own
// req.officeSession/'office.sid' cookie (see ensureOfficeAuth /
// OFFICE_COOKIE_NAME above), so an admin tab and an office tab open at once
// in the same browser can't invalidate each other.
//
// The dedicated '/office-login' page it used to have is gone: one login page
// for every kind of account means office staff can never again land on a form
// that refuses their credentials, and there is only one place to maintain the
// lockout/rate-limit/reCAPTCHA protections. These two routes stay behind only
// as forwarders, because a bookmark, a typed URL, an old QR code, a
// service-worker-cached shell or a stale open tab on ANY device can still
// aim at the old path long after the page itself stopped existing.
app.get('/office-login', noCache, (req, res) => {
    // Carry ?status / ?error through so a forwarded visitor still sees why
    // they were asked to log in; login.ejs understands the same flags.
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    let target = '/login';
    if (error) target += '?error=' + encodeURIComponent(error);
    else if (status) target += '?status=' + encodeURIComponent(status);
    return res.redirect(302, target);
});

// A stale cached copy of the old office form (or a bot) can still POST here.
// The credentials in that body are deliberately NOT processed — this path no
// longer authenticates anyone — so the visitor is simply sent to the real
// form. loginRateLimiter still guards it so it can't be used as an
// unthrottled probe of which office emails exist.
app.post('/office-login', loginRateLimiter('/login'), (req, res) => {
    return res.redirect(303, '/login?status=login_required');
});

app.get('/office-logout', noCache, (req, res) => {
    // Offices log back in at '/login' now, so logging out lands there too —
    // the same place ensureOfficeAuth sends an unauthenticated office
    // visitor. status=logged_out gives them the same "You have been logged
    // out successfully" confirmation the admin and client flows get from
    // '/logout' below.
    const hadSession = !!(req.officeSession && req.officeSession.user && req.officeSession.user.type === 'office');
    destroyOfficeSession(req, res);
    res.redirect(302, hadSession ? '/login?status=logged_out' : '/login');
});

// Approval/decline history count only — used to show a badge on the sidebar's
// "History" link from the Pending page without pulling the full history rows.
function getOfficeHistoryCount(officeId, callback) {
    db.query(
        "SELECT COUNT(*) AS c FROM pending_survey_submissions WHERE office_id = ? AND status IN ('approved', 'declined')",
        [officeId],
        (err, rows) => callback((!err && rows && rows[0]) ? rows[0].c : 0)
    );
}

// Pending count only — used to show a badge on the sidebar's "Pending" link
// from the History page without pulling the full pending rows.
function getOfficePendingCount(officeId, callback) {
    db.query(
        "SELECT COUNT(*) AS c FROM pending_survey_submissions WHERE office_id = ? AND status = 'pending'",
        [officeId],
        (err, rows) => callback((!err && rows && rows[0]) ? rows[0].c : 0)
    );
}

// ---------------------------------------------------------------------------
// OFFICE DASHBOARD — counts only
// ---------------------------------------------------------------------------
// Aggregate activity for the signed-in office: how many surveys it has
// received in total, and how many submissions are pending / approved /
// declined. Every query below is a COUNT or a GROUP BY count — no respondent
// name, email address, or answer is selected at all, so there is nothing
// identifying for the page to leak even by accident. Office staff already see
// individual submissions on Pending/History; this page is deliberately the
// "how many", not the "who" or the "what".
app.get('/office-dashboard', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.officeSession.user.id;
    const { officeName, officeNameShort } = officeHeaderNames(req.officeSession.user);

    // ---- The reporting period is a SEMESTER, not a rolling six months ----
    // The College's terms run January–June and July–December, and the record
    // starts over with each one, so a window that slid month by month would
    // straddle two semesters and mix a finished term's numbers into the
    // current one. The period is therefore the six calendar months of
    // whichever semester today falls in: January–June for months 0-5,
    // July–December for 6-11.
    const now = new Date();
    const year = now.getFullYear();
    const isFirstSem = now.getMonth() < 6;
    const semStartMonth = isFirstSem ? 0 : 6;
    // Shown as "Period Covered" rather than "1st/2nd Semester": the page
    // states the months it is counting, and those months are what the reader
    // actually needs to check a number against.
    const semesterLabel = 'Period Covered';
    const semesterRange = (isFirstSem ? 'January–June ' : 'July–December ') + year;

    // Inclusive start, exclusive end — the first day of the month AFTER the
    // semester. Comparing against '< the next period's start' rather than
    // '<= the last day' is what keeps a submission made at 11:40pm on the
    // final day inside the semester it belongs to.
    const pad = (n) => String(n).padStart(2, '0');
    const semStart = year + '-' + pad(semStartMonth + 1) + '-01';
    const semEnd = (semStartMonth === 0)
        ? year + '-07-01'
        : (year + 1) + '-01-01';

    // All six months of the semester, always — including ones still ahead of
    // today. They read as "nothing yet this month", which is true; dropping
    // them would make a semester in progress look like a complete one.
    const months = [];
    for (let i = 0; i < 6; i++) {
        const d = new Date(year, semStartMonth + i, 1);
        months.push({
            key: d.getFullYear() + '-' + pad(d.getMonth() + 1),
            label: d.toLocaleDateString('en-PH', { month: 'short', year: 'numeric' }),
            count: 0
        });
    }

    const render = (stats) => {
        res.render('office-dashboard', Object.assign({
            officeName,
            officeNameShort,
            semesterLabel,
            semesterRange,
            totalRespondents: 0,
            totalRespondentsAllTime: 0,
            pendingCount: 0,
            approvedCount: 0,
            approvedAllTime: 0,
            declinedCount: 0,
            declinedAllTime: 0,
            historyCount: 0,
            monthly: months
        }, stats));
    };

    // Respondents: this semester, and all time. Both are counts — no
    // respondent column is selected anywhere on this page.
    db.query(
        'SELECT COUNT(*) AS allTime, ' +
        'SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS semester ' +
        'FROM survey_responses WHERE office_id = ?',
        [semStart, semEnd, officeId],
        (errTotal, totalRows) => {
            const totalRow = (!errTotal && totalRows && totalRows[0]) ? totalRows[0] : {};
            const totalRespondentsAllTime = Number(totalRow.allTime || 0);
            const totalRespondents = Number(totalRow.semester || 0);

            // One pass over the submission statuses rather than a COUNT query
            // per status, each status counted twice: within the semester and
            // all time.
            db.query(
                'SELECT status, COUNT(*) AS allTime, ' +
                'SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS semester ' +
                'FROM pending_survey_submissions WHERE office_id = ? GROUP BY status',
                [semStart, semEnd, officeId],
                (errStatus, statusRows) => {
                    let pendingCount = 0;
                    let approvedCount = 0, approvedAllTime = 0;
                    let declinedCount = 0, declinedAllTime = 0;
                    if (!errStatus && statusRows) {
                        statusRows.forEach((row) => {
                            if (row.status === 'pending') {
                                // Pending is deliberately NOT semester-scoped:
                                // it is a live work queue, and a submission
                                // left over from last semester still needs
                                // reviewing. Hiding it behind a date range
                                // would hide work, not old news.
                                pendingCount = Number(row.allTime || 0);
                            } else if (row.status === 'approved') {
                                approvedAllTime = Number(row.allTime || 0);
                                approvedCount = Number(row.semester || 0);
                            } else if (row.status === 'declined') {
                                declinedAllTime = Number(row.allTime || 0);
                                declinedCount = Number(row.semester || 0);
                            }
                        });
                    }

                    db.query(
                        "SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS c " +
                        'FROM survey_responses ' +
                        'WHERE office_id = ? AND created_at >= ? AND created_at < ? ' +
                        'GROUP BY ym',
                        [officeId, semStart, semEnd],
                        (errMonthly, monthlyRows) => {
                            if (!errMonthly && monthlyRows) {
                                monthlyRows.forEach((row) => {
                                    const slot = months.find((m) => m.key === row.ym);
                                    if (slot) slot.count = Number(row.c || 0);
                                });
                            }
                            render({
                                totalRespondents,
                                totalRespondentsAllTime,
                                pendingCount,
                                approvedCount,
                                approvedAllTime,
                                declinedCount,
                                declinedAllTime,
                                // The sidebar's History badge counts every
                                // reviewed submission, not just this term's —
                                // it badges a page that lists all of them.
                                historyCount: approvedAllTime + declinedAllTime,
                                monthly: months
                            });
                        }
                    );
                }
            );
        }
    );
});

// Live status for the office panel's poller (see office-shell.ejs).
//
// Returns a small fingerprint of everything the three office pages display,
// so the panel can tell that what is on screen has gone out of date — not
// just that a new submission arrived. The four numbers cover every way this
// office's data changes:
//
//   pending / latestPendingId  a submission arrives, OR one is approved or
//                              declined (here, or by a colleague on another
//                              device, or in another tab)
//   history                    a submission finishes review, from anywhere
//   responses                  an approved survey lands in the office's
//                              actual records — and also catches a survey
//                              from a CSPC institutional account, which is
//                              recorded directly and never becomes a pending
//                              row at all, so nothing else here would move
//
// Still counts only. No respondent name, email address or answer is selected,
// so the thing running every ten seconds on an unattended screen carries no
// personal data. latestPendingId is what separates "something NEW arrived"
// from "something was reviewed": a count alone cannot tell one submission
// arriving while another is approved from nothing happening at all.
app.get('/office-approvals/status', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.officeSession.user.id;
    // Pending and history come off the same table, so they are one query, not
    // the two this used to make — this runs on a timer for every open panel.
    db.query(
        "SELECT " +
        "  SUM(status = 'pending') AS pending, " +
        "  COALESCE(MAX(CASE WHEN status = 'pending' THEN id END), 0) AS latestId, " +
        "  SUM(status IN ('approved', 'declined')) AS history " +
        'FROM pending_survey_submissions WHERE office_id = ?',
        [officeId],
        (err, rows) => {
            if (err) {
                console.error('❌ Error loading office status:', err);
                return res.status(500).json({ success: false, message: 'Server error.' });
            }
            const row = (rows && rows[0]) || {};
            db.query(
                'SELECT COUNT(*) AS c FROM survey_responses WHERE office_id = ?',
                [officeId],
                (errResp, respRows) => {
                    if (errResp) console.error('❌ Error counting office responses:', errResp);
                    res.json({
                        success: true,
                        pending: Number(row.pending || 0),
                        latestPendingId: Number(row.latestId || 0),
                        history: Number(row.history || 0),
                        // On an error this stays 0 rather than failing the whole
                        // poll: three of the four numbers are still useful, and a
                        // steady 0 simply means this one never reports a change.
                        responses: Number((respRows && respRows[0] && respRows[0].c) || 0)
                    });
                }
            );
        }
    );
});

// Feed for the office bell and the "you have pending surveys" popup. The
// office layout (views/layout/office-shell.ejs) fetches this, but the route
// was never registered — every call 404'd, so the bell always looked empty
// and the popup never had a count to announce. The feed IS the office's live
// pending queue (no notification rows to drift out of sync); read/dismissed
// state stays in the staffer's browser, so nothing here writes anything.
app.get('/office-approvals/notifications', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.officeSession.user.id;
    db.query(
        "SELECT id, service_availed, payload, created_at FROM pending_survey_submissions WHERE office_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 100",
        [officeId],
        (err, rows) => {
            if (err) {
                console.error('❌ [Office Notifications] Error loading pending queue:', err);
                return res.status(500).json({ success: false, message: 'Server error loading notifications.' });
            }
            const notifications = (rows || []).map(r => {
                const payload = parsePendingPayload(r.payload); // {} on a corrupt/unusable payload
                return {
                    id: r.id,
                    respondent: payload.respondentName || 'Anonymous',
                    service: r.service_availed || '',
                    createdAt: r.created_at
                };
            });
            res.json({ success: true, notifications });
        }
    );
});

app.get('/office-approvals', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.officeSession.user.id;
    db.query(
        "SELECT id, google_email, service_availed, payload, created_at FROM pending_survey_submissions WHERE office_id = ? AND status = 'pending' ORDER BY created_at ASC",
        [officeId],
        (err, rows) => {
            const submissions = (!err && rows) ? rows.map(r => {
                let payload = {};
                payload = parsePendingPayload(r.payload); // {} on a corrupt/unusable payload
                return {
                    id: r.id,
                    googleEmail: r.google_email,
                    serviceAvailed: r.service_availed,
                    respondentName: payload.respondentName || 'Anonymous',
                    officeVisitedTime: payload.officeVisitedTime || null,
                    createdAt: r.created_at
                };
            }) : [];

            getOfficeHistoryCount(officeId, (historyCount) => {
                res.render('office-approvals', Object.assign(officeHeaderNames(req.officeSession.user), {
                    submissions,
                    historyCount
                }));
            });
        }
    );
});

// Approval/decline history — its own page (separate from the Pending list) so
// a busy office's growing pending queue doesn't have to share space with its
// history; navigated between via the sidebar on both pages.
app.get('/office-approvals/history', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.officeSession.user.id;
    // Most recently reviewed first, capped so the page doesn't grow unbounded
    // for offices that process a lot of surveys.
    db.query(
        "SELECT id, google_email, service_availed, payload, status, decline_reason, reviewed_at, created_at FROM pending_survey_submissions WHERE office_id = ? AND status IN ('approved', 'declined') ORDER BY reviewed_at DESC LIMIT 50",
        [officeId],
        (err, rows) => {
            const history = (!err && rows) ? rows.map(r => {
                let payload = {};
                payload = parsePendingPayload(r.payload); // {} on a corrupt/unusable payload
                return {
                    id: r.id,
                    googleEmail: r.google_email,
                    serviceAvailed: r.service_availed,
                    respondentName: payload.respondentName || 'Anonymous',
                    officeVisitedTime: payload.officeVisitedTime || null,
                    createdAt: r.created_at,
                    reviewedAt: r.reviewed_at,
                    status: r.status,
                    declineReason: r.decline_reason
                };
            }) : [];

            getOfficePendingCount(officeId, (pendingCount) => {
                // The real reviewed-submission count, not history.length: the
                // list above is capped at 50 rows, so for a busy office the
                // sidebar badge would otherwise sit at "50" forever.
                getOfficeHistoryCount(officeId, (historyCount) => {
                    res.render('office-history', Object.assign(officeHeaderNames(req.officeSession.user), {
                        history,
                        pendingCount,
                        historyCount
                    }));
                });
            });
        }
    );
});

// Fully transactional: claim + finalize (survey_responses/client_profiles/
// client_accounts) + pending_survey_submissions status flip + the
// offline_survey_submissions tracking update (relevant only when this
// submission originated from the offline verify-and-sync flow — a no-op
// UPDATE otherwise) all commit or roll back together on one dedicated
// pooled connection. A crash/error at any point leaves nothing
// half-applied: the claim itself rolls back too, so a failed attempt
// naturally reverts to 'pending' with no separate "revert the claim" query
// needed (unlike the old non-transactional version). AI sentiment/topic
// analysis and the approval email are deliberately kept OUTSIDE the
// transaction — both are slow, non-database operations that must never
// hold a DB connection open (same reasoning as verify-and-sync).
app.post('/office-approvals/:id/approve', ensureOfficeAuth, async (req, res) => {
    const officeId = req.officeSession.user.id;
    const submissionId = req.params.id;

    const conn = await db.promise().getConnection();
    let payload = null;
    let googleEmail = null;
    let surveyResponseId = null;
    let submittedAtDb = null; // the pending row's own created_at — when the client really submitted
    let claimFailed = false;
    let supersededByOnline = false;
    let lockName = null;
    let lockHeld = false;

    try {
        await conn.beginTransaction();

        // Atomically claim the row FIRST (flip to an interim 'processing'
        // status conditioned on it still being 'pending' AND belonging to
        // this office) before any finalize work — same anti-double-approval
        // reasoning as before (two open tabs, a double-click, a race with
        // /decline), now as this transaction's first write.
        const [claimResult] = await conn.query(
            "UPDATE pending_survey_submissions SET status = 'processing' WHERE id = ? AND office_id = ? AND status = 'pending'",
            [submissionId, officeId]
        );
        if (!claimResult || claimResult.affectedRows === 0) {
            claimFailed = true;
            throw new Error('CLAIM_FAILED');
        }

        const [rows] = await conn.query("SELECT * FROM pending_survey_submissions WHERE id = ? LIMIT 1", [submissionId]);
        if (!rows || rows.length === 0) {
            throw new Error('SUBMISSION_NOT_FOUND');
        }
        const row = rows[0];
        googleEmail = row.google_email;
        submittedAtDb = row.created_at;
        payload = parsePendingPayload(row.payload);
        if (!payload || payload.officeId === undefined || !Array.isArray(payload.sqdValues)) {
            // A genuinely unusable payload (not merely a JSON-column vs
            // string mismatch, which parsePendingPayload handles): fail
            // loudly here rather than inserting a half-empty survey row.
            throw new Error('CORRUPT_PAYLOAD');
        }

        // Online-vs-Offline precedence, re-checked HERE (not just when this
        // was originally queued) — time has passed since then, and an
        // Online submission for the same office+account+service may have
        // arrived and become canonical in the meantime. The claim above
        // already prevents double-approving THIS row; the lock below
        // additionally serializes against a concurrent Online submission
        // for the same logical key deciding precedence at the same moment.
        lockName = logicalSurveyLockName(payload.officeId, googleEmail, payload.serviceAvailed);
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // See withLogicalSurveyLock's identical comment: 1 = acquired, 0 =
        // timed out, NULL = a real DB-side error. Only 1 may proceed;
        // logged distinctly so a NULL isn't mistaken for ordinary
        // contention.
        const rawLockResult = (lockRows && lockRows[0]) ? lockRows[0].acquired : undefined;
        lockHeld = rawLockResult === 1 || rawLockResult === '1';
        if (!lockHeld) {
            if (rawLockResult === null) {
                console.error(`❌ [Office Approval] GET_LOCK('${lockName}') returned NULL (DB-side error, not ordinary contention).`);
            }
            const timeoutErr = new Error('Timed out waiting to process this approval — please try again.');
            timeoutErr.code = 'LOCK_TIMEOUT';
            timeoutErr.lockResult = rawLockResult;
            throw timeoutErr;
        }
        const precedence = await resolveSubmissionPrecedence(
            conn, payload.officeId, googleEmail, payload.serviceAvailed, row.submission_source || 'offline_sync',
            { ignorePending: true }
        );

        if (precedence.decision === 'reject' || precedence.decision === 'reject_pending') {
            // An Online submission already owns this logical survey. This
            // pending Offline submission must NOT become a second canonical
            // row — decline it instead of approving, with an accurate
            // reason, and keep the office's approval-history audit trail
            // intact (declined, not silently deleted).
            supersededByOnline = true;
            await conn.query(
                "UPDATE pending_survey_submissions SET status = 'declined', reviewed_at = NOW(), decline_reason = ? WHERE id = ?",
                ['Superseded by a later online submission for this service.', row.id]
            );
            await conn.query(
                "UPDATE offline_survey_submissions SET approval_status = 'rejected' WHERE pending_submission_id = ?",
                [row.id]
            );
            // RELEASE_LOCK must happen AFTER commit, never before — GET_LOCK
            // is session-scoped and independent of transaction state, so a
            // concurrent request waiting on this SAME lock would be free to
            // acquire it and read canonical state the instant it's
            // released. Releasing before commit would let that request read
            // PRE-commit (not-yet-durable, not-yet-visible) state and make
            // its own precedence decision against stale data — exactly the
            // TOCTOU race this lock exists to close.
            await conn.commit();
            await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
            conn.release();

            res.redirect('/office-approvals?error=' + encodeURIComponent('Not approved — the client already has an online submission on record for this service.'));

            createClientNotification({
                clientEmail: googleEmail,
                type: 'pending_declined',
                title: 'Offline Submission Not Needed',
                message: 'Your online submission for this service was already received, so this pending offline copy was not added as a separate response.',
                pendingSubmissionId: submissionId,
                dedupeKey: 'pending-superseded:' + submissionId
            });

            // This branch writes status='declined' too, so the client gets the
            // same Gmail notice as a hand-declined submission — with the
            // superseded reason, which is exactly what was stored on the row.
            notifyClientOfDecline(googleEmail, payload.officeId, {
                name: payload.respondentName,
                serviceAvailed: payload.serviceAvailed,
                reason: 'Superseded by a later online submission for this service.',
                submissionId
            });
            return;
        }

        surveyResponseId = await insertVerifiedSurveyOnConnection(conn, googleEmail, {
            officeId: payload.officeId, respondentName: payload.respondentName,
            topics: payload.topic ? [payload.topic] : (payload.topics || null),
            sentiment: payload.sentiment, region: payload.region, cc1: payload.cc1, cc2: payload.cc2, cc3: payload.cc3,
            sqdValues: payload.sqdValues, comments: payload.comments, serviceAvailed: payload.serviceAvailed,
            clientType: payload.clientType, age: payload.age, gender: payload.gender,
            officeVisitedTime: payload.officeVisitedTime, period: payload.period,
            // The submission's real time, carried over from the pending row this
            // approval is replaying (server-stamped when the client submitted,
            // never client-supplied) — so the response keeps the time the office
            // saw in its Pending list instead of being re-dated to this approval.
            submittedAt: row.created_at,
            // payload.topic(s)/sentiment were never AI-analyzed at queue time
            // (see /submit-survey and syncOneSurvey's non-CSPC branches, which
            // queue with topics: []) — analysis runs asynchronously AFTER this
            // insert, below, same as the live path.
            analysisPending: true
        }, row.submission_source || 'offline_sync');

        if (precedence.supersede) {
            await conn.query(
                "UPDATE survey_responses SET canonical_status = 'superseded', superseded_by_id = ? WHERE id = ? AND canonical_status = 'canonical'",
                [surveyResponseId, precedence.supersede]
            );
        }

        await conn.query("UPDATE pending_survey_submissions SET status = 'approved', reviewed_at = NOW() WHERE id = ?", [row.id]);

        // affectedRows = 0 here is expected/fine — a submission that arrived
        // via the normal online flow simply has no matching offline row.
        // Only a genuine SQL error (caught below) rolls the transaction back.
        await conn.query(
            "UPDATE offline_survey_submissions SET approval_status = 'approved', survey_response_id = ? WHERE pending_submission_id = ?",
            [surveyResponseId, row.id]
        );

        // Same ordering rule as the reject branch above: commit FIRST, then
        // release the lock, so nothing waiting on it can observe pre-commit
        // state.
        await conn.commit();
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    } catch (err) {
        if (lockHeld) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
        try { await conn.rollback(); } catch (rollbackErr) { /* connection may already be unusable */ }
        conn.release();

        if (claimFailed) {
            return res.redirect('/office-approvals?error=' + encodeURIComponent('This submission was already processed or is unavailable.'));
        }
        if (err.code === 'LOCK_TIMEOUT') {
            return res.redirect('/office-approvals?error=' + encodeURIComponent('The server is busy processing another submission for this survey. Please try again shortly.'));
        }
        if (err.message === 'CORRUPT_PAYLOAD') {
            console.error(`❌ [Office Approval] Submission ${submissionId} has an unreadable payload — left pending.`);
            return res.redirect('/office-approvals?error=' + encodeURIComponent("This submission's saved answers could not be read, so it was left pending. Please contact the system administrator."));
        }
        console.error("❌ [Office Approval] Error finalizing approved survey:", err);
        return res.redirect('/office-approvals?error=' + encodeURIComponent('Unable to process the submission. Please try again.'));
    }
    conn.release();

    // Reaching here means the supersededByOnline branch above did NOT run
    // (it returns from the handler entirely, before this point, once its
    // own response/notification are sent) — this is always the normal
    // "approved" outcome.
    res.redirect('/office-approvals?success=' + encodeURIComponent('Survey submission approved successfully.'));

    createClientNotification({
        clientEmail: googleEmail,
        type: 'pending_approved',
        title: 'Survey Approved',
        message: 'Your survey response was approved by the selected office.',
        surveyResponseId,
        pendingSubmissionId: submissionId,
        dedupeKey: 'pending-approved:' + submissionId
    });

    // Fire-and-forget, after commit, same as the pre-transaction version's
    // timing — AI analysis only if this submission's payload didn't already
    // carry a sentiment/topic (mirrors finalizeVerifiedSurvey's own tail).
    if (!isNoFeedbackComment(payload.comments)) {
        analyzeComment(payload.comments, false, payload.officeId).then(({ sentiment: aiSentiment, topics: aiTopics }) => {
            // See the identical /submit-survey comment: analysis_status must
            // always reach 'completed', even on a degraded classification,
            // so the row is never invisible forever.
            if (aiSentiment && aiTopics && aiTopics.length) {
                const [primaryTopic, ...extraTopics] = aiTopics;
                db.query("UPDATE survey_responses SET sentiment = ?, topic = ?, analysis_status = 'completed' WHERE id = ?", [aiSentiment, primaryTopic, surveyResponseId]);
                insertExtraTopics(surveyResponseId, extraTopics);
            } else {
                db.query("UPDATE survey_responses SET analysis_status = 'completed' WHERE id = ?", [surveyResponseId]);
            }
        });
    }

    db.query('SELECT office_name, cluster_name FROM offices WHERE id = ? LIMIT 1', [payload.officeId], (officeErr, officeRows) => {
        const office = (!officeErr && officeRows && officeRows[0]) ? officeRows[0] : null;
        sendSurveyApprovedEmail(googleEmail, {
            name: payload.respondentName,
            officeName: office ? office.office_name : 'Selected Office',
            clusterName: office ? office.cluster_name : '',
            clientType: payload.clientType,
            serviceAvailed: payload.serviceAvailed || 'Not specified',
            // The survey's real submission time (the pending row's created_at,
            // which is also what the approval stored on survey_responses) —
            // NOT "now", which would date the email at the approval.
            submittedAt: formatSubmittedAtForEmail(submittedAtDb ? new Date(submittedAtDb) : null),
            surveyResponseId,
            cc1: payload.cc1, cc2: payload.cc2, cc3: payload.cc3,
            sqd: (payload.sqdValues || []).map((v, i) => ({ label: 'SQD' + i, value: v })),
            comments: payload.comments || 'N/A'
        });
    });
});

// Transactional for the same reason as approve above — the
// pending_survey_submissions decline and the offline_survey_submissions
// tracking update (again a no-op when this didn't originate offline) commit
// or roll back together on one dedicated pooled connection.
app.post('/office-approvals/:id/decline', ensureOfficeAuth, async (req, res) => {
    const officeId = req.officeSession.user.id;
    const reason = String(req.body.decline_reason || '').trim().slice(0, 255) || null;
    const submissionId = req.params.id;

    const conn = await db.promise().getConnection();
    let googleEmail = null;
    let declined = false;
    // Captured inside the transaction, used only AFTER it commits — the
    // decline email needs the respondent's name and the service they answered
    // for, and both live in the pending row's payload, which nothing else on
    // this path had any reason to read before.
    let declinedPayload = {};
    let declinedServiceAvailed = null;
    let submissionOfficeId = officeId;
    try {
        await conn.beginTransaction();

        // No affectedRows guard on the UPDATE below — same as the
        // pre-transaction behavior, the WHERE clause (status='pending' +
        // this office) is the guard against double-processing/wrong-office
        // at the data level; a 0-row match (already processed, wrong
        // office, doesn't exist) still reports success, unchanged from
        // before. `declined` (from that UPDATE's own affectedRows) only
        // gates whether a notification fires below — never the response.
        const [rows] = await conn.query('SELECT google_email, service_availed, office_id, payload FROM pending_survey_submissions WHERE id = ? LIMIT 1', [submissionId]);
        googleEmail = (rows && rows[0]) ? rows[0].google_email : null;
        if (rows && rows[0]) {
            declinedPayload = parsePendingPayload(rows[0].payload);
            declinedServiceAvailed = rows[0].service_availed || declinedPayload.serviceAvailed || null;
            submissionOfficeId = rows[0].office_id || officeId;
        }

        const [declineResult] = await conn.query(
            "UPDATE pending_survey_submissions SET status = 'declined', reviewed_at = NOW(), decline_reason = ? WHERE id = ? AND office_id = ? AND status = 'pending'",
            [reason, submissionId, officeId]
        );
        declined = !!(declineResult && declineResult.affectedRows > 0);

        await conn.query(
            "UPDATE offline_survey_submissions SET approval_status = 'rejected' WHERE pending_submission_id = ?",
            [submissionId]
        );

        await conn.commit();
    } catch (err) {
        try { await conn.rollback(); } catch (rollbackErr) { /* connection may already be unusable */ }
        console.error("❌ [Office Decline] Error declining submission:", err);
        return res.redirect('/office-approvals?error=' + encodeURIComponent('Unable to process the submission. Please try again.'));
    } finally {
        conn.release();
    }

    res.redirect('/office-approvals?success=' + encodeURIComponent('Survey submission declined successfully.'));

    if (declined && googleEmail) {
        createClientNotification({
            clientEmail: googleEmail,
            type: 'pending_rejected',
            title: 'Survey Not Approved',
            message: 'Your survey response was not approved by the selected office.',
            pendingSubmissionId: submissionId,
            dedupeKey: 'pending-rejected:' + submissionId
        });

        // The in-app notification above only ever reaches a client who signs
        // back in. Everything held in pending_survey_submissions comes from a
        // personal (non-@cspc.edu.ph) account, so Gmail is where these clients
        // actually read their outcome — mirrors the approve route, which has
        // emailed its result all along.
        notifyClientOfDecline(googleEmail, submissionOfficeId, {
            name: declinedPayload.respondentName,
            serviceAvailed: declinedServiceAvailed,
            reason,
            submissionId
        });
    }
});

// ==========================================
// GOOGLE OAUTH ROUTES (Client login)
// ==========================================
// `prompt: 'select_account'` forces Google's account chooser on every click instead of
// silently re-authenticating whichever Google account is already signed in on this device.
// `?intent=reset` marks this trip through Google as "verify my identity to reset my
// password" rather than a normal login/registration — stashed in session because
// Google's own redirect back to /auth/google/callback only echoes `code`/`state`,
// not any of our own query params.
app.get('/auth/google', (req, res, next) => {
    if (req.query.intent === 'reset') {
        req.session.googleResetIntent = true;
    } else {
        delete req.session.googleResetIntent;
    }
    next();
}, passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
}));

// Google handles registration, recurring login, AND (with googleResetIntent set)
// password-reset identity verification for clients:
//   - Reset intent + account exists -> Google just verified them; let them set a new
//     local password directly (no e-mailed token needed) via GET/POST /reset-password.
//   - Reset intent + no account for that email -> nothing to reset, send them to register.
//   - New email (no reset intent) -> stash the Google name/email in session and send
//     them to set a local password (they are NOT logged in yet).
//   - Existing email with a password already set -> log them straight in with Google,
//     no need to type the password again.
//   - Existing email with no password (legacy accounts created before this flow existed)
//     -> treat like a new user and have them set a password to finish the upgrade.
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
        const email = req.user && req.user.email;
        const name = req.user && req.user.name;
        const photo = req.user && req.user.photo;
        const isResetIntent = !!req.session.googleResetIntent;
        delete req.session.googleResetIntent;

        if (!email) {
            return req.logout(() => res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed. Please try again.')));
        }

        db.query('SELECT email, password FROM client_accounts WHERE email = ? LIMIT 1', [email], (err, rows) => {
            // Passport's Google strategy logs the user into the session by default — we only
            // want that to persist once a local password has actually been set (or already exists).
            req.logout(() => {
                if (err) {
                    return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                }

                const existingAccount = rows && rows.length > 0 ? rows[0] : null;

                if (isResetIntent) {
                    if (!existingAccount) {
                        return res.redirect('/login?tab=register&error=' + encodeURIComponent('No account found for that Google email. Open the Register tab and sign up with that email first.'));
                    }
                    // Google already verified this identity in this same request — no
                    // separate e-mailed token is needed, just let them set a new password.
                    req.session.googleVerifiedResetEmail = existingAccount.email;
                    return res.redirect('/reset-password?verified=1');
                }

                if (existingAccount && existingAccount.password) {
                    // Regenerate before assigning identity to prevent session
                    // fixation — same reasoning as the /auth-login client path.
                    return req.session.regenerate((regenErr) => {
                        if (regenErr) {
                            return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                        }
                        req.session.clientEmail = existingAccount.email;
                        // Refresh the stored photo on every Google sign-in (Google account photos can
                        // change) — fire-and-forget, doesn't block the redirect.
                        if (photo) {
                            db.query('UPDATE client_accounts SET google_photo_url = ? WHERE email = ?', [photo, existingAccount.email], () => {});
                        }
                        return res.redirect('/client-survey?loggedin=1');
                    });
                }

                req.session.pendingGoogleUser = { email, name, photo };
                return res.redirect('/complete-google-registration');
            });
        });
    }
);

app.get('/complete-google-registration', (req, res) => {
    const pending = req.session.pendingGoogleUser;
    if (!pending) return res.redirect('/login');
    res.render('complete-google-registration', {
        name: pending.name || '',
        email: pending.email,
        photo: pending.photo || null
    });
});

app.post('/complete-google-registration', async (req, res) => {
    const pending = req.session.pendingGoogleUser;
    if (!pending) return res.redirect('/login');

    const { password, confirmPassword } = req.body;

    if (!password || password.length < 8) {
        return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Password must be at least 8 characters long.'));
    }
    if (password !== confirmPassword) {
        return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Passwords do not match.'));
    }

    // What Google hands back is decoration on top of the real account, which is
    // just (email, password): a display name longer than its column, or a photo
    // URL longer than its own, must never be the reason someone cannot register.
    // Clamped to the declared widths here so the INSERT below cannot trip
    // ER_DATA_TOO_LONG on a value the account does not actually depend on.
    const registeredEmail = String(pending.email).trim();
    const respondentName = pending.name ? String(pending.name).trim().slice(0, 255) : null;
    // Same http(s)-only rule /user-accounts applies when it renders this into an
    // <img src>, plus the column width — a URL past 500 chars would only be
    // stored truncated, i.e. broken, so it is dropped rather than saved.
    const rawPhoto = pending.photo ? String(pending.photo).trim() : '';
    const photoUrl = (rawPhoto.length <= 500 && /^https?:\/\//i.test(rawPhoto)) ? rawPhoto : null;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        // Regenerate before assigning identity to prevent session
        // fixation — same reasoning as the /auth-login client path.
        const finishRegistration = () => {
            req.session.regenerate((regenErr) => {
                if (regenErr) {
                    return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                }
                req.session.clientEmail = registeredEmail;
                return res.redirect('/client-survey?loggedin=1');
            });
        };

        // onboarding_completed only takes effect via INSERT (a brand-new account) —
        // ON DUPLICATE KEY UPDATE deliberately omits it, so an email that already had
        // an account (e.g. re-registering) doesn't get its onboarding state reset.
        //
        // `withPhoto` picks between the full insert and one naming only columns
        // that EVERY deployment is guaranteed to have. google_photo_url is not
        // in createClientAccountsTableQuery's original shape — it arrives via a
        // fire-and-forget `ALTER TABLE ... ADD COLUMN` at startup, so one boot
        // where that ALTER failed (a dropped connection against Clever Cloud's
        // 5-connection cap is enough) leaves the column missing permanently, and
        // every registration then dies on a column nobody's account depends on.
        const saveAccount = (withPhoto, done) => {
            if (withPhoto) {
                return db.query(
                    `INSERT INTO client_accounts (email, respondent_name, password, google_photo_url, onboarding_completed)
                     VALUES (?, ?, ?, ?, 0)
                     ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name), password = VALUES(password), google_photo_url = VALUES(google_photo_url)`,
                    [registeredEmail, respondentName, hashedPassword, photoUrl],
                    done
                );
            }
            db.query(
                `INSERT INTO client_accounts (email, respondent_name, password, onboarding_completed)
                 VALUES (?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name), password = VALUES(password)`,
                [registeredEmail, respondentName, hashedPassword],
                done
            );
        };

        // Every failure below is logged with the driver's own code and message.
        // This branch used to discard the error entirely and show the client a
        // bare "Could not save your account", which made a registration that
        // fails in production impossible to diagnose from the logs.
        // A brand-new account row (affectedRows 1; an ON DUPLICATE KEY UPDATE
        // reports 2) means this email is starting over — clear anything the
        // previous, deleted account under the same address left behind before
        // showing the new one its first page.
        const afterSave = (result) => {
            if (result && result.affectedRows === 1) return purgeRowsPredatingAccount(registeredEmail, finishRegistration);
            return finishRegistration();
        };

        saveAccount(true, (err, result) => {
            if (!err) return afterSave(result);

            if (err.code === 'ER_BAD_FIELD_ERROR') {
                console.error(`⚠️  [Google registration] client_accounts is missing a column (${err.sqlMessage || err.message}) — retrying without google_photo_url for ${registeredEmail}.`);
                return saveAccount(false, (retryErr, retryResult) => {
                    if (retryErr) {
                        console.error(`❌ [Google registration] Could not save account for ${registeredEmail}:`, retryErr.code, retryErr.sqlMessage || retryErr.message);
                        return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Could not save your account. Please try again.'));
                    }
                    return afterSave(retryResult);
                });
            }

            console.error(`❌ [Google registration] Could not save account for ${registeredEmail}:`, err.code, err.sqlMessage || err.message);
            return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Could not save your account. Please try again.'));
        });
    } catch (e) {
        console.error(`❌ [Google registration] Unexpected error registering ${registeredEmail}:`, e && (e.stack || e.message || e));
        return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Server error. Please try again.'));
    }
});

// ==========================================
// CLIENT ACCOUNT — Forgot / Reset Password
// ==========================================
// Two independent ways to prove "this is really the account owner" before a new
// local password is accepted, both landing on the same /reset-password form:
//   1. Emailed link — a random token, stored only as its SHA-256 hash (the raw
//      token exists nowhere but the emailed URL and the requester's inbox),
//      valid for 30 minutes, single-use (cleared the moment it's redeemed).
//   2. "Verify with Google instead" — re-runs real Google sign-in (see
//      /auth/google?intent=reset above); success there already proves identity,
//      so no separate token is needed, only the server-side session flag it sets.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Constant-time comparison for reset-token hashes — a plain `===` short-
// circuits on the first mismatched character, leaking (via response timing)
// how many leading hex characters of a guess are correct. Both hashes are
// fixed-length hex SHA-256 digests here, so the length check itself leaks
// nothing an attacker doesn't already know.
function timingSafeHexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

app.get('/forgot-password', noCache, (req, res) => {
    res.render('forgot-password', { sent: req.query.sent === '1' });
});

// Always redirects with the same generic "check your email" outcome whether or
// not the address has an account — confirming account existence to an anonymous
// requester is exactly what a "forgot password" form should never do.
app.post('/forgot-password', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.redirect('/forgot-password');

    db.query('SELECT email FROM client_accounts WHERE email = ? LIMIT 1', [email], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashResetToken(token);
            const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

            db.query(
                'UPDATE client_accounts SET reset_token_hash = ?, reset_token_expires = ? WHERE email = ?',
                [tokenHash, expiresAt, email],
                (updateErr) => {
                    if (updateErr) return console.error('❌ [Password Reset] Error saving reset token:', updateErr);
                    const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
                    sendPasswordResetEmail(email, resetUrl);
                }
            );
        }
        return res.redirect('/forgot-password?sent=1');
    });
});

app.get('/reset-password', noCache, (req, res) => {
    // Path 1: just came back from Google with identity already verified this request.
    if (req.query.verified === '1' && req.session.googleVerifiedResetEmail) {
        return res.render('reset-password', { mode: 'google', email: req.session.googleVerifiedResetEmail, token: null, error: null });
    }

    // Path 2: emailed token link — validate it now so an expired/used/garbage
    // link shows a clear error instead of a form that will just fail on submit.
    const { token, email } = req.query;
    if (token && email) {
        const tokenHash = hashResetToken(String(token));
        db.query(
            'SELECT reset_token_hash, reset_token_expires FROM client_accounts WHERE email = ? LIMIT 1',
            [String(email).trim().toLowerCase()],
            (err, rows) => {
                const row = (!err && rows && rows.length > 0) ? rows[0] : null;
                const valid = row && row.reset_token_hash && timingSafeHexEqual(row.reset_token_hash, tokenHash) && row.reset_token_expires && new Date(row.reset_token_expires) > new Date();
                if (!valid) {
                    return res.render('reset-password', { mode: 'invalid', email: null, token: null, error: 'This reset link is invalid or has expired. Please request a new one.' });
                }
                return res.render('reset-password', { mode: 'token', email: String(email).trim().toLowerCase(), token: String(token), error: null });
            }
        );
        return;
    }

    return res.redirect('/forgot-password');
});

app.post('/reset-password', async (req, res) => {
    const { mode, token, password, confirmPassword } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();

    const fail = (msg) => res.redirect('/reset-password?' + new URLSearchParams({
        ...(mode === 'token' ? { token: token || '', email } : { verified: '1' }),
        error: msg
    }).toString());

    if (!password || password.length < 8) return fail('Password must be at least 8 characters long.');
    if (password !== confirmPassword) return fail('Passwords do not match.');

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        if (mode === 'google') {
            const verifiedEmail = req.session.googleVerifiedResetEmail;
            if (!verifiedEmail) return res.redirect('/forgot-password');

            db.query('UPDATE client_accounts SET password = ? WHERE email = ?', [hashedPassword, verifiedEmail], (err) => {
                if (err) return fail('Could not update your password. Please try again.');
                // Regenerate before assigning identity to prevent session
                // fixation — same reasoning as the /auth-login client path.
                req.session.regenerate((regenErr) => {
                    if (regenErr) return fail('Server error. Please try again.');
                    req.session.clientEmail = verifiedEmail;
                    return res.redirect('/client-survey?loggedin=1');
                });
            });
            return;
        }

        // mode === 'token': re-validate the token server-side (never trust the
        // hidden form fields alone) before actually changing the password.
        if (!email || !token) return res.redirect('/forgot-password');
        const tokenHash = hashResetToken(String(token));

        db.query('SELECT reset_token_hash, reset_token_expires FROM client_accounts WHERE email = ? LIMIT 1', [email], (err, rows) => {
            const row = (!err && rows && rows.length > 0) ? rows[0] : null;
            const valid = row && row.reset_token_hash && timingSafeHexEqual(row.reset_token_hash, tokenHash) && row.reset_token_expires && new Date(row.reset_token_expires) > new Date();
            if (!valid) {
                return res.render('reset-password', { mode: 'invalid', email: null, token: null, error: 'This reset link is invalid or has expired. Please request a new one.' });
            }

            db.query(
                'UPDATE client_accounts SET password = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE email = ?',
                [hashedPassword, email],
                (updateErr) => {
                    if (updateErr) return fail('Could not update your password. Please try again.');
                    // Regenerate before assigning identity to prevent session
                    // fixation — same reasoning as the /auth-login client path.
                    req.session.regenerate((regenErr) => {
                        if (regenErr) return fail('Server error. Please try again.');
                        req.session.clientEmail = email;
                        return res.redirect('/client-survey?loggedin=1');
                    });
                }
            );
        });
    } catch (e) {
        return fail('Server error. Please try again.');
    }
});

// Logs out the admin session, the client session, or both — admin and client
// now live on separate cookies ('admin.sid' / 'client.sid'), so a logout link
// has to say which one it means via ?scope=admin|client; every logout link in
// the views (admin navbar, the cross-tab admin kick-out sync, the client
// survey page) passes the right scope. With no scope given (a stray/old link),
// both are torn down, matching the old unified behavior. Destroys the
// server-side session record entirely (not just nulling fields on it), clears
// the relevant cookie(s), stamps the response so it can never be cached, and
// hard-redirects (302) to /login — never a client-side route change, so there
// is nothing for the bfcache to preserve.
app.get('/logout', noCache, (req, res) => {
    const scope = req.query.scope;
    const wantsAdmin = scope ? scope === 'admin' : true;
    const wantsClient = scope ? scope === 'client' : true;

    const isAdminSession = wantsAdmin && !!(req.adminSession && req.adminSession.user && req.adminSession.user.type === 'admin');
    const isClientSession = wantsClient && !!(req.session && (req.session.clientEmail || (req.isAuthenticated && req.isAuthenticated())));

    const finishClientLogout = (next) => {
        if (!isClientSession) return next();
        req.logout(() => {
            req.session.destroy((err) => {
                if (err) console.error('❌ Error destroying client session on logout:', err);
                res.clearCookie('client.sid', { path: '/' });
                next();
            });
        });
    };

    // Set to true only by real server-side evidence that a newer login had
    // already replaced this session — NEVER by the bare `reason=replaced`
    // query string the BroadcastChannel handler (layout/header.ejs) appends.
    // That param is client-supplied and anyone could type it into the
    // address bar; by itself it must never be enough to manufacture the
    // "signed in elsewhere" message for what might just be a normal logout.
    let confirmedReplaced = false;

    const finishAdminLogout = (next) => {
        if (!isAdminSession) return next();
        // Only clear login_token if THIS session is still the one that owns it —
        // a stale, already-kicked-out tab hitting /logout directly (bypassing
        // ensureAdminAuth) must not null out a newer login made from elsewhere.
        const adminId = req.adminSession.user.id;
        const ownToken = req.adminSession.login_token;
        db.query('UPDATE admins SET login_token = NULL WHERE id = ? AND login_token = ?', [adminId, ownToken], (err, result) => {
            if (err) {
                console.error('❌ Error clearing login_token on logout:', err);
            } else if (!result || result.affectedRows === 0) {
                // The WHERE clause didn't match: admins.login_token was
                // ALREADY something other than this session's own token by
                // the time this ran — i.e. a real newer login had already
                // overwritten it. Genuine server-side evidence, not a guess.
                confirmedReplaced = true;
            }
            closeAdminLogRow(req, () => {
                destroyAdminSession(req, res);
                next();
            });
        });
    };

    finishAdminLogout(() => {
        finishClientLogout(() => {
            // status=logged_out only for a REAL manual logout (an actual
            // session was here), so login.ejs can show the same AppAlert
            // toast design used for the Client Profile "updated successfully"
            // notification — never shown for a /logout hit with no session
            // at all (e.g. a stale/already-expired tab's logout link).
            //
            // The one exception is a confirmed replacement: the cross-tab
            // BroadcastChannel sync script also sends an admin here the
            // instant it detects a REAL newer login happened in a sibling
            // tab of the same browser — that tab never clicked Logout, so it
            // must show the same "signed in elsewhere" message ensureAdminAuth
            // gives the same event server-side. `confirmedReplaced` (the
            // login_token check above) and req._adminSessionMissingReason
            // (the tombstone check — see the cookie-parsing middleware) are
            // the two pieces of ACTUAL server-side evidence for that; the
            // request's own `reason` query param is deliberately never
            // consulted here.
            const replaced = confirmedReplaced || req._adminSessionMissingReason === 'replaced';
            let status = null;
            if (replaced) status = 'session_replaced';
            else if (isAdminSession || isClientSession) status = 'logged_out';
            res.redirect(302, status ? ('/login?status=' + status) : '/login');
        });
    });
});

app.get('/client-survey', ensureClientAuth, noCache, (req, res) => {
    const clientEmail = req.clientEmail;

    db.query('SELECT * FROM offices WHERE is_archived = 0 ORDER BY office_name ASC', (err, offices) => {
        if (err) return res.render('client-survey', { offices: [], clientEmail, blockedCombos: {}, blockedUntil: {}, serviceAvailability: {}, clientProfile: null, officeServices: {}, offlineMode: false, showOnboarding: false });

        // All active services, grouped by office_id — powers the dependent
        // "Service Availed" dropdown (#serviceSelect) on the client side. Also
        // carries each service's resubmission cadence (see isEligibleForResubmission).
        db.query('SELECT office_id, service_name, availability FROM services ORDER BY office_id, id', (errServices, serviceRows) => {
            const officeServices = {};
            const serviceAvailability = {}; // "officeId::serviceName" -> availability
            if (!errServices && serviceRows) {
                serviceRows.forEach(row => {
                    if (!officeServices[row.office_id]) officeServices[row.office_id] = [];
                    officeServices[row.office_id].push(row.service_name);
                    serviceAvailability[row.office_id + '::' + row.service_name] = row.availability;
                });
            }

            // Most recent APPROVED submission per (office, service) this account has —
            // combined with still-pending requests below to build the set of combos
            // currently blocked from resubmission (see isEligibleForResubmission).
            db.query(
                "SELECT office_id, service_availed, MAX(created_at) AS last_at FROM survey_responses WHERE google_email = ? AND canonical_status = 'canonical' GROUP BY office_id, service_availed",
                [clientEmail],
                (err2, approvedRows) => {
                    db.query(
                        "SELECT office_id, service_availed FROM pending_survey_submissions WHERE google_email = ? AND status = 'pending'",
                        [clientEmail],
                        (err4, pendingRows) => {
                            const blockedCombos = {};
                            // "officeId::serviceName" -> epoch ms this account becomes eligible
                            // again, for cadence-based services only (daily/weekly/monthly/yearly).
                            // Powers the live countdown next to a blocked service on the client —
                            // a combo can be in blockedCombos without a blockedUntil entry (still
                            // pending review, or permanently one-time-only), in which case the
                            // client shows the static message instead of a countdown.
                            const blockedUntil = {};

                            (pendingRows || []).forEach(row => {
                                blockedCombos[row.office_id + '::' + row.service_availed] = "Awaiting the office's review.";
                            });

                            (!err2 && approvedRows ? approvedRows : []).forEach(row => {
                                const key = row.office_id + '::' + row.service_availed;
                                if (blockedCombos[key]) return; // already blocked by a pending request
                                const availability = serviceAvailability[key];
                                if (!isEligibleForResubmission(row.last_at, availability)) {
                                    const nextDate = nextEligibleDateText(row.last_at, availability);
                                    blockedCombos[key] = nextDate
                                        ? `You can retake this survey starting ${nextDate}.`
                                        : 'You have already evaluated this service.';
                                    const nextTs = nextEligibleTimestamp(row.last_at, availability);
                                    if (nextTs) blockedUntil[key] = nextTs;
                                }
                            });

                            // Saved/locked demographics from this account's first-ever submission
                            // (if any), plus the account's registered name — respondent_name is
                            // set at registration (Google name) and kept up to date on every
                            // survey submission, so it's always available here regardless of
                            // whether this is the account's first or a later visit.
                            db.query('SELECT respondent_name, region, age, gender, onboarding_completed FROM client_accounts WHERE email = ? LIMIT 1', [clientEmail], (err3, profileRows) => {
                                const clientProfile = (!err3 && profileRows && profileRows.length > 0) ? profileRows[0] : null;
                                // Shows the one-time setup wizard only for accounts that registered
                                // through /complete-google-registration with onboarding_completed = 0
                                // still unset — see the ALTER TABLE comment near client_accounts for
                                // why every pre-existing/backfilled account is excluded by default.
                                const showOnboarding = !!(clientProfile && Number(clientProfile.onboarding_completed) === 0);
                                res.render('client-survey', { offices, clientEmail, blockedCombos, blockedUntil, serviceAvailability, clientProfile, officeServices, offlineMode: false, showOnboarding });
                            });
                        }
                    );
                }
            );
        });
    });
});

// Marks the one-time setup wizard (shown on /client-survey right after
// registration — see showOnboarding above) as dismissed, whether the client
// finished it or clicked Skip. Idempotent: called at most once per account in
// normal use, but harmless if called again.
app.post('/api/onboarding-complete', ensureClientAuth, noCache, (req, res) => {
    db.query('UPDATE client_accounts SET onboarding_completed = 1 WHERE email = ?', [req.clientEmail], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error saving your progress.' });
        res.json({ success: true });
    });
});

// ==========================================
// CLIENT ACCOUNT — Profile tab (view/update)
// ==========================================
// Region/Age/Sex are intentionally NOT editable here — they lock after the first
// survey submission (see /submit-survey) and that rule must hold everywhere,
// not just be hidden in the UI. Only respondent_name can be changed.
app.get('/api/client-profile', ensureClientAuth, noCache, (req, res) => {
    db.query(
        'SELECT email, respondent_name, region, age, gender, google_photo_url, password FROM client_accounts WHERE email = ? LIMIT 1',
        [req.clientEmail],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: 'Server error loading your profile.' });
            const row = (rows && rows.length > 0) ? rows[0] : { email: req.clientEmail, respondent_name: null, region: null, age: null, gender: null, google_photo_url: null, password: null };
            const profile = {
                email: row.email,
                respondent_name: row.respondent_name,
                region: row.region,
                age: row.age,
                gender: row.gender,
                photo_url: row.google_photo_url || null,
                // Whether one EXISTS, never the hash itself — the Profile tab
                // needs this to decide between "set a password" and "change
                // your password" (a Google-only account has none yet).
                has_password: !!row.password
            };
            res.json({ success: true, profile });
        }
    );
});

// Builds the non-secret (but still personal — see the account-identifying
// fields it returns) offline-context snapshot for one account: its
// registered profile (age/sex/region) plus current office/service
// eligibility. Reuses the EXACT SAME eligibility rules /client-survey's
// route already computes (isEligibleForResubmission/nextEligibleTimestamp,
// keyed the same "officeId::serviceName" way as blockedCombos/blockedUntil
// on the client) — never a separate cooldown algorithm. This app has no
// office-level cooldown (confirmed: no such column/table exists — cooldown
// is purely per office+service pair, see checkResubmissionEligibility), so
// unlike the office-level "eligible"/"cooldownUntil" shape a generic offline
// spec might expect, offices here only carry id/name for offline display;
// all eligibility lives on `services`. Shared by GET /api/client/offline-
// context (below) and the post-sync refresh in POST /api/offline-surveys/
// verify-and-sync. Contains no password, hash, token, cookie, or session
// data — but the email/age/gender/region/service-activity it DOES return
// are personal account information, not "non-sensitive" in any absolute
// sense; only what's needed to improve offline UX is included.
async function buildClientOfflineContext(clientEmail) {
    const [officeRows, serviceRows, approvedRows, pendingRows, profileRows] = await Promise.all([
        dbQuery('SELECT id, office_name FROM offices WHERE is_archived = 0 ORDER BY office_name ASC'),
        dbQuery('SELECT office_id, service_name, availability FROM services ORDER BY office_id, id'),
        dbQuery("SELECT office_id, service_availed, MAX(created_at) AS last_at FROM survey_responses WHERE google_email = ? AND canonical_status = 'canonical' GROUP BY office_id, service_availed", [clientEmail]),
        dbQuery("SELECT office_id, service_availed FROM pending_survey_submissions WHERE google_email = ? AND status = 'pending'", [clientEmail]),
        dbQuery('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [clientEmail])
    ]);

    const serviceAvailability = {};
    (serviceRows || []).forEach((row) => {
        serviceAvailability[row.office_id + '::' + row.service_name] = row.availability;
    });

    // Same precedence as /client-survey's blockedCombos: a pending review
    // blocks regardless of cadence; otherwise fall back to the cadence-based
    // resubmission check against the most recent APPROVED submission.
    const blockedKeys = new Set();
    const cooldownUntilMs = {};
    (pendingRows || []).forEach((row) => {
        blockedKeys.add(row.office_id + '::' + row.service_availed);
    });
    (approvedRows || []).forEach((row) => {
        const key = row.office_id + '::' + row.service_availed;
        if (blockedKeys.has(key)) return;
        const availability = serviceAvailability[key];
        if (!isEligibleForResubmission(row.last_at, availability)) {
            blockedKeys.add(key);
            const nextTs = nextEligibleTimestamp(row.last_at, availability);
            if (nextTs) cooldownUntilMs[key] = nextTs;
        }
    });

    const services = (serviceRows || []).map((row) => {
        const key = row.office_id + '::' + row.service_name;
        return {
            officeId: row.office_id,
            serviceName: row.service_name,
            eligible: !blockedKeys.has(key),
            cooldownUntil: cooldownUntilMs[key] ? new Date(cooldownUntilMs[key]).toISOString() : null
        };
    });

    const profileRow = (profileRows && profileRows[0]) || null;

    return {
        accountIdentifier: clientEmail,
        profile: {
            age: (profileRow && profileRow.age) || null,
            sex: (profileRow && profileRow.gender) || null,
            region: (profileRow && profileRow.region) || null
        },
        offices: (officeRows || []).map((o) => ({ officeId: o.id, officeName: o.office_name })),
        services,
        cachedAt: new Date().toISOString()
    };
}

// GET /api/client/offline-context
// Called silently by client-survey.ejs right after an authenticated page
// load (and after a successful online submission) so the browser can cache
// this account's non-secret (personal, but never a credential) profile/
// eligibility snapshot in IndexedDB (offlineAccountContext store — see
// offline-db.js) for /survey-offline to use later. Never includes a
// password, hash, token, or session identifier.
app.get('/api/client/offline-context', ensureClientAuth, noCache, async (req, res) => {
    try {
        const context = await buildClientOfflineContext(req.clientEmail);
        res.json({ success: true, ...context });
    } catch (err) {
        console.error('❌ [Offline Context] Failed to build context:', err);
        res.status(500).json({ success: false, message: 'Server error loading offline context.' });
    }
});

// ==========================================
// CLIENT NOTIFICATIONS API
// ==========================================
// Every route below is ensureClientAuth'd and every query is scoped by
// req.clientEmail (the server-derived session identity) — NEVER by
// anything the request body/query supplies. This is the only thing that
// prevents Account A from reading/marking/deleting Account B's
// notifications by editing an id in DevTools: the WHERE clause itself
// makes a mismatched id simply match zero rows, not an authorization
// bypass. Deletes are soft (deleted_at) — see client_notifications' schema
// comment above; nothing here ever touches survey_responses,
// pending_survey_submissions, offline_survey_submissions, client_accounts,
// or any offline/IndexedDB state.
app.get('/api/client/notifications', ensureClientAuth, noCache, async (req, res) => {
    try {
        const rows = await dbQuery(
            `SELECT id, type, title, message, survey_response_id, pending_submission_id, offline_submission_id,
                    is_read, created_at, read_at
             FROM client_notifications
             WHERE client_email = ? AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 50`,
            [req.clientEmail]
        );
        const unreadRow = await dbQuery(
            'SELECT COUNT(*) AS unread FROM client_notifications WHERE client_email = ? AND is_read = 0 AND deleted_at IS NULL',
            [req.clientEmail]
        );
        res.json({ success: true, notifications: rows, unreadCount: (unreadRow && unreadRow[0]) ? unreadRow[0].unread : 0 });
    } catch (err) {
        console.error('❌ [Notifications] Failed to load notifications:', err);
        res.status(500).json({ success: false, message: 'Server error loading notifications.' });
    }
});

app.patch('/api/client/notifications/read-all', ensureClientAuth, async (req, res) => {
    try {
        await dbQuery(
            "UPDATE client_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE client_email = ? AND is_read = 0 AND deleted_at IS NULL",
            [req.clientEmail]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [Notifications] Failed to mark all read:', err);
        res.status(500).json({ success: false, message: 'Server error updating notifications.' });
    }
});

app.patch('/api/client/notifications/:id/read', ensureClientAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid notification id.' });
    try {
        await dbQuery(
            "UPDATE client_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND client_email = ? AND deleted_at IS NULL",
            [id, req.clientEmail]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [Notifications] Failed to mark notification read:', err);
        res.status(500).json({ success: false, message: 'Server error updating notification.' });
    }
});

app.delete('/api/client/notifications', ensureClientAuth, async (req, res) => {
    try {
        await dbQuery(
            'UPDATE client_notifications SET deleted_at = CURRENT_TIMESTAMP WHERE client_email = ? AND deleted_at IS NULL',
            [req.clientEmail]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [Notifications] Failed to clear notifications:', err);
        res.status(500).json({ success: false, message: 'Server error clearing notifications.' });
    }
});

app.delete('/api/client/notifications/:id', ensureClientAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid notification id.' });
    try {
        await dbQuery(
            'UPDATE client_notifications SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND client_email = ? AND deleted_at IS NULL',
            [id, req.clientEmail]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [Notifications] Failed to delete notification:', err);
        res.status(500).json({ success: false, message: 'Server error deleting notification.' });
    }
});

app.post('/api/client-profile', ensureClientAuth, (req, res) => {
    const respondentName = String(req.body.respondent_name || '').trim().slice(0, 255);
    if (!respondentName) {
        return res.status(400).json({ success: false, message: 'Name cannot be empty.' });
    }
    db.query(
        `INSERT INTO client_accounts (email, respondent_name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name)`,
        [req.clientEmail, respondentName],
        (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Could not save your profile.' });
            res.json({ success: true, respondent_name: respondentName });
        }
    );
});

// ==========================================
// CLIENT ACCOUNT — Change password (Profile tab)
// ==========================================
// Session-authenticated, but still rate-limited: the current-password check
// below is an online guessing oracle for anyone who gets hold of a live
// session, so a wrong current password must not be cheap to retry.
const clientPasswordChangeLimiter = jsonRateLimiter('client-password-change', { windowMs: 15 * 60 * 1000, max: 10 });

app.post('/api/client-password', ensureClientAuth, clientPasswordChangeLimiter, async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    // Same 8-character floor the account was created under
    // (/complete-google-registration), so the two can't drift apart.
    if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Your new password must be at least 8 characters long.' });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Your new passwords do not match.' });
    }

    try {
        const rows = await dbQuery('SELECT password FROM client_accounts WHERE email = ? LIMIT 1', [req.clientEmail]);
        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        const existingHash = rows[0].password;

        // A NULL hash means this account has never had a password — a
        // Google-only sign-in. There is no current password to prove, so this
        // becomes a "set a password" flow rather than a change. The session
        // already proves who they are, which is the same standard
        // /complete-google-registration used to set the first one.
        if (existingHash) {
            if (!currentPassword) {
                return res.status(400).json({ success: false, message: 'Please enter your current password.' });
            }
            const ok = await bcrypt.compare(currentPassword, existingHash);
            if (!ok) {
                return res.status(400).json({ success: false, message: 'Your current password is incorrect.' });
            }
            // Pointless churn, and a good sign the user misunderstood the form.
            const same = await bcrypt.compare(newPassword, existingHash);
            if (same) {
                return res.status(400).json({ success: false, message: 'Your new password must be different from your current one.' });
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbQuery('UPDATE client_accounts SET password = ? WHERE email = ?', [hashedPassword, req.clientEmail]);

        // Session deliberately left intact: the user is standing at their own
        // profile page and just confirmed their current password, so logging
        // them out here would be pure friction, not added safety.
        return res.json({
            success: true,
            message: existingHash ? 'Your password has been updated.' : 'Your password has been set.'
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Could not update your password. Please try again.' });
    }
});

// ==========================================
// CLIENT ACCOUNT — History tab (past submitted surveys)
// ==========================================
// History = approved (survey_responses) + still-pending/declined submissions
// (pending_survey_submissions) for @cspc-exempt accounts, merged and sorted by
// date. Pending-table rows use a "p"-prefixed id (their own auto-increment
// column is a separate namespace from survey_responses.id) and are never
// clickable into /api/client-history/:id — there's no reviewed answer detail
// to show yet.
app.get('/api/client-history', ensureClientAuth, noCache, (req, res) => {
    const approvedQuery = `
        SELECT s.id, o.office_name, o.cluster_name, s.topic, s.sentiment,
               s.created_at, DATE_FORMAT(s.created_at, '%M %d, %Y') AS formatted_date
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        WHERE s.google_email = ? AND s.canonical_status = 'canonical'
    `;
    db.query(approvedQuery, [req.clientEmail], (err, approvedRows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error loading your survey history.', history: [] });

        const pendingQuery = `
            SELECT p.id, o.office_name, o.cluster_name, p.service_availed, p.status, p.decline_reason,
                   p.created_at, DATE_FORMAT(p.created_at, '%M %d, %Y') AS formatted_date
            FROM pending_survey_submissions p
            JOIN offices o ON p.office_id = o.id
            WHERE p.google_email = ? AND p.status <> 'approved'
        `;
        db.query(pendingQuery, [req.clientEmail], (err2, pendingRows) => {
            const approved = (approvedRows || []).map(r => ({
                id: r.id, office_name: r.office_name, cluster_name: r.cluster_name,
                topic: r.topic, sentiment: r.sentiment, formatted_date: formatZonedDateLong(r.created_at) || r.formatted_date,
                created_at: r.created_at, status: 'approved'
            }));
            const pending = (!err2 && pendingRows ? pendingRows : []).map(r => ({
                id: 'p' + r.id, office_name: r.office_name, cluster_name: r.cluster_name,
                service_availed: r.service_availed, decline_reason: r.decline_reason,
                formatted_date: formatZonedDateLong(r.created_at) || r.formatted_date, created_at: r.created_at, status: r.status
            }));
            const history = approved.concat(pending).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            res.json({ success: true, history });
        });
    });
});

// Full answers for one past submission — only returns the record if it belongs
// to the logged-in client, so nobody can peek at another respondent's answers.
app.get('/api/client-history/:id', ensureClientAuth, noCache, (req, res) => {
    const query = `
        SELECT s.id, s.topic, s.sentiment, s.region, s.cc1, s.cc2, s.cc3,
               s.sqd0, s.sqd1, s.sqd2, s.sqd3, s.sqd4, s.sqd5, s.sqd6, s.sqd7, s.sqd8,
               s.comments, s.period_year_quarter, s.created_at,
               DATE_FORMAT(s.created_at, '%M %d, %Y %h:%i %p') AS formatted_date,
               o.office_name, o.cluster_name,
               p.client_type, p.age, p.gender,
               DATE_FORMAT(p.office_visited_time, '%M %d, %Y %h:%i %p') AS office_visited_time_formatted
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        LEFT JOIN client_profiles p ON p.survey_response_id = s.id
        WHERE s.id = ? AND s.google_email = ?
        LIMIT 1
    `;
    db.query(query, [req.params.id, req.clientEmail], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error loading this survey.' });
        if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'Survey not found.' });
        // Printed in the display zone (see formatZonedDateTimeLong), not the DB session's.
        rows[0].formatted_date = formatZonedDateTimeLong(rows[0].created_at) || rows[0].formatted_date;
        res.json({ success: true, survey: rows[0] });
    });
});

app.post('/submit-survey', ensureClientAuth, async (req, res) => {
    // Raw incoming request body — on a repeat visit, disabled HTML fields
    // (age/gender/region, locked after first submission) don't get sent by
    // the browser at all, so this will legitimately show them missing/
    // 'Not Specified' even though the actual saved value is correct. See the
    // "📤 [Survey Final Fields]" log below for what's really used/stored.
    console.log("📥 [Survey Payload Dumating] (raw, pre-profile-merge):", req.body);

    const googleEmail = req.clientEmail;

    // Region/Age/Sex are locked per account after the first-ever submission. Standard
    // HTML forms don't submit values for disabled fields, so req.body may simply be
    // missing region/age/gender on repeat visits — fetch the saved profile first and
    // let it win over (or fill in for) whatever the client actually posted.
    let savedProfile = null;
    try {
        const profileLookupRows = await dbQuery('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [googleEmail]);
        savedProfile = (profileLookupRows && profileLookupRows.length > 0) ? profileLookupRows[0] : null;
    } catch (profileLookupErr) {
        console.error("❌ [Survey] Profile lookup error:", profileLookupErr);
    }

    const {
        office_id, topic, cc1, cc2, cc3,
        sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, service_availed,
        office_visited_time
    } = req.body;

    const respondent_name = req.body.respondent_name || req.body.respondentName || req.body.client_name || req.body.name;
    const client_type = req.body.client_type || req.body.clientType || req.body.client_role;

    // Saved DB value always wins once it exists — this is what makes the fields
    // truly locked server-side, not just visually disabled in the browser.
    const region = (savedProfile && savedProfile.region) || req.body.region;
    const age = (savedProfile && savedProfile.age) || req.body.age || req.body.clientAge || req.body.client_age;
    const gender = (savedProfile && savedProfile.gender) || req.body.gender || req.body.clientGender || req.body.client_gender;

    if (!office_id) {
        return res.status(400).json({ success: false, message: "Missing selected office ID." });
    }

    const cleanInt = (val) => (val !== undefined && val !== "" && val !== null && !isNaN(val)) ? parseInt(val, 10) : null;
    const cleanStr = (val) => (val !== undefined && val !== null && String(val).trim() !== "") ? String(val).trim() : null;

    const finalName = cleanStr(respondent_name) || 'Anonymous';
    const finalClientType = cleanStr(client_type) || 'Citizen';
    const finalAge = allowlisted(age, VALID_AGE_BRACKETS) || 'Not Specified';
    const finalGender = allowlisted(gender, VALID_GENDERS) || 'Not Specified';
    const finalRegion = allowlisted(region, VALID_REGIONS) || 'Not Specified';
    const finalOfficeId = cleanInt(office_id);
    const finalOfficeVisitedTime = cleanTime(office_visited_time);
    const finalServiceAvailed = cleanStr(service_availed);
    // This attempt's stable client-generated id (see activeSurveyDraftId
    // in client-survey.ejs) — checked BEFORE the precedence lock below so a
    // retried submit (e.g. a lost response, or the pending-logout race
    // handled client-side by re-submitting after a 401) resolves to the
    // same existing row instead of contending for the lock at all.
    const finalClientSubmissionId = cleanStr(req.body.client_submission_id || req.body.clientSubmissionId);

    if (finalClientSubmissionId) {
        const existing = await findSurveyByClientSubmissionId(finalClientSubmissionId);
        if (existing) {
            return res.json({ success: true, alreadyRecorded: true, message: "Survey recorded successfully!" });
        }
    }

    const sqdValues = [sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8].map(cleanInt);
    const fields = {
        officeId: finalOfficeId, respondentName: finalName, topics: cleanStr(topic) ? [cleanStr(topic)] : [],
        region: finalRegion, cc1: cleanStr(cc1), cc2: cleanStr(cc2), cc3: cleanStr(cc3),
        sqdValues, comments: cleanStr(comments), serviceAvailed: finalServiceAvailed,
        clientType: finalClientType, age: finalAge, gender: finalGender,
        officeVisitedTime: finalOfficeVisitedTime, period: getPeriodCovered(),
        clientSubmissionId: finalClientSubmissionId,
        // AI analysis runs asynchronously AFTER this insert (fire-and-forget,
        // below) — see insertVerifiedSurveyOnConnection's analysisPending
        // handling for why this row starts 'pending' instead of 'completed'.
        analysisPending: true
    };
    console.log("📤 [Survey Final Fields] (after profile merge, what actually gets stored):", fields);

    // This is a genuinely live, connected request from an authenticated
    // session — always 'online', regardless of anything the client might
    // claim (see module rule #13: source is derived from the route, never
    // from request JSON).
    const SUBMISSION_SOURCE = 'online';

    try {
        // @cspc.edu.ph accounts are trusted automatically and land straight in
        // survey_responses, exactly as before. Any other email must first be
        // verified by the office the client says they visited — see /office-approvals.
        if (isCspcEmail(googleEmail)) {
            const { surveyResponseId, supersededId, alreadyRecorded } = await submitCanonicalSurvey(googleEmail, fields, SUBMISSION_SOURCE);

            res.json({ success: true, message: "Survey recorded successfully!" });

            if (alreadyRecorded) return;

            if (supersededId) {
                console.log(`✅ [Online Precedence] Survey ID ${surveyResponseId} superseded earlier Offline canonical row ID ${supersededId} (same office/account/service).`);
            }

            // Receipt email + AI analysis — same timing/behavior as the old
            // finalizeVerifiedSurvey tail: fire-and-forget, after the
            // response, never inside the lock/transaction above.
            db.query('SELECT office_name, cluster_name FROM offices WHERE id = ? LIMIT 1', [finalOfficeId], (officeErr, officeRows) => {
                const office = (!officeErr && officeRows && officeRows[0]) ? officeRows[0] : null;
                sendSurveyReceiptEmail(googleEmail, {
                    name: finalName,
                    officeName: office ? office.office_name : 'Selected Office',
                    clusterName: office ? office.cluster_name : '',
                    clientType: finalClientType,
                    serviceAvailed: finalServiceAvailed || 'Not specified',
                    submittedAt: new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE }),
                    surveyResponseId,
                    cc1: fields.cc1, cc2: fields.cc2, cc3: fields.cc3,
                    sqd: sqdValues.map((v, i) => ({ label: 'SQD' + i, value: v })),
                    comments: fields.comments || 'N/A'
                });
            });

            if (!isNoFeedbackComment(fields.comments)) {
                analyzeComment(fields.comments, false, finalOfficeId).then(({ sentiment: aiSentiment, topics: aiTopics }) => {
                    // Always flips analysis_status to 'completed', even on a
                    // degraded/failed classification (analyzeComment never
                    // rejects, but a bad API key etc. could still leave
                    // aiSentiment/aiTopics falsy) — a row must never stay
                    // 'pending' forever and invisible to every admin view.
                    if (aiSentiment && aiTopics && aiTopics.length) {
                        const [primaryTopic, ...extraTopics] = aiTopics;
                        db.query("UPDATE survey_responses SET sentiment = ?, topic = ?, analysis_status = 'completed' WHERE id = ?", [aiSentiment, primaryTopic, surveyResponseId]);
                        insertExtraTopics(surveyResponseId, extraTopics);
                        console.log(`✅ [AI Success] ID: ${surveyResponseId} | Sentiment: ${aiSentiment} | Topics: ${aiTopics.join(', ')}`);
                    } else {
                        db.query("UPDATE survey_responses SET analysis_status = 'completed' WHERE id = ?", [surveyResponseId]);
                    }
                });
            }
            return;
        }

        await queuePendingSurveyWithPrecedence(finalOfficeId, googleEmail, finalServiceAvailed, fields, SUBMISSION_SOURCE);
        res.json({ success: true, pending: true, message: "Submitted! The office you visited will verify your visit before this is recorded." });
    } catch (err) {
        if (err.code === 'ELIGIBILITY_REJECTED') {
            return res.status(409).json({ success: false, message: err.rejectMessage });
        }
        if (err.code === 'PENDING_REJECTED') {
            return res.status(409).json({ success: false, message: err.rejectMessage });
        }
        if (err.code === 'LOCK_TIMEOUT') {
            return res.status(503).json({ success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again in a moment.' });
        }
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: "You have already evaluated this office. You cannot submit again." });
        }
        console.error("❌ [Survey] Database insertion error:", err);
        return res.status(500).json({ success: false, message: "Database insertion error: " + err.message });
    }
});

// ==========================================
// OFFLINE SYNC — receives the queued surveys from the client's IndexedDB
// outbox once the Service Worker (or the page-side 'online' fallback)
// detects the connection is back. Unlike /submit-survey, this route AWAITS
// the AI analysis for each survey before inserting it, and only answers
// 200 OK once every survey in the batch has been analyzed (or safely
// defaulted) and written to the database — that response is exactly what
// tells the Service Worker it's safe to delete those records from
// IndexedDB, so nothing is dropped and nothing skips analysis.
// ==========================================
app.post('/sync-surveys', ensureClientAuth, async (req, res) => {
    const googleEmail = req.clientEmail;
    const rawSurveys = Array.isArray(req.body.surveys) ? req.body.surveys : (Array.isArray(req.body) ? req.body : []);

    if (!rawSurveys.length) {
        return res.status(400).json({ success: false, message: "No surveys provided to sync." });
    }

    const results = [];

    // Sequential on purpose: each iteration needs its own fresh duplicate-check
    // against rows inserted by the *previous* iteration, and it avoids spawning
    // a pile of concurrent Python interpreters for a large batch.
    for (const item of rawSurveys) {
        const localId = item && item.localId;
        const payload = (item && item.payload) || item || {};
        try {
            // localId is this survey attempt's stable client-generated id
            // (see activeSurveyDraftId in client-survey.ejs) — passed
            // through as the idempotency key so a retried sync (a lost
            // response, two near-simultaneous sync attempts) resolves to
            // the same existing row instead of a second insert.
            const result = await syncOneSurvey(googleEmail, payload, localId, item && item.createdOfflineAt);
            results.push({ localId, ...result });
        } catch (err) {
            console.error("❌ [Sync] Unexpected error syncing survey:", err);
            results.push({ localId, success: false, message: "Unexpected server error while syncing this survey." });
        }
    }

    res.status(200).json({ success: true, results });
});

async function syncOneSurvey(googleEmail, body, clientSubmissionId, createdOfflineAtRaw) {
    // When the respondent actually finished this survey offline (null = unknown
    // or implausible, so it is stamped at sync time as before).
    const submittedAt = resolveOfflineSubmittedAt(createdOfflineAtRaw);
    const cleanInt = (val) => (val !== undefined && val !== "" && val !== null && !isNaN(val)) ? parseInt(val, 10) : null;
    const cleanStr = (val) => (val !== undefined && val !== null && String(val).trim() !== "") ? String(val).trim() : null;

    // A retry of an already-recorded submission id must resolve as success
    // immediately — BEFORE the resubmission-eligibility check below, which
    // would otherwise (correctly, for a genuinely NEW submission, but
    // wrongly here) reject it: the row this exact id already created is
    // itself what would make that office/service look "already answered".
    const finalClientSubmissionId = cleanStr(clientSubmissionId);
    if (finalClientSubmissionId) {
        const existing = await findSurveyByClientSubmissionId(finalClientSubmissionId);
        if (existing) {
            return { success: true, alreadySynced: true, surveyResponseId: existing.id, sentiment: 'Neutral', topics: ['General Feedback'] };
        }
    }

    const { office_id, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, office_visited_time, service_availed } = body;

    const finalOfficeId = cleanInt(office_id);
    if (!finalOfficeId) {
        return { success: false, message: "Missing selected office ID." };
    }

    const respondent_name = body.respondent_name || body.respondentName || body.client_name || body.name;
    const client_type = body.client_type || body.clientType || body.client_role;

    let savedProfile = null;
    try {
        const profileRows = await dbQuery('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [googleEmail]);
        savedProfile = (profileRows && profileRows.length > 0) ? profileRows[0] : null;
    } catch (err) {
        console.error("❌ [Sync] Profile lookup error:", err);
    }

    const region = (savedProfile && savedProfile.region) || body.region;
    const age = (savedProfile && savedProfile.age) || body.age || body.clientAge || body.client_age;
    const gender = (savedProfile && savedProfile.gender) || body.gender || body.clientGender || body.client_gender;

    const finalName = cleanStr(respondent_name) || 'Anonymous';
    const finalClientType = cleanStr(client_type) || 'Citizen';
    const finalAge = allowlisted(age, VALID_AGE_BRACKETS) || 'Not Specified';
    const finalGender = allowlisted(gender, VALID_GENDERS) || 'Not Specified';
    const finalRegion = allowlisted(region, VALID_REGIONS) || 'Not Specified';
    const finalOfficeVisitedTime = cleanTime(office_visited_time);
    const finalServiceAvailed = cleanStr(service_availed);

    const sqdValues = [sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8].map(cleanInt);
    // Filed under the half-year it was ANSWERED in, not the one the sync
    // happened to land in (a survey done June 30 offline, synced July 1).
    const currentPeriod = getPeriodCovered(submittedAt || new Date());

    // This survey was ANSWERED offline and is only now reaching the server
    // through the authenticated queue-sync route — 'offline_sync' regardless
    // of how fast the connection came back, never 'online' (see module
    // rule #13: source reflects the submission's own channel, not whether
    // the request that finally delivered it happens to be online right
    // now).
    const SUBMISSION_SOURCE = 'offline_sync';

    // @cspc.edu.ph accounts are trusted automatically; anything else waits for
    // the visited office to approve it — see /submit-survey for the same logic.
    if (!isCspcEmail(googleEmail)) {
        try {
            await queuePendingSurveyWithPrecedence(finalOfficeId, googleEmail, finalServiceAvailed, {
                officeId: finalOfficeId, respondentName: finalName, topics: [], region: finalRegion,
                cc1: cleanStr(cc1), cc2: cleanStr(cc2), cc3: cleanStr(cc3), sqdValues,
                comments: cleanStr(comments), serviceAvailed: finalServiceAvailed,
                clientType: finalClientType, age: finalAge, gender: finalGender,
                officeVisitedTime: finalOfficeVisitedTime, period: currentPeriod
            }, SUBMISSION_SOURCE, submittedAt);
        } catch (err) {
            if (err.code === 'ELIGIBILITY_REJECTED' || err.code === 'PENDING_REJECTED') {
                return { success: false, status: 'rejected', message: err.rejectMessage };
            }
            if (err.code === 'LOCK_TIMEOUT') {
                return { success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again shortly.' };
            }
            console.error("❌ [Sync] Error queuing submission for office review:", err);
            return { success: false, message: "Database error while submitting your survey." };
        }
        return { success: true, pending: true, message: "Submitted! The office you visited will verify your visit before this is recorded." };
    }

    // Precedence check happens BEFORE the (slower) AI call — no point
    // running sentiment/topic analysis for a survey that's about to be
    // rejected/superseded because an Online canonical response already
    // exists for this exact office+account+service.
    let precedenceResult;
    try {
        precedenceResult = await withLogicalSurveyLock(finalOfficeId, googleEmail, finalServiceAvailed, (conn) =>
            resolveSubmissionPrecedence(conn, finalOfficeId, googleEmail, finalServiceAvailed, SUBMISSION_SOURCE)
        );
    } catch (err) {
        if (err.code === 'LOCK_TIMEOUT') {
            return { success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again shortly.' };
        }
        console.error("❌ [Sync] Precedence check failed:", err);
        return { success: false, message: "Database error while submitting your survey." };
    }
    if (precedenceResult.decision === 'reject' || precedenceResult.decision === 'reject_pending') {
        // An Online submission already owns this logical survey — this
        // Offline copy is not, and never becomes, canonical. Accurate
        // status so pwa-client.js/offline-db.js resolve the queue item
        // instead of retrying it forever, and never show "submitted
        // successfully" for something that was actually rejected.
        return { success: true, status: 'superseded_by_online', alreadyOnline: true, message: 'Your online submission for this service was already received — this offline copy was not needed.' };
    }

    // Await the AI analysis BEFORE inserting — analyzeComment() never throws,
    // so a failed/unreachable analyze.py just yields the Neutral/General
    // Feedback fallback here instead of aborting this survey's sync.
    // offline=true routes this through analyze.py's pure-Gemini path (see
    // that script's module comment, 2026-09-25) — the same classification a
    // live comment gets, just via a fresh subprocess per synced item.
    let sentiment = null;
    let topics = null;
    try {
        const aiResult = await analyzeComment(comments, true, finalOfficeId);
        sentiment = aiResult.sentiment;
        topics = aiResult.topics;
    } catch (err) {
        console.error("❌ [Sync] AI analysis threw unexpectedly, defaulting:", err);
        sentiment = 'Neutral';
        topics = ['General Feedback'];
    }

    let surveyResponseId, supersededId;
    try {
        // The lock/precedence check above was necessarily a separate,
        // now-closed acquisition (the AI call above must never run while a
        // lock is held) — re-resolve inside submitCanonicalSurvey's own
        // lock, which is safe: this survey's identity/eligibility can only
        // have improved in its favor is impossible (Online never loses
        // ground), so a second precedence check here is authoritative and
        // simply repeats the same read if nothing changed.
        const result = await submitCanonicalSurvey(googleEmail, {
            officeId: finalOfficeId, respondentName: finalName, topics, sentiment, region: finalRegion,
            cc1: cleanStr(cc1), cc2: cleanStr(cc2), cc3: cleanStr(cc3), sqdValues,
            comments: cleanStr(comments), serviceAvailed: finalServiceAvailed,
            clientType: finalClientType, age: finalAge, gender: finalGender,
            officeVisitedTime: finalOfficeVisitedTime, period: currentPeriod,
            clientSubmissionId: finalClientSubmissionId, submittedAt
        }, SUBMISSION_SOURCE);
        surveyResponseId = result.surveyResponseId;
        supersededId = result.supersededId;
    } catch (err) {
        if (err.code === 'ELIGIBILITY_REJECTED' || err.code === 'PENDING_REJECTED') {
            return { success: true, status: 'superseded_by_online', alreadyOnline: true, message: 'Your online submission for this service was already received — this offline copy was not needed.' };
        }
        if (err.code === 'LOCK_TIMEOUT') {
            return { success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again shortly.' };
        }
        if (err.code === 'ER_DUP_ENTRY') {
            return { success: false, message: "You have already evaluated this office. You cannot submit again." };
        }
        console.error("❌ [Sync] Database insertion error:", err);
        return { success: false, message: "Database insertion error: " + err.message };
    }

    console.log(`✅ [Sync Success] ID: ${surveyResponseId} | Sentiment: ${sentiment || 'Neutral'} | Topics: ${(topics && topics.length ? topics : ['General Feedback']).join(', ')}`);
    if (supersededId) {
        console.log(`⚠️ [Sync Precedence] Offline sync ID ${surveyResponseId} unexpectedly superseded canonical row ${supersededId} — should never happen for an offline_sync-sourced insert.`);
    }

    return {
        success: true,
        status: 'synced',
        message: "Survey synced and analyzed successfully!",
        surveyResponseId,
        sentiment: sentiment || 'Neutral',
        topics: (topics && topics.length) ? topics : ['General Feedback']
    };
}

// ==========================================
// OFFLINE SURVEY — unauthenticated entry point, verified only at sync time
// ==========================================
// Trivial, unauthenticated liveness probe. Purely for the client-side
// "Server temporarily unavailable" indicator (login.ejs/index.ejs) —
// intentionally decoupled from navigator.onLine, which alone controls the
// "Take Survey Offline" button. Excluded from the service worker's /api/
// bypass rule like every other /api/ route (always live, never cached).
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// No ensureClientAuth — this is the whole point. A device with zero
// connectivity cannot authenticate against the database at all, so this
// page collects the survey plus only a plain "registered identifier" (an
// email — see the §5 note on POST /api/offline-surveys/verify-and-sync
// below for why not a username), never a password, and defers real account
// verification to that endpoint once the connection returns. Reuses
// client-survey.ejs (via offlineMode) rather than a parallel template —
// offices/services are public, non-sensitive lookup data, safe to serve to
// an unauthenticated visitor.
app.get('/survey-offline', noCache, (req, res) => {
    db.query('SELECT * FROM offices WHERE is_archived = 0 ORDER BY office_name ASC', (err, offices) => {
        if (err) {
            return res.render('client-survey', {
                offices: [], clientEmail: null, blockedCombos: {}, blockedUntil: {},
                serviceAvailability: {}, clientProfile: null, officeServices: {}, offlineMode: true, showOnboarding: false
            });
        }

        db.query('SELECT office_id, service_name, availability FROM services ORDER BY office_id, id', (errServices, serviceRows) => {
            const officeServices = {};
            const serviceAvailability = {};
            if (!errServices && serviceRows) {
                serviceRows.forEach(row => {
                    if (!officeServices[row.office_id]) officeServices[row.office_id] = [];
                    officeServices[row.office_id].push(row.service_name);
                    serviceAvailability[row.office_id + '::' + row.service_name] = row.availability;
                });
            }

            res.render('client-survey', {
                offices, clientEmail: null, blockedCombos: {}, blockedUntil: {},
                serviceAvailability, clientProfile: null, officeServices, offlineMode: true, showOnboarding: false
            });
        });
    });
});

// Fixed dummy hash, computed once at startup — bcrypt.compare()'d against
// whenever the submitted identifier doesn't resolve to a real account, so a
// "no such account" response takes the same time as a "wrong password"
// response. Without this, response timing alone could be used to enumerate
// which registered identifiers exist.
const DUMMY_BCRYPT_HASH_FOR_TIMING = bcrypt.hashSync('offline-verify-timing-guard', 10);

const OFFLINE_SUBMISSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses/validates the client's "when this was actually saved offline"
// timestamp — kept distinct from offline_survey_submissions.synced_at
// (server-generated, at write time) so the two can differ and both be
// shown ("completed offline at X, synced at Y"). Rejects nonsense (garbage
// strings, or a timestamp implausibly far in the future — more than a day
// past now, generous enough for real device clock drift) by falling back
// to null rather than failing the whole sync over a bad clock.
function parseCreatedOfflineAt(raw) {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
    return parsed;
}

// The time an offline-answered survey should be RECORDED under: when the
// respondent actually finished it, not when the queue happened to reach the
// server. Before this, both offline routes stamped the sync moment, so a
// survey answered at 9:05 with no signal read 2:40 PM everywhere — the office's
// Pending list, the admin's records, the client's receipt and the resubmission
// cooldown. The device clock is the only witness to the real time, so it is
// sanity-bounded: anything unparseable, in the future (a fast clock), or more
// than a year old (a clock reset to 2000) returns null and the survey is
// stamped at sync time like before, never at a nonsense date.
const OFFLINE_SUBMITTED_AT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
function resolveOfflineSubmittedAt(raw) {
    const parsed = parseCreatedOfflineAt(raw);
    if (!parsed) return null;
    const now = Date.now();
    if (parsed.getTime() > now) return null;
    if (parsed.getTime() < now - OFFLINE_SUBMITTED_AT_MAX_AGE_MS) return null;
    return parsed;
}

function formatSubmittedAtForEmail(date) {
    return (date || new Date()).toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE });
}

// Strict positive-integer parse — accepts only a real number/numeric string
// representing a positive integer, unlike parseInt() (which would let
// "5abc" silently become 5). Returns null for anything else, including
// non-string/non-number types (arrays/objects) and non-integers/negatives.
function parseStrictPositiveInt(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const normalized = typeof raw === 'number' ? raw : raw.trim();
    if (normalized === '') return null;
    const n = Number(normalized);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Strict integer-in-[0,5] check for one SQD answer — same reasoning as
// parseStrictPositiveInt above, just range-bounded (0 = N/A ... 5 = Strongly
// Agree, per the existing sqdRatingLabels scale). { ok: true, value: null }
// means "legitimately unanswered" — distinct from { ok: false }, "a value
// was supplied and it's invalid" (e.g. "5abc", "2.5", "Infinity", an
// array/object).
function parseStrictSqdValue(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false };
    const normalized = typeof raw === 'number' ? raw : raw.trim();
    if (normalized === '') return { ok: true, value: null };
    const n = Number(normalized);
    if (!Number.isInteger(n) || n < 0 || n > 5) return { ok: false };
    return { ok: true, value: n };
}

// Strict counterpart to allowlisted() (server.js's existing age/gender/
// region helper, which silently falls back to null for anything not in the
// set). This endpoint has no session to fall back on, so it must instead
// distinguish "field absent/blank" (a legitimate unanswered field — value:
// null) from "field supplied but not one of the exact allowed values" (a
// malformed/tampered submission — ok: false, rejected outright rather than
// silently coerced to null/"Not Specified"). Requires the value to actually
// BE a string before comparing — every real submission from the form sends
// these as strings, so anything else (an array/object, e.g. ["Male"]) is
// rejected immediately rather than being coerced by String(value) into
// matching the allowlist by accident.
function strictAllowlisted(value, allowedSet) {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false };
    const v = value.trim();
    if (v === '') return { ok: true, value: null };
    if (!allowedSet.has(v)) return { ok: false };
    return { ok: true, value: v };
}

// age/gender/region are "locked after first submission" — once
// client_accounts already has a value, THAT trusted, previously-validated
// DB value always wins over whatever this request submitted (mirrors
// /submit-survey and syncOneSurvey). Strict validation therefore only ever
// applies to the submitted value in the no-saved-value case, where it's the
// one actually being used.
function resolveLockedField(savedValue, submittedValue, allowedSet) {
    if (savedValue) return { ok: true, value: savedValue };
    return strictAllowlisted(submittedValue, allowedSet);
}

// ==========================================
// POST /api/offline-surveys/verify-and-sync
// The ONLY place a client-typed identifier is ever trusted enough to write
// to the official database — and only after its password is verified here,
// server-side, against the real bcrypt hash. One survey per call; the
// client (pwa-client.js) loops this sequentially over the surveys queued
// under one identifier, reusing that single in-memory password only within
// that loop, never across a different identifier's surveys.
//
// §5 note: client_accounts has no separate username column (confirmed
// against /auth-login's own handleClientLogin, which looks accounts up by
// email only) — so this, like /auth-login, only ever accepts a registered
// CSPC email or Gmail as the identifier, never a "username." The UI label
// says exactly that ("Registered CSPC Email / Gmail"), not "username."
// ==========================================
app.post('/api/offline-surveys/verify-and-sync', offlineVerifyLimiter, async (req, res) => {
    const submissionId = String(req.body.offlineSubmissionId || '').trim();
    const identifier = String(req.body.registeredIdentifier || '').trim().toLowerCase();
    const password = req.body.password;
    const payload = req.body.survey || {};

    // --- Strict input validation, BEFORE any database work — this is a
    // public, unauthenticated endpoint. ---
    if (!OFFLINE_SUBMISSION_UUID_RE.test(submissionId)) {
        return res.status(400).json({ success: false, message: 'Invalid submission ID.' });
    }
    if (!identifier || identifier.length > 255) {
        return res.status(400).json({ success: false, message: 'Invalid account identifier.' });
    }
    if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
        return res.status(400).json({ success: false, message: 'Invalid request.' });
    }

    // 1. Idempotency short-circuit — a retried/duplicated request for a UUID
    // that already finished is answered from the tracking row's CURRENT
    // state (which reflects any office approve/decline action since), no
    // password re-check, no re-insert.
    let existingRows;
    try {
        existingRows = await dbQuery(
            'SELECT approval_status, verification_status, registered_identifier, survey_response_id, pending_submission_id FROM offline_survey_submissions WHERE offline_submission_id = ? LIMIT 1',
            [submissionId]
        );
    } catch (err) {
        console.error('❌ [Offline Verify] Idempotency lookup failed:', err);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
    if (existingRows && existingRows.length > 0) {
        const existing = existingRows[0];
        const status = existing.approval_status;

        // Ensure the ORIGINAL sync notification exists before answering
        // from the idempotent short-circuit — covers the case where the
        // survey/pending row committed successfully on an earlier attempt
        // but the notification insert itself failed that time (logged and
        // swallowed, per createClientNotification's own contract, so
        // nothing here retried it automatically until now). dedupe_key's
        // UNIQUE constraint makes this exactly as safe on the 1st, 2nd, or
        // 100th replay: already exists -> INSERT IGNORE no-ops; the user
        // already soft-deleted it -> the row (with deleted_at set) still
        // physically exists and still matches the same dedupe_key, so it's
        // never resurrected either way. Never re-runs the survey
        // transaction, never re-sends the receipt/pending email — only
        // this one INSERT IGNORE happens here.
        if (existing.verification_status === 'verified') {
            createClientNotification({
                clientEmail: existing.registered_identifier,
                type: 'offline_synced',
                title: 'Survey Synchronized',
                message: 'Your offline survey response was successfully synchronized and submitted.',
                surveyResponseId: existing.survey_response_id,
                offlineSubmissionId: submissionId,
                dedupeKey: 'offline-synced:' + submissionId
            });
        } else {
            createClientNotification({
                clientEmail: existing.registered_identifier,
                type: 'offline_pending',
                title: 'Pending Office Approval',
                message: 'Your offline survey response was synchronized successfully and is awaiting office approval.',
                pendingSubmissionId: existing.pending_submission_id,
                offlineSubmissionId: submissionId,
                dedupeKey: 'offline-pending:' + submissionId
            });
        }

        if (status === 'rejected') {
            return res.json({ success: true, status: 'rejected', message: 'This submission was reviewed and was not included in the official results.' });
        }
        const isPending = status === 'pending';
        return res.json({
            success: true,
            status: isPending ? 'pending_approval' : 'synced',
            message: isPending ? 'Survey synchronized and is pending office approval.' : 'Survey successfully submitted.'
        });
    }

    // 2. Account-aware lockout (independent of the IP-based limiter above).
    if (isOfflineVerifyIdentifierLocked(identifier)) {
        return res.status(401).json({ success: false, status: 'verification_failed', message: OFFLINE_VERIFY_GENERIC_MESSAGE });
    }

    // 3. Look up the account.
    let accountRows;
    try {
        accountRows = await dbQuery('SELECT email, password FROM client_accounts WHERE email = ? LIMIT 1', [identifier]);
    } catch (err) {
        console.error('❌ [Offline Verify] Account lookup failed:', err);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
    const account = (accountRows && accountRows.length > 0) ? accountRows[0] : null;

    // 4. Verify the password. ALWAYS runs bcrypt.compare — even against the
    // fixed dummy hash for a nonexistent account — so a "no such account"
    // response and a "wrong password" response are indistinguishable both
    // in message AND in timing (prevents account-enumeration via either
    // channel).
    const hashToCompare = (account && account.password) ? account.password : DUMMY_BCRYPT_HASH_FOR_TIMING;
    let passwordMatches = false;
    try {
        passwordMatches = await bcrypt.compare(password, hashToCompare);
    } catch (err) {
        passwordMatches = false;
    }

    if (!account || !account.password || !passwordMatches) {
        recordOfflineVerifyFailure(identifier);
        // Only notify when the email actually resolves to a real account —
        // an unknown email must never get any account-specific side effect
        // (would be an account-enumeration signal). dedupeKey is keyed off
        // the submission's own UUID, so INSERT IGNORE naturally collapses
        // any retried/duplicate call for the same offline survey into a
        // single Bell entry.
        if (account) {
            createClientNotification({
                clientEmail: account.email,
                type: 'offline_verification_failed',
                title: "Offline Survey Not Synced",
                message: 'Your offline survey was not synced because the password entered was incorrect.',
                offlineSubmissionId: submissionId,
                dedupeKey: 'offline-verify-failed:' + submissionId
            });
        }
        return res.status(401).json({ success: false, status: 'verification_failed', message: OFFLINE_VERIFY_GENERIC_MESSAGE });
    }
    clearOfflineVerifyFailures(identifier);
    console.log('[Offline Verify] Account verification succeeded');

    // Use the DB's stored casing from here on, not whatever casing was typed.
    const verifiedEmail = account.email;
    const createdOfflineAt = parseCreatedOfflineAt(req.body.createdOfflineAt);
    // The bounded version of the same clock reading — what the survey itself
    // is recorded under (see resolveOfflineSubmittedAt).
    const submittedAt = resolveOfflineSubmittedAt(req.body.createdOfflineAt);

    // 5. Clean/validate the survey fields — strict, since this endpoint has
    // no session/auth to fall back on: a malformed or out-of-range value is
    // rejected outright, never silently defaulted (unlike the authenticated
    // /submit-survey path, which is trusted more because it requires a live
    // session first).
    const cleanStr = (val) => (val !== undefined && val !== null && String(val).trim() !== "") ? String(val).trim() : null;

    const { office_id, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, office_visited_time, service_availed } = payload;
    const finalOfficeId = parseStrictPositiveInt(office_id);
    if (!finalOfficeId) {
        return res.status(400).json({ success: false, message: 'Missing or invalid office ID.' });
    }

    // Office must exist and not be archived.
    let officeRow = null;
    try {
        const officeRows = await dbQuery('SELECT office_name FROM offices WHERE id = ? AND is_archived = 0 LIMIT 1', [finalOfficeId]);
        officeRow = (officeRows && officeRows[0]) ? officeRows[0] : null;
    } catch (err) {
        console.error('❌ [Offline Verify] Office lookup failed:', err);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
    if (!officeRow) {
        return res.status(400).json({ success: false, message: 'Selected office is invalid or no longer available.' });
    }
    const officeName = officeRow.office_name;

    const finalServiceAvailed = cleanStr(service_availed);
    // Service, when given, must actually belong to the selected office.
    if (finalServiceAvailed) {
        let serviceExists = false;
        try {
            const serviceRows = await dbQuery('SELECT 1 FROM services WHERE office_id = ? AND service_name = ? LIMIT 1', [finalOfficeId, finalServiceAvailed]);
            serviceExists = !!(serviceRows && serviceRows.length > 0);
        } catch (err) {
            console.error('❌ [Offline Verify] Service lookup failed:', err);
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }
        if (!serviceExists) {
            return res.status(400).json({ success: false, message: 'Selected service is invalid for that office.' });
        }
    }

    // SQD0-8 — see parseStrictSqdValue: rejects anything that isn't cleanly
    // an in-range integer (e.g. "5abc", "2.5", "Infinity", an array/object),
    // not just whatever parseInt() happens to salvage from the front of it.
    const rawSqd = [sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8];
    const sqdValues = [];
    for (const raw of rawSqd) {
        const parsedSqd = parseStrictSqdValue(raw);
        if (!parsedSqd.ok) {
            return res.status(400).json({ success: false, message: 'Invalid rating value submitted.' });
        }
        sqdValues.push(parsedSqd.value);
    }

    const rawComments = cleanStr(comments);
    if (rawComments && rawComments.length > OFFLINE_SURVEY_MAX_COMMENTS_LENGTH) {
        return res.status(400).json({ success: false, message: 'Comments are too long.' });
    }

    // CC1/CC2/CC3 — supplied-but-invalid is rejected outright (400), never
    // silently turned into "unanswered." Absent/blank is fine (unanswered).
    const cc1Check = strictAllowlisted(cc1, VALID_CC1);
    if (!cc1Check.ok) return res.status(400).json({ success: false, message: "Invalid Citizen's Charter (CC1) value submitted." });
    const cc2Check = strictAllowlisted(cc2, VALID_CC2);
    if (!cc2Check.ok) return res.status(400).json({ success: false, message: "Invalid Citizen's Charter (CC2) value submitted." });
    const cc3Check = strictAllowlisted(cc3, VALID_CC3);
    if (!cc3Check.ok) return res.status(400).json({ success: false, message: "Invalid Citizen's Charter (CC3) value submitted." });

    const respondent_name = payload.respondent_name || payload.respondentName || payload.client_name || payload.name;
    const client_type = payload.client_type || payload.clientType || payload.client_role;

    let savedProfile = null;
    try {
        const profileRows = await dbQuery('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [verifiedEmail]);
        savedProfile = (profileRows && profileRows.length > 0) ? profileRows[0] : null;
    } catch (err) {
        console.error('❌ [Offline Verify] Profile lookup error:', err);
    }

    // region/age/gender: the saved DB value (if any) always wins — see
    // resolveLockedField — so strict rejection only ever fires on a
    // genuinely user-supplied, invalid value for a field that has no saved
    // value to fall back on yet.
    const regionCheck = resolveLockedField(savedProfile && savedProfile.region, payload.region, VALID_REGIONS);
    if (!regionCheck.ok) return res.status(400).json({ success: false, message: 'Invalid region submitted.' });
    const ageCheck = resolveLockedField(savedProfile && savedProfile.age, payload.age || payload.clientAge || payload.client_age, VALID_AGE_BRACKETS);
    if (!ageCheck.ok) return res.status(400).json({ success: false, message: 'Invalid age bracket submitted.' });
    const genderCheck = resolveLockedField(savedProfile && savedProfile.gender, payload.gender || payload.clientGender || payload.client_gender, VALID_GENDERS);
    if (!genderCheck.ok) return res.status(400).json({ success: false, message: 'Invalid gender submitted.' });

    // client_type: validated against the actual client_types table (same
    // source the normal survey UI populates its dropdown from) instead of
    // accepted as arbitrary free text — a non-empty, unrecognized value is
    // rejected; an absent/blank one falls back to 'Citizen', same default
    // used everywhere else in this app (/submit-survey, syncOneSurvey).
    const rawClientType = cleanStr(client_type);
    let finalClientType = 'Citizen';
    if (rawClientType) {
        let clientTypeExists = false;
        try {
            const ctRows = await dbQuery('SELECT 1 FROM client_types WHERE type_name = ? LIMIT 1', [rawClientType]);
            clientTypeExists = !!(ctRows && ctRows.length > 0);
        } catch (err) {
            console.error('❌ [Offline Verify] Client type lookup failed:', err);
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }
        if (!clientTypeExists) {
            return res.status(400).json({ success: false, message: 'Invalid client type submitted.' });
        }
        finalClientType = rawClientType;
    }

    // VARCHAR(255) in every table this ends up in (survey_responses,
    // client_profiles, client_accounts) — capped the same width here.
    const finalName = (cleanStr(respondent_name) || 'Anonymous').slice(0, 255);
    const finalAge = ageCheck.value || 'Not Specified';
    const finalGender = genderCheck.value || 'Not Specified';
    const finalRegion = regionCheck.value || 'Not Specified';
    const finalCc1 = cc1Check.value;
    const finalCc2 = cc2Check.value;
    const finalCc3 = cc3Check.value;
    const finalOfficeVisitedTime = cleanTime(office_visited_time);

    // 6. Precedence pre-check — this survey was ANSWERED offline, so its
    // source is always 'offline_sync', never 'online' (see module rule
    // #13). Cheap, brief lock acquire/release (its own connection,
    // released immediately) purely to fail fast and skip AI below when
    // this is already a lost cause — the AUTHORITATIVE check happens again
    // inside the transaction's own lock further down, since Online can
    // still arrive in the gap between this check and the insert.
    const SUBMISSION_SOURCE = 'offline_sync';
    let precheck;
    try {
        precheck = await withLogicalSurveyLock(finalOfficeId, verifiedEmail, finalServiceAvailed, (lockConn) =>
            resolveSubmissionPrecedence(lockConn, finalOfficeId, verifiedEmail, finalServiceAvailed, SUBMISSION_SOURCE)
        );
    } catch (err) {
        if (err.code === 'LOCK_TIMEOUT') {
            return res.status(503).json({ success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again shortly.' });
        }
        console.error('❌ [Offline Verify] Precedence pre-check failed:', err);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
    if (precheck.decision === 'reject' || precheck.decision === 'reject_pending') {
        // Distinct from a wrong-password 401 (verification_failed) and from
        // the idempotency-duplicate 409 below (ER_DUP_ENTRY) — the account
        // and submitted data are both valid here; only the office/service is
        // currently on cooldown, OR (new) an Online submission already owns
        // this logical survey and always dominates a canonical/pending
        // Offline one, regardless of arrival order. pwa-client.js must
        // treat this status as `eligibility_conflict`: no password retry, no
        // automatic 12s re-attempt, record kept for the user to review. The
        // password already verified successfully above (reached only after
        // that), so the account IS notification-worthy even though no
        // survey_responses/pending_survey_submissions row was ever written.
        createClientNotification({
            clientEmail: verifiedEmail,
            type: 'eligibility_conflict',
            title: 'Offline Response Not Submitted',
            message: precheck.nextEligibleAt
                ? `Your offline response could not be submitted because the selected service is currently unavailable for another response. You may submit another response for this service after ${new Date(precheck.nextEligibleAt).toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE })}.`
                : (precheck.message || 'Your offline response could not be submitted because the selected service is currently unavailable for another response.'),
            offlineSubmissionId: submissionId,
            dedupeKey: 'offline-conflict:' + submissionId
        });
        return res.status(409).json({
            success: false, status: 'eligibility_conflict', message: precheck.message,
            nextEligibleAt: precheck.nextEligibleAt || null
        });
    }

    // Same rule as syncOneSurvey: the half-year the survey was answered in.
    const currentPeriod = getPeriodCovered(submittedAt || new Date());
    const isCspc = isCspcEmail(verifiedEmail);

    // 7. AI sentiment/topic analysis — a slow, non-database call — runs
    // BEFORE opening any DB connection/transaction/lock, never while one is
    // held open. Mirrors syncOneSurvey's offline=true pure-Gemini path.
    let sentiment = 'Neutral';
    let topics = ['General Feedback'];
    if (isCspc) {
        try {
            const aiResult = await analyzeComment(rawComments, true, finalOfficeId);
            sentiment = aiResult.sentiment || sentiment;
            topics = (aiResult.topics && aiResult.topics.length) ? aiResult.topics : topics;
        } catch (err) {
            console.error('❌ [Offline Verify] AI analysis threw unexpectedly, defaulting:', err);
        }
    }

    // 8. Re-acquire the logical-survey lock on the SAME dedicated connection
    // that will hold the transaction below (never the shared `db`/`dbQuery`
    // — the pool is capped at DB_CONNECTION_LIMIT and a bare `db.query('START
    // TRANSACTION')` could interleave with a different pooled connection).
    // Re-checking precedence here (not just trusting the step-6 pre-check)
    // is what makes this authoritative: an Online submission could have
    // committed in the gap while AI was running above.
    const conn = await db.promise().getConnection();
    let result;
    const lockName = logicalSurveyLockName(finalOfficeId, verifiedEmail, finalServiceAvailed);
    let lockHeld = false;
    try {
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // See withLogicalSurveyLock's identical comment: 1 = acquired, 0 =
        // timed out, NULL = a real DB-side error. Only 1 may proceed;
        // logged distinctly so a NULL isn't mistaken for ordinary
        // contention. Both 0 and NULL still resolve to the same safe,
        // retriable client response (503/retry_later) — never a silent
        // "proceed anyway" — since a plain 500 here would make the
        // offline-sync client treat this survey as a hard failure instead
        // of leaving it safely queued for retry (see runOfflineSurveySync
        // in offline-db.js).
        const rawLockResult = (lockRows && lockRows[0]) ? lockRows[0].acquired : undefined;
        lockHeld = rawLockResult === 1 || rawLockResult === '1';
        if (!lockHeld) {
            if (rawLockResult === null) {
                console.error(`❌ [Offline Verify] GET_LOCK('${lockName}') returned NULL (DB-side error, not ordinary contention).`);
            }
            conn.release();
            return res.status(503).json({ success: false, status: 'retry_later', message: 'The server is busy processing another submission for this survey. Please try again shortly.' });
        }

        const precedence = await resolveSubmissionPrecedence(conn, finalOfficeId, verifiedEmail, finalServiceAvailed, SUBMISSION_SOURCE);
        if (precedence.decision === 'reject' || precedence.decision === 'reject_pending') {
            await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
            conn.release();
            createClientNotification({
                clientEmail: verifiedEmail,
                type: 'eligibility_conflict',
                title: 'Offline Response Not Submitted',
                message: precedence.nextEligibleAt
                    ? `Your offline response could not be submitted because the selected service is currently unavailable for another response. You may submit another response for this service after ${new Date(precedence.nextEligibleAt).toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short', timeZone: DISPLAY_TIME_ZONE })}.`
                    : (precedence.message || 'Your offline response could not be submitted because the selected service is currently unavailable for another response.'),
                offlineSubmissionId: submissionId,
                dedupeKey: 'offline-conflict:' + submissionId
            });
            return res.status(409).json({
                success: false, status: 'eligibility_conflict', message: precedence.message,
                nextEligibleAt: precedence.nextEligibleAt || null
            });
        }

        await conn.beginTransaction();

        if (isCspc) {
            console.log('[Offline Verify] CSPC branch selected');
            const surveyResponseId = await insertVerifiedSurveyOnConnection(conn, verifiedEmail, {
                officeId: finalOfficeId, respondentName: finalName, topics, sentiment, region: finalRegion,
                cc1: finalCc1, cc2: finalCc2, cc3: finalCc3, sqdValues,
                comments: rawComments, serviceAvailed: finalServiceAvailed,
                clientType: finalClientType, age: finalAge, gender: finalGender,
                officeVisitedTime: finalOfficeVisitedTime, period: currentPeriod, submittedAt
            }, SUBMISSION_SOURCE);

            if (precedence.supersede) {
                await conn.query(
                    "UPDATE survey_responses SET canonical_status = 'superseded', superseded_by_id = ? WHERE id = ? AND canonical_status = 'canonical'",
                    [surveyResponseId, precedence.supersede]
                );
            }

            await conn.query(
                `INSERT INTO offline_survey_submissions
                 (offline_submission_id, registered_identifier, office_id, verification_status, approval_status, survey_response_id, created_offline_at)
                 VALUES (?, ?, ?, 'verified', 'not_required', ?, ?)`,
                [submissionId, verifiedEmail, finalOfficeId, surveyResponseId, createdOfflineAt]
            );

            await conn.commit();
            console.log('[Offline Verify] Transaction committed');
            result = { status: 'synced', surveyResponseId };
        } else {
            console.log('[Offline Verify] External branch selected');
            // External/Gmail — account ownership just proven by password,
            // but still routed for office review, exactly like the
            // authenticated /sync-surveys path already does for these
            // accounts.
            const pendingPayload = {
                officeId: finalOfficeId, respondentName: finalName, topics: [], region: finalRegion,
                cc1: finalCc1, cc2: finalCc2, cc3: finalCc3, sqdValues,
                comments: rawComments, serviceAvailed: finalServiceAvailed,
                clientType: finalClientType, age: finalAge, gender: finalGender,
                officeVisitedTime: finalOfficeVisitedTime, period: currentPeriod
            };

            const [pendingResult] = await conn.query(
                'INSERT INTO pending_survey_submissions (office_id, google_email, service_availed, payload, submission_source, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))',
                [finalOfficeId, verifiedEmail, finalServiceAvailed, JSON.stringify(pendingPayload), SUBMISSION_SOURCE, submittedAt]
            );

            await conn.query(
                `INSERT INTO offline_survey_submissions
                 (offline_submission_id, registered_identifier, office_id, verification_status, approval_status, pending_submission_id, created_offline_at)
                 VALUES (?, ?, ?, 'external_account', 'pending', ?, ?)`,
                [submissionId, verifiedEmail, finalOfficeId, pendingResult.insertId, createdOfflineAt]
            );

            await conn.commit();
            console.log('[Offline Verify] Transaction committed');
            result = { status: 'pending_approval', pendingSubmissionId: pendingResult.insertId };
        }

        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    } catch (err) {
        if (lockHeld) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
        try { await conn.rollback(); } catch (rollbackErr) { /* connection may already be unusable */ }
        conn.release();

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'You have already evaluated this office, or this survey was already synced.' });
        }
        console.error('❌ [Offline Verify] Transaction failed:', err);
        return res.status(500).json({ success: false, message: 'Database error while syncing your survey.' });
    }
    conn.release();

    // 9. Email — AFTER commit, outside the transaction, only ever sent to
    // an address that just proved ownership via a correct password (never
    // to an arbitrary typed-in address that failed verification).
    //
    // Also refresh the offline-context snapshot (§28 of the offline-profile
    // spec) — this endpoint never creates a login session, so the sync
    // response itself is the only safe way to hand the browser an updated,
    // non-secret (personal, credential-free) cooldown/profile snapshot (the service just answered is
    // now on cooldown; a first-time CSPC submission may have just created
    // this account's very first client_accounts row). Best-effort: a failure
    // here never fails the sync itself, which already committed above.
    let refreshedOfflineContext = null;
    try {
        refreshedOfflineContext = await buildClientOfflineContext(verifiedEmail);
    } catch (err) {
        console.error('❌ [Offline Verify] Failed to build refreshed offline context:', err);
    }

    if (result.status === 'synced') {
        sendOfflineSurveySyncedEmail(verifiedEmail, {
            officeName,
            serviceAvailed: finalServiceAvailed || 'Not specified',
            submittedAt: formatSubmittedAtForEmail(submittedAt),
            surveyResponseId: result.surveyResponseId
        });
        createClientNotification({
            clientEmail: verifiedEmail,
            type: 'offline_synced',
            title: 'Survey Synchronized',
            message: 'Your offline survey response was successfully synchronized and submitted.',
            surveyResponseId: result.surveyResponseId,
            offlineSubmissionId: submissionId,
            dedupeKey: 'offline-synced:' + submissionId
        });
        return res.json({
            success: true, status: 'synced', submissionId: String(result.surveyResponseId),
            message: 'Survey successfully synchronized.', offlineContext: refreshedOfflineContext
        });
    }

    sendOfflineSurveyPendingEmail(verifiedEmail, { officeName });
    createClientNotification({
        clientEmail: verifiedEmail,
        type: 'offline_pending',
        title: 'Pending Office Approval',
        message: 'Your offline survey response was synchronized successfully and is awaiting office approval.',
        pendingSubmissionId: result.pendingSubmissionId,
        offlineSubmissionId: submissionId,
        dedupeKey: 'offline-pending:' + submissionId
    });
    return res.json({
        success: true, status: 'pending_approval',
        message: 'Survey synchronized and is pending office approval.', offlineContext: refreshedOfflineContext
    });
});

// ==========================================
// 2. Admin Dashboard Routes
// ==========================================
// Shared by /dashboard and /report/dashboard so both render from the same
// live numbers instead of maintaining two copies of this query pyramid.
function loadDashboardData(req, callback) {
    // No periodCovered in the querystring at all -> default to the current
    // active period; an explicit "" (All Periods) is a deliberate user choice.
    const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
    const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();
    const hasPeriodFilter = !!selectedPeriod;

    const periodCol = periodNormExpr('s.period_year_quarter');
    // Always includes the canonical-only filter (Online-vs-Offline
    // precedence — see resolveSubmissionPrecedence) regardless of whether a
    // period filter is also active, so dashboard totals/analytics never
    // count a superseded row. Every query below appends dateWhere/
    // dateWhereAnd directly after `survey_responses s`/the JOIN condition,
    // so this is the single place that guarantees that exclusion for all
    // of them — see Part 40 of the online/offline consistency fix.
    const dateWhere = hasPeriodFilter ? ` WHERE ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` WHERE s.canonical_status = 'canonical' `;
    const dateWhereAnd = hasPeriodFilter ? ` AND ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` AND s.canonical_status = 'canonical' `;
    const dateParams = hasPeriodFilter ? [normalizePeriodStr(selectedPeriod)] : [];

    const logErr = (label) => (err) => { if (err) console.error(`[Dashboard] ${label} query failed:`, err.message); };

    db.query(`SELECT COUNT(*) AS total FROM survey_responses s${dateWhere}`, dateParams, (err, totalRes) => {
        logErr('total respondents')(err);
        const totalRespondents = (totalRes && totalRes[0]) ? totalRes[0].total : 0;

        const avgQuery = `
            SELECT ${sqdScoreExpr(ALL_SQD_COLS)} AS overall_avg
            FROM survey_responses s${dateWhere}
        `;
        db.query(avgQuery, dateParams, (err, avgRes) => {
            logErr('overall average')(err);
            let overallAvgScore = 0;
            if (avgRes && avgRes[0] && avgRes[0].overall_avg) {
                overallAvgScore = parseFloat(avgRes[0].overall_avg);
            }

            let interpretation = "POOR";
            if(overallAvgScore >= 95) interpretation = "OUTSTANDING";
            else if(overallAvgScore >= 90) interpretation = "VERY SATISFACTORY";
            else if(overallAvgScore >= 80) interpretation = "SATISFACTORY";
            else if(overallAvgScore >= 60) interpretation = "FAIR";

            db.query('SELECT COUNT(*) AS total_offices FROM offices WHERE is_archived = 0', (err, officeCountRes) => {
                logErr('office count')(err);
                const totalOffices = (officeCountRes && officeCountRes[0]) ? officeCountRes[0].total_offices : 0;

                const clusterAnalyticsQuery = `
                    SELECT
                        cluster_name,
                        COUNT(s.id) as cluster_volume,
                        ${sqdScoreExpr(ALL_SQD_COLS)} as cluster_rating
                    FROM offices o
                    LEFT JOIN survey_responses s ON o.id = s.office_id${dateWhereAnd}
                    WHERE o.is_archived = 0
                    GROUP BY cluster_name
                `;

                db.query(clusterAnalyticsQuery, dateParams, (err, clusterData) => {
                    logErr('cluster analytics')(err);
                    const chartData = { labels: [], respondents: [], ratings: [] };
                    const clusterCards = [];
                    const colors = ['#251d3a', '#2a2550', '#ffcc00', '#ffcc00'];

                    // cluster_name -> weighted overall rating, reused below to print a
                    // per-cluster TOTAL row on the PER CLUSTER report (same weighted-
                    // average math as the chart/cards, just keyed by full cluster name
                    // instead of the shortened chart label).
                    const clusterRatingMap = {};

                    if (clusterData) {
                        clusterData.forEach((row, idx) => {
                            let shortName = row.cluster_name;
                            if (shortName.length > 20) shortName = shortName.split(' ')[0] + ' Cluster';
                            let safeRating = parseFloat(row.cluster_rating || 0);

                            chartData.labels.push(shortName);
                            chartData.respondents.push(row.cluster_volume);
                            chartData.ratings.push(safeRating);

                            clusterCards.push({
                                name: shortName,
                                rating: safeRating.toFixed(2),
                                respondents: row.cluster_volume,
                                color: colors[idx % colors.length]
                            });

                            clusterRatingMap[row.cluster_name] = { rating: safeRating, respondents: row.cluster_volume || 0 };
                        });
                    }

                    const reportQuery = `
                        SELECT
                            o.cluster_name,
                            o.office_name,
                            ${OFFICE_REPORT_NAME_EXPR} AS report_name,
                            COUNT(s.id) as office_volume,
                            ${sqdScoreExpr(ALL_SQD_COLS)} as office_score
                        FROM offices o
                        LEFT JOIN survey_responses s ON o.id = s.office_id${dateWhereAnd}
                        WHERE o.is_archived = 0
                        GROUP BY o.id, o.cluster_name, o.office_name, o.full_name
                        ORDER BY o.cluster_name, o.office_name
                    `;

                    db.query(reportQuery, dateParams, (err, reportRows) => {
                        logErr('office report')(err);
                        const clustersMap = {};
                        const rankedOffices = [];
                        const interpretForDashboard = (score) => {
                            if (score >= 95) return "OUTSTANDING";
                            if (score >= 90) return "VERY SATISFACTORY";
                            if (score >= 80) return "SATISFACTORY";
                            if (score >= 60) return "FAIR";
                            return "POOR";
                        };

                        if (reportRows) {
                            reportRows.forEach(row => {
                                const cName = row.cluster_name || 'Unassigned Cluster';
                                if (!clustersMap[cName]) {
                                    clustersMap[cName] = { clusterName: cName, offices: [] };
                                }

                                let score = parseFloat(row.office_score || 0);
                                const cell = scoreCell(row.office_volume, row.office_score, interpretForDashboard);
                                // Every report prints the office's spelled-out name (report_name),
                                // never the short office_name staff use internally to pick it from
                                // a dropdown — same convention as OFFICE_REPORT_NAME_EXPR everywhere
                                // else a report names an office.
                                clustersMap[cName].offices.push({ name: row.report_name, score: cell.score, interpretation: cell.interpretation, respondents: row.office_volume || 0 });

                                if (row.office_volume > 0) {
                                    rankedOffices.push({ name: row.report_name, cluster: cName, score, respondents: row.office_volume });
                                }
                            });
                        }

                        // PER CLUSTER report order (Office of the President, Administrative
                        // and Finance, Research/Innovation/Collaboration, Academic) with each
                        // cluster's own TOTAL row attached — see CLUSTER_REPORT_ORDER.
                        const reportData = buildOrderedClusterReport(clustersMap, clusterRatingMap, interpretForDashboard);

                        // OVERALL CLUSTER report: every cluster with the offices inside it, as
                        // one continuous list, closed by a single TOTAL for the whole institution.
                        // Each office score is the weighted sqdScoreExpr figure already printed
                        // above it; the TOTAL is their plain average — the surveyed offices' overall
                        // scores added up, divided by how many were surveyed. Being a per-office
                        // average, it will differ from the respondent-weighted rating the dashboard
                        // shows: the two answer different questions.
                        // Only offices that were actually surveyed count toward it — an office
                        // with no respondents at all has no score to average, so including it
                        // would just be dividing by offices that never took part. An office WITH
                        // respondents stays in even when it scored 0.00%: that is a real result.
                        // Summed straight from the same rows the respondents-summary table prints
                        // (one row per non-archived office), not the separate whole-table COUNT(*)
                        // above — that query has no office join/is_archived filter, so a response
                        // left behind on an archived office would make the two disagree. Summing
                        // the printed rows keeps the report's own TOTAL always equal to what's above it.
                        const totalRespondentsAll = (reportRows || []).reduce((sum, row) => sum + (row.office_volume || 0), 0);

                        const scoredOffices = (reportRows || []).filter(row => (row.office_volume || 0) > 0);
                        const officeScores = scoredOffices.map(row => parseFloat(row.office_score || 0));
                        const officeScoreSum = officeScores.reduce((sum, score) => sum + score, 0);
                        const overallAllClusters = officeScores.length ? officeScoreSum / officeScores.length : 0;
                        const overallClusterTotal = {
                            officeCount: officeScores.length,
                            overallScore: officeScores.length ? overallAllClusters.toFixed(2) : NO_DATA,
                            interpretation: officeScores.length ? interpretForDashboard(overallAllClusters) : NO_DATA
                        };

                        rankedOffices.sort((a, b) => b.score - a.score);
                        const topOffices = rankedOffices.slice(0, 5);
                        const bottomOffices = rankedOffices.slice(-5).reverse().filter(o => !topOffices.includes(o));

                        const sentimentQuery = `SELECT ${REPORT_SENTIMENT_SQL} AS sentiment, COUNT(*) AS c FROM survey_responses s${dateWhere} GROUP BY ${REPORT_SENTIMENT_SQL}`;
                        db.query(sentimentQuery, dateParams, (err, sentimentRows) => {
                            logErr('sentiment breakdown')(err);
                            const sentimentBreakdown = { Positive: 0, Neutral: 0, Negative: 0 };
                            (sentimentRows || []).forEach(row => {
                                if (row.sentiment && sentimentBreakdown.hasOwnProperty(row.sentiment)) {
                                    sentimentBreakdown[row.sentiment] = row.c;
                                }
                            });
                            const sentimentTotal = sentimentBreakdown.Positive + sentimentBreakdown.Neutral + sentimentBreakdown.Negative;

                            // Multi-topic tagging project (2026-09-25): a
                            // comment can carry more than one topic (see
                            // survey_response_topics) — UNIONing the primary
                            // (from survey_responses.topic) with every extra
                            // topic is what makes this ranking count each
                            // topic mention, not just whichever one a
                            // comment happened to land on first. The second
                            // branch's JOIN naturally contributes nothing
                            // for a comment with no extras — its primary
                            // already came from the first branch.
                            const topicsQuery = `
                                SELECT topic, COUNT(*) AS c FROM (
                                    SELECT ${REPORT_TOPIC_SQL} AS topic
                                    FROM survey_responses s
                                    ${dateWhere ? `${dateWhere} AND` : 'WHERE'} (${HAS_AI_ANALYSIS_SQL} AND s.topic <> '')
                                    UNION ALL
                                    SELECT srt.topic AS topic
                                    FROM survey_responses s
                                    JOIN survey_response_topics srt ON srt.survey_response_id = s.id
                                    ${dateWhere ? `${dateWhere} AND` : 'WHERE'} (${HAS_AI_ANALYSIS_SQL} AND s.topic <> '')
                                ) all_topics
                                GROUP BY topic ORDER BY c DESC LIMIT 6
                            `;

                            db.query(topicsQuery, [...dateParams, ...dateParams], (err, topicRows) => {
                                logErr('top topics')(err);
                                const maxTopicCount = (topicRows && topicRows[0]) ? topicRows[0].c : 0;
                                const topTopics = (topicRows || []).map(r => ({
                                    topic: r.topic,
                                    count: r.c,
                                    pct: maxTopicCount ? Math.round((r.c / maxTopicCount) * 100) : 0
                                }));

                                const recentQuery = `
                                    SELECT s.id, o.office_name, o.cluster_name, ${REPORT_SENTIMENT_SQL} AS sentiment, ${REPORT_TOPIC_SQL} AS topic, s.created_at
                                    FROM survey_responses s
                                    JOIN offices o ON o.id = s.office_id
                                    ${dateWhere}
                                    ORDER BY s.created_at DESC
                                    LIMIT 60
                                `;
                                db.query(recentQuery, dateParams, (err, recentRows) => {
                                    logErr('recent submissions')(err);

                                    // Multi-topic tagging project (2026-09-25): dashboard.ejs's
                                    // live "Recent Submissions" table AND dashboard-report.ejs's
                                    // PDF-exportable version of the same table both read this one
                                    // array — attaching extra topics here fixes both at once,
                                    // same as /api/report-data's identical attachment.
                                    const ids = (recentRows || []).map(r => r.id);
                                    const buildRecentSubmissions = (extraTopicsMap) => (recentRows || []).map(r => ({
                                        officeName: r.office_name,
                                        cluster: r.cluster_name || 'Unassigned Cluster',
                                        // No AI result means none is shown — the old
                                        // '|| Neutral' / '|| General Feedback' here
                                        // invented one for every N/A comment.
                                        sentiment: r.sentiment || NO_FEEDBACK_LABEL,
                                        sentimentTone: sentimentTone(r.sentiment),
                                        topic: r.topic || NO_FEEDBACK_LABEL,
                                        extraTopics: r.topic ? (extraTopicsMap.get(r.id) || []) : [],
                                        date: r.created_at
                                    }));

                                    const withRecentSubmissions = (recentSubmissions) => {
                                        getMergedPeriodOptions((periodOptions) => {
                                            callback({
                                                dashboardData: { overallRating: overallAvgScore, overallLevel: interpretation, periodCoveredLabel: selectedPeriod || 'All Periods' },
                                                chartData: chartData, clusterCards: clusterCards, satisfactionRate: overallAvgScore,
                                                totalRespondents: totalRespondents, totalOffices: totalOffices, reportData: reportData,
                                                overallClusterTotal: overallClusterTotal, totalRespondentsAll: totalRespondentsAll,
                                                periodOptions: periodOptions, selectedPeriod: selectedPeriod || '',
                                                hasQueryParam: hasQueryParam,
                                                sentimentBreakdown: sentimentBreakdown, sentimentTotal: sentimentTotal,
                                                topTopics: topTopics, recentSubmissions: recentSubmissions,
                                                topOffices: topOffices, bottomOffices: bottomOffices,
                                                clusterOptions: CLUSTER_REPORT_ORDER
                                            });
                                        });
                                    };

                                    if (!ids.length) return withRecentSubmissions(buildRecentSubmissions(new Map()));
                                    db.query(
                                        `SELECT survey_response_id, topic FROM survey_response_topics WHERE survey_response_id IN (${ids.map(() => '?').join(',')}) ORDER BY survey_response_id, sort_order`,
                                        ids,
                                        (extraErr, extraRows) => {
                                            const extraTopicsMap = new Map();
                                            if (!extraErr && extraRows) {
                                                extraRows.forEach(r => {
                                                    if (!extraTopicsMap.has(r.survey_response_id)) extraTopicsMap.set(r.survey_response_id, []);
                                                    extraTopicsMap.get(r.survey_response_id).push(r.topic);
                                                });
                                            } else if (extraErr) {
                                                console.error('❌ [Dashboard] Error loading extra topics for recent submissions:', extraErr);
                                            }
                                            withRecentSubmissions(buildRecentSubmissions(extraTopicsMap));
                                        }
                                    );
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

app.get('/dashboard', ensureAdminAuth, noCache, (req, res) => {
    loadDashboardData(req, (locals) => res.render('dashboard', locals));
});

app.get('/report/dashboard', ensureAdminAuth, noCache, (req, res) => {
    loadDashboardData(req, (locals) => res.render('dashboard-report', locals));
});

app.get('/profile', ensureAdminAuth, noCache, (req, res) => res.render('profile'));
app.get('/password', ensureAdminAuth, noCache, (req, res) => res.render('password'));

// Lets the logged-in admin upload a custom profile photo (replaces the auto-generated
// ui-avatars.com initials avatar).
const profileUploadDir = path.join(__dirname, 'public', 'images', 'uploads', 'profiles');
fs.mkdirSync(profileUploadDir, { recursive: true });

const profileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, profileUploadDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `admin-${req.adminSession.user.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) {
            return cb(new Error('Only PNG, JPG, or WebP images are allowed.'));
        }
        cb(null, true);
    }
});

app.post('/api/profile/photo', ensureAdminAuth, (req, res) => {
    profileUpload.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'No image file received.' });

        const url = `/images/uploads/profiles/${req.file.filename}`;
        const adminId = req.adminSession.user.id;
        db.query('UPDATE admins SET photo_url = ? WHERE id = ?', [url, adminId], (err) => {
            if (err) {
                console.error('❌ Error saving profile photo URL:', err);
                return res.status(500).json({ success: false, message: 'Photo uploaded but could not be saved.' });
            }
            // Keep the session in sync so the new photo shows up immediately (navbar, etc.)
            // without needing to log out and back in.
            req.adminSession.user.photo_url = url;
            req.adminSession.admin.photo_url = url;
            res.json({ success: true, url });
        });
    });
});

// Lets the logged-in admin change their OWN password (distinct from /admins/edit,
// which is Super-Admin-only and edits OTHER admins' accounts).
app.post('/password', ensureAdminAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Please fill in all password fields.' });
    }
    if (String(newPassword).length < 8) {
        return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
    }

    const adminId = req.adminSession.user.id;
    db.query('SELECT * FROM admins WHERE id = ? LIMIT 1', [adminId], async (err, rows) => {
        if (err) {
            console.error('❌ Error loading admin for password change:', err);
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Admin account not found.' });
        }

        const admin = rows[0];
        const currentMatches = await verifyAdminPassword(admin, currentPassword);
        if (!currentMatches) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }

        try {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            db.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, adminId], (err) => {
                if (err) {
                    console.error('❌ Error updating admin password:', err);
                    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
                }
                res.json({ success: true, message: 'Password successfully updated!' });
            });
        } catch (e) {
            console.error('❌ Error hashing new admin password:', e);
            res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }
    });
});
// Cluster/office analytics print view. Was previously a static mock-up with fake
// numbers baked into the markup — now computes real figures from survey_responses
// using the same sqdScoreExpr formula as /dashboard and /report, so what prints
// here always matches actual submitted answers.
app.get('/print', ensureAdminAuth, noCache, (req, res) => {
    const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
    const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();
    const hasPeriodFilter = !!selectedPeriod;

    const periodCol = periodNormExpr('s.period_year_quarter');
    // Always excludes superseded rows — see the identical comment on
    // loadDashboardData's dateWhere/dateWhereAnd above.
    const dateWhere = hasPeriodFilter ? ` WHERE ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` WHERE s.canonical_status = 'canonical' `;
    const dateWhereAnd = hasPeriodFilter ? ` AND ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` AND s.canonical_status = 'canonical' `;
    const dateParams = hasPeriodFilter ? [normalizePeriodStr(selectedPeriod)] : [];

    // Matches the "INTERPRETATION OF RESULTS" legend printed on this same page
    // (95/90/80/60), not the dashboard's own thresholds — keeps the label on
    // every row consistent with the scale shown right below it.
    const interpretFor = (score) => {
        if (score >= 95) return 'Outstanding';
        if (score >= 90) return 'Very Satisfactory';
        if (score >= 80) return 'Satisfactory';
        if (score >= 60) return 'Fair';
        return 'Poor';
    };

    const logErr = (label) => (err) => { if (err) console.error(`[Print] ${label} query failed:`, err.message); };

    db.query(`SELECT COUNT(*) AS total FROM survey_responses s${dateWhere}`, dateParams, (err, totalRes) => {
        logErr('total respondents')(err);
        const totalRespondents = (totalRes && totalRes[0]) ? totalRes[0].total : 0;

        db.query(`SELECT ${sqdScoreExpr(ALL_SQD_COLS)} AS overall_avg FROM survey_responses s${dateWhere}`, dateParams, (err, avgRes) => {
            logErr('overall average')(err);
            const overallAvgScore = (avgRes && avgRes[0] && avgRes[0].overall_avg) ? parseFloat(avgRes[0].overall_avg) : 0;

            db.query('SELECT COUNT(*) AS total_offices FROM offices WHERE is_archived = 0', (err, officeCountRes) => {
                logErr('office count')(err);
                const totalOffices = (officeCountRes && officeCountRes[0]) ? officeCountRes[0].total_offices : 0;

                const clusterQuery = `
                    SELECT o.cluster_name, COUNT(s.id) as cluster_volume, ${sqdScoreExpr(ALL_SQD_COLS)} as cluster_rating
                    FROM offices o
                    LEFT JOIN survey_responses s ON o.id = s.office_id${dateWhereAnd}
                    WHERE o.is_archived = 0
                    GROUP BY o.cluster_name
                `;
                db.query(clusterQuery, dateParams, (err, clusterRows) => {
                    logErr('cluster analytics')(err);
                    const colors = ['#251d3a', '#2a2550', '#ffcc00', '#ffcc00'];
                    const chartData = { labels: [], respondents: [], ratings: [] };
                    const clusterCards = [];
                    const clusterRatingMap = {};
                    (clusterRows || []).forEach((row, idx) => {
                        const name = row.cluster_name || 'Other Offices';
                        const rating = parseFloat(row.cluster_rating || 0);
                        chartData.labels.push(name);
                        chartData.respondents.push(row.cluster_volume);
                        chartData.ratings.push(rating);
                        clusterCards.push({ name, rating: rating.toFixed(2), respondents: row.cluster_volume, color: colors[idx % colors.length] });
                        clusterRatingMap[row.cluster_name] = { rating, respondents: row.cluster_volume || 0 };
                    });

                    const officeQuery = `
                        SELECT o.cluster_name, o.office_name, ${OFFICE_REPORT_NAME_EXPR} AS report_name, COUNT(s.id) as office_volume, ${sqdScoreExpr(ALL_SQD_COLS)} as office_score
                        FROM offices o
                        LEFT JOIN survey_responses s ON o.id = s.office_id${dateWhereAnd}
                        WHERE o.is_archived = 0
                        GROUP BY o.id, o.cluster_name, o.office_name, o.full_name
                        ORDER BY o.cluster_name, o.office_name
                    `;
                    db.query(officeQuery, dateParams, (err, officeRows) => {
                        logErr('office report')(err);
                        const clustersMap = {};
                        (officeRows || []).forEach(row => {
                            const cName = row.cluster_name || 'Other Offices';
                            if (!clustersMap[cName]) {
                                clustersMap[cName] = { clusterName: cName, offices: [] };
                            }
                            const cell = scoreCell(row.office_volume, row.office_score, interpretFor);
                            // Full spelled-out name, same as every other report — see
                            // OFFICE_REPORT_NAME_EXPR.
                            clustersMap[cName].offices.push({ name: row.report_name, score: cell.score, interpretation: cell.interpretation, respondents: row.office_volume || 0 });
                        });

                        // PER CLUSTER report order with each cluster's own TOTAL row —
                        // see CLUSTER_REPORT_ORDER.
                        const reportData = buildOrderedClusterReport(clustersMap, clusterRatingMap, interpretFor);

                        res.render('print', {
                            overallRating: overallAvgScore.toFixed(2),
                            overallInterpretation: interpretFor(overallAvgScore),
                            totalRespondents,
                            totalOffices,
                            periodLabel: selectedPeriod || 'All Periods',
                            chartData,
                            clusterCards,
                            reportData
                        });
                    });
                });
            });
        });
    });
});

// ==========================================
// DYNAMIC REPORTS ROUTE (Modified)
// ==========================================
app.get('/report', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT office_name FROM offices ORDER BY office_name ASC', (err, offices) => {
        getMergedPeriodOptions((periodOptions) => {
            res.render('report', { offices: offices || [], periodOptions: periodOptions });
        });
    });
});

// Powers both the institution-wide /report page (sends `office` by name) and the
// per-cluster "Select Office" drill-down (sends `cluster` + `officeId`, so "All
// Offices" on a cluster page still scopes to that cluster instead of the whole
// institution). `periodCovered` narrows further to one fixed date range.
// `respondentId` (from the "Generate Report" action on one Survey Records row)
// scopes everything to that single client instead, so admins can verify the
// SQD computation against one respondent's own answers.
app.post('/api/report-data', ensureAdminAuth, (req, res) => {
    const { office, officeId, cluster, periodCovered, respondentId, serviceAvailed } = req.body;

    const conditions = [];
    const queryParams = [];

    if (respondentId) {
        // Exact single-row lookup by primary key (e.g. "Generate Report" on
        // one Survey Records row) — deliberately NOT filtered by
        // canonical_status, so an admin can still pull up a superseded
        // row's own report for audit/verification purposes.
        conditions.push('s.id = ?');
        queryParams.push(respondentId);
    } else {
        // Aggregate report (institution/cluster/office totals) — a
        // superseded row (an Offline submission an Online one later
        // dominated for the same office/account/service) must never
        // inflate these figures.
        conditions.push("s.canonical_status = 'canonical'");
        if (cluster) {
            conditions.push('o.cluster_name = ?');
            queryParams.push(cluster);
        }
        if (officeId) {
            conditions.push('o.id = ?');
            queryParams.push(officeId);
        } else if (office && office !== 'ALL OFFICES') {
            conditions.push('o.office_name = ?');
            queryParams.push(office);
        }
        if (periodCovered) {
            // Normalized comparison, not exact `=` — see periodNormExpr's
            // docstring. Using exact match here (while /dashboard and
            // /report use the normalized form) made this endpoint's totals
            // silently diverge from the dashboard's for the same period
            // whenever a row's period string used a legacy/variant spelling.
            conditions.push(`${periodNormExpr('s.period_year_quarter')} = ?`);
            queryParams.push(normalizePeriodStr(periodCovered));
        }
        // One service of the selected office — only respondents who availed of
        // that exact service are counted. Omitted (or 'ALL SERVICES') keeps the
        // office-wide totals across every service it offers.
        if (serviceAvailed && serviceAvailed !== 'ALL SERVICES') {
            conditions.push('s.service_availed = ?');
            queryParams.push(serviceAvailed);
        }
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    // Rating-bucket counts (Strongly Agree..N/A) for SQD 0 and SQD 1-8 — power the
    // CQA-style "SQD Results" report table alongside the plain % columns already
    // used by the numeric-summary table.
    const bucketCols = [
        ...sqdBucketExprs('s.sqd0', 'sqd0'),
        ...SQD_DIMENSIONS.flatMap(d => sqdBucketExprs(`s.${d.col}`, d.col))
    ].join(',\n            ');

    const query = `
        SELECT
            COUNT(s.id) as total_respondents,
            MAX(s.respondent_name) as respondent_name,
            MAX(o.office_name) as office_name,
            MAX(${OFFICE_REPORT_NAME_EXPR}) as office_report_name,
            MAX(s.service_availed) as service_availed,
            MAX(s.period_year_quarter) as period_year_quarter,
            MAX(s.created_at) as response_at,
            ${sqdScoreExpr(['s.sqd1'])} as sqd1,
            ${sqdScoreExpr(['s.sqd2'])} as sqd2,
            ${sqdScoreExpr(['s.sqd3'])} as sqd3,
            ${sqdScoreExpr(['s.sqd4'])} as sqd4,
            ${sqdScoreExpr(['s.sqd5'])} as sqd5,
            ${sqdScoreExpr(['s.sqd6'])} as sqd6,
            ${sqdScoreExpr(['s.sqd7'])} as sqd7,
            ${sqdScoreExpr(['s.sqd8'])} as sqd8,
            ${sqdScoreExpr(ALL_SQD_COLS)} as overall_score,
            ${bucketCols}
        FROM survey_responses s
        LEFT JOIN offices o ON s.office_id = o.id${whereClause}
    `;

    db.query(query, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        const commentsWhere = conditions.length
            ? ` AND ${conditions.join(' AND ')}`
            : '';
        // HAS_REAL_COMMENT_SQL, not just a non-empty check: an "N/A"-style comment
        // is non-empty text, so a plain TRIM() <> '' test used to let it through and
        // the report listed it as a comment nobody wrote. The report is the written
        // comments, so those rows never leave the database now.
        //
        // s.id is selected so extra topics (multi-topic tagging project,
        // 2026-09-25 — see survey_response_topics) can be attached below; it
        // is stripped back out of each comment object before the response is
        // sent, since no view has ever needed a raw row id here before.
        const commentsQuery = `SELECT s.id, s.comments, ${REPORT_SENTIMENT_SQL} AS sentiment, ${REPORT_TOPIC_SQL} AS topic FROM survey_responses s LEFT JOIN offices o ON s.office_id = o.id WHERE ${HAS_REAL_COMMENT_SQL}${commentsWhere}`;

        db.query(commentsQuery, queryParams, (err, commentsResult) => {
            // Last gate before a comment becomes a line on a signed document.
            // HAS_REAL_COMMENT_SQL above has already dropped the blanks and
            // the "N/A"s it can see in SQL, and the topic filter has dropped
            // whatever the AI classifier flagged as junk — but both of those
            // depend on the classifier having run and having been reachable at
            // the time. prepareReportComment does not: it re-checks every rule
            // against the text itself, here, and masks any profanity in what
            // survives. See shared/commentFilter.js for why each rule is
            // written to keep a borderline comment rather than drop it.
            const kept = [];
            for (const row of (commentsResult || [])) {
                const verdict = prepareReportComment(row.comments);
                if (!verdict.include) continue;
                kept.push(Object.assign({}, row, {
                    comments: verdict.text,
                    // Lets a view mark a masked row if it ever wants to; the
                    // printed templates deliberately do not, since an asterisk
                    // run already reads as "removed" on paper.
                    wasMasked: verdict.wasMasked
                }));
            }

            // The report's "Submitted <date>" — the latest response's date,
            // printed in the display zone rather than the DB session's.
            const stats = results[0] || {};
            stats.response_date = formatZonedDateLong(stats.response_at);
            delete stats.response_at;

            // Multi-topic tagging project (2026-09-25): every report/print
            // page that lists comments (report.ejs, cluster-detail.ejs,
            // survey-records.ejs's per-respondent report) shows only
            // `c.topic` (the primary) unless `c.extraTopics` is attached
            // here too — without this, a comment Gemini tagged with two
            // topics silently printed as if it only had one, everywhere a
            // report is generated.
            const ids = kept.map(c => c.id);
            const attachExtraTopics = (extraTopicsMap) => {
                const comments = kept.map(row => {
                    const { id, ...comment } = row;
                    comment.extraTopics = extraTopicsMap.get(id) || [];
                    return comment;
                });
                res.json({
                    stats,
                    comments
                });
            };

            if (!ids.length) return attachExtraTopics(new Map());
            db.query(
                `SELECT survey_response_id, topic FROM survey_response_topics WHERE survey_response_id IN (${ids.map(() => '?').join(',')}) ORDER BY survey_response_id, sort_order`,
                ids,
                (extraErr, extraRows) => {
                    const extraTopicsMap = new Map();
                    if (!extraErr && extraRows) {
                        extraRows.forEach(r => {
                            if (!extraTopicsMap.has(r.survey_response_id)) extraTopicsMap.set(r.survey_response_id, []);
                            extraTopicsMap.get(r.survey_response_id).push(r.topic);
                        });
                    } else if (extraErr) {
                        console.error('❌ [Report Data] Error loading extra topics:', extraErr);
                    }
                    attachExtraTopics(extraTopicsMap);
                }
            );
        });
    });
});

// Per-office SQD rating breakdown for every (non-archived) office in a cluster —
// powers the "Number of Respondents" report's ALL OFFICES view, which prints the
// full CQA SQD 0 / SQD 1-8 template once per office rather than one combined
// cluster-wide total. Same bucket math as /api/report-data, just grouped by
// office instead of collapsed into a single row.
app.post('/api/report-data-by-cluster', ensureAdminAuth, (req, res) => {
    const { cluster, periodCovered } = req.body;
    if (!cluster) return res.status(400).json({ error: 'cluster is required' });

    // Normalized comparison, not exact `=` — see periodNormExpr's docstring.
    // Kept consistent with /dashboard, /report, and /api/report-data so the
    // same period selection never yields different respondent counts
    // depending on which report page is open.
    const periodWhereAnd = periodCovered ? ` AND ${periodNormExpr('s.period_year_quarter')} = ?` : '';
    const params = periodCovered ? [normalizePeriodStr(periodCovered), cluster] : [cluster];

    const bucketCols = [
        ...sqdBucketExprs('s.sqd0', 'sqd0'),
        ...SQD_DIMENSIONS.flatMap(d => sqdBucketExprs(`s.${d.col}`, d.col))
    ].join(',\n            ');

    const query = `
        SELECT o.id, o.office_name, COUNT(s.id) as total_respondents,
            ${bucketCols}
        FROM offices o
        LEFT JOIN survey_responses s ON o.id = s.office_id${periodWhereAnd}
        WHERE o.cluster_name = ? AND o.is_archived = 0
        GROUP BY o.id, o.office_name
        ORDER BY o.office_name
    `;

    db.query(query, params, (err, rows) => {
        if (err) {
            console.error('❌ [report-data-by-cluster] query failed:', err.message);
            return res.status(500).json({ error: err.message });
        }

        const toBuckets = (row, prefix) => ({
            sa: parseInt(row[`${prefix}_sa`]) || 0,
            a: parseInt(row[`${prefix}_a`]) || 0,
            n: parseInt(row[`${prefix}_n`]) || 0,
            d: parseInt(row[`${prefix}_d`]) || 0,
            sd: parseInt(row[`${prefix}_sd`]) || 0,
            na: parseInt(row[`${prefix}_na`]) || 0
        });

        const offices = (rows || []).map(row => {
            const sqd0Row = buildSqdBucketRow('SQD 0', toBuckets(row, 'sqd0'));
            const sqdRows = SQD_DIMENSIONS.map(d => buildSqdBucketRow(d.label, toBuckets(row, d.col)));
            const overallTotals = sqdRows.reduce((acc, r) => {
                acc.sa += r.sa; acc.a += r.a; acc.n += r.n; acc.d += r.d; acc.sd += r.sd; acc.na += r.na;
                return acc;
            }, { sa: 0, a: 0, n: 0, d: 0, sd: 0, na: 0 });
            const overallRow = buildSqdBucketRow('OVERALL', overallTotals);

            return {
                officeId: row.id,
                officeName: row.office_name,
                totalRespondents: row.total_respondents || 0,
                sqd0Row, sqdRows, overallRow
            };
        });

        res.json({ offices });
    });
});

// Topic Badge Color Formula (topicBadgeClassFor) — now in
// views/layout/report_computation/report_formula.js.

// ==========================================
// DYNAMIC SURVEY RECORDS ROUTE
// ==========================================
app.get('/survey-records', ensureAdminAuth, noCache, (req, res) => {
    const ratingQuery = `
        SELECT o.cluster_name,
               ${sqdScoreExpr(ALL_SQD_COLS)} as rating
        FROM offices o
        LEFT JOIN survey_responses s ON o.id = s.office_id AND s.canonical_status = 'canonical'
        GROUP BY o.cluster_name
    `;
    db.query(ratingQuery, (err, ratingResults) => {
        const clusterRatings = {};
        if (ratingResults) {
            ratingResults.forEach(r => { clusterRatings[r.cluster_name || 'Other Offices'] = parseFloat(r.rating).toFixed(2); });
        }
        
        // analysis_status = 'completed': a row whose AI analysis is still
        // running (see HAS_AI_ANALYSIS_SQL's comment) is excluded from this
        // table entirely, not just its topic/sentiment badge — it appears
        // once Gemini finishes, usually within a few seconds.
        const recordsQuery = `
            SELECT s.id, s.respondent_name, s.topic, s.sentiment,
                   s.topic_override, s.subtopic_override, s.sentiment_override,
                   s.comments, s.created_at, DATE_FORMAT(s.created_at, '%M %d, %Y') as formatted_date, o.cluster_name, o.office_name,
                   DATE_FORMAT(p.office_visited_time, '%M %d, %Y %h:%i %p') as office_visited_time_formatted
            FROM survey_responses s
            JOIN offices o ON s.office_id = o.id
            LEFT JOIN client_profiles p ON p.survey_response_id = s.id
            WHERE s.canonical_status = 'canonical' AND s.analysis_status = 'completed'
            ORDER BY o.cluster_name, s.created_at DESC
        `;
        db.query(recordsQuery, (err, results) => {
            // Multi-topic tagging project (2026-09-25): extra topics beyond
            // the primary (survey_responses.topic) live in a child table —
            // fetched once here as a survey_response_id -> [topic, ...] map
            // instead of one query per row.
            const responseIds = (results || []).map(r => r.id);
            const extraTopicsQuery = responseIds.length
                ? `SELECT survey_response_id, topic FROM survey_response_topics WHERE survey_response_id IN (${responseIds.map(() => '?').join(',')}) ORDER BY survey_response_id, sort_order`
                : null;
            const withExtraTopics = (extraTopicsMap) => {
            const recordsByCluster = {};
            if (results) {
                results.forEach(row => {
                    const cluster = row.cluster_name || 'Other Offices';
                    if (!recordsByCluster[cluster]) recordsByCluster[cluster] = [];

                    // A NULL topic/sentiment means this comment was blank or
                    // an explicit "N/A"/"none"/... placeholder (see
                    // isNoFeedbackComment) — there is genuinely nothing to
                    // classify, so this must display as "No feedback", never
                    // the fabricated "General Feedback"/"Neutral" that a
                    // bare `|| 'General Feedback'` fallback would show here.
                    const hasFeedback = row.topic !== null && row.topic !== undefined;

                    // Effective = admin override when present, else the AI's
                    // own value — an admin correction is reflected here
                    // without ever touching the raw AI topic/sentiment
                    // columns (see /api/admin/survey-response/:id/analysis).
                    const effectiveTopic = hasFeedback ? (row.topic_override || row.topic) : null;
                    const effectiveSentimentRaw = row.sentiment_override || (hasFeedback ? (row.sentiment || 'Neutral') : null);
                    const badgeClass = hasFeedback ? topicBadgeClassFor(effectiveTopic) : 'bg-no-feedback';

                    // Profanity is masked HERE too, not only on the signed
                    // report. /survey-records is read on a shared office
                    // screen, and the words are starred through their vowels
                    // (see maskProfanity in shared/commentFilter.js) so the
                    // row still reads as the complaint it is. Only what is
                    // sent to the browser is masked — the stored comment is
                    // never rewritten, so the AI classifier, the exports and
                    // any later re-read all still see the original text.
                    const displayComments = row.comments ? maskProfanity(row.comments).text : '';

                    const sentimentValue = hasFeedback ? effectiveSentimentRaw : 'No feedback';
                    const sentimentLower = sentimentValue.toLowerCase();
                    let sentimentClass = 'bg-sentiment-neutral';
                    if (!hasFeedback) sentimentClass = 'bg-sentiment-none';
                    else if (sentimentLower.includes('positive')) sentimentClass = 'bg-sentiment-positive';
                    else if (sentimentLower.includes('negative')) sentimentClass = 'bg-sentiment-negative';

                    // Multi-topic tagging project (2026-09-25): any topics
                    // beyond the primary, each rendered as its own small
                    // badge in the same cell — see extraTopicsMap above.
                    const extraTopics = hasFeedback
                        ? (extraTopicsMap.get(row.id) || []).map(t => ({ topic: t, topicClass: topicBadgeClassFor(t) }))
                        : [];

                    recordsByCluster[cluster].push({ id: row.id, name: row.respondent_name || 'Anonymous', officeName: row.office_name || 'N/A', topic: hasFeedback ? effectiveTopic : 'No feedback', topicClass: badgeClass, extraTopics, sentiment: sentimentValue, sentimentClass, comments: displayComments || 'No comments provided.', date: formatZonedDateLong(row.created_at) || row.formatted_date, dateRaw: row.created_at ? new Date(row.created_at).toISOString() : '', officeVisitedTime: row.office_visited_time_formatted || 'N/A' });
                });
            }
            res.render('survey-records', { recordsByCluster, clusterRatings, TOPIC_TAXONOMY, SENTIMENT_VALUES });
            };

            if (!extraTopicsQuery) return withExtraTopics(new Map());
            db.query(extraTopicsQuery, responseIds, (extraErr, extraRows) => {
                const extraTopicsMap = new Map();
                if (!extraErr && extraRows) {
                    extraRows.forEach(r => {
                        if (!extraTopicsMap.has(r.survey_response_id)) extraTopicsMap.set(r.survey_response_id, []);
                        extraTopicsMap.get(r.survey_response_id).push(r.topic);
                    });
                } else if (extraErr) {
                    console.error('❌ [Survey Records] Error loading extra topics:', extraErr);
                }
                withExtraTopics(extraTopicsMap);
            });
        });
    });
});

// Full answers for one survey response — powers the "View Result" button on
// /survey-records. Unlike /api/client-history/:id (client-facing, scoped to
// the logged-in client's own email), any logged-in admin can view any
// respondent's answers here.
app.get('/api/admin/survey-response/:id', ensureAdminAuth, noCache, (req, res) => {
    const query = `
        SELECT s.id, s.respondent_name, s.topic, s.sentiment,
               s.topic_override, s.subtopic_override, s.sentiment_override,
               s.region, s.cc1, s.cc2, s.cc3,
               s.sqd0, s.sqd1, s.sqd2, s.sqd3, s.sqd4, s.sqd5, s.sqd6, s.sqd7, s.sqd8,
               s.comments, s.period_year_quarter, s.google_email, s.created_at,
               DATE_FORMAT(s.created_at, '%M %d, %Y %h:%i %p') AS formatted_date,
               o.office_name, o.cluster_name,
               p.client_type, p.age, p.gender,
               DATE_FORMAT(p.office_visited_time, '%M %d, %Y %h:%i %p') AS office_visited_time_formatted
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        LEFT JOIN client_profiles p ON p.survey_response_id = s.id
        WHERE s.id = ? AND s.analysis_status = 'completed'
        LIMIT 1
    `;
    db.query(query, [req.params.id], (err, rows) => {
        if (err) {
            console.error('❌ Error loading survey response for admin view:', err);
            return res.status(500).json({ success: false, message: 'Server error loading this survey.' });
        }
        if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'Survey not found.' });
        const survey = rows[0];
        survey.formatted_date = formatZonedDateTimeLong(survey.created_at) || survey.formatted_date;
        // The Survey Result modal is the same record surface as the
        // /survey-records table behind it, so it gets the same masking —
        // otherwise clicking "View Result" on a masked row would print the
        // unmasked original right back on screen.
        if (survey.comments) survey.comments = maskProfanity(survey.comments).text;
        const hasFeedback = survey.topic !== null && survey.topic !== undefined;
        const aiSplit = hasFeedback ? splitTopic(survey.topic) : { topic: null, subtopic: null };
        survey.effectiveSentiment = survey.sentiment_override || (hasFeedback ? (survey.sentiment || 'Neutral') : null);
        survey.effectiveTopic = survey.topic_override || aiSplit.topic;
        survey.effectiveSubtopic = survey.subtopic_override || aiSplit.subtopic;

        // Multi-topic tagging project (2026-09-25): any topics beyond the
        // primary, each split into {topic, subtopic} the same way as above —
        // there is no separate override column for these (see
        // survey_response_topics' table comment), an admin edit replaces
        // these rows outright via the PATCH endpoint below.
        if (!hasFeedback) {
            survey.extraTopics = [];
            return res.json({ success: true, survey });
        }
        db.query(
            'SELECT topic FROM survey_response_topics WHERE survey_response_id = ? ORDER BY sort_order',
            [survey.id],
            (extraErr, extraRows) => {
                if (extraErr) console.error('❌ Error loading extra topics for admin view:', extraErr);
                survey.extraTopics = (extraRows || []).map(r => splitTopic(r.topic));
                res.json({ success: true, survey });
            }
        );
    });
});

// Admin correction of the AI's sentiment/topic/subtopic read on one survey
// response's comment (Survey Result modal "Edit Analysis"). The comment text
// itself is never editable here or anywhere else in this route. Topic/
// subtopic are intentionally NOT restricted to TOPIC_TAXONOMY's known pairs —
// the modal's "Custom" option lets an admin type any topic/subtopic text, so
// validation only guards against empty/oversized input rather than a fixed
// allowlist. The PRIMARY topic/subtopic are stored in separate *_override
// columns (see the add_survey_analysis_overrides migration) so the AI's
// original `topic`/`sentiment` columns are never overwritten by a
// correction.
//
// Multi-topic tagging project (2026-09-25): any topics beyond the primary
// (`extraTopics` in the request body) replace whatever was in
// survey_response_topics outright — that table has no override column of
// its own (unlike the primary), so there is no "AI original vs. admin
// corrected" distinction to preserve for these; an admin can freely add,
// remove, or edit them and the previous set is simply gone.
const MAX_EXTRA_TOPICS = 4;

app.patch('/api/admin/survey-response/:id/analysis', ensureAdminAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid survey response id.' });
    }

    if (!SENTIMENT_VALUES.includes(req.body?.sentiment)) {
        return res.status(400).json({ success: false, message: 'Invalid sentiment value.' });
    }
    const sentiment = req.body.sentiment;
    const topic = typeof req.body.topic === 'string' ? req.body.topic.trim() : '';
    const subtopic = typeof req.body.subtopic === 'string' ? req.body.subtopic.trim() : '';
    if (!topic || topic.length > 150) {
        return res.status(400).json({ success: false, message: 'Please enter a topic between 1 and 150 characters.' });
    }
    if (!subtopic || subtopic.length > 100) {
        return res.status(400).json({ success: false, message: 'Please enter a subtopic between 1 and 100 characters.' });
    }

    const rawExtras = Array.isArray(req.body.extraTopics) ? req.body.extraTopics : [];
    if (rawExtras.length > MAX_EXTRA_TOPICS) {
        return res.status(400).json({ success: false, message: `You can add at most ${MAX_EXTRA_TOPICS} additional topics.` });
    }
    const extraTopicStrings = [];
    for (const entry of rawExtras) {
        const t = typeof entry?.topic === 'string' ? entry.topic.trim() : '';
        const st = typeof entry?.subtopic === 'string' ? entry.subtopic.trim() : '';
        if (!t || t.length > 100 || !st || st.length > 100) {
            return res.status(400).json({ success: false, message: 'Each additional topic and subtopic must be 1-100 characters.' });
        }
        const combined = combineTopic(t, st);
        if (!combined || combined.length > 150) {
            return res.status(400).json({ success: false, message: 'One of the additional topic/subtopic combinations is too long.' });
        }
        extraTopicStrings.push(combined);
    }

    let conn;
    try {
        conn = await db.promise().getConnection();
        await conn.beginTransaction();

        const [result] = await conn.query(
            'UPDATE survey_responses SET topic_override = ?, subtopic_override = ?, sentiment_override = ? WHERE id = ?',
            [topic, subtopic, sentiment, id]
        );
        // affectedRows is 0 both when the id doesn't exist AND when the row
        // exists but already holds these exact override values (MySQL only
        // counts a row as "affected" if the UPDATE actually changes a
        // value) — an existence check disambiguates the two instead of
        // assuming the former.
        if (!result || result.affectedRows === 0) {
            const [existing] = await conn.query('SELECT id FROM survey_responses WHERE id = ? LIMIT 1', [id]);
            if (!existing || existing.length === 0) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({ success: false, message: 'Survey response not found.' });
            }
        }

        await conn.query('DELETE FROM survey_response_topics WHERE survey_response_id = ?', [id]);
        if (extraTopicStrings.length) {
            const values = [];
            const placeholders = extraTopicStrings.map((t, i) => { values.push(id, t, i); return '(?, ?, ?)'; }).join(', ');
            await conn.query(
                `INSERT INTO survey_response_topics (survey_response_id, topic, sort_order) VALUES ${placeholders}`,
                values
            );
        }

        await conn.commit();
        conn.release();
        res.json({
            success: true, effectiveSentiment: sentiment, effectiveTopic: topic, effectiveSubtopic: subtopic,
            extraTopics: extraTopicStrings.map(splitTopic)
        });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); } catch (rollbackErr) { /* connection may already be unusable */ }
            conn.release();
        }
        console.error('❌ [Survey Records] Failed to save admin analysis override:', err);
        res.status(500).json({ success: false, message: 'Server error saving analysis.' });
    }
});

// ==========================================
// REGISTERED USER ACCOUNTS
// ==========================================
// The directory of accounts that actually EXIST on the client side: one row per
// row of client_accounts, which is written the moment someone registers (Google
// sign-in or the email/password form). Surveys are deliberately not the source
// here -- a registered account that has never surveyed still belongs on this
// page, and an account that surveyed ten times is still one account. The
// activity itself lives on /survey-records.
//
// Deliberately narrow: an admin sees the account's name, its email, whether it
// is institutional or personal, and when it registered. Ratings, comments and
// demographics all stay on /survey-records where they already live.
const ACCOUNT_LIST_LIMIT = 500;

app.get('/user-accounts', ensureAdminAuth, noCache, (req, res) => {
    // Newest registration first, which is also the page's default sort. The
    // sort controls in the toolbar reorder these same rows in the browser, so
    // switching sort never costs a round trip.
    const accountsQuery = `
        SELECT ca.email,
               ca.respondent_name,
               ca.google_photo_url,
               ca.created_at,
               (SELECT COUNT(*)
                  FROM survey_responses s
                 WHERE s.google_email = ca.email
                   AND s.canonical_status = 'canonical') AS submission_count
        FROM client_accounts ca
        ORDER BY ca.created_at DESC, ca.email ASC
        LIMIT ${ACCOUNT_LIST_LIMIT}
    `;

    // Counted over the whole table rather than derived from the capped list
    // above, so the tiles stay truthful once there are more than
    // ACCOUNT_LIST_LIMIT accounts.
    //
    // The CSPC test mirrors isCspcEmail() exactly: both institutional domains,
    // matched on the END of the address so a personal address that merely
    // mentions the school (e.g. cspc.edu.ph.fake@gmail.com) is not counted as
    // institutional. '%@cspc.edu.ph' does not match '...@my.cspc.edu.ph',
    // hence the second pattern.
    //
    // "Registered today" uses a boundary computed in the display zone and
    // passed in, rather than MySQL's CURDATE(). CURDATE() is midnight in the
    // DATABASE's zone, which on a UTC server is 8am Manila -- so between
    // midnight and 8am the tile would count yesterday's registrations while
    // the dates listed right below it read correctly.
    const startOfToday = startOfZonedDay(new Date());
    const statsQuery = `
        SELECT COUNT(*) AS total_accounts,
               SUM(LOWER(ca.email) LIKE '%@cspc.edu.ph'
                OR LOWER(ca.email) LIKE '%@my.cspc.edu.ph') AS cspc_accounts,
               SUM(ca.created_at >= ?) AS today_count
        FROM client_accounts ca
    `;

    db.query(accountsQuery, (err, rows) => {
        if (err) console.error('\u274c [User Accounts] Error loading registered accounts:', err);

        db.query(statsQuery, [startOfToday], (err2, statRows) => {
            if (err2) console.error('\u274c [User Accounts] Error loading account stats:', err2);

            // Both the date and the time of registration are resolved in
            // DISPLAY_TIME_ZONE rather than the server's own, so a deployment
            // running in UTC still reports campus time.
            const accounts = (rows || []).map(row => {
                const when = row.created_at ? new Date(row.created_at) : null;
                const email = row.email || '';
                const hasName = !!(row.respondent_name && String(row.respondent_name).trim());
                const name = hasName ? String(row.respondent_name).trim() : 'No name set';

                return {
                    email,
                    name,
                    hasName,
                    isCspc: isCspcEmail(email),
                    // The Google account's own picture, saved at sign-in (see
                    // /auth/google/callback). Only http(s) is passed through --
                    // the column is a plain VARCHAR an operator could edit, and
                    // this value goes straight into an <img src>, so a
                    // javascript:/data: URL must never reach the template.
                    photoUrl: /^https?:\/\//i.test(String(row.google_photo_url || '').trim())
                        ? String(row.google_photo_url).trim()
                        : null,
                    submissionCount: Number(row.submission_count) || 0,
                    // Sort keys are precomputed server-side so the browser sort
                    // compares numbers and lowercased strings instead of
                    // re-parsing the printed date on every click.
                    nameKey: name.toLowerCase(),
                    dateKey: when ? when.getTime() : 0,
                    registeredDate: when ? formatZonedDateShort(when) : 'Unknown',
                    registeredTime: when ? formatZonedTime(when) : '',
                    registeredFull: when ? `${formatZonedDayLabel(when)} at ${formatZonedTime(when)}` : 'Registration date unknown'
                };
            });

            const stats = (statRows && statRows[0]) ? statRows[0] : {};
            const totalAccounts = Number(stats.total_accounts) || 0;
            const cspcAccounts = Number(stats.cspc_accounts) || 0;

            res.render('user-accounts', {
                accounts,
                listedCount: accounts.length,
                accountLimit: ACCOUNT_LIST_LIMIT,
                stats: {
                    totalAccounts,
                    cspcAccounts,
                    // Personal is the complement rather than its own SUM(), so
                    // the two tiles can never disagree with the total.
                    personalAccounts: Math.max(totalAccounts - cspcAccounts, 0),
                    todayCount: Number(stats.today_count) || 0
                }
            });
        });
    });
});

// ==========================================
// ADMIN NOTIFICATION BELL (INCOMING SURVEYS)
// ==========================================
// The feed IS survey_responses -- no per-admin notification rows are written
// anywhere, so a survey can never exist without its notification (or a
// notification without its survey). "Unseen" is a single per-admin watermark
// (admins.notifications_seen_at, see its ALTER TABLE) compared against each
// survey's created_at; NULL falls back to the admin account's own creation
// date so a newly added admin isn't greeted by the entire archive.
const ADMIN_NOTIFICATION_LIMIT = 20;

app.get('/api/admin/notifications', ensureAdminAuth, noCache, (req, res) => {
    const adminId = req.adminSession.user.id;

    db.query(
        'SELECT COALESCE(notifications_seen_at, created_at) AS seen_at FROM admins WHERE id = ? LIMIT 1',
        [adminId],
        (err, seenRows) => {
            if (err) {
                console.error('❌ [Admin Notifications] Error reading the seen watermark:', err);
                return res.status(500).json({ success: false, message: 'Server error loading notifications.' });
            }

            const seenAt = (seenRows && seenRows[0]) ? seenRows[0].seen_at : null;

            // Ordered and flagged by recorded_at (when the row arrived), but
            // DISPLAYING created_at (when the client submitted) — an approval
            // that replays a days-old submission is genuinely new to the admin,
            // yet its time must still read the same here as it does on
            // /survey-records and in the office's own list.
            db.query(
                `SELECT s.id, s.respondent_name, s.google_email, s.created_at,
                        COALESCE(s.recorded_at, s.created_at) AS recorded_at, o.office_name
                 FROM survey_responses s
                 JOIN offices o ON o.id = s.office_id
                 WHERE s.canonical_status = 'canonical' AND s.analysis_status = 'completed'
                 ORDER BY recorded_at DESC, s.id DESC
                 LIMIT ${ADMIN_NOTIFICATION_LIMIT}`,
                (err2, rows) => {
                    if (err2) {
                        console.error('❌ [Admin Notifications] Error loading recent surveys:', err2);
                        return res.status(500).json({ success: false, message: 'Server error loading notifications.' });
                    }

                    // Counted separately rather than derived from `rows` so the badge
                    // stays truthful past the 20 the panel lists (a burst of 50 reads
                    // as 50, not 20).
                    db.query(
                        `SELECT COUNT(*) AS unseen
                         FROM survey_responses
                         WHERE canonical_status = 'canonical'
                           AND analysis_status = 'completed'
                           AND COALESCE(recorded_at, created_at) > COALESCE(?, NOW())`,
                        [seenAt],
                        (err3, countRows) => {
                            if (err3) console.error('❌ [Admin Notifications] Error counting unseen surveys:', err3);

                            const seenTime = seenAt ? new Date(seenAt).getTime() : Infinity;
                            const notifications = (rows || []).map(row => ({
                                id: row.id,
                                office: row.office_name || 'Unknown office',
                                respondent: row.respondent_name || 'Anonymous',
                                email: row.google_email || null,
                                createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
                                isNew: row.recorded_at ? new Date(row.recorded_at).getTime() > seenTime : false
                            }));

                            res.json({
                                success: true,
                                notifications,
                                unseenCount: (countRows && countRows[0]) ? Number(countRows[0].unseen) || 0 : 0
                            });
                        }
                    );
                }
            );
        }
    );
});

// Moves this admin's watermark to now -- i.e. "the bell has been looked at".
// Per-admin, so one admin clearing their own badge never clears anyone else's.
app.post('/api/admin/notifications/seen', ensureAdminAuth, (req, res) => {
    db.query(
        'UPDATE admins SET notifications_seen_at = NOW() WHERE id = ?',
        [req.adminSession.user.id],
        (err) => {
            if (err) {
                console.error('❌ [Admin Notifications] Error saving the seen watermark:', err);
                return res.status(500).json({ success: false, message: 'Server error updating notifications.' });
            }
            res.json({ success: true });
        }
    );
});

// ==========================================
// 3. OFFICES & CLUSTERS CRUD ROUTES
// ==========================================
app.get('/offices', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT * FROM clusters ORDER BY cluster_name ASC', (err, clusters) => {
        if (err) console.error("Error loading clusters:", err);
        db.query('SELECT * FROM offices ORDER BY cluster_name ASC, office_name ASC', (err, offices) => {
            if (err) console.error("Error loading offices:", err);

            // Services grouped by office_id — powers the per-office "Services" modal below.
            db.query('SELECT id, office_id, service_name, availability FROM services ORDER BY office_id, id', (svcErr, serviceRows) => {
                const officeServicesData = {};
                if (!svcErr && serviceRows) {
                    serviceRows.forEach(row => {
                        if (!officeServicesData[row.office_id]) officeServicesData[row.office_id] = [];
                        officeServicesData[row.office_id].push({ id: row.id, service_name: row.service_name, availability: row.availability });
                    });
                }

                res.render('offices', {
                    clustersData: clusters || [],
                    officesData: offices || [],
                    officeServicesData
                });
            });
        });
    });
});

// Small helpers so every /offices and /manage-admins redirect shares the same
// success/error query-param convention already used by the login pages
// (?error=<message>) — extended here with a matching ?success=<message>.
// AppAlert.autoShowFromQuery() (public/js/alerts.js) reads these on page load.
function officesOk(msg) { return '/offices?success=' + encodeURIComponent(msg); }
function officesErr(msg) { return '/offices?error=' + encodeURIComponent(msg); }
const GENERIC_SAVE_ERROR = 'Something went wrong while processing your request. Please try again.';

app.post('/clusters/add', ensureAdminAuth, (req, res) => {
    const { cluster_name } = req.body;
    if (!cluster_name || cluster_name.trim() === "") {
        return res.redirect(officesErr('Please enter a cluster name.'));
    }
    db.query('INSERT IGNORE INTO clusters (cluster_name) VALUES (?)', [cluster_name.trim()], (err) => {
        if (err) { console.error("❌ Error adding cluster to database:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Cluster added successfully.'));
    });
});

app.post('/clusters/edit', ensureAdminAuth, (req, res) => {
    const { id, cluster_name } = req.body;
    if (!cluster_name || cluster_name.trim() === "") {
        return res.redirect(officesErr('Please enter a cluster name.'));
    }
    const newName = cluster_name.trim();
    db.query('SELECT cluster_name FROM clusters WHERE id = ?', [id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.redirect(officesErr(GENERIC_SAVE_ERROR));
        const oldName = rows[0].cluster_name;
        db.query('UPDATE clusters SET cluster_name = ? WHERE id = ?', [newName, id], (err) => {
            if (err) { console.error("❌ Error updating cluster:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
            db.query('UPDATE offices SET cluster_name = ? WHERE cluster_name = ?', [newName, oldName], (err) => {
                if (err) { console.error("❌ Error cascading cluster rename to offices:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
                loadOfficeNameCache();
                res.redirect(officesOk('Cluster updated successfully.'));
            });
        });
    });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
// Ini-cascade rin ang archive sa lahat ng offices sa ilalim ng cluster na ito.
app.post('/clusters/delete/:id', ensureAdminAuth, (req, res) => {
    db.query('SELECT cluster_name FROM clusters WHERE id = ?', [req.params.id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.redirect(officesErr(GENERIC_SAVE_ERROR));
        const clusterName = rows[0].cluster_name;
        db.query('UPDATE clusters SET is_archived = 1 WHERE id = ?', [req.params.id], (err) => {
            if (err) { console.error("❌ Error archiving cluster:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
            db.query('UPDATE offices SET is_archived = 1 WHERE cluster_name = ?', [clusterName], (err) => {
                if (err) { console.error("❌ Error cascading cluster archive to offices:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
                res.redirect(officesOk('Cluster archived successfully.'));
            });
        });
    });
});

app.post('/clusters/restore/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE clusters SET is_archived = 0 WHERE id = ?', [req.params.id], (err, result) => {
        if (err) { console.error("❌ Error restoring cluster:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Cluster restored successfully.'));
    });
});

// Permanent delete: tinatanggal talaga sa database ang cluster kasama ang mga offices sa ilalim nito.
app.post('/clusters/permanent-delete/:id', ensureAdminAuth, (req, res) => {
    db.query('SELECT cluster_name FROM clusters WHERE id = ?', [req.params.id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.redirect(officesErr(GENERIC_SAVE_ERROR));
        const clusterName = rows[0].cluster_name;
        db.query('DELETE FROM offices WHERE cluster_name = ?', [clusterName], (err) => {
            if (err) { console.error("❌ Error permanently deleting offices under cluster:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
            db.query('DELETE FROM clusters WHERE id = ?', [req.params.id], (err) => {
                if (err) { console.error("❌ Error permanently deleting cluster:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
                res.redirect(officesOk('Cluster deleted permanently.'));
            });
        });
    });
});

app.post('/offices/add', ensureAdminAuth, async (req, res) => {
    const { cluster_name, office_name, head_director, email_address, password } = req.body;
    // Login for the office approval panel (signed in at /login) — optional at creation
    // time; a super admin can also set/change it later via /offices/edit.
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    db.query('INSERT INTO offices (cluster_name, office_name, head_director, email_address, password) VALUES (?, ?, ?, ?, ?)',
    [cluster_name, office_name, head_director || 'Not Assigned', email_address, passwordHash], (err, result) => {
        if (err) { console.error("❌ Error adding office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        loadOfficeNameCache();

        // "Service(s) Availed" repeatable input group — service_name comes in as
        // either a single string or an array depending on how many rows were filled.
        let serviceNames = req.body.service_name;
        if (!serviceNames) return res.redirect(officesOk('Office added successfully.'));
        if (!Array.isArray(serviceNames)) serviceNames = [serviceNames];
        serviceNames = serviceNames.map(s => (s || '').trim()).filter(s => s.length > 0);
        if (serviceNames.length === 0) return res.redirect(officesOk('Office added successfully.'));

        const values = serviceNames.map(name => [result.insertId, name]);
        db.query('INSERT INTO services (office_id, service_name) VALUES ?', [values], (svcErr) => {
            if (svcErr) { console.error("❌ Error adding services for new office:", svcErr); return res.redirect(officesErr('Office was added, but its services could not be saved. Please add them again.')); }
            res.redirect(officesOk('Office added successfully.'));
        });
    });
});

// ==========================================
// SERVICES AVAILED — per-office CRUD (powers the client survey's dependent
// "Service Availed" dropdown, see officeServices in /client-survey below)
// ==========================================
const VALID_SERVICE_AVAILABILITY = ['daily', 'weekly', 'monthly', 'yearly'];
// Normalizes the Availability dropdown's posted value to a valid enum,
// defaulting blank/unrecognized values to 'daily' (column is NOT NULL).
function cleanAvailability(val) {
    const v = (val || '').trim().toLowerCase();
    return VALID_SERVICE_AVAILABILITY.includes(v) ? v : 'daily';
}

app.post('/services/add', ensureAdminAuth, (req, res) => {
    const { office_id, service_name, availability } = req.body;
    const name = (service_name || '').trim();
    if (!office_id || !name) return res.redirect(officesErr('Please provide a service name.'));
    db.query('INSERT INTO services (office_id, service_name, availability) VALUES (?, ?, ?)', [office_id, name, cleanAvailability(availability)], (err) => {
        if (err) { console.error("❌ Error adding service:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Service added successfully.'));
    });
});

app.post('/services/edit', ensureAdminAuth, (req, res) => {
    const { id, service_name, availability } = req.body;
    const name = (service_name || '').trim();
    if (!id || !name) return res.redirect(officesErr('Please provide a service name.'));
    db.query('UPDATE services SET service_name = ?, availability = ? WHERE id = ?', [name, cleanAvailability(availability), id], (err) => {
        if (err) { console.error("❌ Error editing service:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Service updated successfully.'));
    });
});

app.post('/services/delete/:id', ensureAdminAuth, (req, res) => {
    db.query('DELETE FROM services WHERE id = ?', [req.params.id], (err) => {
        if (err) { console.error("❌ Error deleting service:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Service deleted successfully.'));
    });
});

app.post('/offices/edit', ensureAdminAuth, async (req, res) => {
    const { id, cluster_name, office_name, head_director, email_address, password } = req.body;
    // Blank password field on edit = leave the existing login untouched (mirrors
    // how the admin edit forms already treat a blank password field).
    if (password) {
        const passwordHash = await bcrypt.hash(password, 10);
        db.query('UPDATE offices SET cluster_name = ?, office_name = ?, head_director = ?, email_address = ?, password = ? WHERE id = ?',
        [cluster_name, office_name, head_director, email_address, passwordHash, id], (err, result) => {
            if (err) { console.error("❌ Error editing office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
            loadOfficeNameCache();
            res.redirect(officesOk('Office updated successfully.'));
        });
        return;
    }
    db.query('UPDATE offices SET cluster_name = ?, office_name = ?, head_director = ?, email_address = ? WHERE id = ?',
    [cluster_name, office_name, head_director, email_address, id], (err, result) => {
        if (err) { console.error("❌ Error editing office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        loadOfficeNameCache();
        res.redirect(officesOk('Office updated successfully.'));
    });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
app.post('/offices/delete/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE offices SET is_archived = 1 WHERE id = ?', [req.params.id], (err, result) => {
        if (err) { console.error("❌ Error archiving office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Office archived successfully.'));
    });
});

app.post('/offices/restore/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE offices SET is_archived = 0 WHERE id = ?', [req.params.id], (err, result) => {
        if (err) { console.error("❌ Error restoring office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        res.redirect(officesOk('Office restored successfully.'));
    });
});

// Permanent delete: tinatanggal talaga sa database ang office record.
app.post('/offices/permanent-delete/:id', ensureAdminAuth, (req, res) => {
    db.query('DELETE FROM offices WHERE id = ?', [req.params.id], (err, result) => {
        if (err) { console.error("❌ Error permanently deleting office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        loadOfficeNameCache();
        res.redirect(officesOk('Office deleted permanently.'));
    });
});

// ==========================================
// MANAGE ADMINS CRUD ROUTES (Super Admin only)
// ==========================================
function ensureSuperAdmin(req, res, next) {
    if (req.adminSession && req.adminSession.user && req.adminSession.user.type === 'admin' && req.adminSession.user.role === 'Super Admin') {
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(403).json({ success: false, message: "Only a Super Admin can manage admin accounts." });
    }
    return res.redirect('/dashboard');
}

app.get('/manage-admins', ensureAdminAuth, ensureSuperAdmin, noCache, (req, res) => {
    db.query('SELECT id, username, fullname, gender, role, created_at FROM admins ORDER BY fullname ASC', (err, admins) => {
        if (err) console.error("❌ Error loading admins:", err);
        res.render('manage-admins', { adminsData: admins || [] });
    });
});

// Role isn't exposed in the Manage Admins UI (access control only, not a user-facing
// concept) — every admin created here defaults to the plain 'Admin' role. Promoting
// someone to Super Admin is a direct-database action, deliberately kept out of the UI.
function adminsOk(msg) { return '/manage-admins?success=' + encodeURIComponent(msg); }
function adminsErr(msg) { return '/manage-admins?error=' + encodeURIComponent(msg); }

app.post('/admins/add', ensureAdminAuth, ensureSuperAdmin, async (req, res) => {
    const { username, password, fullname, gender } = req.body;
    if (!username || !password || !fullname) {
        return res.redirect(adminsErr('Please complete all required fields.'));
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query(
            'INSERT INTO admins (username, password, fullname, gender, role) VALUES (?, ?, ?, ?, ?)',
            [username.trim(), hashedPassword, fullname.trim(), gender || 'Male', 'Admin'],
            (err) => {
                if (err) { console.error("❌ Error adding admin:", err); return res.redirect(adminsErr(GENERIC_SAVE_ERROR)); }
                res.redirect(adminsOk('Admin account created successfully.'));
            }
        );
    } catch (e) {
        console.error("❌ Error hashing new admin password:", e);
        res.redirect(adminsErr(GENERIC_SAVE_ERROR));
    }
});

app.post('/admins/edit', ensureAdminAuth, ensureSuperAdmin, async (req, res) => {
    const { id, username, password, fullname, gender } = req.body;
    if (!id || !username || !fullname) {
        return res.redirect(adminsErr('Please complete all required fields.'));
    }

    // Password field is optional on edit — leave the existing hash alone when left blank.
    // Role is never touched here — it isn't part of this form, and overwriting it would
    // silently demote/promote whatever role the account already had.
    try {
        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.query(
                'UPDATE admins SET username = ?, password = ?, fullname = ?, gender = ? WHERE id = ?',
                [username.trim(), hashedPassword, fullname.trim(), gender || 'Male', id],
                (err) => {
                    if (err) { console.error("❌ Error updating admin:", err); return res.redirect(adminsErr(GENERIC_SAVE_ERROR)); }
                    res.redirect(adminsOk('Admin account updated successfully.'));
                }
            );
        } else {
            db.query(
                'UPDATE admins SET username = ?, fullname = ?, gender = ? WHERE id = ?',
                [username.trim(), fullname.trim(), gender || 'Male', id],
                (err) => {
                    if (err) { console.error("❌ Error updating admin:", err); return res.redirect(adminsErr(GENERIC_SAVE_ERROR)); }
                    res.redirect(adminsOk('Admin account updated successfully.'));
                }
            );
        }
    } catch (e) {
        console.error("❌ Error hashing updated admin password:", e);
        res.redirect(adminsErr(GENERIC_SAVE_ERROR));
    }
});

// Hard delete: admin_logs.admin_id references this row with ON DELETE SET NULL,
// so past login history is preserved even after the account itself is removed.
app.post('/admins/delete/:id', ensureAdminAuth, ensureSuperAdmin, (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (req.adminSession.user.id === targetId) {
        // Deleting your own account mid-session would leave you locked in with
        // no valid admins row behind it — block it rather than let that happen.
        return res.redirect(adminsErr('You cannot delete your own account while logged in.'));
    }
    db.query('DELETE FROM admins WHERE id = ?', [targetId], (err) => {
        if (err) { console.error("❌ Error deleting admin:", err); return res.redirect(adminsErr(GENERIC_SAVE_ERROR)); }
        res.redirect(adminsOk('Admin account deleted successfully.'));
    });
});

// ==========================================
// 4. SURVEY SETTINGS CRUD
// ==========================================

app.get('/survey', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT * FROM survey_settings ORDER BY id ASC', (err, results) => {
        let settings = { sqd: [], cc: [] };
        if (!err && results) {
            results.forEach(row => {
                if (settings[row.category]) settings[row.category].push(row);
            });
        }
        res.render('survey', { settings: settings });
    });
});

app.post('/settings/add', ensureAdminAuth, (req, res) => {
    const { category, content } = req.body;
    db.query('INSERT INTO survey_settings (category, content) VALUES (?, ?)', [category, content], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, insertId: result.insertId });
    });
});

app.post('/settings/edit', ensureAdminAuth, (req, res) => {
    const { id, content } = req.body;
    db.query('UPDATE survey_settings SET content = ? WHERE id = ?', [content, id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
app.post('/settings/delete', ensureAdminAuth, (req, res) => {
    const { id } = req.body;
    db.query('UPDATE survey_settings SET is_archived = 1 WHERE id = ?', [id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

app.post('/settings/restore', ensureAdminAuth, (req, res) => {
    const { id } = req.body;
    db.query('UPDATE survey_settings SET is_archived = 0 WHERE id = ?', [id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// Manually add a new "Period Covered" option to the dashboard filter dropdown.
// Stored as its own row in the same survey_settings lookup table used for
// SQD/CC content (category = 'period_covered') rather than a new table — see
// getMergedPeriodOptions(). This only extends the filter's choices; it does
// NOT change how new survey submissions get tagged (that stays tied to the
// server date via getPeriodCovered()).
app.post('/period-covered/add', ensureAdminAuth, (req, res) => {
    const periodCovered = String(req.body.periodCovered || '').trim();
    if (!periodCovered) {
        return res.redirect(periodCoveredErr('Please enter a period covered value.'));
    }
    getMergedPeriodOptions((existingOptions) => {
        const alreadyExists = existingOptions.some(o => normalizePeriodStr(o.value) === normalizePeriodStr(periodCovered));
        if (alreadyExists) {
            return res.redirect(periodCoveredErr('That period covered already exists.'));
        }
        db.query('INSERT INTO survey_settings (category, content) VALUES (?, ?)', ['period_covered', periodCovered], (err) => {
            if (err) { console.error('❌ Error adding period covered:', err); return res.redirect(periodCoveredErr(GENERIC_SAVE_ERROR)); }
            res.redirect(periodCoveredOk('Period covered added successfully.'));
        });
    });
});

// ==========================================
// 5. Helper Function para sa Cluster Queries
// ==========================================
function getClusterPerformanceData(clusterName, periodCovered, callback) {
    // Normalized comparison, not exact `=` — see periodNormExpr's docstring.
    // Kept consistent with /dashboard, /report, and /api/report-data so
    // /cluster/:id never reports different respondent counts/ratings than
    // the dashboard for the same selected period.
    const periodJoinFilter = periodCovered ? ` AND ${periodNormExpr('s.period_year_quarter')} = ?` : '';
    const clusterQuery = `
        SELECT
            o.id,
            o.office_name AS fullName,
            IF(LOCATE(' ', o.office_name) > 0,
               REPLACE(REPLACE(REPLACE(UPPER(o.office_name), 'OFFICE OF THE ', ''), 'OFFICE OF ', ''), 'VICE PRESIDENT FOR ', ''),
               SUBSTRING(UPPER(o.office_name), 1, 4)
            ) AS label,
            COUNT(s.id) AS resp,
            ${sqdScoreExpr(ALL_SQD_COLS)} AS rating
        FROM offices o
        LEFT JOIN survey_responses s ON o.id = s.office_id${periodJoinFilter}
        WHERE o.cluster_name = ?
        GROUP BY o.id, o.office_name
    `;
    const queryParams = periodCovered ? [normalizePeriodStr(periodCovered), clusterName] : [clusterName];

    db.query(clusterQuery, queryParams, (err, results) => {
        if (err) return callback(err, null);
        
        const formattedResults = results.map(row => {
            let shortLabel = row.label.split(' ').map(word => word[0]).join('').substring(0, 5);
            if (!shortLabel || shortLabel.length < 2) shortLabel = row.fullName.substring(0, 4).toUpperCase();
            return {
                id: row.id,
                label: shortLabel,
                fullName: row.fullName,
                resp: row.resp,
                rating: row.rating
            };
        });
        
        callback(null, formattedResults);
    });
}

// Offices belonging to one cluster, for the "Select Office" filter dropdown.
function getOfficesForCluster(clusterName, callback) {
    db.query(
        `SELECT o.id, o.office_name, ${OFFICE_REPORT_NAME_EXPR} AS report_name
         FROM offices o WHERE o.cluster_name = ? AND o.is_archived = 0 ORDER BY o.office_name`,
        [clusterName],
        (err, rows) => {
            // A failed query used to hand back an empty list silently, which emptied the
            // "Select Office" dropdown with no clue as to why — log it instead.
            if (err) console.error('❌ [getOfficesForCluster] query failed:', err.message);
            callback(err ? [] : rows);
        }
    );
}

// Every service offered by those same offices, for the "Select Service" filter
// that sits beside "Select Office" — the page keeps the whole cluster's list and
// narrows it to the picked office client-side, so switching offices doesn't cost
// a round trip. Keyed by office id, matching the office dropdown's values.
// It UNIONs the office's service catalogue with the service names respondents
// actually picked in `survey_responses`, so a service a client availed of still
// appears here (and stays reportable) even after it was renamed or removed from
// the `services` table — otherwise those responses would be uncountable.
function getServicesForCluster(clusterName, callback) {
    db.query(
        `SELECT office_id, service_name FROM (
             SELECT sv.office_id AS office_id, sv.service_name AS service_name, sv.id AS ord
             FROM services sv
             JOIN offices o ON o.id = sv.office_id
             WHERE o.cluster_name = ? AND o.is_archived = 0
             UNION
             SELECT r.office_id AS office_id, r.service_availed AS service_name, 999999 AS ord
             FROM survey_responses r
             JOIN offices o2 ON o2.id = r.office_id
             WHERE o2.cluster_name = ? AND o2.is_archived = 0
               AND r.service_availed IS NOT NULL AND TRIM(r.service_availed) <> ''
         ) AS merged
         GROUP BY office_id, service_name
         ORDER BY office_id, MIN(ord), service_name`,
        [clusterName, clusterName],
        (err, rows) => callback(err ? [] : rows)
    );
}

// ==========================================
// 6. Cluster Routes
// ==========================================
// Single dynamic cluster stats page — driven entirely by the `clusters` table,
// so a newly added cluster automatically gets its own page here (and shows up
// in the sidebar's "All Cluster" list via res.locals.sidebarClusters).
app.get('/cluster/:id', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT * FROM clusters WHERE id = ?', [req.params.id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.redirect('/offices');
        const cluster = rows[0];

        const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
        const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();

        getClusterPerformanceData(cluster.cluster_name, selectedPeriod, (err, data) => {
            getOfficesForCluster(cluster.cluster_name, (officesInCluster) => {
                getServicesForCluster(cluster.cluster_name, (servicesInCluster) => {
                    getMergedPeriodOptions((periodOptions) => {
                        res.render('cluster-detail', {
                            data: data || [],
                            periodOptions: periodOptions,
                            selectedPeriod: selectedPeriod || '',
                            officesInCluster: officesInCluster,
                            servicesInCluster: servicesInCluster,
                            clusterName: cluster.cluster_name,
                            clusterId: cluster.id
                        });
                    });
                });
            });
        });
    });
});

// ==========================================
// DYNAMIC PUBLIC DASHBOARD API
// ==========================================
app.get('/api/public-dashboard', (req, res) => {
    // Cluster/office lists come from the offices table (all non-archived offices),
    // not just ones with survey rows — so a cluster filter shows every office it
    // contains, blank (0%) if it has no responses yet, instead of hiding it.
    // office_name has no UNIQUE constraint in the schema — two offices can
    // legitimately share a name under different clusters. Keying the chart
    // buckets by office id (not name) below keeps them distinct instead of
    // silently merging their respondent counts/satisfaction % together.
    db.query('SELECT id, cluster_name, office_name FROM offices WHERE is_archived = 0 ORDER BY office_name, id', (err, officeRows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const clustersSet = new Set();
        officeRows.forEach(o => { if (o.cluster_name) clustersSet.add(o.cluster_name); });
        const clusterList = Array.from(clustersSet).sort();

        // officeList/officeCluster stay parallel arrays of DISPLAY labels (for
        // the chart legend), but officeIndexById is what actually resolves a
        // survey_responses row to its bucket index, so two offices with the
        // same name never collide into one bucket.
        const officeList = officeRows.map(o => o.office_name);
        const officeCluster = officeRows.map(o => o.cluster_name || null);
        const officeIndexById = new Map(officeRows.map((o, i) => [o.id, i]));

        const query = `
            SELECT
                o.id AS office_id,
                o.cluster_name,
                o.office_name,
                s.sqd1, s.sqd2, s.sqd3, s.sqd4, s.sqd5, s.sqd6, s.sqd7, s.sqd8,
                s.cc1, s.period_year_quarter, ${EFFECTIVE_SENTIMENT_SQL} AS sentiment
            FROM survey_responses s
            JOIN offices o ON s.office_id = o.id
            WHERE o.is_archived = 0 AND s.canonical_status = 'canonical'
        `;

        db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        // Keyed by the exact canonical period strings (PERIOD_COVERED_OPTIONS plus
        // any admin-added ones — see getMergedPeriodOptions) — real-time and
        // exact, instead of the old fuzzy 2-bucket p1/p2 substring match, so
        // switching periods reflects only what's actually in the DB for that
        // period (and shows empty once its records are gone).
        getMergedPeriodOptions((periodOptions) => {
        const chartData = {};
        const periods = periodOptions.map(o => o.value);

        periods.forEach(p => {
            chartData[p] = {
                overall: [0, 0],
                clusterSat: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                clusterResp: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                // SQD answers only (excludes the "N/A" = 0 option) — lets a cluster/
                // office whose only responses marked every question N/A be reported
                // as "no ratings yet" instead of a misleading 0% dissatisfaction.
                clusterAnswerable: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                clusterAgree: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                officeSat: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                officeResp: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                officeAnswerable: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                officeAgree: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                ccAware: [0, 0, 0],
                ccOffice: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                sentiment: { Positive: 0, Neutral: 0, Negative: 0 },
                totalRespondents: 0,
                officesEvaluated: 0
            };
        });

        // Legacy/manually-seeded rows can spell the same period a few different
        // ways ("July to Dec 2026" vs "Jul - Dec 2026") — matched on a normalized
        // form so those rows still land in the right bucket instead of vanishing.
        const normalizedPeriods = periods.map(normalizePeriodStr);

        results.forEach(row => {
            const rowNorm = normalizePeriodStr(row.period_year_quarter);
            const pIdx = normalizedPeriods.indexOf(rowNorm);
            const p = pIdx !== -1 ? periods[pIdx] : null;
            if (!p) return;

            chartData[p].totalRespondents++;
            if (row.sentiment && chartData[p].sentiment.hasOwnProperty(row.sentiment)) {
                chartData[p].sentiment[row.sentiment]++;
            }

            const cIdx = clusterList.indexOf(row.cluster_name);
            const oIdx = officeIndexById.has(row.office_id) ? officeIndexById.get(row.office_id) : -1;

            const sqdAvg = ((row.sqd1||0) + (row.sqd2||0) + (row.sqd3||0) + (row.sqd4||0) + (row.sqd5||0) + (row.sqd6||0) + (row.sqd7||0) + (row.sqd8||0)) / 8;
            const isSatisfied = sqdAvg >= 3.5;

            if (isSatisfied) chartData[p].overall[0]++;
            else chartData[p].overall[1]++;

            // 0 is the survey's "N/A" option, not a real rating — excluded from both
            // the answerable count and the agree count so an all-N/A response doesn't
            // register as 0% dissatisfaction. Mirrors the admin dashboard's sqdScoreExpr.
            const sqdVals = [row.sqd1, row.sqd2, row.sqd3, row.sqd4, row.sqd5, row.sqd6, row.sqd7, row.sqd8];
            const answerableVals = sqdVals.filter(v => v !== 0 && v !== null && v !== undefined);
            const agreeCount = answerableVals.filter(v => v === 4 || v === 5).length;

            if (cIdx !== -1) {
                chartData[p].clusterResp[cIdx]++;
                chartData[p].clusterAnswerable[cIdx] += answerableVals.length;
                chartData[p].clusterAgree[cIdx] += agreeCount;
            }

            if (oIdx !== -1) {
                chartData[p].officeResp[oIdx]++;
                chartData[p].officeAnswerable[oIdx] += answerableVals.length;
                chartData[p].officeAgree[oIdx] += agreeCount;
            }

            const ccVal = String(row.cc1 || '').trim().toLowerCase();
            const match = ccVal.match(/\d/);
            const digit = match ? match[0] : null;

            let isAwareUser = false;

            if (
                digit === '1' || digit === '2' || 
                ccVal.includes('i know what a cc is') || 
                (ccVal.includes('aware') && !ccVal.includes('not aware'))
            ) {
                chartData[p].ccAware[0]++; 
                isAwareUser = true;
            } else if (
                digit === '4' || ccVal.includes('do not know') || ccVal.includes('not aware')
            ) {
                chartData[p].ccAware[1]++; 
            } else if (
                digit === '3' || ccVal.includes('i learned of the cc') || ccVal.includes('only when i saw')
            ) {
                chartData[p].ccAware[2]++; 
                isAwareUser = true;
            }

            if (oIdx !== -1 && isAwareUser) {
                chartData[p].ccOffice[oIdx]++; 
            }
        });

        periods.forEach(p => {
            // null = has respondents but every one of them marked N/A on all SQD
            // questions, so there's nothing ratable yet — distinct from 0 (no
            // respondents at all) and from a real, computed 0% dissatisfaction.
            chartData[p].clusterSat = chartData[p].clusterAnswerable.map((answerable, i) => {
                if (answerable > 0) return Math.round((chartData[p].clusterAgree[i] / answerable) * 100);
                return chartData[p].clusterResp[i] > 0 ? null : 0;
            });
            chartData[p].officeSat = chartData[p].officeAnswerable.map((answerable, i) => {
                if (answerable > 0) return Math.round((chartData[p].officeAgree[i] / answerable) * 100);
                return chartData[p].officeResp[i] > 0 ? null : 0;
            });
            delete chartData[p].clusterAnswerable;
            delete chartData[p].clusterAgree;
            delete chartData[p].officeAnswerable;
            delete chartData[p].officeAgree;
            chartData[p].ccOffice = chartData[p].ccOffice.map((awareCount, i) => {
                return chartData[p].officeResp[i] > 0 ? Math.round((awareCount / chartData[p].officeResp[i]) * 100) : 0;
            });
            chartData[p].officesEvaluated = chartData[p].officeResp.filter(r => r > 0).length;
        });

        res.json({
            chartData: chartData,
            clusterList: clusterList.length > 0 ? clusterList : undefined,
            officeList: officeList.length > 0 ? officeList : undefined,
            officeCluster: officeList.length > 0 ? officeCluster : undefined,
            periodOptions: periodOptions,
            currentPeriod: getPeriodCovered()
        });
        });
        });
    });
});

// ==========================================
// SERVER START
// ==========================================
const listenPort = process.env.PORT || port;
app.listen(listenPort, '0.0.0.0', () => {
    console.log(`Server is running on port ${listenPort}`);
    console.log(`Open: http://localhost:${listenPort}`);
    startModelServer();
});