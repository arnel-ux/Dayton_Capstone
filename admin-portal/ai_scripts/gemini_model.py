"""
Gemini-based classifier — replaces the local mDeBERTa zero-shot topic model
and the tabularisai sentiment transformer. As of the 2026-09-22 pure-AI
classification project, this is used two ways:
  - ONLINE (heavy_model.analyze_pure_ai): the SOLE classifier for live
    comments — the keyword lexicon is never consulted at all, since AI
    speed/consistency for live submissions is the priority.
  - OFFLINE (heavy_model.analyze): the fallback, reached only when
    topic_common's keyword lexicon finds ZERO anchors in a comment (see
    keyword_topic_override / lexicon_sentiment docstrings for why the
    lexicon always wins outright on a hit there).

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
    "Processing": "How long a transaction, its wait beforehand, or the release of its result took — waiting in line, being attended to, or waiting for an outcome/result to come out. Not about the number of steps involved (Service Procedure) and not about approval specifically (Approval Process).",
    "Service Procedure": "Whether the STEPS of a process were simple or needlessly complicated — too many steps, redundant requirements, being sent back and forth between offices/windows, or being referred elsewhere. Not about how clearly things were explained (Communication and Information) and not about raw speed (Processing).",
    "Requirements": "Whether the required documents/qualifications for a service were clear, complete, or attainable — confusion about what's needed, missing/incomplete requirements, or not meeting eligibility criteria.",
    "Approval Process": "Getting a request, form, or document approved, signed, or endorsed by an authority — approval speed, status, or the signature/endorsement step itself.",
    "Communication and Information": "Whether the person was clearly told/explained what they needed to know — being kept informed of updates or schedule changes, getting a clear vs. confusing/contradicting explanation or answer, being redirected without explanation, or not being told what was happening. USE THIS whenever the core complaint or praise is about the CLARITY, CONSISTENCY, or existence of information/explanation given — even if it was a staff member who gave (or failed to give) that information. Prefer this over Staff Service when the issue is about what was said (not how politely or competently), and over Service Procedure when the issue is about confusing/missing information rather than the number of steps.",
    "Staff Service": "How staff, faculty, guards, or any personnel treated or helped the person — DEMEANOR/ATTITUDE (polite, rude, courteous, discourteous, including implied attitude like coldness or reluctance to help), COMPETENCE (knowledgeable, well-trained, giving a correct/consistent answer, or failing to), FAIRNESS (favoritism, bias, unequal treatment), or ASSISTANCE (being accommodated, attended to, or helped). This can be about STAFF, FACULTY, STUDENTS, or anyone else the comment names as behaving this way — do not assume it's always staff. Not whether what they said was clear (Communication and Information) — this is about how someone treated or assisted another person, or how skilled/fair they were.",
    "Documents and Records": "Processing, issuing, or correcting documents/credentials/records: transcripts, diplomas, certificates, IDs, HR employee records. Not about approval/signature specifically (Approval Process) and not about a physical ID card being printed/released (ID Services).",
    "System and Access": "An online portal, website, account, or login system — logging in, account activation/recovery, or the system glitching/crashing/losing data. Not about the system being confusing to use, as opposed to broken (Ease of Use), and not about internet connectivity itself (Internet Service).",
    "Ease of Use": "Whether a system, form, or portal's INTERFACE/DESIGN itself was easy or confusing to navigate — as opposed to it being down/broken (System and Access). Not about the overall process having too many steps (Service Procedure).",
    "Internet Service": "Internet or wifi connectivity/signal problems, or internet subscription/access renewal at the Internet Center.",
    "Scheduling and Availability": "Whether an appointment, exam, or service slot was available and scheduled — appointment/exam availability, fully-booked slots, or schedule confirmation. Not about waiting in line once already there (Processing).",
    "Financial Transaction": "Paying fees, tuition, or other charges — payment processing/posting, receipts, reimbursement/liquidation of expenses, account balances, or remittances. Not about a scholarship grant's own amount or release (Scholarship and Assistance).",
    "Facilities and Resources": "Physical facilities or equipment — aircon/cooling, restroom, general cleanliness/tidiness, seating/furniture, power/lighting, appearance/upkeep, actual equipment/machines, building/structure, parking, or resource availability. Also covers printers/computer labs. A vague complaint/praise that only names the PLACE itself (\"opisina\", \"office\", \"dito\") with a generic quality judgment (\"hindi maayos\", \"ayos naman\", \"okay lang\") and no specific aspect — no dirt/smell, no named appearance phrase like \"pangit\"/\"presentable\", no named equipment, no temperature, no furniture — stays at the plain \"Facilities and Resources\" topic with NO sub-item; do not pick \"Equipment/Machine\" unless an actual device/machine is named (printer, computer, kagamitan, makina), and do not pick \"Appearance/Condition\" unless a specific appearance/presentability word or phrase is used, not just a generic \"maayos\"/\"ayos\" judgment. IMPORTANT sub-item rule for the restroom specifically: a dirt/smell/mess word (\"madumi\", \"marumi\", \"dumi\", \"mabaho\", \"maalikabok\", \"makalat\", \"dirty\", \"smelly\", \"unsanitary\", etc.) ALWAYS wins \"Cleanliness\" over \"Restroom Condition\", even when the comment ALSO names the restroom/CR/banyo — the location word being present is not a reason to prefer \"Restroom Condition\" once an actual dirt/smell/mess word is there. Reserve \"Restroom Condition\" for restroom comments with NO dirt/smell/mess word at all (missing supplies, broken fixtures, locked/unavailable, etc.) — e.g. \"madumi ang cr\" is Cleanliness, not Restroom Condition; \"walang tissue sa cr\" is Restroom Condition, not Cleanliness. Not about people loitering or hanging around (Bystanders and Loitering) even if it happens near a building, and not library/dormitory/transportation specifically (their own topics).",
    "Bystanders and Loitering": "Idle outsiders, non-clients, or bystanders hanging around/loitering ('tambay', 'mga standby') — noise, crowding, or disturbance they cause. Not about the physical building/facility itself (Facilities and Resources) and not about staff/student attitude (Staff Service) — this is specifically about uninvolved people just standing/hanging around.",
    "Scholarship and Assistance": "Scholarship applications, eligibility, grant amounts, or grant release/financial assistance disbursement.",
    "Enrollment Process": "Enrollment, registration, matriculation, shifting, cross-enrollment, or re-admission. Not about adding/dropping subjects or grade changes once already enrolled (Academic Transaction).",
    "Academic Transaction": "Adding/dropping subjects, grade changes/corrections, applying for graduation, or entrance examinations, once a student is already enrolled.",
    "Health Service": "Seeing a doctor, dentist, or nurse at the campus health clinic, or getting a medical certificate.",
    "Clearance Process": "Getting an accounting/administrative clearance processed or its status checked.",
    "Leave Process": "Applying for or processing an employee's leave of absence (with or without pay).",
    "Accreditation Process": "A student organization's accreditation application or status.",
    "Complaint Handling": "How a formal complaint or grievance itself was handled — the response, follow-up, or resolution process for a complaint the person filed. Not the underlying issue being complained about (pick that topic instead) — this is specifically about the complaint-handling process.",
    "ID Services": "Applying for, printing, or releasing a physical ID card (student or employee). Not about the identifying information on a document being wrong (Documents and Records).",
    "Dormitory Service": "Applying for or renewing a dormitory bed space or housing.",
    "Supplies and Resources": "Requesting or receiving supplies, materials, or accountable forms from a supply/property office.",
    "Transportation Service": "College transportation/vehicle services — vehicle availability or a transportation request.",
    "Library Service": "Borrowing or returning library books, or book/library resource availability.",
    "Research Service": "Research assistance or consultation provided to a client.",
    "General Service": "A generic office service with no more specific topic above clearly fitting — service information, accessibility, or an overall process/request, for an office whose services aren't individually specialized enough to name a more specific topic.",
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

# MAX_TOPICS caps how many distinct topics one comment can be tagged with —
# added 2026-09-25 (multi-topic tagging project) after finding a comment that
# genuinely names two unrelated things (e.g. "matagal ang transaction pero
# maayos ang kalinisan") only ever got the single most-salient one, silently
# dropping the other from every topic-frequency report. Sentiment stays a
# single verdict for the WHOLE comment (not per-topic) — see PROMPT_TEMPLATE.
# Capped (not unbounded) so Gemini doesn't pad the list with tangentially
# related topics just because the array field exists.
MAX_TOPICS = 3

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "sentiment": {"type": "string", "enum": SENTIMENTS},
        "topics": {
            "type": "array",
            "items": {"type": "string", "enum": ALL_TOPICS},
            "minItems": 1,
            "maxItems": MAX_TOPICS,
        },
    },
    "required": ["sentiment", "topics"],
}


def _build_topic_guide():
    lines = []
    for t in candidate_topics + [GENERAL_FEEDBACK]:
        lines.append(f"- {t}: {TOPIC_DESCRIPTIONS[t]}")
        items = TOPIC_ITEM_KEYWORDS.get(t)
        if items:
            for label, keywords in items:
                hint = _item_hint(keywords)
                lines.append(f"    - {label} (e.g. {hint})" if hint else f"    - {label}")
    return "\n".join(lines)


_TOPIC_GUIDE = _build_topic_guide()

PROMPT_TEMPLATE = """You are classifying a student/client feedback comment submitted to a Philippine state college (CSPC) located in Camarines Sur, Bicol region. The comment may be in English, Tagalog, or Taglish (mixed) — it may also include Bikol (the regional language of that area), regional slang, informal shorthand/textspeak, or dialectal spelling variants (e.g. "madunong"/"madumi" instead of "marunong"/"marumi"). If a word or phrase is unfamiliar, infer its meaning from context and sentence structure rather than skipping or misreading it.

Classify the comment on two axes:

1. sentiment: Positive, Negative, or Neutral — ONE verdict for the comment AS A WHOLE, even if it names multiple topics. MANDATORY RULE for a mixed comment (a genuine positive claim about one thing AND a genuine negative claim about another thing, whether or not joined by a contrastive word like "pero"/"kaso"/"nga lang"/"but"/"however"): this is ALWAYS Neutral, regardless of which point seems more important, bigger, or more specific than the other — never pick a side just because one complaint or compliment feels more serious. For example, "mabilis naman ang transaction kaso nga lang masusungit ang mga empleyado dun" (fast transaction, BUT the employees are rude) has one real positive claim and one real negative claim about two different things — this is Neutral, not Negative, even though the staff complaint might seem like the more serious issue. Only pick Positive or Negative when the comment's substantive claims all point the same direction — a comment can still repeat or elaborate on the SAME single point (e.g. "maganda ang serbisyo, mabilis talaga" is still Positive, both clauses praise the same thing) without becoming mixed; it becomes Neutral only once a second, genuinely separate aspect is judged in the opposite direction. Watch for negation ("walang problema" = no problem = Positive), sarcasm, and temporal contrast (a comment praising how things "used to be" while complaining about "now" should be scored on the CURRENT state being described, not the past one).

2. topics: a list of 1 to {max_topics} best-fitting labels from this fixed list. MOST comments are about only ONE thing — return a single-item list unless the comment CLEARLY and specifically discusses multiple distinct things (e.g. "matagal ang transaction pero maayos ang kalinisan ng opisina" names two separate, unrelated topics and should return both; "sobrang tagal ng transaction" names only one). Never pad the list with a second topic that's only tangentially related or restates the same underlying issue. Some topics have more specific sub-items indented beneath them (with example trigger words) — pick the SPECIFIC sub-item ONLY when the comment clearly and specifically names that particular thing; otherwise use the general parent topic above it with no sub-item. A generic quality judgment word alone ("hindi maayos", "maayos naman", "ayos lang", "okay lang", "good", "bad") is NOT enough on its own to pick a specific sub-item — it only justifies one when it is paired with, or replaced by, something concrete the sub-item is actually about (an object, a place-specific issue, a named symptom). For example, "hindi maayos yung opisina" names only the office in general with a generic judgment and no equipment, dirt, temperature, or appearance-specific word — this must stay at the plain parent topic, never a specific sub-item like "Equipment/Machine" just because the item existed in the list. When genuinely unsure between the parent topic and one of its sub-items, prefer the parent topic. Use "General Feedback" only when nothing else genuinely fits, and only as the LIST'S ONLY entry (never alongside a real topic).
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
        topic_guide=_TOPIC_GUIDE, office_context=office_context, comment=text,
        max_topics=MAX_TOPICS
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
    Returns (sentiment, topics) using Gemini 3.5 Flash-Lite — sentiment is a
    single string, topics is a non-empty list of 1-MAX_TOPICS strings (see
    the multi-topic tagging project, 2026-09-25: most comments still return
    exactly one topic, but a comment that clearly names multiple distinct
    things, e.g. transaction speed AND cleanliness, returns each of them
    instead of silently keeping only the more salient one). Constrained to
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
            raw_topics = data.get("topics")
            if sentiment not in SENTIMENTS:
                sentiment = "Neutral"
            topics = [t for t in raw_topics if t in ALL_TOPICS] if isinstance(raw_topics, list) else []
            if not topics:
                topics = [GENERAL_FEEDBACK]
            else:
                # De-dupe while preserving order — the schema doesn't forbid
                # Gemini repeating a label across the array.
                seen = set()
                topics = [t for t in topics if not (t in seen or seen.add(t))][:MAX_TOPICS]
            return sentiment, topics
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
