// ============================================================================
// REPORT FORMULA MODULE
// ============================================================================
// Every computation/formula used to build a report or dashboard number,
// grouped together so each one is easy to find and change.
// server.js requires this module and destructures the names it needs.
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
function sqdScoreExpr(cols) {
    // (Strongly Agree + Agree) / (total answered - N/A) * 100.
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
// The 8 Citizen's Charter survey dimensions.
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
// Builds one rating-breakdown row from its raw bucket counts.
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
// Score display for one office or cluster, showing N/A when nobody answered yet.
const NO_DATA = 'N/A';
function scoreCell(respondents, rawScore, interpretFn) {
    if (!respondents) return { score: NO_DATA, interpretation: NO_DATA };
    const score = parseFloat(rawScore || 0);
    return { score: score.toFixed(2), interpretation: interpretFn(score) };
}

// Fixed cluster display order for the institutional report.
const CLUSTER_REPORT_ORDER = [
    'Office of the President Cluster',
    'Administrative and Finance Cluster',
    'Research, Innovation and Collaboration Cluster',
    'Academic Cluster'
];

// Reorders the clusters into CLUSTER_REPORT_ORDER and attaches each cluster's overall score.
function buildOrderedClusterReport(clustersMap, clusterRatingMap, interpretFn) {
    const byName = new Map();
    Object.keys(clustersMap).forEach(name => byName.set(name, clustersMap[name]));

    const ordered = [];
    CLUSTER_REPORT_ORDER.forEach(name => {
        if (byName.has(name)) { ordered.push(byName.get(name)); byName.delete(name); }
    });
    // Any cluster not in the fixed list still prints, appended at the end.
    byName.forEach(cluster => ordered.push(cluster));

    ordered.forEach(cluster => {
        const rating = clusterRatingMap[cluster.clusterName];
        const cell = scoreCell(rating ? rating.respondents : 0, rating ? rating.rating : 0, interpretFn);
        cluster.overallScore = cell.score;
        cluster.interpretation = cell.interpretation;
    });

    return ordered;
}


// ----------------------------------------------------------------------------
// 4. OFFICE DISPLAY NAME FORMULA
// ----------------------------------------------------------------------------
// The name an office prints under on a report, preferring full_name over office_name.
const OFFICE_REPORT_NAME_EXPR = "COALESCE(NULLIF(TRIM(o.full_name), ''), o.office_name)";


// ----------------------------------------------------------------------------
// 5. PERIOD NORMALIZATION FORMULA
// ----------------------------------------------------------------------------
// Normalizes a period string so different spellings of the same period match.
function normalizePeriodStr(s) {
    return String(s || '').trim().replace(/July/i, 'Jul').replace(/June/i, 'Jun').replace(/\s+to\s+/i, ' - ');
}
function periodNormExpr(col) {
    return `REPLACE(REPLACE(REPLACE(TRIM(${col}), 'July', 'Jul'), 'June', 'Jun'), ' to ', ' - ')`;
}


// ----------------------------------------------------------------------------
// 6. EFFECTIVE TOPIC/SENTIMENT FORMULA
// ----------------------------------------------------------------------------
// SQL version of shared/topicTaxonomy.js's combineTopic(), using the admin override when present.
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
// Decides whether a survey row has a real, finished AI result to show in reports.
const NO_FEEDBACK_LABEL = 'No feedback';

// Matches the junk-topic labels detect_junk_topic assigns, plus the legacy "Unclassified" label.
const NO_AI_RESULT_TOPIC_SQL = `(
    LOWER(COALESCE(${EFFECTIVE_TOPIC_SQL}, '')) LIKE 'no feedback%'
    OR LOWER(COALESCE(${EFFECTIVE_TOPIC_SQL}, '')) LIKE 'unclassified%'
)`;

// True only once a row has a completed, non-junk AI result.
const HAS_AI_ANALYSIS_SQL = `(s.topic IS NOT NULL AND s.analysis_status = 'completed' AND NOT ${NO_AI_RESULT_TOPIC_SQL})`;
const REPORT_TOPIC_SQL = `CASE WHEN ${HAS_AI_ANALYSIS_SQL} THEN (${EFFECTIVE_TOPIC_SQL}) ELSE NULL END`;
const REPORT_SENTIMENT_SQL = `CASE WHEN ${HAS_AI_ANALYSIS_SQL} THEN (${EFFECTIVE_SENTIMENT_SQL}) ELSE NULL END`;

// True only for rows with an actual written comment and a completed AI result.
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
// Turns a sentiment value into a plain tone: positive, negative, neutral, or none.
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
// Picks a badge color class for one topic string.
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
