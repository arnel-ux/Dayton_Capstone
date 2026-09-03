"""
Regression check against the project's EXISTING test_accuracy.py CASES list,
but using ONLY the pure lexicon functions (tc.lexicon_sentiment /
tc.keyword_topic_override) — never heavy_model, never Gemini/the
transformer. This deliberately avoids spending real API quota; it only
proves my lexicon changes didn't regress any case that was already resolved
by the lexicon before this change (the "lexicon-hit" bucket, which
test_accuracy.py's own docstring says should stay ~100% regardless of any
AI-side change).

Run: python test_regression_lexicon_only.py
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("test_accuracy_cases", "test_accuracy.py")
# We only need the CASES list, not to execute run()/hm-dependent code — but
# module-level code in test_accuracy.py runs on import regardless, and it
# only defines functions/imports at module level (no auto-run outside
# __main__), so this is safe.
mod = importlib.util.module_from_spec(spec)
sys.modules["test_accuracy_cases"] = mod
spec.loader.exec_module(mod)

import topic_common as tc

failures = []
skipped_lexicon_miss = 0
checked = 0

for text, expected_sent, expected_topic, office_hint in mod.CASES:
    lex_sent = tc.lexicon_sentiment(text)
    lex_topic = tc.keyword_topic_override(text)

    if lex_sent is not None:
        checked += 1
        if lex_sent != expected_sent:
            failures.append(("SENTIMENT", text, expected_sent, lex_sent))
    if lex_topic is not None:
        checked += 1
        if lex_topic != expected_topic:
            failures.append(("TOPIC", text, expected_topic, lex_topic))
    if lex_sent is None and lex_topic is None:
        skipped_lexicon_miss += 1

print(f"Checked {checked} lexicon-resolved assertions from {len(mod.CASES)} existing cases "
      f"({skipped_lexicon_miss} cases have zero lexicon coverage on both axes — skipped, those need the AI model).")

if failures:
    print(f"\n--- REGRESSIONS ({len(failures)}) ---")
    for kind, text, expected, got in failures:
        print(f"  [{kind}] expected={expected!r} got={got!r}\n    text={text!r}")
    sys.exit(1)
else:
    print("No regressions in existing lexicon-covered cases.")
    sys.exit(0)
