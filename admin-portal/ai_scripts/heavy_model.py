"""
The AI classifier for survey comments. model_server.py keeps this loaded
in memory so Gemini only needs to be set up once instead of every request.
Everything is classified by Gemini now, both online and offline comments,
with no keyword lexicon involved anymore.
"""
import sys

from topic_common import GENERAL_FEEDBACK
from comment_filter import detect_junk_topic
import gemini_model


def warmup():
    # Fails fast at startup if GEMINI_API_KEY is missing, instead of
    # only finding out on the first real comment.
    gemini_model._get_client()


def is_ready():
    try:
        gemini_model._get_client()
        return True
    except Exception:
        return False


def _gemini_classify_safe(text, office_hint=None):
    # Returns (sentiment, topics). If Gemini fails for any reason, falls
    # back to safe defaults instead of crashing the whole submission.
    try:
        return gemini_model.classify(text, office_hint=office_hint)
    except Exception as e:
        print(f"[heavy_model] Gemini fallback failed, degrading to defaults: {e}", file=sys.stderr, flush=True)
        return "Neutral", [GENERAL_FEEDBACK]


def analyze_pure_ai(text, office_hint=None):
    # The main entry point for classifying a comment. Junk gets caught
    # early for free, everything else goes straight to Gemini.
    junk = detect_junk_topic(text)
    if junk:
        return "Neutral", [junk]
    return _gemini_classify_safe(text, office_hint=office_hint)
