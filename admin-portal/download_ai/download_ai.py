import os
import subprocess
import sys

# Force a massive 15-minute timeout limit so slow Wi-Fi doesn't crash it
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '1000'

# server.js now runs comment analysis through a persistent Flask model
# server (ai_scripts/model_server.py) instead of spawning a fresh Python
# process per comment, so Flask is a required dependency going forward.
try:
    import flask  # noqa: F401
except ImportError:
    print("Installing Flask (required by ai_scripts/model_server.py)...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "flask"])

from transformers import pipeline

print("Starting Initial Setup: Downloading AI Models...")
print("This may take 10-20 minutes depending on your internet connection.")
print("-" * 50)

# 1. Download Sentiment Analysis AI (OLD - kept cached as a fallback)
print("1/4: Downloading Sentiment AI Model (CardiffNLP)...")
pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment", framework="pt")
print("✅ Sentiment AI Download Complete!")

print("-" * 50)

# 2. Download Zero-Shot Topic Modeler AI (OLD - kept cached as a fallback)
print("2/4: Downloading Zero-Shot Topic AI Model (Symanto)...")
pipeline("zero-shot-classification", model="symanto/xlm-roberta-base-snli-mnli-anli-xnli", framework="pt")
print("✅ Topic AI Download Complete!")

print("-" * 50)

# 3. Download Sentiment Analysis AI (NEW - active model used by analyze.py)
print("3/4: Downloading Sentiment AI Model (tabularisai multilingual)...")
pipeline("text-classification", model="tabularisai/multilingual-sentiment-analysis", framework="pt")
print("✅ Sentiment AI Download Complete!")

print("-" * 50)

# 4. Download Zero-Shot Topic Modeler AI (NEW - active model used by analyze.py)
print("4/4: Downloading Zero-Shot Topic AI Model (mDeBERTa-v3 mnli-xnli)...")
pipeline("zero-shot-classification", model="MoritzLaurer/mDeBERTa-v3-base-mnli-xnli", framework="pt")
print("✅ Topic AI Download Complete!")

print("-" * 50)
print("🎉 ALL DOWNLOADS 100% COMPLETE! Your AI environment is fully set up.")
print("You can now safely run 'node server.js' to start the system.")