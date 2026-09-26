// Canonical Topic -> [Subtopic, ...] taxonomy for the Node/JS side of the
// admin portal (Survey Result modal dropdowns, the admin analysis-override
// endpoint's validation, and effective-topic display). This is the single
// taxonomy source on this side of the codebase — the modal's Topic/Subtopic
// dropdowns and the endpoint's allowlist both read from this one file rather
// than each hand-typing their own copy of the topic list.
//
// Rewritten 2026-09-22 (pure-AI classification project) around one rule:
// every Topic/Subtopic name is SENTIMENT-NEUTRAL — it names what the comment
// is about, never whether that thing was good or bad (sentiment is the
// separate axis that carries that judgment). This is also why "Transaction"
// no longer gets its own General/Slow/Fast subtopics (that baked a sentiment
// judgment into the subtopic itself) — it's folded into "Processing -
// Processing Time", with sentiment alone carrying the slow/fast verdict, the
// same as every other topic.
//
// The AI classifier (admin-portal/ai_scripts/topic_common.py) is the
// authority for the actual keyword-matching logic and stores its result as a
// single "{Topic} - {Item}" string (or a bare "{Topic}" when no specific item
// matched — see splitTopic below). Every topic here has "General" listed
// first, representing exactly that "topic matched, no specific item" case,
// EXCEPT "No Feedback" (whose one subtopic is also "No Feedback" — a comment
// that has nothing meaningful to classify, not a "General" case at all). The
// topic names and item labels below are kept textually in sync with
// topic_common.py's candidate_topics/TOPIC_ITEM_KEYWORDS by hand, since
// Python and Node can't literally share one source file across the language
// boundary — if the Python taxonomy changes, update this file to match.
//
// Both the Topic and Subtopic dropdowns also carry a trailing "Custom" entry
// (appended at render time, not stored in this object — see
// survey-records.ejs's populateSelect) that swaps the <select> for a free-text
// input, letting an admin type any topic/subtopic that isn't in this list.
// The PATCH /api/admin/survey-response/:id/analysis endpoint accepts any
// non-empty topic/subtopic string (within column length limits) for exactly
// this reason — it does not require the pair to appear together here.
const TOPIC_TAXONOMY = {
    "Processing": ["General", "Waiting Time", "Release Time", "Processing Time"],
    "Service Procedure": ["General", "Referral Process", "Process Steps", "Submission Process"],
    "Requirements": ["General", "Requirement Completeness", "Eligibility", "Requirement Clarity"],
    "Approval Process": ["General", "Signature/Endorsement", "Approval Status", "Approval Time"],
    "Communication and Information": ["General", "Inconsistent/Contradicting Information", "Response to Inquiries", "Status Update", "Announcements"],
    "Staff Service": ["General", "Fairness/Equal Treatment", "Staff Competence", "Technical Assistance", "Staff Assistance", "Staff Courtesy"],
    "Documents and Records": ["General", "Transcript of Records", "Diploma", "Honorable Dismissal", "Good Moral Certificate", "Academic Records", "HR Employee Records", "Certification"],
    "System and Access": ["General", "Login Access", "Account Activation", "Account Recovery", "System Availability", "Account Access"],
    "Ease of Use": ["General", "Form/Portal Usability"],
    "Internet Service": ["General", "Account Renewal", "Connectivity", "Service Availability"],
    "Scheduling and Availability": ["General", "Exam Schedule", "Appointment Availability", "Service Availability"],
    "Financial Transaction": ["General", "Official Receipt", "Tuition Fee", "Reimbursement Process", "Liquidation Process", "Account Balance", "Remittance Processing", "Claim Processing", "Payment Processing"],
    "Facilities and Resources": ["General", "Aircon/Cooling", "Restroom Condition", "Cleanliness", "Seating/Furniture", "Power/Lighting", "Equipment/Machine", "Appearance/Condition", "Building/Structure", "Parking", "Resource Availability"],
    "Bystanders and Loitering": ["General"],
    "Scholarship and Assistance": ["General", "Grant Amount", "Application Process", "Grant Release"],
    "Enrollment Process": ["General", "Matriculation", "Cross-Enrollment", "Re-admission", "Shifting", "Enrollment Procedure"],
    "Academic Transaction": ["General", "Subject Adjustment", "Grade Correction", "Graduation Application", "Entrance Examination"],
    "Health Service": ["General", "Dental Services", "Certificate Release", "Medicine/Supplies", "Consultation/Treatment"],
    "Clearance Process": ["General"],
    "Leave Process": ["General"],
    "Accreditation Process": ["General"],
    "Complaint Handling": ["General", "Response", "Follow-up", "Resolution Process"],
    "ID Services": ["General", "ID Printing", "ID Application"],
    "Dormitory Service": ["General"],
    "Supplies and Resources": ["General"],
    "Transportation Service": ["General"],
    "Library Service": ["General", "Return Process", "Borrowing Process", "Book Availability"],
    "Research Service": ["General"],
    "General Service": ["General", "Service Information", "Service Accessibility", "Overall Process"],
    "General Feedback": ["General"],
    "No Feedback": ["No Feedback"],
};

const SENTIMENT_VALUES = ["Positive", "Neutral", "Negative", "No Sentiment"];

// Splits a stored "{Topic} - {Item}" (or bare "{Topic}") string into
// { topic, subtopic } for display. A bare topic (no " - Item" suffix) means
// no specific item matched, which maps to the "General" subtopic — except
// "No Feedback", whose bare form always pairs with the "No Feedback" subtopic
// (there's no "General" case for it), and "General Feedback" itself, whose
// only subtopic is "General".
//
// "Unclassified" / "Unclassified - No Meaningful Feedback" are normalized to
// "No Feedback" / "No Feedback" here too — that was this topic's name before
// it was renamed to match the "No Feedback" wording used everywhere else in
// the admin UI. Rows classified before the rename still hold the old string
// in the database, and this keeps them displaying correctly forever without
// a data migration.
function splitTopic(topicString) {
    if (!topicString) return { topic: null, subtopic: null };
    const sepIndex = topicString.indexOf(" - ");
    if (sepIndex === -1) {
        if (topicString === "Unclassified" || topicString === "No Feedback") {
            return { topic: "No Feedback", subtopic: "No Feedback" };
        }
        return { topic: topicString, subtopic: "General" };
    }
    let topic = topicString.slice(0, sepIndex);
    let subtopic = topicString.slice(sepIndex + 3);
    if (topic === "Unclassified") {
        topic = "No Feedback";
        subtopic = "No Feedback";
    }
    return { topic, subtopic };
}

// Inverse of splitTopic: recombines an (admin-overridden) topic/subtopic pair
// back into the same "{Topic} - {Item}" storage format the AI classifier
// uses, so report/dashboard queries that group or display by the raw topic
// string stay consistent whether a row was AI-classified or admin-corrected.
// A null/undefined subtopic, or the "General" subtopic, collapses to the bare
// topic — mirroring splitTopic's bare-form handling above — EXCEPT
// "No Feedback" (whose only subtopic, "No Feedback", is itself the bare
// form).
function combineTopic(topic, subtopic) {
    if (!topic) return null;
    if (topic === "No Feedback") return "No Feedback";
    if (!subtopic || subtopic === "General") return topic;
    return `${topic} - ${subtopic}`;
}

module.exports = { TOPIC_TAXONOMY, SENTIMENT_VALUES, splitTopic, combineTopic };
