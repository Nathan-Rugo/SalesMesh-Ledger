# ML Engine (Module 2) — Documentation Review & Improvement Notes

**Reviewed document:** the capstone project report
**Scope:** Everything touching the two-layer ML risk engine — Sections 2.2.4, 3.2.1–3.2.4, 3.5.4, 4.2.1–4.2.2, 4.4.1, and 4.10.2.
**Context:** Your milestone table shows the proposal defended and Chapter 4 "ongoing," so this is the right moment to tighten these sections before Chapter 5 implementation writing begins — the changes below are additive (new paragraphs, a couple of table rows) rather than a rewrite.

This file is meant to sit next to the `.tex` file while you edit. Each item gives you: what's there now, why it's worth strengthening, and ready-to-adapt paragraph text in your document's voice. Nothing here contradicts your architecture — Isolation Forest → XGBoost cascade, FastAPI microservice, Redis idempotency, Hyperledger commit is sound and is standard industry practice (it mirrors how Stripe Radar and similar systems are structured). The fixes are about precision and defensibility, not a redesign.

---

## 0. The one thing to fix first

**Section 3.2.1 (Data Acquisition)** currently presents PaySim's `isFraud` label as if it directly represents the fraud your system is built to catch. It doesn't. PaySim's `isFraud` models agents taking over a customer account and draining it via transfer-then-cash-out — an account-takeover pattern. Your thesis targets two different typologies: commission stuffing (transaction splitting, Section 2.3.1) and circular chaining (float recycling, Section 2.3.1). If an examiner who knows PaySim reads Section 3.2.1 closely, this is the first thing they'll flag — not the 0.1% imbalance. Fix this one and several other sections fall into place around it.

---

## 1. Section 2.2.4 — Machine Learning for Financial Anomaly Detection

**What's there:** Good literature grounding for the Isolation Forest → XGBoost cascade (Abbassi et al., Hajek et al.). No changes needed to the theory. One addition worth making:

**Suggested addition** (end of the subsection, before moving to 2.3):

> The cascade architecture also provides a structural response to the extreme class imbalance characteristic of fraud data: because the supervised second stage trains only on the subset of transactions the unsupervised first stage has already flagged as anomalous, the effective class ratio presented to the XGBoost classifier is substantially less skewed than the population-level fraud rate, reducing reliance on resampling techniques that can otherwise distort the minority class distribution.

This pre-empts a question examiners commonly ask AI/ML projects: "how did you handle imbalance?" Your answer is architectural, and stating it here means you don't have to explain it from scratch in Chapter 3.

---

## 2. Section 3.2.1 — Data Acquisition

**What's there:** PaySim described as providing "over six million records to train a model that can identify risk signals," with no distinction drawn between `isFraud` and `isFlaggedFraud`, and no acknowledgement that PaySim's fraud scenario differs from your target typologies.

**Suggested replacement / addition** (insert after the existing PaySim paragraph):

> It is important to distinguish between PaySim's two fraud-related fields. The `isFlaggedFraud` field is a naive business rule that fires only when a single transfer exceeds KES 200,000, and applies to a negligible number of records; it is not used in this research. The `isFraud` field is the dataset's genuine ground truth, but it represents agents who take control of a customer account and drain it by transferring funds out and immediately cashing them out — an account-takeover pattern structurally distinct from the commission-stuffing and circular-chaining typologies this research targets (Section 2.3.1). PaySim is therefore used in this project to model realistic base transaction volume, timing, and amount distributions for mobile-money agent traffic, rather than as the primary source of fraud ground truth. A purpose-built synthetic fraud-injection module (Section 3.2.2) generates labelled training examples for the two target typologies directly from the mathematical definitions established in this chapter, following the common practice in the fraud-detection literature of extending a general-purpose transaction simulator with domain-specific injected scenarios when its native fraud model does not match the target application.

> ⚠️ **Before you paste this in:** if you can find a specific paper that does exactly this (uses PaySim as background traffic + a custom fraud injector), cite it in that last sentence instead of leaving it as an unattributed claim — ask your supervisor or search Google Scholar for something like "PaySim synthetic fraud injection extension." If you can't find one, soften "following the common practice" to "an approach consistent with," which doesn't imply a specific citation exists.

**New sub-subsection worth adding: "3.2.1.1 Synthetic Fraud Scenario Generation"**

> To generate ground truth for the two fraud typologies central to this research, a synthetic injection layer is applied on top of the PaySim transaction backbone. Commission-stuffing sequences are generated by selecting a legitimate deposit event and replacing it with $k$ sub-threshold deposits from the same agent, timed within a sliding window $\Delta t$, such that their cumulative sum exceeds the incentive threshold $\theta$ as defined in Equation 3.2. Circular chaining sequences are generated by selecting a pair of agent accounts and inserting a bounded sequence of alternating transfers between them within a fixed time window, with no corresponding customer-facing sale. Both generators log the ground-truth label alongside the engineered feature vector, giving the two-layer engine labelled examples that match the fraud definitions established in the literature review rather than PaySim's native account-takeover scenario.

**Downstream effect:** this addition means Section 3.2.4 (validation) can now honestly claim the model is tested against the fraud it's actually meant to catch — see Item 5 below.

---

## 3. Section 3.2.2 — Data Preprocessing

**What's there:** $V_i$ (velocity), $R_s$ (split ratio), and entropy analysis are all well-defined and mathematically sound. Keep all of it.

**Suggested addition** (after the entropy paragraph, before "Model Training"):

> Two further behavioural features extend this set. First, an agent-relative anomaly score expresses each transaction amount as a z-score against that specific agent's own rolling 30-day mean and standard deviation, rather than against a population-wide threshold; this captures a shift in an individual agent's behaviour even where the transaction would appear unremarkable relative to the wider agent population, and links directly to the `agent_trust_rating` field already defined in the SALES\_AGENTS table (Table 4.4). Second, a recipient-reuse frequency feature counts the number of distinct settlement cycles in which a given agent-counterparty pair recurs within a rolling window, providing an early signal for the circular transaction chaining described in Section 2.3.1, which the velocity and split-ratio features alone are not designed to detect.

**Why bother:** $V_i$ and $R_s$ catch stuffing well but say almost nothing about chaining — chaining is a *relationship* pattern (same two accounts, repeated), not a *volume* pattern. This feature is what actually gives your model a shot at the second fraud vector you named in your problem statement.

---

## 4. Section 3.2.3 — Model Training

**What's there:** Isolation Forest (contamination = 0.01, 100 estimators) and XGBoost (binary logistic, depth 6, $\eta$ = 0.1) are both reasonable, standard configurations. No changes needed to these numbers.

**Suggested addition** (end of the subsection):

> Because fraudulent transactions form a small minority of overall traffic, the XGBoost classifier trains only on the subset of transactions the Layer 1 Isolation Forest has already flagged as anomalous, which substantially reduces the effective class imbalance presented to the supervised stage relative to the raw population rate. Within this filtered subset, the `scale_pos_weight` parameter is tuned to the observed ratio of legitimate to fraudulent examples. Gradient-boosted classifiers trained under class imbalance frequently produce poorly calibrated probability outputs, so the raw XGBoost score is passed through an isotonic regression calibration layer before the 0.85 confidence threshold defined in Section 3.5.4 is applied, ensuring the threshold corresponds to a statistically meaningful probability rather than an arbitrary score cut-off.

**Why this matters for your defense:** your FR-05 and Section 3.5.4 both hinge on ">0.85 confidence." An examiner can reasonably ask "0.85 of what, exactly, and is that number meaningful?" This paragraph answers that before it's asked.

---

## 5. Section 3.2.4 — Model Validation and Testing

**What's there:** F1-score, precision-recall curves, FPR < 0.5% target, and adversarial chaos engineering — all good. Missing: how the data is split, and what the model is compared against.

**Suggested addition:**

> Given the low base rate of fraudulent transactions, Precision-Recall AUC is reported as the primary discrimination metric alongside F1-score, since accuracy and ROC-AUC can present an overly optimistic picture under severe class imbalance. Training, validation, and test partitions are constructed chronologically and grouped by agent identifier, so that no single agent's transactions span more than one partition and the model is always evaluated on transactions occurring after those it was trained on — preventing the temporal and agent-level leakage that would otherwise inflate reported performance. The two-layer engine's performance is further benchmarked against a naive rule-based baseline (a static threshold on single-transaction amount and same-day transaction count) to quantify the empirical lift attributable to the machine learning layer, consistent with the experimental research paradigm established in Section 3.2.

**Why the baseline comparison matters specifically:** your own marking guide rewards a "clear, logical and well explained approach" — a documented baseline is the standard way an ML evaluation demonstrates the model is actually earning its complexity, not just a checkbox for the marking guide.

---

## 6. Section 3.5.4 — Module 2: ML Risk Assessment and Anomaly Detection Engine

**What's there:** FastAPI microservice, `POST /evaluate`, quarantine threshold 0.72, XGBoost confidence 0.85 — this is a clean, deployable description. Two additions close integration gaps with Module 3 and the NFR table.

**Suggested addition:**

> Every response from the `POST /evaluate` endpoint includes a `model_version` identifier alongside the isolation and XGBoost scores, allowing the corresponding Hyperledger Fabric commitment in Module 3 to record precisely which model version produced a given risk decision — supporting the non-repudiation requirements discussed in Section 2.2.3 and giving the closed-loop retraining process described in Section 2.6 a concrete audit trail to retrain against. Should the FastAPI microservice fail to respond within the allotted latency budget, the Node.js gateway applies a conservative fail-safe default of `QUARANTINE` rather than `CLEAR`, ensuring that an infrastructure fault in the risk-assessment layer cannot silently bypass verification.

---

## 7. Section 4.2.1 / 4.2.2 — Functional & Non-Functional Requirements tables

Two rows worth adding to Table 4.3 (Non-Functional Requirements):

| Req. ID | Category | Requirement Description | Target Metric |
|---|---|---|---|
| NFR-08 | Fail-Safe Default | If the ML microservice does not respond within the latency budget, the gateway shall default to QUARANTINE rather than CLEAR. | 100% fail-safe compliance under simulated ML-service downtime |
| NFR-09 | Model Traceability | Every risk decision persisted to the ledger shall reference the exact model version that produced it. | 100% of ledger entries carry a resolvable `model_version` |

These are cheap to add and directly support the "immutability" and "audit trail" language already in your abstract and NFR-04.

---

## 8. Section 4.10.2 — Data Dictionary (VERIFICATION_EVENTS, Table 4.6)

**Optional, not required.** If you want the schema to visibly support Item 6 above, add one column:

| Column Name | Data Type | Constraints | Description |
|---|---|---|---|
| `model_version` | VARCHAR(20) | NOT NULL | Identifier of the trained model artefact that produced this evaluation; supports reproducibility and audit. |

Only add this if you're comfortable touching the ERD/schema diagram figure too — if that diagram is already finalized as an image, it may be less disruptive to just mention `model_version` in prose in 3.5.4 and leave the table as-is for now, then reconcile in Chapter 5 when you build the real schema.

---

## 9. Section 3.3.7 — Deployment and Feedback (small addition)

You already mention "calibration of the risk-adaptive thresholds" here. One sentence makes that concrete rather than aspirational:

> Post-deployment, feature-level Population Stability Index (PSI) is computed on a rolling basis to detect distributional drift in agent behaviour or transaction patterns, providing an objective trigger for the threshold recalibration referenced above rather than relying solely on qualitative operational feedback.

---

## Prioritized checklist

If you only have time for three edits before your next supervisor check-in, do these, in order:

1. **Section 3.2.1** — the PaySim label-mismatch fix (Item 2). This is the one an ML-literate examiner is most likely to probe.
2. **Section 3.2.4** — chronological/agent-grouped split + baseline comparison (Item 5). Cheap to add, directly answers "how do you know it generalizes."
3. **Section 3.2.3** — calibration + imbalance-handling statement (Item 4). Makes your 0.85 threshold defensible.

Everything else (Items 1, 3, 6, 7, 8, 9) is worth doing but won't sink a defense on its own.

## Open questions worth raising with your supervisor

- Whether the synthetic fraud-injection approach (Item 2) needs a specific literature citation, or whether describing it as a methodological choice grounded in your own fraud definitions is sufficient for this program's standards.
- Whether any real (even small, anonymized) Daraja sandbox transaction sample is obtainable for a final held-out validation set, given your existing "sandbox constraints" limitation (Section 1.5.2).
- Whether the `model_version` / traceability additions (Items 6–8) should be reflected in the ERD diagram now or deferred to Chapter 5, since the diagram is already a finished figure.

---

*Once you've decided which of these to fold into the `.tex` file, say the word and we'll start building — I'd suggest starting with the synthetic fraud-injection generator (Item 2), since the training pipeline and evaluation script both depend on it.*
