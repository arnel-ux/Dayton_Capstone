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
// by design — see topic_common.py's _transaction_subtopic) and "Unclassified"
// (whose one subtopic, "No Meaningful Feedback", is not a "General" case at
// all). The topic names and item labels below are kept textually in sync
// with topic_common.py's candidate_topics/TOPIC_ITEM_KEYWORDS by hand, since
// Python and Node can't literally share one source file across the language
// boundary — if the Python taxonomy changes, update this file to match.
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
    "Unclassified": ["No Meaningful Feedback"],
};

const SENTIMENT_VALUES = ["Positive", "Neutral", "Negative"];

// Splits a stored "{Topic} - {Item}" (or bare "{Topic}") string into
// { topic, subtopic } for display. A bare topic (no " - Item" suffix) means
// no specific item matched, which maps to the "General" subtopic — except
// "Unclassified", whose bare form always pairs with "No Meaningful Feedback"
// (there's no "General" case for it), and "General Feedback" itself, whose
// only subtopic is "General".
function splitTopic(topicString) {
    if (!topicString) return { topic: null, subtopic: null };
    const sepIndex = topicString.indexOf(" - ");
    if (sepIndex === -1) {
        if (topicString === "Unclassified") {
            return { topic: "Unclassified", subtopic: "No Meaningful Feedback" };
        }
        return { topic: topicString, subtopic: "General" };
    }
    return {
        topic: topicString.slice(0, sepIndex),
        subtopic: topicString.slice(sepIndex + 3),
    };
}

module.exports = { TOPIC_TAXONOMY, SENTIMENT_VALUES, splitTopic };
