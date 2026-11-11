# SalesMesh ML Risk Engine (Module 2) — Evaluation Report (v1.1.0)

All intervals are 95% cluster-bootstrap CIs (1000 resamples of 106 agent components in the test partition). Thresholds are fixed at s 0.45 / 0.72 and p 0.50 / 0.85 and were never tuned on test. PR-AUC = average precision.

## 1. Floors (directive Section 8)

| Floor | Requirement | Point | 95% CI | Point verdict | CI verdict |
|---|---|---|---|---|---|
| PR-AUC lift over baseline | >= 0.65 | 0.7324 | [0.7111, 0.7528] | PASS | PASS |
| F1 (QUARANTINE) | >= 0.75 | 0.8911 | [0.8759, 0.9053] | PASS | PASS |
| FPR | < 0.50% (target < 0.10%) | 0.06% | [0.02%, 0.11%] | PASS | PASS |
| Layer-1 latency (ms, mean) | < 30.0 (target < 10.0) | 0.2168 | n/a | PASS | N/A |

*CI verdict: PASS = whole CI meets the floor, FAIL = whole CI misses it, INCONCLUSIVE = CI straddles the floor.*

## 2. Data and Split

- Dataset: 86,528 rows, 5,146 fraud rows, 900 fraud events (600 stuffing, 300 chaining).
- Split seed 42: 300 agents in 260 components; 180 dev / 120 test agents. 5 events straddle a time cutoff; 1 validation events (4 rows) that also have rows in train were excluded from validation so the calibrator never sees a training event.

| Partition | Agents | Window | Rows | Fraud rows | Fraud events |
|---|---|---|---|---|---|
| Train | 180 (dev) | <= 2026-01-25 18:01:09.118094250 | 28,476 | 1817 | 319 |
| Validation (calibration) | 180 (dev) | (2026-01-25 18:01:09.118094250, 2026-02-01 12:00:37.249801500] | 7,488 | 405 | 72 |
| Test (unseen agents, out of time) | 120 | > 2026-02-01 12:00:37.249801500 | 10,741 | 600 | 104 |

## 3. Headline Metrics (test partition)

| System | PR-AUC | F1 | Precision | Recall | FPR | Event recall | Brier |
|---|---|---|---|---|---|---|---|
| **Cascade** (PR-AUC on operating score) | 0.8416 [0.8190, 0.8625] | 0.8911 [0.8759, 0.9053] | 0.9878 [0.9768, 0.9966] | 0.8117 [0.7883, 0.8340] | 0.06% [0.02%, 0.11%] | 0.9904 [0.9692, 1.0000] | 0.00886 [0.00428, 0.01363] |
| XGBoost calibrated, standalone (p >= 0.85 on all rows) | 0.8452 [0.8243, 0.8613] | 0.9009 [0.8873, 0.9126] | 0.9804 [0.9661, 0.9913] | 0.8333 [0.8155, 0.8499] | 0.10% [0.04%, 0.16%] | 1.0000 [1.0000, 1.0000] | 0.01004 [0.00801, 0.01196] |
| XGBoost raw, standalone | 0.8628 [0.8437, 0.8771] | 0.8999 [0.8863, 0.9118] | 0.9804 [0.9661, 0.9913] | 0.8317 [0.8129, 0.8485] | 0.10% [0.04%, 0.16%] | 1.0000 [1.0000, 1.0000] | 0.01099 [0.00906, 0.01287] |
| Naive baseline (P99.5 amount ceiling + 24 h count cap) | 0.1091 [0.0841, 0.1326] | 0.0145 [0.0000, 0.0313] | 0.0549 [0.0000, 0.1038] | 0.0083 [0.0000, 0.0187] | 0.85% [0.61%, 1.11%] | 0.0288 [0.0000, 0.0629] | n/a |

- Paired lift over baseline: PR-AUC 0.7324 [0.7111, 0.7528], F1 0.8767 [0.8574, 0.8960], event recall 0.9615 [0.9286, 0.9911].
- Operating-score (cascade) PR-AUC 0.8416 vs standalone calibrated XGBoost PR-AUC 0.8452: the difference is what the Layer-1 routing costs or adds to the ranking.
- Cascade Brier is over Layer-2-adjudicated rows (the cohort p is calibrated for); over all rows it is 0.01004 [0.00801, 0.01196].

## 4. Event-Level and Per-Typology Recall (QUARANTINE)

| Typology | Events | Detected | Event recall (cluster-bootstrap 95% CI) | Exact 95% CI (Clopper–Pearson) | Row recall |
|---|---|---|---|---|---|
| All | 104 | 103 | 0.9904 [0.9692, 1.0000] | [0.9476, 0.9998] | 0.8117 [0.7883, 0.8340] |
| commission_stuffing | 67 | 67 | 1.0000 [1.0000, 1.0000] | [0.9464, 1.0000] | 0.7929 |
| circular_chaining | 37 | 36 | 0.9730 [0.9117, 1.0000] | [0.8584, 0.9993] | 0.8359 |

*The percentile bootstrap collapses to zero width when every event is detected; the exact Clopper–Pearson interval does not.*

Counting REVIEW as a flag as well: event recall 0.9904 (103/104).

## 5. Fast-Clear Leakage (s < 0.45 cleared without Layer 2)

- Fraud rows fast-cleared: 103/600 (17.17%); by typology: commission_stuffing 19.82%, circular_chaining 13.74%.
- Fraud events with EVERY row fast-cleared: 0/104 (0.00%).
- Routing share of test rows: fast-clear 84.21%, Layer 2 15.69%, bypass 0.10%.

## 6. Ablations (same fitted models, decision policy only; point estimates)

| Policy | PR-AUC (operating score) | F1 | Precision | Recall | FPR | FP | Event recall | Layer-2 share |
|---|---|---|---|---|---|---|---|---|
| primary (bypass on, fast-clear on) | 0.8416 | 0.8911 | 0.9878 | 0.8117 | 0.06% | 6 | 0.9904 | 15.69% |
| bypass off | 0.8414 | 0.8911 | 0.9878 | 0.8117 | 0.06% | 6 | 0.9904 | 15.79% |
| no fast-clear | 0.8455 | 0.9009 | 0.9804 | 0.8333 | 0.10% | 10 | 1.0000 | 99.90% |
| no fast-clear, bypass off | 0.8452 | 0.9009 | 0.9804 | 0.8333 | 0.10% | 10 | 1.0000 | 100.00% |
| flag = QUARANTINE or REVIEW | 0.8416 | 0.8921 | 0.9879 | 0.8133 | 0.06% | 6 | 0.9904 | — |

## 7. Training Cohorts and Calibration

- XGBoost cohort: `candidates` — 5,193 rows (1502 fraud), scale_pos_weight = 2.4574.
- Isotonic calibration cohort: `val_candidates` — 1,141 val rows (332 fraud).
- SHAP attributions are in xgboost_log_odds_margin_uncalibrated units.

Reliability on the Layer-2 cohort of the test partition:

| p bin | n | mean p | observed fraud rate |
|---|---|---|---|
| [0.00, 0.10) | 1189 | 0.0040 | 0.0076 |
| [0.10, 0.30) | 13 | 0.1250 | 0.0000 |
| [0.30, 0.50) | 0 | n/a | n/a |
| [0.50, 0.85) | 1 | 0.7474 | 1.0000 |
| [0.85, 1.00] | 482 | 0.9919 | 0.9876 |

Baseline (fitted on train): amount ceiling KES 14,845.30, 24 h count cap 17.00.

## 8. Latency (single row, ms)

- Layer 1 compiled traversal: mean 0.217, p50 0.161, p99 0.531 (sklearn `score_samples`: mean 18.978).
- Full cascade without SHAP: mean 1.868; with top-3 SHAP: mean 3.387, p99 5.576.

## 9. Stability: 5 Repeated Splits

Seeds [42, 43, 44, 45, 46] change which agent components are test agents and the model seeds; time cutoffs are fixed. Test fraud events per repeat: 95–113.

| Metric | Mean | Std | Min | Max |
|---|---|---|---|---|
| pr_auc_operating | 0.8471 | 0.0154 | 0.8275 | 0.8700 |
| pr_auc_xgb_standalone | 0.8557 | 0.0104 | 0.8446 | 0.8672 |
| f1 | 0.8891 | 0.0124 | 0.8765 | 0.9092 |
| precision | 0.9903 | 0.0037 | 0.9868 | 0.9961 |
| recall | 0.8068 | 0.0204 | 0.7868 | 0.8397 |
| fpr | 0.0005 | 0.0002 | 0.0002 | 0.0006 |
| event_recall | 0.9963 | 0.0051 | 0.9904 | 1.0000 |
| pr_auc_lift | 0.7396 | 0.0109 | 0.7308 | 0.7562 |

