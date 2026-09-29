"""
This is the Gemini classifier. It reads every comment and decides its
sentiment and topics. The topic list comes straight from topic_common.py
so both files always agree on what topics exist.
"""
import json
import logging
import os
import time

from topic_common import candidate_topics, GENERAL_FEEDBACK, TOPIC_ITEM_KEYWORDS

# Quiets a harmless SDK log message that would otherwise spam the console.
logging.getLogger("google_genai.models").setLevel(logging.ERROR)

try:
    from dotenv import load_dotenv
    # Loads the .env file when this script runs on its own.
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except ImportError:
    pass

MODEL_NAME = "gemini-3.5-flash-lite"

SENTIMENTS = ["Positive", "Negative", "Neutral"]

# A short description for each topic, shown to Gemini so it knows what
# each one means.
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
    "Facilities and Resources": "Physical facilities or equipment — aircon/cooling, restroom, general cleanliness/tidiness, seating/furniture, power/lighting, appearance/upkeep, actual equipment/machines, building/structure, parking, or resource availability. Also covers printers/computer labs. A vague complaint/praise that only names the PLACE itself (\"opisina\", \"office\", \"dito\") with a generic quality judgment (\"hindi maayos\", \"ayos naman\", \"okay lang\") and no specific aspect — no dirt/smell/mess, no named appearance phrase like \"pangit\"/\"presentable\", no named equipment, no temperature, no furniture — stays at the plain \"Facilities and Resources\" topic with NO sub-item; do not pick \"Equipment/Machine\" unless an actual device/machine is named (printer, computer, kagamitan, makina), and do not pick \"Appearance/Condition\" unless a specific appearance/presentability word or phrase is used, not just a generic \"maayos\"/\"ayos\" judgment. IMPORTANT sub-item rule, for ANY facility/office comment, not restroom comments alone: a dirt/smell/mess word (\"madumi\", \"marumi\", \"dumi\", \"magulo\", \"makalat\", \"mabaho\", \"maalikabok\", \"dirty\", \"messy\", \"smelly\", \"unsanitary\", etc.) is itself a concrete, specific aspect, so it ALWAYS earns the \"Cleanliness\" sub-item instead of staying at the plain parent topic — this applies just as much to a general \"magulo yung opisina\" (the office is messy) as it does to a restroom comment. When the comment ALSO names the restroom/CR/banyo, that same dirt/smell/mess word ALWAYS wins \"Cleanliness\" over \"Restroom Condition\" too — the location word being present is not a reason to prefer \"Restroom Condition\" once an actual dirt/smell/mess word is there. Reserve \"Restroom Condition\" for restroom comments with NO dirt/smell/mess word at all (missing supplies, broken fixtures, locked/unavailable, etc.) — e.g. \"madumi ang cr\" is Cleanliness, not Restroom Condition; \"walang tissue sa cr\" is Restroom Condition, not Cleanliness; \"magulo yung office\" (with no restroom mentioned at all) is Cleanliness, not the bare parent topic. Not about people loitering or hanging around (Bystanders and Loitering) even if it happens near a building, and not library/dormitory/transportation specifically (their own topics).",
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

# Turns a subtopic's example words into a short hint string for the prompt.
def _item_hint(keywords):
    examples = [kw if isinstance(kw, str) else kw[0] for kw in keywords[:3]]
    return ", ".join(examples)


ALL_TOPICS = candidate_topics + [GENERAL_FEEDBACK] + [
    label for items in TOPIC_ITEM_KEYWORDS.values() for label, _ in items
]

# The most topics one comment can be tagged with at once.
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


# Keeps calls to Gemini under the free tier's rate limit.
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


def classify(text, office_hint=None, max_retries=5):
    """
    Asks Gemini to classify one comment and returns (sentiment, topics).
    Retries a couple times if the request fails before giving up.
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
                    http_options=types.HttpOptions(timeout=15000),  # 15 second timeout
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
                # Removes duplicate topics if Gemini repeats one.
                seen = set()
                topics = [t for t in topics if not (t in seen or seen.add(t))][:MAX_TOPICS]
            return sentiment, topics
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                err_text = str(e)
                is_rate_limit = "429" in err_text or "RESOURCE_EXHAUSTED" in err_text
                # A 503/UNAVAILABLE means Gemini itself is momentarily overloaded,
                # not that the request is bad — this clears within seconds to tens
                # of seconds, so it's worth a real wait instead of a quick retry.
                is_overloaded = "503" in err_text or "UNAVAILABLE" in err_text
                if is_rate_limit:
                    time.sleep(20)
                elif is_overloaded:
                    time.sleep(10)
                else:
                    time.sleep(2 ** attempt)
    raise last_err
