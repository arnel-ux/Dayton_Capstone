import os
# Force a massive 15-minute timeout limit so slow Wi-Fi doesn't crash it
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '1000' 

from transformers import pipeline

print("Downloading optimized PyTorch AI Model (Half the size)... Please wait.")

# The framework='pt' tells it to completely ignore the massive TensorFlow file
pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment", framework="pt")

print("✅ Download 100% Complete! You can now start Node.js.")