"""
Shared taxonomy, keyword anchors, and lightweight heuristics used by both
analyze.py (CLI / standalone fallback) and heavy_model.py (persistent
model-server path). Keeping this in one module means the fast/offline
heuristic path and the full model path can never silently drift apart.
"""
import re

# ---------------------------------------------------------------------------
# TOPIC TAXONOMY
# "Facilities and Equipment" used to be one catch-all bucket for anything
# physical — aircon, restrooms, chairs, lighting all landed on the same
# generic tag. That's not useful for an office trying to act on feedback, so
# the physical-facility comments are now split into the specific thing being
# complained/praised about. "Facilities and Equipment" is kept as a narrower
# fallback for physical-facility comments that don't name one of those
# specific things (e.g. "sirang gusto", generic "pasilidad").
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
    "Internet Connection",
    "Aircon and Cooling",
    "Restroom and Cleanliness",
    "Seating and Furniture",
    "Power and Lighting",
    "Facilities and Equipment",
    "Customer Service",
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
# Only *object nouns* (aircon, wifi, pila) are used as anchors — never bare
# descriptors like "mabagal"/"mahina"/"malinis" alone, since those are
# ambiguous across every category (slow queue vs slow wifi vs weak aircon,
# clean restroom vs clean process) and would misfire.
#
# Dict order matters for keyword_topic_override's tie-break: the broad
# "Facilities and Equipment" fallback bucket is listed LAST so that on an
# equal keyword-hit count, a more specific facility subtype (Aircon,
# Restroom, Seating, Power) always wins over the generic bucket.
# ---------------------------------------------------------------------------
TOPIC_KEYWORDS = {
    "Queueing and Waiting Time": [
        "pila", "linya", "queue", "queueing", "waiting line", "numero", "hintay",
    ],
    "Internet Connection": [
        "internet", "wifi", "wi-fi", "signal", "network", "koneksyon", "online system",
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
    "Customer Service": [
        "staff", "kawani", "empleyado", "tauhan", "employee", "receptionist",
        "guard", "security", "clerk",
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
# lexicon doesn't cover). Running all 11 specific candidates through the
# model on every such comment is both slower (more candidates = more
# compute, and CPU zero-shot is already the heaviest step in the pipeline)
# and, empirically, *less* accurate — the four facility subtypes are close
# enough in meaning that spreading them across the same single classification
# pass dilutes the model's confidence on the correct broad category.
#
# So the fallback is staged instead:
#   Stage 1 — classify against the 7 broad categories (same shape as the
#             original taxonomy). Fast: fewer candidates, short hypotheses.
#   Stage 2 — only runs if stage 1's winner is the broad "Facilities and
#             Equipment" bucket, and picks which specific facility subtype
#             (aircon/restroom/furniture/power) fits, or confirms the
#             general bucket if none clearly fits. This means the extra
#             compute for specificity is only spent on comments that are
#             actually facility-related.
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
    "Internet Connection",
    "Facilities and Equipment",
    "Customer Service",
]

BROAD_LABELS = {
    "Queueing and Waiting Time": "long queues or waiting in line",
    "Transaction Speed": "the speed of the transaction itself",
    "Process Efficiency": "the process being simple or complicated",
    "Ease of Use": "a system or form being easy or hard to use",
    "Internet Connection": "internet or wifi connectivity problems",
    "Facilities and Equipment": "physical facilities or equipment, like aircon, restrooms, or furniture",
    "Customer Service": "staff behavior or courtesy",
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

# Confidence floors for each stage. Below the floor, the comment genuinely
# doesn't lean toward any specific theme in that stage, so it stays at the
# broader/safer answer instead of forcing a low-confidence specific guess.
# With 7 broad candidates a uniform/no-signal read is ~0.14 each, and a real
# winner clears ~0.25+ in practice; with 5 facility subtypes uniform is ~0.20.
GENERAL_FALLBACK_THRESHOLD = 0.25
FACILITY_SUBTOPIC_THRESHOLD = 0.25

broad_label_list = [BROAD_LABELS[t] for t in BROAD_TOPICS]
broad_label_to_topic = {v: k for k, v in BROAD_LABELS.items()}

facility_label_list = [FACILITY_LABELS[t] for t in FACILITY_SUBTOPICS]
facility_label_to_topic = {v: k for k, v in FACILITY_LABELS.items()}


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
