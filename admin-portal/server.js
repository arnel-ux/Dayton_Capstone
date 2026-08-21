require('dotenv').config();

const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const { spawn } = require('child_process'); // 🔥 ADDED THIS LINE
const { promisify } = require('util');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
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

// Sends the client a proof-of-completion receipt of exactly what they just
// submitted. Fire-and-forget: called AFTER the client already got its
// success response, so a slow or failed send can never hold up the survey.
function sendSurveyReceiptEmail(toEmail, receipt) {
    if (!mailTransporter || !toEmail || toEmail === 'Not Specified') return;

    const sqdRowsHtml = receipt.sqd.map((r) => `
        <tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;">${r.label}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;text-align:center;font-weight:600;">${r.value === null ? 'N/A' : (r.value === 0 ? 'N/A' : r.value + ' / 5')}</td>
        </tr>`).join('');

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
            <div style="background:#2554c7;color:#fff;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
                <h2 style="margin:0;">Camarines Sur Polytechnic Colleges</h2>
                <p style="margin:4px 0 0;opacity:.9;">Client Satisfaction Measurement (CSM) Survey — Official Receipt</p>
            </div>
            <div style="border:1px solid #e2e8f0;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
                <p>Hi ${receipt.name},</p>
                <p>Thank you for completing the CSM survey. This email confirms your submission was received and serves as your proof of completion.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
                    <tr><td style="padding:6px 10px;font-weight:bold;width:40%;">Office Visited</td><td style="padding:6px 10px;">${receipt.officeName}</td></tr>
                    <tr><td style="padding:6px 10px;font-weight:bold;">Cluster</td><td style="padding:6px 10px;">${receipt.clusterName || 'N/A'}</td></tr>
                    <tr><td style="padding:6px 10px;font-weight:bold;">Client Type</td><td style="padding:6px 10px;">${receipt.clientType}</td></tr>
                    <tr><td style="padding:6px 10px;font-weight:bold;">Date Submitted</td><td style="padding:6px 10px;">${receipt.submittedAt}</td></tr>
                    <tr><td style="padding:6px 10px;font-weight:bold;">Reference No.</td><td style="padding:6px 10px;">CSM-${receipt.surveyResponseId}</td></tr>
                </table>
                <h4 style="margin-bottom:6px;">Service Quality Dimension Ratings</h4>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">${sqdRowsHtml}</table>
                <p style="margin-top:20px;font-size:12px;color:#64748b;">This is an automated message from the CSPC Center for Quality Assurance. If you did not take this survey, please disregard this email.</p>
            </div>
        </div>
    `;

    mailTransporter.sendMail({
        from: process.env.MAIL_FROM || `"CSPC Center for Quality Assurance" <${process.env.MAIL_USER}>`,
        to: toEmail,
        subject: `CSM Survey Receipt — ${receipt.officeName} (Ref: CSM-${receipt.surveyResponseId})`,
        html
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
    period_year_quarter VARCHAR(50) DEFAULT 'Jan - Jun 2026',
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
app.get('/', (req, res) => res.render('index'));
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
        if (err) return res.render('client-survey', { offices: [], clientEmail, takenOfficeIds: [], clientProfile: null });

        // Offices this account has already submitted a survey for — disabled in the dropdown
        db.query('SELECT office_id FROM survey_responses WHERE google_email = ?', [clientEmail], (err2, rows) => {
            const takenOfficeIds = err2 ? [] : rows.map(r => r.office_id);

            // Saved/locked demographics from this account's first-ever submission (if any)
            db.query('SELECT region, age, gender FROM client_accounts WHERE email = ? LIMIT 1', [clientEmail], (err3, profileRows) => {
                const clientProfile = (!err3 && profileRows && profileRows.length > 0) ? profileRows[0] : null;
                res.render('client-survey', { offices, clientEmail, takenOfficeIds, clientProfile });
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
            sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, comments
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
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth(); // 0 to 11
    const currentPeriod = currentMonth < 6 ? `Jan - Jun ${currentYear}` : `Jul - Dec ${currentYear}`;

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

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    const currentPeriod = currentMonth < 6 ? `Jan - Jun ${currentYear}` : `Jul - Dec ${currentYear}`;

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
// SEMESTER FILTER HELPERS
// ==========================================
// Survey submissions are auto-tagged with a period string like "Jan - Jun 2026"
// or "Jul - Dec 2026" (see submitSurveyResponse). These map 1:1 onto academic
// semesters, so we surface them as a single "Semester" dropdown everywhere
// instead of separate Start Date / End Date / Quarter pickers.
function periodToSemesterLabel(period) {
    const match = /^(Jan - Jun|Jul - Dec) (\d{4})$/.exec(period || '');
    if (!match) return period;
    const semester = match[1] === 'Jan - Jun' ? '1st Semester' : '2nd Semester';
    return `${semester}, A.Y. ${match[2]}`;
}

function getSemesterOptions(callback) {
    db.query(
        'SELECT DISTINCT period_year_quarter FROM survey_responses WHERE period_year_quarter IS NOT NULL ORDER BY period_year_quarter DESC',
        (err, rows) => {
            if (err || !rows) return callback([]);
            callback(rows.map(r => ({ value: r.period_year_quarter, label: periodToSemesterLabel(r.period_year_quarter) })));
        }
    );
}

// ==========================================
// 2. Admin Dashboard Routes
// ==========================================
app.get('/dashboard', ensureAdminAuth, noCache, (req, res) => {
    const { semester } = req.query;
    const hasSemesterFilter = !!semester;

    const dateWhere = hasSemesterFilter ? ' WHERE s.period_year_quarter = ? ' : '';
    const dateWhereAnd = hasSemesterFilter ? ' AND s.period_year_quarter = ? ' : '';
    const dateParams = hasSemesterFilter ? [semester] : [];

    db.query(`SELECT COUNT(*) AS total FROM survey_responses s${dateWhere}`, dateParams, (err, totalRes) => {
        const totalRespondents = (totalRes && totalRes[0]) ? totalRes[0].total : 0;

        const avgQuery = `
            SELECT AVG((IFNULL(sqd1,0) + IFNULL(sqd2,0) + IFNULL(sqd3,0) + IFNULL(sqd4,0) + IFNULL(sqd5,0) + IFNULL(sqd6,0) + IFNULL(sqd7,0) + IFNULL(sqd8,0)) / 8) AS overall_avg
            FROM survey_responses s${dateWhere}
        `;
        db.query(avgQuery, dateParams, (err, avgRes) => {
            let overallAvgScore = 0;
            if (avgRes && avgRes[0] && avgRes[0].overall_avg) {
                overallAvgScore = parseFloat(((avgRes[0].overall_avg / 5) * 100).toFixed(2));
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
                        IFNULL(ROUND(AVG((IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) + IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) + IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)) / 8) * 20, 2), 0) as cluster_rating
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
                            IFNULL(ROUND(AVG((IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) + IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) + IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)) / 8) * 20, 2), 0) as office_score
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

                        getSemesterOptions((semesterOptions) => {
                            res.render('dashboard', {
                                dashboardData: { overallRating: overallAvgScore, overallLevel: interpretation, academicYear: "A.Y. 2026-2027" },
                                chartData: chartData, clusterCards: clusterCards, satisfactionRate: overallAvgScore,
                                totalRespondents: totalRespondents, totalOffices: totalOffices, reportData: reportData,
                                semesterOptions: semesterOptions, selectedSemester: semester || ''
                            });
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
// institution). `semester` narrows further to one period_year_quarter.
app.post('/api/report-data', ensureAdminAuth, (req, res) => {
    const { office, officeId, cluster, semester } = req.body;

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
    if (semester) {
        conditions.push('s.period_year_quarter = ?');
        queryParams.push(semester);
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const query = `
        SELECT
            COUNT(s.id) as total_respondents,
            IFNULL(ROUND(AVG(s.sqd1) * 20, 2), 0) as sqd1,
            IFNULL(ROUND(AVG(s.sqd2) * 20, 2), 0) as sqd2,
            IFNULL(ROUND(AVG(s.sqd3) * 20, 2), 0) as sqd3,
            IFNULL(ROUND(AVG(s.sqd4) * 20, 2), 0) as sqd4,
            IFNULL(ROUND(AVG(s.sqd5) * 20, 2), 0) as sqd5,
            IFNULL(ROUND(AVG(s.sqd6) * 20, 2), 0) as sqd6,
            IFNULL(ROUND(AVG(s.sqd7) * 20, 2), 0) as sqd7,
            IFNULL(ROUND(AVG(s.sqd8) * 20, 2), 0) as sqd8,
            IFNULL(ROUND(AVG((IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) + IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) + IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)) / 8) * 20, 2), 0) as overall_score
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
               IFNULL(ROUND(AVG((IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) + IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) + IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)) / 8) * 20, 2), 0) as rating
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
function getClusterPerformanceData(clusterName, semester, callback) {
    const semesterJoinFilter = semester ? ' AND s.period_year_quarter = ?' : '';
    const clusterQuery = `
        SELECT
            o.id,
            o.office_name AS fullName,
            IF(LOCATE(' ', o.office_name) > 0,
               REPLACE(REPLACE(REPLACE(UPPER(o.office_name), 'OFFICE OF THE ', ''), 'OFFICE OF ', ''), 'VICE PRESIDENT FOR ', ''),
               SUBSTRING(UPPER(o.office_name), 1, 4)
            ) AS label,
            COUNT(s.id) AS resp,
            ROUND(IFNULL(AVG((
                IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) +
                IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) +
                IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)
            ) / 8) * 20, 0), 1) AS rating
        FROM offices o
        LEFT JOIN survey_responses s ON o.id = s.office_id${semesterJoinFilter}
        WHERE o.cluster_name = ?
        GROUP BY o.id, o.office_name
    `;
    const queryParams = semester ? [semester, clusterName] : [clusterName];

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
        const semester = req.query.semester || '';
        getClusterPerformanceData(clusterName, semester, (err, data) => {
            getSemesterOptions((semesterOptions) => {
                getOfficesForCluster(clusterName, (officesInCluster) => {
                    res.render(view, {
                        data: data || [],
                        semesterOptions: semesterOptions,
                        selectedSemester: semester,
                        officesInCluster: officesInCluster,
                        clusterName: clusterName
                    });
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
            // MAPPING LOGIC: Hinahati ang DB record papunta sa p1 o p2 para mag-reset at magsilbing archive ang past semester
            const periodStr = row.period_year_quarter || '';
            const p = periodStr.includes('Jul - Dec') ? 'p2' : 'p1';

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
app.listen(port, () => {
    console.log(`🚀 Server is running at http://localhost:${port}`);
});