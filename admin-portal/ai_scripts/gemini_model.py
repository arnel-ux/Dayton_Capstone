"""
Gemini-based fallback classifier — replaces the local mDeBERTa zero-shot
topic model and the tabularisai sentiment transformer as the AI fallback
that heavy_model.py reaches for only when topic_common's keyword lexicon
finds ZERO anchors in a comment (see keyword_topic_override / lexicon_sentiment
docstrings for why the lexicon always wins outright on a hit).

Why swap the fallback specifically (not the lexicon, not the overall
architecture): mDeBERTa zero-shot and tabularisai are both narrow models with
no real grip on code-switched Taglish reasoning (negation, sarcasm, temporal
contrast) — confirmed via the 2026-08-24/25 confidence-dump experiments in
heavy_model.py's old classify_topic/classify_sentiment docstrings, where the
model's own confidence didn't separate right answers from wrong ones on this
data at all. Gemini is a general-purpose LLM that can actually read the
sentence instead of scoring embedding similarity, so it should do better on
exactly the cases the lexicon can't resolve.

Kept CONSISTENT with the existing taxonomy on purpose: candidate_topics (the
same list keyword_topic_override resolves to) plus every "{Topic} - {Item}"
label from TOPIC_ITEM_KEYWORDS are all valid outputs here too (added
2026-08-29) — built directly from that same dict so the two paths can never
drift apart. Unlike the keyword lexicon, which can only refine to an item
when the comment contains one of that item's specific keywords, Gemini
decides item-vs-parent-topic itself from the full sentence (see
PROMPT_TEMPLATE's instruction to only pick a sub-item when the comment
clearly names that specific thing) — this is what lets a comment resolved
here reach the same specificity as a lexicon hit, which the old mDeBERTa
fallback could never do at all.
"""
import json
import logging
import os
import time

from topic_common import candidate_topics, GENERAL_FEEDBACK, TOPIC_ITEM_KEYWORDS

# The SDK logs a harmless "AFC is enabled" / "not recommended" advisory on
# every single call since we use the plain generate_content() request/reply
# API (no tool/function-calling, so AFC never actually does anything) rather
# than its Chat wrapper — silenced so it doesn't spam production logs on
# every classified comment.
logging.getLogger("google_genai.models").setLevel(logging.ERROR)

try:
    from dotenv import load_dotenv
    # Loads admin-portal/.env into os.environ when this module is imported
    # standalone (python test_accuracy.py, python analyze.py). A no-op when
    # server.js already spawned this process with .env merged into
    # process.env (dotenv won't override already-set vars).
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except ImportError:
    pass

MODEL_NAME = "gemini-3.5-flash-lite"

SENTIMENTS = ["Positive", "Negative", "Neutral"]

# One short line per topic so Gemini has an unambiguous definition to pick
# from, instead of guessing at what a bare label like "Process Efficiency"
# is meant to cover. Deliberately short — Gemini doesn't need the Taglish
# keyword examples the zero-shot model needed, it can read the sentence.
TOPIC_DESCRIPTIONS = {
    "Queueing and Waiting Time": "Waiting in line or for a turn to be served, BEFORE being attended to. Not about how fast things went once it was your turn (that's Transaction Speed).",
    "Transaction Speed": "How fast a transaction moved once it started/was your turn — e.g. how quickly a result, receipt, or approval came out. Not about waiting in line beforehand (Queueing) and not about the number of steps involved (Process Efficiency).",
    "Process Efficiency": "Whether the STEPS of a process were simple or needlessly complicated — too many steps, redundant requirements, being sent back and forth between offices/windows for the SAME transaction. Not about how clearly things were explained (Communication and Information) and not about raw speed (Transaction Speed).",
    "Ease of Use": "Whether a system, form, or portal's INTERFACE/DESIGN itself was easy or confusing to navigate. Not about the overall process having too many steps (Process Efficiency) and not about staff giving confusing verbal information (Communication and Information).",
    "Online System and Portal": "An online portal, website, account, or login system not working, glitching, or losing data.",
    "Internet Connection": "Internet or wifi connectivity/signal problems.",
    "Aircon and Cooling": "Air conditioning, electric fans, or room temperature.",
    "Restroom and Cleanliness": "Restrooms/comfort rooms or general cleanliness of the place.",
    "Seating and Furniture": "Chairs, benches, tables, or other furniture.",
    "Power and Lighting": "Electricity, brownouts/blackouts, or lighting.",
    "Facilities and Equipment": "Other physical facilities/equipment/buildings not covered above (also covers library, dormitory, parking, transportation, printers/computer labs).",
    "Staff Courtesy and Attitude": "Staff being polite, rude, courteous, or their general DEMEANOR/ATTITUDE — including implied attitude, not just explicitly named rudeness: seeming to want the person gone, treating someone as a burden/unwelcome, visible annoyance or reluctance to help, coldness. Not whether what they said was clear or correct (Communication and Information / Staff Competence) — this is purely about how they treated the person.",
    "Staff Competence and Knowledge": "Staff being knowledgeable, skilled, well-trained, or giving the CORRECT/CONSISTENT answer based on their expertise (or failing to — not knowing something, giving contradicting answers, seeming untrained). Not whether they were polite (Staff Courtesy) and not whether information was clearly communicated in general (Communication and Information) — this is specifically about whether staff KNEW what they were doing.",
    "Fairness and Equal Treatment": "Favoritism, bias, or unequal/unfair treatment.",
    "Payment and Fees": "Fees, payments, tuition, or receipts.",
    "Document and Credential Processing": "Processing documents/credentials: transcripts, diplomas, certificates, IDs, grade changes.",
    "Enrollment and Registration": "Enrollment, registration, matriculation, shifting, or re-admission.",
    "Communication and Information": "Whether the person was clearly told/explained what they needed to know — being kept informed of updates or schedule changes, getting a clear vs. confusing/contradicting explanation or answer, being redirected without explanation, or not being told what was happening. USE THIS whenever the core complaint or praise is about the CLARITY, CONSISTENCY, or existence of information/explanation given — even if it was a staff member who gave (or failed to give) that information. Prefer this over Staff Courtesy when the issue is about what was said (not how politely), over Staff Competence when the issue is about being kept informed (not whether staff knew the technical answer), and over Process Efficiency when the issue is about confusing/missing information rather than the number of steps.",
    "Health and Medical Services": "Seeing a doctor, dentist, or nurse at the campus health clinic.",
    "Guidance and Counseling Services": "Guidance counseling or the guidance office.",
    "Scholarship and Financial Assistance": "Scholarship applications, grants, or financial assistance.",
    GENERAL_FEEDBACK: "Vague, generic praise/complaint with NO specific identifiable cause named — no concrete process, person, system, or facility issue mentioned, even if the sentiment itself is clear (e.g. \"I had a great day\" or \"it was disappointing\" with no reason given). If the comment names a concrete cause, pick that topic instead, even if the phrasing is sarcastic or indirect.",
}

# ---------------------------------------------------------------------------
# ITEM-LEVEL LABELS (added 2026-08-29 so Gemini can match the lexicon's
# specificity, e.g. "Aircon and Cooling - Electric Fan" instead of stopping
# at the plain "Aircon and Cooling"). Built directly from topic_common's
# TOPIC_ITEM_KEYWORDS — the same source of truth the keyword lexicon uses —
# so the two paths can never drift out of sync, and each item's example
# keywords double as a compact hint for Gemini without hand-writing a
# separate description for every one of the ~50 items.
# ---------------------------------------------------------------------------
def _item_hint(keywords):
    examples = [kw if isinstance(kw, str) else kw[0] for kw in keywords[:3]]
    return ", ".join(examples)


ALL_TOPICS = candidate_topics + [GENERAL_FEEDBACK] + [
    label for items in TOPIC_ITEM_KEYWORDS.values() for label, _ in items
]

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "sentiment": {"type": "string", "enum": SENTIMENTS},
        "topic": {"type": "string", "enum": ALL_TOPICS},
    },
    "required": ["sentiment", "topic"],
}


def _build_topic_guide():
    lines = []
    for t in candidate_topics + [GENERAL_FEEDBACK]:
        lines.append(f"- {t}: {TOPIC_DESCRIPTIONS[t]}")
        items = TOPIC_ITEM_KEYWORDS.get(t)
        if items:
            for label, keywords in items:
                lines.append(f"    - {label} (e.g. {_item_hint(keywords)})")
    return "\n".join(lines)


_TOPIC_GUIDE = _build_topic_guide()

PROMPT_TEMPLATE = """You are classifying a student/client feedback comment submitted to a Philippine state college (CSPC) located in Camarines Sur, Bicol region. The comment may be in English, Tagalog, or Taglish (mixed) — it may also include Bikol (the regional language of that area), regional slang, informal shorthand/textspeak, or dialectal spelling variants (e.g. "madunong"/"madumi" instead of "marunong"/"marumi"). If a word or phrase is unfamiliar, infer its meaning from context and sentence structure rather than skipping or misreading it.

Classify the comment on two axes:

1. sentiment: Positive, Negative, or Neutral. Read the whole comment for overall meaning — watch for negation ("walang problema" = no problem = Positive), sarcasm, and temporal contrast (a comment praising how things "used to be" while complaining about "now" should be scored on the CURRENT state being described, not the past one).

2. topic: pick exactly ONE best-fitting label from this fixed list. Some topics have more specific sub-items indented beneath them (with example trigger words) — pick the SPECIFIC sub-item ONLY when the comment clearly names that particular thing; otherwise use the general parent topic above it. Do not force-fit a sub-item when the comment is only generally about the parent topic without naming the specific item. Use "General Feedback" only when nothing else genuinely fits.
{topic_guide}

{office_context}The comment text is always the primary and decisive signal — use the office context above only to break a genuine tie, never to override what the comment text actually says.

Comment: {comment}
"""


def _build_prompt(text, office_hint=None):
    office_context = (
        f"This comment was submitted on a survey for: {office_hint}. "
        if office_hint else ""
    )
    return PROMPT_TEMPLATE.format(
        topic_guide=_TOPIC_GUIDE, office_context=office_context, comment=text
    )


# ---------------------------------------------------------------------------
# CLIENT-SIDE THROTTLE
# The free tier caps at 15 requests/minute per model. Real production
# traffic (one admin portal, submissions trickling in) will basically never
# hit this, but the accuracy test harnesses (test_accuracy.py, and any batch
# re-scoring) fire many calls back-to-back and WILL blow past it without
# this — confirmed empirically: an unthrottled run hit repeated 429s.
# Capping at 12/60s (under the real 15/60s limit) here, at the call site,
# means every caller is automatically safe without needing to remember to
# pace itself.
# ---------------------------------------------------------------------------
_call_times = []
_MAX_CALLS_PER_WINDOW = 12
_WINDOW_SECONDS = 60


def _throttle():
    global _call_times
    now = time.time()
    _call_times = [t for t in _call_times if now - t < _WINDOW_SECONDS]
    if len(_call_times) >= _MAX_CALLS_PER_WINDOW:
        sleep_for = _WINDOW_SECONDS - (now - _call_times[0]) + 0.5
        if sleep_for > 0:
            time.sleep(sleep_for)
        now = time.time()
        _call_times = [t for t in _call_times if now - t < _WINDOW_SECONDS]
    _call_times.append(time.time())


_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set (checked process env and admin-portal/.env)"
            )
        _client = genai.Client(api_key=api_key)
    return _client


def classify(text, office_hint=None, max_retries=3):
    """
    Returns (sentiment, topic) using Gemini 3.5 Flash-Lite, constrained to
    this project's existing sentiment/topic taxonomy via a JSON schema so an
    out-of-taxonomy label is structurally impossible, not just requested.

    Retries on transient errors (network blips, 429 rate limit) with a short
    backoff; raises on the last attempt so the caller can decide how to
    degrade (see heavy_model.py's fallback-of-fallback handling).
    """
    from google.genai import types

    client = _get_client()
    prompt = _build_prompt(text, office_hint)

    last_err = None
    for attempt in range(max_retries):
        _throttle()
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=RESPONSE_SCHEMA,
                    temperature=0,
                    http_options=types.HttpOptions(timeout=15000),  # ms — bound a hung request instead of blocking a live comment submission indefinitely
                ),
            )
            data = json.loads(response.text)
            sentiment = data.get("sentiment")
            topic = data.get("topic")
            if sentiment not in SENTIMENTS:
                sentiment = "Neutral"
            if topic not in ALL_TOPICS:
                topic = GENERAL_FEEDBACK
            return sentiment, topic
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                # A 429 needs to wait out most of the rate-limit window, not
                # a quick exponential backoff — the throttle above should
                # normally prevent these, but a burst from multiple
                # processes (e.g. a manual test run overlapping with live
                # traffic) can still trigger one occasionally.
                is_rate_limit = "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)
                time.sleep(20 if is_rate_limit else 2 ** attempt)
    raise last_err
