"""
Shared taxonomy, keyword anchors, and lightweight heuristics used by both
analyze.py (CLI / standalone fallback) and heavy_model.py (persistent
model-server path). Keeping this in one module means the fast/offline
heuristic path and the full model path can never silently drift apart.
"""
import re

# ---------------------------------------------------------------------------
# NO-FEEDBACK DETECTION — must run BEFORE any lexicon/AI classification.
# A blank comment or an explicit "nothing to say" placeholder ("N/A", "none",
# "no comment", ...) has no actual content to classify — forcing it through
# the lexicon/AI pipeline previously produced a fabricated "General Feedback
# / Neutral" result, which reads to an admin as a real (if generic) opinion
# rather than "this respondent didn't write anything." Callers (analyze.py,
# model_server.py, server.js's analyzeComment) must check this FIRST and
# short-circuit to no classification at all (topic=None, sentiment=None) —
# see each caller for how that maps to the database (NULL, not a string).
# ---------------------------------------------------------------------------
NO_FEEDBACK_PHRASES = {
    "na", "n/a", "none", "nil", "no comment", "no comments", "not applicable",
}


def is_no_feedback(text):
    """
    True for a blank/whitespace-only comment, or one of the common "nothing
    to say" placeholders in any case/spacing and with or without periods or
    dashes — "N/A", "n/a", "NA", "N.A.", "None", "NONE", "nil", "Nil",
    "No Comment", "not applicable", "-", "--", "..." all normalize to a
    match here. Anything with real content (even a single real word) is not
    a no-feedback comment, however short.
    """
    if text is None:
        return True
    trimmed = str(text).strip()
    if trimmed == "":
        return True
    # Dashes/periods stripped before comparing: "N.A." -> "na", "--"/"..." -> ""
    # (caught by the blank check below), without touching real words that
    # merely contain a period/dash elsewhere (e.g. "wi-fi", "e.g." in a real
    # sentence never reduce to one of the exact phrases below).
    stripped = re.sub(r'[.\-]', '', trimmed.lower())
    stripped = re.sub(r'\s+', ' ', stripped).strip()
    if stripped == "":
        return True
    return stripped in NO_FEEDBACK_PHRASES

# ---------------------------------------------------------------------------
# HYPHEN-TOLERANT KEYWORD MATCHING
# Real feedback typed by Filipino users on a phone keyboard very often drops
# hyphens ("naghang" / "nag hang" instead of "nag-hang", "wifi" instead of
# "wi-fi") — added 2026-08-30 after finding "nag-hang"/"nag-crash" wouldn't
# match the far more common unhyphenated typing. Rather than hand-listing 2-3
# spelling variants of every hyphenated keyword in every list below (easy to
# forget on the next addition), every keyword's hyphen is compiled as an
# OPTIONAL separator that also matches a space or nothing at all — so a
# single entry like "nag-hang" already covers "nag-hang", "nag hang", and
# "naghang" everywhere keywords are matched (TOPIC_KEYWORDS,
# TOPIC_ITEM_KEYWORDS, the sentiment lexicon, neutral phrases, and collision
# phrases all go through this one helper).
# ---------------------------------------------------------------------------
def _kw_pattern(kw):
    escaped = re.escape(kw).replace('\\-', '[- ]?')
    return r'\b' + escaped + r'\b'


def _matched_spans(lowered, keywords):
    """
    Non-overlapping (start, end, weight) match spans for a keyword list
    (plain strings, weight 1, or (keyword, weight) tuples). When two
    keywords in the SAME list match overlapping text — e.g. "wifi" and
    "wi-fi" both matching the same word now that _kw_pattern treats the
    hyphen as optional, or a pre-existing intentional duplicate like
    "one-stop"/"one stop" — only the first-listed keyword's match is kept,
    so one real mention is never double-counted as two hits. Added
    2026-08-30 alongside _kw_pattern: hyphen-tolerant matching would
    otherwise silently inflate counts for every keyword list that already
    carries both a hyphenated and unhyphenated spelling of the same term.
    """
    spans = []
    for entry in keywords:
        kw, weight = entry if isinstance(entry, tuple) else (entry, 1)
        for m in re.finditer(_kw_pattern(kw), lowered):
            s, e = m.start(), m.end()
            if any(s < e2 and e > s2 for s2, e2, _ in spans):
                continue
            spans.append((s, e, weight))
    return spans


# ---------------------------------------------------------------------------
# TOPIC TAXONOMY (rewritten 2026-09-22 — pure-AI classification project)
#
# Redesigned around one rule: a Topic/Subtopic label must be SENTIMENT-NEUTRAL
# — it names what the comment is ABOUT, never whether that thing was good or
# bad (that judgment belongs entirely to the separate sentiment axis). The old
# taxonomy violated this in a few places (e.g. "Transaction - Slow"/
# "Transaction - Fast" baked a sentiment judgment into the subtopic itself),
# which is exactly the pattern this rewrite removes — see the former
# _transaction_subtopic, now deleted; "Transaction" is folded into
# "Processing - Processing Time" and sentiment alone carries the slow/fast
# verdict, matching every other topic's convention.
#
# This taxonomy merges the previous physical-facility/behavioral topics
# (which already had well-tuned Taglish keyword coverage — kept largely
# as-is below) with a broader set of administrative/service-process topics
# covering the college's non-facility offices (registrar, HR, cash unit,
# scholarships, ICT, library, dormitory, travel orders, etc.), consolidating
# topics that meant the same thing under one neutral name and removing
# duplicates. Topics with no keyword list below are intentionally
# keyword-free — Gemini (the classifier for online comments, and the
# fallback for offline comments the lexicon doesn't anchor) is the only
# thing that ever resolves them; hand-authoring exhaustive Taglish keyword
# coverage for every administrative micro-category is not worth the
# maintenance cost the old lexicon-first design paid for the common,
# high-volume categories below.
# ---------------------------------------------------------------------------
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
# TAGLISH KEYWORD ANCHORS
# Only object nouns or unambiguous compound phrases are used as anchors —
# never bare descriptors like "mabagal"/"mahina"/"malinis" alone, since those
# are ambiguous across every category and would misfire. A keyword hit here
# wins the topic outright over Gemini (see keyword_topic_override) — as of
# 2026-09-25 (see analyze.py's module comment), no production classification
# path calls this at all anymore; both online and offline comments go
# straight to Gemini (see heavy_model.analyze_pure_ai). This dict is only
# still consulted by the junk-detector's "is this actually real vocabulary"
# guard below, and by test_accuracy.py's lexicon-only scoring.
# ---------------------------------------------------------------------------
TOPIC_KEYWORDS = {
    "Processing": [
        "pila", "linya", "queue", "queueing", "waiting line", "numero",
        "hintay", "naghintay", "naghihintay", "hinihintay", "hinintay",
        "pinaghihintayan", "maghintay",
        "antay", "umaantay", "inaantay", "antayin",
        "priority number", "numbering system",
        "transaction", "pag-transact", "processing time",
        "release ng resulta", "ma-release", "na-release",
        ("processing", 0.75),
    ],
    "Service Procedure": [
        "hassle-free", "hassle free", "walang abala", "walang hassle",
        "streamlined", "isang beses lang", "isang hakbang lang", "one-stop",
        "maraming hakbang", "madaming hakbang", "kumplikado",
        ("proseso", 0.5), ("process", 0.5),
        "referral", "irefer", "i-refer", "pinadala sa ibang office",
    ],
    "Requirements": [
        "requirements", "kakailanganin", "kailangang dokumento",
        "kulang na requirements", "incomplete requirements",
        "kulang sa requirements", "hindi kumpleto ang requirements",
        "eligibility", "kwalipikado", "hindi kwalipikado",
        "hindi qualified", "not qualified", "not eligible",
    ],
    "Approval Process": [
        "approval", "aprubado", "approve", "na-approve", "ina-approve",
        "endorsement", "endorso", "signature", "pirma", "lagda",
        "pending approval", "hindi pa naaprubahan", "hindi pa na-approve",
    ],
    "Communication and Information": [
        "impormasyon", "information", "communication", "announcement", "abiso",
        "notice", "paalala", "text blast", "walang paalam", "walang reply",
        "hindi sumasagot", "no response", "not informed", "nobody informed",
        "no update", "walang update", "no updates", "walang updates", "email",
        "iba-iba sagot", "iba't ibang sagot", "magkaibang sagot",
        "kanya-kanyang sagot", "conflicting information",
        "contradicting information", "inconsistent information",
        "nagkontra-kontra",
    ],
    "Staff Service": [
        # Fairness/equal-treatment anchors
        "palakasan", "walang palakasan", "paboritism", "favoritism",
        "nepotism", "bias", "unfair", "hindi patas", "walang katarungan",
        "may kilala",
        # Competence/knowledge anchors
        "hindi marunong", "hindi madunong", "walang alam", "not knowledgeable",
        "incompetent", "hindi alam ng",
        "hindi sanay", "untrained", "kulang sa training", "hindi sigurado sa sagot",
        "hindi updated", "hindi na updated", "hindi pa updated", "outdated",
        ("sanay", 0.5),
        # Assistance/accommodation anchors
        "accommodate", "accommodating", "accommodation",
        "inasikaso", "inaasikaso", "aasikasuhin", "asikaso",
        "pinansin", "pinapansin", "entertained",
        "walang assistance", "walang tumutulong", "poor assistance",
        "poor service", "bad attitude", "unhelpful", "not helpful",
        "technical assistance", "it support", "tulong teknikal",
        # Generic courtesy/demeanor anchors (role nouns weighted low, same as
        # before, so synonym-stacking on one person never outranks a specific
        # complaint elsewhere)
        ("staff", 0.5), ("staffs", 0.5), ("kawani", 0.5), ("empleyado", 0.5),
        ("tauhan", 0.5), ("employee", 0.5), ("receptionist", 0.5),
        ("guard", 0.5), ("security", 0.5), ("clerk", 0.5), ("faculty", 0.5),
        ("professor", 0.5), ("guro", 0.5), ("adviser", 0.5),
        ("ma'am", 0.5), ("sir", 0.5),
        "bastos", "hindi magalang", "suplado", "suplada", "masungit",
        "mabait", "mababait", "magalang", "magagalang", "courteous",
        "respectful", "approachable", "friendly",
        "masusungit", "rude", "disrespectful", "unfriendly",
    ],
    "Documents and Records": [
        "transcript", "tor", "diploma", "certification", "certificate",
        "credentials", "cav", "transcript of records", "honorable dismissal",
        "diploma ko", "good moral", "form 137", "form 138",
        "certificate of grades", "identification card", "id card", "school id",
        "leave of absence", "certificate of employment", "service record",
        "personnel record", "201 file",
    ],
    "System and Access": [
        "portal", "website", "web site", "sias", "online system",
        "log-in", "login", "log in", "e-services", "e-portal", "online account",
        ("online form", 0.75),
        "glitch", "glitchy", "buggy", "crashed", "crashing", "nag-crash",
        "nag-hang", "hanging", "nag-error", "system error",
        "account activation", "i-activate", "account recovery",
        "forgot password", "reset password",
    ],
    "Ease of Use": [
        ("user-friendly", 1.5), ("user friendly", 1.5),
        "madaling gamitin",
        "mahirap gamitin", "nakakalito", "nalilito", "confusing na sundin",
    ],
    "Internet Service": [
        "internet", "wifi", "wi-fi", "signal", "network", "koneksyon",
        "walang signal", "walang internet", "internet access",
        "internet subscription", "renewal of internet",
    ],
    "Scheduling and Availability": [
        "schedule", "iskedyul", "appointment", "walang schedule",
        "walang appointment", "exam schedule", "entrance exam schedule",
        "walang available na slot", "no available slot", "fully booked",
    ],
    "Financial Transaction": [
        "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
        "fee", "fees", "singil", "kabayaran", "resibo",
        "official receipt", "sobrang mahal ang bayad", "tuition", "tuition fee",
        "petty cash", "reimbursement", "liquidation", "statement of account",
        "account balance", "remittance", "claim for payment",
    ],
    "Facilities and Resources": [
        # Aircon/cooling
        "aircon", "air-con", "air condition", "aircondition", "air conditioning",
        "electric fan", "bentilador", "pabentilador",
        "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
        "masyadong mainit", "too hot", "very hot", "hot room", "hot office",
        "stuffy", "kulob", "maalinsangan",
        "malamig", "sobrang lamig", "napakalamig", "too cold", "very cold",
        "walang aircon", "walang air con", "sira ang aircon", "sirang aircon",
        "mahina ang aircon", "mahina aircon", "walang ventilation",
        "poor ventilation", "kulang ventilation", "walang bentilasyon",
        # Restroom
        "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        "tissue", "sabon",
        # Cleanliness (general, not restroom-specific)
        ("kalinisan", 1.5), ("cleanliness", 1.5), ("malinis", 1.5),
        ("marumi", 1.5), ("rumi", 1.5), ("dumi", 1.5), ("madumi", 1.5),
        ("makalat", 1.5), ("kalat", 1.5), ("magulo", 1.5),
        ("dirty", 1.5), ("unclean", 1.5), ("not clean", 1.5),
        ("maalikabok", 1.5), ("alikabok", 1.5), ("dusty", 1.5),
        ("mabaho", 1.5), ("ambaho", 1.5), ("napakabaho", 1.5),
        ("napaka baho", 1.5), ("sobrang baho", 1.5), ("ang baho", 1.5),
        ("masyadong mabaho", 1.5), ("masangsang", 1.5), ("mabahong amoy", 1.5),
        ("amoy mabaho", 1.5), ("smelly", 1.5), ("stinky", 1.5),
        ("foul smell", 1.5), ("bad smell", 1.5), ("unsanitary", 1.5),
        ("poor sanitation", 1.5), ("filthy", 1.5), ("messy", 1.5),
        ("napakalinis", 1.5), ("napaka linis", 1.5), ("sobrang linis", 1.5),
        ("maayos at malinis", 1.5), ("well cleaned", 1.5), ("sanitary", 1.5),
        # Seating and furniture
        "upuan", "silya", "mesa", "bangko", "furniture", "chairs", "seats", "muwebles",
        # Power and lighting
        "kuryente", "ilaw", "brownout", "blackout", "lighting", "power outage",
        "walang kuryente",
        # Equipment/appearance/building/parking (excludes library/dormitory/
        # transportation, which are their own topics below)
        "pasilidad", "kagamitan", "equipment", "facilities", "aparatus",
        "makina", "istruktura", "parking", "paradahan", "printer",
        "computer lab", "computer laboratory", "computer shop",
        ("pangit", 1.5), ("pangit tignan", 1.5), ("pangit tingnan", 1.5),
        ("di magandang tignan", 1.5), ("hindi magandang tignan", 1.5),
        ("di magandang tingnan", 1.5), ("hindi magandang tingnan", 1.5),
        ("di kaaya aya", 1.5), ("hindi kaaya aya", 1.5), ("kaaya aya", 1.5),
        ("kaaya-aya", 1.5), ("hindi presentable", 1.5), ("di presentable", 1.5),
        ("unpresentable", 1.5), ("unattractive", 1.5),
        ("unpleasant looking", 1.5), ("poor appearance", 1.5),
        ("poorly maintained", 1.5),
        ("maayos tignan", 1.5), ("maayos tingnan", 1.5),
        ("pleasant looking", 1.5), ("well maintained", 1.5),
    ],
    "Bystanders and Loitering": [
        "tambay", "nakatambay", "istambay", "mga tambay", "standby",
        "mga standby", "loitering", "loiterers",
        "tumatambay", "tumambay", "tatambay", "nagtatambay", "nagtambay",
    ],
    "Scholarship and Assistance": [
        "scholarship", "iskolarship", "iskolar", "scholar",
        "financial assistance", "grants-in-aid", "scholarship grant", "grant",
        ("mali ang amount", 1.5), ("mali yung amount", 1.5), ("maling amount", 1.5),
        ("mali ang halaga", 1.5), ("mali yung halaga", 1.5), ("maling halaga", 1.5),
        ("kulang ang amount", 1.5), ("kulang yung amount", 1.5), ("kulang na amount", 1.5),
        ("kulang ang halaga", 1.5), ("kulang yung halaga", 1.5), ("kulang na halaga", 1.5),
    ],
    "Enrollment Process": [
        "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
        "magpapatala", "ipatala", "registration", "rehistrasyon",
        "matriculation", "cross-enrollment", "re-admission", "shifting",
        "mag-shift", "nag-shift",
    ],
    "Academic Transaction": [
        "add/drop", "adding of subjects", "dropping of subjects",
        "drop subject", "dropping subject",
        "grade change", "correction of grades", "change of grade",
        "graduation", "commencement", "graduating",
        "entrance exam", "entrance examination", "college entrance exam",
    ],
    "Health Service": [
        "clinic", "klinika", "doktor", "doctor", "dentista", "dentist",
        "dental", "medical certificate", "gamot", "nurse", "nars",
        "konsultasyon", "check-up", "checkup", "medical consultation",
    ],
    "Clearance Process": [
        "clearance",
    ],
    "Leave Process": [
        "leave of absence", "sick leave", "vacation leave", "bakasyon leave",
    ],
    "Accreditation Process": [
        "accreditation", "akreditasyon", "accredit",
    ],
    "Complaint Handling": [
        "grievance", "sumbong", "hinaing",
    ],
    "ID Services": [
        "identification card", "id card", "school id", "employee id",
        "id printing",
    ],
    "Dormitory Service": [
        "dormitory", "dorm", "bed space", "boarding house",
    ],
    "Supplies and Resources": [
        "supplies", "materials", "accountable forms", "office supplies",
    ],
    "Transportation Service": [
        "transportation", "sasakyan", "service vehicle", "shuttle",
    ],
    "Library Service": [
        "library", "aklatan", "librong hiniram", "libro", "book", "books",
        "borrowing", "hiram ng libro", "pagsauli ng libro", "returning books",
    ],
    "Research Service": [
        "research assistance", "pananaliksik", "research consultation",
    ],
    # "General Service" and "Service Procedure"'s referral-only phrasing are
    # deliberately kept sparse — see the module comment above. These are
    # only ever reached via Gemini (online) or the Gemini fallback (offline).
}

# ---------------------------------------------------------------------------
# ITEM-LEVEL REFINEMENT (topic -> "{Topic} - {Specific Item}")
# One more level of specificity than TOPIC_KEYWORDS, applied only AFTER a
# topic has already been resolved by keyword_topic_override. Every item
# label is sentiment-neutral by design (see the taxonomy module comment
# above) — an item never encodes whether the thing it names was good or bad,
# only what it was. Not every topic has a meaningful item breakdown; those
# without one stay at the plain topic label.
#
# Each entry is an ORDERED list of (item_label, keywords) — on an equal
# keyword-hit count, the first-listed item wins, so the more specific/common
# item for that topic is listed first.
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
            ("processing", 0.75),
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
            ("proseso", 0.5), ("process", 0.5),
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
            ("staff", 0.5), ("staffs", 0.5), ("kawani", 0.5), ("empleyado", 0.5),
            ("tauhan", 0.5), ("employee", 0.5), ("receptionist", 0.5),
            ("guard", 0.5), ("security", 0.5), ("clerk", 0.5), ("faculty", 0.5),
            ("professor", 0.5), ("guro", 0.5), ("adviser", 0.5),
            ("ma'am", 0.5), ("sir", 0.5),
            "bastos", "hindi magalang", "suplado", "suplada", "masungit",
            "mabait", "mababait", "magalang", "magagalang", "courteous",
            "respectful", "approachable", "friendly",
            "masusungit", "rude", "disrespectful", "unfriendly", "bad attitude",
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
            ("user-friendly", 1.5), ("user friendly", 1.5), "madaling gamitin",
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
            ("kalinisan", 1.5), ("cleanliness", 1.5), ("malinis", 1.5),
            ("marumi", 1.5), ("rumi", 1.5), ("dumi", 1.5), ("madumi", 1.5),
            ("makalat", 1.5), ("kalat", 1.5), ("magulo", 1.5),
            ("dirty", 1.5), ("unclean", 1.5), ("not clean", 1.5),
            ("maalikabok", 1.5), ("alikabok", 1.5), ("dusty", 1.5),
            ("mabaho", 1.5), ("ambaho", 1.5), ("napakabaho", 1.5),
            ("napaka baho", 1.5), ("sobrang baho", 1.5), ("ang baho", 1.5),
            ("masyadong mabaho", 1.5), ("masangsang", 1.5), ("mabahong amoy", 1.5),
            ("amoy mabaho", 1.5), ("smelly", 1.5), ("stinky", 1.5),
            ("foul smell", 1.5), ("bad smell", 1.5), ("unsanitary", 1.5),
            ("poor sanitation", 1.5), ("filthy", 1.5), ("messy", 1.5),
            ("napakalinis", 1.5), ("napaka linis", 1.5), ("sobrang linis", 1.5),
            ("maayos at malinis", 1.5), ("well cleaned", 1.5), ("sanitary", 1.5),
        ]),
        ("Facilities and Resources - Seating/Furniture", [
            "upuan", "silya", "mesa", "bangko", "furniture", "chairs", "seats", "muwebles",
        ]),
        ("Facilities and Resources - Power/Lighting", [
            "kuryente", "ilaw", "brownout", "blackout", "lighting", "power outage",
            "walang kuryente",
        ]),
        # Split 2026-09-25 from a single conflated "Equipment Condition" item
        # that mixed appearance-judgment phrases with actual equipment nouns
        # under one label — a comment naming neither ("hindi maayos yung
        # opisina", no equipment, no specific appearance phrase) was still
        # landing on "Equipment Condition" via Gemini because that item's
        # own example hint (its first 3 keywords) was "pangit, pangit
        # tignan, pangit tingnan", nothing to do with equipment at all, so
        # the label Gemini picked didn't match what its own hint told it to
        # match on. Listed with Equipment/Machine first so a comment naming
        # BOTH a device and an appearance phrase (e.g. "pangit ang printer")
        # resolves to the more specific Equipment/Machine on a tie.
        ("Facilities and Resources - Equipment/Machine", [
            "kagamitan", "equipment", "makina", "aparatus", "printer",
            "computer lab", "computer laboratory", "computer shop",
        ]),
        ("Facilities and Resources - Appearance/Condition", [
            ("pangit", 1.5), ("pangit tignan", 1.5), ("pangit tingnan", 1.5),
            ("di magandang tignan", 1.5), ("hindi magandang tignan", 1.5),
            ("di magandang tingnan", 1.5), ("hindi magandang tingnan", 1.5),
            ("di kaaya aya", 1.5), ("hindi kaaya aya", 1.5), ("kaaya aya", 1.5),
            ("kaaya-aya", 1.5), ("hindi presentable", 1.5), ("di presentable", 1.5),
            ("unpresentable", 1.5), ("unattractive", 1.5),
            ("unpleasant looking", 1.5), ("poor appearance", 1.5),
            ("poorly maintained", 1.5),
            ("maayos tignan", 1.5), ("maayos tingnan", 1.5),
            ("pleasant looking", 1.5), ("well maintained", 1.5),
        ]),
        ("Facilities and Resources - Building/Structure", ["istruktura"]),
        ("Facilities and Resources - Parking", ["parking", "paradahan"]),
        ("Facilities and Resources - Resource Availability", ["pasilidad", "facilities"]),
    ],
    "Scholarship and Assistance": [
        ("Scholarship and Assistance - Grant Amount", [
            ("mali ang amount", 1.5), ("mali yung amount", 1.5), ("maling amount", 1.5),
            ("mali ang halaga", 1.5), ("mali yung halaga", 1.5), ("maling halaga", 1.5),
            ("kulang ang amount", 1.5), ("kulang yung amount", 1.5), ("kulang na amount", 1.5),
            ("kulang ang halaga", 1.5), ("kulang yung halaga", 1.5), ("kulang na halaga", 1.5),
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
    "ID Services": [
        ("ID Services - ID Printing", ["id printing", "employee id"]),
        ("ID Services - ID Application", [
            "identification card", "id card", "school id",
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
    # No keyword coverage — these two are reachable only through Gemini (see
    # the taxonomy module comment above), never through keyword_topic_override/
    # item_label_override's lexicon matching. Still registered here (even with
    # empty keyword lists) so gemini_model.ALL_TOPICS actually includes them as
    # valid outputs, matching shared/topicTaxonomy.js's admin-override dropdown.
    "Complaint Handling": [
        ("Complaint Handling - Response", []),
        ("Complaint Handling - Follow-up", []),
        ("Complaint Handling - Resolution Process", []),
    ],
    "General Service": [
        ("General Service - Service Information", []),
        ("General Service - Service Accessibility", []),
        ("General Service - Overall Process", []),
    ],
}


GENERAL_FEEDBACK = "General Feedback"


def item_label_override(topic, text):
    """
    Best-matching "{topic} - {item}" label for a topic that already resolved
    via keyword_topic_override, or None if that topic has no item breakdown
    or the text doesn't name any specific item within it. Same
    weighted-sum-then-order tie-break as keyword_topic_override, scoped to
    the winning topic's own item list.

    Bug fixed 2026-09-26: this used to score each item by len(_matched_spans(...))
    — literally counting matches — which silently ignored every keyword's
    declared weight (e.g. Cleanliness's ("madumi", 1.5) counted as a plain
    1, same as a bare 1-weighted location noun). That meant an issue-specific
    word like "madumi" (dirty) could never actually outrank a bare location
    noun like "cr" the way the weight was designed to guarantee — it silently
    fell back to whichever item happened to be listed first, defeating the
    entire point of weighting items at all. "madumi ang cr sa office" is
    exactly this case: Cleanliness's weighted "madumi" (1.5) must beat
    Restroom Condition's bare "cr" (1), not tie with it.
    """
    groups = TOPIC_ITEM_KEYWORDS.get(topic)
    if not groups:
        return None
    lowered = text.lower()
    hits = {}
    for item_label, keywords in groups:
        count = sum(weight for _, _, weight in _matched_spans(lowered, keywords))
        if count:
            hits[item_label] = count
    if not hits:
        return None
    # Preserve declared order on ties by scanning `groups` instead of `hits`.
    best_count = max(hits.values())
    for item_label, _ in groups:
        if hits.get(item_label) == best_count:
            return item_label
    return None


# ---------------------------------------------------------------------------
# OFFICE-AWARE HINT
# Superseded by gemini_model.py's own office_hint (free-text office/cluster
# name passed straight into the Gemini prompt as soft context — see its
# PROMPT_TEMPLATE) now that Gemini, not a zero-shot model, is the fallback.
# ---------------------------------------------------------------------------


def keyword_topic_override(text):
    """
    Best-matching topic by object-noun keyword count, or None if no keyword
    hit at all. As of 2026-09-25 (see analyze.py's module comment), no
    production comment is actually CLASSIFIED via this function anymore —
    every online and offline comment goes straight to Gemini (see
    heavy_model.analyze_pure_ai). This function is still called two ways:
    detect_junk_topic's "is this actually real vocabulary" guard below (not
    a classification, just a safety check), and heavy_model.analyze()'s
    lexicon-first hybrid, kept only for test_accuracy.py's lexicon-only
    scoring.
    """
    lowered = text.lower()
    hits = {}
    for topic, keywords in TOPIC_KEYWORDS.items():
        count = sum(weight for _, _, weight in _matched_spans(lowered, keywords))
        if count:
            hits[topic] = count
    if not hits:
        return None
    topic = max(hits.items(), key=lambda kv: kv[1])[0]
    # Refine to "{topic} - {item}" when the text names a specific enough
    # item within that topic (see TOPIC_ITEM_KEYWORDS) — otherwise stays at
    # the plain topic label.
    return item_label_override(topic, text) or topic


# ---------------------------------------------------------------------------
# SENTIMENT LEXICON — negation-aware keyword scoring, zero model loading.
# Used two ways:
#   1. The offline/fast path (fast_sentiment): no model at all, this is the
#      entire answer.
#   2. The offline HYBRID path (heavy_model.analyze): tried FIRST, before
#      Gemini. Empirically, a general-purpose multilingual sentiment
#      transformer (tried and replaced — see heavy_model.py's docstring) is
#      miscalibrated on short Tagalog/Taglish text in exactly the way a
#      zero-shot topic model is miscalibrated on Taglish topics: plainly
#      positive Tagalog sentences ("mabilis na-release yung resulta ko",
#      "hassle-free talaga") routinely score highest on Neutral, and negated
#      phrases ("walang palakasan dito, pantay-pantay lahat") can score
#      highest on Very Negative because the model reacts to the raw
#      negative-coded word inside the negation instead of the negation
#      itself. A small additive boost can't fix a gap that size, so — same
#      convention as topic keywords — a clear lexicon hit wins outright and
#      Gemini is reserved for text with no keyword coverage.
#
# The ONLINE path (heavy_model.analyze_pure_ai) never calls this — Gemini
# alone decides sentiment there, per the 2026-09-22 decision that AI speed/
# consistency for live comments takes priority over the lexicon.
#
# Negation handling: a NEGATOR word ("hindi", "wala", "walang", "di", "huwag",
# "ayaw", "not", "no", "never", "without") found in the up-to-3 words
# immediately before a sentiment keyword, WITHIN THE SAME CLAUSE (split on
# ,.;:!?), flips that keyword's polarity. This is what correctly turns
# "walang problema" (no problem) positive and "wala...maayos" (not
# proper/fine) negative, instead of naive substring-in-lowered scanning that
# scored both purely on the presence of "problema"/"maayos" regardless of
# the negator sitting right next to them. Clause-scoping keeps a negator in
# one clause from leaking across a comma into an unrelated later clause
# (e.g. "walang palakasan dito, pantay-pantay lahat" must not let "walang"
# flip "pantay").
# ---------------------------------------------------------------------------
FAST_NEGATIVE_WORDS = [
    "mahina", "masama", "masamang", "pangit", "sira", "sirang", "bastos",
    "mabagal", "matagal", "tagal", "bagal", "katagal", "bobo", "reklamo",
    "galit", "problema", "hassle", "dumi", "madumi", "marumi", "amoy-amoy",
    "kulang", "konti", "hirap", "mahirap", "nahirapan", "nakakainis",
    "nakakastress", "sakit ng ulo", "kumplikado", "maraming hakbang", "madaming hakbang",
    "palakasan", "may kilala", "paulit-ulit", "nawawalan ng koneksyon",
    "nawalan ng signal", "nakakalito", "nalilito", "walang kwenta",
    "sayang", "huli na", "magulo", "naligaw",
    "poor", "bad", "slow", "broken", "rude", "worst", "terrible", "awful",
    "annoying", "frustrating", "difficult", "messy", "disappoint",
    "disappointed", "disappointing", "disappointment",
    "dirty", "confusing", "outdated", "late", "lost", "not working",
    "brownout", "blackout", "power outage",
    "walang paalam", "walang reply", "hindi sumasagot", "hindi sinagot",
    "hindi sumagot", "walang sagot", "no response", "no reply",
    "never replied", "not informed", "nobody informed",
    "no update", "walang update", "no updates", "walang updates",
    "wala pang balita", "walang balita",
    "walang wifi", "walang internet", "no wifi", "no internet", "no signal",
    "walang stock", "out of stock", "no stock",
    "sobrang mahal", "napakamahal", "masyadong mahal", "overpriced",
    "too expensive",
    "suplado", "suplada", "masungit", "sungit", "mayabang",
    "nagla-lag", "lumalag", "laggy",
    "nakakabwisit", "nakakagalit", "nakakadismaya", "nakakapagod",
    "walang silbi", "walang kwenta na", "walang malasakit", "pabaya",
    "abusado", "walang modo", "walang disiplina", "naantala", "na-delay",
    "nadelay", "sablay", "epic fail",
    "unprofessional", "unacceptable", "horrible", "pathetic", "useless",
    "waste of time", "inconvenient", "inconvenience", "unresponsive",
    "unreliable", "chaotic", "disorganized", "incomplete", "faulty",
    "malfunctioning", "glitch", "glitchy", "buggy", "crashed", "crashing",
    "nag-crash", "nag-hang", "hanging",
    "antagal",
    "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
    "masyadong mainit", "maalinsangan", "kulob", "too hot", "very hot",
    "mabaho", "ambaho", "napakabaho", "napaka baho", "sobrang baho",
    "ang baho", "masyadong mabaho", "masangsang",
    "mabahong amoy", "amoy mabaho", "smelly", "stinky", "foul smell",
    "bad smell", "unsanitary",
    "pangit", "unpresentable", "hindi presentable", "unattractive",
    "poor appearance", "poorly maintained",
    "hindi inaasikaso", "di inaasikaso", "hindi pinapansin", "di pinapansin",
    "walang assistance", "walang tumutulong", "poor assistance", "poor service",
    "bad attitude",
    "masusungit", "disrespectful", "unfriendly",
    "mali", "maling", "incorrect",
    "mahaba ang pila", "mahabang pila", "napakahaba ang pila",
    "sobrang haba ng pila", "ang haba ng pila", "long line", "long queue",
]
FAST_POSITIVE_WORDS = [
    "maganda", "magandang", "mabilis", "magaling", "mabait", "salamat",
    "masaya", "masayang", "maayos", "ayos naman", "okay naman", "ok naman",
    "walang problema", "walang reklamo", "pantay", "patas", "madali",
    "kadali", "mahusay", "sanay", "stable", "malinaw", "maalaga", "magiliw",
    "marunong", "madunong",
    "propesyonal", "tulong", "tumulong", "tinulungan",
    "walang abala", "walang hassle", "isang beses lang", "isang hakbang lang",
    "one-stop", "one stop", "patient",
    "satisfied", "great", "good", "excellent", "fast", "helpful",
    "friendly", "nice", "pleasant", "malinis", "the best", "love it", "hassle-free",
    "hassle free", "streamlined", "efficient", "smooth", "convenient",
    "fair", "equal", "commend", "professional", "professionally", "professionalism",
    "appreciate", "appreciated",
    "magalang", "matulungin", "maasikaso",
    "maagap", "matiyaga", "masipag", "accommodating", "approachable",
    "considerate", "welcoming", "sulit", "astig", "solid", "top-notch",
    "seamless", "responsive", "on-time", "prompt",
    "organized", "spot on", "kaaya-aya", "mapagkalinga",
    "all goods",
    "napakalinis", "napaka linis", "sobrang linis", "maayos at malinis",
    "very clean", "well maintained",
    "kaayang aya", "kaayang ayang", "kaaya ayang", "kaaya-ayang",
    "mababait", "magagalang", "courteous", "respectful",
]

# Filler phrases that read as flat/neutral on their own — matched only when
# no positive/negative keyword fired at all (see lexicon_sentiment), so a
# comment that also carries real signal elsewhere isn't dragged to Neutral
# just for containing one of these.
FAST_NEUTRAL_PHRASES = [
    "walang masabi", "karaniwan lang", "ok lang", "okay lang",
    "walang komento",
]

# Known idiom collisions: a phrase that contains a sentiment-lexicon word as
# a substring but means something unrelated to that word's polarity, e.g.
# "good moral certificate" is a specific document name (see
# TOPIC_ITEM_KEYWORDS), not praise — it must not trip the bare word "good".
# Masked out of the text before keyword scanning.
SENTIMENT_COLLISION_PHRASES = ["good moral"]

NEGATOR_WORDS = {
    "hindi", "wala", "walang", "di", "'di", "huwag", "ayaw",
    "not", "no", "never", "without",
    "wasn't", "isn't", "doesn't", "don't", "didn't", "couldn't", "can't",
    "cannot", "won't", "aren't", "wouldn't", "shouldn't",
}
NEGATION_LOOKBACK = 3

# A generic complaint-filler word co-occurring in the same clause as a more
# specific negative descriptor is redundant with it, not a second
# independent gripe — e.g. "may kunting problema lang kasi madumi" ("there's
# a small problem because it's dirty") is ONE complaint (dirtiness) named
# twice, not two. Left uncorrected this double-counts and can make a
# genuinely mixed comment (one real compliment + one real complaint) read as
# more negative than it is purely because the complaint used two words. Only
# dropped when a more specific negative word fires in the same clause —
# a clause with ONLY "problema" and nothing else still counts it normally.
GENERIC_NEGATIVE_FILLERS = {"problema", "reklamo", "issue", "concern"}

# "sana" (I hope/wish) marks a positive word as aspirational rather than
# descriptive of the current state — "sana maayos pa" ("hope it gets fixed")
# is a complaint, not praise, even though it contains "maayos". Treated like
# a negator for lookback purposes, but it neutralizes the keyword (drops it)
# instead of flipping its polarity, since "sana [positive]" isn't a negative
# claim either — it's a wish, distinct from both.
ASPIRATIONAL_WORDS = {"sana", "kailangan"}


def _is_aspirational(clause_lower, span_start):
    words_before = clause_lower[:span_start].split()[-NEGATION_LOOKBACK:]
    return any(w.strip("'") in ASPIRATIONAL_WORDS for w in words_before)


def _keyword_spans(clause_lower, keywords):
    # Delegates to _matched_spans so two keywords in the same list that match
    # the same text (e.g. "walang kwenta"/"walang kwenta na", or a hyphenated
    # spelling now matching its own unhyphenated variant via _kw_pattern)
    # count as one hit, not two — see _matched_spans docstring.
    return [(s, e) for s, e, _ in _matched_spans(clause_lower, keywords)]


def _is_negated(clause_lower, span_start):
    words_before = clause_lower[:span_start].split()[-NEGATION_LOOKBACK:]
    return any(w.strip("'") in NEGATOR_WORDS for w in words_before)


def lexicon_sentiment(text):
    """
    Negation-aware keyword sentiment verdict, or None if the text contains no
    sentiment keyword at all (caller should fall back to a full model in
    that case — see module docstring above for why this wins outright over
    the transformer whenever it does have a signal).
    """
    lowered = text.lower()
    for phrase in SENTIMENT_COLLISION_PHRASES:
        lowered = re.sub(_kw_pattern(phrase), ' ', lowered)

    clauses = re.split(r'[.,;:!?]+', lowered)
    pos_count = 0
    neg_count = 0
    neutral_hit = False
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        if any(re.search(_kw_pattern(p), clause) for p in FAST_NEUTRAL_PHRASES):
            neutral_hit = True
        pos_spans = _keyword_spans(clause, FAST_POSITIVE_WORDS)
        covered = set()
        for s, e in pos_spans:
            covered.update(range(s, e))
        # Drop negative spans that overlap an already-claimed positive
        # phrase, so e.g. "hassle-free" (positive phrase) doesn't also
        # register "hassle" (negative word) as a second, contradictory hit.
        neg_spans = [
            (s, e) for s, e in _keyword_spans(clause, FAST_NEGATIVE_WORDS)
            if not (set(range(s, e)) & covered)
        ]
        specific_neg_spans = [
            (s, e) for s, e in neg_spans if clause[s:e] not in GENERIC_NEGATIVE_FILLERS
        ]
        if specific_neg_spans:
            neg_spans = specific_neg_spans
        for s, e in pos_spans:
            if _is_negated(clause, s):
                neg_count += 1
            elif _is_aspirational(clause, s):
                pass
            else:
                pos_count += 1
        for s, e in neg_spans:
            if _is_negated(clause, s):
                pos_count += 1
            else:
                neg_count += 1

    if pos_count == 0 and neg_count == 0:
        return "Neutral" if neutral_hit else None
    if pos_count > neg_count:
        return "Positive"
    if neg_count > pos_count:
        return "Negative"
    return "Neutral"


def fast_sentiment(text):
    if detect_junk_topic(text):
        return "Neutral"
    return lexicon_sentiment(text) or "Neutral"


# ---------------------------------------------------------------------------
# NO-MEANINGFUL-FEEDBACK DETECTION (pure numbers / symbols / emoji /
# keyboard-mash gibberish / greeting-only text) — a deterministic pre-check
# so these get a clear, honest "No Feedback - No Feedback" tag
# INSTANTLY, without ever spending a Gemini call on content that has no real
# opinion to classify, and without it being counted as genuine (if generic)
# "General Feedback" — that label means "meaningful feedback that doesn't fit
# a more specific topic," not "the classifier didn't understand this."
#
# This is now also the ENTIRE keyword-lexicon footprint of the ONLINE
# classification path (see heavy_model.analyze_pure_ai) — every comment that
# clears this gate goes straight to Gemini with no keyword matching at all —
# both online AND offline, as of 2026-09-25 (see analyze.py's module
# comment). The keyword lexicon above (TOPIC_KEYWORDS/TOPIC_ITEM_KEYWORDS/
# sentiment words) is no longer used to classify any production comment; it
# still runs as this function's own "is this actually real vocabulary" guard
# below, and backs heavy_model.analyze()'s hybrid for test_accuracy.py's
# lexicon-only scoring.
#
# Order of checks:
#   1. Known-vocabulary guard — if the comment already matches a topic or
#      sentiment keyword, it is real content by definition and must never be
#      flagged as junk on letter-shape alone (e.g. a bare "CR" comment is a
#      genuine, if terse, Restroom-topic keyword — two letters, zero vowels).
#   2. Numbers-only / symbols-only.
#   3. Greeting/courtesy-particle-only ("Hello po", "Hi", "Hi po", "po po").
#   4. Whole-comment vowel-ratio check (gibberish heuristic, kept as a
#      secondary net for junk spread across multiple short tokens).
#   5. Per-token check: every alphabetic token (len>=2) is "suspicious"
#      (zero vowels, or len>=8 with a consonant run>=4 — no real
#      English/Tagalog/Taglish word looks like that) and there's at least one
#      such token.
# Anything with a real recognizable word anywhere in it returns None and
# falls through to the normal lexicon/Gemini path — this is deliberately
# conservative in the direction of keeping real feedback classified normally.
# ---------------------------------------------------------------------------
UNCLASSIFIED_NO_FEEDBACK = "No Feedback - No Feedback"

_GIBBERISH_MIN_LETTERS = 10
_GIBBERISH_MAX_VOWEL_RATIO = 0.15
_VOWELS = set("aeiou")

_SUSPICIOUS_TOKEN_MIN_LEN = 8
_SUSPICIOUS_TOKEN_MIN_CONSONANT_RUN = 4

GREETING_WORDS = {"hello", "hi", "hey", "yo", "kumusta", "kamusta"}
GREETING_PHRASES = [
    "good morning", "good afternoon", "good evening", "good day",
    "magandang umaga", "magandang tanghali", "magandang hapon",
    "magandang gabi", "magandang araw",
]
COURTESY_PARTICLES = {"po", "opo", "naman", "na", "ba", "lang", "sana", "nga"}


def _collect_known_vocab_tokens():
    """
    Every single-word (no-space) token already used anywhere in the topic or
    sentiment lexicons, lowercased. Used as a safety net so a short, real
    keyword (e.g. "cr", "id") is never treated as gibberish purely because it
    happens to have an unusual letter shape.
    """
    tokens = set()

    def add_from(keyword_list):
        for entry in keyword_list:
            kw = entry[0] if isinstance(entry, tuple) else entry
            for word in re.findall(r"[a-z]+", kw.lower()):
                tokens.add(word)

    for keywords in TOPIC_KEYWORDS.values():
        add_from(keywords)
    for groups in TOPIC_ITEM_KEYWORDS.values():
        for _label, keywords in groups:
            add_from(keywords)
    add_from(FAST_POSITIVE_WORDS)
    add_from(FAST_NEGATIVE_WORDS)
    return tokens


_KNOWN_VOCAB_TOKENS = _collect_known_vocab_tokens()


def _is_greeting_or_particle_only(stripped_text):
    """
    True only if the text contains at least one real greeting (word or
    phrase) AND nothing besides that greeting and courtesy particles
    ("po", "naman", ...) — e.g. "Hello po", "Hi", "Good morning po". A
    comment with no greeting at all (even if every word happens to be a bare
    particle, or a real greeting followed by real feedback) returns False.
    """
    lowered = stripped_text.lower()
    found_greeting = False
    for phrase in GREETING_PHRASES:
        replaced = re.sub(_kw_pattern(phrase), ' ', lowered)
        if replaced != lowered:
            found_greeting = True
        lowered = replaced

    remaining_words = []
    for word in re.findall(r"[a-z']+", lowered):
        if word in GREETING_WORDS:
            found_greeting = True
        elif word not in COURTESY_PARTICLES:
            remaining_words.append(word)

    return found_greeting and not remaining_words


# The three QWERTY rows. Every check above is a letter-SHAPE heuristic (vowel
# ratio, consonant runs), and the most common junk a respondent types slips
# straight through them: "asdf" and "qwerty" are vowel-rich, and "asdasd" or
# "aaaaaa" are perfectly pronounceable. Those are caught structurally instead
# -- by where the letters sit on the keyboard, and by whether the token is one
# short unit stamped out over and over.
_KEYBOARD_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
_KEYBOARD_RUN_MIN_LEN = 4


def _is_keyboard_run(token, min_len=_KEYBOARD_RUN_MIN_LEN):
    """
    True when every letter of the token lies on ONE keyboard row in an
    unbroken left-to-right or right-to-left run: "asdf", "qwerty", "zxcvbnm",
    "lkjh". Real words essentially never do this at 4+ letters, which is why
    the default minimum is deliberately that high.
    """
    lowered = token.lower()
    if len(lowered) < min_len:
        return False
    for row in _KEYBOARD_ROWS:
        positions = [row.find(ch) for ch in lowered]
        if -1 in positions:
            continue
        steps = set(b - a for a, b in zip(positions, positions[1:]))
        if steps == {1} or steps == {-1}:
            return True
    return False


def _repeated_unit(token):
    """
    ("asd", 2) for "asdasd", ("a", 6) for "aaaaaa", ("asdf", 2) for "asdfasdf";
    None when the token is not one short unit repeated end to end.

    Units run to 4 letters because "asdfasdf" is one of the most common mashes
    there is -- but a 4-letter unit is also exactly how Filipino reduplication
    works ("halohalo", "arawaraw", "sarisari"), so the caller additionally
    requires a 4-letter unit to be a keyboard run before condemning it. None of
    those three words is one.
    """
    lowered = token.lower()
    for size in (1, 2, 3, 4):
        if len(lowered) < size * 2 or len(lowered) % size:
            continue
        unit = lowered[:size]
        if unit * (len(lowered) // size) == lowered:
            return unit, len(lowered) // size
    return None


def _max_consonant_run(lowered_letters):
    best = current = 0
    for ch in lowered_letters:
        if ch in _VOWELS:
            current = 0
        else:
            current += 1
            best = max(best, current)
    return best


def _is_suspicious_token(token):
    if token.lower() in _KNOWN_VOCAB_TOKENS:
        return False
    letters = [c for c in token if c.isalpha() and c.isascii()]
    if len(letters) < 2:
        return False
    lowered = "".join(letters).lower()
    vowel_count = sum(1 for c in lowered if c in _VOWELS)
    if vowel_count == 0:
        return True
    if len(lowered) >= _SUSPICIOUS_TOKEN_MIN_LEN and _max_consonant_run(lowered) >= _SUSPICIOUS_TOKEN_MIN_CONSONANT_RUN:
        return True

    # Straight keyboard mash: "asdf", "qwertyuiop", "zxcvbnm".
    if _is_keyboard_run(lowered):
        return True

    repeated = _repeated_unit(lowered)
    if repeated:
        unit, reps = repeated
        unit_has_vowel = any(c in _VOWELS for c in unit)
        # The thresholds below are deliberately uneven, because Tagalog/Bikol
        # reduplication is real and must survive: "mama"/"papa" are a 2-letter
        # unit twice, and "dagdag"/"pagpag" a 3-letter unit twice. So neither
        # shape may condemn a token on repetition alone.
        #   - a 1-2 letter unit needs 4+ repetitions ("aaaaaa", "tatatata"), or
        #     3+ when the unit has no vowel to form a syllable with ("ghghgh")
        #     or is itself adjacent keys ("opopop");
        #   - a 3- or 4-letter unit counts at 2 repetitions only when the unit
        #     is itself a keyboard run ("asdasd", "asdfasdf"), which "dagdag"
        #     and "halohalo" are not.
        if len(unit) <= 2 and reps >= 4:
            return True
        if len(unit) <= 2 and reps >= 3 and (not unit_has_vowel or _is_keyboard_run(unit, 2)):
            return True
        if len(unit) == 3 and reps >= 2 and _is_keyboard_run(unit, 3):
            return True
        if len(unit) == 4 and reps >= 2 and _is_keyboard_run(unit, 4):
            return True

    return False


def detect_junk_topic(text):
    """
    Returns UNCLASSIFIED_NO_FEEDBACK, or None (not junk — classify normally).
    Called before the keyword lexicon and before Gemini.
    """
    stripped = text.strip()
    if not stripped:
        return None  # blank comments are handled separately upstream

    # Real, recognized content always wins outright — never flagged as junk
    # on letter-shape alone (see module comment, check #1).
    if keyword_topic_override(stripped) or lexicon_sentiment(stripped):
        return None

    letters = [c for c in stripped if c.isalpha() and c.isascii()]
    digits = [c for c in stripped if c.isdigit()]

    if digits and not letters:
        residual = re.sub(r'[\d\s\-\(\)\+\.]', '', stripped)
        if not residual:
            return UNCLASSIFIED_NO_FEEDBACK

    if not letters and not digits:
        # Something is there (checked non-empty above) but it's not a
        # letter or a digit — pure emoji/symbols/punctuation.
        return UNCLASSIFIED_NO_FEEDBACK

    if letters and _is_greeting_or_particle_only(stripped):
        return UNCLASSIFIED_NO_FEEDBACK

    if len(letters) >= _GIBBERISH_MIN_LETTERS:
        vowel_count = sum(1 for c in letters if c.lower() in _VOWELS)
        if vowel_count / len(letters) < _GIBBERISH_MAX_VOWEL_RATIO:
            return UNCLASSIFIED_NO_FEEDBACK

    alpha_tokens = [t for t in re.findall(r"[A-Za-z]+", stripped) if len(t) >= 2]
    if alpha_tokens and all(_is_suspicious_token(t) for t in alpha_tokens):
        return UNCLASSIFIED_NO_FEEDBACK

    return None


def fast_topic(text):
    junk = detect_junk_topic(text)
    if junk:
        return junk
    return keyword_topic_override(text) or GENERAL_FEEDBACK
