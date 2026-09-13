// Canonical Topic -> [Subtopic, ...] taxonomy for the Node/JS side of the
// admin portal (Survey Result modal dropdowns, the admin analysis-override
// endpoint's validation, and effective-topic display). This is the single
// taxonomy source on this side of the codebase — the modal's Topic/Subtopic
// dropdowns and the endpoint's allowlist both read from this one file rather
// than each hand-typing their own copy of the topic list.
//
// The AI classifier (admin-portal/ai_scripts/topic_common.py) is the
// authority for the actual keyword-matching logic and stores its result as a
// single "{Topic} - {Item}" string (or a bare "{Topic}" when no specific item
// matched — see splitTopic below). Every topic here has "General" listed
// first, representing exactly that "topic matched, no specific item" case,
// EXCEPT "Transaction" (whose three subtopics are already General/Slow/Fast
// by design — see topic_common.py's _transaction_subtopic) and "No Feedback"
// (whose one subtopic is also "No Feedback" — a comment that has nothing
// meaningful to classify, not a "General" case at all). The topic names and
// item labels below are kept textually in sync with topic_common.py's
// candidate_topics/TOPIC_ITEM_KEYWORDS by hand, since Python and Node can't
// literally share one source file across the language boundary — if the
// Python taxonomy changes, update this file to match.
//
// Both the Topic and Subtopic dropdowns also carry a trailing "Custom" entry
// (appended at render time, not stored in this object — see
// survey-records.ejs's populateSelect) that swaps the <select> for a free-text
// input, letting an admin type any topic/subtopic that isn't in this list.
// The PATCH /api/admin/survey-response/:id/analysis endpoint accepts any
// non-empty topic/subtopic string (within column length limits) for exactly
// this reason — it does not require the pair to appear together here.
const TOPIC_TAXONOMY = {
    "Queueing and Waiting Time": ["General", "Numbering System", "Long Lines"],
    "Transaction": ["General", "Slow", "Fast"],
    "Process Efficiency": ["General", "Complexity/Red Tape", "Simplicity"],
    "Ease of Use": ["General", "Confusing Design", "User-Friendly Design"],
    "Online System and Portal": ["General", "Login/Account", "Website", "System Errors/Bugs", "Online System"],
    "Internet Connection": ["General", "Wifi", "Signal"],
    "Aircon and Cooling": ["General", "Electric Fan", "Air Conditioning Unit", "Temperature/Ventilation"],
    "Restroom": ["General", "Supplies (Soap/Tissue)", "Restroom/CR"],
    "Cleanliness": ["General", "Restroom/CR", "Classroom", "Laboratory", "Library", "Canteen", "Clinic", "Waiting Area", "Hallway/Corridor", "Lobby", "Grounds", "Office"],
    "Seating and Furniture": ["General", "Chairs", "Tables", "Benches", "General Furniture"],
    "Power and Lighting": ["General", "Power Outage", "Lighting"],
    "Facilities and Equipment": ["General", "Appearance/Presentation", "Parking", "Library", "Dormitory/Housing", "Transportation", "Equipment/Machine", "Building/Structure"],
    "Courtesy and Attitude": ["General", "Accommodation/Assistance", "Security Guard", "Front Desk/Clerk", "Faculty/Adviser", "Student", "Staff/Employee"],
    "Staff Competence and Knowledge": ["General", "Training Gap", "Knowledge/Answer Accuracy"],
    "Fairness and Equal Treatment": ["General", "Favoritism", "Bias/Unequal Treatment"],
    "Bystanders and Loitering": ["General"],
    "Payment and Fees": ["General", "Official Receipt", "Tuition Fee", "Petty Cash Reimbursement/Liquidation", "Statement of Account", "Fees"],
    "Document and Credential Processing": ["General", "Transcript of Records", "Diploma", "Honorable Dismissal", "Good Moral Certificate", "Academic Records", "ID Card", "Grade Change/Correction", "HR Employee Records", "Certification", "Clearance"],
    "Enrollment and Registration": ["General", "Graduation", "Matriculation", "Cross-Enrollment", "Re-admission", "Shifting", "Entrance Examination", "Adding/Dropping of Subjects", "Enrollment/Registration Process"],
    "Communication and Information": ["General", "Inconsistent/Contradicting Information", "Schedule/Policy Changes", "Response to Inquiries", "Announcements"],
    "Health and Medical Services": ["General", "Dental Services", "Medical Certificate", "Medicine/Supplies", "Consultation/Check-up"],
    "Guidance and Counseling Services": ["General"],
    "Scholarship and Financial Assistance": ["General", "Financial Assistance/Grants-in-Aid", "Scholarship Application/Grant"],
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
// "Transaction" (whose raw AI form always spells out "Transaction - General",
// never bare — see _transaction_subtopic) and "No Feedback" (whose only
// subtopic, "No Feedback", is itself the bare form).
function combineTopic(topic, subtopic) {
    if (!topic) return null;
    if (topic === "No Feedback") return "No Feedback";
    if (topic !== "Transaction" && (!subtopic || subtopic === "General")) return topic;
    return `${topic} - ${subtopic}`;
}

module.exports = { TOPIC_TAXONOMY, SENTIMENT_VALUES, splitTopic, combineTopic };
