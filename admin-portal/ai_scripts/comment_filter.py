"""
Junk/no-feedback detection for survey comments — split out of topic_common.py
on 2026-09-28 into its own module so it's easy to locate on its own, separate
from the AI taxonomy (which stays in topic_common.py, since gemini_model.py
reads it directly to build Gemini's prompt).

NOTE: this is the Python, pre-AI junk detector (blanks, "N/A"-style
placeholders, emoji/symbol-only text, keyboard mash, greeting-only comments)
that runs BEFORE Gemini is ever called, for every comment, online and offline
alike. It is unrelated to admin-portal/shared/commentFilter.js, which is a
separate JS module that re-checks these same kinds of rules (plus profanity
masking) at REPORT-GENERATION time on the Node side, as a defense-in-depth
check independent of whether this Python classifier ever ran on a given row
— see that file's own comment for why both exist.

Public API: is_no_feedback(text), detect_junk_topic(text),
UNCLASSIFIED_NO_FEEDBACK. Everything else here is a private implementation
detail.
"""
import re

from topic_common import TOPIC_ITEM_KEYWORDS

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
# HYPHEN-TOLERANT MATCHING — used by the greeting-phrase check below
# (_is_greeting_or_particle_only), which needs to match a phrase like "good
# morning" regardless of exact spacing/hyphenation.
# ---------------------------------------------------------------------------
def _kw_pattern(kw):
    escaped = re.escape(kw).replace('\\-', '[- ]?')
    return r'\b' + escaped + r'\b'


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
# offline alike — everything that clears this gate goes straight to Gemini
# with no keyword matching at all.
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
    Every single-word (no-space) token used anywhere in topic_common's
    TOPIC_ITEM_KEYWORDS, lowercased. Used as a safety net so a short, real
    keyword (e.g. "cr", "id") is never treated as gibberish purely because it
    happens to have an unusual letter shape.
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
