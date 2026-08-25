"""
Full transformer-based sentiment + topic analysis. All models are loaded
lazily and cached at module level, so within a single process the ~1GB of
weights are only ever loaded once — analyze() on the 2nd, 3rd, ... call in
the same process just runs inference. model_server.py keeps this module
imported in a long-lived process specifically to exploit that caching;
analyze.py imports it too, so it still works correctly (just slower, one
model-load per invocation) when run standalone without the server.
"""
import os
import warnings

warnings.filterwarnings('ignore')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')

from topic_common import (
    broad_label_list,
    broad_label_to_topic,
    BROAD_TOPICS,
    BROAD_TO_SPECIFIC_FALLBACK,
    SUBTOPIC_GROUPS,
    keyword_topic_override,
    lexicon_sentiment,
    office_hint_topics,
    HYPOTHESIS_TEMPLATE,
    GENERAL_FEEDBACK,
    GENERAL_FALLBACK_THRESHOLD,
    SUBTOPIC_THRESHOLD,
    OFFICE_HINT_BOOST,
)

_state = {}


def _device_setup():
    import torch
    if 'use_cuda' not in _state:
        _state['use_cuda'] = torch.cuda.is_available()
        _state['device'] = 0 if _state['use_cuda'] else -1
        # CPU inference is latency-sensitive here (no GPU to hide behind),
        # so let torch use every core for intra-op parallelism instead of
        # the conservative default.
        if not _state['use_cuda']:
            torch.set_num_threads(max(1, os.cpu_count() or 1))
    return _state['use_cuda'], _state['device']


def _load_fast_model(model_name, allow_cpu_quantization=True):
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification

    use_cuda, _ = _device_setup()
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    if use_cuda:
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


def _get_sentiment_pipeline():
    if 'sentiment' not in _state:
        from transformers import pipeline
        _, device = _device_setup()
        # tabularisai/multilingual-sentiment-analysis is trained across 20+
        # languages and handles code-switched Taglish/Tagalog/English far
        # more reliably than older single-language models, with no keyword
        # lists or translation step needed.
        model, tokenizer = _load_fast_model("tabularisai/multilingual-sentiment-analysis")
        _state['sentiment'] = pipeline(
            "text-classification",
            model=model,
            tokenizer=tokenizer,
            framework="pt",
            device=device,
        )
    return _state['sentiment']


def _get_topic_pipeline():
    # Lazily constructed and only needed the first time a comment has no
    # keyword match, instead of paying the (larger) load cost unconditionally.
    # NOTE: DeBERTa-v3's disentangled attention is not compatible with
    # PyTorch's dynamic INT8 quantization backend, so on CPU this model
    # stays fp32 — only the sentiment model gets quantized. It still
    # benefits from fp16 on CUDA, and from torch.no_grad() either way.
    if 'topic' not in _state:
        from transformers import pipeline
        _, device = _device_setup()
        model, tokenizer = _load_fast_model(
            "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli", allow_cpu_quantization=False
        )
        _state['topic'] = pipeline(
            "zero-shot-classification",
            model=model,
            tokenizer=tokenizer,
            framework="pt",
            device=device,
        )
    return _state['topic']


def warmup():
    """Force both models to load immediately (called once at server startup)."""
    _get_sentiment_pipeline()
    _get_topic_pipeline()


def is_ready():
    return 'sentiment' in _state and 'topic' in _state


# ---------------------------------------------------------------------------
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
# ---------------------------------------------------------------------------
MIN_SIGNAL = 0.15
DIFF_THRESHOLD = 0.65


def classify_sentiment(text):
    # Keyword lexicon wins outright when it has a signal at all — see
    # topic_common's lexicon_sentiment docstring for why: the transformer is
    # empirically miscalibrated on short Tagalog/Taglish text (plain
    # positives scoring Neutral, negated phrases scoring Very Negative off
    # the negated word alone) in a way no amount of threshold tuning below
    # fixes. Tried making the transformer the primary decision-maker
    # (2026-08-24) with a confidence gate deferring to the lexicon only when
    # the AI was unsure — measured regression from 114/117 to 94/117 on the
    # sentiment test suite, because the transformer's confidence doesn't
    # reliably separate its right answers from its wrong ones on this data
    # (both land in a similar range), so a threshold can't cleanly rescue
    # only the wrong ones. Reverted. This also skips the transformer call
    # entirely on a lexicon hit, which is a nice speed win since it's one of
    # the two heaviest steps in the pipeline. The transformer remains the
    # fallback for text with no keyword coverage at all — nuanced English,
    # genuinely mixed reviews, sarcasm — which is exactly where its
    # mixed-sentiment logic below adds real value over a keyword count.
    lex = lexicon_sentiment(text)
    if lex:
        return lex

    import torch
    analyzer = _get_sentiment_pipeline()
    with torch.no_grad():
        try:
            scores = analyzer(text, truncation=True, max_length=512, top_k=None)
        except TypeError:
            # Older transformers versions use return_all_scores instead of top_k
            scores = analyzer(text, truncation=True, max_length=512, return_all_scores=True)

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


def classify_topic(text, office_hint=None):
    """
    office_hint: optional free-text string (e.g. "Accounting Office" or a
    cluster name) describing which office/service the comment's survey was
    submitted for. Used only as a small additive nudge on stage 1 — see
    topic_common.office_hint_topics's docstring for why it stays soft.

    Tried making the zero-shot model the primary decision-maker (2026-08-24)
    with a confidence gate deferring to the keyword lexicon only when the AI
    was unsure — measured regression from 114/117 to 103/117 on the topic
    test suite. Diagnosed why: dumped the model's raw per-label scores and
    found it landed similar confidence (~0.35-0.49) on both correct AND
    incorrect top picks for this ~15-way classification, so no threshold can
    cleanly separate the two — set it low enough to accept good answers and
    you also accept bad ones at the same confidence; set it high enough to
    reject bad ones and you reject most good ones too, which just pushes
    almost everything to the lexicon anyway. Reverted to lexicon-first.
    """
    import torch
    # Keyword anchors win outright when present (see
    # keyword_topic_override's docstring for why) — this also skips
    # the zero-shot call entirely on a hit, which is a nice speed
    # win since it's the most expensive step in the pipeline.
    override = keyword_topic_override(text)
    if override:
        return override

    modeler = _get_topic_pipeline()

    # Stage 1: broad category. General Feedback is intentionally excluded
    # from the candidates (see GENERAL_FALLBACK_THRESHOLD) so the model is
    # forced to pick its best broad-category match; only a genuinely
    # low-confidence top score demotes it to General Feedback, instead of
    # General Feedback competing directly and winning on vague comments
    # just for being the safe default.
    with torch.no_grad():
        res = modeler(text, broad_label_list, hypothesis_template=HYPOTHESIS_TEMPLATE, multi_label=False)

    hinted = office_hint_topics(office_hint)
    if hinted:
        scores = dict(zip(res['labels'], res['scores']))
        for topic in hinted:
            label = broad_label_list[BROAD_TOPICS.index(topic)] if topic in BROAD_TOPICS else None
            if label in scores:
                scores[label] += OFFICE_HINT_BOOST
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        top_label, top_score = ranked[0]
    else:
        top_label, top_score = res['labels'][0], res['scores'][0]

    if top_score < GENERAL_FALLBACK_THRESHOLD:
        return GENERAL_FEEDBACK
    broad_topic = broad_label_to_topic[top_label]

    # Stage 2: only spend the extra compute narrowing down to a specific
    # subtype when the comment landed on a broad bucket that actually has
    # subtypes (facility / staff groups) — see SUBTOPIC_GROUPS.
    if broad_topic in SUBTOPIC_GROUPS:
        sub_topics, sub_labels = SUBTOPIC_GROUPS[broad_topic]
        sub_label_list = [sub_labels[t] for t in sub_topics]
        sub_label_to_topic = {v: k for k, v in sub_labels.items()}
        with torch.no_grad():
            res2 = modeler(text, sub_label_list, hypothesis_template=HYPOTHESIS_TEMPLATE, multi_label=False)
        top2_label, top2_score = res2['labels'][0], res2['scores'][0]
        if top2_score >= SUBTOPIC_THRESHOLD:
            return sub_label_to_topic[top2_label]
        return BROAD_TO_SPECIFIC_FALLBACK[broad_topic]

    return broad_topic


def analyze(text, office_hint=None):
    """Convenience wrapper: returns (sentiment, topic) for a single comment."""
    return classify_sentiment(text), classify_topic(text, office_hint=office_hint)
