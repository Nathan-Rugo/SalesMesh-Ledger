# SalesMesh ML Risk Engine (Module 2) — Evaluation Report (v1.0.0)

All intervals are 95% cluster-bootstrap CIs (1000 resamples of 106 agent components in the test partition). Thresholds are fixed at s 0.45 / 0.72 and p 0.50 / 0.85 and were never tuned on test. PR-AUC = average precision.

## 1. Floors (directive Section 8)

| Floor | Requirement | Point | 95% CI | Point verdict | CI verdict |
|---|---|---|---|---|---|
| PR-AUC lift over baseline | >= 0.65 | 0.7120 | [0.6840, 0.7351] | PASS | PASS |
| F1 (QUARANTINE) | >= 0.75 | 0.8694 | [0.8519, 0.8854] | PASS | PASS |
| FPR | < 0.50% (target < 0.10%) | 0.13% | [0.07%, 0.21%] | PASS | PASS |
| Layer-1 latency (ms, mean) | < 30.0 (target < 10.0) | 0.1674 | n/a | PASS | N/A |

*CI verdict: PASS = whole CI meets the floor, FAIL = whole CI misses it, INCONCLUSIVE = CI straddles the floor.*

## 2. Data and Split

- Dataset: 85,428 rows, 5,141 fraud rows, 900 fraud events (600 stuffing, 300 chaining).
- Split seed 42: 300 agents in 260 components; 180 dev / 120 test agents. 11 events straddle a time cutoff; 5 validation events (19 rows) that also have rows in train were excluded from validation so the calibrator never sees a training event.

| Partition | Agents | Window | Rows | Fraud rows | Fraud events |
|---|---|---|---|---|---|
| Train | 180 (dev) | <= 2026-01-25 19:39:38.839961212 | 28,365 | 1779 | 313 |
| Validation (calibration) | 180 (dev) | (2026-01-25 19:39:38.839961212, 2026-02-01 12:12:12.383564269] | 7,375 | 433 | 79 |
| Test (unseen agents, out of time) | 120 | > 2026-02-01 12:12:12.383564269 | 10,369 | 675 | 120 |

## 3. Headline Metrics (test partition)

| System | PR-AUC | F1 | Precision | Recall | FPR | Event recall | Brier |
|---|---|---|---|---|---|---|---|
| **Cascade** (PR-AUC on operating score) | 0.8255 [0.8020, 0.8478] | 0.8694 [0.8519, 0.8854] | 0.9760 [0.9587, 0.9882] | 0.7837 [0.7587, 0.8074] | 0.13% [0.07%, 0.21%] | 0.9917 [0.9716, 1.0000] | 0.01627 [0.01101, 0.02122] |
| XGBoost calibrated, standalone (p >= 0.85 on all rows) | 0.8408 [0.8215, 0.8567] | 0.8909 [0.8781, 0.9017] | 0.9804 [0.9668, 0.9903] | 0.8163 [0.7981, 0.8333] | 0.11% [0.06%, 0.18%] | 0.9917 [0.9716, 1.0000] | 0.01293 [0.01077, 0.01495] |
| XGBoost raw, standalone | 0.8664 [0.8486, 0.8806] | 0.8953 [0.8821, 0.9062] | 0.9806 [0.9673, 0.9904] | 0.8237 [0.8054, 0.8403] | 0.11% [0.06%, 0.18%] | 1.0000 [1.0000, 1.0000] | 0.01312 [0.01130, 0.01495] |
| Naive baseline (P99.5 amount ceiling + 24 h count cap) | 0.1135 [0.0846, 0.1504] | 0.0522 [0.0144, 0.0907] | 0.1615 [0.0568, 0.2487] | 0.0311 [0.0083, 0.0573] | 1.12% [0.76%, 1.54%] | 0.0833 [0.0333, 0.1405] | n/a |

- Paired lift over baseline: PR-AUC 0.7120 [0.6840, 0.7351], F1 0.8172 [0.7831, 0.8500], event recall 0.9083 [0.8531, 0.9596].
- Operating-score (cascade) PR-AUC 0.8255 vs standalone calibrated XGBoost PR-AUC 0.8408: the difference is what the Layer-1 routing costs or adds to the ranking.
- Cascade Brier is over Layer-2-adjudicated rows (the cohort p is calibrated for); over all rows it is 0.01293 [0.01077, 0.01495].

## 4. Event-Level and Per-Typology Recall (QUARANTINE)

| Typology | Events | Detected | Event recall (cluster-bootstrap 95% CI) | Exact 95% CI (Clopper–Pearson) | Row recall |
|---|---|---|---|---|---|
| All | 120 | 119 | 0.9917 [0.9716, 1.0000] | [0.9544, 0.9998] | 0.7837 [0.7587, 0.8074] |
| commission_stuffing | 84 | 84 | 1.0000 [1.0000, 1.0000] | [0.9570, 1.0000] | 0.7762 |
| circular_chaining | 36 | 35 | 0.9722 [0.9091, 1.0000] | [0.8547, 0.9993] | 0.7967 |

*The percentile bootstrap collapses to zero width when every event is detected; the exact Clopper–Pearson interval does not.*

Counting REVIEW as a flag as well: event recall 1.0000 (120/120).

## 5. Fast-Clear Leakage (s < 0.45 cleared without Layer 2)

- Fraud rows fast-cleared: 129/675 (19.11%); by typology: commission_stuffing 20.51%, circular_chaining 16.67%.
- Fraud events with EVERY row fast-cleared: 0/120 (0.00%).
- Routing share of test rows: fast-clear 84.81%, Layer 2 15.09%, bypass 0.10%.

## 6. Ablations (same fitted models, decision policy only; point estimates)

| Policy | PR-AUC (operating score) | F1 | Precision | Recall | FPR | FP | Event recall | Layer-2 share |
|---|---|---|---|---|---|---|---|---|
| primary (bypass on, fast-clear on) | 0.8255 | 0.8694 | 0.9760 | 0.7837 | 0.13% | 13 | 0.9917 | 15.09% |
| bypass off | 0.8316 | 0.8708 | 0.9796 | 0.7837 | 0.11% | 11 | 0.9917 | 15.19% |
| no fast-clear | 0.8346 | 0.8894 | 0.9770 | 0.8163 | 0.13% | 13 | 0.9917 | 99.90% |
| no fast-clear, bypass off | 0.8408 | 0.8909 | 0.9804 | 0.8163 | 0.11% | 11 | 0.9917 | 100.00% |
| flag = QUARANTINE or REVIEW | 0.8255 | 0.8703 | 0.9761 | 0.7852 | 0.13% | 13 | 1.0000 | — |

## 7. Training Cohorts and Calibration

- XGBoost cohort: `candidates` — 4,936 rows (1444 fraud), scale_pos_weight = 2.4183.
- Isotonic calibration cohort: `val_candidates` — 1,057 val rows (357 fraud).
- SHAP attributions are in xgboost_log_odds_margin_uncalibrated units.

Reliability on the Layer-2 cohort of the test partition:

| p bin | n | mean p | observed fraud rate |
|---|---|---|---|
| [0.00, 0.10) | 1032 | 0.0208 | 0.0155 |
| [0.10, 0.30) | 0 | n/a | n/a |
| [0.30, 0.50) | 0 | n/a | n/a |
| [0.50, 0.85) | 1 | 0.5353 | 1.0000 |
| [0.85, 1.00] | 532 | 0.9912 | 0.9793 |

Baseline (fitted on train): amount ceiling KES 14,603.72, 24 h count cap 16.00.

## 8. Latency (single row, ms)

- Layer 1 compiled traversal: mean 0.167, p50 0.155, p99 0.399 (sklearn `score_samples`: mean 10.585).
- Full cascade without SHAP: mean 1.108; with top-3 SHAP: mean 2.388, p99 2.912.

## 9. Stability: 5 Repeated Splits

Seeds [42, 43, 44, 45, 46] change which agent components are test agents and the model seeds; time cutoffs are fixed. Test fraud events per repeat: 98–120.

| Metric | Mean | Std | Min | Max |
|---|---|---|---|---|
| pr_auc_operating | 0.8350 | 0.0118 | 0.8202 | 0.8468 |
| pr_auc_xgb_standalone | 0.8401 | 0.0057 | 0.8301 | 0.8441 |
| f1 | 0.8661 | 0.0238 | 0.8321 | 0.8914 |
| precision | 0.9819 | 0.0090 | 0.9755 | 0.9975 |
| recall | 0.7758 | 0.0411 | 0.7138 | 0.8166 |
| fpr | 0.0009 | 0.0005 | 0.0001 | 0.0013 |
| event_recall | 0.9946 | 0.0050 | 0.9903 | 1.0000 |
| pr_auc_lift | 0.7284 | 0.0152 | 0.7120 | 0.7495 |

