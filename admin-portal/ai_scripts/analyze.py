import sys
import json
import os
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from comment_filter import is_no_feedback

# ---------------------------------------------------------------------------
# INPUT PROTOCOL
# Backward compatible with the original "raw comment text on stdin" contract,
# plus a new optional JSON envelope: {"comment": "...", "offline": true}.
#
# 2026-09-25: offline-synced comments (see /sync-surveys in server.js) now
# get the exact same pure-Gemini classification as live comments — reverses
# the 2026-09-22 decision to keep offline sync on the keyword-lexicon-first
# hybrid. Offline sync only ever reaches this script once the device is back
# online and actually talking to the server, so the original rationale for a
# lexicon fallback (network/rate-limit conservatism) doesn't hold here the
# way it does for a live submission — consistent accuracy (including
# multi-topic tagging, see gemini_model.py's MAX_TOPICS) across every comment
# regardless of channel was judged more valuable than the small amount of
# Gemini quota this saves. `is_offline` is kept (not removed) since it's
# still meaningful request metadata, even though it no longer changes which
# function gets called below; heavy_model.analyze() (the hybrid) remains
# available for test_accuracy.py's lexicon-only scoring, just no longer used
# by any production path.
#
# NOTE: server.js's live path (/submit-survey) no longer calls this script —
# it talks to the persistent model_server.py over HTTP instead, so a comment
# never pays a full model-load cost per submission (see model_server.py's
# docstring). This script remains as: (a) the offline/batch-sync path, and
# (b) a standalone CLI fallback if run directly or if the model server is
# ever unavailable — both load the Gemini client fresh in this one-off
# process, so slower than the persistent model server but self-contained.
# ---------------------------------------------------------------------------
raw_input = sys.stdin.read().strip()

client_comment = raw_input
is_offline = False
office_hint = None
if raw_input.startswith('{'):
    try:
        payload = json.loads(raw_input)
        client_comment = str(payload.get("comment", "") or "").strip()
        is_offline = bool(payload.get("offline", False))
        office_hint = str(payload.get("office", "") or "").strip() or None
    except (json.JSONDecodeError, ValueError):
        pass  # not JSON after all — treat raw_input as the plain comment text

try:
    # Blank AND common "nothing to say" placeholders ("N/A", "none", "no
    # comment", ...) must never receive a fabricated classification — see
    # is_no_feedback's docstring. None here becomes a real JSON null, which
    # server.js's analyzeComment() already treats the same way a blank
    # comment always has (never a default "Neutral"/"General Feedback").
    if is_no_feedback(client_comment):
        final_sentiment = None
        final_topics = None
    else:
        # Pure-AI path for both online and offline (see module comment
        # above) — skips the keyword lexicon entirely, same as
        # model_server.py's /analyze route. final_topics is always a
        # non-empty list (multi-topic tagging project, 2026-09-25).
        import heavy_model
        final_sentiment, final_topics = heavy_model.analyze_pure_ai(client_comment, office_hint=office_hint)

    print(json.dumps({
        "sentiment": final_sentiment,
        "topics": final_topics
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
