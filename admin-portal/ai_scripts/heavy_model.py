"""
AI classifier for survey comments. model_server.py keeps this module
imported in a long-lived process so the Gemini client and taxonomy data
only get set up once per process.

Formerly ran MoritzLaurer/mDeBERTa-v3-base-mnli-xnli (zero-shot topic) and
tabularisai/multilingual-sentiment-analysis locally. Both were replaced with
Gemini 3.5 Flash-Lite (see gemini_model.py) on 2026-08-29 after a head-to-head
on this project's accuracy suite: mDeBERTa resolved only 21/80 (26.2%) of the
topic-lexicon-miss cases (it defaulted to "General Feedback" on most of
them — its own confidence never separated right answers from wrong ones on
this data, see keyword_topic_override's docstring for the earlier
confidence-dump finding that predicted exactly this), while Gemini resolved
49/68 (72.1%) on the same slice, plus 94-100% sentiment accuracy across three
separate test runs (the original suite, an edge-case stress test covering
emoji/ALL-CAPS/gibberish/Bikol, and a full-taxonomy sweep). mDeBERTa and
tabularisai are fully removed, not just superseded — no local model weights
are loaded by this module anymore.

2026-09-22: this module exposes TWO classification entry points — originally
per the pure-AI classification project's decision to prioritize Gemini for
live (online) comments while keeping the keyword lexicon as a hybrid
fallback layer for offline-synced comments. That offline-hybrid choice was
itself reversed on 2026-09-25 (see analyze.py's module comment): offline
sync only ever reaches this module once the device is back online, so the
original network/rate-limit conservatism for it doesn't apply, and
consistent accuracy (including multi-topic tagging) was judged more
valuable. In production, both entry points now resolve to the same
pure-Gemini behavior:
  - analyze_pure_ai: used by model_server.py's /analyze route (the ONLINE
    path) AND by analyze.py for offline-synced comments. Skips the keyword
    lexicon's topic/sentiment matching entirely — only the junk/no-feedback
    pre-check still runs before Gemini.
  - analyze (plus classify_sentiment/classify_topic): the keyword-lexicon-
    first hybrid — no longer called by any production path, but kept for
    test_accuracy.py's lexicon-only scoring.
"""
import sys

from topic_common import (
    keyword_topic_override,
    lexicon_sentiment,
    detect_junk_topic,
    GENERAL_FEEDBACK,
)
import gemini_model


def warmup():
    """
    Called once at server startup. Unlike the old local-model version, there
    are no weights to load — this just fails fast if GEMINI_API_KEY is
    missing/misconfigured, instead of only discovering that on the first
    real comment.
    """
    gemini_model._get_client()


def is_ready():
    try:
        gemini_model._get_client()
        return True
    except Exception:
        return False


def _gemini_classify_safe(text, office_hint=None):
    """
    Returns (sentiment, topics) — topics is always a non-empty list (see
    gemini_model.classify's docstring, multi-topic tagging project). On any
    Gemini failure (quota exhausted, network issue, bad API key), degrade to
    the safest neutral defaults instead of raising — a single comment
    failing to classify shouldn't 500 the whole submission. Logged to
    stderr so an outage/quota exhaustion is visible in server logs instead
    of silently mislabeling comments as Neutral/General Feedback.
    """
    try:
        return gemini_model.classify(text, office_hint=office_hint)
    except Exception as e:
        print(f"[heavy_model] Gemini fallback failed, degrading to defaults: {e}", file=sys.stderr, flush=True)
        return "Neutral", [GENERAL_FEEDBACK]


def classify_sentiment(text):
    # Junk content (pure numbers/symbols/emoji/keyboard-mash — see
    # detect_junk_topic's docstring) has no real sentiment to read; default
    # to Neutral without spending a Gemini call on it.
    if detect_junk_topic(text):
        return "Neutral"
    # Keyword lexicon wins outright when it has a signal at all — see
    # topic_common.lexicon_sentiment's docstring. Gemini is the fallback for
    # text with no keyword coverage at all (nuanced English, genuinely mixed
    # reviews, sarcasm), which is exactly where it adds real value.
    lex = lexicon_sentiment(text)
    if lex:
        return lex
    sentiment, _ = _gemini_classify_safe(text)
    return sentiment


def classify_topic(text, office_hint=None):
    """
    office_hint: optional free-text string (e.g. "Accounting Office" or a
    cluster name) describing which office/service the comment's survey was
    submitted for. Passed through to Gemini as soft context only — the
    comment text stays the primary and decisive signal (see gemini_model's
    PROMPT_TEMPLATE), same convention as the old office_hint_topics nudge.
    """
    # Junk content wins outright, same as a keyword hit — see
    # detect_junk_topic's docstring for why this is safe to trust without
    # Gemini's input.
    junk = detect_junk_topic(text)
    if junk:
        return junk
    # Keyword anchors win outright when present (see
    # keyword_topic_override's docstring for why).
    override = keyword_topic_override(text)
    if override:
        return override
    # The lexicon only ever names ONE topic per comment — classify_topic's
    # own contract (test_accuracy.py's per-axis scoring) is a single string,
    # so this takes just the primary/first of Gemini's (possibly multiple)
    # topics. The real production path (analyze()/analyze_pure_ai() below)
    # keeps the full list.
    _, topics = _gemini_classify_safe(text, office_hint=office_hint)
    return topics[0]


def analyze(text, office_hint=None):
    """
    Convenience wrapper: returns (sentiment, topics) for a single comment —
    topics is always a non-empty list (see gemini_model.classify's
    docstring, multi-topic tagging project: most comments still resolve to
    exactly one topic, but a comment naming multiple distinct things gets
    each of them). Makes at most ONE Gemini call (not two) when both axes
    miss the lexicon — classify_sentiment/classify_topic stay independent
    for test_accuracy.py's per-axis scoring, but the real production path
    (model_server.py's /analyze route) goes through this function, and a
    live comment shouldn't cost double the API quota just because it needs
    the fallback on both axes at once.

    The keyword lexicon itself only ever names ONE topic per comment (its
    max-keyword-weight tiebreak has no notion of "also a second topic") —
    when it resolves both axes, that single topic is returned as a
    one-element list rather than calling Gemini at all.
    """
    junk = detect_junk_topic(text)
    if junk:
        # No Gemini call at all — junk content has no real sentiment or
        # topic to extract, and a keyword hit here would be a coincidence
        # too unlikely to bother checking for.
        return "Neutral", [junk]

    lex_sent = lexicon_sentiment(text)
    lex_topic = keyword_topic_override(text)
    if lex_sent and lex_topic:
        return lex_sent, [lex_topic]

    ai_sent, ai_topics = _gemini_classify_safe(text, office_hint=office_hint)
    return lex_sent or ai_sent, [lex_topic] if lex_topic else ai_topics


def analyze_pure_ai(text, office_hint=None):
    """
    ONLINE live-submission path (2026-09-22 decision): Gemini alone is the
    classifier for comments that need a real answer here — admin-side speed
    and consistency for live submissions takes priority over the keyword
    lexicon, which is reserved for the offline hybrid path instead (see
    analyze() above). Junk detection (blank/gibberish/greeting-only) still
    runs first and skips Gemini entirely — see detect_junk_topic's
    docstring — but any comment that clears that gate goes straight to
    Gemini, without ever trying keyword_topic_override/lexicon_sentiment.
    Returns (sentiment, topics) — topics is always a non-empty list (see
    gemini_model.classify's docstring, multi-topic tagging project).
    """
    junk = detect_junk_topic(text)
    if junk:
        return "Neutral", [junk]
    return _gemini_classify_safe(text, office_hint=office_hint)
