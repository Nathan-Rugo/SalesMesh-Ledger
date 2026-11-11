# PaySim Calibration of the Synthetic Backbone (gh-18, ML-05): v1.0.0 → v1.1.0

This report covers the issue's Specific Objective (iv): "baseline volumes and diurnal cycles modelled from PaySim"
(Section 3.2.1.1). Before gh-18 the base traffic used uniform 07:00–21:00 timing and plain Poisson volumes, and no
parameter was fitted to data. Two parts of the backbone are now fitted to the real PaySim1 CSV:
- the hour-of-day cycle;
- the day-to-day volume multiplier.

The model was retrained and shipped as `risk_cascade_v1.1.0`.

## 1. Source and method

- **Data:** PaySim1 (Lopez-Rojas, Elmir & Axelsson, 2016), Kaggle `ealaxi/paysim1`, CC BY-SA 4.0.
  - The local copy `Synthetic_Financial_datasets_log.csv` has 6,362,620 rows and sha256 `16910f90…4eea6b`
    (full hash in the profile).
  - The CSV is not committed.
- **Profiler:** `engine/paysim_profile.py`, run as `python -m engine.paysim_profile <csv> --out data/paysim_profile.json`.
  - It streams the file in 500k-row chunks and reads only `step`, `type` and `amount`.
  - `isFraud` and `isFlaggedFraud` are never read, so they cannot act as labels, features or filters. A test checks
    that flipping `isFraud` leaves the fit unchanged.
- **Rows used:** `type ∈ {PAYMENT, CASH_IN}`, with no other filter: 3,550,779 rows.
- **Step → time:** step *s* covers hours [s−1, s), so hour = (s−1) mod 24 and day = ⌊(s−1)/24⌋.
  - PaySim documents a step as one hour but not the clock time of step 1, so step 1 = 00:00 is an assumption. It is
    supported by the data: the 07:00 → 08:00 jump in the hour weights (0.46% → 4.56%) matches a business day opening.
    A phase shift of an hour or so cannot be ruled out, and it is a known assumption of this fit.
  - The replay loader `load_paysim_as_base_traffic` now uses the same (s−1) offset.
  - Before this change, it was one hour late.
- **Output:** `data/paysim_profile.json`, written with `sort_keys` and `indent=2`. It holds:
  - the hour weights, the busy-day CV and its bootstrap 95% interval;
  - the kept and dropped days, and the sensitivity CVs;
  - the amount quantiles and the row counts;
  - the source sha256, the mapping and the fit date.

**How the generator uses the profile.** `generate_dataset.py` loads the committed profile by default. If the file is
missing, it exits non-zero and does not fall back to uniform timing. The profile then drives
`generate_synthetic_base_traffic(..., profile=...)`:
- **Day multiplier:** each day *d* draws a shared g_d ~ Gamma(shape 1/CV², scale CV²), so the mean is 1 and the CV is the busy-day CV.
- **Volume:** each agent-day count ~ Poisson(6 · g_d).
- **Timing:** each timestamp is an hour drawn from the 24 weights, plus a uniform offset within that hour.
- **Amounts** are unchanged: log-normal, median KES 1,500, σ 0.9.
  - PaySim's PAYMENT + CASH_IN amount quantiles are recorded for reference only: P5 1,385, P25 7,204, median 19,193,
    P75 103,064, P95 318,214 and P99 473,237 (PaySim units).
  - `--currency-scale` (≈ 1500/19190) applies only to the PaySim replay path, which is reference-only and was not run here.
    The 19,190 is the PAYMENT + CASH_IN median, but the replay keeps all four types (CASH_OUT and TRANSFER too), so
    the scale only approximately maps the replayed median to KES 1,500.

## 2. Fitted hour-of-day profile

The weights are pooled over all 31 days and normalised to sum to 1.
- Hours 07:00–20:59 carry 90.9% of the weight.
- The peak is 17:00–19:59 (27.1% of the weight).
- Night (00:00–06:59) carries 1.1% of the weight, and no hour is empty. The late evening (21:00–23:59) still
  carries 8.0%.

| Hour | Rows | Weight |
|---|---|---|
| 00:00 | 19,970 | 0.0056 |
| 01:00 | 6,647 | 0.0019 |
| 02:00 | 1,169 | 0.0003 |
| 03:00 | 703 | 0.0002 |
| 04:00 | 980 | 0.0003 |
| 05:00 | 2,465 | 0.0007 |
| 06:00 | 6,308 | 0.0018 |
| 07:00 | 16,424 | 0.0046 |
| 08:00 | 161,924 | 0.0456 |
| 09:00 | 236,252 | 0.0665 |
| 10:00 | 245,208 | 0.0691 |
| 11:00 | 262,066 | 0.0738 |
| 12:00 | 251,893 | 0.0709 |
| 13:00 | 237,954 | 0.0670 |
| 14:00 | 226,211 | 0.0637 |
| 15:00 | 238,125 | 0.0671 |
| 16:00 | 234,630 | 0.0661 |
| 17:00 | 306,716 | 0.0864 |
| 18:00 | 344,440 | 0.0970 |
| 19:00 | 311,729 | 0.0878 |
| 20:00 | 154,932 | 0.0436 |
| 21:00 | 131,157 | 0.0369 |
| 22:00 | 101,150 | 0.0285 |
| 23:00 | 51,726 | 0.0146 |

## 3. Day totals and the volume multiplier

**Busy-day rule:** keep the days whose PAYMENT + CASH_IN total is at least 0.5 × the largest day's total (318,702 on day 0).
- **Kept:** 14 days (0, 1 and 5–16), at 198,242–318,702 rows each.
- **Dropped:** 17 days (2–4 and 17–30), at 0–32,959 rows each. Day 30 has no PAYMENT or CASH_IN rows.

The near-empty days are a PaySim step-scheduling artifact, not demand, so they are kept out of the volume fit. They
still count in the pooled hour weights.

| Day | Rows | Kept | Day | Rows | Kept |
|---|---|---|---|---|---|
| 0 | 318,702 | yes | 16 | 235,108 | yes |
| 1 | 249,854 | yes | 17 | 12,745 | no |
| 2 | 617 | no | 18 | 7,011 | no |
| 3 | 19,134 | no | 19 | 11,447 | no |
| 4 | 6,920 | no | 20 | 14,373 | no |
| 5 | 242,432 | yes | 21 | 31,386 | no |
| 6 | 231,985 | yes | 22 | 29,813 | no |
| 7 | 249,700 | yes | 23 | 18,739 | no |
| 8 | 234,142 | yes | 24 | 32,959 | no |
| 9 | 218,702 | yes | 25 | 8,317 | no |
| 10 | 233,701 | yes | 26 | 4,826 | no |
| 11 | 198,242 | yes | 27 | 8,841 | no |
| 12 | 237,300 | yes | 28 | 31,115 | no |
| 13 | 222,471 | yes | 29 | 6,101 | no |
| 14 | 224,060 | yes | 30 | 0 | no |
| 15 | 210,036 | yes | | | |

The day-to-day CV is a method-of-moments estimate over the kept-day totals: population std / mean.

| Busy-day threshold | Days kept | CV |
|---|---|---|
| 0.4 × max (sensitivity) | 14 | 0.1132 |
| **0.5 × max (used)** | **14** | **0.1132** |
| 0.6 × max (sensitivity) | 14 | 0.1132 |

The CV does not change anywhere between 0.4 × and 0.6 × the maximum, because no day falls in that band: the totals
jump from 32,959 to 198,242. With CV 0.113, the daily multiplier's central 95% range is 0.79–1.23.

**Uncertainty.** The CV rests on only 14 days. A seeded percentile bootstrap over the kept days (10,000 resamples,
seed 0; `day_multiplier_cv_ci95` in the profile) gives a 95% interval of **[0.041, 0.162]** around the point
estimate 0.113. The interval is wide and skewed, because day 0 (318,702) sits well above the other 13 days.
The generator uses the point estimate; the day-to-day volume variation is fitted only loosely.

## 4. Old vs new metrics

Both runs use the same code, apart from the backbone, and the same commands:
- `generate_dataset.py --seed 42` (300 agents, 45 days, 600 stuffing, 300 chaining over 40 pairs, θ 5000);
- `train.py --seed 42 --n-bootstrap 1000 --stability-repeats 5`.

Both use the pinned `.venv`: Python 3.11.9, scikit-learn 1.6.1, xgboost 2.1.3, numpy 1.26.4 and pandas 2.2.3.

The fraud injectors (θ, k, windows), the split fractions and the thresholds are unchanged. Brackets are 95%
cluster-bootstrap CIs over the test partition's agent components (106 in both runs).

| Dataset / split | v1.0.0 | v1.1.0 |
|---|---|---|
| Rows / fraud rows | 85,428 / 5,141 | 86,528 / 5,146 |
| Dataset sha256 (prefix) | `7b4a0df9b411` | `928fa295b7cd` |
| `t_min` → `t_max` (2026) | 01-01 07:00 → 02-14 21:17 | 01-01 00:03 → 02-14 23:59 |
| Cutoffs (train/val, val/test) | 01-25 19:39, 02-01 12:12 | 01-25 18:01, 02-01 12:00 |
| Fraud events train / val / test | 313 / 79 / 120 | 319 / 72 / 104 |
| Test rows | 10,369 | 10,741 |

| Metric (test partition) | v1.0.0 (uniform 07:00–21:00) | v1.1.0 (PaySim-calibrated) |
|---|---|---|
| PR-AUC lift (cascade − baseline) | 0.7120 [0.6840, 0.7351] | 0.7324 [0.7111, 0.7528] |
| Cascade PR-AUC (operating score) | 0.8255 [0.8020, 0.8478] | 0.8416 [0.8190, 0.8625] |
| Cascade F1 | 0.8694 [0.8519, 0.8854] | 0.8911 [0.8759, 0.9053] |
| Cascade precision | 0.9760 [0.9587, 0.9882] | 0.9878 [0.9768, 0.9966] |
| Cascade recall (rows) | 0.7837 [0.7587, 0.8074] | 0.8117 [0.7883, 0.8340] |
| Cascade FPR | 0.134% [0.066%, 0.214%] | 0.059% [0.019%, 0.108%] |
| Cascade event recall | 0.9917 [0.9716, 1.0000] (119/120) | 0.9904 [0.9692, 1.0000] (103/104) |
| Cascade Brier (Layer-2 cohort) | 0.0163 [0.0110, 0.0212] | 0.0089 [0.0043, 0.0136] |
| Baseline PR-AUC | 0.1135 [0.0846, 0.1504] | 0.1091 [0.0841, 0.1326] |
| Baseline F1 | 0.0522 [0.0144, 0.0907] | 0.0145 [0.0000, 0.0313] |
| Baseline FPR | 1.124% [0.755%, 1.543%] | 0.848% [0.606%, 1.108%] |
| Standalone calibrated XGBoost PR-AUC | 0.8408 [0.8215, 0.8567] | 0.8452 [0.8243, 0.8613] |
| Layer-1 latency (compiled, mean) | 0.17 ms | 0.22 ms |

| Stability (5 splits, seeds 42–46) | v1.0.0 mean ± std | v1.1.0 mean ± std |
|---|---|---|
| PR-AUC (operating score) | 0.8350 ± 0.0118 | 0.8471 ± 0.0154 |
| PR-AUC lift | 0.7284 ± 0.0152 | 0.7396 ± 0.0109 |
| F1 | 0.8661 ± 0.0238 | 0.8891 ± 0.0124 |
| Precision | 0.9819 ± 0.0090 | 0.9903 ± 0.0037 |
| Recall (rows) | 0.7758 ± 0.0411 | 0.8068 ± 0.0204 |
| FPR | 0.094% ± 0.048% | 0.048% ± 0.016% |
| Event recall | 0.9946 ± 0.0050 | 0.9963 ± 0.0051 |

**Directive floors.** Every floor passes at the point estimate and over the whole CI in both versions:
- PR-AUC lift ≥ 0.65;
- F1 ≥ 0.75;
- FPR < 0.5%;
- Layer-1 latency < 30 ms.

In v1.1.0 the point FPR (0.059%) also meets the 0.1% target, which v1.0.0 missed (0.134%). The CI upper bound (0.108%)
still crosses 0.1%. Event recall is unchanged within its CI: exact Clopper–Pearson [0.948, 1.000] in v1.1.0 against
[0.954, 1.000] in v1.0.0.

## 5. Why the comparison is not single-cause

The difference between v1.0.0 and v1.1.0 cannot be attributed to the calibration alone:
- **Fresh draw.** v1.1.0 is a new random draw of the backbone. Changing the timing draws shifts every later draw,
  including the anchor choices, the chain pairs and their timings, so the two datasets are unrelated draws.
- **Moved cutoffs.** The split cutoffs come from `t_min` / `t_max`, and both moved: v1.0.0 started at 07:00 on day 1
  and ended near 21:00, while v1.1.0 covers whole days. The partitions are therefore different, with 104 test events
  instead of 120.
- **Off-hours context changed.** Under v1.0.0 the only rows outside the old 07:00–21:00 window were slow-chain fraud,
  so off-hours activity was a free tell. In v1.1.0, 7,461 benign rows fall outside that window, alongside 579
  circular-chaining and 252 commission-stuffing rows.
  - Timing is therefore a more realistic and harder signal in v1.1.0.
  - No feature uses the hour of day directly, but the inter-transaction gaps (velocity, entropy) change with the
    diurnal shape.

Most metric changes fall inside or near the other version's CI, and the stability means move by about one to two
standard deviations. The finding is that **the PaySim-calibrated backbone does not degrade detection, and every
directive floor still passes with its CI.** The results do not show that calibration improved the model.

## 6. Reproduce

```bash
cd ml-engine
.venv/Scripts/python -m engine.paysim_profile "$TEMP/paysim/Synthetic_Financial_datasets_log.csv" --out data/paysim_profile.json
.venv/Scripts/python generate_dataset.py --seed 42
.venv/Scripts/python train.py --model-version v1.1.0 --seed 42 --n-bootstrap 1000 --stability-repeats 5
```

On the pinned `.venv` on the same platform (Windows, Python 3.11.9, numpy 1.26.4, pandas 2.2.3), the same seed and
profile gave a byte-identical dataset CSV (sha256 `928fa295…dcc22b`) on three runs. Other platforms or library
versions may differ in the last bits of float formatting.
