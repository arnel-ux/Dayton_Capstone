import sys
import json
import os
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from comment_filter import is_no_feedback

# Reads either plain comment text or a JSON payload like
# {"comment": "...", "offline": true} from stdin.
# Every comment goes through Gemini now, online or offline, so is_offline
# is just kept as info rather than something that changes the logic.
# server.js talks to model_server.py directly for live comments, so this
# script only runs for offline syncing or as a manual fallback.
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
        pass  # not actually JSON, treat it as plain text

try:
    # Blank or "N/A" style comments get no classification at all.
    if is_no_feedback(client_comment):
        final_sentiment = None
        final_topics = None
    else:
        import heavy_model
        final_sentiment, final_topics = heavy_model.analyze_pure_ai(client_comment, office_hint=office_hint)

    print(json.dumps({
        "sentiment": final_sentiment,
        "topics": final_topics
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
