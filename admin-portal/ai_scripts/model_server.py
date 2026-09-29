"""
A small local server that keeps heavy_model.py loaded and ready.
server.js starts this once when the admin portal boots and sends every
live comment here instead of starting a fresh Python process each time.
This is the online path, using Gemini directly with no keyword lexicon.
Offline synced comments use the same Gemini function through analyze.py.
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

    # A blank or "N/A" style comment gets no classification at all.
    if is_no_feedback(comment):
        return jsonify({"sentiment": None, "topics": None})

    try:
        sentiment, topics = heavy_model.analyze_pure_ai(comment, office_hint=office_hint)
        return jsonify({"sentiment": sentiment, "topics": topics})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("AI_MODEL_SERVER_PORT", "8765"))
    print(f"[model_server] loading AI models (port {port})...", flush=True)
    heavy_model.warmup()
    print("[model_server] READY", flush=True)
    # threaded so the health check still responds while a request is running
    app.run(host="127.0.0.1", port=port, threaded=True)
