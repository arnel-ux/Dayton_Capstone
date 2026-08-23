"""
Shared taxonomy, keyword anchors, and lightweight heuristics used by both
analyze.py (CLI / standalone fallback) and heavy_model.py (persistent
model-server path). Keeping this in one module means the fast/offline
heuristic path and the full model path can never silently drift apart.
"""
import re

# ---------------------------------------------------------------------------
# TOPIC TAXONOMY
# Split into topics specific enough that an admin reading a feedback report
# can tell what a comment is about from its topic tag alone, without opening
# the comment text. Grouped conceptually:
#   - Speed/process:      Queueing and Waiting Time, Transaction Speed,
#                          Process Efficiency
#   - Systems:             Ease of Use, Online System and Portal,
#                          Internet Connection
#   - Physical facility:   Aircon and Cooling, Restroom and Cleanliness,
#                          Seating and Furniture, Power and Lighting,
#                          Facilities and Equipment (narrow fallback)
#   - People:              Staff Courtesy and Attitude,
#                          Staff Competence and Knowledge,
#                          Fairness and Equal Treatment
#   - Transaction-specific: Payment and Fees, Document and Credential
#                          Processing, Enrollment and Registration
#   - Information:          Communication and Information
#
# "Facilities and Equipment" is a narrower fallback for physical-facility
# comments that don't name one of the more specific facility subtypes
# (e.g. "sirang gusto", generic "pasilidad"). Likewise "Staff Courtesy and
# Attitude" doubles as the default bucket for staff-related comments that
# don't clearly single out competence or fairness specifically.
#
# "General Feedback" is deliberately NOT a zero-shot candidate (see
# classify_topic in heavy_model.py) — it's a low-confidence fallback only, so
# a comment is never routed there just because it edged out the other
# hypotheses.
# ---------------------------------------------------------------------------
candidate_topics = [
    "Queueing and Waiting Time",
    "Transaction Speed",
    "Process Efficiency",
    "Ease of Use",
    "Online System and Portal",
    "Internet Connection",
    "Aircon and Cooling",
    "Restroom and Cleanliness",
    "Seating and Furniture",
    "Power and Lighting",
    "Facilities and Equipment",
    "Staff Courtesy and Attitude",
    "Staff Competence and Knowledge",
    "Fairness and Equal Treatment",
    "Payment and Fees",
    "Document and Credential Processing",
    "Enrollment and Registration",
    "Communication and Information",
]

# ---------------------------------------------------------------------------
# TAGLISH KEYWORD ANCHORS
# Zero-shot NLI models are weakest exactly where local feedback lives: short
# Taglish phrases like "mahina ang aircon". These lexicons do two jobs:
#   1. Feed a richer, example-laden hypothesis to the zero-shot model so it
#      has concrete Taglish anchors to match against (the "few-shot" context
#      an NLI model can actually use, since it has no true few-shot mode).
#   2. Provide a small deterministic score boost/tiebreak when a comment
#      contains one of these unambiguous object-noun keywords, and power the
#      fast offline heuristic path entirely on their own.
# Only *object nouns* or unambiguous compound phrases are used as anchors —
# never bare descriptors like "mabagal"/"mahina"/"malinis" alone, since those
# are ambiguous across every category (slow queue vs slow wifi vs weak
# aircon, clean restroom vs clean process) and would misfire.
#
# Dict order matters for keyword_topic_override's tie-break: on an equal
# keyword-hit count, whichever topic is listed FIRST wins. So the more
# specific sub-buckets of a group are listed before that group's broad
# fallback bucket (e.g. "Fairness and Equal Treatment" and "Staff Competence
# and Knowledge" before the generic "Staff Courtesy and Attitude" catch-all;
# the four specific facility subtypes before the generic "Facilities and
# Equipment" catch-all).
# ---------------------------------------------------------------------------
TOPIC_KEYWORDS = {
    "Queueing and Waiting Time": [
        "pila", "linya", "queue", "queueing", "waiting line", "numero", "hintay",
    ],
    "Internet Connection": [
        "internet", "wifi", "wi-fi", "signal", "network", "koneksyon",
        "walang signal", "walang internet",
    ],
    "Online System and Portal": [
        "portal", "website", "web site", "sias", "online form", "online system",
        "log-in", "login", "log in", "e-services", "e-portal", "online account",
    ],
    "Aircon and Cooling": [
        "aircon", "air-con", "air condition", "aircondition", "air conditioning",
        "electric fan", "bentilador", "pabentilador",
    ],
    "Restroom and Cleanliness": [
        "banyo", "cr", "palikuran", "restroom", "toilet", "kalinisan", "cleanliness",
    ],
    "Seating and Furniture": [
        "upuan", "silya", "mesa", "bangko", "furniture", "chairs", "seats", "muwebles",
    ],
    "Power and Lighting": [
        "kuryente", "ilaw", "brownout", "blackout", "lighting", "power outage",
        "walang kuryente",
    ],
    # Unambiguous compound phrases naming a fairness/impartiality concern —
    # listed before the generic staff bucket so it wins the tie-break.
    # "walang palakasan" is lifted straight from the SQD7 survey question
    # itself, so it's a strong, unambiguous anchor for real client phrasing.
    "Fairness and Equal Treatment": [
        "palakasan", "walang palakasan", "paboritism", "favoritism",
        "nepotism", "bias", "unfair", "hindi patas", "walang katarungan",
    ],
    # Unambiguous compound phrases naming a knowledge/competence gap, as
    # opposed to bare attitude/manners complaints — also listed before the
    # generic staff bucket.
    "Staff Competence and Knowledge": [
        "hindi marunong", "walang alam", "not knowledgeable", "incompetent",
        "hindi sanay", "untrained", "kulang sa training", "hindi sigurado sa sagot",
    ],
    # Generic staff-behavior bucket: role nouns with no more specific
    # competence/fairness phrase present. Listed after those two so a
    # comment naming both (e.g. "yung guard, walang palakasan") resolves to
    # the more specific bucket instead.
    "Staff Courtesy and Attitude": [
        "staff", "kawani", "empleyado", "tauhan", "employee", "receptionist",
        "guard", "security", "clerk", "bastos",
    ],
    "Payment and Fees": [
        "bayad", "babayaran", "fee", "fees", "singil", "kabayaran", "resibo",
        "official receipt", "sobrang mahal ang bayad",
    ],
    "Document and Credential Processing": [
        "transcript", "tor", "diploma", "certification", "certificate",
        "credentials", "cav", "transcript of records", "honorable dismissal",
        "diploma ko",
    ],
    "Enrollment and Registration": [
        "enrollment", "enrolment", "pagpapatala", "registration", "rehistrasyon",
        "matriculation", "cross-enrollment", "re-admission", "shifting",
    ],
    "Communication and Information": [
        "impormasyon", "information", "announcement", "abiso", "notice",
        "paalala", "text blast", "walang paalam",
    ],
    # "transaction" is the unambiguous object-noun anchor for comments whose
    # core driver is how fast the service itself moved (hal. "bilis ng
    # transaction") — as opposed to "Queueing" (waiting for your turn) or
    # "Process Efficiency" (how simple the steps were).
    "Transaction Speed": [
        "transaction", "pag-transact", "processing time", "release ng resulta",
    ],
    # Compound Taglish/English phrases that unambiguously describe the
    # process itself being simple/tedious, not any specific object.
    "Process Efficiency": [
        "hassle-free", "hassle free", "walang abala", "walang hassle",
        "streamlined", "isang beses lang", "one-stop", "maraming hakbang",
        "kumplikado",
    ],
    "Ease of Use": [
        "user-friendly", "user friendly", "madaling gamitin",
        "mahirap gamitin", "nakakalito", "confusing na sundin",
    ],
    # Broad physical-facility fallback — only object nouns that don't already
    # belong to one of the more specific facility subtypes above.
    "Facilities and Equipment": [
        "pasilidad", "kagamitan", "equipment", "facilities", "aparatus",
        "makina", "istruktura", "parking", "paradahan",
    ],
}

GENERAL_FEEDBACK = "General Feedback"

# ---------------------------------------------------------------------------
# TWO-STAGE ZERO-SHOT
# The keyword lexicon above resolves most Taglish comments instantly and
# never touches the model. Zero-shot is the fallback for the minority of
# comments with no keyword anchor (typically plain English or phrasing the
# lexicon doesn't cover). Running every specific candidate through the model
# on every such comment is both slower (more candidates = more compute, and
# CPU zero-shot is already the heaviest step in the pipeline) and,
# empirically, *less* accurate — close-in-meaning subtypes spread across the
# same single classification pass dilute the model's confidence on the
# correct broad category.
#
# So the fallback is staged instead:
#   Stage 1 — classify against the broad categories below (one entry per
#             conceptual group). Fast: short hypotheses, one pass.
#   Stage 2 — only runs if stage 1's winner is a broad bucket that has
#             specific subtypes (Facilities and Equipment, or Staff and
#             Service Quality), and picks which specific subtype fits, or
#             falls back to the group's generic bucket if none clearly fits.
#             This means the extra compute for specificity is only spent on
#             comments that are actually in that group.
# Candidate labels are short noun phrases fed through HYPOTHESIS_TEMPLATE,
# NOT full hand-written sentences. This matches the simple "This example is
# about {}."-style template these MNLI/XNLI zero-shot checkpoints are
# actually calibrated against — empirically it scores meaningfully better
# *and* faster than long custom sentence hypotheses (fewer tokens per
# candidate, and no lexical-overlap artifacts from stuffing example nouns
# into the hypothesis text, e.g. a hypothesis that name-drops "internet,
# wifi" was found to spuriously win on totally unrelated comments just from
# surface word overlap). Taglish examples belong in keyword_topic_override's
# lexicon instead, which is exactly what handles Taglish/local-language
# input already — this template only ever runs on comments that lexicon
# didn't already resolve.
# ---------------------------------------------------------------------------
HYPOTHESIS_TEMPLATE = "This text is about {}."

BROAD_TOPICS = [
    "Queueing and Waiting Time",
    "Transaction Speed",
    "Process Efficiency",
    "Ease of Use",
    "Online System and Portal",
    "Internet Connection",
    "Facilities and Equipment",
    "Staff and Service Quality",
    "Payment and Fees",
    "Document and Credential Processing",
    "Enrollment and Registration",
    "Communication and Information",
]

BROAD_LABELS = {
    "Queueing and Waiting Time": "long queues or waiting in line",
    "Transaction Speed": "the speed of the transaction itself",
    "Process Efficiency": "the process being simple or complicated",
    "Ease of Use": "a system or form being easy or hard to use",
    "Online System and Portal": "an online portal, website, or system account",
    "Internet Connection": "internet or wifi connectivity problems",
    "Facilities and Equipment": "physical facilities or equipment, like aircon, restrooms, or furniture",
    "Staff and Service Quality": "staff behavior, competence, or fairness",
    "Payment and Fees": "fees, payments, or receipts",
    "Document and Credential Processing": "processing of documents, certificates, or credentials",
    "Enrollment and Registration": "enrollment, registration, or matriculation",
    "Communication and Information": "how clearly information or updates were communicated",
}

# broad-topic key -> the specific taxonomy label used when a comment lands
# on that broad bucket but stage 2 doesn't clear its own threshold (or the
# group has no stage 2 at all). Most groups map to themselves 1:1; the two
# grouped buckets (facility / staff) map down to their generic sub-label.
BROAD_TO_SPECIFIC_FALLBACK = {
    "Facilities and Equipment": "Facilities and Equipment",
    "Staff and Service Quality": "Staff Courtesy and Attitude",
}

FACILITY_SUBTOPICS = [
    "Aircon and Cooling",
    "Restroom and Cleanliness",
    "Seating and Furniture",
    "Power and Lighting",
    "Facilities and Equipment",
]

FACILITY_LABELS = {
    "Aircon and Cooling": "the aircon, electric fan, or room temperature",
    "Restroom and Cleanliness": "the restroom or the overall cleanliness of the place",
    "Seating and Furniture": "chairs, benches, tables, or other furniture",
    "Power and Lighting": "electricity, brownouts, or lighting",
    "Facilities and Equipment": "some other physical facility, building, or equipment issue",
}

STAFF_SUBTOPICS = [
    "Staff Courtesy and Attitude",
    "Staff Competence and Knowledge",
    "Fairness and Equal Treatment",
]

STAFF_LABELS = {
    "Staff Courtesy and Attitude": "staff being polite, rude, or courteous",
    "Staff Competence and Knowledge": "staff being knowledgeable or skilled at their job",
    "Fairness and Equal Treatment": "staff treating everyone fairly and without favoritism",
}

# Stage-2 group registry: broad topic -> (candidate list, label map).
SUBTOPIC_GROUPS = {
    "Facilities and Equipment": (FACILITY_SUBTOPICS, FACILITY_LABELS),
    "Staff and Service Quality": (STAFF_SUBTOPICS, STAFF_LABELS),
}

# Confidence floors for each stage. Below the floor, the comment genuinely
# doesn't lean toward any specific theme in that stage, so it stays at the
# broader/safer answer instead of forcing a low-confidence specific guess.
# With ~12 broad candidates a uniform/no-signal read is well under 0.10 each,
# and a real winner clears ~0.20+ in practice; with 3-5 subtypes uniform is
# ~0.20-0.33.
GENERAL_FALLBACK_THRESHOLD = 0.20
SUBTOPIC_THRESHOLD = 0.25

broad_label_list = [BROAD_LABELS[t] for t in BROAD_TOPICS]
broad_label_to_topic = {v: k for k, v in BROAD_LABELS.items()}

# ---------------------------------------------------------------------------
# OFFICE-AWARE HINT (soft, additive — never a hard override)
# The comment text is always the primary signal: keyword hits above resolve
# a comment outright regardless of which office the survey was for, and this
# hint only ever nudges the zero-shot STAGE 1 score by a small additive
# amount before picking the top broad category. That keeps a comment about
# "walang wifi" tagged Internet Connection even on the Registrar's survey —
# the office only breaks genuine near-ties (e.g. a vague "maganda naman"
# style comment with no strong lexical signal in any direction) instead of
# steering a comment that already has a clear textual answer.
#
# Matched against office_name/cluster_name substrings so it stays correct as
# offices are added/renamed, instead of hardcoding office IDs.
# ---------------------------------------------------------------------------
OFFICE_HINT_KEYWORDS = {
    "Payment and Fees": ["accounting", "cashier", "budget", "finance"],
    "Document and Credential Processing": ["registrar", "records"],
    "Enrollment and Registration": ["registrar", "records", "admission"],
    "Facilities and Equipment": ["general services", "supply", "motorpool"],
    "Communication and Information": ["information", "public affairs", "ict", "mis"],
    "Online System and Portal": ["ict", "mis", "information technology"],
}

# Small enough to only decide a near-tie (stage-1 scores of otherwise
# similar candidates typically differ by single-digit-percent margins at the
# uncertain end of the distribution); nowhere near enough to overturn a
# comment with genuine textual signal for a different category.
OFFICE_HINT_BOOST = 0.05


def office_hint_topics(office_text):
    """
    Broad topics to nudge for a given office/cluster name string, or an
    empty set if nothing matches. Case-insensitive substring match against
    OFFICE_HINT_KEYWORDS.
    """
    if not office_text:
        return set()
    lowered = office_text.lower()
    return {
        topic for topic, needles in OFFICE_HINT_KEYWORDS.items()
        if any(needle in lowered for needle in needles)
    }


def keyword_topic_override(text):
    """
    Best-matching topic by object-noun keyword count, or None if no keyword
    hit at all. Empirically, the zero-shot topic model's read on short
    Taglish phrases is unreliable even with a richer hypothesis template —
    e.g. "mahina ang aircon" can score highest on an unrelated category and
    lowest on the correct one. A small additive score boost can't close a
    gap that size, so a keyword hit on these curated, unambiguous
    local-language nouns wins outright instead of just nudging the model.
    The zero-shot model is kept as the fallback for comments that don't
    contain any of these anchors.
    """
    lowered = text.lower()
    hits = {}
    for topic, keywords in TOPIC_KEYWORDS.items():
        count = sum(1 for kw in keywords if re.search(r'\b' + re.escape(kw) + r'\b', lowered))
        if count:
            hits[topic] = count
    if not hits:
        return None
    return max(hits.items(), key=lambda kv: kv[1])[0]


# ---------------------------------------------------------------------------
# FAST PATH — lightweight lexicon heuristics, zero model loading.
# Used for offline-synced comments where the batch is processed after the
# fact with nobody waiting live, so we skip loading any transformer weights
# entirely and rely on local keyword/lexicon matching — "immediate local
# processing" instead of heavy inference.
# ---------------------------------------------------------------------------
FAST_NEGATIVE_WORDS = [
    "mahina", "masama", "pangit", "sira", "sirang", "bastos", "mabagal",
    "matagal", "bobo", "reklamo", "galit", "problema", "hassle",
    "poor", "bad", "slow", "broken", "rude", "worst", "terrible", "awful",
]
FAST_POSITIVE_WORDS = [
    "maganda", "mabilis", "magaling", "mabait", "salamat", "masaya",
    "satisfied", "great", "good", "excellent", "fast", "helpful",
    "friendly", "nice", "the best", "love it", "hassle-free", "hassle free",
]


def fast_sentiment(text):
    lowered = text.lower()
    pos = sum(1 for w in FAST_POSITIVE_WORDS if w in lowered)
    # Strip matched positive phrases before scanning for negative words, so a
    # positive phrase containing a negative substring (e.g. "hassle-free"
    # contains "hassle") isn't double-counted as evidence for both sides.
    masked = lowered
    for w in FAST_POSITIVE_WORDS:
        masked = masked.replace(w, " ")
    neg = sum(1 for w in FAST_NEGATIVE_WORDS if w in masked)
    if neg > pos:
        return "Negative"
    if pos > neg:
        return "Positive"
    return "Neutral"


def fast_topic(text):
    return keyword_topic_override(text) or GENERAL_FEEDBACK
