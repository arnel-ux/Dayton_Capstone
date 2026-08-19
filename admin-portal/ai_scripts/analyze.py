import sys
import json
import os
import re
import warnings

warnings.filterwarnings('ignore')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'

# ---------------------------------------------------------------------------
# INPUT PROTOCOL
# Backward compatible with the original "raw comment text on stdin" contract,
# plus a new optional JSON envelope: {"comment": "...", "offline": true}.
# The "offline" flag marks comments synced from the client's IndexedDB outbox
# (see /sync-surveys in server.js) — nobody is waiting on those in real time,
# so they take the fast heuristic path below instead of the full model path.
# ---------------------------------------------------------------------------
raw_input = sys.stdin.read().strip()

client_comment = raw_input
is_offline = False
if raw_input.startswith('{'):
    try:
        payload = json.loads(raw_input)
        client_comment = str(payload.get("comment", "") or "").strip()
        is_offline = bool(payload.get("offline", False))
    except (json.JSONDecodeError, ValueError):
        pass  # not JSON after all — treat raw_input as the plain comment text

# "General Feedback" is deliberately NOT a zero-shot candidate (see
# classify_topic below) — it's a low-confidence fallback only, so a comment
# is never routed there just because it edged out the other hypotheses.
candidate_topics = [
    "Queueing and Waiting Time",
    "Transaction Speed",
    "Process Efficiency",
    "Ease of Use",
    "Internet Connection",
    "Facilities and Equipment",
    "Customer Service",
]

# ---------------------------------------------------------------------------
# TAGLISH KEYWORD ANCHORS
# Zero-shot NLI models are weakest exactly where local feedback lives: short
# Taglish phrases like "mahina ang aircon". These lexicons do two jobs:
#   1. Feed a richer, example-laden hypothesis to the zero-shot model so it
#      has concrete Taglish anchors to match against (the "few-shot" context
#      an NLI model can actually use, since it has no true few-shot mode).
#   2. Provide a small deterministic score boost/tiebreak when a comment
#      contains one of these unambiguous object-noun keywords, and power the
#      fast offline heuristic path entirely on their own.
# Only *object nouns* (aircon, wifi, pila) are used as anchors — never bare
# descriptors like "mabagal"/"mahina" alone, since those are ambiguous across
# every category (slow queue vs slow wifi vs weak aircon) and would misfire.
# ---------------------------------------------------------------------------
TOPIC_KEYWORDS = {
    "Queueing and Waiting Time": [
        "pila", "linya", "queue", "queueing", "waiting line", "numero", "hintay",
    ],
    "Internet Connection": [
        "internet", "wifi", "wi-fi", "signal", "network", "koneksyon", "online system",
    ],
    "Facilities and Equipment": [
        "aircon", "air-con", "air condition", "aircondition", "kuryente", "ilaw",
        "banyo", "cr", "palikuran", "upuan", "silya", "mesa", "pasilidad",
        "kagamitan", "equipment", "facilities", "aparatus", "makina",
    ],
    "Customer Service": [
        "staff", "kawani", "empleyado", "tauhan", "employee", "receptionist",
        "guard", "security", "clerk",
    ],
    # "transaction" is the unambiguous object-noun anchor for comments whose
    # core driver is how fast the service itself moved (hal. "bilis ng
    # transaction") — as opposed to "Queueing" (waiting for your turn) or
    # "Process Efficiency" (how simple the steps were).
    "Transaction Speed": [
        "transaction", "pag-transact", "processing time", "release ng resulta",
    ],
    # Compound Taglish/English phrases that unambiguously describe the
    # process itself being simple/tedious, not any specific object.
    "Process Efficiency": [
        "hassle-free", "hassle free", "walang abala", "walang hassle",
        "streamlined", "isang beses lang", "one-stop", "maraming hakbang",
        "kumplikado",
    ],
    "Ease of Use": [
        "user-friendly", "user friendly", "madaling gamitin",
        "mahirap gamitin", "nakakalito", "confusing na sundin",
    ],
}

CATEGORY_HYPOTHESES = {
    "Queueing and Waiting Time": (
        "long queues or waiting in line before being served "
        "(hal. mahabang pila, matagal maghintay ng turn, mabagal ang linya)"
    ),
    "Transaction Speed": (
        "how fast or slow the actual transaction or processing was once it "
        "started (hal. sobrang bilis ng transaction, mabilis ang pagproseso, "
        "matagal bago ma-release)"
    ),
    "Process Efficiency": (
        "whether the process itself was simple and hassle-free versus "
        "tedious and complicated, regardless of speed "
        "(hal. very hassle-free, walang abala, kaunting hakbang lang, "
        "kumplikado ang requirements)"
    ),
    "Ease of Use": (
        "how easy or difficult a system, form, or set of steps was to use "
        "or understand (hal. madaling gamitin, user-friendly, nakakalito, "
        "magulo ang instructions)"
    ),
    "Internet Connection": (
        "internet, wifi, or online system connectivity problems "
        "(hal. mabagal o walang internet, mahinang wifi o signal)"
    ),
    "Facilities and Equipment": (
        "the office's physical facilities, environment, or equipment such as "
        "aircon, lighting, cleanliness, chairs, or restrooms "
        "(hal. mahina o sirang aircon, walang kuryente, madumi, sirang kagamitan)"
    ),
    "Customer Service": (
        "staff behavior, courtesy, or helpfulness "
        "(hal. magalang o bastos na staff, mabait o walang pakialam na tauhan)"
    ),
}
GENERAL_FEEDBACK = "General Feedback"
# Zero-shot confidence floor for the best specific-category match. Below
# this, the comment genuinely doesn't lean toward any specific theme, so it
# falls back to General Feedback — but General Feedback itself is never one
# of the hypotheses being scored, so it can't win just by being vaguer than
# the others. With 7 specific candidates, a uniform/no-signal read is ~0.14
# each; 0.22 requires the model to have picked a real winner.
GENERAL_FALLBACK_THRESHOLD = 0.22
candidate_hypotheses = [CATEGORY_HYPOTHESES[t] for t in candidate_topics]
hypothesis_to_topic = {v: k for k, v in CATEGORY_HYPOTHESES.items()}

def keyword_topic_override(text):
    """
    Best-matching topic by object-noun keyword count, or None if no keyword
    hit at all. Empirically, MoritzLaurer/mDeBERTa-v3-base-mnli-xnli's
    zero-shot read on short Taglish phrases is unreliable even with a
    richer hypothesis template — e.g. "mahina ang aircon" scored highest on
    "Queueing and Waiting Time" (0.99) and lowest on the correct
    "Facilities and Equipment" (0.01). A small additive score boost can't
    close a gap that size, so a keyword hit on these curated, unambiguous
    local-language nouns wins outright instead of just nudging the model.
    The zero-shot model is kept as the fallback for comments that don't
    contain any of these anchors.
    """
    lowered = text.lower()
    hits = {}
    for topic, keywords in TOPIC_KEYWORDS.items():
        count = sum(1 for kw in keywords if re.search(r'\b' + re.escape(kw) + r'\b', lowered))
        if count:
            hits[topic] = count
    if not hits:
        return None
    return max(hits.items(), key=lambda kv: kv[1])[0]


# ---------------------------------------------------------------------------
# FAST PATH — lightweight lexicon heuristics, zero model loading.
# Used for offline-synced comments (see is_offline above) where the batch is
# processed after the fact with nobody waiting live, so we skip the ~1GB of
# transformer weights entirely and rely on local keyword/lexicon matching —
# "immediate local processing" instead of heavy inference.
# ---------------------------------------------------------------------------
FAST_NEGATIVE_WORDS = [
    "mahina", "masama", "pangit", "sira", "sirang", "bastos", "mabagal",
    "matagal", "bobo", "reklamo", "galit", "problema", "hassle",
    "poor", "bad", "slow", "broken", "rude", "worst", "terrible", "awful",
]
FAST_POSITIVE_WORDS = [
    "maganda", "mabilis", "magaling", "mabait", "salamat", "masaya",
    "satisfied", "great", "good", "excellent", "fast", "helpful",
    "friendly", "nice", "the best", "love it", "hassle-free", "hassle free",
]


def fast_sentiment(text):
    lowered = text.lower()
    pos = sum(1 for w in FAST_POSITIVE_WORDS if w in lowered)
    # Strip matched positive phrases before scanning for negative words, so a
    # positive phrase containing a negative substring (e.g. "hassle-free"
    # contains "hassle") isn't double-counted as evidence for both sides.
    masked = lowered
    for w in FAST_POSITIVE_WORDS:
        masked = masked.replace(w, " ")
    neg = sum(1 for w in FAST_NEGATIVE_WORDS if w in masked)
    if neg > pos:
        return "Negative"
    if pos > neg:
        return "Positive"
    return "Neutral"


def fast_topic(text):
    return keyword_topic_override(text) or GENERAL_FEEDBACK


try:
    if client_comment == "":
        final_sentiment = "Neutral"
        final_topic = GENERAL_FEEDBACK

    elif is_offline:
        # Fast path: no model import, no model load, no network — just the
        # local lexicon above. This is what makes offline-synced batches fast.
        final_sentiment = fast_sentiment(client_comment)
        final_topic = fast_topic(client_comment)

    else:
        # Heavy path: only import torch/transformers when we actually need
        # them, so blank/offline comments never pay the model-load cost.
        import torch
        from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification

        # -------------------------------------------------------------
        # DEVICE / PRECISION SETUP
        # GPU present  -> fp16 weights on CUDA (fast + low memory, no accuracy
        #                 loss worth mentioning for this use case).
        # CPU only     -> dynamic INT8 quantization of the Linear layers,
        #                 where almost all the FLOPs in a transformer live.
        # -------------------------------------------------------------
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

        # 1. SENTIMENT AI
        # tabularisai/multilingual-sentiment-analysis is trained across 20+
        # languages and handles code-switched Taglish/Tagalog/English far more
        # reliably than the old cardiffnlp XLM-R model, with no keyword lists
        # or translation step needed.
        _sent_model, _sent_tokenizer = load_fast_model("tabularisai/multilingual-sentiment-analysis")
        sentiment_analyzer = pipeline(
            "text-classification",
            model=_sent_model,
            tokenizer=_sent_tokenizer,
            framework="pt",
            device=DEVICE,
        )

        # 2. TOPIC MODELER (Zero-Shot Classification) — lazily constructed.
        # MoritzLaurer/mDeBERTa-v3-base-mnli-xnli is the larger of the two
        # models, and classify_topic() below resolves most comments via the
        # keyword override without ever needing it. _get_topic_modeler() only
        # loads it the first time a comment has no keyword match, instead of
        # paying that cost unconditionally on every heavy-path call.
        # NOTE: DeBERTa-v3's disentangled attention is not compatible with
        # PyTorch's dynamic INT8 quantization backend, so on CPU this model
        # stays fp32 — only the sentiment model gets quantized. It still
        # benefits from fp16 on CUDA, and from torch.no_grad() either way.
        _topic_modeler_cache = {}

        def _get_topic_modeler():
            if 'pipeline' not in _topic_modeler_cache:
                _topic_model, _topic_tokenizer = load_fast_model(
                    "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli", allow_cpu_quantization=False
                )
                _topic_modeler_cache['pipeline'] = pipeline(
                    "zero-shot-classification",
                    model=_topic_model,
                    tokenizer=_topic_tokenizer,
                    framework="pt",
                    device=DEVICE,
                )
            return _topic_modeler_cache['pipeline']

        # ---------------------------------------------------------------
        # MIXED-SENTIMENT THRESHOLDS
        # The sentiment model is 5-class (Very Negative / Negative / Neutral /
        # Positive / Very Positive). We collapse it to 3-class by summing the
        # probability mass on each side, then apply a balancing rule:
        #   - MIN_SIGNAL:     the smaller of the two sides (positive/negative)
        #                      must carry at least this much probability to
        #                      count as a "real" opinion, not just noise.
        #   - DIFF_THRESHOLD: if both sides clear MIN_SIGNAL and the gap
        #                      between them is within this margin, the review
        #                      is genuinely split and gets forced to Neutral
        #                      rather than whichever side nudged ahead.
        #
        # Calibrated empirically: clearly one-sided reviews ("worst experience
        # ever", "great service, very friendly staff") land with a pos/neg
        # gap of ~0.87-0.91 and a minority-side share of ~0.03-0.04. Genuinely
        # mixed reviews ("sometimes good sometimes bad") land with a gap of
        # ~0.01-0.51 and a minority-side share of ~0.18-0.40. The thresholds
        # sit in the wide gap between those two clusters.
        # ---------------------------------------------------------------
        MIN_SIGNAL = 0.15
        DIFF_THRESHOLD = 0.65

        def classify_sentiment(text):
            with torch.no_grad():
                try:
                    scores = sentiment_analyzer(text, truncation=True, max_length=512, top_k=None)
                except TypeError:
                    # Older transformers versions use return_all_scores instead of top_k
                    scores = sentiment_analyzer(text, truncation=True, max_length=512, return_all_scores=True)

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

            # Guard against a false "mixed" read: when the two highest-scoring
            # raw classes are both on the same side (e.g. Negative + Very
            # Negative), the model is just unsure about *intensity*, not torn
            # between polarities. Only treat it as genuinely mixed when the
            # top-2 classes disagree on polarity (or one of them is Neutral).
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

        def classify_topic(text):
            # Keyword anchors win outright when present (see
            # keyword_topic_override's docstring for why) — this also skips
            # the zero-shot call entirely on a hit, which is a nice speed
            # win since it's the most expensive step in the pipeline.
            override = keyword_topic_override(text)
            if override:
                return override

            # General Feedback is intentionally excluded from
            # candidate_hypotheses (see GENERAL_FALLBACK_THRESHOLD) so the
            # model is forced to pick its best specific-category match; only
            # a genuinely low-confidence top score demotes it to General
            # Feedback, instead of General Feedback competing directly and
            # winning on vague comments just for being the safe default.
            with torch.no_grad():
                res = _get_topic_modeler()(text, candidate_hypotheses, multi_label=False)

            top_label, top_score = res['labels'][0], res['scores'][0]
            if top_score < GENERAL_FALLBACK_THRESHOLD:
                return GENERAL_FEEDBACK
            return hypothesis_to_topic[top_label]

        final_sentiment = classify_sentiment(client_comment)
        final_topic = classify_topic(client_comment)

    print(json.dumps({
        "sentiment": final_sentiment,
        "topic": final_topic
    }))

except Exception as e:
    print(json.dumps({"error": str(e)}))
