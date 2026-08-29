"""
AI fallback classifier for comments the keyword lexicon can't resolve.
model_server.py keeps this module imported in a long-lived process so the
Gemini client and taxonomy data only get set up once per process.

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
    On any Gemini failure (quota exhausted, network issue, bad API key),
    degrade to the safest neutral defaults instead of raising — a single
    comment failing to classify shouldn't 500 the whole submission. Logged
    to stderr so an outage/quota exhaustion is visible in server logs
    instead of silently mislabeling comments as Neutral/General Feedback.
    """
    try:
        return gemini_model.classify(text, office_hint=office_hint)
    except Exception as e:
        print(f"[heavy_model] Gemini fallback failed, degrading to defaults: {e}", file=sys.stderr, flush=True)
        return "Neutral", GENERAL_FEEDBACK


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
    _, topic = _gemini_classify_safe(text, office_hint=office_hint)
    return topic


def analyze(text, office_hint=None):
    """
    Convenience wrapper: returns (sentiment, topic) for a single comment.
    Makes at most ONE Gemini call (not two) when both axes miss the
    lexicon — classify_sentiment/classify_topic stay independent for
    test_accuracy.py's per-axis scoring, but the real production path
    (model_server.py's /analyze route) goes through this function, and a
    live comment shouldn't cost double the API quota just because it needs
    the fallback on both axes at once.
    """
    junk = detect_junk_topic(text)
    if junk:
        # No Gemini call at all — junk content has no real sentiment or
        # topic to extract, and a keyword hit here would be a coincidence
        # too unlikely to bother checking for.
        return "Neutral", junk

    lex_sent = lexicon_sentiment(text)
    lex_topic = keyword_topic_override(text)
    if lex_sent and lex_topic:
        return lex_sent, lex_topic

    ai_sent, ai_topic = _gemini_classify_safe(text, office_hint=office_hint)
    return lex_sent or ai_sent, lex_topic or ai_topic
