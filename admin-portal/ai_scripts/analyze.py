import sys
import json
from transformers import pipeline

# 1. Catch the comment sent by Node.js server.js
if len(sys.argv) > 1:
    client_comment = sys.argv[1]
else:
    client_comment = ""

# 2. Load the specific Models (matching your prototype)
sentiment_analyzer = pipeline("sentiment-analysis", model="cardiffnlp/twitter-xlm-roberta-base-sentiment")
topic_analyzer = pipeline("zero-shot-classification", model="symanto/xlm-roberta-base-snli-mnli-anli-xnli")

# 3. Define the Candidate Labels based on your `offices` table
office_labels = [
    "Office of the President",
    "Academic Affairs",
    "Administration and Finance",
    "Research, Innovation and Collaboration",
    "International Relations and Linkages",
    "Institutional Planning and Development",
    "Internal Audit",
    "Human Resource Management and Development",
    "Records and Freedom of Information",
    "Health Services",
    "General Services",
    "Supply and Property Management",
    "Project Management",
    "Information and Communications Technology",
    "Accounting",
    "Budget",
    "Cash",
    "Production and Auxiliary Services",
    "Center for Rinconada Culture and Arts",
    "College of Engineering and Architecture",
    "College of Health Sciences",
    "Buhi Campus",
    "Information and Alumni Affairs and Broadcast Center",
    "Research and Development Services",
    "Center for Extension and Community Services",
    "CCS",
    "Admission Offices"
]

try:
    if client_comment.strip() == "":
        final_sentiment = "Neutral"
        final_topic = "General"
    else:
        # Run Sentiment Analysis
        sent_res = sentiment_analyzer(client_comment, truncation=True, max_length=512)[0]
        raw_label = sent_res['label']
        
        # Map model output to clean labels
        sentiment_map = {
            'LABEL_0': 'Negative', 'LABEL_1': 'Neutral', 'LABEL_2': 'Positive',
            'negative': 'Negative', 'neutral': 'Neutral', 'positive': 'Positive'
        }
        final_sentiment = sentiment_map.get(raw_label, 'Neutral')

        # Run Topic/Office Modeling
        topic_res = topic_analyzer(client_comment, office_labels, truncation=True, max_length=512)
        final_topic = topic_res['labels'][0] # Grabs the highest matching office

    # 4. Print the output as a JSON string for Node.js to capture
    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))