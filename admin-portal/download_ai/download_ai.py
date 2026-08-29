"""
First-time setup check for the AI comment-analysis pipeline. Historically
this downloaded ~1GB of local transformer weights (mDeBERTa, tabularisai,
and two earlier models before those) so ai_scripts/model_server.py could run
zero-shot topic/sentiment classification entirely on-box. That whole local-
model path was removed on 2026-08-29 in favor of Gemini 3.5 Flash-Lite (see
ai_scripts/gemini_model.py + heavy_model.py's module docstring for why —
mDeBERTa resolved only 26.2% of the topic cases the keyword lexicon
couldn't, versus Gemini's 72%+ on the same slice) — there are no model
weights to download anymore, just a couple of lightweight pip packages and a
live API key.
"""
import os
import subprocess
import sys

# Reconfigure stdout as UTF-8 so the checkmarks below don't crash on Windows'
# default cp1252 console encoding (only available on Python 3.7+, always
# true here — no need to guard it).
sys.stdout.reconfigure(encoding="utf-8")

# pip package name -> the name it's actually imported under.
REQUIRED_PACKAGES = {
    "flask": "flask",
    "google-genai": "google.genai",
    "python-dotenv": "dotenv",
}

print("Checking AI comment-analysis setup...")
print("-" * 50)

for pip_name, import_name in REQUIRED_PACKAGES.items():
    try:
        __import__(import_name)
    except ImportError:
        print(f"Installing {pip_name}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", pip_name])
print("✅ Required packages present.")
print("-" * 50)

# .env lives at admin-portal/.env, one directory up from this script.
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
try:
    from dotenv import load_dotenv
    load_dotenv(env_path)
except ImportError:
    pass

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    print("❌ GEMINI_API_KEY is not set.")
    print(f"   Add it to {os.path.abspath(env_path)} as: GEMINI_API_KEY=your_key_here")
    print("   Get a free key at https://aistudio.google.com/apikey (no billing required).")
    sys.exit(1)

print("Verifying the API key with a live test call...")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ai_scripts"))
try:
    import gemini_model
    sentiment, topic = gemini_model.classify("Maganda ang serbisyo dito.")
    print(f"✅ Gemini responded correctly (sentiment={sentiment}, topic={topic}).")
except Exception as e:
    print(f"❌ Gemini API call failed: {e}")
    print("   Check that GEMINI_API_KEY is valid and the account isn't rate-limited/quota-exhausted.")
    sys.exit(1)

print("-" * 50)
print("🎉 AI setup verified. You can now safely run 'node server.js' to start the system.")
