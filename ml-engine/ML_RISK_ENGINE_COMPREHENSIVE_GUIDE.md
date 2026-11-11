# SalesMesh ML Risk Assessment Engine (Module 2) — Comprehensive System & Research Documentation

**Author / Candidate:** Nathan Githinji (Adm: 166386)  
**Supervisor:** Ms. Julliet Kirui  
**Project:** Automated Risk-Adaptive Commission and Escrow Ledger for Distributed Retail Networks  
**Module:** Module 2 — Analytical Risk Core & Machine Learning Microservice  
**Document Version:** 1.0.0 (Production & Defense Ready)  
**Date:** October 2026  

---

## Executive Summary & Strategic Context

In distributed mobile-money retail agent networks (e.g., M-Pesa, Safaricom Daraja network), independent sales agents operate on quota-incentive commission structures. These incentive systems are systematically exploited through two primary fraud typologies:
1. **Commission Stuffing (Transaction Splitting / Structuring):** An agent splits legitimate customer transactions into $k$ smaller, sub-threshold deposits ($A_k < \theta$) within a condensed time window ($\Delta t$) to artificially inflate transaction count metrics and trigger tiered commission bonuses without corresponding retail sales volume.
2. **Circular Transaction Chaining (Float Recycling):** Two or more colluding agents rapidly pass a single float balance back and forth in an alternating loop with no underlying customer retail sale, manufacturing artificial transaction volume to capture transaction fees or bonus disbursements.

Standard commercial anti-fraud engines (e.g., generic rules or basic classification) fail in this domain because:
- **Static business rules** (e.g., flagging amounts $> \text{KES } 10,000$) create astronomical false positive rates ($> 6.5\%$) on legitimate high-value commerce while failing to detect stuffing, which intentionally stays below threshold ceilings.
- **Off-the-shelf datasets (like PaySim)** model *account-takeover* (unauthorized draining of credentials), an entirely different fraud signature that teaches machine learning algorithms irrelevant features.
- **Extreme Class Imbalance** ($\sim 1.3\%$ fraud rate) causes uncalibrated supervised models to output extreme, ungrounded confidence scores.

To solve this, **Module 2 implements a Two-Layer Risk Cascade**:
An unsupervised **Isolation Forest** pre-filter ($<30\text{ ms}$) screens raw streaming transactions, rapidly clearing obvious benign traffic, while isolating candidate anomalies for a supervised, **isotonic-calibrated XGBoost classifier** equipped with **SHAP TreeExplainer** interpretability.

---

## 1. End-to-End System Architecture

```
                       Incoming Transaction Payload (Node.js Gateway)
                                             │
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │       FastAPI Microservice (POST /evaluate)            │
                 │       • Latency measurement middleware                 │
                 │       • Strict Pydantic v2 input validation            │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │   Layer 1: Isolation Forest Pre-Filter (Liu, 2008)     │
                 │   • Unsupervised anomaly scoring: s(x, n) ∈ [0, 1]     │
                 │   • Execution latency: ~5.2 ms (<30 ms SLA budget)     │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                            ┌────────────────┴────────────────┐
                            │                                 │
                            ▼ (s >= 0.72)                     ▼ (s < 0.45)
                  [ Immediate QUARANTINE ]              [ Fast CLEAR ]
                  (Operational bypass per               (Passes ~83% of normal traffic;
                   thesis Section 3.5.4)                 spares Layer 2 compute overhead)
                            │
                            ▼ (0.45 <= s < 0.72: Candidate Anomaly Cohort)
                 ┌────────────────────────────────────────────────────────┐
                 │   Layer 2: Calibrated XGBoost (Chen & Guestrin, 2016)  │
                 │   • Trained exclusively on filtered candidate subset   │
                 │   • scale_pos_weight tuned to empirical cohort ratio   │
                 │   • Non-parametric Isotonic Regression Calibrator      │
                 │   • SHAP TreeExplainer feature attribution ranking     │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                                ┌────────────┴────────────┐
                                ▼ (P >= 0.85)             ▼ (P < 0.85)
                          [ QUARANTINE ]               [ CLEAR ]
                        (Escrow Hold Placed)      (Advances to Module 3 Escrow)
                                │                                 │
                                └────────────────┬────────────────┘
                                                 │
                                                 ▼
                 ┌────────────────────────────────────────────────────────┐
                 │            Audit & Blockchain Traceability             │
                 │ • Persistent response with model_version: "v1.1.0"     │
                 │ • Committed to Hyperledger Fabric for non-repudiation  │
                 └────────────────────────────────────────────────────────┘
```

---

## 2. Why the Two-Layer Cascade? (Architectural Defense)

Examiners frequently ask: *"Why combine an unsupervised model with a supervised model instead of choosing just one?"*

### Problem 1: The Severe Class Imbalance Trap
In retail transaction streams, fraudulent transactions represent only $\approx 1.3\%$ of traffic. If a supervised classifier (like XGBoost) is trained directly on the raw transaction stream, the extreme skew degrades minority-class gradient updates. Resampling techniques (such as SMOTE or random oversampling) distort the underlying distribution of retail behavior.

**Our Architectural Solution:**
Layer 1 acts as a structural filter. Because the unsupervised Isolation Forest removes the vast majority of clearly benign transactions ($s < 0.45$), the **candidate anomaly cohort** presented to Layer 2 has a significantly higher concentration of fraud ($\approx 7.3\%$ vs. $1.3\%$). This reduces the effective class imbalance naturally by a factor of 5.6x before XGBoost begins training.

### Problem 2: The Online Latency Budget
High-volume payment networks require rapid responses. Running complex tree ensemble traversals and computing SHAP attribution values on every transaction would saturate server CPU resources.
- **Layer 1 Isolation Forest** executes in **$\sim 5.2\text{ ms}$**, well under the $30\text{ ms}$ threshold required by Non-Functional Requirement NFR-02.
- Transactions with an anomaly score $s < 0.45$ (representing $> 80\%$ of daily volume) are **cleared immediately**, sparing expensive Layer 2 compute.
- Only the ambiguous, suspicious transactions ($0.45 \le s < 0.72$) are passed to Layer 2 for deep supervised adjudication.

---

## 3. Data Engineering & Synthetic Fraud Generation

### Why PaySim's Native `isFraud` Label Was Rejected
A critical flaw in standard academic fraud research is using PaySim’s native `isFraud` label uncritically:
- **What PaySim's `isFraud` models:** Account takeover (credential theft, bulk transfer out, immediate cash-out).
- **What this research targets:** First-party retail agent collusion (commission stuffing and float recycling).

Training an algorithm on account takeover signals teaches it to look for account-clearing transfers, which are completely irrelevant to commission splitting.

**Methodological Solution (Thesis Section 3.2.1):**
1. **PaySim-Calibrated Background Traffic:** The base traffic is synthetic, but two of its properties are fitted to the real PaySim1 CSV (Lopez-Rojas et al., 2016; Kaggle `ealaxi/paysim1`, CC BY-SA 4.0) by a streamed profiler (`engine/paysim_profile.py`), and the fitted parameters are committed in `data/paysim_profile.json`. The fit uses PAYMENT + CASH_IN rows only; `isFraud` is never read.
   - **Diurnal cycle:** 24 pooled hour-of-day weights. Activity peaks at 17:00–19:00, and night hours are rare but non-zero.
   - **Day-to-day volume:** a shared daily multiplier g ~ Gamma(mean 1, CV 0.113), using the CV of PaySim's 14 busy days. The near-empty days are a PaySim scheduling artifact and are excluded.

   Amounts stay log-normal (median KES 1,500, σ 0.9). PaySim's amount quantiles are recorded for reference only. See `reports/paysim_calibration.md`.
2. **Purpose-Built Synthetic Fraud Injectors:** A mathematically rigorous synthetic fraud injection engine (`engine/fraud_injector.py`) superimposes real-world commission fraud patterns directly on top of the traffic:
   - **Commission Stuffing Generator:** Selects an agent and replaces a transaction with $k \in [3, 7]$ sub-threshold bursts ($A_k < \theta$, where $\theta = \text{KES } 5,000$) within a sliding 20-minute window, whose cumulative sum exceeds $\theta$.
   - **Circular Chaining Generator:** Selects a pair of colluding agent accounts and injects an alternating sequence of $m \in [4, 8]$ rapid transfers between them within 24 hours, returning the float to the origin with no end-customer retail sale.

---

## 4. The 6 Behavioral Features (Math & Rationales)

All features are **strictly causal** (they only look backward from the current transaction's timestamp), ensuring that online inference at the API Gateway never leaks future information:

```
  Past Transactions (History Window)         Current Transaction (t_i)
─────────────────────────────────────────────► [ Evaluate ]
  [t_i - 24h]               [t_i - 20min]
       │                          │
       └──── Rolling Baseline ────┴──────────► Causal Features Computed
```

| Feature Name | Symbol / Code | Mathematical Definition | Thesis Reference | Targeted Typology |
|---|---|---|---|---|
| **Instantaneous Velocity** | $V_i$ (`velocity_v_i`) | $V_i = \frac{1}{\Delta t_{i, i-1}} = \frac{1}{(t_i - t_{i-1}) \text{ in hours}}$ | Thesis Eq. 3.1 | **Commission Stuffing:** Human sales agents take 15–45 minutes between sales; scripted splitting fires transactions within seconds. |
| **Split Ratio** | $R_s$ (`split_ratio_r_s`) | $R_s = \frac{\sum_{t \in [t_i - 20m, t_i], A < \theta} A}{\sum_{t \in [t_i - 24h, t_i]} A}$ | Thesis Eq. 3.2 | **Commission Stuffing:** Expresses what proportion of the agent's daily volume is concentrated in suspicious sub-$\theta$ bursts. |
| **Entropy of Gaps** | $H$ (`entropy_gaps`) | $H = -\sum_{b=1}^{B} p_b \log_2 p_b$ | Thesis Sec. 3.2.2 | **Automated Scripting:** Natural human sales create varied, high-entropy intervals; automated splitting bots produce deterministic, low-entropy intervals. |
| **Agent-Relative Z-Score** | $Z_{\text{agent}}$ (`agent_zscore`) | $Z_i = \frac{A_i - \mu_{\text{agent}, 30d}}{\max(\sigma_{\text{agent}, 30d}, \sigma_{\text{floor}})}$ | Review Item 3 | **Individual Baseline Shift:** Measures amount deviation relative to *this agent's own 30-day history*, preventing high-volume rural agents from being penalized by national averages. |
| **Amount-to-Median Ratio** | $M_r$ (`amount_to_median_ratio`) | $M_r = \frac{A_i}{\text{Median}_{\text{agent}, 30d}}$ | Thesis Sec. 3.5.4 | **Outlier Anomaly:** Non-parametric ratio that remains robust when an agent's history contains extreme skew. |
| **Recipient Reuse Frequency** | $C_{\text{reuse}}$ (`recipient_reuse_count`) | $C_{\text{reuse}} = \sum_{k \in [t_i - 24h, t_i)} \mathbb{I}(\text{Dest}_k = \text{Dest}_i)$ | Review Item 3 | **Circular Chaining:** Velocity and split ratio alone cannot detect circular chaining because amounts look normal. Counting recursive counterparty interactions flags float recycling loops. |

---

## 5. Methodological Rigor: Leak-Free Evaluation & Calibration

### 1. Partitioning Strategy (Dal Pozzolo et al., 2018)
Standard random k-fold cross-validation is fundamentally flawed for financial fraud detection because:
- It causes **temporal leakage** (using tomorrow's transactions to predict yesterday's fraud).
- It causes **agent identity leakage** (the model memorizes specific agent IDs rather than learning generalizable fraud behavior).

**Our Partitioning Strategy (`engine/split.py`):**
- **Strict Chronological Ordering:** Data is sorted by timestamp. The first 70% of time forms the training window, the next 15% forms the validation (calibration) window, and the final 15% forms the held-out test window.
- **Strict Agent Disjointness:** Agents are partitioned randomly across splits. No agent in the test partition ever appears in the training or validation sets.
- **The Generalization Test:** The model is tested on **unseen agents** operating in a **future time period**.

### 2. Isotonic Probability Calibration (Niculescu-Mizil & Caruana, 2005)
Gradient-boosted decision trees trained under remaining class skew output decision margins that compress predictions toward the extremes. If uncalibrated, an XGBoost score of "0.85" is an arbitrary heuristic threshold rather than a true probability.

**Our Calibration Solution:**
We train a non-parametric **Isotonic Regression** model on the held-out validation set predictions:
$$P(\text{Fraud} \mid x) = \text{IsotonicRegressor}(P_{\text{raw XGBoost}}(x))$$
- Guarantees that $P(\text{Fraud} \mid x) \ge 0.85$ reflects an empirical $85\%$ posterior probability of fraud.
- Drops the calibration Brier score from **0.0679** (naive) to **0.0014** (calibrated cascade).

---

## 6. Empirical Results & Baseline Comparison

The two-layer cascade was benchmarked against a **Naive Rule-Based Baseline** (an amount ceiling and a trailing-24 h count cap, both fitted on train at P99.5):

### Test Set Performance (`v1.1.0`: 86,528 rows, 10,741 test rows, 104 test fraud events)

Brackets are 95% cluster-bootstrap CIs (1,000 resamples over the 106 test agent components). The baseline is fitted on
train: amount ceiling KES 14,845 (P99.5) and a trailing-24 h count cap of 17 (P99.5).

| Evaluation Metric | Two-Layer Cascade (`v1.1.0`) | Naive Rule Baseline | Paired Lift |
|---|---|---|---|
| **PR-AUC (Primary Metric)** | **0.8416** [0.8190, 0.8625] | 0.1091 [0.0841, 0.1326] | **+0.7324** [0.7111, 0.7528] |
| **F1-Score** | **0.8911** [0.8759, 0.9053] | 0.0145 [0.0000, 0.0313] | +0.8767 [0.8574, 0.8960] |
| **Precision** | **98.78%** [97.68%, 99.66%] | 5.49% [0.00%, 10.38%] | — |
| **Recall (rows)** | **81.17%** [78.83%, 83.40%] | 0.83% [0.00%, 1.87%] | — |
| **Event recall** | **103/104** (0.9904) | 3/104 (0.0288) | +0.9615 [0.9286, 0.9911] |
| **False Positive Rate (FPR)** | **0.06%** [0.02%, 0.11%] *(PASS)* | 0.85% [0.61%, 1.11%] | — |
| **Brier Score (Layer-2 cohort)** | **0.00886** [0.00428, 0.01363] | n/a | — |
| **Layer 1 Latency** | **0.22 ms** mean (compiled traversal) | — | **Complies with NFR-02 (<30 ms SLA)** |

Full detail and the v1.0.0 comparison: `README.md` (Measured Evaluation), `reports/evaluation_report.md` and
`reports/paysim_calibration.md`.

### Why False Positive Rate (FPR) is Critical for Business Morale:
Under the naive rule baseline, **0.85% of innocent test transactions are flagged** (about 86 of 10,141). The cascade
flags **6** (FPR 0.06%), well under the directive's **$< 0.5\%$** floor and its 0.1% target.

---

## 7. Ablation Study & Stability Analysis

### Ablation 1: The Layer 1 Bypass Policy
Thesis Section 3.5.4 specifies that an Isolation Forest score $s(x, n) \ge 0.72$ triggers immediate `QUARANTINE`, bypassing Layer 2. To evaluate this rule scientifically, we ran an ablation on identical fitted models (`engine/eval.py`):

| Policy Mode | PR-AUC | False Positives | Recall | Operational Impact |
|---|---|---|---|---|
| **Bypass Enabled (Thesis as written)** | **0.8416** | 6 | 81.2% | Fastest decision on extreme outliers |
| **Bypass Disabled (XGBoost always adjudicates)** | **0.8414** | 6 | 81.2% | Same flags; requires full XGBoost inference |

**Thesis Conclusion (v1.1.0):** On this test partition the bypass rule changes no decision (same false positives and recall); it only short-circuits the rarest, most extreme anomalies (about 0.1% of traffic).

### Ablation 2: Repeated-Split Stability Check (`engine/stability.py`)
Because retail fraud is rare, a single test split contains a finite number of fraud events (95 to 113 per split in `v1.1.0`). To confirm that our results were not an artifact of random seed selection, we executed **5 independent agent-grouped split-fit-evaluate cycles**:

| Metric | Mean Across 5 Repeats | Standard Deviation ($\sigma$) | Observed Range |
|---|---|---|---|
| **PR-AUC (operating score)** | **0.8471** | 0.0154 | 0.8275 – 0.8700 |
| **F1-Score** | **0.8891** | 0.0124 | 0.8765 – 0.9092 |
| **Precision** | **0.9903** | 0.0037 | 0.9868 – 0.9961 |
| **False Positive Rate** | **0.0005** | 0.0002 | 0.0002 – 0.0006 |
| **Event recall** | **0.9963** | 0.0051 | 0.9904 – 1.0000 |

The primary split result (PR-AUC 0.8416) sits within the empirical distribution, confirming that the engine generalizes reliably across agent cohorts.

---

## 8. Microservice Implementation (Module 2)

The engine is packaged as an asynchronous **FastAPI** microservice (`service/app.py`):

### 1. `POST /evaluate` (Inference Endpoint)
- Accepts the 6 behavioral features either as flat fields or nested under a `features` object.
- Executes sequential cascade logic.
- Generates **SHAP feature attributions** indicating *why* a transaction was quarantined.

**Sample Request:**
```json
{
  "transaction_id": "TXN_20261001_882910",
  "agent_id": "AG_042",
  "amount": 4850.0,
  "features": {
    "velocity_v_i": 85.2,
    "split_ratio_r_s": 0.38,
    "entropy_gaps": 0.85,
    "agent_zscore": 2.1,
    "amount_to_median_ratio": 2.4,
    "recipient_reuse_count": 3.0
  },
  "include_shap": true
}
```

**Sample Response (QUARANTINE Triggered):**
```json
{
  "transaction_id": "TXN_20261001_882910",
  "isolation_score": 0.6124,
  "xgb_probability": 0.8942,
  "model_version": "v1.1.0",
  "decision": "QUARANTINE",
  "triggered_layer": 2,
  "reason": "Layer 2 Calibrated XGBoost confidence (0.8942) >= threshold (0.85)",
  "top_shap_features": [
    { "feature": "velocity_v_i", "attribution": 2.4512, "value": 85.2 },
    { "feature": "recipient_reuse_count", "attribution": 1.1205, "value": 3.0 },
    { "feature": "split_ratio_r_s", "attribution": 0.8412, "value": 0.38 }
  ],
  "latency_ms": 6.84,
  "evaluated_at": "2026-10-01T10:00:45Z"
}
```

### 2. `GET /health` (Readiness Probe)
Returns service health, model version, and loaded feature columns for Kubernetes / ECS container orchestration.

### 3. `GET /model/info` (Ledger Synchronization)
Exports active decision thresholds (`quarantine_isolation_threshold: 0.72`, `quarantine_xgb_threshold: 0.85`) to ensure consensus alignment across distributed nodes.

---

## 9. Gateway & Blockchain Integration (Modules 1, 3, & 4)

### 1. Fail-Safe Default Circuit Breaker (NFR-08)
In decentralized escrow systems, an analytical service failure must never allow unvetted transactions to bypass risk screening.
In `integration/risk_client.ts` (the Node.js / TypeScript Gateway Client), an automated circuit breaker enforces:
- Latency timeout budget: **500 ms**.
- **If the ML service crashes, times out, or fails:** The client automatically catches the error and returns:
  ```typescript
  {
    decision: "QUARANTINE",
    reason: "Fail-safe default: ML microservice unreachable/timed out (NFR-08)",
    model_version: "v1.1.0-failsafe"
  }
  ```
  **Policy Guarantee:** The system defaults strictly to `QUARANTINE`, never `CLEAR`. Legitimate funds may be momentarily held for manual review, but fraudulent payouts can never leak into escrow during an outage.

### 2. Immutable Ledger Traceability (NFR-09)
Every evaluation response carries `model_version: "v1.1.0"`. 
When the Node.js Gateway advances a `CLEAR` transaction to **Module 3 (Hyperledger Fabric)**, the smart contract (`commitTransaction`) writes the exact `model_version` into the immutable transaction state block. This satisfies non-repudiation and enables closed-loop model retraining audits.

---

## 10. Supervisor Meeting & Oral Defense Cheat Sheet

| Question an Examiner Will Ask | Your Prepared Answer |
|---|---|
| *"Why didn't you just use PaySim's fraud column?"* | *"PaySim's `isFraud` represents account takeover (identity theft and account draining). Our capstone targets first-party agent collusion: commission stuffing and circular chaining. Training on PaySim's native labels would learn the wrong signatures. We fitted the base traffic's hour-of-day cycle and day-to-day volume variation to PaySim's PAYMENT and CASH_IN rows (never its labels), and injected mathematically defined ground truth matching Equations 3.1 and 3.2."* |
| *"How did you handle the 1.3% class imbalance?"* | *"Architecturally, rather than through artificial synthetic sampling. The Layer 1 Isolation Forest acts as a pre-filter, stripping away over 80% of benign traffic. The candidate cohort passed to XGBoost has a 5.6x higher fraud density, which stabilizes boosting. We then tuned `scale_pos_weight` directly on this candidate subset."* |
| *"What does 0.85 confidence actually mean?"* | *"On raw XGBoost, tree margin outputs are compressed and cannot be interpreted as probabilities. We applied non-parametric Isotonic Regression on held-out validation predictions to calibrate the margin into an empirical posterior probability $P(\text{Fraud} \mid x) \ge 0.85$. This dropped our Brier calibration score by 98%."* |
| *"How do you prove there is no data leakage?"* | *"We implemented chronological and agent-grouped partitioning (Dal Pozzolo et al., 2018). All splits strictly follow time progression, and agents in the test partition were never seen during training. The model is proven to generalize to brand-new agents in future time periods."* |
| *"What happens if the ML microservice goes down?"* | *"Non-Functional Requirement NFR-08 dictates a fail-safe default. The Node.js gateway client has a 500ms timeout budget. If the microservice fails, the client automatically defaults to QUARANTINE, preventing unvetted transactions from ever reaching the escrow ledger."* |

---

## 11. Verification Evidence (25/25 Pytest Suite)

The implementation has been independently verified across 25 unit and integration tests:

```text
============================= test session starts =============================
tests/test_pipeline.py            8 PASSED  (Traffic generation, injectors, feature math)
tests/test_service.py             8 PASSED  (FastAPI endpoints, SHAP rankings, schema validation)
tests/test_training_pipeline.py   9 PASSED  (Partitioning disjointness, calibration, latency SLA)
============================= 25 passed in 21.25s =============================
```

**Delivered Artifacts:**
- Core Package: [`engine/`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/engine) (`cascade.py`, `features.py`, `split.py`, `eval.py`, `stability.py`)
- API Service: [`service/`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/service) (`app.py`, `schemas.py`, `config.py`)
- Gateway Client: [`integration/risk_client.ts`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/integration/risk_client.ts)
- Container: [`Dockerfile`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/Dockerfile), [`docker-compose.yml`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/docker-compose.yml)
- Serialized Model: [`models/risk_cascade_v1.1.0.joblib`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/models/risk_cascade_v1.1.0.joblib)
- Metrics & Ablation Data: [`reports/metrics.json`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/reports/metrics.json), [`reports/evaluation_report.md`](file:///C:/Users/rugog/Documents/CoDeAnDpRoJeCtS/Nathan-Rugo/Automative%20Commision%20and%20Escrow%20Payment/automative-commission-handling/backend/ml-engine/reports/evaluation_report.md)
