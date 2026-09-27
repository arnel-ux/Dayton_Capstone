"""
AI classifier for survey comments. model_server.py keeps this module
imported in a long-lived process so the Gemini client and taxonomy data
only get set up once per process.

Formerly ran MoritzLaurer/mDeBERTa-v3-base-mnli-xnli (zero-shot topic) and
tabularisai/multilingual-sentiment-analysis locally, then a keyword-lexicon
hybrid (lexicon first, Gemini fallback). Both were fully replaced —
2026-08-29 for the local transformer models, 2026-09-25 for the lexicon
hybrid (see analyze.py's module comment and topic_common.py's cleanup note,
2026-09-27) — with Gemini 3.5 Flash-Lite as the sole classifier for every
comment, online and offline alike. This module now exposes exactly one
classification entry point:
  - analyze_pure_ai: used by model_server.py's /analyze route (online) and
    by analyze.py (offline-synced comments). Only the junk/no-feedback
    pre-check (see topic_common.detect_junk_topic) runs before Gemini —
    no keyword matching of any kind.
"""
import sys

from topic_common import detect_junk_topic, GENERAL_FEEDBACK
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


def analyze_pure_ai(text, office_hint=None):
    """
    The classifier for every comment, online and offline alike (see the
    module docstring). Junk detection (blank/gibberish/greeting-only) still
    runs first and skips Gemini entirely — see detect_junk_topic's docstring
    — but any comment that clears that gate goes straight to Gemini, with no
    keyword matching at all. Returns (sentiment, topics) — topics is always
    a non-empty list (see gemini_model.classify's docstring, multi-topic
    tagging project).
    """
    junk = detect_junk_topic(text)
    if junk:
        return "Neutral", [junk]
    return _gemini_classify_safe(text, office_hint=office_hint)
