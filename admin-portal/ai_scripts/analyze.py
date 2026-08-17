import sys
import json
import os
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

from transformers import pipeline

# Read the comment securely
client_comment = sys.stdin.read().strip()

# 1. LOAD SENTIMENT AI
sentiment_analyzer = pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment", framework="pt")

# 2. LOAD TRUE AI TOPIC MODELER (Zero-Shot Classification)
topic_modeler = pipeline("zero-shot-classification", model="symanto/xlm-roberta-base-snli-mnli-anli-xnli", framework="pt")

# 3. YOUR DYNAMIC DASHBOARD CATEGORIES
# The AI will read the feedback and mathematically assign it to one of these exact phrases.
# You can change these to match whatever you want to show on your Admin Dashboard!
candidate_topics = [
    "Queueing and Waiting Time", 
    "Internet Connection", 
    "Office Facilities", 
    "Customer Service", 
    "General Feedback"
]

try:
    if client_comment == "":
        final_sentiment = "Neutral"
        final_topic = "General Feedback"
    else:
        # A. Process Sentiment
        sent_res = sentiment_analyzer(client_comment, truncation=True, max_length=512)[0]
        raw_label = str(sent_res['label']).lower()
        
        if '0' in raw_label or 'negative' in raw_label:
            final_sentiment = "Negative"
        elif '2' in raw_label or 'positive' in raw_label:
            final_sentiment = "Positive"
        else:
            final_sentiment = "Neutral"

        # B. Process True AI Topic
        # The AI predicts the best matching category based on semantic context
        topic_res = topic_modeler(client_comment, candidate_topics)
        
        # Extract the highest probability topic (e.g., "Queueing and Waiting Time")
        final_topic = topic_res['labels'][0]

    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))