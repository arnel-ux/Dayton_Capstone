// ============================================================================
// REPORT FORMULA MODULE
// ============================================================================
// Every computation/formula used to build a report or dashboard number in
// this app, in one place, extracted out of server.js on 2026-09-28 so each
// one is easy to find and change without having to search the whole 8000+
// line file. Nothing in here was rewritten — every function/constant below
// is byte-for-byte the same logic that lived in server.js, just moved and
// grouped under a clear "which formula is this" header per section.
//
// server.js requires this whole module once near its own top and destructures
// every name it needs from it — every call site elsewhere in server.js and in
// the EJS views keeps using the exact same names as before, so nothing about
// how a route or a template calls these had to change.
//
// Sections in this file, in order:
//   1. SQD Score Formula            (sqdScoreExpr, ALL_SQD_COLS)
//   2. SQD Bucket Breakdown Formula (sqdBucketExprs, SQD_DIMENSIONS, buildSqdBucketRow)
//   3. Cluster/Office Score-Cell Formula (NO_DATA, scoreCell, CLUSTER_REPORT_ORDER, buildOrderedClusterReport)
//   4. Office Display Name Formula  (OFFICE_REPORT_NAME_EXPR)
//   5. Period Normalization Formula (normalizePeriodStr, periodNormExpr)
//   6. Effective Topic/Sentiment Formula (EFFECTIVE_TOPIC_SQL, EFFECTIVE_SENTIMENT_SQL)
//   7. AI-Analysis-Gating Formula   (NO_FEEDBACK_LABEL, NO_AI_RESULT_TOPIC_SQL,
//                                    HAS_AI_ANALYSIS_SQL, REPORT_TOPIC_SQL,
//                                    REPORT_SENTIMENT_SQL, HAS_REAL_COMMENT_SQL)
//   8. Sentiment Tone Formula       (sentimentTone)
//   9. Topic Badge Color Formula    (topicBadgeClassFor)
// ============================================================================


// ----------------------------------------------------------------------------
// 1. SQD SCORE FORMULA (Citizen's Charter / ARTA)
// ----------------------------------------------------------------------------
// Overall Score = (# 'Strongly Agree' + # 'Agree') / (Total Respondents - # 'N/A') * 100
// sqd columns store 5=Strongly Agree, 4=Agree, 3=Neutral, 2=Disagree, 1=Strongly Disagree, 0=N/A.
// This is purely a numeric-rating computation and never touches the AI sentiment/topic
// pipeline (see analyzeComment in server.js) — the two scores are computed independently of each other.
function sqdScoreExpr(cols) {
    // (Strongly Agree + Agree) / (total responses - N/A) * 100.
    // The denominator counts answers that actually carry a rating (1..5) rather
    // than `COUNT(s.id) * cols - (answers equal to 0)`: a column left NULL is an
    // unanswered item, which sqdBucketExprs() already buckets as N/A, so counting
    // it in the denominator here made the scorecard's % disagree with the SQD 0 /
    // SQD 1-8 tables' Overall % on the very same report.
    const agreeSum = cols.map(c => `SUM(CASE WHEN ${c} IN (4,5) THEN 1 ELSE 0 END)`).join(' + ');
    const answerable = cols.map(c => `SUM(CASE WHEN ${c} BETWEEN 1 AND 5 THEN 1 ELSE 0 END)`).join(' + ');
    return `IFNULL(ROUND((${agreeSum}) / NULLIF((${answerable}), 0) * 100, 2), 0)`;
}
const ALL_SQD_COLS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `s.sqd${i}`);


// ----------------------------------------------------------------------------
// 2. SQD BUCKET BREAKDOWN FORMULA
// ----------------------------------------------------------------------------
// Per-column rating breakdown (Strongly Agree..N/A bucket counts) for the
// "SQD Results" detailed report — same 5/4/3/2/1/0 scale as sqdScoreExpr,
// but returns each bucket's count instead of collapsing straight to a %.
function sqdBucketExprs(col, alias) {
    return [
        `SUM(CASE WHEN ${col} = 5 THEN 1 ELSE 0 END) AS ${alias}_sa`,
        `SUM(CASE WHEN ${col} = 4 THEN 1 ELSE 0 END) AS ${alias}_a`,
        `SUM(CASE WHEN ${col} = 3 THEN 1 ELSE 0 END) AS ${alias}_n`,
        `SUM(CASE WHEN ${col} = 2 THEN 1 ELSE 0 END) AS ${alias}_d`,
        `SUM(CASE WHEN ${col} = 1 THEN 1 ELSE 0 END) AS ${alias}_sd`,
        `SUM(CASE WHEN ${col} = 0 OR ${col} IS NULL THEN 1 ELSE 0 END) AS ${alias}_na`
    ];
}
const SQD_DIMENSIONS = [
    { col: 'sqd1', label: 'Responsiveness' },
    { col: 'sqd2', label: 'Reliability' },
    { col: 'sqd3', label: 'Access & Facility' },
    { col: 'sqd4', label: 'Communication' },
    { col: 'sqd5', label: 'Costs' },
    { col: 'sqd6', label: 'Integrity' },
    { col: 'sqd7', label: 'Assurance' },
    { col: 'sqd8', label: 'Outcome' }
];
// Builds one rating-breakdown row from its raw bucket counts. total defaults to
// the sum of all buckets (i.e. every respondent answered this column once).
function buildSqdBucketRow(label, buckets) {
    const { sa, a, n, d, sd, na } = buckets;
    const total = sa + a + n + d + sd + na;
    const answerable = total - na;
    const overall = answerable > 0 ? ((sa + a) / answerable * 100) : null;
    return {
        label, sa, a, n, d, sd, na, total,
        overall: overall === null ? 'N/A' : overall.toFixed(0) + '%'
    };
}


// ----------------------------------------------------------------------------
// 3. CLUSTER/OFFICE SCORE-CELL FORMULA
// ----------------------------------------------------------------------------
// An office (or cluster) nobody has answered for yet has no score to print — a
// literal 0.00%/POOR would read as "rated, and rated badly". Reports print N/A
// instead, so an empty office is identifiable at a glance.
const NO_DATA = 'N/A';
function scoreCell(respondents, rawScore, interpretFn) {
    if (!respondents) return { score: NO_DATA, interpretation: NO_DATA };
    const score = parseFloat(rawScore || 0);
    return { score: score.toFixed(2), interpretation: interpretFn(score) };
}

// Fixed cluster presentation order for the "PER CLUSTER" institutional report
// (dashboard's report modal and /print) — NOT alphabetical/ID order, per the
// official printed report's required sequence.
const CLUSTER_REPORT_ORDER = [
    'Office of the President Cluster',
    'Administrative and Finance Cluster',
    'Research, Innovation and Collaboration Cluster',
    'Academic Cluster'
];

// Reorders a { clusterName, offices: [...] }[] array (built in cluster_name
// alphabetical order by the SQL GROUP BY) into CLUSTER_REPORT_ORDER, and
// attaches each cluster's own weighted overall score/interpretation from
// clusterRatingMap (cluster_name -> { rating }) so the report can print a
// TOTAL row per cluster instead of only one institution-wide total.
function buildOrderedClusterReport(clustersMap, clusterRatingMap, interpretFn) {
    const byName = new Map();
    Object.keys(clustersMap).forEach(name => byName.set(name, clustersMap[name]));

    const ordered = [];
    CLUSTER_REPORT_ORDER.forEach(name => {
        if (byName.has(name)) { ordered.push(byName.get(name)); byName.delete(name); }
    });
    // Any cluster not in the fixed list (e.g. newly added) still prints, just
    // appended after the required sequence rather than silently dropped.
    byName.forEach(cluster => ordered.push(cluster));

    ordered.forEach(cluster => {
        const rating = clusterRatingMap[cluster.clusterName];
        // A cluster whose offices have no responses at all prints N/A too, the same
        // way each of those offices does — see scoreCell.
        const cell = scoreCell(rating ? rating.respondents : 0, rating ? rating.rating : 0, interpretFn);
        cluster.overallScore = cell.score;
        cluster.interpretation = cell.interpretation;
    });

    return ordered;
}


// ----------------------------------------------------------------------------
// 4. OFFICE DISPLAY NAME FORMULA
// ----------------------------------------------------------------------------
// The name an office prints under on a report: its spelled-out `full_name` when
// one is set, otherwise `office_name` (already the complete name for most
// offices). Kept as one expression so every report resolves it identically.
const OFFICE_REPORT_NAME_EXPR = "COALESCE(NULLIF(TRIM(o.full_name), ''), o.office_name)";


// ----------------------------------------------------------------------------
// 5. PERIOD NORMALIZATION FORMULA
// ----------------------------------------------------------------------------
// Legacy/manually-seeded rows have used a handful of equivalent spellings for
// the same period ("July to Dec 2026" vs "Jul - Dec 2026"). Comparing on a
// normalized form so those rows aren't silently dropped from period-filtered
// stats — an exact-match `=` here previously made real data disappear.
function normalizePeriodStr(s) {
    return String(s || '').trim().replace(/July/i, 'Jul').replace(/June/i, 'Jun').replace(/\s+to\s+/i, ' - ');
}
function periodNormExpr(col) {
    return `REPLACE(REPLACE(REPLACE(TRIM(${col}), 'July', 'Jul'), 'June', 'Jun'), ' to ', ' - ')`;
}


// ----------------------------------------------------------------------------
// 6. EFFECTIVE TOPIC/SENTIMENT FORMULA
// ----------------------------------------------------------------------------
// SQL mirrors of shared/topicTaxonomy.js's combineTopic()/effective-sentiment
// rule, for the handful of report/dashboard queries that GROUP BY or otherwise
// need the admin-corrected topic/sentiment at the database level rather than
// after fetching rows into JS. Keep in sync with combineTopic — "No Feedback"
// has no "General"-style bare/item split (its one subtopic IS "No Feedback"),
// everything else collapses to the bare topic when its subtopic is missing or
// "General".
const EFFECTIVE_TOPIC_SQL = `
    CASE
        WHEN s.topic_override IS NULL THEN s.topic
        WHEN s.topic_override = 'No Feedback' THEN 'No Feedback'
        WHEN s.subtopic_override IS NULL OR s.subtopic_override = 'General' THEN s.topic_override
        ELSE CONCAT(s.topic_override, ' - ', s.subtopic_override)
    END
`;
const EFFECTIVE_SENTIMENT_SQL = `COALESCE(s.sentiment_override, s.sentiment)`;


// ----------------------------------------------------------------------------
// 7. AI-ANALYSIS-GATING FORMULA
// ----------------------------------------------------------------------------
// A survey whose comment was blank or an "N/A"/"none"-style placeholder is
// stored with topic = NULL and sentiment = NULL (see isNoFeedbackComment and
// insertVerifiedSurveyOnConnection in server.js) — there was genuinely nothing
// for the AI to read, so it produced no result. /survey-records has always
// rendered those as "No feedback" with no sentiment and no topic; every other
// report instead substituted a fabricated 'Neutral'/'General Feedback' of its
// own, which inflated the Neutral counts and could hand the dominant-topic
// line to a "topic" no respondent ever wrote about. The expressions below are
// /survey-records' rule at the SQL level so every report agrees with it.
//
// s.topic IS NOT NULL is the whole test, checked on the RAW ai column rather
// than the COALESCEd effective one on purpose: an admin override saved
// against a no-feedback row must not quietly promote that row back into the
// analyzed counts, which is exactly how /survey-records treats it too.
const NO_FEEDBACK_LABEL = 'No feedback';

// The AI's own "there is nothing here to classify" verdict, as stored: a
// comment the classifier read and found meaningless (keyboard mash like
// "asdfasdf", emoji or punctuation only, a bare "hello po") comes back from
// detect_junk_topic as the topic "No Feedback - No Feedback" — a real string,
// not NULL, which is precisely why a NULL-only test used to miss it.
// "Unclassified" is the same verdict under its older name (see
// shared/topicTaxonomy.js, which still maps it) and is matched for legacy rows.
//
// Checked on the EFFECTIVE topic, not the raw one, so it cuts both ways: an
// admin who reclassifies a wrongly-flagged comment to a real topic puts it
// back into the reports, and an admin who marks a genuinely meaningless
// comment as "No Feedback" from /survey-records takes it out — the manual
// remedy for any mash the detector doesn't catch on its own.
const NO_AI_RESULT_TOPIC_SQL = `(
    LOWER(COALESCE(${EFFECTIVE_TOPIC_SQL}, '')) LIKE 'no feedback%'
    OR LOWER(COALESCE(${EFFECTIVE_TOPIC_SQL}, '')) LIKE 'unclassified%'
)`;

// s.topic IS NOT NULL stays keyed to the RAW column (an override must never
// resurrect a survey whose respondent wrote nothing at all); the junk-topic
// test above is the part that honours overrides.
//
// s.analysis_status = 'completed' (added 2026-09-22, pure-AI classification
// project): a live comment is inserted with a PLACEHOLDER topic/sentiment
// while Gemini is still analyzing it in the background (see
// insertVerifiedSurveyOnConnection's analysisPending handling in server.js) —
// that placeholder is a non-NULL string, so without this check a
// still-analyzing comment would already "have AI analysis" by the tests
// above and briefly show a wrong/about-to-change topic or sentiment.
// Requiring 'completed' here means every query built on HAS_AI_ANALYSIS_SQL
// (dashboard/report topic & sentiment breakdowns, and HAS_REAL_COMMENT_SQL's
// comment listing below) simply treats a still-analyzing comment as "nothing
// to show yet", exactly like a genuine no-feedback row, until the analysis
// finishes.
const HAS_AI_ANALYSIS_SQL = `(s.topic IS NOT NULL AND s.analysis_status = 'completed' AND NOT ${NO_AI_RESULT_TOPIC_SQL})`;
const REPORT_TOPIC_SQL = `CASE WHEN ${HAS_AI_ANALYSIS_SQL} THEN (${EFFECTIVE_TOPIC_SQL}) ELSE NULL END`;
const REPORT_SENTIMENT_SQL = `CASE WHEN ${HAS_AI_ANALYSIS_SQL} THEN (${EFFECTIVE_SENTIMENT_SQL}) ELSE NULL END`;

// Only a survey that carries a REAL written comment belongs in the comments
// report — "the report is the comments", so a respondent who left the box
// blank or typed "N/A" simply isn't part of it (they're still counted in every
// respondent/SQD total, which is where they do belong).
//
// Two conditions, because they catch different rows:
//   - s.topic IS NOT NULL is the authoritative modern test (a no-feedback
//     comment is stored with NULL topic AND NULL sentiment — see
//     insertVerifiedSurveyOnConnection), and
//   - the text test below is a SQL mirror of isNoFeedbackComment for LEGACY
//     rows written before that rule existed, which can hold a literal "N/A"
//     comment alongside a fabricated 'General Feedback' topic. Matches
//     isNoFeedbackComment's own normalization: trim, drop "." and "-", lower.
const HAS_REAL_COMMENT_SQL = `
    s.comments IS NOT NULL
    AND TRIM(s.comments) <> ''
    AND ${HAS_AI_ANALYSIS_SQL}
    AND LOWER(REPLACE(REPLACE(TRIM(s.comments), '.', ''), '-', '')) NOT IN
        ('', 'na', 'n/a', 'none', 'nil', 'no comment', 'no comments', 'not applicable')
`;


// ----------------------------------------------------------------------------
// 8. SENTIMENT TONE FORMULA
// ----------------------------------------------------------------------------
// Bare tone token ('positive' | 'negative' | 'neutral' | 'none') for a
// sentiment value, so each view can prefix it with its own class naming
// (bg-sentiment-* on the dashboard, pill-* in the printable report) and still
// colour a given response identically everywhere. A missing sentiment is
// 'none' — never silently folded into 'neutral'.
function sentimentTone(sentiment) {
    const value = (sentiment || '').toLowerCase();
    if (!value || value === NO_FEEDBACK_LABEL.toLowerCase()) return 'none';
    if (value.includes('positive')) return 'positive';
    if (value.includes('negative')) return 'negative';
    return 'neutral';
}


// ----------------------------------------------------------------------------
// 9. TOPIC BADGE COLOR FORMULA
// ----------------------------------------------------------------------------
// Badge color for one topic string (bare topic or "{Topic} - {Item}") — used
// for both the primary topic and every extra topic (multi-topic tagging
// project, 2026-09-25) on /survey-records, so every badge in a row is
// colored the same consistent way regardless of which slot it's in. Caller
// handles the "no feedback at all" case itself (bg-no-feedback), since that
// depends on the ROW, not any one topic string.
function topicBadgeClassFor(topic) {
    const topicLower = (topic || '').toLowerCase();
    if (topicLower.startsWith('unclassified') || topicLower.startsWith('no feedback')) return 'bg-unclassified';
    if (topicLower.includes('restroom') || topicLower.includes('cleanliness')) return 'bg-cr';
    if (topicLower.includes('aircon') || topicLower.includes('cooling')) return 'bg-aircon';
    if (
        topicLower.includes('facilities and resources') || topicLower.includes('equipment') ||
        topicLower.includes('furniture') || topicLower.includes('seating') ||
        topicLower.includes('power') || topicLower.includes('lighting') ||
        topicLower.includes('dormitory') || topicLower.includes('transportation service') ||
        topicLower.includes('supplies and resources')
    ) return 'bg-facility';
    if (topicLower.includes('staff service') || topicLower.includes('fairness') || topicLower.includes('courtesy') || topicLower.includes('competence')) return 'bg-staff';
    if (topicLower.includes('processing') || topicLower.includes('approval process') || topicLower.includes('service procedure')) return 'bg-transaction';
    if (topicLower.includes('financial transaction')) return 'bg-payment';
    if (
        topicLower.includes('documents and records') || topicLower.includes('credential') ||
        topicLower.includes('enrollment process') || topicLower.includes('academic transaction') ||
        topicLower.includes('clearance process') || topicLower.includes('id services')
    ) return 'bg-docs';
    if (topicLower.includes('system and access') || topicLower.includes('ease of use') || topicLower.includes('internet service')) return 'bg-online';
    if (
        topicLower.includes('health service') || topicLower.includes('scholarship and assistance') ||
        topicLower.includes('leave process') || topicLower.includes('library service') ||
        topicLower.includes('research service') || topicLower.includes('accreditation process')
    ) return 'bg-health';
    return 'bg-general';
}


module.exports = {
    // 1. SQD Score Formula
    sqdScoreExpr, ALL_SQD_COLS,
    // 2. SQD Bucket Breakdown Formula
    sqdBucketExprs, SQD_DIMENSIONS, buildSqdBucketRow,
    // 3. Cluster/Office Score-Cell Formula
    NO_DATA, scoreCell, CLUSTER_REPORT_ORDER, buildOrderedClusterReport,
    // 4. Office Display Name Formula
    OFFICE_REPORT_NAME_EXPR,
    // 5. Period Normalization Formula
    normalizePeriodStr, periodNormExpr,
    // 6. Effective Topic/Sentiment Formula
    EFFECTIVE_TOPIC_SQL, EFFECTIVE_SENTIMENT_SQL,
    // 7. AI-Analysis-Gating Formula
    NO_FEEDBACK_LABEL, NO_AI_RESULT_TOPIC_SQL, HAS_AI_ANALYSIS_SQL,
    REPORT_TOPIC_SQL, REPORT_SENTIMENT_SQL, HAS_REAL_COMMENT_SQL,
    // 8. Sentiment Tone Formula
    sentimentTone,
    // 9. Topic Badge Color Formula
    topicBadgeClassFor,
};
