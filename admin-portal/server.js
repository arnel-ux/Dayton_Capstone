require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2');
const { spawn } = require('child_process'); // 🔥 ADDED THIS LINE
const { promisify } = require('util');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const app = express();
const port = 3000;

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

// ==========================================
// SESSION & PASSPORT (Google OAuth for clients)
// ==========================================
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
}, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    if (!email) return done(null, false);
    return done(null, { email, name: profile.displayName });
}));

// Resolves the signed-in client's email from either Google OAuth (passport) or the
// unified email/password login form (req.session.clientEmail) — the two ways a
// registered client can end up authenticated.
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
    return res.redirect(302, '/login');
}

// Ensures only a logged-in admin (set at /auth-login) can view/use admin pages & CRUD routes.
// Same null/undefined/destroyed-session handling as ensureClientAuth above.
function ensureAdminAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please log in as admin first." });
    }
    return res.redirect(302, '/login');
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
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',      
    password: '',      
    database: 'cqa_db' 
});

db.connect((err) => {
    if (err) {
        console.error('❌ Error connecting to MySQL:', err);
        return;
    }
    console.log('✅ Connected to cqa_db database successfully!');
});

// Promise wrapper around db.query — used by the offline-sync route so it can
// `await` each step (duplicate check → AI analysis → insert) in sequence.
const dbQuery = promisify(db.query).bind(db);

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
        imageUrl: 'https://spims.cspc.edu.ph/assets/img/background.jpg'
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

// Runs a comment through ai_scripts/analyze.py and resolves with
// { sentiment, topic }. Used by both the live /submit-survey route (fire-and-forget,
// applied via an UPDATE after the fact) and the /sync-surveys batch route
// (awaited before the row is even inserted). Never rejects — a missing/blank
// comment resolves with nulls (so DB defaults apply), and any script failure
// resolves with the "Neutral" / "General Feedback" fallback instead of
// throwing, so one bad comment can never crash a batch sync.
//
// `offline` should be true for comments coming from the /sync-surveys queue
// (submitted while the client was offline, synced later in bulk) — analyze.py
// takes a lightweight local heuristic fast path for those instead of loading
// its transformer models, since nobody is waiting on a live response.
function analyzeComment(comment, offline = false) {
    return new Promise((resolve) => {
        if (!comment || !String(comment).trim()) {
            return resolve({ sentiment: null, topic: null });
        }

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        try {
            const pythonScriptPath = path.join(__dirname, 'ai_scripts', 'analyze.py');
            const pythonProcess = spawn('python', [pythonScriptPath]);

            pythonProcess.on('error', (err) => {
                console.error("❌ [AI] Could not start Python. Is it installed?", err);
                finish({ sentiment: 'Neutral', topic: 'General Feedback' });
            });

            pythonProcess.stdin.write(JSON.stringify({ comment: String(comment), offline: !!offline }));
            pythonProcess.stdin.end();

            let aiOutput = '';
            pythonProcess.stdout.on('data', (chunk) => { aiOutput += chunk.toString(); });
            pythonProcess.stderr.on('data', (chunk) => { process.stdout.write(chunk.toString()); });

            pythonProcess.on('close', () => {
                try {
                    const jsonMatch = aiOutput.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const aiResult = JSON.parse(jsonMatch[0]);
                        if (aiResult.sentiment && aiResult.topic) {
                            return finish({ sentiment: aiResult.sentiment, topic: aiResult.topic });
                        }
                    }
                    console.error("❌ [AI Parsing Error]: Could not find JSON.\nRaw Output:", aiOutput);
                    finish({ sentiment: 'Neutral', topic: 'General Feedback' });
                } catch (e) {
                    console.error("❌ [AI Execution Error]:", e.message);
                    finish({ sentiment: 'Neutral', topic: 'General Feedback' });
                }
            });
        } catch (err) {
            console.error("❌ [AI] Unexpected error launching analysis:", err);
            finish({ sentiment: 'Neutral', topic: 'General Feedback' });
        }
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
const sqdStatementFor = (label) => {
    const idx = parseInt(String(label).replace(/[^0-9]/g, ''), 10);
    return Number.isInteger(idx) && SQD_STATEMENTS[idx] ? `${label}. ${SQD_STATEMENTS[idx]}` : label;
};

// ==========================================
// SQD Score Formula (Citizen's Charter / ARTA)
// ==========================================
// Overall Score = (# 'Strongly Agree' + # 'Agree') / (Total Respondents - # 'N/A') * 100
// sqd columns store 5=Strongly Agree, 4=Agree, 3=Neutral, 2=Disagree, 1=Strongly Disagree, 0=N/A.
// This is purely a numeric-rating computation and never touches the AI sentiment/topic
// pipeline (see analyzeComment) — the two scores are computed independently of each other.
function sqdScoreExpr(cols) {
    const agreeSum = cols.map(c => `SUM(CASE WHEN ${c} IN (4,5) THEN 1 ELSE 0 END)`).join(' + ');
    const naSum = cols.map(c => `SUM(CASE WHEN ${c} = 0 THEN 1 ELSE 0 END)`).join(' + ');
    const answerable = `(COUNT(s.id) * ${cols.length} - (${naSum}))`;
    return `IFNULL(ROUND((${agreeSum}) / NULLIF(${answerable}, 0) * 100, 2), 0)`;
}
const ALL_SQD_COLS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `s.sqd${i}`);

// ==========================================
// PERIOD COVERED HELPERS
// ==========================================
// Submission tagging stays dynamic (server date -> period string) since the
// client can't tamper with it. The filter dropdown, however, is a fixed,
// known set of periods -- kept as a static list rather than derived from
// whatever happens to be in the database, to avoid legacy/inconsistent
// strings leaking into the UI.
function getPeriodCovered(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth(); // 0 = Jan ... 11 = Dec
    return month <= 5 ? `Jan to June ${year}` : `July to Dec ${year}`;
}

const PERIOD_COVERED_OPTIONS = [
    { value: 'Jan to June 2026', label: 'Jan to June 2026' },
    { value: 'July to Dec 2026', label: 'July to Dec 2026' },
    { value: 'Jan to June 2027', label: 'Jan to June 2027' },
    { value: 'July to Dec 2027', label: 'July to Dec 2027' }
];

// Sends the client a proof-of-completion receipt of exactly what they just
// submitted. Fire-and-forget: called AFTER the client already got its
// success response, so a slow or failed send can never hold up the survey.
function sendSurveyReceiptEmail(toEmail, receipt) {
    if (!mailTransporter || !toEmail || toEmail === 'Not Specified') return;

    const sqdRowsHtml = receipt.sqd.map((r, idx) => `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};font-size:13px;color:#334155;">${sqdStatementFor(r.label)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};text-align:center;font-weight:700;font-size:13px;color:#4f46e5;width:70px;">${r.value === null ? 'N/A' : (r.value === 0 ? 'N/A' : r.value + ' / 5')}</td>
        </tr>`).join('');

    const detailRow = (label, value) => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:13px;font-weight:700;color:#64748b;width:42%;vertical-align:top;">${label}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eef1f6;font-size:14px;font-weight:600;color:#0f172a;vertical-align:top;">${value}</td>
        </tr>`;

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
                                    <td class="receipt-header" style="background:#4f46e5;padding:32px 28px;text-align:center;">
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
                                        <span style="display:block;font-size:16px;font-weight:700;color:#4f46e5;font-family:'Courier New',monospace;letter-spacing:.03em;">CSM-${receipt.surveyResponseId}</span>
                                    </td>
                                </tr>
                            </table>

                            <!-- Body -->
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td class="receipt-body" style="padding:28px;color:#1e293b;">
                                        <p style="margin:0 0 8px;font-size:15px;">Hi <strong>${receipt.name}</strong>,</p>
                                        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">Thank you for completing the CSM survey. This email is your official, system-generated proof of submission — no further action or signature is required.</p>

                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                            ${detailRow('Name', receipt.name)}
                                            ${detailRow('Office Visited', receipt.officeName)}
                                            ${detailRow('Service Availed', receipt.serviceAvailed)}
                                            ${detailRow('Date Submitted', receipt.submittedAt)}
                                            ${detailRow('Cluster', receipt.clusterName || 'N/A')}
                                            ${detailRow('Client Type', receipt.clientType)}
                                        </table>

                                        <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.03em;">Service Quality Dimension Ratings</h3>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                                            ${sqdRowsHtml}
                                        </table>

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);`;

// One row per Google/registered-client account. Holds the demographic details
// (region, age, gender) locked-in from that account's FIRST survey submission,
// plus lets registered clients log in via the regular /login form.
const createClientAccountsTableQuery = `
CREATE TABLE IF NOT EXISTS client_accounts (
    email VARCHAR(255) PRIMARY KEY,
    respondent_name VARCHAR(255) NULL,
    password VARCHAR(255) NULL,
    region VARCHAR(100) NULL,
    age VARCHAR(50) NULL,
    gender VARCHAR(50) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;

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

                // Services table (per office) — powers the dependent "Service Availed" dropdown
                db.query(createServicesTableQuery, (err) => {
                    if (err) console.error("❌ Error creating services table:", err);
                    else console.log('✅ services table verified/created successfully!');
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
                            // 1 Google account = 1 survey per office, enforced at the DB level too
                            db.query("ALTER TABLE survey_responses ADD UNIQUE KEY unique_office_google_email (office_id, google_email)", () => {});
                        });

                        // Pinakahuli ang Client Profiles
                        db.query(createClientProfilesTableQuery, (err) => {
                            if (err) console.error("❌ Error creating client_profiles table:", err);
                            else console.log('✅ client_profiles table verified/created successfully!');
                        });

                        // Client accounts (locked demographics + unified login lookup)
                        db.query(createClientAccountsTableQuery, (err) => {
                            if (err) console.error("❌ Error creating client_accounts table:", err);
                            else console.log('✅ client_accounts table verified/created successfully!');
                            // Older deployments created this table before the `password` column
                            // existed (Google sign-in used to log clients in directly, no local
                            // password) — add it now so existing rows can be upgraded in place.
                            db.query("ALTER TABLE client_accounts ADD COLUMN password VARCHAR(255) NULL", () => {});
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

// ==========================================
// CONTENT MANAGEMENT — landing page (index.ejs) sections
// ==========================================
const contentUploadDir = path.join(__dirname, 'public', 'images', 'uploads');
fs.mkdirSync(contentUploadDir, { recursive: true });

const contentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, contentUploadDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${req.params.section}-${req.params.field}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)) {
            return cb(new Error('Only PNG, JPG, WebP, or SVG images are allowed.'));
        }
        cb(null, true);
    }
});

// Returns the full content object so the CMS can populate its form fields
// with whatever is actually saved (instead of the hardcoded defaults baked
// into content-management.ejs).
app.get('/api/content', ensureAdminAuth, noCache, (req, res) => {
    try {
        const landingContent = loadLandingContent();
        res.json({ success: true, content: landingContent });
    } catch (err) {
        console.error('❌ Error loading data/landing-data.json:', err);
        res.status(500).json({ success: false, message: 'Could not load landing page content.' });
    }
});

// Saves one section (branding / hero / about / org / services / footer) at a
// time — matches how the CMS's tabs each submit their own form independently.
app.post('/api/content/:section', ensureAdminAuth, (req, res) => {
    const { section } = req.params;
    if (!LANDING_SECTION_KEYS.includes(section)) {
        return res.status(400).json({ success: false, message: 'Unknown content section.' });
    }

    // Whitelist to the known fields for this section only — never trust the
    // request body's own key set, so an admin (or a bug in the CMS JS) can't
    // smuggle arbitrary keys into the stored JSON.
    const allowedFields = Object.keys(DEFAULT_LANDING_CONTENT[section]);
    const fields = {};
    for (const key of allowedFields) {
        if (typeof req.body[key] === 'string') {
            fields[key] = req.body[key].slice(0, 5000); // generous cap, still bounded
        }
    }

    try {
        saveLandingSection(section, fields);
        console.log(`✅ Saved "${section}" section to data/landing-data.json`);
        res.json({ success: true, section, fields });
    } catch (err) {
        console.error(`❌ Error saving landing content section "${section}" to landing-data.json:`, err);
        res.status(500).json({ success: false, message: 'Could not save changes.' });
    }
});

// Uploads a single image for one field (e.g. section=hero, field=imageUrl),
// saves the resulting public URL into that field immediately, and returns it
// so the CMS can preview it without waiting for a separate "Save Changes" click.
app.post('/api/content/:section/upload/:field', ensureAdminAuth, (req, res) => {
    const { section, field } = req.params;
    if (!LANDING_SECTION_KEYS.includes(section) || !(field in DEFAULT_LANDING_CONTENT[section])) {
        return res.status(400).json({ success: false, message: 'Unknown content field.' });
    }

    contentUpload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'No image file received.' });

        const url = `/images/uploads/${req.file.filename}`;
        try {
            saveLandingSection(section, { [field]: url });
            console.log(`✅ Saved uploaded image URL for ${section}.${field} to data/landing-data.json`);
            res.json({ success: true, url });
        } catch (writeErr) {
            console.error('❌ Error saving uploaded image URL to landing-data.json:', writeErr);
            res.status(500).json({ success: false, message: 'Image uploaded but could not be saved.' });
        }
    });
});
// Landing on /login — including via the Back button — is treated as an explicit
// logout: any active session (admin or client) is destroyed immediately, before
// the form even renders. This is what closes the Forward-button hole: with the
// session gone, a Forward navigation back to /dashboard has nothing valid for
// ensureAdminAuth to find, so it bounces straight back here instead of letting
// the user in.
app.get('/login', noCache, (req, res) => {
    const hasActiveSession = !!(req.session && (req.session.user || req.session.clientEmail))
        || (req.isAuthenticated && req.isAuthenticated());

    if (!hasActiveSession) {
        return res.render('login');
    }

    req.logout(() => {
        req.session.destroy((err) => {
            if (err) console.error('❌ Error destroying session on /login:', err);
            res.clearCookie('connect.sid', { path: '/' });
            res.render('login');
        });
    });
});

// ==========================================
// UNIFIED LOGIN (Admin OR registered Client)
// ==========================================
// The main /login form posts here. Admin credentials still work as before;
// additionally, any email already known in client_accounts (i.e. someone who has
// signed in with Google and submitted at least one survey) can log back in from
// this same form instead of clicking "Sign in with Google" again.
app.post('/auth-login', (req, res) => {
    const { username, password } = req.body;

    if (username === 'admin' && password === 'admin123') {
        req.session.user = { username: 'admin', role: 'admin' };
        return res.redirect('/dashboard');
    } else if (username === 'admin') {
        // Wrong admin password — clients must use the "Sign in with Google" button instead
        return res.redirect('/login?error=' + encodeURIComponent('Invalid admin credentials!'));
    }

    const emailInput = String(username || '').trim().toLowerCase();
    if (!emailInput || !password) {
        return res.redirect('/login?error=' + encodeURIComponent('Please enter both your email and password.'));
    }

    db.query('SELECT email, password FROM client_accounts WHERE email = ? LIMIT 1', [emailInput], async (err, rows) => {
        if (err) {
            return res.redirect('/login?error=' + encodeURIComponent('Server error. Please try again.'));
        }
        if (!rows || rows.length === 0) {
            return res.redirect('/login?error=' + encodeURIComponent('No account found for that email. Please register using the "Sign in with Google" button first.'));
        }

        const account = rows[0];
        if (!account.password) {
            return res.redirect('/login?error=' + encodeURIComponent('This account has no password set yet. Please sign in with Google once to create one.'));
        }

        const passwordMatches = await bcrypt.compare(password, account.password);
        if (!passwordMatches) {
            return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
        }

        req.session.clientEmail = account.email;
        return res.redirect('/client-survey');
    });
});

// Same "landing here = logout" treatment as /login above, for the client's
// dedicated Google sign-in entry point.
app.get('/client-login', noCache, (req, res) => {
    const hasActiveSession = !!(req.session && req.session.clientEmail)
        || (req.isAuthenticated && req.isAuthenticated());

    if (!hasActiveSession) {
        return res.render('client-login');
    }

    req.logout(() => {
        req.session.destroy((err) => {
            if (err) console.error('❌ Error destroying session on /client-login:', err);
            res.clearCookie('connect.sid', { path: '/' });
            res.render('client-login');
        });
    });
});

// ==========================================
// GOOGLE OAUTH ROUTES (Client login)
// ==========================================
// `prompt: 'select_account'` forces Google's account chooser on every click instead of
// silently re-authenticating whichever Google account is already signed in on this device.
app.get('/auth/google', passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
}));

// Google handles both registration AND recurring login for clients:
//   - New email  -> stash the Google name/email in session and send them to set a local
//                   password (they are NOT logged in yet).
//   - Existing email with a password already set -> log them straight in with Google,
//     no need to type the password again.
//   - Existing email with no password (legacy accounts created before this flow existed)
//     -> treat like a new user and have them set a password to finish the upgrade.
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
        const email = req.user && req.user.email;
        const name = req.user && req.user.name;

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
                if (existingAccount && existingAccount.password) {
                    req.session.clientEmail = existingAccount.email;
                    return res.redirect('/client-survey');
                }

                req.session.pendingGoogleUser = { email, name };
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
        email: pending.email
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

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query(
            `INSERT INTO client_accounts (email, respondent_name, password)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name), password = VALUES(password)`,
            [pending.email, pending.name || null, hashedPassword],
            (err) => {
                if (err) {
                    return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Could not save your account. Please try again.'));
                }
                req.session.clientEmail = pending.email;
                delete req.session.pendingGoogleUser;
                return res.redirect('/client-survey');
            }
        );
    } catch (e) {
        return res.redirect('/complete-google-registration?error=' + encodeURIComponent('Server error. Please try again.'));
    }
});

// Full logout for BOTH admin and client sessions: unhooks passport (if a Google
// session is active), destroys the server-side session record entirely (not just
// nulling fields on it), clears the session cookie from the browser, stamps the
// response so it can never be cached, and hard-redirects (302) to /login — never
// a client-side route change, so there is nothing for the bfcache to preserve.
app.get('/logout', noCache, (req, res) => {
    req.logout(() => {
        req.session.destroy((err) => {
            if (err) console.error('❌ Error destroying session on logout:', err);
            res.clearCookie('connect.sid', { path: '/' });
            res.redirect(302, '/login');
        });
    });
});

app.get('/client-survey', ensureClientAuth, noCache, (req, res) => {
    const clientEmail = req.clientEmail;

    db.query('SELECT * FROM offices ORDER BY office_name ASC', (err, offices) => {
        if (err) return res.render('client-survey', { offices: [], clientEmail, takenOfficeIds: [], clientProfile: null, officeServices: {} });

        // All active services, grouped by office_id — powers the dependent
        // "Service Availed" dropdown (#serviceSelect) on the client side.
        db.query('SELECT office_id, service_name FROM services ORDER BY office_id, id', (errServices, serviceRows) => {
            const officeServices = {};
            if (!errServices && serviceRows) {
                serviceRows.forEach(row => {
                    if (!officeServices[row.office_id]) officeServices[row.office_id] = [];
                    officeServices[row.office_id].push(row.service_name);
                });
            }

            // Offices this account has already submitted a survey for — disabled in the dropdown
            db.query('SELECT office_id FROM survey_responses WHERE google_email = ?', [clientEmail], (err2, rows) => {
                const takenOfficeIds = err2 ? [] : rows.map(r => r.office_id);

                // Saved/locked demographics from this account's first-ever submission (if any)
                db.query('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [clientEmail], (err3, profileRows) => {
                    const clientProfile = (!err3 && profileRows && profileRows.length > 0) ? profileRows[0] : null;
                    res.render('client-survey', { offices, clientEmail, takenOfficeIds, clientProfile, officeServices });
                });
            });
        });
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
        'SELECT email, respondent_name, region, age, gender FROM client_accounts WHERE email = ? LIMIT 1',
        [req.clientEmail],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: 'Server error loading your profile.' });
            const profile = (rows && rows.length > 0) ? rows[0] : { email: req.clientEmail, respondent_name: null, region: null, age: null, gender: null };
            res.json({ success: true, profile });
        }
    );
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
// CLIENT ACCOUNT — History tab (past submitted surveys)
// ==========================================
app.get('/api/client-history', ensureClientAuth, noCache, (req, res) => {
    const query = `
        SELECT s.id, o.office_name, o.cluster_name, s.topic, s.sentiment,
               DATE_FORMAT(s.created_at, '%M %d, %Y') AS formatted_date
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        WHERE s.google_email = ?
        ORDER BY s.created_at DESC
    `;
    db.query(query, [req.clientEmail], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error loading your survey history.', history: [] });
        res.json({ success: true, history: rows || [] });
    });
});

// Full answers for one past submission — only returns the record if it belongs
// to the logged-in client, so nobody can peek at another respondent's answers.
app.get('/api/client-history/:id', ensureClientAuth, noCache, (req, res) => {
    const query = `
        SELECT s.id, s.topic, s.sentiment, s.region, s.cc1, s.cc2, s.cc3,
               s.sqd0, s.sqd1, s.sqd2, s.sqd3, s.sqd4, s.sqd5, s.sqd6, s.sqd7, s.sqd8,
               s.comments, s.period_year_quarter,
               DATE_FORMAT(s.created_at, '%M %d, %Y %h:%i %p') AS formatted_date,
               o.office_name, o.cluster_name,
               p.client_type, p.age, p.gender
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        LEFT JOIN client_profiles p ON p.survey_response_id = s.id
        WHERE s.id = ? AND s.google_email = ?
        LIMIT 1
    `;
    db.query(query, [req.params.id, req.clientEmail], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error loading this survey.' });
        if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'Survey not found.' });
        res.json({ success: true, survey: rows[0] });
    });
});

app.post('/submit-survey', ensureClientAuth, (req, res) => {
    console.log("📥 [Survey Payload Dumating]:", req.body);

    const googleEmail = req.clientEmail;

    // Region/Age/Sex are locked per account after the first-ever submission. Standard
    // HTML forms don't submit values for disabled fields, so req.body may simply be
    // missing region/age/gender on repeat visits — fetch the saved profile first and
    // let it win over (or fill in for) whatever the client actually posted.
    db.query('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [googleEmail], (profileLookupErr, profileLookupRows) => {
        const savedProfile = (!profileLookupErr && profileLookupRows && profileLookupRows.length > 0) ? profileLookupRows[0] : null;

        const {
            office_id, topic, cc1, cc2, cc3,
            sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, service_availed
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
        const finalAge = cleanStr(age) || 'Not Specified';
        const finalGender = cleanStr(gender) || 'Not Specified';
        const finalRegion = cleanStr(region) || 'Not Specified';
        const finalOfficeId = cleanInt(office_id);

        // 1 account can only submit ONE survey per office
        db.query(
            'SELECT id FROM survey_responses WHERE office_id = ? AND google_email = ? LIMIT 1',
            [finalOfficeId, googleEmail],
            (checkErr, existing) => {
                if (checkErr) {
                    console.error("❌ [Survey] Duplicate-check error:", checkErr);
                    return res.status(500).json({ success: false, message: "Database error while checking previous submissions." });
                }

                if (existing && existing.length > 0) {
                    return res.status(409).json({ success: false, message: "You have already evaluated this office. You cannot submit again." });
                }

                submitSurveyResponse();
            }
        );

    function submitSurveyResponse() {
    // DYNAMIC 6-MONTH PERIOD LOGIC (BASED ON CURRENT DATE OF SUBMISSION)
    const currentPeriod = getPeriodCovered();

    const insertQuery = `
        INSERT INTO survey_responses
        (office_id, respondent_name, topic, region, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, period_year_quarter, google_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
        finalOfficeId, finalName, cleanStr(topic) || 'General', finalRegion,
        cleanStr(cc1), cleanStr(cc2), cleanStr(cc3),
        cleanInt(sqd0), cleanInt(sqd1), cleanInt(sqd2), cleanInt(sqd3),
        cleanInt(sqd4), cleanInt(sqd5), cleanInt(sqd6), cleanInt(sqd7), cleanInt(sqd8),
        cleanStr(comments) || 'N/A', currentPeriod, googleEmail
    ];

    db.query(insertQuery, values, (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, message: "You have already evaluated this office. You cannot submit again." });
            }
            console.error("❌ [Survey] Database insertion error:", err);
            return res.status(500).json({ success: false, message: "Database insertion error: " + err.message });
        }

        const surveyResponseId = result.insertId;
        
        const insertProfileQuery = `
            INSERT INTO client_profiles (survey_response_id, respondent_name, client_type, age, gender, region, email)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const profileValues = [
            surveyResponseId, finalName, finalClientType, finalAge, finalGender, finalRegion, googleEmail
        ];

        db.query(insertProfileQuery, profileValues, (profileErr) => {
            if (profileErr) console.error("❌ [Client Profile] Error inserting profile:", profileErr);

            // Lock in this account's demographics on its first-ever submission. Region/age/gender
            // are deliberately left out of the UPDATE clause — once set, they never change again.
            const upsertAccountQuery = `
                INSERT INTO client_accounts (email, respondent_name, region, age, gender)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name)
            `;
            db.query(upsertAccountQuery, [googleEmail, finalName, finalRegion, finalAge, finalGender], (acctErr) => {
                if (acctErr) console.error("❌ [Client Account] Error upserting locked profile:", acctErr);
            });

            // 1. Instantly respond to the frontend so the client sees "Thank You" without waiting
            res.json({ success: true, message: "Survey recorded successfully!" });

            // 1b. Fire-and-forget proof-of-completion receipt to the client's Gmail.
            // Looks up the office's display name first since only office_id is on hand here.
            db.query('SELECT office_name, cluster_name FROM offices WHERE id = ? LIMIT 1', [finalOfficeId], (officeErr, officeRows) => {
                const office = (!officeErr && officeRows && officeRows[0]) ? officeRows[0] : null;
                sendSurveyReceiptEmail(googleEmail, {
                    name: finalName,
                    officeName: office ? office.office_name : 'Selected Office',
                    clusterName: office ? office.cluster_name : '',
                    clientType: finalClientType,
                    serviceAvailed: cleanStr(service_availed) || 'Not specified',
                    submittedAt: new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' }),
                    surveyResponseId,
                    sqd: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
                        label: 'SQD' + i,
                        value: cleanInt(req.body['sqd' + i])
                    }))
                });
            });

            // 2. 🔥 BACKGROUND AI PROCESS START 🔥
            // Fire-and-forget: the client already has its response, so this just
            // patches sentiment/topic onto the row once analyze.py finishes.
            if (comments && comments.trim() !== "") {
                analyzeComment(comments).then(({ sentiment, topic }) => {
                    if (sentiment && topic) {
                        const updateQuery = 'UPDATE survey_responses SET sentiment = ?, topic = ? WHERE id = ?';
                        db.query(updateQuery, [sentiment, topic, surveyResponseId]);
                        console.log(`✅ [AI Success] ID: ${surveyResponseId} | Sentiment: ${sentiment} | Topic: ${topic}`);
                    }
                });
            }
        });
    });
    }
    });
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
            const result = await syncOneSurvey(googleEmail, payload);
            results.push({ localId, ...result });
        } catch (err) {
            console.error("❌ [Sync] Unexpected error syncing survey:", err);
            results.push({ localId, success: false, message: "Unexpected server error while syncing this survey." });
        }
    }

    res.status(200).json({ success: true, results });
});

async function syncOneSurvey(googleEmail, body) {
    const cleanInt = (val) => (val !== undefined && val !== "" && val !== null && !isNaN(val)) ? parseInt(val, 10) : null;
    const cleanStr = (val) => (val !== undefined && val !== null && String(val).trim() !== "") ? String(val).trim() : null;

    const { office_id, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments } = body;

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
    const finalAge = cleanStr(age) || 'Not Specified';
    const finalGender = cleanStr(gender) || 'Not Specified';
    const finalRegion = cleanStr(region) || 'Not Specified';

    try {
        const existing = await dbQuery(
            'SELECT id FROM survey_responses WHERE office_id = ? AND google_email = ? LIMIT 1',
            [finalOfficeId, googleEmail]
        );
        if (existing && existing.length > 0) {
            return { success: false, message: "You have already evaluated this office. You cannot submit again." };
        }
    } catch (err) {
        console.error("❌ [Sync] Duplicate-check error:", err);
        return { success: false, message: "Database error while checking previous submissions." };
    }

    // Await the AI analysis BEFORE inserting — analyzeComment() never throws,
    // so a failed/unreachable analyze.py just yields the Neutral/General
    // Feedback fallback here instead of aborting this survey's sync.
    // offline=true routes this through analyze.py's fast local heuristic
    // path instead of loading the transformer models for every synced item.
    let sentiment = null;
    let topic = null;
    try {
        const aiResult = await analyzeComment(comments, true);
        sentiment = aiResult.sentiment;
        topic = aiResult.topic;
    } catch (err) {
        console.error("❌ [Sync] AI analysis threw unexpectedly, defaulting:", err);
        sentiment = 'Neutral';
        topic = 'General Feedback';
    }

    const currentPeriod = getPeriodCovered();

    let insertResult;
    try {
        insertResult = await dbQuery(
            `INSERT INTO survey_responses
             (office_id, respondent_name, topic, sentiment, region, cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments, period_year_quarter, google_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                finalOfficeId, finalName, topic || 'General', sentiment || 'Neutral', finalRegion,
                cleanStr(cc1), cleanStr(cc2), cleanStr(cc3),
                cleanInt(sqd0), cleanInt(sqd1), cleanInt(sqd2), cleanInt(sqd3),
                cleanInt(sqd4), cleanInt(sqd5), cleanInt(sqd6), cleanInt(sqd7), cleanInt(sqd8),
                cleanStr(comments) || 'N/A', currentPeriod, googleEmail
            ]
        );
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return { success: false, message: "You have already evaluated this office. You cannot submit again." };
        }
        console.error("❌ [Sync] Database insertion error:", err);
        return { success: false, message: "Database insertion error: " + err.message };
    }

    const surveyResponseId = insertResult.insertId;

    try {
        await dbQuery(
            `INSERT INTO client_profiles (survey_response_id, respondent_name, client_type, age, gender, region, email)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [surveyResponseId, finalName, finalClientType, finalAge, finalGender, finalRegion, googleEmail]
        );
    } catch (profileErr) {
        console.error("❌ [Sync][Client Profile] Error inserting profile:", profileErr);
    }

    try {
        await dbQuery(
            `INSERT INTO client_accounts (email, respondent_name, region, age, gender)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE respondent_name = VALUES(respondent_name)`,
            [googleEmail, finalName, finalRegion, finalAge, finalGender]
        );
    } catch (acctErr) {
        console.error("❌ [Sync][Client Account] Error upserting locked profile:", acctErr);
    }

    console.log(`✅ [Sync Success] ID: ${surveyResponseId} | Sentiment: ${sentiment || 'Neutral'} | Topic: ${topic || 'General'}`);

    return {
        success: true,
        message: "Survey synced and analyzed successfully!",
        surveyResponseId,
        sentiment: sentiment || 'Neutral',
        topic: topic || 'General'
    };
}

// ==========================================
// 2. Admin Dashboard Routes
// ==========================================
app.get('/dashboard', ensureAdminAuth, noCache, (req, res) => {
    // No periodCovered in the querystring at all -> default to the current
    // active period; an explicit "" (All Periods) is a deliberate user choice.
    const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
    const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();
    const hasPeriodFilter = !!selectedPeriod;

    const dateWhere = hasPeriodFilter ? ' WHERE s.period_year_quarter = ? ' : '';
    const dateWhereAnd = hasPeriodFilter ? ' AND s.period_year_quarter = ? ' : '';
    const dateParams = hasPeriodFilter ? [selectedPeriod] : [];

    db.query(`SELECT COUNT(*) AS total FROM survey_responses s${dateWhere}`, dateParams, (err, totalRes) => {
        const totalRespondents = (totalRes && totalRes[0]) ? totalRes[0].total : 0;

        const avgQuery = `
            SELECT ${sqdScoreExpr(ALL_SQD_COLS)} AS overall_avg
            FROM survey_responses s${dateWhere}
        `;
        db.query(avgQuery, dateParams, (err, avgRes) => {
            let overallAvgScore = 0;
            if (avgRes && avgRes[0] && avgRes[0].overall_avg) {
                overallAvgScore = parseFloat(avgRes[0].overall_avg);
            }

            let interpretation = "POOR";
            if(overallAvgScore >= 95) interpretation = "OUTSTANDING";
            else if(overallAvgScore >= 85) interpretation = "VERY SATISFACTORY";
            else if(overallAvgScore >= 75) interpretation = "SATISFACTORY";
            else if(overallAvgScore >= 60) interpretation = "FAIR";

            db.query('SELECT COUNT(*) AS total_offices FROM offices WHERE is_archived = 0', (err, officeCountRes) => {
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
                    const chartData = { labels: [], respondents: [], ratings: [] };
                    const clusterCards = [];
                    const colors = ['#4f46e5', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

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
                        });
                    }

                    const reportQuery = `
                        SELECT
                            o.cluster_name,
                            o.office_name,
                            ${sqdScoreExpr(ALL_SQD_COLS)} as office_score
                        FROM offices o
                        LEFT JOIN survey_responses s ON o.id = s.office_id${dateWhereAnd}
                        WHERE o.is_archived = 0
                        GROUP BY o.id, o.cluster_name, o.office_name
                        ORDER BY o.cluster_name, o.office_name
                    `;

                    db.query(reportQuery, dateParams, (err, reportRows) => {
                        const reportData = [];
                        const clustersMap = {};

                        if (reportRows) {
                            reportRows.forEach(row => {
                                const cName = row.cluster_name || 'Unassigned Cluster';
                                if (!clustersMap[cName]) {
                                    clustersMap[cName] = { clusterName: cName, offices: [] };
                                    reportData.push(clustersMap[cName]);
                                }

                                let score = parseFloat(row.office_score || 0);
                                let interp = "POOR";
                                if(score >= 95) interp = "OUTSTANDING";
                                else if(score >= 85) interp = "VERY SATISFACTORY";
                                else if(score >= 75) interp = "SATISFACTORY";
                                else if(score >= 60) interp = "FAIR";

                                clustersMap[cName].offices.push({ name: row.office_name, score: score.toFixed(2), interpretation: interp });
                            });
                        }

                        res.render('dashboard', {
                            dashboardData: { overallRating: overallAvgScore, overallLevel: interpretation, periodCoveredLabel: selectedPeriod || 'All Periods' },
                            chartData: chartData, clusterCards: clusterCards, satisfactionRate: overallAvgScore,
                            totalRespondents: totalRespondents, totalOffices: totalOffices, reportData: reportData,
                            periodOptions: PERIOD_COVERED_OPTIONS, selectedPeriod: selectedPeriod || ''
                        });
                    });
                });
            });
        });
    });
});

app.get('/profile', ensureAdminAuth, noCache, (req, res) => res.render('profile'));
app.get('/password', ensureAdminAuth, noCache, (req, res) => res.render('password'));
app.get('/print', ensureAdminAuth, noCache, (req, res) => res.render('print'));

// ==========================================
// DYNAMIC REPORTS ROUTE (Modified)
// ==========================================
app.get('/report', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT office_name FROM offices ORDER BY office_name ASC', (err, offices) => {
        res.render('report', { offices: offices || [] });
    });
});

// Powers both the institution-wide /report page (sends `office` by name) and the
// per-cluster "Select Office" drill-down (sends `cluster` + `officeId`, so "All
// Offices" on a cluster page still scopes to that cluster instead of the whole
// institution). `periodCovered` narrows further to one fixed date range.
app.post('/api/report-data', ensureAdminAuth, (req, res) => {
    const { office, officeId, cluster, periodCovered } = req.body;

    const conditions = [];
    const queryParams = [];

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
        conditions.push('s.period_year_quarter = ?');
        queryParams.push(periodCovered);
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const query = `
        SELECT
            COUNT(s.id) as total_respondents,
            ${sqdScoreExpr(['s.sqd1'])} as sqd1,
            ${sqdScoreExpr(['s.sqd2'])} as sqd2,
            ${sqdScoreExpr(['s.sqd3'])} as sqd3,
            ${sqdScoreExpr(['s.sqd4'])} as sqd4,
            ${sqdScoreExpr(['s.sqd5'])} as sqd5,
            ${sqdScoreExpr(['s.sqd6'])} as sqd6,
            ${sqdScoreExpr(['s.sqd7'])} as sqd7,
            ${sqdScoreExpr(['s.sqd8'])} as sqd8,
            ${sqdScoreExpr(ALL_SQD_COLS)} as overall_score
        FROM survey_responses s
        LEFT JOIN offices o ON s.office_id = o.id${whereClause}
    `;

    db.query(query, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        const commentsWhere = conditions.length
            ? ` AND ${conditions.join(' AND ')}`
            : '';
        const commentsQuery = `SELECT s.comments, s.sentiment, s.topic FROM survey_responses s LEFT JOIN offices o ON s.office_id = o.id WHERE s.comments IS NOT NULL AND TRIM(s.comments) != ''${commentsWhere}`;

        db.query(commentsQuery, queryParams, (err, commentsResult) => {
            res.json({
                stats: results[0] || {},
                comments: commentsResult || []
            });
        });
    });
});

// ==========================================
// DYNAMIC SURVEY RECORDS ROUTE
// ==========================================
app.get('/survey-records', ensureAdminAuth, noCache, (req, res) => {
    const ratingQuery = `
        SELECT o.cluster_name,
               ${sqdScoreExpr(ALL_SQD_COLS)} as rating
        FROM offices o
        LEFT JOIN survey_responses s ON o.id = s.office_id
        GROUP BY o.cluster_name
    `;
    db.query(ratingQuery, (err, ratingResults) => {
        const clusterRatings = {};
        if (ratingResults) {
            ratingResults.forEach(r => { clusterRatings[r.cluster_name || 'Other Offices'] = parseFloat(r.rating).toFixed(2); });
        }
        
        const recordsQuery = `
            SELECT s.respondent_name, s.topic, s.sentiment, s.comments, DATE_FORMAT(s.created_at, '%M %d, %Y') as formatted_date, o.cluster_name
            FROM survey_responses s JOIN offices o ON s.office_id = o.id ORDER BY o.cluster_name, s.created_at DESC
        `;
        db.query(recordsQuery, (err, results) => {
            const recordsByCluster = {};
            if (results) {
                results.forEach(row => {
                    const cluster = row.cluster_name || 'Other Offices';
                    if (!recordsByCluster[cluster]) recordsByCluster[cluster] = [];

                    let badgeClass = 'bg-general';
                    const topicLower = (row.topic || '').toLowerCase();
                    if (topicLower.includes('cr') || topicLower.includes('restroom')) badgeClass = 'bg-cr';
                    else if (topicLower.includes('aircon') || topicLower.includes('ac')) badgeClass = 'bg-aircon';
                    else if (topicLower.includes('facility') || topicLower.includes('equipment')) badgeClass = 'bg-facility';

                    const sentimentValue = row.sentiment || 'Neutral';
                    const sentimentLower = sentimentValue.toLowerCase();
                    let sentimentClass = 'bg-sentiment-neutral';
                    if (sentimentLower.includes('positive')) sentimentClass = 'bg-sentiment-positive';
                    else if (sentimentLower.includes('negative')) sentimentClass = 'bg-sentiment-negative';

                    recordsByCluster[cluster].push({ name: row.respondent_name || 'Anonymous', topic: row.topic || 'General', topicClass: badgeClass, sentiment: sentimentValue, sentimentClass, comments: row.comments || 'No comments provided.', date: row.formatted_date });
                });
            }
            res.render('survey-records', { recordsByCluster, clusterRatings });
        });
    });
});

// ==========================================
// 3. OFFICES & CLUSTERS CRUD ROUTES
// ==========================================
app.get('/offices', ensureAdminAuth, noCache, (req, res) => {
    db.query('SELECT * FROM clusters ORDER BY cluster_name ASC', (err, clusters) => {
        if (err) console.error("Error loading clusters:", err);
        db.query('SELECT * FROM offices ORDER BY cluster_name ASC, office_name ASC', (err, offices) => {
            if (err) console.error("Error loading offices:", err);
            res.render('offices', { 
                clustersData: clusters || [],
                officesData: offices || []
            });
        });
    });
});

app.post('/clusters/add', ensureAdminAuth, (req, res) => {
    const { cluster_name } = req.body;
    if (!cluster_name || cluster_name.trim() === "") {
        return res.redirect('/offices');
    }
    db.query('INSERT IGNORE INTO clusters (cluster_name) VALUES (?)', [cluster_name.trim()], (err) => {
        if (err) console.error("❌ Error adding cluster to database:", err);
        res.redirect('/offices');
    });
});

app.post('/clusters/edit', ensureAdminAuth, (req, res) => {
    const { id, cluster_name } = req.body;
    if (!cluster_name || cluster_name.trim() === "") {
        return res.redirect('/offices');
    }
    const newName = cluster_name.trim();
    db.query('SELECT cluster_name FROM clusters WHERE id = ?', [id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.redirect('/offices');
        const oldName = rows[0].cluster_name;
        db.query('UPDATE clusters SET cluster_name = ? WHERE id = ?', [newName, id], (err) => {
            if (err) { console.error("❌ Error updating cluster:", err); return res.redirect('/offices'); }
            db.query('UPDATE offices SET cluster_name = ? WHERE cluster_name = ?', [newName, oldName], (err) => {
                if (err) console.error("❌ Error cascading cluster rename to offices:", err);
                res.redirect('/offices');
            });
        });
    });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
app.post('/clusters/delete/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE clusters SET is_archived = 1 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

app.post('/clusters/restore/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE clusters SET is_archived = 0 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

app.post('/offices/add', ensureAdminAuth, (req, res) => {
    const { cluster_name, office_name, head_director, email_address } = req.body;
    db.query('INSERT INTO offices (cluster_name, office_name, head_director, email_address) VALUES (?, ?, ?, ?)', 
    [cluster_name, office_name, head_director || 'Not Assigned', email_address], (err, result) => { 
        if (err) console.error("❌ Error adding office:", err);
        res.redirect('/offices'); 
    });
});

app.post('/offices/edit', ensureAdminAuth, (req, res) => {
    const { id, cluster_name, office_name, head_director, email_address } = req.body;
    db.query('UPDATE offices SET cluster_name = ?, office_name = ?, head_director = ?, email_address = ? WHERE id = ?', 
    [cluster_name, office_name, head_director, email_address, id], (err, result) => { res.redirect('/offices'); });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
app.post('/offices/delete/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE offices SET is_archived = 1 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

app.post('/offices/restore/:id', ensureAdminAuth, (req, res) => {
    db.query('UPDATE offices SET is_archived = 0 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

// ==========================================
// 4. SURVEY SETTINGS CRUD
// ==========================================

app.get('/content-management', ensureAdminAuth, noCache, (req, res) => {
    // Same synchronous read as GET '/' — the admin must always see the exact
    // values currently live on the landing page, never the hardcoded defaults
    // that used to be baked into content-management.ejs.
    const landingContent = loadLandingContent();
    res.render('content-management', { landingContent });
});

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

// ==========================================
// 5. Helper Function para sa Cluster Queries
// ==========================================
function getClusterPerformanceData(clusterName, periodCovered, callback) {
    const periodJoinFilter = periodCovered ? ' AND s.period_year_quarter = ?' : '';
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
    const queryParams = periodCovered ? [periodCovered, clusterName] : [clusterName];

    db.query(clusterQuery, queryParams, (err, results) => {
        if (err) return callback(err, null);
        
        const formattedResults = results.map(row => {
            let shortLabel = row.label.split(' ').map(word => word[0]).join('').substring(0, 5);
            if (!shortLabel || shortLabel.length < 2) shortLabel = row.fullName.substring(0, 4).toUpperCase();
            return {
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
        'SELECT id, office_name FROM offices WHERE cluster_name = ? AND is_archived = 0 ORDER BY office_name',
        [clusterName],
        (err, rows) => callback(err ? [] : rows)
    );
}

// ==========================================
// 6. Cluster Routes
// ==========================================
function renderClusterPage(view, clusterName) {
    return (req, res) => {
        const hasQueryParam = typeof req.query.periodCovered !== 'undefined';
        const selectedPeriod = hasQueryParam ? req.query.periodCovered : getPeriodCovered();

        getClusterPerformanceData(clusterName, selectedPeriod, (err, data) => {
            getOfficesForCluster(clusterName, (officesInCluster) => {
                res.render(view, {
                    data: data || [],
                    periodOptions: PERIOD_COVERED_OPTIONS,
                    selectedPeriod: selectedPeriod || '',
                    officesInCluster: officesInCluster,
                    clusterName: clusterName
                });
            });
        });
    };
}

app.get('/cluster/office-of-the-president', ensureAdminAuth, noCache, renderClusterPage('cluster-op', 'Office of the President Cluster'));
app.get('/cluster/admin-finance', ensureAdminAuth, noCache, renderClusterPage('cluster-admin-finance', 'Administrative and Finance Cluster'));
app.get('/cluster/research-innovation', ensureAdminAuth, noCache, renderClusterPage('cluster-research', 'Research, Innovation and Collaboration Cluster'));
app.get('/cluster/academic', ensureAdminAuth, noCache, renderClusterPage('cluster-academic', 'Academic Cluster'));
app.get('/cluster/other-offices', ensureAdminAuth, noCache, renderClusterPage('cluster-other', 'Other Offices Cluster'));

// ==========================================
// DYNAMIC PUBLIC DASHBOARD API
// ==========================================
app.get('/api/public-dashboard', (req, res) => {
    const query = `
        SELECT 
            o.cluster_name, 
            o.office_name,
            s.sqd1, s.sqd2, s.sqd3, s.sqd4, s.sqd5, s.sqd6, s.sqd7, s.sqd8,
            s.cc1, s.period_year_quarter
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
    `;



    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const clustersSet = new Set();
        const officesSet = new Set();
        results.forEach(r => {
            if (r.cluster_name) clustersSet.add(r.cluster_name);
            if (r.office_name) officesSet.add(r.office_name);
        });
        const clusterList = Array.from(clustersSet).sort();
        const officeList = Array.from(officesSet).sort();

        // Ginawang 2 periods (p1 at p2) for 2026 based sa instruction mo
        const chartData = {};
        const periods = ['p1', 'p2']; 
        
        periods.forEach(p => {
            chartData[p] = {
                overall: [0, 0], 
                clusterSat: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                clusterResp: new Array(clusterList.length > 0 ? clusterList.length : 4).fill(0),
                officeSat: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                officeResp: new Array(officeList.length > 0 ? officeList.length : 7).fill(0),
                ccAware: [0, 0, 0], 
                ccOffice: new Array(officeList.length > 0 ? officeList.length : 7).fill(0)
            };
        });

        results.forEach(row => {
            // MAPPING LOGIC: Hinahati ang DB record papunta sa p1 o p2 para mag-reset at magsilbing archive ang past period
            const periodStr = row.period_year_quarter || '';
            const p = periodStr.includes('July to Dec') ? 'p2' : 'p1';

            const cIdx = clusterList.indexOf(row.cluster_name);
            const oIdx = officeList.indexOf(row.office_name);

            const sqdAvg = ((row.sqd1||0) + (row.sqd2||0) + (row.sqd3||0) + (row.sqd4||0) + (row.sqd5||0) + (row.sqd6||0) + (row.sqd7||0) + (row.sqd8||0)) / 8;
            const isSatisfied = sqdAvg >= 3.5; 

            if (isSatisfied) chartData[p].overall[0]++;
            else chartData[p].overall[1]++;

            if (cIdx !== -1) {
                chartData[p].clusterResp[cIdx]++;
                if (isSatisfied) chartData[p].clusterSat[cIdx]++;
            }

            if (oIdx !== -1) {
                chartData[p].officeResp[oIdx]++;
                if (isSatisfied) chartData[p].officeSat[oIdx]++;
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
            chartData[p].clusterSat = chartData[p].clusterSat.map((satCount, i) => {
                return chartData[p].clusterResp[i] > 0 ? Math.round((satCount / chartData[p].clusterResp[i]) * 100) : 0;
            });
            chartData[p].officeSat = chartData[p].officeSat.map((satCount, i) => {
                return chartData[p].officeResp[i] > 0 ? Math.round((satCount / chartData[p].officeResp[i]) * 100) : 0;
            });
            chartData[p].ccOffice = chartData[p].ccOffice.map((awareCount, i) => {
                return chartData[p].officeResp[i] > 0 ? Math.round((awareCount / chartData[p].officeResp[i]) * 100) : 0;
            });
        });

        res.json({
            chartData: chartData,
            clusterList: clusterList.length > 0 ? clusterList : undefined,
            officeList: officeList.length > 0 ? officeList : undefined
        });
    });
});

// ==========================================
// SERVER START
// ==========================================
app.listen(3000, '0.0.0.0', () => {
    console.log(`🚀 Server is running at http://localhost:${port}`);
});