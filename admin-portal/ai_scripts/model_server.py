"""
Persistent local HTTP wrapper around heavy_model.py. server.js spawns this
once when the admin portal starts (see startModelServer in server.js) and
sends every live-comment analysis request here instead of spawning a fresh
`python analyze.py` process per comment.

This is the ONLINE classification path: every comment that reaches
heavy_model.analyze_pure_ai() here is classified by Gemini alone, with no
keyword-lexicon matching (see that function's docstring). Offline-synced
comments never hit this server at all — they go through analyze.py's own
process-per-comment path instead, which (as of 2026-09-25) calls this same
analyze_pure_ai() function too, just via a fresh subprocess rather than this
persistent one.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import warnings
warnings.filterwarnings('ignore')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')

from flask import Flask, request, jsonify

import heavy_model
from comment_filter import is_no_feedback

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "ready": heavy_model.is_ready()})


@app.route("/analyze", methods=["POST"])
def analyze_route():
    data = request.get_json(force=True, silent=True) or {}
    comment = str(data.get("comment", "") or "").strip()
    office_hint = str(data.get("office", "") or "").strip() or None

    # Blank AND common "nothing to say" placeholders must never receive a
    # fabricated classification — see is_no_feedback's docstring in
    # topic_common.py. `null` here (not "Neutral"/"General Feedback") is
    # what server.js's analyzeComment() already expects for "no real
    # classification" in every other case.
    if is_no_feedback(comment):
        return jsonify({"sentiment": None, "topics": None})

    try:
        # topics is always a non-empty list (multi-topic tagging project,
        # 2026-09-25) — see heavy_model.analyze_pure_ai's docstring.
        sentiment, topics = heavy_model.analyze_pure_ai(comment, office_hint=office_hint)
        return jsonify({"sentiment": sentiment, "topics": topics})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("AI_MODEL_SERVER_PORT", "8765"))
    print(f"[model_server] loading AI models (port {port})...", flush=True)
    heavy_model.warmup()
    print("[model_server] READY", flush=True)
    # threaded=True lets the health check respond even while a request is
    # mid-inference; single Python process still runs one inference at a
    # time under the GIL, which is fine for this workload (fire-and-forget,
    # low request rate from a single office admin portal).
    app.run(host="127.0.0.1", port=port, threaded=True)
