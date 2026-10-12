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
//  10. SQD Overall Report Formula   (SQD_CRITICAL_SERVICE_OFFICE_IDS, sqdDimensionCountExprs, buildSqdOverallReport)
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


// ----------------------------------------------------------------------------
// 10. SQD OVERALL REPORT FORMULA (Per Service Quality Dimension)
// ----------------------------------------------------------------------------
// One office's score for one dimension = (Strongly Agree + Agree) / (answered, N/A left out) * 100.
// A dimension's score = the plain average of that office score across the offices that have an
// answer for it (an office with no answer for the dimension is N/A and is skipped, not counted as 0).
// OVERALL SCORE = the plain average of the 8 dimension scores.
// "Score by Critical Service" averages only the offices in SQD_CRITICAL_SERVICE_OFFICE_IDS;
// "Score in All Services" averages every active office.
// Critical service offices: Graduate School(16), CTHBM(15), CCS(13), CAS(11), CEA(10), CHS(14),
// CTDE(12), Student Testing and Admission(1), Student Registration and Records(3),
// Learning Resources(23), Guidance and Counseling(2), ACCESS(29), NSTP(40),
// Student Affairs and Services(18), Health Services Unit(4), General Services Unit(22), Cash Unit(5).
const SQD_CRITICAL_SERVICE_OFFICE_IDS = [16, 15, 13, 11, 10, 14, 12, 1, 3, 23, 2, 29, 40, 18, 4, 22, 5];

// Per-office agree/answered counts for each of the 8 dimensions.
function sqdDimensionCountExprs() {
    return SQD_DIMENSIONS.flatMap(d => [
        `SUM(CASE WHEN s.${d.col} IN (4,5) THEN 1 ELSE 0 END) AS ${d.col}_agree`,
        `SUM(CASE WHEN s.${d.col} BETWEEN 1 AND 5 THEN 1 ELSE 0 END) AS ${d.col}_ans`
    ]);
}

// Builds the report from per-office count rows ({ id, report_name, sqd1_agree, sqd1_ans, ... }).
// Also returns a worksheet (one row per counted office, one column per dimension) so the
// computation can be shown office by office, the same way the summary numbers were derived.
function buildSqdOverallReport(officeRows, interpretFn) {
    const mean = (values) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
    const fmt = (value) => value === null ? NO_DATA : value.toFixed(2);

    // One entry per office: its score for each dimension (null = no answers = N/A) and its own overall.
    // Offices with no answers at all are left out, they don't count toward any average.
    const offices = (officeRows || []).map(row => {
        const scores = SQD_DIMENSIONS.map(d => {
            const ans = Number(row[`${d.col}_ans`]);
            return ans > 0 ? Number(row[`${d.col}_agree`]) / ans * 100 : null;
        });
        return { id: row.id, name: row.report_name, scores, overall: mean(scores.filter(v => v !== null)) };
    }).filter(o => o.overall !== null);

    // Critical offices keep the order of SQD_CRITICAL_SERVICE_OFFICE_IDS (the printed template's order).
    const criticalOffices = SQD_CRITICAL_SERVICE_OFFICE_IDS
        .map(id => offices.find(o => o.id === id))
        .filter(Boolean);

    const dimensionMeans = (list) => SQD_DIMENSIONS.map((d, i) => mean(list.map(o => o.scores[i]).filter(v => v !== null)));
    const criticalMeans = dimensionMeans(criticalOffices);
    const allMeans = dimensionMeans(offices);
    const overallOf = (means) => mean(means.filter(v => v !== null));
    const cell = (value) => ({ score: fmt(value), interpretation: value === null ? NO_DATA : interpretFn(value) });

    const sheet = (list, means) => ({
        offices: list.map(o => ({ name: o.name, scores: o.scores.map(fmt), overall: fmt(o.overall) })),
        averages: means.map(fmt),
        overall: fmt(overallOf(means))
    });

    return {
        dimensions: SQD_DIMENSIONS.map((d, i) => ({ label: d.label, critical: fmt(criticalMeans[i]), all: fmt(allMeans[i]) })),
        overall: { critical: cell(overallOf(criticalMeans)), all: cell(overallOf(allMeans)) },
        worksheet: { critical: sheet(criticalOffices, criticalMeans), all: sheet(offices, allMeans) }
    };
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
    // 10. SQD Overall Report Formula
    SQD_CRITICAL_SERVICE_OFFICE_IDS, sqdDimensionCountExprs, buildSqdOverallReport,
};
