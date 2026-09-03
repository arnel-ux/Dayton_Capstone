"""
Lexicon accuracy test suite (fast/offline path only — no models loaded).
Run: python test_lexicon_accuracy.py
"""
import sys
from topic_common import fast_topic, fast_sentiment, is_no_feedback

CASES = [
    # (comment, expected_topic_substring or None, expected_sentiment or None)
    ("antagal ng transaction", "Transaction Speed", "Negative"),
    ("hindi maayos yung pag accommodate ng staffs", "Courtesy and Attitude - Accommodation/Assistance", "Negative"),
    ("Mainit sa office", "Aircon and Cooling", "Negative"),
    # 2026-09 semantic-audit change: appearance ("kaaya-aya" family) no
    # longer implies Cleanliness — see topic_common.py's Cleanliness/
    # Facilities and Equipment comments. No dirt/smell/mess word is present
    # in this sentence at all, so it must NOT resolve to Cleanliness.
    ("Di kaayang ayang tignan ang office", "Facilities and Equipment - Appearance/Presentation", "Negative"),
    ("Napaka baho ng cr sa office", "Cleanliness - Restroom/CR", "Negative"),
    ("Madumi ang laboratory", "Cleanliness - Laboratory", "Negative"),
    ("Malinis ang CR", "Cleanliness - Restroom/CR", "Positive"),
    ("Mabilis ang transaction", "Transaction Speed", "Positive"),
    ("Mabait at accommodating yung staff", "Courtesy and Attitude", "Positive"),
    ("hindi malinis ang office", "Cleanliness - Office", "Negative"),
    ("sobrang init sa laboratory", "Aircon and Cooling", "Negative"),
    ("Pumunta ako sa registrar para kumuha ng document", None, "Neutral"),
    # Extra self-generated cases
    ("Ambaho naman ng restroom.", "Cleanliness", "Negative"),
    ("Marumi yung CR.", "Cleanliness - Restroom/CR", "Negative"),
    ("Ang init sa registrar office.", "Aircon and Cooling", "Negative"),
    ("Sobrang bagal ng processing.", "Transaction Speed", "Negative"),
    ("Hindi inaasikaso ng staff.", "Courtesy and Attitude - Accommodation/Assistance", "Negative"),
    ("Hindi helpful yung employee.", "Courtesy and Attitude", "Negative"),
    ("Napakalinis ng laboratory.", "Cleanliness - Laboratory", "Positive"),
    ("Mabilis yung transaction.", "Transaction Speed", "Positive"),
    ("maayos", None, "Positive"),
    ("hindi maayos", None, "Negative"),
    ("malinis", "Cleanliness", "Positive"),
    ("hindi malinis", "Cleanliness", "Negative"),
    ("maganda", None, "Positive"),
    ("hindi maganda", None, "Negative"),
    ("helpful", None, "Positive"),
    ("not helpful", "Courtesy and Attitude - Accommodation/Assistance", "Negative"),
    ("accommodating", "Courtesy and Attitude", "Positive"),
    ("not accommodating", "Courtesy and Attitude", "Negative"),
    ("rude staff", "Courtesy and Attitude", "Negative"),
    ("dirty restroom", "Cleanliness", "Negative"),
    ("poor ventilation", "Aircon and Cooling", "Negative"),
    ("magandang office", None, "Positive"),
    ("comfortable", None, None),  # no coverage expected — not asserted

    # --- 2026-09 semantic-audit cases: issue vs. location conflicts ---
    ("Napakabaho ng cr sa office", "Cleanliness - Restroom/CR", "Negative"),
    ("Madumi ang office", "Cleanliness - Office", "Negative"),
    ("Malinis ang laboratory", "Cleanliness - Laboratory", "Positive"),
    ("Mainit sa office", "Aircon and Cooling", "Negative"),
    ("Mainit sa laboratory", "Aircon and Cooling", "Negative"),
    ("Sira ang aircon sa office", "Aircon and Cooling", "Negative"),
    ("Di kaaya ayang tignan ang office", "Facilities and Equipment - Appearance/Presentation", "Negative"),
    # CRITICAL: "pangit" must NOT be read as Cleanliness on its own. Topic
    # here resolves to Cleanliness because "malinis" (real hygiene evidence)
    # is also present and wins the topic tie-break by dict order — not
    # because "pangit" was misclassified. Sentiment ties (one negative
    # appearance word, one positive cleanliness word) resolve to Neutral,
    # same convention as every other mixed-polarity comment in this file.
    ("Pangit pero malinis ang office", "Cleanliness", "Neutral"),
    # Confirms Appearance and Cleanliness are scored independently, not as
    # synonyms: "maganda" carries no topic weight (see topic_common.py), so
    # the only topic signal here is "madumi" -> Cleanliness.
    ("Maganda pero madumi ang office", "Cleanliness", "Neutral"),

    # --- negation around the new appearance/accommodation vocabulary ---
    ("malinis ang office", "Cleanliness - Office", "Positive"),
    ("hindi malinis ang office", "Cleanliness - Office", "Negative"),
    ("kaaya-ayang tignan ang office", "Facilities and Equipment - Appearance/Presentation", "Positive"),
    ("hindi kaaya-ayang tignan ang office", "Facilities and Equipment - Appearance/Presentation", "Negative"),
    ("maayos ang accommodation ng staff", "Courtesy and Attitude - Accommodation/Assistance", "Positive"),
    ("hindi maayos ang accommodation ng staff", "Courtesy and Attitude - Accommodation/Assistance", "Negative"),
]

NO_FEEDBACK_CASES = [
    "", " ", "N/A", "n/a", "NA", "na", "N.A.", "none", "None", "NONE",
    "nil", "Nil", "no comment", "No Comment", "no comments",
    "not applicable", "Not Applicable", "-", "--", "...",
]

failures = 0
total = 0

print("=== Topic/Sentiment cases ===")
for comment, exp_topic, exp_sentiment in CASES:
    total += 1
    topic = fast_topic(comment)
    sentiment = fast_sentiment(comment)
    ok = True
    if exp_topic is not None and exp_topic not in topic:
        ok = False
    if exp_sentiment is not None and sentiment != exp_sentiment:
        ok = False
    status = "PASS" if ok else "FAIL"
    if not ok:
        failures += 1
    print(f"[{status}] {comment!r:55s} -> topic={topic!r:55s} sentiment={sentiment!r} (expected topic~={exp_topic!r}, sentiment={exp_sentiment!r})")

print("\n=== No-feedback detection ===")
for val in NO_FEEDBACK_CASES:
    total += 1
    ok = is_no_feedback(val)
    status = "PASS" if ok else "FAIL"
    if not ok:
        failures += 1
    print(f"[{status}] {val!r:15s} -> is_no_feedback={ok}")

# Sanity: a real comment must NOT be flagged as no-feedback
total += 1
if is_no_feedback("Mabilis ang transaction"):
    failures += 1
    print("[FAIL] real comment incorrectly flagged as no-feedback")
else:
    print("[PASS] real comment correctly NOT flagged as no-feedback")

print(f"\n{total - failures}/{total} passed")
sys.exit(1 if failures else 0)
