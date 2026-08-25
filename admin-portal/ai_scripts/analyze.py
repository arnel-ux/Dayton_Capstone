import sys
import json
import os
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from topic_common import GENERAL_FEEDBACK, fast_sentiment, fast_topic

# ---------------------------------------------------------------------------
# INPUT PROTOCOL
# Backward compatible with the original "raw comment text on stdin" contract,
# plus a new optional JSON envelope: {"comment": "...", "offline": true}.
# The "offline" flag marks comments synced from the client's IndexedDB outbox
# (see /sync-surveys in server.js) — nobody is waiting on those in real time,
# so they take the fast heuristic path below instead of the full model path.
#
# NOTE: server.js's live path (/submit-survey) no longer calls this script —
# it talks to the persistent model_server.py over HTTP instead, so a comment
# never pays a full model-load cost per submission (see model_server.py's
# docstring). This script remains as: (a) the offline/batch-sync fast path,
# and (b) a standalone CLI fallback that still works correctly (just slower,
# since it loads the models itself) if run directly or if the model server
# is ever unavailable.
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
    if client_comment == "":
        final_sentiment = "Neutral"
        final_topic = GENERAL_FEEDBACK

    elif is_offline:
        # Fast path: no model import, no model load, no network — just the
        # local lexicon in topic_common.py. This is what makes offline-synced
        # batches fast.
        final_sentiment = fast_sentiment(client_comment)
        final_topic = fast_topic(client_comment)

    else:
        # Heavy path — only reached when this script is run standalone
        # (not through server.js's live route, which uses model_server.py
        # directly). Loads the full transformer models in this one-off
        # process, so it's slow but self-contained and always correct.
        import heavy_model
        final_sentiment, final_topic = heavy_model.analyze(client_comment, office_hint=office_hint)

    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
