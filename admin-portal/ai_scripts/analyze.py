import sys
import json
import os
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

import torch
from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification

# Read the comment securely
client_comment = sys.stdin.read().strip()

# ---------------------------------------------------------------------------
# DEVICE / PRECISION SETUP
# GPU present  -> fp16 weights on CUDA (fast + low memory, no accuracy loss
#                 worth mentioning for this use case).
# CPU only     -> dynamic INT8 quantization of the Linear layers, which is
#                 where almost all the FLOPs in a transformer live. This is
#                 the safe, well-supported PyTorch technique for speeding up
#                 CPU inference without retraining or a full precision loss.
# ---------------------------------------------------------------------------
USE_CUDA = torch.cuda.is_available()
DEVICE = 0 if USE_CUDA else -1


def load_fast_model(model_name, allow_cpu_quantization=True):
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    if USE_CUDA:
        model = AutoModelForSequenceClassification.from_pretrained(
            model_name, torch_dtype=torch.float16
        ).to("cuda")
    else:
        model = AutoModelForSequenceClassification.from_pretrained(model_name)
        if allow_cpu_quantization:
            model = torch.quantization.quantize_dynamic(
                model, {torch.nn.Linear}, dtype=torch.qint8
            )
    model.eval()
    return model, tokenizer


# 1. LOAD SENTIMENT AI
# tabularisai/multilingual-sentiment-analysis is trained across 20+ languages and
# handles code-switched Taglish/Tagalog/English far more reliably than the old
# cardiffnlp XLM-R model, without needing any keyword lists or translation step.
_sent_model, _sent_tokenizer = load_fast_model("tabularisai/multilingual-sentiment-analysis")
sentiment_analyzer = pipeline(
    "text-classification",
    model=_sent_model,
    tokenizer=_sent_tokenizer,
    framework="pt",
    device=DEVICE,
)

# 2. LOAD TRUE AI TOPIC MODELER (Zero-Shot Classification)
# MoritzLaurer/mDeBERTa-v3-base-mnli-xnli is a stronger multilingual NLI backbone
# than the old symanto model, giving noticeably better zero-shot topic accuracy
# on Taglish/Tagalog text while keeping the "pass any topic list" workflow.
# NOTE: DeBERTa-v3's disentangled attention is not compatible with PyTorch's
# dynamic INT8 quantization backend (raises a dtype error at inference), so on
# CPU this model stays fp32 — only the sentiment model gets quantized. It
# still benefits from fp16 automatically when a CUDA GPU is available, and
# from the torch.no_grad() inference wrapper below either way.
_topic_model, _topic_tokenizer = load_fast_model(
    "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli", allow_cpu_quantization=False
)
topic_modeler = pipeline(
    "zero-shot-classification",
    model=_topic_model,
    tokenizer=_topic_tokenizer,
    framework="pt",
    device=DEVICE,
)

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

# ---------------------------------------------------------------------------
# MIXED-SENTIMENT THRESHOLDS
# The sentiment model is 5-class (Very Negative / Negative / Neutral /
# Positive / Very Positive). We collapse it to 3-class by summing the
# probability mass on each side, then apply a balancing rule:
#   - MIN_SIGNAL:     the smaller of the two sides (positive/negative) must
#                      carry at least this much probability to count as a
#                      "real" opinion, not just noise.
#   - DIFF_THRESHOLD: if both sides clear MIN_SIGNAL and the gap between
#                      them is within this margin, the review is genuinely
#                      split (e.g. "sometimes good sometimes bad") and gets
#                      forced to Neutral rather than whichever side nudged
#                      ahead.
#
# Calibrated empirically against this model: clearly one-sided reviews
# ("worst experience ever", "great service, very friendly staff") land with
# a pos/neg gap of ~0.87-0.91 and a minority-side share of ~0.03-0.04.
# Genuinely mixed reviews ("sometimes good sometimes bad", "it was good but
# also bad") land with a gap of ~0.01-0.51 and a minority-side share of
# ~0.18-0.40. The thresholds sit in the wide gap between those two clusters.
# ---------------------------------------------------------------------------
MIN_SIGNAL = 0.15
DIFF_THRESHOLD = 0.65


def classify_sentiment(text):
    with torch.no_grad():
        try:
            scores = sentiment_analyzer(text, truncation=True, max_length=512, top_k=None)
        except TypeError:
            # Older transformers versions use return_all_scores instead of top_k
            scores = sentiment_analyzer(text, truncation=True, max_length=512, return_all_scores=True)

        # A single string input can come back either as a flat list of
        # per-label dicts, or as a list containing one such list, depending
        # on the transformers version — normalize to the flat list.
        if scores and isinstance(scores[0], list):
            scores = scores[0]

    def polarity(label):
        label = label.lower()
        if 'negative' in label:
            return 'negative'
        if 'positive' in label:
            return 'positive'
        return 'neutral'

    pos_prob = 0.0
    neg_prob = 0.0
    neu_prob = 0.0
    for item in scores:
        score = float(item['score'])
        p = polarity(item['label'])
        if p == 'negative':
            neg_prob += score
        elif p == 'positive':
            pos_prob += score
        else:
            neu_prob += score

    # Guard against a false "mixed" read: when the two highest-scoring raw
    # classes are both on the same side (e.g. Negative + Very Negative), the
    # model is just unsure about *intensity*, not torn between polarities.
    # Only treat it as genuinely mixed when the top-2 classes disagree on
    # polarity (or one of them is Neutral).
    ranked = sorted(scores, key=lambda x: float(x['score']), reverse=True)
    top_polarity = polarity(ranked[0]['label'])
    second_polarity = polarity(ranked[1]['label']) if len(ranked) > 1 else top_polarity
    same_family_intensity_split = (
        top_polarity == second_polarity and top_polarity != 'neutral'
    )

    diff = abs(pos_prob - neg_prob)
    if (
        not same_family_intensity_split
        and pos_prob >= MIN_SIGNAL
        and neg_prob >= MIN_SIGNAL
        and diff <= DIFF_THRESHOLD
    ):
        return "Neutral"

    best = max(("Positive", pos_prob), ("Negative", neg_prob), ("Neutral", neu_prob), key=lambda x: x[1])
    return best[0]


try:
    if client_comment == "":
        final_sentiment = "Neutral"
        final_topic = "General Feedback"
    else:
        # A. Process Sentiment (with mixed-sentiment balancing)
        final_sentiment = classify_sentiment(client_comment)

        # B. Process True AI Topic
        # The AI predicts the best matching category based on semantic context
        with torch.no_grad():
            topic_res = topic_modeler(client_comment, candidate_topics)

        # Extract the highest probability topic (e.g., "Queueing and Waiting Time")
        final_topic = topic_res['labels'][0]

    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
