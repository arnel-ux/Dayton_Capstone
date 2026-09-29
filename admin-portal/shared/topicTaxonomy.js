// Canonical Topic -> [Subtopic, ...] taxonomy for the Node/JS side of the
// admin portal, used by the Survey Result modal dropdowns and the analysis
// override endpoint. Keep this in sync with topic_common.py on the Python side.
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

// Splits a stored "{Topic} - {Item}" (or bare "{Topic}") string into { topic, subtopic }.
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

// Inverse of splitTopic: recombines a topic/subtopic pair back into one stored string.
function combineTopic(topic, subtopic) {
    if (!topic) return null;
    if (topic === "No Feedback") return "No Feedback";
    if (!subtopic || subtopic === "General") return topic;
    return `${topic} - ${subtopic}`;
}

module.exports = { TOPIC_TAXONOMY, SENTIMENT_VALUES, splitTopic, combineTopic };
