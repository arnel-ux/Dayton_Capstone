"""
Shared taxonomy and junk-detection heuristics used by both analyze.py (CLI /
offline-sync path) and heavy_model.py (persistent model-server path, and the
same functions analyze.py calls directly). Keeping this in one module means
the two entry points can never silently drift apart.

2026-09-27 cleanup: the keyword-based classification lexicon (TOPIC_KEYWORDS,
the sentiment word lists, keyword_topic_override, item_label_override,
lexicon_sentiment, fast_sentiment/fast_topic) has been removed. It was the
fallback classifier before the pure-AI classification project (2026-09-22)
and briefly a lexicon-first hybrid for offline-synced comments after that,
but neither role survived: online comments have called Gemini exclusively
since 2026-09-22, and offline-synced comments have too since 2026-09-25 (see
analyze.py's module comment) — no production path has classified a single
comment via keyword matching since. What remains here:
  - is_no_feedback / NO_FEEDBACK_PHRASES: still the first gate every comment
    passes through, unchanged.
  - candidate_topics / TOPIC_ITEM_KEYWORDS: NOT dead — this is the taxonomy
    itself. gemini_model.py reads it to build Gemini's prompt guide, its
    example-keyword hints, and the JSON schema's valid-output enum. Deleting
    this would break Gemini, not just the old lexicon.
  - detect_junk_topic and everything it depends on (greeting/gibberish/
    keyboard-mash detection): still the ONLY thing that runs before Gemini is
    ever called, for every comment, online and offline alike — this is what
    catches blanks, "N/A"-style placeholders, emoji/symbol-only text,
    keyboard mash, and greeting-only comments for free, without spending an
    API call. Its own "is this actually real vocabulary" guard now reads
    directly from TOPIC_ITEM_KEYWORDS (see _collect_known_vocab_tokens)
    instead of the deleted lexicon — verified before this cleanup that no
    real short word (e.g. "cr", "id") was uniquely covered only by the
    deleted lists.
"""
import re

# ---------------------------------------------------------------------------
# NO-FEEDBACK DETECTION — must run BEFORE any AI classification.
# A blank comment or an explicit "nothing to say" placeholder ("N/A", "none",
# "no comment", ...) has no actual content to classify — forcing it through
# the classification pipeline previously produced a fabricated "General
# Feedback / Neutral" result, which reads to an admin as a real (if generic)
# opinion rather than "this respondent didn't write anything." Callers
# (analyze.py, model_server.py, server.js's analyzeComment) must check this
# FIRST and short-circuit to no classification at all (topic=None,
# sentiment=None) — see each caller for how that maps to the database (NULL,
# not a string).
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
# HYPHEN-TOLERANT MATCHING — still used by the junk-detector's greeting-phrase
# check below (_is_greeting_or_particle_only), which needs to match a phrase
# like "good morning" regardless of exact spacing/hyphenation.
# ---------------------------------------------------------------------------
def _kw_pattern(kw):
    escaped = re.escape(kw).replace('\\-', '[- ]?')
    return r'\b' + escaped + r'\b'


# ---------------------------------------------------------------------------
# TOPIC TAXONOMY (rewritten 2026-09-22 — pure-AI classification project)
#
# This is Gemini's entire classification universe — gemini_model.py builds
# its prompt guide, its per-item example hints, and its JSON schema's
# valid-output enum directly from candidate_topics and TOPIC_ITEM_KEYWORDS
# below. Do not remove or rename anything here without also checking
# gemini_model.py's TOPIC_DESCRIPTIONS (which must have an entry for every
# topic listed here).
#
# Designed around one rule: a Topic/Subtopic label must be SENTIMENT-NEUTRAL
# — it names what the comment is ABOUT, never whether that thing was good or
# bad (that judgment belongs entirely to the separate sentiment axis). The old
# taxonomy violated this in a few places (e.g. "Transaction - Slow"/
# "Transaction - Fast" baked a sentiment judgment into the subtopic itself),
# which is exactly the pattern this rewrite removes — "Transaction" is folded
# into "Processing - Processing Time" and sentiment alone carries the
# slow/fast verdict, matching every other topic's convention.
#
# This taxonomy merges the previous physical-facility/behavioral topics with
# a broader set of administrative/service-process topics covering the
# college's non-facility offices (registrar, HR, cash unit, scholarships,
# ICT, library, dormitory, travel orders, etc.), consolidating topics that
# meant the same thing under one neutral name and removing duplicates.
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
# SUBTOPICS (topic -> "{Topic} - {Specific Item}" labels), keyed by parent
# topic. Every item label is sentiment-neutral by design (see the taxonomy
# comment above) — an item never encodes whether the thing it names was good
# or bad, only what it was. Not every topic has a meaningful item breakdown;
# those without one stay at the plain topic label.
#
# The short keyword list under each item is NOT a matcher anymore (see the
# module docstring) — it exists purely so gemini_model.py's _item_hint() can
# show Gemini a couple of concrete example words/phrases for what that label
# means (e.g. "Restroom Condition (e.g. tissue, sabon, banyo)"). An empty
# list is valid — see Complaint Handling/General Service below — Gemini still
# needs the label registered here to ever output it, even with no examples.
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


# ---------------------------------------------------------------------------
# NO-MEANINGFUL-FEEDBACK DETECTION (pure numbers / symbols / emoji /
# keyboard-mash gibberish / greeting-only text) — a deterministic pre-check
# so these get a clear, honest "No Feedback - No Feedback" tag INSTANTLY,
# without ever spending a Gemini call on content that has no real opinion to
# classify, and without it being counted as genuine (if generic) "General
# Feedback" — that label means "meaningful feedback that doesn't fit a more
# specific topic," not "the classifier didn't understand this."
#
# This is the ONLY keyword-based check any comment goes through, online and
# offline alike (see the module docstring) — everything that clears this gate
# goes straight to Gemini with no keyword matching at all.
#
# Order of checks:
#   1. Known-vocabulary guard — if a token in the comment is itself a real
#      taxonomy keyword (see _collect_known_vocab_tokens/_KNOWN_VOCAB_TOKENS
#      below), it is never flagged as junk on letter-shape alone (e.g. a bare
#      "CR" comment is a genuine, if terse, Restroom-topic keyword — two
#      letters, zero vowels) — see _is_suspicious_token's own check for this.
#   2. Numbers-only / symbols-only.
#   3. Greeting/courtesy-particle-only ("Hello po", "Hi", "Hi po", "po po").
#   4. Whole-comment vowel-ratio check (gibberish heuristic, kept as a
#      secondary net for junk spread across multiple short tokens).
#   5. Per-token check: every alphabetic token (len>=2) is "suspicious"
#      (zero vowels, or len>=8 with a consonant run>=4 — no real
#      English/Tagalog/Taglish word looks like that) and there's at least one
#      such token.
# Anything with a real recognizable word anywhere in it returns None and
# falls through to the normal Gemini path — this is deliberately conservative
# in the direction of keeping real feedback classified normally.
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
    Every single-word (no-space) token used anywhere in TOPIC_ITEM_KEYWORDS,
    lowercased. Used as a safety net so a short, real keyword (e.g. "cr",
    "id") is never treated as gibberish purely because it happens to have an
    unusual letter shape.

    Used to also pull from the classification lexicon (TOPIC_KEYWORDS,
    FAST_POSITIVE_WORDS, FAST_NEGATIVE_WORDS) before that was removed
    2026-09-27 — verified beforehand that every token those lists uniquely
    contributed was either not short/vowelless enough to ever trip
    _is_suspicious_token, or already duplicated in TOPIC_ITEM_KEYWORDS, so
    this guard's real-world coverage is unchanged.
    """
    tokens = set()

    def add_from(keyword_list):
        for entry in keyword_list:
            kw = entry[0] if isinstance(entry, tuple) else entry
            for word in re.findall(r"[a-z]+", kw.lower()):
                tokens.add(word)

    for groups in TOPIC_ITEM_KEYWORDS.values():
        for _label, keywords in groups:
            add_from(keywords)
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
    Returns UNCLASSIFIED_NO_FEEDBACK, or None (not junk — classify normally
    via Gemini). Called before Gemini is ever invoked, for every comment.
    """
    stripped = text.strip()
    if not stripped:
        return None  # blank comments are handled separately upstream

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
