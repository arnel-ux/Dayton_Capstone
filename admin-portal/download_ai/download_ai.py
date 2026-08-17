import os

# Force a massive 15-minute timeout limit so slow Wi-Fi doesn't crash it
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '1000' 

from transformers import pipeline

print("Starting Initial Setup: Downloading AI Models...")
print("This may take 10-20 minutes depending on your internet connection.")
print("-" * 50)

# 1. Download Sentiment Analysis AI
print("1/2: Downloading Sentiment AI Model (CardiffNLP)...")
pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment", framework="pt")
print("✅ Sentiment AI Download Complete!")

print("-" * 50)

# 2. Download Zero-Shot Topic Modeler AI
print("2/2: Downloading Zero-Shot Topic AI Model (Symanto)...")
pipeline("zero-shot-classification", model="symanto/xlm-roberta-base-snli-mnli-anli-xnli", framework="pt")
print("✅ Topic AI Download Complete!")

print("-" * 50)
print("🎉 ALL DOWNLOADS 100% COMPLETE! Your AI environment is fully set up.")
print("You can now safely run 'node server.js' to start the system.")