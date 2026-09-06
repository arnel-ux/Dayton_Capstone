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
# TOPIC TAXONOMY
# Split into topics specific enough that an admin reading a feedback report
# can tell what a comment is about from its topic tag alone, without opening
# the comment text. Grouped conceptually:
#   - Speed/process:      Queueing and Waiting Time, Transaction,
#                          Process Efficiency
#   - Systems:             Ease of Use, Online System and Portal,
#                          Internet Connection
#   - Physical facility:   Aircon and Cooling, Restroom, Cleanliness,
#                          Seating and Furniture, Power and Lighting,
#                          Facilities and Equipment (narrow fallback)
#   - People:              Courtesy and Attitude,
#                          Staff Competence and Knowledge,
#                          Fairness and Equal Treatment,
#                          Bystanders and Loitering
#   - Transaction-specific: Payment and Fees, Document and Credential
#                          Processing, Enrollment and Registration,
#                          Scholarship and Financial Assistance
#   - Service-specific:    Health and Medical Services,
#                          Guidance and Counseling Services
#   - Information:          Communication and Information
#
# "Facilities and Equipment" is a narrower fallback for physical-facility
# comments that don't name one of the more specific facility subtypes
# (e.g. "sirang gusto", generic "pasilidad") — it also covers library,
# dormitory, and transportation complaints via item-level refinement (see
# TOPIC_ITEM_KEYWORDS) since those are physical/logistics services without
# enough distinct comment volume to justify their own top-level topic.
# Likewise "Courtesy and Attitude" doubles as the default bucket for
# demeanor-related comments that don't clearly single out competence or
# fairness specifically — item-level refinement (see TOPIC_ITEM_KEYWORDS)
# further breaks it down by WHO the attitude complaint is about (staff,
# student, faculty, guard, etc.) instead of assuming it's always staff.
#
# "Restroom" and "Cleanliness" were split from the single combined
# "Restroom and Cleanliness" topic on 2026-08-31 — a comment about general
# office/area messiness (e.g. "makalat ang office nila") was landing on a
# label that literally says "Restroom" even though no restroom was involved
# at all, which read as a misclassification to admins reviewing the tag.
# Restroom-specific words (banyo/CR/toilet, and the supplies used there)
# stay in "Restroom"; general tidiness/dirtiness words with no restroom word
# present go to "Cleanliness".
#
# "Bystanders and Loitering" was added 2026-08-31 — comments about idle
# people/outsiders hanging around ("nakatambay", "mga standby") were
# previously falling through to either "General Feedback" or, worse, getting
# misread by the AI fallback as a "Facilities and Equipment - Building/
# Structure" comment purely because a physical-location word like "building"
# appeared nearby, even though the complaint is about people, not the
# structure.
#
# Health and Medical Services, Guidance and Counseling Services, and
# Scholarship and Financial Assistance were added 2026-08-24 after
# cross-checking the taxonomy against cqa_db.sql's actual `services` table —
# these are real, distinct CSPC offices (Health Services Unit; Guidance and
# Counseling; scholarship processing under Student Affairs and Services /
# Cash Unit) that previously had no topic anchor at all and would silently
# fall into General Feedback.
#
# "General Feedback" is deliberately NOT a zero-shot candidate (see
# classify_topic in heavy_model.py) — it's a low-confidence fallback only, so
# a comment is never routed there just because it edged out the other
# hypotheses.
# ---------------------------------------------------------------------------
candidate_topics = [
    "Queueing and Waiting Time",
    "Transaction",
    "Process Efficiency",
    "Ease of Use",
    "Online System and Portal",
    "Internet Connection",
    "Aircon and Cooling",
    "Restroom",
    "Cleanliness",
    "Seating and Furniture",
    "Power and Lighting",
    "Facilities and Equipment",
    "Courtesy and Attitude",
    "Staff Competence and Knowledge",
    "Fairness and Equal Treatment",
    "Bystanders and Loitering",
    "Payment and Fees",
    "Document and Credential Processing",
    "Enrollment and Registration",
    "Communication and Information",
    "Health and Medical Services",
    "Guidance and Counseling Services",
    "Scholarship and Financial Assistance",
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
        "pila", "linya", "queue", "queueing", "waiting line", "numero",
        # Bare "hintay"/"antay" only ever appear in real feedback with a verb
        # affix glued directly onto the root (nag-, -in-, pina-...-an, etc.),
        # so \bhintay\b never actually matches "naghintay"/"hinihintay" — the
        # word boundary sits at the affix, not the root. Listing the common
        # inflected forms explicitly is cheaper and safer than a generic
        # affix-stripping regex (which risks false-positive stems on
        # unrelated words).
        "hintay", "naghintay", "naghihintay", "hinihintay", "hinintay",
        "pinaghihintayan", "maghintay",
        "antay", "umaantay", "inaantay", "antayin",
        "priority number", "numbering system",
    ],
    "Internet Connection": [
        "internet", "wifi", "wi-fi", "signal", "network", "koneksyon",
        "walang signal", "walang internet",
    ],
    "Online System and Portal": [
        "portal", "website", "web site", "sias", "online system",
        "log-in", "login", "log in", "e-services", "e-portal", "online account",
        # Weighted below default: "online form" alone is a softer/shared
        # anchor with Ease of Use's confusion descriptors (a comment naming
        # both, e.g. "nalilito ako sa online form", is really about the form
        # being confusing, not the portal itself) — see Ease of Use below.
        ("online form", 0.75),
        # 2026-08-30: unambiguous digital-system-failure vocabulary, distinct
        # from the physical-facility "sira"/broken anchors elsewhere — these
        # only ever describe software/system behavior, never a physical
        # object, so safe as standalone anchors here.
        "glitch", "glitchy", "buggy", "crashed", "crashing", "nag-crash",
        "nag-hang", "hanging", "nag-error", "system error",
    ],
    # "mainit"/"init" (hot/heat) and "malamig"/"lamig" (cold) added — a
    # room-temperature complaint doesn't always name the aircon itself
    # ("mainit sa office" never mentions "aircon" at all), so the bare
    # temperature descriptor needs to anchor this topic on its own, not only
    # the equipment noun. "napaka-"/"sobrang"/"masyadong" prefixed forms are
    # listed explicitly (same convention as the rest of this file, e.g.
    # "hindi marunong"/"hindi madunong" above) since _kw_pattern's word
    # boundaries don't match a concatenated intensifier prefix.
    "Aircon and Cooling": [
        "aircon", "air-con", "air condition", "aircondition", "air conditioning",
        "electric fan", "bentilador", "pabentilador",
        "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
        "masyadong mainit", "too hot", "very hot", "hot room", "hot office",
        "stuffy", "kulob", "maalinsangan",
        "malamig", "sobrang lamig", "napakalamig", "too cold", "very cold",
        "walang aircon", "walang air con", "sira ang aircon", "sirang aircon",
        "mahina ang aircon", "mahina aircon", "walang ventilation",
        "poor ventilation", "kulang ventilation", "walang bentilasyon",
    ],
    # Restroom-specific words only — split from the old combined "Restroom
    # and Cleanliness" topic on 2026-08-31 (see candidate_topics comment
    # above) so a general "malinis"/"marumi" comment with no restroom word
    # doesn't get tagged with a label that says "Restroom".
    "Restroom": [
        "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        # Found missing during 2026-08-29 testing: a supplies complaint
        # ("walang tissue/sabon") is common enough on its own (without the
        # comment also naming "banyo"/"CR") to deserve its own anchor,
        # rather than only being reachable when paired with a restroom word.
        "tissue", "sabon",
    ],
    # General tidiness/dirtiness — no restroom word required. "makalat"
    # (messy/cluttered) and "magulo" (disorganized/messy) added 2026-08-31
    # after a real comment ("makalat ang office nila") had no anchor at all
    # in either the old combined topic or this one.
    #
    # Weighted 1.5 (the bare location nouns in Restroom/Office-type topics
    # stay at the default 1): a comment like "napakabaho ng CR" previously
    # tied 1-1 against "Restroom" (bare "cr") and lost the tie-break purely
    # because "Restroom" is listed earlier in this dict — even though the
    # ACTUAL complaint (baho = smell) is a cleanliness issue, "cr" is just
    # the location. Per the taxonomy: the issue word must outrank a bare
    # location noun, so a real cleanliness descriptor now always wins that
    # tie instead of losing it by dict-order accident.
    #
    # Deliberately HYGIENE-ONLY (dirt/dust/smell/sanitation) — appearance
    # words ("pangit", "kaaya-aya", "unpresentable", ...) were removed from
    # here 2026-09 and moved to Facilities and Equipment's own Appearance/
    # Presentation item instead. "Di kaaya-ayang tignan ang office" is not
    # evidence of anything being unclean; conflating the two meant an
    # appearance-only complaint with no dirt/smell/mess word at all was
    # still being tagged Cleanliness, which overstates what the respondent
    # actually said. A comment naming BOTH ("pangit at madumi") still
    # correctly resolves to Cleanliness on its own merits — "madumi" alone
    # already outweighs "office" the same way it always has.
    "Cleanliness": [
        ("kalinisan", 1.5), ("cleanliness", 1.5), ("malinis", 1.5),
        ("marumi", 1.5), ("rumi", 1.5), ("dumi", 1.5), ("madumi", 1.5),
        ("makalat", 1.5), ("kalat", 1.5), ("magulo", 1.5),
        ("dirty", 1.5), ("unclean", 1.5), ("not clean", 1.5),
        ("maalikabok", 1.5), ("alikabok", 1.5), ("dusty", 1.5),
        # Intensifier prefix is listed both concatenated ("napakabaho") and
        # spaced ("napaka baho") — real typing varies, and _kw_pattern's
        # word-boundary matching treats these as two genuinely different
        # strings (no boundary exists inside "napakabaho" for a bare "baho"
        # to match through).
        ("mabaho", 1.5), ("ambaho", 1.5), ("napakabaho", 1.5),
        ("napaka baho", 1.5), ("sobrang baho", 1.5), ("ang baho", 1.5),
        ("masyadong mabaho", 1.5), ("masangsang", 1.5), ("mabahong amoy", 1.5),
        ("amoy mabaho", 1.5), ("smelly", 1.5), ("stinky", 1.5),
        ("foul smell", 1.5), ("bad smell", 1.5), ("unsanitary", 1.5),
        ("poor sanitation", 1.5), ("filthy", 1.5), ("messy", 1.5),
        ("napakalinis", 1.5), ("napaka linis", 1.5), ("sobrang linis", 1.5),
        ("maayos at malinis", 1.5), ("well cleaned", 1.5), ("sanitary", 1.5),
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
        "may kilala",
    ],
    # Unambiguous compound phrases naming a knowledge/competence gap, as
    # opposed to bare attitude/manners complaints — also listed before the
    # generic staff bucket.
    "Staff Competence and Knowledge": [
        # "madunong" is the dialectal/Bicol-influenced d-for-r rendering of
        # "marunong" (same intervocalic d~r alternation as dumi/marumi ->
        # madumi below) — CSPC is in the Bicol region, so this spelling shows
        # up in real feedback alongside the standard form.
        "hindi marunong", "hindi madunong", "walang alam", "not knowledgeable", "incompetent",
        # "hindi alam ng [role]" (third-person: THAT PERSON doesn't know) is a
        # distinct grammatical pattern from "hindi ko alam" (first-person: I
        # don't know, self-reflective, unrelated to staff at all — already
        # used unambiguously elsewhere, e.g. General Feedback comments) —
        # found missing during 2026-08-29 fresh-comment testing, where "Hindi
        # alam ng clerk yung sagot" fell through to the generic Staff
        # Courtesy bucket (via the weighted "clerk" role-noun) instead.
        "hindi alam ng",
        "hindi sanay", "untrained", "kulang sa training", "hindi sigurado sa sagot",
        "hindi updated", "hindi na updated", "hindi pa updated", "outdated",
        # Bare "sanay" (accustomed/skilled at a job) is a real positive
        # competence signal on its own ("sanay naman sila sa trabaho nila")
        # but is more ambiguous than the object nouns elsewhere in this file
        # (could describe being used to something unrelated to a job) — kept
        # at reduced weight so it never outranks a more specific competing
        # topic, only wins when nothing else does.
        ("sanay", 0.5),
    ],
    # Generic demeanor/attitude bucket: role nouns with no more specific
    # competence/fairness phrase present. Listed after those two so a
    # comment naming both (e.g. "yung guard, walang palakasan") resolves to
    # the more specific bucket instead.
    #
    # Renamed from "Staff Courtesy and Attitude" on 2026-08-31 — a comment
    # about STUDENTS being rude ("masungit ang mga estudyante") was landing
    # on a topic label that literally says "Staff", which read as wrong to
    # admins even though the plain attitude words below (masungit, bastos,
    # ...) are unambiguous regardless of who the subject is. WHO the comment
    # is about is captured at the item level instead (see
    # TOPIC_ITEM_KEYWORDS["Courtesy and Attitude"]) so the top-level topic
    # itself no longer assumes "staff".
    #
    # Deliberately does NOT include "estudyante"/"student" as a role noun
    # here (unlike "staff"/"kawani"/... below) — student/mag-aaral is FAR
    # more likely than the staff-role nouns to appear in a comment that has
    # nothing to do with anyone's demeanor at all (e.g. "dami ng estudyante"
    # about crowding, or an enrollment-count remark), so it would wrongly
    # win this topic on its own. It's only used for item-level refinement
    # once an unambiguous attitude word below has already resolved the
    # topic, not as a topic-resolving signal by itself.
    #
    # Role nouns (staff/kawani/empleyado/...) are near-synonyms for "this
    # names a specific person/group" rather than independent signals, so
    # they're weighted 0.5 each — otherwise a comment naming two synonyms
    # for the same person (e.g. "yung staff... parang bagong empleyado")
    # could outscore a single specific phrase in another bucket (e.g. Staff
    # Competence's "hindi sigurado sa sagot") purely by synonym-stacking.
    # "bastos" is a real, unambiguous courtesy signal on its own, so it
    # keeps the default weight of 1.
    "Courtesy and Attitude": [
        # "staffs" (common plural typo) added alongside "staff" — the bare
        # word boundary regex \bstaff\b never matched "staffs" (the boundary
        # after "staff" sits between two word characters, "f" and "s", not
        # an actual boundary), so real feedback that pluralized it this way
        # (very common in Taglish) scored zero role-noun signal before this.
        ("staff", 0.5), ("staffs", 0.5), ("kawani", 0.5), ("empleyado", 0.5),
        ("tauhan", 0.5), ("employee", 0.5), ("receptionist", 0.5),
        ("guard", 0.5), ("security", 0.5), ("clerk", 0.5), ("faculty", 0.5),
        ("professor", 0.5), ("guro", 0.5), ("adviser", 0.5),
        ("ma'am", 0.5), ("sir", 0.5),
        "bastos", "hindi magalang", "suplado", "suplada", "masungit",
        # Generic attitude/demeanor descriptors — added so a comment
        # praising or criticizing "sila" (unspecified people) without naming
        # a role or a specific complaint phrase still anchors this topic.
        # Previously these words existed only in the SENTIMENT lexicon
        # (FAST_POSITIVE_WORDS/FAST_NEGATIVE_WORDS), so e.g. "Mababait sila"
        # scored zero topic signal at all and fell through to General
        # Feedback despite being an unambiguous courtesy judgment. Bare
        # "friendly" is safe to include here because the one collision risk
        # ("user-friendly", an Ease of Use keyword) is handled by weighting
        # that keyword up below instead of leaving this one out.
        "mabait", "mababait", "magalang", "magagalang", "courteous",
        "respectful", "approachable", "friendly",
        "masungit", "masusungit", "rude", "disrespectful", "unfriendly",
        # Accommodation/assistance — previously entirely missing from this
        # topic (and from every other topic): "hindi maayos yung pag
        # accommodate ng staffs" had no topic anchor at all before this
        # ("accommodate" matched nothing, and "staffs" didn't match "staff"
        # — see above), so it fell all the way through to General Feedback
        # despite being a clear staff-service complaint. Weighted like
        # "bastos" (1, not 0.5) since these are specific enough complaints
        # on their own, unlike the bare role nouns above.
        "accommodate", "accommodating", "accommodation",
        "inasikaso", "inaasikaso", "aasikasuhin", "asikaso",
        "pinansin", "pinapansin", "entertained",
        "walang assistance", "walang tumutulong", "poor assistance",
        "poor service", "bad attitude", "unhelpful", "not helpful",
    ],
    # Idle outsiders/non-clients hanging around the area — a people/noise
    # complaint, not a facility or staff complaint. Added 2026-08-31 after a
    # real comment ("sobrang ingay ng mga standby dun") had no anchor
    # anywhere and fell through to "General Feedback", and a related comment
    # ("madaming nakatambay sa building nila") was misread by the AI
    # fallback as a "Facilities and Equipment - Building/Structure" issue
    # purely because "building" appeared nearby. "standby" here is the local
    # slang sense (== "tambay"/loiterer), not the English "on standby"
    # sense — safe in this survey-comment context.
    "Bystanders and Loitering": [
        "tambay", "nakatambay", "istambay", "mga tambay", "standby",
        "mga standby", "loitering", "loiterers",
        # "-um-" infix conjugations of "tambay" (to loiter) — same affixed-root
        # gap as "hintay"/"naghintay" above: the word boundary sits at the
        # infix, not the root, so bare \btambay\b never matches these on its
        # own. Covers present ("tumatambay"), the casual/contracted form some
        # users type for it ("tumambay"), future ("tatambay"), and the mag-
        # affix variant some users use instead ("nagtatambay"/"nagtambay").
        "tumatambay", "tumambay", "tatambay", "nagtatambay", "nagtambay",
    ],
    "Payment and Fees": [
        # Same affixed-root gap as "hintay" above — "nagbayad"/"magbabayad"
        # etc. never matched bare \bbayad\b.
        "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
        "fee", "fees", "singil", "kabayaran", "resibo",
        "official receipt", "sobrang mahal ang bayad", "tuition", "tuition fee",
        # 2026-08-30 cross-check against cqa_db.sql's `services` table —
        # "Requesting for Reimbursement/Liquidation of Petty Cash Expenses"
        # (Cash Unit) and "Requesting Statement of Student Accounts
        # Balances" (Accounting Unit) were real services with zero coverage.
        "petty cash", "reimbursement", "liquidation", "statement of account",
        "account balance",
    ],
    "Document and Credential Processing": [
        "transcript", "tor", "diploma", "certification", "certificate",
        "credentials", "cav", "transcript of records", "honorable dismissal",
        "diploma ko", "good moral", "form 137", "form 138",
        "certificate of grades", "identification card", "id card", "school id",
        "grade change", "correction of grades", "change of grade",
        # Found missing 2026-08-29 cross-checking cqa_db.sql's `services`
        # table against the taxonomy — "Requesting for Clearance" (Accounting
        # Unit) is a real, distinct CSPC service with zero coverage before
        # this, and clearance is a very commonly complained-about process at
        # Philippine schools (needed before enrollment/graduation/release of
        # records).
        "clearance",
        # 2026-08-30 second cross-check against cqa_db.sql's `services` table —
        # HR-office document requests (Leave of Absence, Certificate of
        # Employment, Service Record) had zero coverage; these are real,
        # distinct document/credential requests even though the requester is
        # an employee rather than a student.
        "leave of absence", "certificate of employment", "service record",
    ],
    "Enrollment and Registration": [
        "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
        "magpapatala", "ipatala", "registration", "rehistrasyon",
        "matriculation", "cross-enrollment", "re-admission", "shifting",
        "mag-shift", "nag-shift",
        # Found missing 2026-08-29 alongside "clearance" above — "Applying
        # for Graduation" (Registrar) had zero coverage. Deliberately only
        # the unambiguous English terms — "pagtapos"/"pagtatapos" (to
        # finish/end) is far too generic in Tagalog (finishing a line,
        # finishing a process, etc.) to use safely as an anchor here.
        "graduation", "commencement", "graduating",
        # 2026-08-30 cross-check: "Applying for College/Graduate Entrance
        # Examination" (Student Testing and Admission) and "Adding/Dropping
        # of Subjects" (Registrar) were both real services with zero
        # coverage. "exam"/"pagsusulit" alone are too generic (could mean any
        # academic exam unrelated to admission), so anchored as the specific
        # compound phrases actually used for this service.
        "entrance exam", "entrance examination", "college entrance exam",
        "add/drop", "adding of subjects", "dropping of subjects",
        "drop subject", "dropping subject",
    ],
    "Communication and Information": [
        "impormasyon", "information", "communication", "announcement", "abiso",
        "notice", "paalala", "text blast", "walang paalam", "walang reply",
        "hindi sumasagot", "no response", "not informed", "nobody informed",
        "no update", "walang update", "no updates", "walang updates", "email",
        # Found missing during 2026-08-29 testing: comments about getting a
        # different answer from every person asked kept getting misread as
        # Staff Competence or Process Efficiency — this is really about
        # information consistency, not any one staff member's skill or the
        # number of steps involved, so it gets its own unambiguous anchor.
        "iba-iba sagot", "iba't ibang sagot", "magkaibang sagot",
        "kanya-kanyang sagot", "conflicting information",
        "contradicting information", "inconsistent information",
        "nagkontra-kontra",
    ],
    # "transaction" is the unambiguous object-noun anchor for any comment
    # about the transaction itself (as opposed to "Queueing" — waiting for
    # your turn — or "Process Efficiency" — how simple the steps were).
    # Renamed from "Transaction Speed" (2026-09): the old name baked in an
    # assumption this topic was always about speed, which is exactly the bug
    # that caused a plain "Hindi maayos yung transaction" (no speed/duration
    # word anywhere) to get labeled a duration complaint. This topic anchor
    # only ever decides that the comment is ABOUT the transaction — whether
    # it's specifically about speed is now decided by _transaction_subtopic
    # (see item_label_override) using explicit slow/fast evidence words, not
    # by the mere presence of "transaction".
    "Transaction": [
        "transaction", "pag-transact", "processing time", "release ng resulta",
        "ma-release", "na-release",
        # Bare "processing" (not just the "processing time" phrase) — e.g.
        # "sobrang bagal ng processing" names no other object noun at all.
        # Weighted below default like "proseso"/"process" in Process
        # Efficiency below (same reasoning: on its own it's a soft signal,
        # easily outranked by a more specific competing topic).
        ("processing", 0.75),
    ],
    # Compound Taglish/English phrases that unambiguously describe the
    # process itself being simple/tedious, not any specific object.
    "Process Efficiency": [
        "hassle-free", "hassle free", "walang abala", "walang hassle",
        "streamlined", "isang beses lang", "isang hakbang lang", "one-stop",
        # "madaming" is the dialectal d-for-r rendering of "maraming" (see
        # the Staff Competence "madunong" note above for the same alternation).
        "maraming hakbang", "madaming hakbang", "kumplikado",
        # Low-weight generic fallback: "the process" alone is too vague to
        # win against a topic with a real specific anchor (e.g. "proseso ng
        # enrollment" still resolves to Enrollment), but it's better than no
        # signal at all for a bare "ang bagal ng proseso" complaint that
        # names no other specific object.
        ("proseso", 0.5), ("process", 0.5),
    ],
    "Ease of Use": [
        # Weighted above the default 1 (2026-09, alongside adding bare
        # "friendly" as a Courtesy and Attitude anchor below) so a genuine
        # "user-friendly" mention still wins outright — otherwise "friendly"
        # matching inside "user-friendly" (there IS a word boundary at the
        # hyphen) would tie Ease of Use against Courtesy and Attitude on a
        # comment that says nothing else, and Courtesy would win the tie
        # purely by being declared earlier in this dict.
        ("user-friendly", 1.5), ("user friendly", 1.5),
        "madaling gamitin",
        "mahirap gamitin", "nakakalito", "nalilito", "confusing na sundin",
    ],
    # Broad physical-facility fallback — only object nouns that don't already
    # belong to one of the more specific facility subtypes above. Also
    # covers library, dormitory, and transportation via item-level
    # refinement (TOPIC_ITEM_KEYWORDS) — see candidate_topics comment.
    "Facilities and Equipment": [
        "pasilidad", "kagamitan", "equipment", "facilities", "aparatus",
        "makina", "istruktura", "parking", "paradahan",
        "library", "aklatan", "librong hiniram", "libro", "book", "books",
        "dormitory", "dorm", "bed space", "boarding house",
        "transportation", "sasakyan", "service vehicle", "shuttle",
        "printer", "computer lab", "computer laboratory", "computer shop",
        # Appearance/presentation — moved here from "Cleanliness" 2026-09 (see
        # that topic's comment). These describe how a place LOOKS, which is a
        # judgment about upkeep/presentation, not a claim of dirt or odor —
        # "pangit tignan ang office" carries no hygiene evidence at all, so it
        # belongs under this broader physical-facility topic instead. Weighted
        # 1.5 to match Cleanliness's own issue-word weighting, so an
        # appearance complaint reliably outranks a bare location noun the
        # same way a real cleanliness complaint already does.
        ("pangit", 1.5), ("pangit tignan", 1.5), ("pangit tingnan", 1.5),
        ("di magandang tignan", 1.5), ("hindi magandang tignan", 1.5),
        ("di magandang tingnan", 1.5), ("hindi magandang tingnan", 1.5),
        ("di kaaya aya", 1.5), ("hindi kaaya aya", 1.5), ("kaaya aya", 1.5),
        ("kaaya-aya", 1.5), ("di kaayang aya", 1.5), ("hindi kaayang aya", 1.5),
        ("kaayang aya", 1.5),
        ("di kaayang ayang", 1.5), ("hindi kaayang ayang", 1.5),
        ("kaayang ayang", 1.5),
        # "kaaya ayang"/"kaaya-ayang" (linker "-ng" attached before "tignan",
        # e.g. "kaaya-ayang tignan") is yet another real spelling, distinct
        # from "kaayang ayang"/"kaayang aya" above — Filipino attaches the
        # linker to whichever syllable precedes the following word, so both
        # renderings occur in real feedback.
        ("di kaaya ayang", 1.5), ("hindi kaaya ayang", 1.5),
        ("kaaya ayang", 1.5),
        ("di kaaya-ayang", 1.5), ("hindi kaaya-ayang", 1.5),
        ("kaaya-ayang", 1.5),
        ("hindi presentable", 1.5), ("di presentable", 1.5),
        ("unpresentable", 1.5), ("unattractive", 1.5),
        ("unpleasant looking", 1.5), ("poor appearance", 1.5),
        ("poorly maintained", 1.5),
        # Positive appearance — kept distinct from Cleanliness's own positive
        # vocabulary ("malinis", "napakalinis", ...), same split as negative.
        # Deliberately NOT bare "maganda"/"presentable" as topic anchors: both
        # are too generic on their own (regression-tested — "maganda naman
        # siguro pero wala akong masabi, ordinaryo lang" is filler/no-topic
        # text, not a facility-appearance comment, and got mis-tagged when
        # bare "maganda" was tried here). Same "ambiguous bare descriptor"
        # problem this file already avoids elsewhere (see FAST_POSITIVE_WORDS'
        # note on "asikaso"). Only compound/phrase forms, which are specific
        # enough to reliably mean facility appearance, are used as anchors.
        ("maayos tignan", 1.5), ("maayos tingnan", 1.5),
        ("pleasant looking", 1.5), ("well maintained", 1.5),
    ],
    "Health and Medical Services": [
        "clinic", "klinika", "doktor", "doctor", "dentista", "dentist",
        "dental", "medical certificate", "gamot", "nurse", "nars",
        "konsultasyon", "check-up", "checkup", "medical consultation",
    ],
    "Guidance and Counseling Services": [
        "guidance office", "guidance councilor", "guidance counselor",
        "counseling", "counselor", "guidance", "pagpapayo",
    ],
    "Scholarship and Financial Assistance": [
        "scholarship", "iskolarship", "iskolar", "scholar",
        "financial assistance", "grants-in-aid", "scholarship grant",
    ],
}

# ---------------------------------------------------------------------------
# ITEM-LEVEL REFINEMENT (topic -> "{Topic} - {Specific Item}")
# One more level of specificity than TOPIC_KEYWORDS, applied only AFTER a
# topic has already been resolved by keyword_topic_override. Not every topic
# has a meaningful item breakdown (e.g. "Queueing and Waiting Time" doesn't
# name a physical thing), so only the topics below ever get a " - Item"
# suffix — everything else stays at the plain topic label. This keeps the
# taxonomy "only the applicable topic" specific, per admin's request, instead
# of forcing an item guess onto every comment.
#
# Each entry is an ORDERED list of (item_label, keywords) — order matters for
# the tie-break in item_label_override, same convention as TOPIC_KEYWORDS:
# on an equal keyword-hit count, the first-listed item wins, so the more
# specific/common item for that topic should be listed first.
#
# item_label already includes the full "{Topic} - {Item}" text so badge/color
# matching in server.js (which does substring .includes() checks like
# "aircon" or "facility") keeps working unchanged — the parent topic's own
# keyword is still present as a substring of the combined label.
# ---------------------------------------------------------------------------
TOPIC_ITEM_KEYWORDS = {
    "Queueing and Waiting Time": [
        ("Queueing and Waiting Time - Numbering System", [
            "numero", "priority number", "numbering system",
        ]),
        ("Queueing and Waiting Time - Long Lines", [
            "pila", "linya", "queue", "queueing", "waiting line",
            "hintay", "naghintay", "naghihintay", "hinihintay", "hinintay",
            "pinaghihintayan", "maghintay",
            "antay", "umaantay", "inaantay", "antayin",
        ]),
    ],
    # "Transaction" deliberately has NO entry here — its subtopic
    # (General/Slow/Fast) is decided by the evidence-gated _transaction_subtopic
    # function instead of generic keyword-count matching (see
    # item_label_override's special case for this topic, and the module
    # comment above _transaction_subtopic).
    "Process Efficiency": [
        ("Process Efficiency - Complexity/Red Tape", [
            "maraming hakbang", "madaming hakbang", "kumplikado",
        ]),
        ("Process Efficiency - Simplicity", [
            "hassle-free", "hassle free", "walang abala", "walang hassle",
            "streamlined", "isang beses lang", "isang hakbang lang", "one-stop",
        ]),
    ],
    "Ease of Use": [
        ("Ease of Use - Confusing Design", [
            "mahirap gamitin", "nakakalito", "nalilito", "confusing na sundin",
        ]),
        ("Ease of Use - User-Friendly Design", [
            "user-friendly", "user friendly", "madaling gamitin",
        ]),
    ],
    "Aircon and Cooling": [
        # Equipment-noun items listed FIRST: when a comment names the actual
        # broken/missing unit (e.g. "sira ang aircon, sobrang init"), that's
        # the more specific, actionable complaint — the temperature is a
        # symptom of it, not a separate issue. A comment naming ONLY a
        # temperature word (no aircon/fan mentioned at all, e.g. "mainit sa
        # office") still resolves correctly to Temperature/Ventilation below
        # since it's the only item with any match at all.
        ("Aircon and Cooling - Electric Fan", ["electric fan", "bentilador", "pabentilador"]),
        ("Aircon and Cooling - Air Conditioning Unit", [
            "aircon", "air-con", "air condition", "aircondition", "air conditioning",
            "walang aircon", "walang air con", "sira ang aircon", "sirang aircon",
            "mahina ang aircon", "mahina aircon",
        ]),
        ("Aircon and Cooling - Temperature/Ventilation", [
            "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
            "masyadong mainit", "too hot", "very hot", "hot room", "hot office",
            "stuffy", "kulob", "maalinsangan", "malamig", "sobrang lamig",
            "napakalamig", "too cold", "very cold", "walang ventilation",
            "poor ventilation", "kulang ventilation", "walang bentilasyon",
        ]),
    ],
    "Restroom": [
        ("Restroom - Supplies (Soap/Tissue)", [
            "tissue", "sabon",
        ]),
        ("Restroom - Restroom/CR", [
            "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        ]),
    ],
    # Cleanliness itself previously had NO item breakdown at all — every
    # cleanliness comment landed at the bare "Cleanliness" label with no
    # location. LOCATION is the item here (the issue is always "cleanliness"
    # — that's the topic already); "Restroom/CR" is listed first since it's
    # the single most common cleanliness complaint location, reusing the
    # exact same CR/banyo keywords as the Restroom topic above rather than a
    # separate list, so the two stay in sync automatically. "Office" is the
    # fallback default (last, per this file's tie-break convention: first
    # listed wins a tie, so more specific locations must come before it) —
    # matches the existing default used elsewhere in this codebase (e.g.
    # `client_type` defaulting to 'Citizen') when no more specific location
    # is actually named.
    "Cleanliness": [
        ("Cleanliness - Restroom/CR", [
            "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        ]),
        ("Cleanliness - Classroom", ["classroom", "class room", "silid aralan"]),
        ("Cleanliness - Laboratory", [
            "laboratory", "lab", "computer laboratory", "computer lab",
        ]),
        ("Cleanliness - Library", ["library", "aklatan", "lib"]),
        ("Cleanliness - Canteen", ["canteen", "cafeteria"]),
        ("Cleanliness - Clinic", ["clinic", "klinika"]),
        ("Cleanliness - Waiting Area", ["waiting area", "waiting room"]),
        ("Cleanliness - Hallway/Corridor", ["hallway", "corridor", "pasilyo"]),
        ("Cleanliness - Lobby", ["lobby"]),
        ("Cleanliness - Grounds", [
            "grounds", "campus", "surroundings", "paligid", "labas",
        ]),
        ("Cleanliness - Office", ["office", "opisina", "room"]),
    ],
    "Seating and Furniture": [
        ("Seating and Furniture - Chairs", ["upuan", "silya", "chairs", "seats"]),
        ("Seating and Furniture - Tables", ["mesa"]),
        ("Seating and Furniture - Benches", ["bangko"]),
        ("Seating and Furniture - General Furniture", ["furniture", "muwebles"]),
    ],
    "Power and Lighting": [
        ("Power and Lighting - Power Outage", [
            "kuryente", "brownout", "blackout", "power outage", "walang kuryente",
        ]),
        ("Power and Lighting - Lighting", ["ilaw", "lighting"]),
    ],
    "Facilities and Equipment": [
        ("Facilities and Equipment - Appearance/Presentation", [
            "pangit", "pangit tignan", "pangit tingnan",
            "di magandang tignan", "hindi magandang tignan",
            "di magandang tingnan", "hindi magandang tingnan",
            "di kaaya aya", "hindi kaaya aya", "kaaya aya", "kaaya-aya",
            "di kaayang aya", "hindi kaayang aya", "kaayang aya",
            "di kaayang ayang", "hindi kaayang ayang", "kaayang ayang",
            "di kaaya ayang", "hindi kaaya ayang", "kaaya ayang",
            "di kaaya-ayang", "hindi kaaya-ayang", "kaaya-ayang",
            "hindi presentable", "di presentable", "unpresentable",
            "unattractive", "unpleasant looking", "poor appearance",
            "poorly maintained",
            "maayos tignan", "maayos tingnan", "pleasant looking",
            "well maintained",
        ]),
        ("Facilities and Equipment - Parking", ["parking", "paradahan"]),
        ("Facilities and Equipment - Library", [
            "library", "aklatan", "librong hiniram", "libro", "book", "books",
        ]),
        ("Facilities and Equipment - Dormitory/Housing", [
            "dormitory", "dorm", "bed space", "boarding house",
        ]),
        ("Facilities and Equipment - Transportation", [
            "transportation", "sasakyan", "service vehicle", "shuttle",
        ]),
        ("Facilities and Equipment - Equipment/Machine", [
            "kagamitan", "equipment", "makina", "aparatus", "printer",
            "computer lab", "computer laboratory", "computer shop",
        ]),
        ("Facilities and Equipment - Building/Structure", ["istruktura"]),
    ],
    "Online System and Portal": [
        ("Online System and Portal - Login/Account", [
            "log-in", "login", "log in", "online account",
        ]),
        ("Online System and Portal - Website", ["website", "web site"]),
        ("Online System and Portal - System Errors/Bugs", [
            "glitch", "glitchy", "buggy", "crashed", "crashing", "nag-crash",
            "nag-hang", "hanging", "nag-error", "system error",
        ]),
        ("Online System and Portal - Online System", [
            "portal", "sias", "online form", "online system", "e-services", "e-portal",
        ]),
    ],
    "Internet Connection": [
        ("Internet Connection - Wifi", ["wifi", "wi-fi"]),
        ("Internet Connection - Signal", [
            "signal", "network", "walang signal", "koneksyon", "walang internet",
        ]),
    ],
    "Fairness and Equal Treatment": [
        ("Fairness and Equal Treatment - Favoritism", [
            "palakasan", "walang palakasan", "paboritism", "favoritism", "nepotism",
            "may kilala",
        ]),
        ("Fairness and Equal Treatment - Bias/Unequal Treatment", [
            "bias", "unfair", "hindi patas", "walang katarungan",
        ]),
    ],
    "Staff Competence and Knowledge": [
        ("Staff Competence and Knowledge - Training Gap", [
            "hindi sanay", "untrained", "kulang sa training",
        ]),
        ("Staff Competence and Knowledge - Knowledge/Answer Accuracy", [
            "hindi marunong", "hindi madunong", "walang alam", "not knowledgeable",
            "incompetent", "hindi sigurado sa sagot",
        ]),
    ],
    "Document and Credential Processing": [
        # Compound/specific phrases listed before the generic "Certification"
        # catch-all so e.g. "good moral certificate" (which also contains the
        # bare word "certificate") resolves to the more specific bucket on a
        # tied keyword-hit count, same tie-break convention as TOPIC_KEYWORDS.
        ("Document and Credential Processing - Transcript of Records", [
            "transcript", "tor", "transcript of records",
        ]),
        ("Document and Credential Processing - Diploma", ["diploma", "diploma ko"]),
        ("Document and Credential Processing - Honorable Dismissal", [
            "honorable dismissal",
        ]),
        ("Document and Credential Processing - Good Moral Certificate", [
            "good moral",
        ]),
        ("Document and Credential Processing - Academic Records", [
            "form 137", "form 138", "certificate of grades",
        ]),
        ("Document and Credential Processing - ID Card", [
            "identification card", "id card", "school id",
        ]),
        ("Document and Credential Processing - Grade Change/Correction", [
            "grade change", "correction of grades", "change of grade",
        ]),
        # Listed before the generic "Certification" catch-all below, same
        # tie-break reasoning as "Good Moral Certificate" above — "certificate
        # of employment" also contains the bare word "certificate".
        ("Document and Credential Processing - HR Employee Records", [
            "leave of absence", "certificate of employment", "service record",
        ]),
        ("Document and Credential Processing - Certification", [
            "certification", "certificate", "cav",
        ]),
        ("Document and Credential Processing - Clearance", ["clearance"]),
    ],
    "Enrollment and Registration": [
        ("Enrollment and Registration - Graduation", [
            "graduation", "commencement", "graduating",
        ]),
        ("Enrollment and Registration - Matriculation", ["matriculation"]),
        ("Enrollment and Registration - Cross-Enrollment", ["cross-enrollment"]),
        ("Enrollment and Registration - Re-admission", ["re-admission"]),
        ("Enrollment and Registration - Shifting", ["shifting"]),
        ("Enrollment and Registration - Entrance Examination", [
            "entrance exam", "entrance examination", "college entrance exam",
        ]),
        ("Enrollment and Registration - Adding/Dropping of Subjects", [
            "add/drop", "adding of subjects", "dropping of subjects",
            "drop subject", "dropping subject",
        ]),
        ("Enrollment and Registration - Enrollment/Registration Process", [
            "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
            "magpapatala", "ipatala", "registration", "rehistrasyon",
        ]),
    ],
    "Payment and Fees": [
        ("Payment and Fees - Official Receipt", ["resibo", "official receipt"]),
        ("Payment and Fees - Tuition Fee", ["tuition", "tuition fee"]),
        ("Payment and Fees - Petty Cash Reimbursement/Liquidation", [
            "petty cash", "reimbursement", "liquidation",
        ]),
        ("Payment and Fees - Statement of Account", [
            "statement of account", "account balance",
        ]),
        ("Payment and Fees - Fees", [
            "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
            "fee", "fees", "singil", "kabayaran", "sobrang mahal ang bayad",
        ]),
    ],
    # Ordered most-specific-role first, then the general "who" split
    # (Student vs. Staff/Employee), same tie-break convention as elsewhere
    # in this file — a comment naming e.g. both "guard" and "staff" resolves
    # to the more specific Security Guard item.
    "Courtesy and Attitude": [
        # Listed first — a comment naming both an accommodation phrase AND a
        # bare role noun (e.g. "hindi maayos mag-accommodate yung staff")
        # resolves to the more specific item, same tie-break convention as
        # the rest of this file.
        ("Courtesy and Attitude - Accommodation/Assistance", [
            "accommodate", "accommodating", "accommodation",
            "inasikaso", "inaasikaso", "aasikasuhin", "asikaso",
            "pinansin", "pinapansin", "entertained",
            "walang assistance", "walang tumutulong", "poor assistance",
            "unhelpful", "not helpful",
        ]),
        ("Courtesy and Attitude - Security Guard", ["guard", "security"]),
        ("Courtesy and Attitude - Front Desk/Clerk", ["receptionist", "clerk"]),
        ("Courtesy and Attitude - Faculty/Adviser", [
            "faculty", "professor", "guro", "adviser",
        ]),
        ("Courtesy and Attitude - Student", [
            "estudyante", "mag-aaral", "student", "students",
        ]),
        ("Courtesy and Attitude - Staff/Employee", [
            "staff", "staffs", "kawani", "empleyado", "tauhan", "employee",
        ]),
    ],
    "Communication and Information": [
        ("Communication and Information - Inconsistent/Contradicting Information", [
            "iba-iba sagot", "iba't ibang sagot", "magkaibang sagot",
            "kanya-kanyang sagot", "conflicting information",
            "contradicting information", "inconsistent information",
            "nagkontra-kontra",
        ]),
        ("Communication and Information - Schedule/Policy Changes", [
            "walang paalam",
        ]),
        ("Communication and Information - Response to Inquiries", [
            "walang reply", "hindi sumasagot", "no response",
        ]),
        ("Communication and Information - Announcements", [
            "announcement", "abiso", "notice", "paalala", "text blast",
        ]),
    ],
    # Health, Guidance, and Scholarship previously had no item breakdown at
    # all (added 2026-08-24 with only a top-level topic — see the
    # candidate_topics comment above), so every comment landed at the plain
    # topic label with no further specificity. Health's keyword list already
    # spans clearly distinct services (dental vs. general consult vs.
    # medicine vs. paperwork), so it gets the same kind of breakdown as the
    # other topics above.
    "Health and Medical Services": [
        ("Health and Medical Services - Dental Services", [
            "dentista", "dentist", "dental",
        ]),
        ("Health and Medical Services - Medical Certificate", [
            "medical certificate",
        ]),
        ("Health and Medical Services - Medicine/Supplies", ["gamot"]),
        ("Health and Medical Services - Consultation/Check-up", [
            "clinic", "klinika", "doktor", "doctor", "nurse", "nars",
            "konsultasyon", "check-up", "checkup", "medical consultation",
        ]),
    ],
    "Scholarship and Financial Assistance": [
        ("Scholarship and Financial Assistance - Financial Assistance/Grants-in-Aid", [
            "financial assistance", "grants-in-aid",
        ]),
        ("Scholarship and Financial Assistance - Scholarship Application/Grant", [
            "scholarship", "iskolarship", "iskolar", "scholar", "scholarship grant",
        ]),
    ],
}


# ---------------------------------------------------------------------------
# TRANSACTION SUBTOPIC — evidence-gated, not keyword-count-based like every
# other topic's item breakdown. The old "Transaction Speed" item logic fired
# on the bare word "transaction" alone (its item list literally anchored
# "Transaction Duration" on ["transaction", "pag-transact"] — the SAME words
# that already decided the top-level topic), so any transaction comment with
# no speed/duration language at all ("Hindi maayos yung transaction") still
# got labeled a duration complaint. This function requires actual slow/fast
# vocabulary — reusing the sentiment lexicon's own negation machinery
# (_keyword_spans/_is_negated) so "Hindi mabilis ang transaction" doesn't
# score Fast just because "mabilis" appears.
# ---------------------------------------------------------------------------
TRANSACTION_SLOW_WORDS = [
    "slow", "mabagal", "matagal", "tagal", "bagal", "katagal", "antagal",
    "too long", "took too long", "waiting too long", "delay", "delayed",
    "naantala", "na-delay", "nadelay",
]
TRANSACTION_FAST_WORDS = [
    "fast", "quick", "quickly", "mabilis", "efficient", "efficiently",
    "agad", "instant", "agad natapos", "natapos agad",
]


def _transaction_subtopic(text):
    """
    "Transaction - General" (default — no speed/duration evidence either
    way), "Transaction - Slow", or "Transaction - Fast". Scored per-clause
    with the same negation lookback as lexicon_sentiment, so a negated slow
    word counts as fast evidence and vice versa, instead of a negated
    "mabilis" being ignored (and wrongly reading as neutral-toward-Fast) or
    counted as Fast outright.
    """
    lowered = text.lower()
    slow_count = 0
    fast_count = 0
    for clause in re.split(r'[.,;:!?]+', lowered):
        clause = clause.strip()
        if not clause:
            continue
        for s, _e in _keyword_spans(clause, TRANSACTION_SLOW_WORDS):
            if _is_negated(clause, s):
                fast_count += 1
            else:
                slow_count += 1
        for s, _e in _keyword_spans(clause, TRANSACTION_FAST_WORDS):
            if _is_negated(clause, s):
                slow_count += 1
            else:
                fast_count += 1
    if slow_count > fast_count:
        return "Transaction - Slow"
    if fast_count > slow_count:
        return "Transaction - Fast"
    return "Transaction - General"


def item_label_override(topic, text):
    """
    Best-matching "{topic} - {item}" label for a topic that already resolved
    via keyword_topic_override, or None if that topic has no item breakdown
    or the text doesn't name any specific item within it. Same
    count-then-order tie-break as keyword_topic_override, scoped to the
    winning topic's own item list.

    "Transaction" is special-cased to always resolve via _transaction_subtopic
    instead of the generic keyword-count path above — see that function's
    docstring.
    """
    if topic == "Transaction":
        return _transaction_subtopic(text)
    groups = TOPIC_ITEM_KEYWORDS.get(topic)
    if not groups:
        return None
    lowered = text.lower()
    hits = {}
    for item_label, keywords in groups:
        count = len(_matched_spans(lowered, keywords))
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
    "Transaction",
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
    "Health and Medical Services",
    "Guidance and Counseling Services",
    "Scholarship and Financial Assistance",
]

BROAD_LABELS = {
    "Queueing and Waiting Time": "long queues or waiting in line",
    "Transaction": "the speed of the transaction itself",
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
    # More concrete/distinctive phrasing than a plain "clinic, doctor,
    # dentist" list — testing on 2026-08-24 found that shorter, more generic
    # phrasing here acted as a false attractor in zero-shot, winning with
    # 35-49% confidence on unrelated comments (a rude guard, a nice staff
    # member, favoritism, a queue complaint). This wording measurably fixed
    # that false-attraction in the same test (though zero-shot topic
    # classification for this specific label group remains generally
    # unreliable regardless of wording — most genuine health/medical
    # comments are still resolved via the TOPIC_KEYWORDS lexicon above, not
    # this zero-shot fallback, which is only reached when the lexicon has no
    # hit at all).
    "Health and Medical Services": "seeing a doctor, dentist, or nurse at the campus health clinic for a checkup or treatment",
    "Guidance and Counseling Services": "guidance counseling or the guidance office",
    "Scholarship and Financial Assistance": "a scholarship grant or financial assistance",
}

# broad-topic key -> the specific taxonomy label used when a comment lands
# on that broad bucket but stage 2 doesn't clear its own threshold (or the
# group has no stage 2 at all). Most groups map to themselves 1:1; the two
# grouped buckets (facility / staff) map down to their generic sub-label.
BROAD_TO_SPECIFIC_FALLBACK = {
    "Facilities and Equipment": "Facilities and Equipment",
    "Staff and Service Quality": "Courtesy and Attitude",
}

FACILITY_SUBTOPICS = [
    "Aircon and Cooling",
    "Restroom",
    "Cleanliness",
    "Seating and Furniture",
    "Power and Lighting",
    "Facilities and Equipment",
]

FACILITY_LABELS = {
    "Aircon and Cooling": "the aircon, electric fan, or room temperature",
    "Restroom": "the restroom or comfort room specifically",
    "Cleanliness": "the overall cleanliness or tidiness of the place, not specifically the restroom",
    "Seating and Furniture": "chairs, benches, tables, or other furniture",
    "Power and Lighting": "electricity, brownouts, or lighting",
    "Facilities and Equipment": "some other physical facility, building, or equipment issue",
}

STAFF_SUBTOPICS = [
    "Courtesy and Attitude",
    "Staff Competence and Knowledge",
    "Fairness and Equal Treatment",
]

STAFF_LABELS = {
    "Courtesy and Attitude": "someone (staff, faculty, or a student) being polite, rude, or courteous",
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
    "Health and Medical Services": ["health services", "clinic", "dental"],
    "Guidance and Counseling Services": ["guidance", "counseling"],
    "Scholarship and Financial Assistance": ["scholarship", "cash unit", "student affairs"],
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

    (Tried flipping this — AI first, lexicon as fallback — on 2026-08-24;
    reverted after measuring the regression. See heavy_model.classify_topic's
    docstring for the concrete numbers and the reason a confidence gate
    can't safely make that swap: the model lands similar confidence on both
    correct and incorrect top picks for this data, so no threshold cleanly
    separates them.)
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
#   2. The heavy/live path (heavy_model.classify_sentiment): tried FIRST,
#      before the transformer. Empirically, the multilingual sentiment
#      transformer (tabularisai/multilingual-sentiment-analysis) is
#      miscalibrated on short Tagalog/Taglish text in exactly the way the
#      topic zero-shot model is miscalibrated on Taglish topics (see
#      keyword_topic_override's docstring): plainly positive Tagalog
#      sentences ("mabilis na-release yung resulta ko", "hassle-free talaga")
#      routinely score highest on Neutral, and negated phrases ("walang
#      palakasan dito, pantay-pantay lahat") can score highest on Very
#      Negative because the model reacts to the raw negative-coded word
#      inside the negation instead of the negation itself. A small additive
#      boost can't fix a gap that size, so — same convention as topic
#      keywords — a clear lexicon hit wins outright and the transformer is
#      reserved for text with no keyword coverage (nuanced English, genuinely
#      mixed reviews, sarcasm), which is exactly where it adds real value.
#      (Tried the opposite ordering — AI first, lexicon as a confidence-gated
#      fallback — on 2026-08-24; reverted after measuring the regression from
#      114/117 to 94/117 on the sentiment test suite, for the same root
#      cause as the topic model: the transformer's confidence doesn't
#      reliably separate its right answers from its wrong ones on this data.)
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
    # English/short-descriptor gaps found in 2026-08-26 testing (~150-case
    # multi-office suite) — plainly negative on their own, unlike the bare
    # ambiguous descriptors this file otherwise avoids, so safe as standalone
    # anchors: outages/outdated things, being late, and "dirty"/"confusing"
    # which oddly only had Tagalog coverage (marumi/nalilito) before this.
    "dirty", "confusing", "outdated", "late", "lost", "not working",
    "brownout", "blackout", "power outage",
    # Communication-failure phrasing: these were previously anchored only in
    # TOPIC_KEYWORDS' Communication and Information group (a topic signal),
    # but they are just as clearly a *negative sentiment* signal on their own
    # and were missing from the sentiment lexicon entirely, so a plain
    # "the office never replied" comment fell through to Neutral/the
    # transformer instead of resolving outright like other lexicon hits.
    "walang paalam", "walang reply", "hindi sumasagot", "hindi sinagot",
    "hindi sumagot", "walang sagot", "no response", "no reply",
    "never replied", "not informed", "nobody informed",
    "no update", "walang update", "no updates", "walang updates",
    "wala pang balita", "walang balita",
    "walang wifi", "walang internet", "no wifi", "no internet", "no signal",
    "walang stock", "out of stock", "no stock",
    # Price complaints — deliberately compound/intensified phrases, not the
    # bare word "mahal" (which also means "dear/beloved" in Tagalog and would
    # misfire on unrelated positive text), same collision-avoidance approach
    # as SENTIMENT_COLLISION_PHRASES below.
    "sobrang mahal", "napakamahal", "masyadong mahal", "overpriced",
    "too expensive",
    # Staff-attitude descriptors found missing from both the sentiment and
    # topic lexicons — "bastos" was the only unambiguous negative attitude
    # word covered before this, but these are just as common and just as
    # unambiguous (unlike bare "mabagal"-style descriptors, they only ever
    # describe a person's demeanor).
    "suplado", "suplada", "masungit", "sungit", "mayabang",
    # Found missing during 2026-08-29 fresh-comment testing: "nagla-lag"/
    # "lumalag" (lagging) is a common, unambiguous system-slowness complaint
    # with no other meaning in this context, same category as "sira"/"hindi
    # gumagana" above.
    "nagla-lag", "lumalag", "laggy",
    # 2026-08-30 vocabulary pass — additional common Tagalog/English/Taglish
    # words found NOT covered by either lexicon, distinct from words already
    # present above. Only added words that are unambiguous negative signals
    # on their own (same bar as everything else in this list).
    "nakakabwisit", "nakakagalit", "nakakadismaya", "nakakapagod",
    "walang silbi", "walang kwenta na", "walang malasakit", "pabaya",
    "abusado", "walang modo", "walang disiplina", "naantala", "na-delay",
    "nadelay", "sablay", "epic fail",
    "unprofessional", "unacceptable", "horrible", "pathetic", "useless",
    "waste of time", "inconvenient", "inconvenience", "unresponsive",
    "unreliable", "chaotic", "disorganized", "incomplete", "faulty",
    "malfunctioning", "glitch", "glitchy", "buggy", "crashed", "crashing",
    "nag-crash", "nag-hang", "hanging",
    # "antagal" (informal contraction of "ang tagal") — verified missing:
    # "tagal"/"matagal"/"bagal" above only match their own word boundary, and
    # "antagal" has no word boundary between "an" and "tagal" (concatenated,
    # not two separate words), so it never matched any existing entry.
    "antagal",
    # Temperature complaints — same word as the Aircon and Cooling topic
    # anchor above, but needed here too since sentiment and topic are scored
    # independently; without this, "mainit sa office" resolved the topic
    # correctly but scored no sentiment at all (stayed Neutral).
    "mainit", "ang init", "sobrang init", "napakainit", "napaka init",
    "masyadong mainit", "maalinsangan", "kulob", "too hot", "very hot",
    # Cleanliness/odor complaints — "malinis"/"marumi"/"madumi" already exist
    # via the Cleanliness topic keywords (which double as this file's own
    # sentiment signal there), but smell specifically had zero coverage in
    # either lexicon.
    "mabaho", "ambaho", "napakabaho", "napaka baho", "sobrang baho",
    "ang baho", "masyadong mabaho", "masangsang",
    "mabahong amoy", "amoy mabaho", "smelly", "stinky", "foul smell",
    "bad smell", "unsanitary",
    # Appearance/presentability — "di kaaya-aya"/"hindi kaaya-aya" is caught
    # by the existing negation mechanism against "kaaya-aya" (already a
    # FAST_POSITIVE_WORDS entry below), but a bare negative descriptor with
    # no positive counterpart to negate ("pangit", "unpresentable") had no
    # anchor at all.
    "pangit", "unpresentable", "hindi presentable", "unattractive",
    "poor appearance", "poorly maintained",
    # Staff accommodation/assistance — "hindi accommodating"/"not helpful"
    # already negate correctly via the existing mechanism (see
    # "accommodating"/"helpful" in FAST_POSITIVE_WORDS), but these bare
    # negative phrasings have no positive counterpart to negate against.
    "hindi inaasikaso", "di inaasikaso", "hindi pinapansin", "di pinapansin",
    "walang assistance", "walang tumutulong", "poor assistance", "poor service",
    "bad attitude",
    # Courtesy/attitude morphological variants missing before this fix —
    # "masungit"/"rude" were covered but not their reduplicated-plural form
    # ("masusungit", used when describing a plural "sila") or these common
    # English synonyms.
    "masusungit", "disrespectful", "unfriendly",
]
FAST_POSITIVE_WORDS = [
    "maganda", "magandang", "mabilis", "magaling", "mabait", "salamat",
    "masaya", "masayang", "maayos", "ayos naman", "okay naman", "ok naman",
    "walang problema", "walang reklamo", "pantay", "patas", "madali",
    "kadali", "mahusay", "sanay", "stable", "malinaw", "maalaga", "magiliw",
    # "marunong"/"madunong" are the standard and dialectal (d-for-r, common in
    # this Bicol-region school's feedback) spellings of "knowledgeable" — a
    # bare positive here so "hindi marunong"/"hindi madunong" correctly flip
    # to Negative via the existing negation handling below.
    "marunong", "madunong",
    "propesyonal", "tulong", "tumulong", "tinulungan",
    "walang abala", "walang hassle", "isang beses lang", "isang hakbang lang",
    "one-stop", "one stop", "patient",
    "satisfied", "great", "good", "excellent", "fast", "helpful",
    "friendly", "nice", "pleasant", "malinis", "the best", "love it", "hassle-free",
    "hassle free", "streamlined", "efficient", "smooth", "convenient",
    "fair", "equal", "commend", "professional", "professionally", "professionalism",
    "appreciate", "appreciated",
    # Common attitude/manner descriptors missing before this fix — only
    # "mabait" was covered; "magalang" (polite) is just as common and
    # unambiguous, since (unlike bare "mabagal"-style words) it only ever
    # describes demeanor.
    "magalang", "matulungin", "maasikaso",
    # 2026-08-30 vocabulary pass — same rationale as the FAST_NEGATIVE_WORDS
    # addition above: real words a client would plausibly write that weren't
    # covered yet, unambiguous enough to stand alone as a positive anchor.
    "maagap", "matiyaga", "masipag", "accommodating", "approachable",
    "considerate", "welcoming", "sulit", "astig", "solid", "top-notch",
    "seamless", "responsive", "on-time", "prompt",
    "organized", "spot on", "kaaya-aya", "mapagkalinga",
    # NOTE: "asikaso"/"inaasikaso"/"pinapansin" deliberately do NOT appear
    # here as bare sentiment anchors (tried and reverted — see git history):
    # against the project's existing regression suite (test_accuracy.py)
    # they mis-scored several genuinely nuanced Taglish sentences that use
    # "(na/nag-)asikaso" in ways the surrounding context reverses (e.g.
    # "parang gustong-gusto na akong umalis, halatang ayaw makipag-usap"
    # after "yung nag-asikaso sa akin" is actually a complaint, not praise).
    # Same "ambiguous bare descriptor" problem this file already avoids
    # elsewhere (see the TAGLISH KEYWORD ANCHORS module comment above:
    # "never bare descriptors... since those are ambiguous"). The specific,
    # unambiguous negative PHRASES ("hindi inaasikaso", "di pinapansin", ...)
    # are still covered directly in FAST_NEGATIVE_WORDS above, and
    # "accommodate"/"asikaso"/etc remain safe as TOPIC (not sentiment)
    # keywords — a topic mis-tag is a much smaller consequence than a
    # flipped sentiment polarity, so that risk/reward tradeoff is different.
    #
    # Cleanliness — intensified positive forms ("napakalinis" etc.) needed
    # here too since sentiment and topic are scored independently; without
    # this, "Napakalinis ng laboratory" resolved no sentiment at all.
    "napakalinis", "napaka linis", "sobrang linis", "maayos at malinis",
    "very clean", "well maintained",
    # Appearance — bare positive so "di/hindi kaayang aya(ng)" correctly
    # negates via the existing negation mechanism, same reasoning as
    # inaasikaso/asikaso above. "kaaya-aya" (hyphenated) was already covered.
    "kaayang aya", "kaayang ayang", "kaaya ayang", "kaaya-ayang",
    # Courtesy/attitude morphological variants missing before this fix —
    # "mabait"/"magalang" were covered but not their reduplicated-plural form
    # ("mababait"/"magagalang", used when describing a plural "sila") or
    # these common English synonyms.
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
# so these get a clear, honest "Unclassified - No Meaningful Feedback" tag
# INSTANTLY, without ever spending a Gemini call on content that has no real
# opinion to classify, and without it being counted as genuine (if generic)
# "General Feedback" — that label means "meaningful feedback that doesn't fit
# a more specific topic," not "the classifier didn't understand this."
#
# Originally added 2026-08-29 to catch pure numbers/symbols only (returning
# separate "Numbers"/"Random Letters" labels). Extended 2026-09 after finding
# it missed short gibberish ("XZ", "Hfrrg" — too few letters for the old
# length>=10 floor) and longer keyboard-mash that still happens to contain a
# few vowels ("hahhdahsdhas" — 12 letters, 3 vowels, a 25% ratio that clears
# the old 15% floor despite having no plausible syllable structure), and
# after finding greetings ("Hello po", "Hi") were sailing through entirely
# (real words, real vowels — just not feedback about a service). All three
# sub-cases are now unified under one label, since the admin-facing goal is
# the same for all of them: "there is nothing here to classify."
#
# Order of checks:
#   1. Known-vocabulary guard — if the comment already matches a topic or
#      sentiment keyword, it is real content by definition and must never be
#      flagged as junk on letter-shape alone (e.g. a bare "CR" comment is a
#      genuine, if terse, Restroom-topic keyword — two letters, zero vowels).
#   2. Numbers-only / symbols-only (unchanged from the original version).
#   3. Greeting/courtesy-particle-only ("Hello po", "Hi", "Hi po", "po po").
#   4. Whole-comment vowel-ratio check (original gibberish heuristic, kept as
#      a secondary net for junk spread across multiple short tokens).
#   5. Per-token check: every alphabetic token (len>=2) is "suspicious"
#      (zero vowels, or len>=8 with a consonant run>=4 — no real
#      English/Tagalog/Taglish word looks like that) and there's at least one
#      such token.
# Anything with a real recognizable word anywhere in it returns None and
# falls through to the normal lexicon/Gemini path — this is deliberately
# conservative in the direction of keeping real feedback classified normally
# (see check #1 and the admin's original request that a real comment with a
# typo must never be misread as gibberish).
# ---------------------------------------------------------------------------
UNCLASSIFIED_NO_FEEDBACK = "Unclassified - No Meaningful Feedback"

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
