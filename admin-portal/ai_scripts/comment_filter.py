"""
Checks for blank, nonsense, or no feedback comments before anything gets
sent to Gemini. This runs first for every comment, online or offline.
Not related to shared/commentFilter.js, which does similar checks on the
Node side when a report is generated.

Main functions to use: is_no_feedback(text) and detect_junk_topic(text).
"""
import re

from topic_common import TOPIC_ITEM_KEYWORDS

# Comments like "N/A", "none", or blank ones mean the person had nothing
# to say. These should never get a fake topic or sentiment.
NO_FEEDBACK_PHRASES = {
    "na", "n/a", "none", "nil", "no comment", "no comments", "not applicable",
}


def is_no_feedback(text):
    # True for blank comments or common placeholders like N/A, none, or
    # no comment, in any spacing or capitalization.
    if text is None:
        return True
    trimmed = str(text).strip()
    if trimmed == "":
        return True
    stripped = re.sub(r'[.\-]', '', trimmed.lower())
    stripped = re.sub(r'\s+', ' ', stripped).strip()
    if stripped == "":
        return True
    return stripped in NO_FEEDBACK_PHRASES


def _kw_pattern(kw):
    # Lets a phrase like good morning match even if it's spaced or
    # hyphenated differently.
    escaped = re.escape(kw).replace('\\-', '[- ]?')
    return r'\b' + escaped + r'\b'


# The rest of this file catches junk like numbers only, symbols only,
# keyboard mashing, or a comment that's just a greeting. If a comment
# passes all these checks it gets sent to Gemini like normal.
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
    # Grabs every real word already used in the topic list, so a short
    # real word like cr or id never gets mistaken for gibberish.
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
    # True only if the whole comment is just a greeting, maybe with a
    # word like po or naman attached, and nothing else.
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


# Used to catch keyboard mashing like asdf or qwerty that a vowel check
# alone would miss.
_KEYBOARD_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
_KEYBOARD_RUN_MIN_LEN = 4


def _is_keyboard_run(token, min_len=_KEYBOARD_RUN_MIN_LEN):
    # True if every letter sits in a row on the keyboard, like asdf or
    # qwerty. Real words almost never look like this.
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
    # Finds a short chunk that repeats to make the whole word, like
    # asdasd or aaaaaa. Filipino words like halohalo repeat too, so this
    # alone isn't enough to call something junk.
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
    # Checks one word for signs it isn't a real word at all.
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

    if _is_keyboard_run(lowered):
        return True

    repeated = _repeated_unit(lowered)
    if repeated:
        unit, reps = repeated
        unit_has_vowel = any(c in _VOWELS for c in unit)
        # These thresholds are set so real reduplicated words like mama
        # or dagdag never get flagged just for repeating.
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
    # Returns a junk label if the comment is blank looking, symbols only,
    # a greeting only, or gibberish. Otherwise returns None so it goes
    # on to Gemini as usual.
    stripped = text.strip()
    if not stripped:
        return None

    letters = [c for c in stripped if c.isalpha() and c.isascii()]
    digits = [c for c in stripped if c.isdigit()]

    if digits and not letters:
        residual = re.sub(r'[\d\s\-\(\)\+\.]', '', stripped)
        if not residual:
            return UNCLASSIFIED_NO_FEEDBACK

    if not letters and not digits:
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
