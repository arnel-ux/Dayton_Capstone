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
# Likewise "Staff Courtesy and Attitude" doubles as the default bucket for
# staff-related comments that don't clearly single out competence or
# fairness specifically.
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
    ],
    "Aircon and Cooling": [
        "aircon", "air-con", "air condition", "aircondition", "air conditioning",
        "electric fan", "bentilador", "pabentilador",
    ],
    "Restroom and Cleanliness": [
        "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        "kalinisan", "cleanliness", "malinis", "marumi", "dumi", "madumi",
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
    # Generic staff-behavior bucket: role nouns with no more specific
    # competence/fairness phrase present. Listed after those two so a
    # comment naming both (e.g. "yung guard, walang palakasan") resolves to
    # the more specific bucket instead.
    #
    # Role nouns (staff/kawani/empleyado/...) are near-synonyms for "this is
    # about a staff member" rather than independent signals, so they're
    # weighted 0.5 each — otherwise a comment naming two synonyms for the
    # same person (e.g. "yung staff... parang bagong empleyado") could
    # outscore a single specific phrase in another bucket (e.g. Staff
    # Competence's "hindi sigurado sa sagot") purely by synonym-stacking.
    # "bastos" is a real, unambiguous courtesy signal on its own, so it
    # keeps the default weight of 1.
    "Staff Courtesy and Attitude": [
        ("staff", 0.5), ("kawani", 0.5), ("empleyado", 0.5), ("tauhan", 0.5),
        ("employee", 0.5), ("receptionist", 0.5), ("guard", 0.5),
        ("security", 0.5), ("clerk", 0.5), ("faculty", 0.5),
        ("professor", 0.5), ("guro", 0.5), ("adviser", 0.5),
        ("ma'am", 0.5), ("sir", 0.5),
        "bastos", "hindi magalang", "suplado", "suplada", "masungit",
    ],
    "Payment and Fees": [
        # Same affixed-root gap as "hintay" above — "nagbayad"/"magbabayad"
        # etc. never matched bare \bbayad\b.
        "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
        "fee", "fees", "singil", "kabayaran", "resibo",
        "official receipt", "sobrang mahal ang bayad", "tuition", "tuition fee",
    ],
    "Document and Credential Processing": [
        "transcript", "tor", "diploma", "certification", "certificate",
        "credentials", "cav", "transcript of records", "honorable dismissal",
        "diploma ko", "good moral", "form 137", "form 138",
        "certificate of grades", "identification card", "id card", "school id",
        "grade change", "correction of grades", "change of grade",
    ],
    "Enrollment and Registration": [
        "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
        "magpapatala", "ipatala", "registration", "rehistrasyon",
        "matriculation", "cross-enrollment", "re-admission", "shifting",
        "mag-shift", "nag-shift",
    ],
    "Communication and Information": [
        "impormasyon", "information", "communication", "announcement", "abiso",
        "notice", "paalala", "text blast", "walang paalam", "walang reply",
        "hindi sumasagot", "no response", "not informed", "nobody informed",
        "no update", "walang update", "no updates", "walang updates", "email",
    ],
    # "transaction" is the unambiguous object-noun anchor for comments whose
    # core driver is how fast the service itself moved (hal. "bilis ng
    # transaction") — as opposed to "Queueing" (waiting for your turn) or
    # "Process Efficiency" (how simple the steps were).
    "Transaction Speed": [
        "transaction", "pag-transact", "processing time", "release ng resulta",
        "ma-release", "na-release",
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
        "user-friendly", "user friendly", "madaling gamitin",
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
    "Transaction Speed": [
        ("Transaction Speed - Processing Time", [
            "processing time", "release ng resulta", "ma-release", "na-release",
        ]),
        ("Transaction Speed - Transaction Duration", ["transaction", "pag-transact"]),
    ],
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
        ("Aircon and Cooling - Electric Fan", ["electric fan", "bentilador", "pabentilador"]),
        ("Aircon and Cooling - Air Conditioning Unit", [
            "aircon", "air-con", "air condition", "aircondition", "air conditioning",
        ]),
    ],
    "Restroom and Cleanliness": [
        ("Restroom and Cleanliness - Restroom/CR", [
            "banyo", "cr", "comfort room", "palikuran", "restroom", "toilet",
        ]),
        ("Restroom and Cleanliness - General Cleanliness", [
            "kalinisan", "cleanliness", "malinis", "marumi", "dumi", "madumi",
        ]),
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
        ("Document and Credential Processing - Certification", [
            "certification", "certificate", "cav",
        ]),
    ],
    "Enrollment and Registration": [
        ("Enrollment and Registration - Matriculation", ["matriculation"]),
        ("Enrollment and Registration - Cross-Enrollment", ["cross-enrollment"]),
        ("Enrollment and Registration - Re-admission", ["re-admission"]),
        ("Enrollment and Registration - Shifting", ["shifting"]),
        ("Enrollment and Registration - Enrollment/Registration Process", [
            "enrollment", "enrolment", "pagpapatala", "nagpatala", "nagpapatala",
            "magpapatala", "ipatala", "registration", "rehistrasyon",
        ]),
    ],
    "Payment and Fees": [
        ("Payment and Fees - Official Receipt", ["resibo", "official receipt"]),
        ("Payment and Fees - Tuition Fee", ["tuition", "tuition fee"]),
        ("Payment and Fees - Fees", [
            "bayad", "babayaran", "nagbayad", "nagbabayad", "magbayad", "binayaran",
            "fee", "fees", "singil", "kabayaran", "sobrang mahal ang bayad",
        ]),
    ],
    "Staff Courtesy and Attitude": [
        ("Staff Courtesy and Attitude - Security Guard", ["guard", "security"]),
        ("Staff Courtesy and Attitude - Front Desk/Clerk", ["receptionist", "clerk"]),
        ("Staff Courtesy and Attitude - Faculty/Adviser", [
            "faculty", "professor", "guro", "adviser",
        ]),
    ],
    "Communication and Information": [
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


def item_label_override(topic, text):
    """
    Best-matching "{topic} - {item}" label for a topic that already resolved
    via keyword_topic_override, or None if that topic has no item breakdown
    or the text doesn't name any specific item within it. Same
    count-then-order tie-break as keyword_topic_override, scoped to the
    winning topic's own item list.
    """
    groups = TOPIC_ITEM_KEYWORDS.get(topic)
    if not groups:
        return None
    lowered = text.lower()
    hits = {}
    for item_label, keywords in groups:
        count = sum(1 for kw in keywords if re.search(r'\b' + re.escape(kw) + r'\b', lowered))
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
    "Health and Medical Services",
    "Guidance and Counseling Services",
    "Scholarship and Financial Assistance",
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
        count = 0
        for entry in keywords:
            kw, weight = entry if isinstance(entry, tuple) else (entry, 1)
            if re.search(r'\b' + re.escape(kw) + r'\b', lowered):
                count += weight
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
ASPIRATIONAL_WORDS = {"sana"}


def _is_aspirational(clause_lower, span_start):
    words_before = clause_lower[:span_start].split()[-NEGATION_LOOKBACK:]
    return any(w.strip("'") in ASPIRATIONAL_WORDS for w in words_before)


def _keyword_spans(clause_lower, keywords):
    spans = []
    for kw in keywords:
        for m in re.finditer(r'\b' + re.escape(kw) + r'\b', clause_lower):
            spans.append((m.start(), m.end()))
    return spans


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
        lowered = re.sub(r'\b' + re.escape(phrase) + r'\b', ' ', lowered)

    clauses = re.split(r'[.,;:!?]+', lowered)
    pos_count = 0
    neg_count = 0
    neutral_hit = False
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        if any(re.search(r'\b' + re.escape(p) + r'\b', clause) for p in FAST_NEUTRAL_PHRASES):
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
    return lexicon_sentiment(text) or "Neutral"


def fast_topic(text):
    return keyword_topic_override(text) or GENERAL_FEEDBACK
