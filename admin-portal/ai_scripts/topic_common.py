"""
The AI topic/subtopic taxonomy — and ONLY the taxonomy, as of 2026-09-28 (see
below for where everything else moved). This is Gemini's entire
classification universe: gemini_model.py reads candidate_topics and
TOPIC_ITEM_KEYWORDS directly to build its prompt guide, its per-item
example-keyword hints, and its JSON schema's valid-output enum. Do not remove
or rename anything here without also checking gemini_model.py's
TOPIC_DESCRIPTIONS (which must have an entry for every topic listed here).

2026-09-28: junk/no-feedback detection (is_no_feedback, detect_junk_topic,
and the greeting/gibberish/keyboard-mash machinery behind it) moved out to
its own comment_filter package, so it's easy to find on its own — it never
belonged next to the taxonomy conceptually, it just lived here historically.
Import it as `from comment_filter import is_no_feedback, detect_junk_topic`.

2026-09-27: the keyword-based classification lexicon (TOPIC_KEYWORDS, the
sentiment word lists, keyword_topic_override, item_label_override,
lexicon_sentiment, fast_sentiment/fast_topic) was removed entirely. It was
the fallback classifier before the pure-AI classification project
(2026-09-22) and briefly a lexicon-first hybrid for offline-synced comments
after that, but neither role survived: online comments have called Gemini
exclusively since 2026-09-22, and offline-synced comments have too since
2026-09-25 (see analyze.py's module comment) — no production path has
classified a single comment via keyword matching since.

Designed around one rule: a Topic/Subtopic label must be SENTIMENT-NEUTRAL —
it names what the comment is ABOUT, never whether that thing was good or bad
(that judgment belongs entirely to the separate sentiment axis). The old
taxonomy violated this in a few places (e.g. "Transaction - Slow"/
"Transaction - Fast" baked a sentiment judgment into the subtopic itself),
which is exactly the pattern that taxonomy rewrite removed — "Transaction" is
folded into "Processing - Processing Time" and sentiment alone carries the
slow/fast verdict, matching every other topic's convention.

This taxonomy merges the previous physical-facility/behavioral topics with a
broader set of administrative/service-process topics covering the college's
non-facility offices (registrar, HR, cash unit, scholarships, ICT, library,
dormitory, travel orders, etc.), consolidating topics that meant the same
thing under one neutral name and removing duplicates.
"""
candidate_topics = [
    "Processing",
    "Service Procedure",
    "Requirements",
    "Approval Process",
    "Communication and Information",
    "Staff Service",
    "Documents and Records",
    "System and Access",
    "Ease of Use",
    "Internet Service",
    "Scheduling and Availability",
    "Financial Transaction",
    "Facilities and Resources",
    "Bystanders and Loitering",
    "Scholarship and Assistance",
    "Enrollment Process",
    "Academic Transaction",
    "Health Service",
    "Clearance Process",
    "Leave Process",
    "Accreditation Process",
    "Complaint Handling",
    "ID Services",
    "Dormitory Service",
    "Supplies and Resources",
    "Transportation Service",
    "Library Service",
    "Research Service",
    "General Service",
]

# ---------------------------------------------------------------------------
# SUBTOPICS (topic -> "{Topic} - {Specific Item}" labels), keyed by parent
# topic. Every item label is sentiment-neutral by design (see the taxonomy
# comment above) — an item never encodes whether the thing it names was good
# or bad, only what it was. Not every topic has a meaningful item breakdown;
# those without one stay at the plain topic label.
#
# The short keyword list under each item is NOT a matcher (see the module
# docstring) — it exists purely so gemini_model.py's _item_hint() can show
# Gemini a couple of concrete example words/phrases for what that label means
# (e.g. "Restroom Condition (e.g. tissue, sabon, banyo)"). An empty list is
# valid — see Complaint Handling/General Service below — Gemini still needs
# the label registered here to ever output it, even with no examples.
# ---------------------------------------------------------------------------
TOPIC_ITEM_KEYWORDS = {
    "Processing": [
        ("Processing - Waiting Time", [
            "pila", "linya", "queue", "queueing", "waiting line", "numero",
            "hintay", "naghintay", "naghihintay", "hinihintay", "hinintay",
            "pinaghihintayan", "maghintay",
            "antay", "umaantay", "inaantay", "antayin",
            "priority number", "numbering system",
        ]),
        ("Processing - Release Time", [
            "release ng resulta", "ma-release", "na-release", "release",
        ]),
        ("Processing - Processing Time", [
            "transaction", "pag-transact", "processing time",
            "processing",
        ]),
    ],
    "Service Procedure": [
        ("Service Procedure - Referral Process", [
            "referral", "irefer", "i-refer", "pinadala sa ibang office",
        ]),
        ("Service Procedure - Process Steps", [
            "maraming hakbang", "madaming hakbang", "kumplikado",
            "hassle-free", "hassle free", "walang abala", "walang hassle",
            "streamlined", "isang beses lang", "isang hakbang lang", "one-stop",
        ]),
        ("Service Procedure - Submission Process", [
            "proseso", "process",
        ]),
    ],
    "Requirements": [
        ("Requirements - Requirement Completeness", [
            "kulang na requirements", "incomplete requirements",
            "kulang sa requirements", "hindi kumpleto ang requirements",
        ]),
        ("Requirements - Eligibility", [
            "eligibility", "kwalipikado", "hindi kwalipikado",
            "hindi qualified", "not qualified", "not eligible",
        ]),
        ("Requirements - Requirement Clarity", [
            "requirements", "kakailanganin", "kailangang dokumento",
        ]),
    ],
    "Approval Process": [
        ("Approval Process - Signature/Endorsement", [
            "endorsement", "endorso", "signature", "pirma", "lagda",
        ]),
        ("Approval Process - Approval Status", [
            "pending approval", "hindi pa naaprubahan", "hindi pa na-approve",
        ]),
        ("Approval Process - Approval Time", [
            "approval", "aprubado", "approve", "na-approve", "ina-approve",
        ]),
    ],
    "Communication and Information": [
        ("Communication and Information - Inconsistent/Contradicting Information", [
            "iba-iba sagot", "iba't ibang sagot", "magkaibang sagot",
            "kanya-kanyang sagot", "conflicting information",
            "contradicting information", "inconsistent information",
            "nagkontra-kontra",
        ]),
        ("Communication and Information - Response to Inquiries", [
            "walang reply", "hindi sumasagot", "no response",
        ]),
        ("Communication and Information - Status Update", [
            "no update", "walang update", "no updates", "walang updates",
            "not informed", "nobody informed", "walang paalam",
        ]),
        ("Communication and Information - Announcements", [
            "announcement", "abiso", "notice", "paalala", "text blast",
        ]),
    ],
    "Staff Service": [
        ("Staff Service - Fairness/Equal Treatment", [
            "palakasan", "walang palakasan", "paboritism", "favoritism",
            "nepotism", "bias", "unfair", "hindi patas", "walang katarungan",
            "may kilala",
        ]),
        ("Staff Service - Staff Competence", [
            "hindi marunong", "hindi madunong", "walang alam", "not knowledgeable",
            "incompetent", "hindi sigurado sa sagot", "hindi sanay", "untrained",
            "kulang sa training", "hindi alam ng",
        ]),
        ("Staff Service - Technical Assistance", [
            "technical assistance", "it support", "tulong teknikal",
        ]),
        ("Staff Service - Staff Assistance", [
            "accommodate", "accommodating", "accommodation",
            "inasikaso", "inaasikaso", "aasikasuhin", "asikaso",
            "pinansin", "pinapansin", "entertained",
            "walang assistance", "walang tumutulong", "poor assistance",
            "poor service", "unhelpful", "not helpful",
        ]),
        ("Staff Service - Staff Courtesy", [
            "staff", "kawani", "empleyado", "employee", "guard", "security",
            "clerk", "faculty", "professor",
            "bastos", "hindi magalang", "suplado", "suplada", "masungit",
            "mabait", "mababait", "magalang", "magagalang", "courteous",
            "respectful", "approachable", "friendly",
            "masusungit", "rude", "disrespectful", "unfriendly",
        ]),
    ],
    "Documents and Records": [
        ("Documents and Records - Transcript of Records", [
            "transcript", "tor", "transcript of records",
        ]),
        ("Documents and Records - Diploma", ["diploma", "diploma ko"]),
        ("Documents and Records - Honorable Dismissal", ["honorable dismissal"]),
        ("Documents and Records - Good Moral Certificate", ["good moral"]),
        ("Documents and Records - Academic Records", [
            "form 137", "form 138", "certificate of grades",
        ]),
        ("Documents and Records - HR Employee Records", [
            "certificate of employment", "service record", "personnel record",
            "201 file",
        ]),
        ("Documents and Records - Certification", [
            "certification", "certificate", "cav",
        ]),
    ],
    "System and Access": [
        ("System and Access - Login Access", [
            "log-in", "login", "log in", "online account",
        ]),
        ("System and Access - Account Activation", [
            "account activation", "i-activate",
        ]),
        ("System and Access - Account Recovery", [
            "account recovery", "forgot password", "reset password",
        ]),
        ("System and Access - System Availability", [
            "glitch", "glitchy", "buggy", "crashed", "crashing", "nag-crash",
            "nag-hang", "hanging", "nag-error", "system error",
        ]),
        ("System and Access - Account Access", [
            "portal", "sias", "online form", "online system", "e-services",
            "e-portal", "website", "web site",
        ]),
    ],
    "Ease of Use": [
        ("Ease of Use - Form/Portal Usability", [
            "user-friendly", "user friendly", "madaling gamitin",
            "mahirap gamitin", "nakakalito", "nalilito", "confusing na sundin",
        ]),
    ],
    "Internet Service": [
        ("Internet Service - Account Renewal", [
            "internet subscription", "renewal of internet",
        ]),
        ("Internet Service - Connectivity", [
            "wifi", "wi-fi", "signal", "network", "walang signal", "koneksyon",
            "walang internet",
        ]),
        ("Internet Service - Service Availability", [
            "internet", "internet access",
        ]),
    ],
    "Scheduling and Availability": [
        ("Scheduling and Availability - Exam Schedule", [
            "exam schedule", "entrance exam schedule",
        ]),
        ("Scheduling and Availability - Appointment Availability", [
            "appointment", "walang appointment",
        ]),
        ("Scheduling and Availability - Service Availability", [
            "schedule", "iskedyul", "walang schedule",
            "walang available na slot", "no available slot", "fully booked",
        ]),
    ],
    "Financial Transaction": [
        ("Financial Transaction - Official Receipt", ["resibo", "official receipt"]),
        ("Financial Transaction - Tuition Fee", ["tuition", "tuition fee"]),
        ("Financial Transaction - Reimbursement Process", ["reimbursement"]),
        ("Financial Transaction - Liquidation Process", ["liquidation", "petty cash"]),
        ("Financial Transaction - Account Balance", [
            "statement of account", "account balance",
        ]),
        ("Financial Transaction - Remittance Processing", ["remittance"]),
        ("Financial Transaction - Claim Processing", ["claim for payment"]),
        ("Financial Transaction - Payment Processing", [
            "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
            "fee", "fees", "singil", "kabayaran", "sobrang mahal ang bayad",
        ]),
    ],
    "Facilities and Resources": [
        ("Facilities and Resources - Aircon/Cooling", [
            "electric fan", "bentilador", "pabentilador",
            "aircon", "air-con", "air condition", "aircondition", "air conditioning",
            "walang aircon", "walang air con", "sira ang aircon", "sirang aircon",
            "mahina ang aircon", "mahina aircon",
            "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
            "masyadong mainit", "too hot", "very hot", "hot room", "hot office",
            "stuffy", "kulob", "maalinsangan", "malamig", "sobrang lamig",
            "napakalamig", "too cold", "very cold", "walang ventilation",
            "poor ventilation", "kulang ventilation", "walang bentilasyon",
        ]),
        ("Facilities and Resources - Restroom Condition", [
            "tissue", "sabon",
            "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        ]),
        ("Facilities and Resources - Cleanliness", [
            "kalinisan", "cleanliness", "malinis",
            "marumi", "rumi", "dumi", "madumi",
            "makalat", "kalat", "magulo",
            "dirty", "unclean", "not clean",
            "maalikabok", "alikabok", "dusty",
            "mabaho", "ambaho", "napakabaho",
            "napaka baho", "sobrang baho", "ang baho",
            "masyadong mabaho", "masangsang", "mabahong amoy",
            "amoy mabaho", "smelly", "stinky",
            "foul smell", "bad smell", "unsanitary",
            "poor sanitation", "filthy", "messy",
            "napakalinis", "napaka linis", "sobrang linis",
            "maayos at malinis", "well cleaned", "sanitary",
        ]),
        ("Facilities and Resources - Seating/Furniture", [
            "upuan", "silya", "mesa", "bangko", "furniture", "chairs", "seats", "muwebles",
        ]),
        ("Facilities and Resources - Power/Lighting", [
            "kuryente", "ilaw", "brownout", "blackout", "lighting", "power outage",
            "walang kuryente",
        ]),
        ("Facilities and Resources - Equipment/Machine", [
            "kagamitan", "equipment", "makina", "aparatus", "printer",
            "computer lab", "computer laboratory", "computer shop",
        ]),
        ("Facilities and Resources - Appearance/Condition", [
            "pangit", "pangit tignan", "pangit tingnan",
            "di magandang tignan", "hindi magandang tignan",
            "di magandang tingnan", "hindi magandang tingnan",
            "di kaaya aya", "hindi kaaya aya", "kaaya aya",
            "kaaya-aya", "hindi presentable", "di presentable",
            "unpresentable", "unattractive",
            "unpleasant looking", "poor appearance",
            "poorly maintained",
            "maayos tignan", "maayos tingnan",
            "pleasant looking", "well maintained",
        ]),
        ("Facilities and Resources - Building/Structure", ["istruktura"]),
        ("Facilities and Resources - Parking", ["parking", "paradahan"]),
        ("Facilities and Resources - Resource Availability", ["pasilidad", "facilities"]),
    ],
    "Scholarship and Assistance": [
        ("Scholarship and Assistance - Grant Amount", [
            "mali ang amount", "mali yung amount", "maling amount",
            "mali ang halaga", "mali yung halaga", "maling halaga",
            "kulang ang amount", "kulang yung amount", "kulang na amount",
            "kulang ang halaga", "kulang yung halaga", "kulang na halaga",
            "grant",
        ]),
        ("Scholarship and Assistance - Application Process", [
            "scholarship", "iskolarship", "iskolar", "scholar",
        ]),
        ("Scholarship and Assistance - Grant Release", [
            "financial assistance", "grants-in-aid", "scholarship grant",
        ]),
    ],
    "Enrollment Process": [
        ("Enrollment Process - Matriculation", ["matriculation"]),
        ("Enrollment Process - Cross-Enrollment", ["cross-enrollment"]),
        ("Enrollment Process - Re-admission", ["re-admission"]),
        ("Enrollment Process - Shifting", ["shifting", "mag-shift", "nag-shift"]),
        ("Enrollment Process - Enrollment Procedure", [
            "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
            "magpapatala", "ipatala", "registration", "rehistrasyon",
        ]),
    ],
    "Academic Transaction": [
        ("Academic Transaction - Subject Adjustment", [
            "add/drop", "adding of subjects", "dropping of subjects",
            "drop subject", "dropping subject",
        ]),
        ("Academic Transaction - Grade Correction", [
            "grade change", "correction of grades", "change of grade",
        ]),
        ("Academic Transaction - Graduation Application", [
            "graduation", "commencement", "graduating",
        ]),
        ("Academic Transaction - Entrance Examination", [
            "entrance exam", "entrance examination", "college entrance exam",
        ]),
    ],
    "Health Service": [
        ("Health Service - Dental Services", ["dentista", "dentist", "dental"]),
        ("Health Service - Certificate Release", ["medical certificate"]),
        ("Health Service - Medicine/Supplies", ["gamot"]),
        ("Health Service - Consultation/Treatment", [
            "clinic", "klinika", "doktor", "doctor", "nurse", "nars",
            "konsultasyon", "check-up", "checkup", "medical consultation",
        ]),
    ],
    "Clearance Process": [
        ("Clearance Process - Clearance Status", ["clearance"]),
    ],
    "Leave Process": [
        ("Leave Process - Leave Application", [
            "leave of absence", "sick leave", "vacation leave", "bakasyon leave",
        ]),
    ],
    "Accreditation Process": [
        ("Accreditation Process - Accreditation Status", [
            "accreditation", "akreditasyon", "accredit",
        ]),
    ],
    "Complaint Handling": [
        ("Complaint Handling - Response", []),
        ("Complaint Handling - Follow-up", []),
        ("Complaint Handling - Resolution Process", ["grievance", "sumbong", "hinaing"]),
    ],
    "ID Services": [
        ("ID Services - ID Printing", ["id printing", "employee id"]),
        ("ID Services - ID Application", [
            "identification card", "id card", "school id",
        ]),
    ],
    "Dormitory Service": [
        ("Dormitory Service - Bed Space Availability", [
            "dormitory", "dorm", "bed space", "boarding house",
        ]),
    ],
    "Supplies and Resources": [
        ("Supplies and Resources - Item Availability", [
            "supplies", "materials", "accountable forms", "office supplies",
        ]),
    ],
    "Transportation Service": [
        ("Transportation Service - Vehicle Availability", [
            "transportation", "sasakyan", "service vehicle", "shuttle",
        ]),
    ],
    "Library Service": [
        ("Library Service - Return Process", [
            "pagsauli ng libro", "returning books",
        ]),
        ("Library Service - Borrowing Process", [
            "borrowing", "hiram ng libro", "librong hiniram",
        ]),
        ("Library Service - Book Availability", [
            "library", "aklatan", "libro", "book", "books",
        ]),
    ],
    "Research Service": [
        ("Research Service - Research Assistance", [
            "research assistance", "pananaliksik", "research consultation",
        ]),
    ],
    # No keyword examples at all — these are reachable only through Gemini's
    # own judgment (see the module docstring). Still registered here so
    # gemini_model.ALL_TOPICS includes them as valid outputs, matching
    # shared/topicTaxonomy.js's admin-override dropdown.
    "General Service": [
        ("General Service - Service Information", []),
        ("General Service - Service Accessibility", []),
        ("General Service - Overall Process", []),
    ],
}


GENERAL_FEEDBACK = "General Feedback"
