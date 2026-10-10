# Step 2 Review & Findings — Training Pipeline

**Context:** this covers the `split.py`, `cascade.py`, `baseline.py`, `eval.py`,
and `train.py` modules built before the BMAD session ran out of quota. Rather
than assume they worked, everything below was independently re-run and
checked — the same approach as Step 1 (where that caught the `datetime64[us]`
bug). This file documents what that checking found.

## Overall verdict

The architecture and code quality here were genuinely good going in:
calibration, `scale_pos_weight` tuning on the Layer-1-filtered subset, SHAP
explainability, model versioning, a clean save/load round-trip, chronological
+ agent-grouped splitting, and a 9-test pytest suite were all already
correctly implemented, matching the design decisions from the Step 1 review.
This was a verification-and-refinement pass, not a rescue job. One real bug
was found and fixed, one design tension was resolved into reusable evidence,
and one statistical fragility was mitigated. All three are legitimate
Chapter 5 content — you found them by testing rigorously, which is a stronger
story than a pipeline that just happened to run.

## Finding 1 — a real bug in `evaluate_batch()` (fixed)

The method that produces every reported metric was hard-coding the fraud
probability to exactly `1.0` for any transaction Layer 1's immediate-
quarantine rule fired on, regardless of what the calibrated XGBoost model
actually believed. The single-transaction path (`evaluate_transaction`)
didn't have this bug — only the batch/reporting path did, which is exactly
the kind of inconsistency that's easy to miss by reading code and easy to
catch by running it against a known comparison point.

**Evidence (before vs. after, same dataset, same split):**

| | PR-AUC (Cascade) | PR-AUC (Standalone Calibrated XGBoost) |
|---|---|---|
| Before fix | 0.7597 | 0.8205 |
| After fix | 0.8135 | 0.8135 |

Before the fix, the cascade scored *worse* than the exact same XGBoost model
evaluated on its own — which doesn't make architectural sense, since the
cascade's second stage *is* that XGBoost model. After the fix, the two are
identical, which is what should happen: the probability reported now always
reflects the model's real calibrated belief; only the categorical
QUARANTINE/CLEAR/REVIEW decision reflects the operational shortcuts (Layer 1
bypass, fast-clear). See the inline comments in `cascade.py::evaluate_batch`
for the full explanation.

## Finding 2 — the Layer-1 bypass rule, turned into an ablation

Your thesis (Section 3.5.4) specifies, as written: an Isolation Forest score
≥ 0.72 triggers immediate QUARANTINE, skipping Layer 2 entirely. That's now
implemented as a toggleable policy (`bypass_layer2_on_extreme_anomaly`,
default `True` to match the thesis exactly) instead of a hardcoded behaviour,
so both variants can be compared on **identical trained models** — the
ablation in `eval.py::run_bypass_ablation` fits nothing twice; it just
re-evaluates the same fitted pipeline under both policies.

**Result, post bug-fix (clean now that the probability bug above is gone):**

| Policy | PR-AUC | False Positives | Recall |
|---|---|---|---|
| Bypass enabled (thesis as written) | 0.8135 | 1 | 0.7500 |
| Bypass disabled (Layer 2 always adjudicates) | 0.8135 | 0 | 0.7500 |

Identical discriminative power either way; the bypass rule costs exactly one
false positive on this test partition for zero recall gain. Separately, on
the full training set, the 0.72 threshold only ever catches about 4.5% of
injected fraud outright — it's an extremely selective rule (fires on ~0.08%
of all transactions).

**Suggested framing for Chapter 5:** you implemented the literal
specification as the default operational policy, and additionally ran a
controlled ablation — identical trained models, decision policy only — to
quantify its effect. On this test partition, the bypass rule trades one
additional false positive for faster decision latency on the rarest, most
extreme anomalies, with no measurable change in overall discriminative
power. That's a real, specific, defensible finding, not a hand-wave.

## Finding 3 — small test-set fragility (mitigated, not eliminated)

The primary split's test set has 8 fraud examples. Metrics computed from 8
positives are noisy: one flipped prediction moves recall by 12.5 points. A
`repeated_split_evaluation()` utility (`stability.py`) now re-runs the full
split → fit → evaluate cycle across 5 agent-shuffle seeds (chronological
cutoffs stay fixed; only which agents land in train/val/test changes):

| Metric | Mean | Std | Range |
|---|---|---|---|
| PR-AUC | 0.7872 | 0.0703 | 0.6583 – 0.8721 |
| F1 | 0.7790 | 0.0560 | 0.6875 – 0.8421 |

Test-set fraud count ranged **8 to 29** across the 5 repeats. The primary
split's 8 frauds is near the low end of that range, and its PR-AUC (0.8135)
sits inside the observed spread — so it's a real, legitimate number, but it
is one draw from a distribution with a std of 0.07, not a precise fixed
quantity. Report it alongside the range, not instead of it.

This is a direct instance of what your own ML-fundamentals course material
says about limited-data evaluation (cross-validation, Lesson 6/8): don't
trust a single held-out number when the positive class is this sparse. Each
repeat here is a full independent train/val/test cycle with a freshly
trained model, so this is defensible as a lightweight repeated-holdout /
cross-validation argument in Chapter 3 or 5, if you want to use that
language.

**If you want a tighter interval later:** regenerate a larger dataset at the
same ~1.3% fraud rate (more agents/days, proportionally more injected
sequences) so each split retains more fraud examples — `generate_dataset.py`
already supports this via `--n-agents`/`--n-days`. Don't just increase the
fraud *density* without also scaling the traffic, or you'll quietly drift
away from the realistic rare-event framing that's central to your problem
statement.

## Smaller things also fixed while in here

- **`split.py`**: a `UserWarning` about shuffling a pandas `StringArray` with
  `numpy.random.RandomState.shuffle` (not guaranteed safe — risk of silent
  duplication). Fixed by converting to a plain list before shuffling. The
  disjointness tests passed before and after, but the warning indicated a
  real reliability risk on other pandas/numpy version combinations, not just
  noise.
- **`cascade.py`**: `datetime.utcnow()` is deprecated in current Python;
  switched to the timezone-aware equivalent.
- **`requirements.txt`**: pinned to the exact versions used to produce the
  verified results here (pandas 3.0.2, numpy 2.4.4, scikit-learn 1.8.0,
  xgboost 3.4.1, shap 0.52.0). The artifact handed off before this review was
  trained under scikit-learn 1.6.1 and raised version-mismatch warnings when
  loaded here — not a functional failure, but worth keeping your training
  and deployment environments pinned together, and worth a line in your
  Chapter 5 reproducibility notes either way.
- **File structure**: removed root-level duplicates of `base_traffic.py`,
  `features.py`, and `fraud_injector.py` (confirmed byte-identical to the
  copies inside `ml_engine/` before deleting — nothing was lost), removed
  `test_dataset_100.csv` (a leftover dev artifact with a 5.7% fraud rate,
  inconsistent with the realistic ~1.3% rate used everywhere else), and
  removed `__pycache__`/`.pytest_cache` build artifacts that shouldn't ship.

## Current state

- **17/17 tests pass** (8 from Step 1, 9 from Step 2), zero warnings, clean
  run in ~6 seconds.
- **Full training run** (data load → split → fit → evaluate → ablation →
  5-repeat stability check → save artifacts) completes in under a minute.
- Model artifact, evaluation report, and metrics JSON are all freshly
  regenerated and consistent with each other and with this document.

## What's next: Step 3

The FastAPI microservice skeleton — `POST /evaluate`, loading
`RiskCascadePipeline.load()`, returning `isolation_score`, `xgb_probability`,
`model_version`, `decision`, and `top_shap_features` in the shape the Node.js
gateway contract expects, plus the fail-safe QUARANTINE-on-timeout behaviour
from the original Module 2 review. Say the word and we'll build it on top of
this verified pipeline.
