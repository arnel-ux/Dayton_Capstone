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

// All report/dashboard computation formulas live in report_computation/report_formula.js.
// Imports SQD scoring, bucket breakdowns, period normalization, topic/sentiment resolution, and badge coloring helpers.
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

// Tells Express to trust the X-Forwarded-For header only from a loopback proxy (like nginx on the same host).
// TRUST_PROXY env var can override this for other setups.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Makes the current request path available to every view for sidebar highlighting.
app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
});

// Makes the landing page hero image available to every view that shows a photo backdrop.
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
// Admin and client sessions use separate cookies so logins in different tabs don't overwrite each other.
// Client sessions run through normal express-session. Admin sessions use a hand-rolled cookie and store below, since express-session can't run two instances at once.
app.use(session({
    name: 'client.sid',
    store: new session.MemoryStore(),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
        // Only requires HTTPS in production, so local dev over http still works.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

const ADMIN_COOKIE_NAME = 'admin.sid';
const ADMIN_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 hours
const adminSessions = new Map(); // sessionId -> { data: {}, expiresAt: number }

function newAdminSessionId() {
    return crypto.randomBytes(24).toString('base64url');
}

function readAdminSessionIdFromCookie(req) {
    const cookies = cookieLib.parse(req.headers.cookie || '');
    const raw = cookies[ADMIN_COOKIE_NAME];
    if (!raw || raw.slice(0, 2) !== 's:') return null;
    const id = cookieSignature.unsign(raw.slice(2), process.env.SESSION_SECRET);
    return id || null; // false if signature is missing or tampered
}

function writeAdminSessionCookie(res, id) {
    res.cookie(ADMIN_COOKIE_NAME, 's:' + cookieSignature.sign(id, process.env.SESSION_SECRET), {
        httpOnly: true,
        maxAge: ADMIN_SESSION_MAX_AGE_MS,
        path: '/',
        // Same as the client session cookie, HTTPS only in production.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
}

// Regenerates the admin session with a new id and blank data, used at login to prevent session fixation.
function regenerateAdminSession(req, res) {
    if (req.adminSessionID) adminSessions.delete(req.adminSessionID);
    req.adminSessionID = newAdminSessionId();
    req.adminSession = {};
    req._adminSessionHadExisting = false;
}

// Destroys an admin session by id, used to force-invalidate a session open in another tab or device.
function destroyAdminSessionById(id) {
    if (id) adminSessions.delete(id);
}

// Marks a session id as replaced by a newer login, so ensureAdminAuth can tell
// that apart from an ordinary timeout. Stored as a tombstone entry in adminSessions until its original expiry, then read and cleared once.
function markAdminSessionReplaced(id) {
    if (!id) return;
    const existing = adminSessions.get(id);
    const expiresAt = (existing && existing.expiresAt) || (Date.now() + ADMIN_SESSION_MAX_AGE_MS);
    adminSessions.set(id, { replaced: true, expiresAt });
}

// Destroys this request's admin session and clears its cookie. Used by ensureAdminAuth and /logout.
function destroyAdminSession(req, res) {
    destroyAdminSessionById(req.adminSessionID);
    res.clearCookie(ADMIN_COOKIE_NAME, { path: '/' });
    req.adminSession = {};
    req.adminSessionID = null;
    req._adminSessionDestroyed = true;
}

// Loads req.adminSession from the 'admin.sid' cookie on every request.
// Only writes a store entry and cookie back if the session was already valid or got populated during this request.
app.use((req, res, next) => {
    const existingId = readAdminSessionIdFromCookie(req);
    let existingEntry = existingId && adminSessions.get(existingId);
    if (existingEntry && existingEntry.expiresAt <= Date.now()) {
        adminSessions.delete(existingId);
        existingEntry = null;
    }

    // Read before req.adminSessionID gets replaced below. Lets ensureAdminAuth
    // pick the right alert: replaced, expired, or login required.
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

// Checks whether an admin session id is still live. Used by the periodic sweep and the Active Now check in admin_logs.
function isSessionAlive(sessionId) {
    if (!sessionId) return false;
    const entry = adminSessions.get(sessionId);
    // A tombstoned entry keeps its expiresAt but isn't a usable session.
    return !!(entry && !entry.replaced && entry.expiresAt > Date.now());
}

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Feeds the Admin Logs modal with the most recent login sessions and their durations.
// Only runs for actual admin sessions, must run after the session middleware above.
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

        // A row with no logout_time only counts as Active Now if its session id is still alive in the store.
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

// Checks whether an email is an institutional cspc.edu.ph or my.cspc.edu.ph address.
function isCspcEmail(email) {
    if (typeof email !== 'string') return false;
    const normalized = email.toLowerCase().trim();
    return normalized.endsWith('@cspc.edu.ph') || normalized.endsWith('@my.cspc.edu.ph');
}

// Checks whether enough time has passed since the last approved submission for the service's cadence to allow resubmission.
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

// Returns the epoch ms when this account becomes eligible again, or null for a one-time only service.
function nextEligibleTimestamp(lastEventAt, availability) {
    const stepDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 }[availability];
    if (!stepDays || !lastEventAt) return null;
    return new Date(lastEventAt).getTime() + stepDays * 86400000;
}

// Returns a human readable date the client becomes eligible again, or null for a one-time only service.
function nextEligibleDateText(lastEventAt, availability) {
    const ts = nextEligibleTimestamp(lastEventAt, availability);
    if (!ts) return null;
    return new Date(ts).toLocaleDateString('en-PH', { dateStyle: 'long', timeZone: DISPLAY_TIME_ZONE });
}

// Resubmission eligibility now runs through resolveSubmissionPrecedence, which uses withLogicalSurveyLock below.

// Looks up a survey_responses row by its client-generated submission id.
// Used to short-circuit the eligibility check and insert for an idempotent replay. Returns null if nothing matches.
function findSurveyByClientSubmissionId(clientSubmissionId) {
    if (!clientSubmissionId) return Promise.resolve(null);
    return dbQuery('SELECT id FROM survey_responses WHERE client_submission_id = ? LIMIT 1', [clientSubmissionId])
        .then(rows => (rows && rows.length) ? rows[0] : null)
        .catch(err => {
            console.error("❌ [Idempotency] Lookup by client_submission_id failed:", err);
            return null; // fail open rather than block a legitimate submission
        });
}

// All canonical inserts go through submitCanonicalSurvey below, which wraps this insert logic with the precedence lock.

// Core insert into survey_responses, client_profiles, and client_accounts, shared by every canonical insert path.
// Runs on the caller's dedicated pooled connection so it joins that transaction. Does not send email or run AI analysis, callers handle those after commit.
// submissionSource is always supplied by the caller, never read from client JSON.
// Every row starts as canonical_status='canonical'; superseding an older row is a separate UPDATE in the same transaction.

// Bulk-inserts a comment's extra topics beyond the primary one stored on survey_responses.topic.
// No-op for an empty list. sort_order keeps the classifier's ranking order.
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

// Same as above but on the shared pooled db, used by fire-and-forget classification callbacks that run after their own transaction commits.
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

    // A no-feedback comment gets NULL instead of the placeholder default.
    const noFeedback = isNoFeedbackComment(comments);
    // Only the first/primary topic is stored on this row, extras go into survey_response_topics once the id is known.
    // A caller whose analysis hasn't run yet (analysisPending, see below)
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

    // Extra topics beyond the primary. Only populated here when the caller already has the full list at insert time.
    if (!noFeedback) {
        await insertExtraTopicsOnConnection(conn, surveyResponseId, topicsList.slice(1));
    }

    // Uses the same timestamp as its survey_responses row.
    await conn.query(
        `INSERT INTO client_profiles (survey_response_id, respondent_name, client_type, age, gender, region, email, office_visited_time, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [surveyResponseId, respondentName, clientType, age, gender, region, googleEmail, officeVisitedTime, submittedAt || null]
    );

    // Never touches respondent_name here. region/age/gender are write-once, filled only if still NULL.
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
// A committed Online submission always wins over an Offline one for the same account, office, and service.
// Offline can create a canonical row if nothing exists yet, but a later Online submission always supersedes it.
// Enforced with a MySQL named lock (GET_LOCK) across all insert entry points, so two concurrent submissions can't both pass eligibility before either commits.
const LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS = 8;

function logicalSurveyLockName(officeId, googleEmail, serviceAvailed) {
    const raw = `${officeId}|${String(googleEmail || '').toLowerCase()}|${serviceAvailed || ''}`;
    // MySQL named lock names are capped at 64 chars, so this hashes the key.
    return 'cspc_survey_' + crypto.createHash('sha1').update(raw).digest('hex');
}

// Runs work(conn) while holding a named lock for one logical survey key, on a single dedicated connection.
// Throws an Error with code LOCK_TIMEOUT if the lock isn't acquired in time. Callers should treat that as retryable.
async function withLogicalSurveyLock(officeId, googleEmail, serviceAvailed, work) {
    const lockName = logicalSurveyLockName(officeId, googleEmail, serviceAvailed);
    const conn = await db.promise().getConnection();
    try {
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // GET_LOCK returns 1 (acquired), 0 (timed out), or NULL (DB error).
        // Only 1 proceeds, 0 and NULL are both treated as retriable but logged differently.
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
            // Best effort release, the lock dies with the connection anyway if this fails.
            await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch((releaseErr) => {
                console.error('❌ [Survey Lock] RELEASE_LOCK failed (harmless — dies with the connection):', releaseErr);
            });
        }
    } finally {
        conn.release();
    }
}

// Must run on the connection holding the logical survey lock, before any insert.
// Checks pending submissions and cadence, and decides Online vs Offline precedence for the same office, account, and service.
// A pending row blocks the incoming submission unless incoming is online and the pending row isn't.
// A canonical row past its cooldown means a fresh, separate opportunity, always inserted as new.
// A canonical row still in its cooldown gets superseded only if incoming is online and it isn't, otherwise normal cadence rejection applies.
// options.ignorePending skips the pending check, used only by the office-approval route reviewing its own queue.
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

// Throws the right typed Error for a reject or reject_pending decision, no-ops otherwise.
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

// Single funnel for every auto-approved survey insert. Acquires the lock, resolves precedence, inserts, supersedes the losing row if needed, then releases.
// Does not send email or run AI analysis, callers do that after this resolves.
// Resolves to { surveyResponseId, supersededId }. Rejects with an Error whose code is ELIGIBILITY_REJECTED, PENDING_REJECTED, or LOCK_TIMEOUT.
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
            // Last resort idempotency net for a duplicate submission id, resolves to the existing row instead of an error.
            if (err.code === 'ER_DUP_ENTRY' && fields.clientSubmissionId) {
                const existing = await findSurveyByClientSubmissionId(fields.clientSubmissionId);
                if (existing) return { surveyResponseId: existing.id, supersededId: null, alreadyRecorded: true };
            }
            throw err;
        }
    });
}

// Same precedence gate as submitCanonicalSurvey, for the personal or external email branch that queues a pending row for office review instead of inserting directly.
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

// Ensures only an authenticated client, Google or unified login, can view or submit the survey.
// Treats a missing or destroyed session the same as not logged in.
function ensureClientAuth(req, res, next) {
    const email = getClientEmail(req);
    if (email) {
        req.clientEmail = email;
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please sign in before submitting the survey." });
    }
    // A client.sid cookie with no valid session behind it means the browser was logged in and it expired, as opposed to never logging in at all.
    const hadSessionCookie = !!(req.headers.cookie && req.headers.cookie.includes('client.sid='));
    return res.redirect(302, hadSessionCookie ? '/login?status=session_expired' : '/login?status=login_required');
}

// Ensures only a logged-in admin can view or use admin pages and CRUD routes.
// Same missing or destroyed session handling as ensureClientAuth above.
function ensureAdminAuth(req, res, next) {
    if (req.adminSession && req.adminSession.user && req.adminSession.user.type === 'admin') {
        // login_token tie-breaks two admin tabs sharing one cookie: /auth-login stamps a fresh token on every login,
        // so an older tab's session fails this comparison on its next request.
        return db.query('SELECT login_token FROM admins WHERE id = ?', [req.adminSession.user.id], (err, rows) => {
            if (err) {
                console.error('❌ Error verifying login_token:', err);
                return res.redirect(302, '/login?error=' + encodeURIComponent('Server error. Please try again.'));
            }

            const dbToken = rows && rows[0] ? rows[0].login_token : null;
            if (!dbToken || dbToken !== req.adminSession.login_token) {
                // A stale token means a real newer login happened elsewhere.
                destroyAdminSession(req, res);
                return res.redirect(302, '/login?status=session_replaced');
            }

            res.locals.loginToken = dbToken; // read by the cross tab BroadcastChannel sync script

            // Powers the sidebar's All Cluster submenu, queried per request so a new cluster shows up immediately.
            db.query('SELECT id, cluster_name FROM clusters WHERE is_archived = 0 ORDER BY cluster_name', (err, clusters) => {
                res.locals.sidebarClusters = err ? [] : clusters;
                next();
            });
        });
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please log in as admin first." });
    }

    // A cookie was sent but no admin session was found. Only trust req._adminSessionMissingReason === 'replaced' as evidence of a real other login, everything else is treated as plain expiration.
    if (req._adminSessionMissingReason === 'replaced') {
        return res.redirect(302, '/login?status=session_replaced');
    }
    const hadSessionCookie = !!(req.headers.cookie && req.headers.cookie.includes('admin.sid='));
    if (hadSessionCookie) {
        return res.redirect(302, '/login?status=session_expired');
    }
    return res.redirect(302, '/login?status=login_required');
}

// Ensures only a logged-in office account can view or use the office approval panel.
// Reuses the same admin session infra as ensureAdminAuth with a distinct user.type.

// The spelled-out name for offices whose office_name is stored as an acronym.
// Applied on boot so every environment shows the full name without a manual migration step.
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

// Runs once per boot. Matches on office_name rather than id, and only fills a full_name that is missing.
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

// Strips a trailing acronym in parentheses from an office name, like "(NSTP)".
// Only strips a parenthetical that looks like an acronym: no spaces, 2 to 15 characters.
function stripParentheticalAcronym(name) {
    const raw = String(name || '').trim();
    const stripped = raw.replace(/\s*\(([^)\s]{2,15})\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return stripped || raw;
}

function deriveOfficeShortName(officeName, fullName) {
    const stored = String(officeName || '').trim();
    const full = String(fullName || '').trim();
    if (!stored) return '';

    // If office_name is already the acronym, it is the short form.
    if (full && full.toLowerCase() !== stored.toLowerCase()) return stored;

    // A parenthesized acronym in the name itself beats a derived one.
    const parenthesized = stored.match(/\(([^)]{2,15})\)/);
    if (parenthesized) return parenthesized[1].trim();

    // Otherwise build initials from the words that carry meaning, dropping linking words like "and" or "of".
    const words = stored
        .replace(/\([^)]*\)/g, ' ')
        .split(/[\s/,\-]+/)
        .filter(Boolean)
        .filter((w) => !OFFICE_ACRONYM_STOPWORDS.has(w.toLowerCase()));
    const initials = words.map((w) => w.charAt(0).toUpperCase()).join('');

    // A single initial is not a name, so a one-word office keeps its word.
    return initials.length >= 2 ? initials : stored;
}

// Builds the office name pair the header shows. officeName is the full spelled out name, officeNameShort is the fallback for when it doesn't fit.
function officeHeaderNames(user) {
    const stored = String((user && user.office_name) || '').trim();
    const full = String((user && user.full_name) || '').trim() || stored;
    return {
        officeName: stripParentheticalAcronym(full),
        officeNameShort: deriveOfficeShortName(stored, user && user.full_name)
    };
}

function ensureOfficeAuth(req, res, next) {
    if (req.adminSession && req.adminSession.user && req.adminSession.user.type === 'office') {
        // Fills in full_name for a session opened before it existed, so the header spells the office out without a re-login.
        // fullNameResolved tracks whether the lookup already succeeded, since an empty full_name alone doesn't tell whether it was ever checked.
        const officeUser = req.adminSession.user;
        if (!officeUser.full_name && !officeUser.fullNameResolved) {
            return db.query('SELECT full_name FROM offices WHERE id = ? LIMIT 1', [officeUser.id], (err, rows) => {
                if (err) {
                    console.error('❌ Error loading this office full name:', err);
                    // Left unresolved on purpose, the next page load tries again.
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
    // Offices sign in through the same /login form as admins and clients.
    return res.redirect(302, '/login?status=login_required');
}

// Tells the browser and any proxy to never cache a restricted page or serve it from the bfcache.
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
// Uses a pool instead of a single connection so a dropped connection gets replaced automatically and query errors surface per callback instead of crashing the process.
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'cqa_db',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    // The dev MySQL plan caps max_user_connections at 5 total.
    connectionLimit: process.env.DB_CONNECTION_LIMIT ? parseInt(process.env.DB_CONNECTION_LIMIT, 10) : 4,
    queueLimit: 0,
    // TCP keep-alive pings the connection so it doesn't get silently dropped while idle.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// Listens for pool-level errors too, so those can't crash the process via an unhandled error event.
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

// Promise wrapper around db.query, used by routes that await each step in sequence.
const dbQuery = promisify(db.query).bind(db);

// Caches office_id to "office_name, cluster_name" strings, used as a soft hint for the AI topic classifier.
// Refreshed at startup and lazily on a cache miss.
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
// AI MODEL SERVER (persistent, keeps transformer weights loaded in memory instead of reloading per comment)
// ==========================================
const MODEL_SERVER_PORT = process.env.AI_MODEL_SERVER_PORT || 8765;
const MODEL_SERVER_URL = `http://127.0.0.1:${MODEL_SERVER_PORT}`;
let modelServerProcess = null;
let modelServerReady = false;

// Prefers the venv's python.exe over whatever python resolves to on PATH.
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

// Last resort safety net, logs and keeps serving instead of letting one bad request kill the whole server.
process.on('uncaughtException', (err) => {
    console.error('❌ [FATAL] Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ [FATAL] Unhandled promise rejection (server kept running):', reason);
});

// ==========================================
// LANDING PAGE CONTENT (CMS-editable, index.ejs)
// ==========================================
// Stored as one JSON blob since the CMS reads and writes whole sections at a time.
// DEFAULT_LANDING_CONTENT is what a fresh database renders before any row is saved.
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

// The Cluster/Office/Service directory and the Transparency Dashboard are out of scope for this CMS.
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

// Persists one section's fields merged over what was already saved, so saving one section doesn't wipe the others.
// Synchronous since this is an infrequent admin action.
function saveLandingSection(section, fields) {
    const current = loadLandingContent();
    current[section] = { ...current[section], ...fields };
    fs.writeFileSync(LANDING_DATA_FILE, JSON.stringify(current, null, 2), 'utf8');
    return current[section];
}

// Runs a comment through analyze.py in a fresh Python process. Slower than the persistent model server.
// Used as a fallback when the model server is unreachable, and as the normal path for offline-synced comments.
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
                        // topics is a non-empty array.
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

// Parses pending_survey_submissions.payload, which mysql2 may return as an already-parsed object or as a JSON string.
// Accepts both shapes and never throws, an unusable payload comes back as {}.
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

// isNoFeedbackComment now lives in shared/commentFilter.js alongside the gibberish test and profanity masking.

// Resolves { sentiment, topics } for a comment. Used by both the live submit route and the batch sync route.
// Never rejects. A blank comment resolves with nulls, and any failure falls back to Neutral / General Feedback.
// offline should be true for comments from the sync queue, which use a fresh analyze.py subprocess instead of the persistent model server.
// officeId is an optional soft topic hint for the classifier, never a hard override.
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
                // topics is a non-empty array.
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
// Optional and non-blocking. If MAIL_USER/MAIL_PASS aren't set, sending is skipped and submissions still work normally.
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

// Local logo, embedded as an inline CID attachment so it shows in the email body instead of as a downloadable attachment.
const RECEIPT_LOGO_PATH = path.join(__dirname, 'public', 'images', 'cspc-logo.png');

// Citizen's Charter SQD statements, keyed by index so the email table can show the full statement instead of "SQD0".
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
// Escapes free-text client input before it lands in email HTML, so a comment can't inject markup.
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Server-side allowlist for age/gender/region, since a direct POST could bypass the form's fixed option sets and inject markup when rendered back.
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

// Citizen's Charter option sets, mirrors the CC1/CC2/CC3 radio values. Used to coerce out-of-set values to null on the unauthenticated verify-and-sync endpoint.
const VALID_CC1 = new Set([
    "I know what a CC is and I saw this office's CC.",
    "I know what a CC is but I did not see this office's CC.",
    "I learned of the CC only when I saw this office's CC.",
    "I do not know what a CC is and I did not see one in this office"
]);
const VALID_CC2 = new Set(['Easy to see', 'Somewhat easy to see', 'Difficult to see', 'Not visible at all', 'N/A']);
const VALID_CC3 = new Set(['Helped very much', 'Did not help', 'Somewhat helped', 'N/A']);

// Comments have no length cap elsewhere in the app, but this unauthenticated endpoint gets one.
const OFFLINE_SURVEY_MAX_COMMENTS_LENGTH = 2000;

const sqdStatementFor = (label) => {
    const idx = parseInt(String(label).replace(/[^0-9]/g, ''), 10);
    return Number.isInteger(idx) && SQD_STATEMENTS[idx] ? `${label}. ${SQD_STATEMENTS[idx]}` : label;
};

// ==========================================
// SQD Score, bucket breakdown, cluster/office score cell, and office display name formulas now live in
// views/layout/report_computation/report_formula.js.

// ==========================================
// DISPLAY TIME ZONE
// ==========================================
// Every timestamp is rendered in Philippine time regardless of where the server runs.
// This only changes how stored instants are printed, not what is stored.
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Asia/Manila';

// Templates format a few timestamps inline too, and need the same zone.
app.locals.displayTimeZone = DISPLAY_TIME_ZONE;

// Cache-busting query string for report.css, changes once per server start so a CSS edit shows up on refresh.
app.locals.assetVersion = Date.now();

// The display zone's UTC offset at a given instant, computed per-instant so it still works if the zone ever observes DST.
function zonedOffsetMs(date) {
    const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const asZone = new Date(date.toLocaleString('en-US', { timeZone: DISPLAY_TIME_ZONE }));
    return asZone.getTime() - asUtc.getTime();
}

// Returns 'YYYY-MM-DD' for the calendar day this instant falls on in the display zone. Decides which day heading two submissions group under.
function zonedDayKey(date) {
    return date.toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE });
}

// Returns the instant midnight began, in the display zone, for the day this instant falls on. Used for today/last 7 days counting.
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

// The compact 'Sep 18, 2026' form, for places that print a date in a fixed-width column.
function formatZonedDateShort(date) {
    return date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: DISPLAY_TIME_ZONE
    });
}

// Formats as 'September 05, 2026', computed in the display zone rather than the database session's zone. Returns '' for a missing or invalid value.
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
// Submission tagging stays dynamic since the client can't tamper with it. The filter dropdown is a fixed static list to avoid legacy strings leaking into the UI.
function getPeriodCovered(date = new Date()) {
    // Uses the display zone's year and month, not the server's.
    const parts = {};
    new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', timeZone: DISPLAY_TIME_ZONE })
        .formatToParts(date).forEach(p => { parts[p.type] = p.value; });
    const year = Number(parts.year);
    const month = Number(parts.month) - 1; // 0 = Jan ... 11 = Dec
    return month <= 5 ? `Jan to June ${year}` : `July to Dec ${year}`;
}

// Validates and normalizes the submitted office visit date and time into a MySQL DATETIME literal. Invalid input drops to NULL rather than rejecting.
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

// Period normalization formula now lives in views/layout/report_computation/report_formula.js.

// Only periods that have already come around are listed here. An admin adds the next one when it arrives, via /period-covered/add.
const PERIOD_COVERED_OPTIONS = [
    { value: 'Jan to June 2026', label: 'Jan to June 2026' },
    { value: 'July to Dec 2026', label: 'July to Dec 2026' }
];

// Admin-added periods on top of the fixed list, stored in survey_settings. Merged and de-duped against normalizePeriodStr so a differently-spelled collision never shows twice.
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

// Sends the client a proof-of-completion receipt. Fire-and-forget, called after the client already got its success response.
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

    // Only references the logo if the file exists, so a missing logo never breaks the email.
    const hasLogo = fs.existsSync(RECEIPT_LOGO_PATH);
    const logoHtml = hasLogo
        ? `<img src="cid:cspc-logo" alt="CSPC Logo" width="72" style="display:block;margin:0 auto 12px;max-width:72px;width:72px;height:auto;">`
        : '';

    // Full standalone HTML document so Gmail's mobile and web clients respect the viewport meta and media query, letting the layout reflow on phones.
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

    // contentDisposition:'inline' stops Gmail from listing this as a separate downloadable attachment.
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

// Sent instead of the generic receipt when a personal-email submission is reviewed and approved by the office.
// Shows the full result inside the email itself rather than linking out. Fire-and-forget like sendSurveyReceiptEmail.
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

// The decline-side counterpart to sendSurveyApprovedEmail. Only personal-email clients ever have a pending submission to decline.
// Does not echo back SQD/CC answers since nothing was recorded, just the office, service, and reason. Fire-and-forget.
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

// Looks up the office name for a declined submission and sends the decline email. Shared by both decline paths.
// Kept as a callback rather than awaited since both call sites fire it after their response already went out.
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

// Sends a client a one-time password-reset link. Fire-and-forget, the response stays generic either way so it never confirms whether an account exists.
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

// Sent only after a CSPC institutional offline survey is verified and inserted. Never sent to an address that hasn't proven ownership via password.
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

// Sent only after an external or Gmail offline survey is verified and queued into pending_survey_submissions.
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
// Creates one client notification for a real server event, never for a purely local or browser condition.
// Idempotent via dedupe_key's unique constraint, INSERT IGNORE no-ops on a repeat instead of erroring or duplicating.
// A soft-deleted notification's row still exists, so the same dedupe_key can never resurrect one the user already deleted.
// Fire-and-forget, called after the caller's transaction already committed, so a failure here is logged and swallowed.
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

// Holds extra topics beyond the primary one on survey_responses.topic, for a comment naming more than one distinct thing.
// Ordered by sort_order, which preserves the classifier's own array order. A no-feedback comment never gets a row here.
const createSurveyResponseTopicsTableQuery = `
CREATE TABLE IF NOT EXISTS survey_response_topics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_response_id INT NOT NULL,
    topic VARCHAR(150) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);`;

// Services per office, used by the dependent Service Availed dropdown in client-survey.ejs.
const createServicesTableQuery = `
CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);`;

// Holds submissions from non institutional accounts until the visited office approves them.
// Approved rows get replayed into survey_responses, and this row is kept as an audit trail instead of deleted.
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

// Tracks outcomes of the offline survey verify-and-sync flow. The unique key on offline_submission_id is the idempotency guard for retried syncs.
// Never holds a password or credential, only written after one is already verified and discarded.
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

// In-app client notification inbox. client_email matches client_accounts.email, the account identifier used everywhere else.
// dedupe_key's unique constraint makes creation idempotent and stops a soft-deleted notification from being recreated by a replay.
// Soft delete only, a notification is never physically removed.
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

// Bookkeeping for one-off data migrations, unlike the idempotent ALTER TABLEs above. One row per migration name records that it ran.
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

// One row per Google or registered client account. Holds demographic details locked in from the first survey submission, and lets registered clients log in.
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
// client_accounts.email is the account identifier, stored as a plain column everywhere else rather than a foreign key.
// Deleting an account by hand in the DB left its surveys, submissions, and notifications behind, and a re-registered email would silently inherit them.
// Two fixes since the delete happens outside this app: an AFTER DELETE trigger that purges owned rows immediately, and a startup sweep for anything orphaned before the trigger existed.
// Rows with a null or blank email are untouched, those are anonymous walk-in submissions.

// Ordered children first. stamp is the column that says when the row was written on this server, used to spot rows that predate the account now owning their email.
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

// Dropped and recreated on every boot so the trigger always matches the list above.
function installClientAccountPurgeTrigger() {
    db.query('DROP TRIGGER IF EXISTS trg_client_accounts_purge_owned_rows', (dropErr) => {
        if (dropErr) {
            // Most likely cause is the DB user lacking TRIGGER privilege. Without it, a hand-made delete is only cleaned up at the next restart by the sweep below.
            console.error('❌ Could not drop client_accounts purge trigger:', dropErr.message);
            return;
        }
        db.query(createClientAccountPurgeTriggerQuery, (createErr) => {
            if (createErr) console.error('❌ Could not install client_accounts purge trigger — deleting an account will leave its surveys/notifications behind until the next restart:', createErr.message);
            else console.log('✅ client_accounts purge trigger verified/created successfully!');
        });
    });
}

// Fresh-start guard for re-registration after a delete that predates the trigger.
// Anything older than the newly inserted account row belonged to the deleted account, and gets purged.
// Only called when registration actually inserted a new account row, never on an existing account resaving its details.
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
                // Logged and swallowed, a leftover row must never fail the registration. The startup sweep catches whatever this misses.
                if (err) console.error(`❌ [Account] Could not clear old ${table} rows for ${email}:`, err.message);
                else if (result && result.affectedRows > 0) console.log(`🧹 [Account] Cleared ${result.affectedRows} ${table} row(s) from a previous account under ${email}.`);
                finish();
            }
        );
    });
}

// Cleans up leftovers from deletes made before the trigger existed. Two cases:
// orphaned rows whose email has no client_accounts row at all, and inherited rows whose account exists but the row predates it (the re-registration case).
// The one-minute grace period covers an account and its first survey being written in the same transaction with second-precision timestamps.
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

    // Seeds the two original accounts once, so a fresh database still boots with working admin logins.
    // Stored as bcrypt hashes so a leaked DB dump doesn't hand over working credentials.
    // Deployers must change both passwords immediately after first login.
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

        // Ties each admin_logs row to the exact browser session that created it, so the same account logged in from multiple tabs shows separate Active Now rows.
        db.query("ALTER TABLE admin_logs ADD COLUMN session_id VARCHAR(255) NULL", () => {});

        // Lets an admin set a custom profile photo instead of the auto-generated initials avatar.
        db.query("ALTER TABLE admins ADD COLUMN photo_url VARCHAR(500) NULL", () => {});

        // Single active session enforcement. Stamped fresh on every login, compared on every request to catch a displaced tab or device.
        db.query("ALTER TABLE admins ADD COLUMN login_token VARCHAR(255) NULL", () => {});

        // Watermark for the notification bell, the moment this admin last opened the panel.
        // The backfill only runs the first time this column is added, so existing survey history doesn't all show as unseen.
        db.query("ALTER TABLE admins ADD COLUMN notifications_seen_at DATETIME NULL", (alterErr) => {
            if (alterErr) return;
            db.query("UPDATE admins SET notifications_seen_at = NOW()", () => {});
        });

        // A server restart wipes the in-memory admin session Map, so no browser can close these rows via /logout anymore. Closes them out at restart instead.
        db.query('UPDATE admin_logs SET logout_time = NOW() WHERE logout_time IS NULL', (err, result) => {
            if (err) console.error("❌ Error closing orphaned admin_logs rows:", err);
            else if (result.affectedRows > 0) console.log(`✅ Closed ${result.affectedRows} orphaned admin_logs row(s) from before this restart.`);
        });
    });
});

// ==========================================
// ABANDONED ADMIN SESSION SWEEP
// ==========================================
// Catches what /logout can't: a browser closed or tab left open without logging out.
// Every few minutes, closes out any admin_logs row that's still open but whose session no longer exists.
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

// Tables are created in order to avoid foreign key errors.
db.query(createClustersTableQuery, (err) => {
    if (err) {
        console.error("❌ Error creating clusters table:", err);
    } else {
        console.log('✅ clusters table verified/created successfully!');
        db.query("ALTER TABLE clusters ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0", () => {});
        // Seeds default clusters if empty.
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

        // Creates the offices table next.
        db.query(createOfficesTableQuery, (err) => {
            if (err) {
                console.error("❌ Error creating offices table:", err);
            } else {
                console.log('✅ offices table verified/created successfully!');
                db.query("ALTER TABLE offices ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0", () => {});
                // Office-side login for the approval panel, a bcrypt hash set by the super admin. NULL means no login is set up yet.
                db.query("ALTER TABLE offices ADD COLUMN password VARCHAR(255) NULL", () => {});
                // Full office name for printed reports, since some offices are stored under their acronym. NULL means office_name is already the full name.
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
                    // Which channel queued this pending submission, read by resolveSubmissionPrecedence so a pending offline row can be preempted by an incoming online one.
                    // Historical rows default to legacy_unknown rather than online.
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

                // Creates the survey_responses table next.
                db.query(createSurveyTableQuery, (err) => {
                    if (err) {
                        console.error("❌ Error creating survey_responses table:", err);
                    } else {
                        db.query("ALTER TABLE survey_responses ADD COLUMN respondent_name VARCHAR(255) DEFAULT 'Anonymous'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN topic VARCHAR(100) DEFAULT 'General'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN sentiment VARCHAR(50) DEFAULT 'Neutral'", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN region VARCHAR(100) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN google_email VARCHAR(255) NULL", () => {
                            // The old once-per-office constraint no longer holds since resubmission is now cadence-based.
                            // A plain index on office_id is added first since MySQL won't drop the old unique index until something else backs the FK.
                            db.query("CREATE INDEX idx_survey_responses_office_id ON survey_responses(office_id)", () => {
                                db.query("ALTER TABLE survey_responses DROP INDEX unique_office_google_email", () => {});
                            });
                        });
                        // Which service this submission was for. Drives the per-service resubmission cooldown.
                        db.query("ALTER TABLE survey_responses ADD COLUMN service_availed VARCHAR(255) NULL", () => {});

                        // Idempotency guard for the online survey path. Ensures the same client-generated submission id never creates two rows.
                        // NULL is allowed and multiple NULLs never collide.
                        db.query("ALTER TABLE survey_responses ADD COLUMN client_submission_id VARCHAR(64) NULL", () => {
                            db.query("ALTER TABLE survey_responses ADD UNIQUE KEY unique_client_submission_id (client_submission_id)", () => {});
                        });

                        // Admin manual correction columns for the AI's sentiment, topic, and subtopic read.
                        // Kept separate from topic/sentiment, which stay the raw AI output. NULL means no override yet.
                        db.query("ALTER TABLE survey_responses ADD COLUMN topic_override VARCHAR(150) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN subtopic_override VARCHAR(100) NULL", () => {});
                        db.query("ALTER TABLE survey_responses ADD COLUMN sentiment_override VARCHAR(20) NULL", () => {});

                        // A live comment is inserted with a placeholder topic and sentiment while the AI analyzes it in the background.
                        // Pending rows are excluded from every admin-facing display until the async update flips them to completed. Historical rows default to completed.
                        db.query("ALTER TABLE survey_responses ADD COLUMN analysis_status ENUM('pending','completed') NOT NULL DEFAULT 'completed'", () => {});

                        db.query(createSurveyResponseTopicsTableQuery, (err) => {
                            if (err) console.error('❌ Error creating survey_response_topics table:', err);
                            else console.log('✅ survey_response_topics table verified/created successfully!');
                        });
                        db.query("CREATE INDEX idx_survey_response_topics_response_id ON survey_response_topics(survey_response_id)", () => {});

                        // ---- Online-vs-Offline canonical precedence (data-consistency fix) ----
                        // Which channel created this row, server-derived at insert time and never trusted from client JSON.
                        // Historical rows default to legacy_unknown rather than online, so a real historical offline row is never immune to a later online submission superseding it.
                        db.query("ALTER TABLE survey_responses ADD COLUMN submission_source ENUM('online','offline_sync','legacy_unknown') NOT NULL DEFAULT 'legacy_unknown'", () => {});
                        // canonical counts everywhere, superseded is a losing row kept for audit and excluded from reports.
                        db.query("ALTER TABLE survey_responses ADD COLUMN canonical_status ENUM('canonical','superseded') NOT NULL DEFAULT 'canonical'", () => {});
                        // Points at the canonical row that superseded this one, NULL if none.
                        db.query("ALTER TABLE survey_responses ADD COLUMN superseded_by_id INT NULL", () => {});
                        // Backs resolveSubmissionPrecedence's canonical row lookup so it doesn't scan every row for the office under a submission burst.
                        db.query("CREATE INDEX idx_survey_responses_logical_key ON survey_responses(office_id, google_email, service_availed, canonical_status)", () => {});

                        // When this row was actually written, as opposed to created_at which is when the client submitted.
                        // The two differ for a submission replayed later by an office approval, so the notification bell can still order by real arrival time.
                        // The backfill only runs the first time this column is added.
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
                            // Forgot Password support: a short-lived single-use token, stored only as a SHA-256 hash plus its expiry.
                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN reset_token_hash VARCHAR(255) NULL", 'reset_token_hash');
                            alterClientAccounts("ALTER TABLE client_accounts ADD COLUMN reset_token_expires DATETIME NULL", 'reset_token_expires');
                            // Drives the one-time setup wizard on /client-survey after registration. Existing accounts default to already onboarded, new signups insert 0.
                            // The backfill below is nested in this callback so it never races the ALTER on a different pooled connection.
                            db.query("ALTER TABLE client_accounts ADD COLUMN onboarding_completed TINYINT(1) NOT NULL DEFAULT 1", (alterErr) => {
                                // ER_DUP_FIELDNAME is the normal steady state, so the backfill still runs. Anything else means the column is really missing.
                                if (alterErr && alterErr.code !== 'ER_DUP_FIELDNAME') {
                                    console.error("❌ Could not add client_accounts.onboarding_completed — skipping backfill:", alterErr.message);
                                    return;
                                }

                                // Seeds one client_accounts row per email from that email's most recent client_profiles submission, for clients who submitted before accounts existed.
                                // One-time only, marked in schema_migrations, so a deleted account never gets silently re-created from old submission history.
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

                                    // A deployment that already has accounts has already run this backfill before, so re-running it would resurrect deleted accounts. Skipped in that case.
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

                            // Deleting an account takes everything it owns with it, so re-registering the same email starts genuinely empty.
                            installClientAccountPurgeTrigger();
                            sweepOrphanedClientAccountRows();

                            // Region/age/gender are locked in exactly once, at an account's own first real submission, and nowhere else.
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
    // Reads landing-data.json synchronously so whatever the admin last saved is guaranteed to be what renders here.
    const landingContent = loadLandingContent();
    res.render('index', { landingContent });
});

// Closes this browser session's own admin_logs row, never anyone else's. Matches by id first, falling back to session_id for an older cookie without it.
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

// Verifies a g-recaptcha-response token against Google's siteverify endpoint. Runs server-side so it can't be bypassed with a direct POST.
function verifyRecaptcha(token, remoteIp) {
    return new Promise((resolve) => {
        // Gates on RECAPTCHA_SITE_KEY rather than the secret key, matching what decides whether the widget renders client-side.
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
// The main /login form posts here for both admin credentials and any email already known in client_accounts.
// Detecting the bcrypt prefix lets both plaintext seed rows and hashed rows log in through the same form.
function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]?\$/.test(value);
}

// Simple in-memory per-IP login attempt throttle, since this portal runs as a single Node process.
const loginAttempts = new Map(); // ip -> { count, windowStart }
const LOGIN_RATE_LIMIT_MAX = 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Counts failed attempts only, so a shared office IP with several people logging in correctly never trips the limit.
// The middleware only reads the bucket, the route handler reports the outcome back through the two helpers on req below.
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
        // A correct password clears prior failures for this address, so an early typo doesn't count against a colleague later.
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

// JSON-response counterpart to loginRateLimiter, for API routes where a redirect doesn't make sense.
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

// Offline sync gets a generous ceiling since many students can be reconnecting from the same shared IP at once.
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

// Same non-revealing message as a normal verification failure. Never distinguishes locked out from wrong credentials.
const OFFLINE_VERIFY_GENERIC_MESSAGE = 'Unable to verify the registered account information provided.';

const offlineVerifyLimiter = jsonRateLimiter('offline-verify', { windowMs: 15 * 60 * 1000, max: 40 });

// Per-account login lockout, separate from the per-IP limiter above. Protects one specific account from being guessed at all, even across many IPs.
// Keyed by the identifier typed into the login form, lowercased so different casings share one counter.
const failedLoginsByAccount = new Map(); // identifier -> { count, firstAttempt, lockedUntil }
// Five attempts still stops guessing cold while not locking someone out over an ordinary typo and retry.
const ACCOUNT_LOCKOUT_THRESHOLD = 5;
const ACCOUNT_LOCKOUT_WINDOW_MS = 5 * 60 * 1000; // failed attempts older than this no longer count
const ACCOUNT_LOCKOUT_DURATION_MS = 5 * 60 * 1000; // how long the account stays locked once tripped

// Returns the active lockout entry for this identifier, or null if it isn't
// currently locked (also clears it out of the Map once expired).
function getAccountLockout(identifier) {
    // Locks out an account after too many failed attempts to stop password guessing.
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
        // Don't return this db.query call directly, it breaks inside an async function.
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

            // Issues a fresh session id and cookie for this login.
            regenerateAdminSession(req, res);

            req.adminSession.user = {
                id: admin.id,
                username: admin.username,
                fullname: admin.fullname,
                gender: admin.gender,
                role: admin.role, // used for server side access control, not shown in the UI
                created_at: admin.created_at,
                photo_url: admin.photo_url || null,
                type: 'admin' // auth flag, separate from the role field
            };
            req.adminSession.admin = req.adminSession.user;
            req.adminSession.login_token = loginToken;

            // Only one active session allowed per admin account, this token is what enforces it.
            db.query('UPDATE admins SET login_token = ? WHERE id = ?', [loginToken, admin.id], (tokenErr) => {
                if (tokenErr) console.error('❌ Error saving login_token:', tokenErr);
            });

            db.query('SELECT session_id FROM admin_logs WHERE admin_id = ? AND logout_time IS NULL', [admin.id], (err, openRows) => {
                if (err) console.error('❌ Error loading this admin\'s open sessions:', err);

                // Kicks out any other open session for this admin on its next request.
                (openRows || [])
                    .map(r => r.session_id)
                    .filter(sid => sid && sid !== req.adminSessionID)
                    .forEach(sid => {
                        // Marks the old session as replaced instead of deleting it outright.
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
                        // Lets the header's new tab guard know this tab actually logged in.
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

    // One email can belong to both a client account and an office account, so try both.
    db.query('SELECT email, password FROM client_accounts WHERE email = ? LIMIT 1', [emailInput], async (err, rows) => {
        if (err) {
            return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
        }

        const account = rows && rows[0];
        // No client account with this email, try the office login instead.
        if (!account) return handleOfficeLogin({ knownAsClient: false });
        // A Google signed up client account has no password of its own yet.
        if (!account.password) return handleOfficeLogin({ knownAsClient: true, noClientPassword: true });

        const passwordMatches = await bcrypt.compare(password, account.password);
        if (!passwordMatches) return handleOfficeLogin({ knownAsClient: true });

        clearFailedLogins(emailInput);
        if (req.clearLoginFailures) req.clearLoginFailures();

        // Regenerates the session before assigning identity to prevent session fixation.
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

            regenerateAdminSession(req, res);
            req.adminSession.user = {
                id: office.id,
                office_name: office.office_name,
                // Kept on the session so pages can show the office name without a query.
                full_name: office.full_name || null,
                cluster_name: office.cluster_name,
                email_address: office.email_address,
                type: 'office'
            };
            // Sends the office straight to its dashboard after login.
            return res.redirect('/office-dashboard?loggedin=1');
        });
    }
    }
});

// Client's dedicated Google sign in entry point. Bounces to the survey if already signed in.
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
// Office staff log in through the same /login form as everyone else.
// These two routes just forward any old bookmarked links to the real page.
app.get('/office-login', noCache, (req, res) => {
    // Carries status/error through so the forwarded visitor still sees why they were sent here.
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    let target = '/login';
    if (error) target += '?error=' + encodeURIComponent(error);
    else if (status) target += '?status=' + encodeURIComponent(status);
    return res.redirect(302, target);
});

// Old cached office login form, redirects to the real one instead of processing credentials.
app.post('/office-login', loginRateLimiter('/login'), (req, res) => {
    return res.redirect(303, '/login?status=login_required');
});

app.get('/office-logout', noCache, (req, res) => {
    // Sends the office back to /login with a logged out confirmation.
    const hadSession = !!(req.adminSession && req.adminSession.user && req.adminSession.user.type === 'office');
    destroyAdminSession(req, res);
    res.redirect(302, hadSession ? '/login?status=logged_out' : '/login');
});

// Approval/decline history count only, used for the sidebar History badge.
function getOfficeHistoryCount(officeId, callback) {
    db.query(
        "SELECT COUNT(*) AS c FROM pending_survey_submissions WHERE office_id = ? AND status IN ('approved', 'declined')",
        [officeId],
        (err, rows) => callback((!err && rows && rows[0]) ? rows[0].c : 0)
    );
}

// Pending count only, used for the sidebar Pending badge.
function getOfficePendingCount(officeId, callback) {
    db.query(
        "SELECT COUNT(*) AS c FROM pending_survey_submissions WHERE office_id = ? AND status = 'pending'",
        [officeId],
        (err, rows) => callback((!err && rows && rows[0]) ? rows[0].c : 0)
    );
}

// ---------------------------------------------------------------------------
// OFFICE DASHBOARD, counts only
// ---------------------------------------------------------------------------
// Shows totals and pending/approved/declined counts for the signed in office.
// Only counts are queried, no respondent names or answers.
app.get('/office-dashboard', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.adminSession.user.id;
    const { officeName, officeNameShort } = officeHeaderNames(req.adminSession.user);

    // Reporting period is the current semester, January to June or July to December.
    const now = new Date();
    const year = now.getFullYear();
    const isFirstSem = now.getMonth() < 6;
    const semStartMonth = isFirstSem ? 0 : 6;
    const semesterLabel = 'Period Covered';
    const semesterRange = (isFirstSem ? 'January–June ' : 'July–December ') + year;

    // Start is inclusive, end is exclusive at the first day of the next semester.
    const pad = (n) => String(n).padStart(2, '0');
    const semStart = year + '-' + pad(semStartMonth + 1) + '-01';
    const semEnd = (semStartMonth === 0)
        ? year + '-07-01'
        : (year + 1) + '-01-01';

    // Builds all six months of the semester, including ones still ahead of today.
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

    // Respondent counts, this semester and all time.
    db.query(
        'SELECT COUNT(*) AS allTime, ' +
        'SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS semester ' +
        'FROM survey_responses WHERE office_id = ?',
        [semStart, semEnd, officeId],
        (errTotal, totalRows) => {
            const totalRow = (!errTotal && totalRows && totalRows[0]) ? totalRows[0] : {};
            const totalRespondentsAllTime = Number(totalRow.allTime || 0);
            const totalRespondents = Number(totalRow.semester || 0);

            // One pass over the submission statuses, each counted for the semester and all time.
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
                                // Pending is not semester scoped, it is a live work queue.
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
    const officeId = req.adminSession.user.id;
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
                        // Stays 0 on error instead of failing the whole poll.
                        responses: Number((respRows && respRows[0] && respRows[0].c) || 0)
                    });
                }
            );
        }
    );
});

// Feed for the office bell and pending surveys popup. Built straight from the live pending queue.
app.get('/office-approvals/notifications', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.adminSession.user.id;
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
    const officeId = req.adminSession.user.id;
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
                res.render('office-approvals', Object.assign(officeHeaderNames(req.adminSession.user), {
                    submissions,
                    historyCount
                }));
            });
        }
    );
});

// Approval/decline history, its own page separate from the Pending list.
app.get('/office-approvals/history', ensureOfficeAuth, noCache, (req, res) => {
    const officeId = req.adminSession.user.id;
    // Most recently reviewed first, capped at 50 rows.
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
                // Real reviewed submission count, not history.length which is capped at 50.
                getOfficeHistoryCount(officeId, (historyCount) => {
                    res.render('office-history', Object.assign(officeHeaderNames(req.adminSession.user), {
                        history,
                        pendingCount,
                        historyCount
                    }));
                });
            });
        }
    );
});

// Claims and finalizes the submission in one transaction so nothing is left half applied.
// AI analysis and the approval email run outside the transaction since they are slow.
app.post('/office-approvals/:id/approve', ensureOfficeAuth, async (req, res) => {
    const officeId = req.adminSession.user.id;
    const submissionId = req.params.id;

    const conn = await db.promise().getConnection();
    let payload = null;
    let googleEmail = null;
    let surveyResponseId = null;
    let submittedAtDb = null; // pending row's created_at, when the client actually submitted
    let claimFailed = false;
    let supersededByOnline = false;
    let lockName = null;
    let lockHeld = false;

    try {
        await conn.beginTransaction();

        // Claims the row first by flipping it to processing, prevents double approval.
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
            // Payload is unusable, fail loudly instead of inserting a half empty survey row.
            throw new Error('CORRUPT_PAYLOAD');
        }

        // Rechecks online vs offline precedence here since an online submission may
        // have arrived since this was queued. Lock guards against a concurrent one.
        lockName = logicalSurveyLockName(payload.officeId, googleEmail, payload.serviceAvailed);
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // 1 means acquired, 0 means timed out, null means a real DB error.
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
            // An online submission already owns this survey, so decline instead of approving.
            supersededByOnline = true;
            await conn.query(
                "UPDATE pending_survey_submissions SET status = 'declined', reviewed_at = NOW(), decline_reason = ? WHERE id = ?",
                ['Superseded by a later online submission for this service.', row.id]
            );
            await conn.query(
                "UPDATE offline_survey_submissions SET approval_status = 'rejected' WHERE pending_submission_id = ?",
                [row.id]
            );
            // Releases the lock only after commit so no one reads pre commit state.
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

        // affectedRows 0 is fine here, an online submission has no matching offline row.
        await conn.query(
            "UPDATE offline_survey_submissions SET approval_status = 'approved', survey_response_id = ? WHERE pending_submission_id = ?",
            [surveyResponseId, row.id]
        );

        // Commits first, then releases the lock, same as the reject branch above.
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

    // Reaching here means this is the normal approved outcome, not superseded by online.
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

    // Fire and forget AI analysis after commit, only if not already analyzed.
    if (!isNoFeedbackComment(payload.comments)) {
        analyzeComment(payload.comments, false, payload.officeId).then(({ sentiment: aiSentiment, topics: aiTopics }) => {
            // analysis_status must always reach completed, even on a degraded classification.
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
            // Uses the survey's real submission time, not the approval time.
            submittedAt: formatSubmittedAtForEmail(submittedAtDb ? new Date(submittedAtDb) : null),
            surveyResponseId,
            cc1: payload.cc1, cc2: payload.cc2, cc3: payload.cc3,
            sqd: (payload.sqdValues || []).map((v, i) => ({ label: 'SQD' + i, value: v })),
            comments: payload.comments || 'N/A'
        });
    });
});

// Transactional for the same reason as approve above, decline and the offline
// tracking update commit or roll back together.
app.post('/office-approvals/:id/decline', ensureOfficeAuth, async (req, res) => {
    const officeId = req.adminSession.user.id;
    const reason = String(req.body.decline_reason || '').trim().slice(0, 255) || null;
    const submissionId = req.params.id;

    const conn = await db.promise().getConnection();
    let googleEmail = null;
    let declined = false;
    // Captured inside the transaction, used after commit for the decline email.
    let declinedPayload = {};
    let declinedServiceAvailed = null;
    let submissionOfficeId = officeId;
    try {
        await conn.beginTransaction();

        // The WHERE clause guards against double processing or wrong office.
        // `declined` only gates whether a notification fires, not the response.
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

        // Also emails the client since this app notification only reaches them if they sign back in.
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
// Forces Google's account chooser every time instead of auto signing in the current device account.
// intent=reset marks this as a password reset identity check, stashed in session since Google's
// callback only echoes code and state.
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

// Handles registration, login, and password reset identity verification for clients
// depending on whether an account and password already exist for this Google email.
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
            // Logs out the passport session, it should only persist once a password is set.
            req.logout(() => {
                if (err) {
                    return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                }

                const existingAccount = rows && rows.length > 0 ? rows[0] : null;

                if (isResetIntent) {
                    if (!existingAccount) {
                        return res.redirect('/login?tab=register&error=' + encodeURIComponent('No account found for that Google email. Open the Register tab and sign up with that email first.'));
                    }
                    // Google already verified this identity, so skip the emailed token.
                    req.session.googleVerifiedResetEmail = existingAccount.email;
                    return res.redirect('/reset-password?verified=1');
                }

                if (existingAccount && existingAccount.password) {
                    // Regenerates the session first to prevent session fixation.
                    return req.session.regenerate((regenErr) => {
                        if (regenErr) {
                            return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                        }
                        req.session.clientEmail = existingAccount.email;
                        // Refreshes the stored photo on every Google sign in without blocking the redirect.
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

    // Clamps the name and photo to their column widths so the insert never fails on them.
    const registeredEmail = String(pending.email).trim();
    const respondentName = pending.name ? String(pending.name).trim().slice(0, 255) : null;
    // Only keeps an http(s) photo URL under 500 chars, otherwise drops it.
    const rawPhoto = pending.photo ? String(pending.photo).trim() : '';
    const photoUrl = (rawPhoto.length <= 500 && /^https?:\/\//i.test(rawPhoto)) ? rawPhoto : null;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        // Regenerates the session first to prevent session fixation.
        const finishRegistration = () => {
            req.session.regenerate((regenErr) => {
                if (regenErr) {
                    return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
                }
                req.session.clientEmail = registeredEmail;
                return res.redirect('/client-survey?loggedin=1');
            });
        };

        // onboarding_completed only applies on insert, so re-registering keeps its state.
        // withPhoto falls back to columns every deployment is guaranteed to have,
        // in case the google_photo_url column never got added at startup.
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

        // affectedRows 1 means a brand new account, so clear out anything left by
        // a previous deleted account under the same address first.
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
// Either an emailed token good for 30 minutes, or verifying with Google again,
// both leading to the same reset password form.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Constant time comparison so response timing can't leak how much of a guess is correct.
function timingSafeHexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

app.get('/forgot-password', noCache, (req, res) => {
    res.render('forgot-password', { sent: req.query.sent === '1' });
});

// Always shows the same generic check your email outcome so this can't confirm an account exists.
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
                // Regenerates the session first to prevent session fixation.
                req.session.regenerate((regenErr) => {
                    if (regenErr) return fail('Server error. Please try again.');
                    req.session.clientEmail = verifiedEmail;
                    return res.redirect('/client-survey?loggedin=1');
                });
            });
            return;
        }

        // Re-validates the token server side before actually changing the password.
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
                    // Regenerates the session first to prevent session fixation.
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

// Logs out the admin session, the client session, or both depending on ?scope.
// Destroys the session, clears cookies, and redirects to /login.
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

    // Only set true by real server-side evidence of a newer login, never from the query string.
    let confirmedReplaced = false;

    const finishAdminLogout = (next) => {
        if (!isAdminSession) return next();
        // Only clears login_token if this session still owns it.
        const adminId = req.adminSession.user.id;
        const ownToken = req.adminSession.login_token;
        db.query('UPDATE admins SET login_token = NULL WHERE id = ? AND login_token = ?', [adminId, ownToken], (err, result) => {
            if (err) {
                console.error('❌ Error clearing login_token on logout:', err);
            } else if (!result || result.affectedRows === 0) {
                // The token was already overwritten by a real newer login.
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
            // status=logged_out only shows for a real manual logout with an actual session.
            // A confirmed replacement instead shows the signed in elsewhere message.
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

        // All active services grouped by office, powers the Service Availed dropdown.
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

            // Most recent approved submission per office and service for this account.
            db.query(
                "SELECT office_id, service_availed, MAX(created_at) AS last_at FROM survey_responses WHERE google_email = ? AND canonical_status = 'canonical' GROUP BY office_id, service_availed",
                [clientEmail],
                (err2, approvedRows) => {
                    db.query(
                        "SELECT office_id, service_availed FROM pending_survey_submissions WHERE google_email = ? AND status = 'pending'",
                        [clientEmail],
                        (err4, pendingRows) => {
                            const blockedCombos = {};
                            // Epoch ms when a cadence based service becomes eligible again, powers the countdown.
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

                            // Locked demographics from this account's first submission plus its registered name.
                            db.query('SELECT respondent_name, region, age, gender, onboarding_completed FROM client_accounts WHERE email = ? LIMIT 1', [clientEmail], (err3, profileRows) => {
                                const clientProfile = (!err3 && profileRows && profileRows.length > 0) ? profileRows[0] : null;
                                // Shows the setup wizard only for accounts still at onboarding_completed 0.
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

// Marks the setup wizard as dismissed, whether the client finished it or skipped.
app.post('/api/onboarding-complete', ensureClientAuth, noCache, (req, res) => {
    db.query('UPDATE client_accounts SET onboarding_completed = 1 WHERE email = ?', [req.clientEmail], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error saving your progress.' });
        res.json({ success: true });
    });
});

// ==========================================
// CLIENT ACCOUNT — Profile tab (view/update)
// ==========================================
// Region, age, and sex are not editable here since they lock after the first survey.
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
                // Only whether a password exists, never the hash itself.
                has_password: !!row.password
            };
            res.json({ success: true, profile });
        }
    );
});

// Builds an offline context snapshot for one account: profile plus office and
// service eligibility, using the same rules as /client-survey. Never includes
// passwords, hashes, or session data.
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

    // Same precedence as /client-survey, a pending review blocks regardless of cadence.
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

// Called after page load so the browser can cache this account's profile and
// eligibility snapshot in IndexedDB for /survey-offline to use later.
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
// Every route here is scoped by the session's own client email, never by anything
// the request supplies, so one account can't touch another's notifications. Deletes are soft.
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
// Still rate limited even though the session is authenticated, so guessing the current password stays costly.
const clientPasswordChangeLimiter = jsonRateLimiter('client-password-change', { windowMs: 15 * 60 * 1000, max: 10 });

app.post('/api/client-password', ensureClientAuth, clientPasswordChangeLimiter, async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    // Same 8 character minimum as account creation.
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

        // A null hash means this is a Google only account, so this becomes a set password flow.
        if (existingHash) {
            if (!currentPassword) {
                return res.status(400).json({ success: false, message: 'Please enter your current password.' });
            }
            const ok = await bcrypt.compare(currentPassword, existingHash);
            if (!ok) {
                return res.status(400).json({ success: false, message: 'Your current password is incorrect.' });
            }
            // Rejects setting the same password again.
            const same = await bcrypt.compare(newPassword, existingHash);
            if (same) {
                return res.status(400).json({ success: false, message: 'Your new password must be different from your current one.' });
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbQuery('UPDATE client_accounts SET password = ? WHERE email = ?', [hashedPassword, req.clientEmail]);

        // Session stays intact, they already confirmed their identity on this page.
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
// Merges approved surveys with still pending or declined submissions, sorted by date.
// Pending rows get a p prefixed id and aren't clickable since there is no answer detail yet.
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
    // Raw request body, disabled fields on a repeat visit may show as missing here.
    console.log("📥 [Survey Payload Dumating] (raw, pre-profile-merge):", req.body);

    const googleEmail = req.clientEmail;

    // Region, age, and sex lock after the first submission, so fetch the saved profile
    // and let it win over whatever the disabled form fields posted.
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

    // Saved DB value always wins once it exists, this is what actually locks the fields server side.
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
    // Stable client generated id, checked first so a retried submit reuses the same row.
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
        // AI analysis runs asynchronously after this insert, so the row starts pending.
        analysisPending: true
    };
    console.log("📤 [Survey Final Fields] (after profile merge, what actually gets stored):", fields);

    // Always online, this route is a live authenticated session request.
    const SUBMISSION_SOURCE = 'online';

    try {
        // CSPC accounts land straight in survey_responses, others need office approval.
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
                    // Always flips analysis_status to completed, even on a degraded classification.
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
// OFFLINE SYNC — receives queued surveys once the connection is back.
// Waits for AI analysis on each one before responding, so the Service
// Worker only deletes them from IndexedDB once they are safely saved.
// ==========================================
app.post('/sync-surveys', ensureClientAuth, async (req, res) => {
    const googleEmail = req.clientEmail;
    const rawSurveys = Array.isArray(req.body.surveys) ? req.body.surveys : (Array.isArray(req.body) ? req.body : []);

    if (!rawSurveys.length) {
        return res.status(400).json({ success: false, message: "No surveys provided to sync." });
    }

    const results = [];

    // Sequential on purpose, each iteration needs a fresh duplicate check against the last.
    for (const item of rawSurveys) {
        const localId = item && item.localId;
        const payload = (item && item.payload) || item || {};
        try {
            // localId is the idempotency key so a retried sync reuses the same row.
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
    // When the survey was actually completed offline, null falls back to stamping at sync time.
    const submittedAt = resolveOfflineSubmittedAt(createdOfflineAtRaw);
    const cleanInt = (val) => (val !== undefined && val !== "" && val !== null && !isNaN(val)) ? parseInt(val, 10) : null;
    const cleanStr = (val) => (val !== undefined && val !== null && String(val).trim() !== "") ? String(val).trim() : null;

    // A retry of an already recorded submission id resolves as success right away.
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
    // Filed under the half year it was answered in, not the one the sync happened to land in.
    const currentPeriod = getPeriodCovered(submittedAt || new Date());

    // Always offline_sync since this survey was answered offline, regardless of connection speed.
    const SUBMISSION_SOURCE = 'offline_sync';

    // CSPC accounts are trusted automatically, others wait for office approval.
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

    // Checks precedence before the slower AI call, no point analyzing a survey about to be rejected.
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
        // An online submission already owns this survey, so this offline copy never becomes canonical.
        return { success: true, status: 'superseded_by_online', alreadyOnline: true, message: 'Your online submission for this service was already received — this offline copy was not needed.' };
    }

    // Awaits AI analysis before inserting, falls back to Neutral/General Feedback if it fails.
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
        // Precedence is re-resolved inside submitCanonicalSurvey's own lock since the
        // earlier lock was already released before the AI call.
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
// Simple liveness probe for the client side server unavailable indicator.
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// No ensureClientAuth here since a device with no connectivity can't authenticate.
// Collects the survey plus an identifier email only, verified later at sync time.
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

// Fixed dummy hash so a no such account response takes as long as a wrong password one.
const DUMMY_BCRYPT_HASH_FOR_TIMING = bcrypt.hashSync('offline-verify-timing-guard', 10);

const OFFLINE_SUBMISSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses the client's saved offline timestamp, falls back to null on garbage or a future date.
function parseCreatedOfflineAt(raw) {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
    return parsed;
}

// The time an offline survey should be recorded under, when it was actually finished,
// not when it reached the server. Falls back to sync time if the clock looks wrong.
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

// Strict positive integer parse, unlike parseInt this rejects things like "5abc".
function parseStrictPositiveInt(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const normalized = typeof raw === 'number' ? raw : raw.trim();
    if (normalized === '') return null;
    const n = Number(normalized);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Strict integer check for one SQD answer, 0 through 5. Empty means unanswered,
// anything else invalid returns ok false.
function parseStrictSqdValue(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false };
    const normalized = typeof raw === 'number' ? raw : raw.trim();
    if (normalized === '') return { ok: true, value: null };
    const n = Number(normalized);
    if (!Number.isInteger(n) || n < 0 || n > 5) return { ok: false };
    return { ok: true, value: n };
}

// Strict counterpart to allowlisted(), rejects a value outright instead of coercing it to null.
function strictAllowlisted(value, allowedSet) {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false };
    const v = value.trim();
    if (v === '') return { ok: true, value: null };
    if (!allowedSet.has(v)) return { ok: false };
    return { ok: true, value: v };
}

// A saved value in client_accounts always wins over the request, same as /submit-survey.
function resolveLockedField(savedValue, submittedValue, allowedSet) {
    if (savedValue) return { ok: true, value: savedValue };
    return strictAllowlisted(submittedValue, allowedSet);
}

// ==========================================
// POST /api/offline-surveys/verify-and-sync
// The only place a client typed identifier gets trusted to write to the database,
// only after its password is verified here against the real bcrypt hash.
// One survey per call, only accepts a registered email, never a username.
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

    // 1. Idempotency short circuit, a retried request answers from the tracking row's current state.
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

        // Makes sure the original sync notification exists, safe to repeat on any replay
        // thanks to dedupe_key. Never re-runs the survey transaction or resends email.
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

    // SQD0-8, rejects anything that isn't cleanly an in range integer.
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

    // CC1/CC2/CC3, a supplied but invalid value is rejected outright, blank is fine.
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

    // Region, age, gender, saved DB value always wins over what was submitted.
    const regionCheck = resolveLockedField(savedProfile && savedProfile.region, payload.region, VALID_REGIONS);
    if (!regionCheck.ok) return res.status(400).json({ success: false, message: 'Invalid region submitted.' });
    const ageCheck = resolveLockedField(savedProfile && savedProfile.age, payload.age || payload.clientAge || payload.client_age, VALID_AGE_BRACKETS);
    if (!ageCheck.ok) return res.status(400).json({ success: false, message: 'Invalid age bracket submitted.' });
    const genderCheck = resolveLockedField(savedProfile && savedProfile.gender, payload.gender || payload.clientGender || payload.client_gender, VALID_GENDERS);
    if (!genderCheck.ok) return res.status(400).json({ success: false, message: 'Invalid gender submitted.' });

    // client_type is validated against the actual client_types table, not free text.
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

    // Capped to match the VARCHAR(255) columns this ends up in.
    const finalName = (cleanStr(respondent_name) || 'Anonymous').slice(0, 255);
    const finalAge = ageCheck.value || 'Not Specified';
    const finalGender = genderCheck.value || 'Not Specified';
    const finalRegion = regionCheck.value || 'Not Specified';
    const finalCc1 = cc1Check.value;
    const finalCc2 = cc2Check.value;
    const finalCc3 = cc3Check.value;
    const finalOfficeVisitedTime = cleanTime(office_visited_time);

    // 6. Precedence pre check, always offline_sync since this was answered offline.
    // Just a quick fail fast check, the real one runs again inside the transaction lock below.
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
        // The account and data are valid, but the office/service is on cooldown or an
        // online submission already owns this survey. Client treats this as eligibility_conflict.
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

    // Same rule as syncOneSurvey, files under the half year the survey was answered in.
    const currentPeriod = getPeriodCovered(submittedAt || new Date());
    const isCspc = isCspcEmail(verifiedEmail);

    // 7. Runs AI analysis before opening any DB connection or lock.
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

    // 8. Re-acquires the lock on the same dedicated connection that holds the
    // transaction below, and rechecks precedence since online could have committed
    // while AI was running.
    const conn = await db.promise().getConnection();
    let result;
    const lockName = logicalSurveyLockName(finalOfficeId, verifiedEmail, finalServiceAvailed);
    let lockHeld = false;
    try {
        const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOGICAL_SURVEY_LOCK_TIMEOUT_SECONDS]);
        // 1 means acquired, 0 means timed out, null means a real DB error. Either
        // failure returns a retriable 503 so the client keeps this queued for retry.
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

    // 9. Sends the email after commit, only to the address that proved ownership.
    // Also refreshes the offline context snapshot for the response, best effort only.
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
// Shared by /dashboard and /report/dashboard so both render the same live numbers.
function loadDashboardData(req, callback) {
    // Defaults to the current active period when periodCovered is missing from the query.
    const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
    const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();
    const hasPeriodFilter = !!selectedPeriod;

    const periodCol = periodNormExpr('s.period_year_quarter');
    // Always filters to canonical rows so totals never include a superseded submission.
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

                    // Maps cluster name to its weighted rating, used for the per cluster TOTAL row below.
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
                                // Reports always print the office's full name, not the short internal name.
                                clustersMap[cName].offices.push({ name: row.report_name, score: cell.score, interpretation: cell.interpretation, respondents: row.office_volume || 0 });

                                if (row.office_volume > 0) {
                                    rankedOffices.push({ name: row.report_name, cluster: cName, score, respondents: row.office_volume });
                                }
                            });
                        }

                        // Builds the PER CLUSTER report with each cluster's TOTAL row attached.
                        const reportData = buildOrderedClusterReport(clustersMap, clusterRatingMap, interpretForDashboard);

                        // Builds the OVERALL CLUSTER report, all offices in one list with a single institution wide TOTAL.
                        // Only offices with at least one respondent count toward that average.
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

                            // Combines each comment's primary topic with its extra topics so the ranking counts every mention.
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

                                    // Both the live and PDF Recent Submissions tables read this same array.
                                    const ids = (recentRows || []).map(r => r.id);
                                    const buildRecentSubmissions = (extraTopicsMap) => (recentRows || []).map(r => ({
                                        officeName: r.office_name,
                                        cluster: r.cluster_name || 'Unassigned Cluster',
                                        // Shows nothing when there is no AI result instead of faking a default.
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

// Lets the logged-in admin upload a custom profile photo.
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
            // Keeps the session in sync so the new photo shows up right away.
            req.adminSession.user.photo_url = url;
            req.adminSession.admin.photo_url = url;
            res.json({ success: true, url });
        });
    });
});

// Lets the logged-in admin change their own password.
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
// Cluster and office analytics print view, computed from survey_responses.
app.get('/print', ensureAdminAuth, noCache, (req, res) => {
    const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
    const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();
    const hasPeriodFilter = !!selectedPeriod;

    const periodCol = periodNormExpr('s.period_year_quarter');
    // Always excludes superseded rows.
    const dateWhere = hasPeriodFilter ? ` WHERE ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` WHERE s.canonical_status = 'canonical' `;
    const dateWhereAnd = hasPeriodFilter ? ` AND ${periodCol} = ? AND s.canonical_status = 'canonical' ` : ` AND s.canonical_status = 'canonical' `;
    const dateParams = hasPeriodFilter ? [normalizePeriodStr(selectedPeriod)] : [];

    // Matches the "INTERPRETATION OF RESULTS" legend printed on this same page.
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
                            // Full spelled-out name, same as every other report.
                            clustersMap[cName].offices.push({ name: row.report_name, score: cell.score, interpretation: cell.interpretation, respondents: row.office_volume || 0 });
                        });

                        // Builds the PER CLUSTER report with each cluster's own TOTAL row.
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

// Powers the institution wide /report page and the per-cluster office drill down.
// respondentId scopes the whole report to a single client's own answers instead.
app.post('/api/report-data', ensureAdminAuth, (req, res) => {
    const { office, officeId, cluster, periodCovered, respondentId, serviceAvailed } = req.body;

    const conditions = [];
    const queryParams = [];

    if (respondentId) {
        // Single row lookup by id, not filtered by canonical status so a superseded row can still be pulled up.
        conditions.push('s.id = ?');
        queryParams.push(respondentId);
    } else {
        // Aggregate report totals, canonical rows only so a superseded submission never inflates them.
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
            // Uses the normalized period comparison, same as /dashboard and /report.
            conditions.push(`${periodNormExpr('s.period_year_quarter')} = ?`);
            queryParams.push(normalizePeriodStr(periodCovered));
        }
        // Narrows to one service when given, otherwise keeps office-wide totals across every service.
        if (serviceAvailed && serviceAvailed !== 'ALL SERVICES') {
            conditions.push('s.service_availed = ?');
            queryParams.push(serviceAvailed);
        }
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    // Rating bucket counts for SQD 0 and SQD 1-8, powering the SQD Results report table.
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
        // Filters out blank or N/A style comments so the report only lists comments someone actually wrote.
        // s.id is selected so extra topics can be attached below, then stripped back out before sending.
        const commentsQuery = `SELECT s.id, s.comments, ${REPORT_SENTIMENT_SQL} AS sentiment, ${REPORT_TOPIC_SQL} AS topic FROM survey_responses s LEFT JOIN offices o ON s.office_id = o.id WHERE ${HAS_REAL_COMMENT_SQL}${commentsWhere}`;

        db.query(commentsQuery, queryParams, (err, commentsResult) => {
            // Final check before a comment goes on the report, re-checking the text itself and masking any profanity.
            const kept = [];
            for (const row of (commentsResult || [])) {
                const verdict = prepareReportComment(row.comments);
                if (!verdict.include) continue;
                kept.push(Object.assign({}, row, {
                    comments: verdict.text,
                    // Lets a view flag a masked row if it wants to, though the printed templates don't use it.
                    wasMasked: verdict.wasMasked
                }));
            }

            // The report's "Submitted" date, formatted in the display timezone.
            const stats = results[0] || {};
            stats.response_date = formatZonedDateLong(stats.response_at);
            delete stats.response_at;

            // Attaches each comment's extra topics so a report shows all of them, not just the primary one.
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

// Per-office SQD rating breakdown for every office in a cluster, one row per office instead of one combined total.
app.post('/api/report-data-by-cluster', ensureAdminAuth, (req, res) => {
    const { cluster, periodCovered } = req.body;
    if (!cluster) return res.status(400).json({ error: 'cluster is required' });

    // Uses the normalized period comparison, kept consistent with the other report routes.
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

// Topic Badge Color Formula (topicBadgeClassFor) now lives in
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
        
        // Excludes rows still waiting on AI analysis, they show up once it finishes.
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
            // Fetches extra topics for every row in one query instead of one per row.
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

                    // A NULL topic or sentiment means the comment was blank or a placeholder, so it shows as No feedback.
                    const hasFeedback = row.topic !== null && row.topic !== undefined;

                    // Uses the admin override when present, otherwise the AI's own value.
                    const effectiveTopic = hasFeedback ? (row.topic_override || row.topic) : null;
                    const effectiveSentimentRaw = row.sentiment_override || (hasFeedback ? (row.sentiment || 'Neutral') : null);
                    const badgeClass = hasFeedback ? topicBadgeClassFor(effectiveTopic) : 'bg-no-feedback';

                    // Masks profanity for display only, the stored comment itself is never rewritten.
                    const displayComments = row.comments ? maskProfanity(row.comments).text : '';

                    const sentimentValue = hasFeedback ? effectiveSentimentRaw : 'No feedback';
                    const sentimentLower = sentimentValue.toLowerCase();
                    let sentimentClass = 'bg-sentiment-neutral';
                    if (!hasFeedback) sentimentClass = 'bg-sentiment-none';
                    else if (sentimentLower.includes('positive')) sentimentClass = 'bg-sentiment-positive';
                    else if (sentimentLower.includes('negative')) sentimentClass = 'bg-sentiment-negative';

                    // Any topics beyond the primary, each rendered as its own small badge.
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

// Full answers for one survey response, powers the View Result button on /survey-records.
// Any logged-in admin can view any respondent's answers here.
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
        // Applies the same masking as the survey-records table behind this modal.
        if (survey.comments) survey.comments = maskProfanity(survey.comments).text;
        const hasFeedback = survey.topic !== null && survey.topic !== undefined;
        const aiSplit = hasFeedback ? splitTopic(survey.topic) : { topic: null, subtopic: null };
        survey.effectiveSentiment = survey.sentiment_override || (hasFeedback ? (survey.sentiment || 'Neutral') : null);
        survey.effectiveTopic = survey.topic_override || aiSplit.topic;
        survey.effectiveSubtopic = survey.subtopic_override || aiSplit.subtopic;

        // Any topics beyond the primary, split into topic and subtopic the same way as above.
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

// Lets an admin correct the AI's sentiment, topic, and subtopic on one survey response.
// The comment text itself is never editable here. Extra topics beyond the primary
// are simply replaced outright with whatever the request sends.
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
        // affectedRows can be 0 either because the id doesn't exist or the row already had these values, so check existence too.
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
// Lists registered client accounts, one row per client_accounts row regardless of survey activity.
// Only shows name, email, account type, and registration date. Everything else stays on /survey-records.
const ACCOUNT_LIST_LIMIT = 500;

app.get('/user-accounts', ensureAdminAuth, noCache, (req, res) => {
    // Newest registration first, the toolbar's sort controls reorder these rows in the browser.
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

    // Counted over the whole table so the tiles stay accurate past ACCOUNT_LIST_LIMIT.
    // The CSPC check matches both institutional domains at the end of the address only.
    // "Registered today" uses a boundary from the display timezone instead of MySQL's CURDATE().
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

            // Registration date and time are resolved in the display timezone, not the server's own.
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
                    // Only allows http(s) URLs through since this value goes straight into an img src.
                    photoUrl: /^https?:\/\//i.test(String(row.google_photo_url || '').trim())
                        ? String(row.google_photo_url).trim()
                        : null,
                    submissionCount: Number(row.submission_count) || 0,
                    // Precomputed sort keys so the browser sorts numbers and lowercased strings, not printed dates.
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
                    // Personal is the complement of CSPC accounts so the two tiles can never disagree with the total.
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
// The notification feed is just survey_responses, there are no separate notification rows.
// Unseen is a per-admin watermark compared against each survey's created_at.
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

            // Ordered by when the row arrived, but displays when the client actually submitted.
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

                    // Counted separately so the badge stays accurate past the 20 the panel lists.
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

// Moves this admin's watermark to now, marking the bell as looked at.
// Each admin has their own watermark, so clearing one never affects another.
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

            // Services grouped by office_id, powers the per-office Services modal below.
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

// Small helpers so /offices and /manage-admins redirects share the same success/error query param convention.
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

// Soft delete lang, is_archived flag lang ang binabago para hindi mawala ang historical data.
// Kasama sa archive ang lahat ng offices sa ilalim ng cluster na ito.
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
    // Login for the office approval panel, optional at creation. A super admin can set it later via /offices/edit.
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    db.query('INSERT INTO offices (cluster_name, office_name, head_director, email_address, password) VALUES (?, ?, ?, ?, ?)',
    [cluster_name, office_name, head_director || 'Not Assigned', email_address, passwordHash], (err, result) => {
        if (err) { console.error("❌ Error adding office:", err); return res.redirect(officesErr(GENERIC_SAVE_ERROR)); }
        loadOfficeNameCache();

        // service_name comes in as a single string or an array depending on how many rows were filled.
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
// SERVICES AVAILED, per-office CRUD, powers the client survey's Service Availed dropdown
// ==========================================
const VALID_SERVICE_AVAILABILITY = ['daily', 'weekly', 'monthly', 'yearly'];
// Normalizes the Availability dropdown's value to a valid enum, defaulting to daily.
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
    // A blank password field on edit leaves the existing login untouched.
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

// Soft delete lang, is_archived flag lang ang binabago para hindi mawala ang historical data.
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

// Role isn't exposed in the Manage Admins UI, every admin created here defaults to Admin.
// Promoting someone to Super Admin is a direct database action, not part of the UI.
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

    // Password is optional on edit, leaves the existing hash alone when blank.
    // Role is never touched here since it isn't part of this form.
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

// Hard delete. admin_logs.admin_id references this row with ON DELETE SET NULL, so login history is kept.
app.post('/admins/delete/:id', ensureAdminAuth, ensureSuperAdmin, (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (req.adminSession.user.id === targetId) {
        // Blocks deleting your own account mid session, which would leave you locked in with no valid admin row.
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

// Soft delete lang, is_archived flag lang ang binabago para hindi mawala ang historical data.
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

// Adds a new Period Covered option to the dashboard filter dropdown.
// Only extends the filter's choices, doesn't change how new submissions get tagged.
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
    // Uses the normalized period comparison, kept consistent with the other report routes.
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
            // Logs a failed query instead of silently emptying the Select Office dropdown.
            if (err) console.error('❌ [getOfficesForCluster] query failed:', err.message);
            callback(err ? [] : rows);
        }
    );
}

// Every service offered by those offices, for the Select Service filter beside Select Office.
// Combines the office's service list with service names respondents actually picked, so a
// renamed or removed service still shows up here and stays reportable.
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
// Single dynamic cluster stats page, driven by the clusters table.
// A newly added cluster automatically gets its own page here.
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
    // Lists all non-archived offices, not just ones with survey rows, so an empty office still shows blank instead of hidden.
    // Chart buckets are keyed by office id, not name, since two offices can share a name under different clusters.
    db.query('SELECT id, cluster_name, office_name FROM offices WHERE is_archived = 0 ORDER BY office_name, id', (err, officeRows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const clustersSet = new Set();
        officeRows.forEach(o => { if (o.cluster_name) clustersSet.add(o.cluster_name); });
        const clusterList = Array.from(clustersSet).sort();

        // officeList and officeCluster are display labels for the chart legend.
        // officeIndexById resolves a row to its bucket index so same-named offices never collide.
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

        // Keyed by the exact canonical period strings so switching periods reflects only what's actually in the DB.
        getMergedPeriodOptions((periodOptions) => {
        const chartData = {};
        const periods = periodOptions.map(o => o.value);

        periods.forEach(p => {
            chartData[p] = {
                overall: [0, 0],
                clusterSat: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                clusterResp: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                // Counts SQD answers only, excluding N/A, so an all N/A office reports as no ratings yet, not 0%.
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

        // Matches on a normalized form so differently spelled period rows still land in the right bucket.
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

            // Excludes the N/A option from both the answerable and agree counts so it never reads as 0% dissatisfaction.
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
            // null means there are respondents but every one marked N/A, distinct from 0 (no respondents at all).
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