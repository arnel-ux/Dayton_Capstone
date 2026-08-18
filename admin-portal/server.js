require('dotenv').config();

const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const { spawn } = require('child_process'); // 🔥 ADDED THIS LINE
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
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

// Ensures only an authenticated client (Google OR unified login) can view/submit the survey
function ensureClientAuth(req, res, next) {
    const email = getClientEmail(req);
    if (email) {
        req.clientEmail = email;
        return next();
    }
    if (req.is('application/json') || req.xhr) {
        return res.status(401).json({ success: false, message: "Please sign in before submitting the survey." });
    }
    return res.redirect('/login');
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
app.get('/login', (req, res) => res.render('login'));

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
    if (!emailInput) {
        return res.send("<script>alert('Invalid credentials!'); window.location.href='/login';</script>");
    }

    db.query('SELECT email FROM client_accounts WHERE email = ? LIMIT 1', [emailInput], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            req.session.clientEmail = rows[0].email;
            return res.redirect('/client-survey');
        }
        res.send("<script>alert('Invalid credentials! Registered clients must first sign in once with Google before using this form.'); window.location.href='/login';</script>");
    });
});

app.get('/client-login', (req, res) => res.render('client-login'));
app.get('/gmail-login', (req, res) => res.render('gmail-login'));

// ==========================================
// GOOGLE OAUTH ROUTES (Client login)
// ==========================================
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => res.redirect('/client-survey')
);

app.get('/logout', (req, res) => {
    req.session.clientEmail = null;
    req.logout(() => res.redirect('/login'));
});

app.get('/client-survey', ensureClientAuth, (req, res) => {
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

            // 2. 🔥 BACKGROUND AI PROCESS START 🔥
            if (comments && comments.trim() !== "") {
                const pythonScriptPath = path.join(__dirname, 'ai_scripts', 'analyze.py');
                const pythonProcess = spawn('python', [pythonScriptPath]);

                // 🔥 Catch if Python is missing from Windows Environment Variables
                pythonProcess.on('error', (err) => {
                    console.error("❌ [CRITICAL ERROR]: Could not start Python. Is it installed?", err);
                });

                pythonProcess.stdin.write(comments);
                pythonProcess.stdin.end();

                let aiOutput = '';
                let aiError = '';

                pythonProcess.stdout.on('data', (chunk) => { 
                    aiOutput += chunk.toString(); 
                });
                
                // 🔥 SHOW PYTHON LOGS & DOWNLOAD BARS IN REAL-TIME
                pythonProcess.stderr.on('data', (chunk) => { 
                    process.stdout.write(chunk.toString()); 
                    aiError += chunk.toString(); 
                });

                pythonProcess.on('close', (code) => {
                    try {
                        const jsonMatch = aiOutput.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const aiResult = JSON.parse(jsonMatch[0]);
                            
                            if (aiResult.sentiment && aiResult.topic) {
                                const updateQuery = 'UPDATE survey_responses SET sentiment = ?, topic = ? WHERE id = ?';
                                db.query(updateQuery, [aiResult.sentiment, aiResult.topic, surveyResponseId]);
                                console.log(`✅ [AI Success] ID: ${surveyResponseId} | Sentiment: ${aiResult.sentiment} | Topic: ${aiResult.topic}`);
                            }
                        } else {
                            console.error("❌ [AI Parsing Error]: Could not find JSON.\nRaw Output:", aiOutput);
                        }
                    } catch (e) {
                        console.error("❌ [AI Execution Error]:", e.message);
                    }
                });
            }
        });
    });
    }
    });
});

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
app.get('/dashboard', (req, res) => {
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

app.get('/profile', (req, res) => res.render('profile'));
app.get('/password', (req, res) => res.render('password'));
app.get('/print', (req, res) => res.render('print'));

// ==========================================
// DYNAMIC REPORTS ROUTE (Modified)
// ==========================================
app.get('/report', (req, res) => {
    db.query('SELECT office_name FROM offices ORDER BY office_name ASC', (err, offices) => {
        res.render('report', { offices: offices || [] });
    });
});

app.post('/api/report-data', (req, res) => {
    const { office, quarter, period } = req.body;
    
    let query = `
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
        LEFT JOIN offices o ON s.office_id = o.id
    `;
    
    let queryParams = [];
    if (office !== 'ALL OFFICES') {
        query += ` WHERE o.office_name = ?`;
        queryParams.push(office);
    }

    db.query(query, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let commentsQuery = `SELECT s.comments, s.sentiment, s.topic FROM survey_responses s LEFT JOIN offices o ON s.office_id = o.id WHERE s.comments IS NOT NULL AND TRIM(s.comments) != ''`;
        if (office !== 'ALL OFFICES') {
            commentsQuery += ` AND o.office_name = ?`;
        }

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
app.get('/survey-records', (req, res) => {
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
            SELECT s.respondent_name, s.topic, s.comments, DATE_FORMAT(s.created_at, '%M %d, %Y') as formatted_date, o.cluster_name
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
                    
                    recordsByCluster[cluster].push({ name: row.respondent_name || 'Anonymous', topic: row.topic || 'General', topicClass: badgeClass, comments: row.comments || 'No comments provided.', date: row.formatted_date });
                });
            }
            res.render('survey-records', { recordsByCluster, clusterRatings });
        });
    });
});

// ==========================================
// 3. OFFICES & CLUSTERS CRUD ROUTES
// ==========================================
app.get('/offices', (req, res) => {
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

app.post('/clusters/add', (req, res) => {
    const { cluster_name } = req.body;
    if (!cluster_name || cluster_name.trim() === "") {
        return res.redirect('/offices');
    }
    db.query('INSERT IGNORE INTO clusters (cluster_name) VALUES (?)', [cluster_name.trim()], (err) => {
        if (err) console.error("❌ Error adding cluster to database:", err);
        res.redirect('/offices');
    });
});

app.post('/offices/add', (req, res) => {
    const { cluster_name, office_name, head_director, email_address } = req.body;
    db.query('INSERT INTO offices (cluster_name, office_name, head_director, email_address) VALUES (?, ?, ?, ?)', 
    [cluster_name, office_name, head_director || 'Not Assigned', email_address], (err, result) => { 
        if (err) console.error("❌ Error adding office:", err);
        res.redirect('/offices'); 
    });
});

app.post('/offices/edit', (req, res) => {
    const { id, cluster_name, office_name, head_director, email_address } = req.body;
    db.query('UPDATE offices SET cluster_name = ?, office_name = ?, head_director = ?, email_address = ? WHERE id = ?', 
    [cluster_name, office_name, head_director, email_address, id], (err, result) => { res.redirect('/offices'); });
});

// Soft delete / archive: hindi na tinatanggal ang record sa database (walang DELETE query),
// binabago na lamang ang is_archived flag para maiwasan ang pagkawala ng historical survey data.
app.post('/offices/delete/:id', (req, res) => {
    db.query('UPDATE offices SET is_archived = 1 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

app.post('/offices/restore/:id', (req, res) => {
    db.query('UPDATE offices SET is_archived = 0 WHERE id = ?', [req.params.id], (err, result) => { res.redirect('/offices'); });
});

// ==========================================
// 4. SURVEY SETTINGS CRUD
// ==========================================
app.get('/survey', (req, res) => {
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

app.post('/settings/add', (req, res) => {
    const { category, content } = req.body;
    db.query('INSERT INTO survey_settings (category, content) VALUES (?, ?)', [category, content], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, insertId: result.insertId });
    });
});

app.post('/settings/edit', (req, res) => {
    const { id, content } = req.body;
    db.query('UPDATE survey_settings SET content = ? WHERE id = ?', [content, id], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

app.post('/settings/delete', (req, res) => {
    const { id } = req.body;
    db.query('DELETE FROM survey_settings WHERE id = ?', [id], (err) => {
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

app.get('/cluster/office-of-the-president', renderClusterPage('cluster-op', 'Office of the President Cluster'));
app.get('/cluster/admin-finance', renderClusterPage('cluster-admin-finance', 'Administrative and Finance Cluster'));
app.get('/cluster/research-innovation', renderClusterPage('cluster-research', 'Research, Innovation and Collaboration Cluster'));
app.get('/cluster/academic', renderClusterPage('cluster-academic', 'Academic Cluster'));
app.get('/cluster/other-offices', renderClusterPage('cluster-other', 'Other Offices Cluster'));

// ==========================================
// Cluster Respondents API (office/semester drill-down for cluster pages)
// ==========================================
// Backs the "Select Office" dropdown on each cluster page: returns individual
// survey responses (taker + their SQD results) for a cluster, optionally
// narrowed to one office and/or one semester.
app.get('/api/cluster-respondents', (req, res) => {
    const { cluster, office, semester } = req.query;
    if (!cluster) return res.status(400).json({ success: false, message: 'cluster is required' });

    const conditions = ['o.cluster_name = ?'];
    const params = [cluster];

    if (office) {
        conditions.push('o.id = ?');
        params.push(office);
    }
    if (semester) {
        conditions.push('s.period_year_quarter = ?');
        params.push(semester);
    }

    const query = `
        SELECT
            s.id, s.respondent_name, o.office_name,
            s.period_year_quarter, s.created_at,
            ROUND(((IFNULL(s.sqd1,0) + IFNULL(s.sqd2,0) + IFNULL(s.sqd3,0) +
                    IFNULL(s.sqd4,0) + IFNULL(s.sqd5,0) + IFNULL(s.sqd6,0) +
                    IFNULL(s.sqd7,0) + IFNULL(s.sqd8,0)) / 8) * 20, 2) AS rating
        FROM survey_responses s
        JOIN offices o ON s.office_id = o.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.created_at DESC
    `;

    db.query(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        const interpretationFor = (score) => {
            if (score >= 95) return 'OUTSTANDING';
            if (score >= 85) return 'VERY SATISFACTORY';
            if (score >= 75) return 'SATISFACTORY';
            if (score >= 60) return 'FAIR';
            return 'POOR';
        };

        const results = rows.map(row => {
            const rating = parseFloat(row.rating || 0);
            return {
                id: row.id,
                respondentName: row.respondent_name || 'Anonymous',
                officeName: row.office_name,
                period: row.period_year_quarter,
                submittedAt: row.created_at,
                rating: rating,
                interpretation: interpretationFor(rating)
            };
        });

        res.json({ success: true, results: results });
    });
});

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