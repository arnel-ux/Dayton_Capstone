import sys
import json
import re
import warnings
from collections import Counter

warnings.filterwarnings('ignore')

from transformers import pipeline

# Read the comment securely
client_comment = sys.stdin.read().strip()

# WARNING: This line will trigger a 1.1GB download the very first time it runs on a new PC!
sentiment_analyzer = pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment")

STOPWORDS = set([
    "the", "and", "is", "in", "it", "of", "for", "to", "that", "was", "on", "with", "as", "at", "by",
    "this", "but", "are", "not", "have", "be", "from", "or", "an", "they", "which", "you", "we", "can",
    "sa", "ng", "na", "ang", "mga", "ay", "po", "opo", "ko", "mo", "niya", "nila", "namin", "natin",
    "kay", "kung", "ba", "pa", "rin", "din", "naman", "lang", "eh", "kasi", "yung", "ako", "siya",
    "sila", "kami", "tayo", "ni", "pang", "para", "dahil", "daw", "raw", "nga", "yung", "ung",
    "may", "wala", "very", "so", "much", "too", "really", "just", "do", "did", "does", "all", "ano"
])

def extract_important_keywords(text):
    clean_text = re.sub(r'[^\w\s]', '', text.lower())
    words = clean_text.split()
    meaningful_words = [w for w in words if w not in STOPWORDS and len(w) > 2]
    
    if not meaningful_words:
        return "General Feedback"
        
    word_counts = Counter(meaningful_words)
    top_words = [word for word, count in word_counts.most_common(2)]
    return " ".join(top_words).title()

try:
    if client_comment == "":
        final_sentiment = "Neutral"
        final_topic = "General Feedback"
    else:
        sent_res = sentiment_analyzer(client_comment, truncation=True, max_length=512)[0]
        raw_label = str(sent_res['label']).lower()
        
        if '0' in raw_label or 'negative' in raw_label:
            final_sentiment = "Negative"
        elif '2' in raw_label or 'positive' in raw_label:
            final_sentiment = "Positive"
        else:
            final_sentiment = "Neutral"

        final_topic = extract_important_keywords(client_comment)

    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))