# SalesMesh ML Risk Engine (Module 2)

Two-layer fraud-detection microservice for the **"Automated Risk-Adaptive Commission and Escrow Ledger for Distributed Retail Networks"** capstone platform.

Combines an unsupervised **Isolation Forest** pre-filter (<30ms) feeding a supervised, calibrated **XGBoost** classifier with **SHAP TreeExplainer** interpretability, benchmarked against a naive rule-based baseline.

**Status:** engine rebuilt with statistically valid evaluation, service hardened, and packaging pinned.
- The automated test suite passes in a venv built from the compiled pins (`python -m pytest tests -q`).
- Trained artifact `models/risk_cascade_v1.1.0.joblib` with its `.sha256` sidecar, both committed to git.
- FastAPI microservice exposing `POST /evaluate` (features mode or raw transaction + history), `GET /health`, `GET /model/info`.
- Non-root Docker image, docker-compose service, and a CI job that runs pytest and builds the image.
- TypeScript gateway client in `integration/`: **pending (deferred)**. The existing file predates the hardened API,
  and its rebuild (never throw, response validation, fail-safe `QUARANTINE`) is tracked separately.

---

## Architecture & Cascade Decision Logic

```
   Incoming Transaction Payload
               │
               ▼
┌──────────────────────────────┐
│  Layer 1: Isolation Forest   │  Unsupervised anomaly score s(x, n) ∈ [0, 1]
│  (contamination=0.01, n=100) │  Target latency: <30ms
└──────────────┬───────────────┘
               │
      ┌────────┴──────────────────────────┐
      │                                   │
      ▼ (s >= 0.72)                       ▼ (s < 0.45)
[ Immediate QUARANTINE ]            [ Fast CLEAR ]  (<30ms budget met)
(Operational bypass per Sec. 3.5.4) (Decision skips Layer 2; p still computed for audit)
      │
      ▼ (0.45 <= s < 0.72: Candidate Anomaly Cohort)
┌─────────────────────────────────────────┐
│       Layer 2: Calibrated XGBoost       │  Supervised classifier
│       (depth=6, scale_pos_weight=2.42)  │  Trained on candidate subset
│       + Isotonic Regression Calibrator  │  Outputs posterior P(Fraud | x)
└────────────────────┬────────────────────┘
                     │
         ┌───────────┼─────────────────┐
         ▼ (P>=0.85) ▼ (0.50<=P<0.85)  ▼ (P<0.50)
      [ QUARANTINE ] [ REVIEW ]        [ CLEAR ]
```

---

## Directory Structure

```
ml-engine/
├── engine/                       # Core ML Package
│   ├── base_traffic.py           # PaySim-calibrated synthetic backbone & PaySim replay loader
│   ├── paysim_profile.py         # Streamed PaySim profiler (hour weights, busy-day volume CV)
│   ├── fraud_injector.py         # Commission stuffing & circular chaining injectors
│   ├── features.py               # Feature engineering (V_i, R_s, entropy, z-score, reuse)
│   ├── split.py                  # Chronological, agent-component-grouped partitioning (Dal Pozzolo et al., 2018)
│   ├── fast_iforest.py           # Compiled IsolationForest traversal (== score_samples within 1e-9)
│   ├── cascade.py                # RiskCascadePipeline (Isolation Forest + XGBoost + Isotonic Calibrator)
│   ├── baseline.py               # Naive rule-based benchmark baseline
│   ├── eval.py                   # Multi-metric evaluation & ablation suite
│   ├── stability.py               # Repeated-split stability check
│   └── train.py                  # Pipeline training logic
├── service/                      # FastAPI Microservice (Step 3)
│   ├── app.py                    # FastAPI application, lifespan, endpoints, exception handling
│   ├── schemas.py                # Pydantic v2 validation contracts
│   └── config.py                 # Environment and runtime settings
├── integration/                  # Gateway client - PENDING (deferred rebuild)
│   └── risk_client.ts            # Pre-hardening draft; not yet aligned with the current /evaluate contract
├── data/
│   └── paysim_profile.json       # Fitted PaySim profile (committed; the PaySim CSV is not)
├── models/
│   ├── risk_cascade_v1.1.0.joblib # Serialized model artifact (committed)
│   └── risk_cascade_v1.1.0.joblib.sha256 # Integrity sidecar; load is refused without it
├── reports/
│   ├── evaluation_report.md      # Full Markdown evaluation report & baseline lift
│   ├── metrics.json              # Machine-readable metrics & ablation data
│   └── paysim_calibration.md     # PaySim profile fit and v1.0.0 vs v1.1.0 comparison
├── tests/                        # pytest suite
│   ├── test_pipeline.py          # Traffic, injectors, feature maths and batch/online parity
│   ├── test_training_pipeline.py # Split, compiled forest, cascade, calibration, artifact integrity
│   ├── test_evaluation.py        # Bootstrap CIs, event recall, train CLI, acceptance checks
│   ├── test_paysim_profile.py    # PaySim profiler, calibrated hour shares, determinism, anchor supply
│   └── test_service.py           # API contract, raw-mode parity, fail-safe error matrix, settings
├── Dockerfile                    # Multi-stage, python:3.11.9-slim-bookworm, non-root `app` user, urllib HEALTHCHECK
├── docker-compose.yml            # Single-service compose (passes MODEL_SHA256)
├── pyproject.toml                # Project metadata (requires-python ~=3.11) + pytest config
├── requirements.in               # Exact top-level runtime pins
├── requirements.txt              # Compiled with `uv pip compile --python-version 3.11 --universal`
├── requirements-dev.in / .txt    # Runtime pins + pytest and httpx
├── run_server.py                 # Microservice launch entrypoint
├── train.py                      # Training CLI entrypoint
└── generate_dataset.py           # Dataset generation CLI (the CSV is git-ignored; regenerate it)
```

---

## Quick Start

### 1. Local Python environment (Python 3.11)

You must use the compiled pins. `RiskCascadePipeline.load` refuses the artifact unless scikit-learn and xgboost
equal its recorded `library_versions` exactly. numpy and joblib must match major.minor.

```bash
cd ml-engine
uv venv .venv --python 3.11
PY=.venv/bin/python               # Linux/macOS
# PY=.venv/Scripts/python.exe     # Windows (Git Bash); in PowerShell use .venv\Scripts\python.exe
uv pip install -r requirements-dev.txt --python "$PY"

"$PY" -m pytest tests -q                      # full suite
"$PY" run_server.py --port 8000               # http://localhost:8000, OpenAPI docs at /docs
curl -f http://localhost:8000/health          # 200 when the model is loaded, 503 otherwise
```

On Linux the pins install `xgboost-cpu==2.1.3` instead of `xgboost==2.1.3`. It provides the same `xgboost` module
and `__version__` without the ~200 MB NCCL GPU library, so the artifact's version check still passes.

To change a pin, edit `requirements.in` (or `requirements-dev.in`) and recompile both files:

```bash
uv pip compile requirements.in --python-version 3.11 --universal -o requirements.txt
uv pip compile requirements-dev.in --python-version 3.11 --universal -o requirements-dev.txt
```

Bumping scikit-learn or xgboost means retraining the artifact under the new versions.

### 2. Docker

```bash
cd ml-engine
docker build -t salesmesh-ml-engine .
# Pin the artifact digest from outside models/ so a swapped artifact+sidecar pair is also refused:
MODEL_SHA256=$(cut -d' ' -f1 models/risk_cascade_v1.1.0.joblib.sha256) docker compose up -d
curl -f http://localhost:8000/health
```

- The image is multi-stage. A builder stage installs the pins into `/opt/venv`. The runtime stage is
  `python:3.11.9-slim-bookworm` with only `libgomp1` added, and it copies in that venv and the app.
- It runs as the non-root `app` user.
- Its HEALTHCHECK uses Python `urllib`, so it fails while `/health` returns 503.
- CI (`.github/workflows/ci-ml-engine.yml`) runs pytest on Python 3.11 from `requirements-dev.txt`. It then builds
  the image, waits for the container's own HEALTHCHECK to report `healthy`, and asserts that the process is not
  running as root.

### 3. Settings

pydantic-settings reads these from environment variables (`service/config.py`):

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_PATH` | `models/risk_cascade_v1.1.0.joblib` | Artifact path. The `.sha256` sidecar next to it is mandatory. |
| `MODEL_SHA256` | unset | Pinned artifact digest: exactly 64 hex characters, with no `sha256:` prefix or filename. A malformed value fails at startup. On a mismatch the model is not loaded and the service stays at 503. A warning is logged when `ENVIRONMENT=production` and this is unset. |
| `HOST` / `PORT` | `localhost` / `8000` | Bind address for `run_server.py`. The image sets `HOST=0.0.0.0`. |
| `ENVIRONMENT` | `development` | Label only. |
| `ENABLE_SHAP` | `true` | Global SHAP switch. |
| `DEFAULT_TOP_K_SHAP` | `3` | Number of SHAP attributions returned when the request omits `top_k_shap` (1–6). |
| `CORS_ALLOW_ORIGINS` | empty | Comma-separated or JSON list. Empty installs no CORS middleware, so no `Access-Control-Allow-Origin` is sent. Credentials are never allowed. |
| `MAX_REQUEST_BYTES` | `524288` | Request body limit, applied to chunked bodies too. Larger bodies get 413. |
| `MAX_HISTORY_ROWS` | `2000` | Maximum number of `history` rows in raw mode. More rows get 422. |

`FAIL_SAFE_DECISION` is fixed to `QUARANTINE` and cannot be overridden.

---

## API Reference

Every non-2xx response has this shape and never contains a stack trace. That includes 404, 405, 413, 422, 500 and 503.

```json
{
  "error": "UnprocessableEntity",
  "message": "Request failed validation.",
  "fail_safe_recommendation": "QUARANTINE",
  "policy_reference": "NFR-08: Gateway shall default to QUARANTINE rather than CLEAR upon ML service failure.",
  "fail_safe_cause": "invalid_request",
  "retryable": false,
  "errors": [{"loc": ["body", "features", "velocity_v_i"], "msg": "Input should be a finite number", "type": "finite_number"}]
}
```

`errors` appears only on validation failures. Handlers are synchronous, so inference runs in the threadpool.

`fail_safe_cause` and `retryable` tell the gateway *why* it is quarantining:

| Status | `fail_safe_cause` | `retryable` | What the gateway should do |
|---|---|---|---|
| 503 | `service_unavailable` | `true` | Quarantine, then re-score automatically once `/health` is 200 again |
| 500 | `inference_error` | `true` | Quarantine, then re-score later; the details are in the service log |
| 422, 404, 405 | `invalid_request` | `false` | Quarantine and flag a gateway bug; the same request will fail again |
| 413 | `payload_too_large` | `false` | Quarantine and send less history (at most 30 days is ever used) |

Raw-mode history rows older than 30 days before the transaction are dropped before features are computed. No
feature looks further back, so trimming them changes nothing except latency. Timestamps must fall between
1678-01-01 and 2261-12-31 UTC, the range the feature engine computes in.

### 1. `POST /evaluate`

Send **exactly one** of the two modes below. Sending both, or neither, returns 422. Every object rejects unknown
fields, NaN and ±Infinity. Missing values are never defaulted.

**Features mode** sends the 6 engineered features, either nested under `features` or flat at the top level. You can
send both forms together only when every flat value equals its nested value.

```json
{
  "transaction_id": "TXN_20261001_882910",
  "agent_id": "AG_042",
  "features": {
    "velocity_v_i": 85.2,
    "split_ratio_r_s": 0.38,
    "entropy_gaps": 0.85,
    "agent_zscore": 2.1,
    "amount_to_median_ratio": 2.4,
    "recipient_reuse_count": 3.0
  },
  "include_shap": true,
  "top_k_shap": 3
}
```

**Raw mode** sends the transaction plus that agent's recent history. The service computes the features with
`engine.features.compute_features_from_history`, the same function the training batch builder uses. The result
equals `build_feature_matrix` on the same rows to within 1e-9, so the gateway never re-implements the feature maths.

```json
{
  "transaction_id": "TXN_20261001_882910",
  "transaction": {"agent_id": "AG_042", "timestamp": "2026-10-01T10:00:00Z", "amount": 4850.0, "counterparty_id": "CP_991"},
  "history": [
    {"transaction_id": "TXN_20261001_882909", "agent_id": "AG_042", "timestamp": "2026-10-01T09:59:30Z", "amount": 4900.0, "counterparty_id": "CP_991"}
  ]
}
```

- `history` must be present, but it can be empty for an agent's first transaction.
- Every history row must carry the transaction's `agent_id`. A row from another agent returns 422.
- History `transaction_id` values must be unique. Duplicates return 422.
- Timestamps that pandas cannot represent (outside about 1677–2262) return 422.
- Rows stamped after the transaction are ignored. Same-second ties are ordered by `transaction_id`, as in training.
- Naive timestamps are taken as UTC.
- Rows older than 30 days never affect any feature, so there is no need to send them.
- Top-level `agent_id`, `counterparty_id` and `amount` are optional. If present, they must equal the transaction's values.

**Response (200 OK):**
```json
{
  "transaction_id": "TXN_20261001_882910",
  "isolation_score": 0.6582,
  "xgb_probability": 0.9796,
  "model_version": "v1.1.0",
  "model_sha256": "a1c88c6a7e02fedbea4c8758f07ec56894fad246afe07c9c39f8068243fd5abf",
  "decision": "QUARANTINE",
  "triggered_layer": 2,
  "layer2_adjudicated": true,
  "reason": "Layer 2 calibrated XGBoost P(fraud) (0.9796) >= threshold (0.85)",
  "feature_vector": {"velocity_v_i": 120.0, "split_ratio_r_s": 1.0, "entropy_gaps": 0.0,
                     "agent_zscore": 0.0, "amount_to_median_ratio": 1.0, "recipient_reuse_count": 1.0},
  "top_shap_features": [{"feature": "recipient_reuse_count", "attribution": 5.22, "value": 1.0}],
  "shap_attribution_units": "xgboost_log_odds_margin_uncalibrated",
  "latency_ms": 11.43,
  "evaluated_at": "2026-10-01T10:00:00.123456Z"
}
```

- `feature_vector` holds the 6 values that were scored.
- `xgb_probability` is always the real calibrated p.
- When `layer2_adjudicated` is false, Layer 1 (fast-clear or bypass) made the decision and p is recorded for audit only.
- SHAP attributions are in **uncalibrated XGBoost log-odds (margin)** units. They explain the raw margin, not the
  calibrated probability.

| Status | When |
|---|---|
| 422 | Neither mode or both modes; NaN/Inf; a missing, null or unknown field; flat values that conflict with nested ones; history from another agent; duplicate history ids; timestamps outside 1678–2261 UTC; more than `MAX_HISTORY_ROWS` rows |
| 413 | Body larger than `MAX_REQUEST_BYTES`, whether declared or chunked |
| 503 | Model not loaded: missing, tampered, library-version mismatch, or `MODEL_SHA256` mismatch |
| 500 | Unexpected failure while computing features or scoring. The body is generic, `retryable` is true, and the details go to the server log. |

### 2. `GET /health`

This is the readiness probe.

- **200** `healthy`: includes `model_version`, `model_sha256`, `feature_columns` and `uptime_seconds`.
- **503** `unhealthy`: returned when no model is loaded. It includes the NFR-08 fields and a short `reason`
  category: `artifact_missing`, `integrity_mismatch`, `library_mismatch` or `load_failed`. The full detail (paths,
  digests, versions) is logged server-side only. `curl -f` and the Docker HEALTHCHECK therefore fail.

### 3. `GET /model/info`

Returns:
- `model_version` and `model_sha256`;
- `feature_columns`;
- `thresholds` (filter 0.45, bypass 0.72, quarantine 0.85, review 0.50) and `review_xgb_threshold`;
- `training_metadata` and the artifact's `library_versions`;
- `shap_attribution_units` and `decision_policy`.

It returns 503 with the NFR-08 body when the model is not loaded.

---

## Measured Evaluation (v1.1.0, PaySim-calibrated backbone, 2026-11-11)

Regenerated with `python generate_dataset.py --seed 42` (300 agents, 45 days; the backbone reads
`data/paysim_profile.json`) and `python train.py --dataset salesmesh_fraud_dataset.csv --model-version v1.1.0 --seed 42
--n-bootstrap 1000 --stability-repeats 5`, both in the pinned `.venv`.
Full detail: `reports/evaluation_report.md` and `reports/metrics.json`. The v1.0.0 → v1.1.0 comparison is in
`reports/paysim_calibration.md`.

**Backbone.** Base traffic is synthetic, with two parts fitted to PaySim1 (Lopez-Rojas et al., 2016) PAYMENT + CASH_IN rows:
- **Hour of day:** each timestamp takes an hour drawn from PaySim's 24 pooled hour weights, plus a uniform offset
  within that hour. Activity peaks at 17:00–19:00 and night hours are rare but non-zero.
- **Day-to-day volume:** each day has a shared multiplier g ~ Gamma(mean 1, CV 0.113), the CV of PaySim's 14 busy days.
  Each agent-day count is Poisson(6·g).

Amounts stay log-normal (median KES 1,500, σ 0.9).

**Data and split.** 86,528 rows; 900 injected fraud events (600 commission-stuffing that replace an anchor deposit,
300 circular-chaining over 40 fixed colluding pairs); 5,146 fraud rows.
- Split seed 42: test = 120 unseen agents (40%, colluding pairs kept together) in the last 30% of time.
- The dev agents give train (first 55%) and validation (55–70%).
- Fraud events: train 319, validation 72, test 104.
- Validation drops the 1 event (4 rows) that straddles the train/validation cutoff and so also has rows in train.

**Method.**
- Thresholds are fixed at s 0.45 / 0.72 and p 0.50 / 0.85, and are never tuned on test.
- Brackets are 95% cluster-bootstrap CIs: 1,000 resamples of the 106 agent components in the test partition.
- PR-AUC is average precision. The cascade PR-AUC uses the operating score (fast-clear → s/0.45, Layer 2 → 1 + p,
  bypass → 2 + s), so it reflects the routing.
- The cascade Brier score is over the Layer-2-adjudicated rows.
- Positive decision = QUARANTINE.

| Metric (test partition) | Two-Layer Cascade (`v1.1.0`) | Naive Baseline | Paired Lift |
|---|---|---|---|
| **PR-AUC** | **0.8416** [0.8190, 0.8625] | 0.1091 [0.0841, 0.1326] | **+0.7324** [0.7111, 0.7528] |
| **F1** | **0.8911** [0.8759, 0.9053] | 0.0145 [0.0000, 0.0313] | +0.8767 [0.8574, 0.8960] |
| Precision | 0.9878 [0.9768, 0.9966] | 0.0549 [0.0000, 0.1038] | — |
| Recall (rows) | 0.8117 [0.7883, 0.8340] | 0.0083 [0.0000, 0.0187] | — |
| **Event recall** | **0.9904** [0.9692, 1.0000] (103/104; exact [0.9476, 0.9998]) | 0.0288 [0.0000, 0.0629] | +0.9615 [0.9286, 0.9911] |
| **FPR** | **0.06%** [0.02%, 0.11%] | 0.85% [0.61%, 1.11%] | — |
| Brier (Layer-2 cohort) | 0.00886 [0.00428, 0.01363] | n/a (rule score is not a probability) | — |

- **Standalone calibrated XGBoost** (p on every row): PR-AUC 0.8452 [0.8243, 0.8613], F1 0.9009 [0.8873, 0.9126].
  The cascade ranks slightly below it because the fast-clear band removes rows from Layer 2.
- **Event recall by typology:**
  - Commission stuffing: 67/67. The bootstrap interval collapses to zero width at 100%, so the exact Clopper–Pearson
    interval [0.9464, 1.0000] is the one to quote.
  - Circular chaining: 36/37 (0.9730, bootstrap [0.9118, 1.0000]).
- **Fast-clear leakage:** 103 of 600 test fraud rows (17.2%) score s < 0.45 and are cleared without Layer 2.
  No fraud event has every row fast-cleared (0/104). Fast-clear handles 84.2% of all test traffic.
  - The no-fast-clear ablation (same models) raises F1 to 0.9009 and row recall to 0.8333.
  - Event recall rises to 1.0000, and FPR rises to 0.10%.
- **Baseline** (fitted on train): amount ceiling KES 14,845.30 (P99.5) and a trailing-24 h count cap of 17 (P99.5).
- **Latency** (single row): Layer 1 with the compiled traversal averages 0.22 ms (p99 0.53 ms), against 18.98 ms
  for sklearn `score_samples`. The full cascade averages 1.9 ms, or 3.4 ms with top-3 SHAP.
- **Stability** (5 repeated splits, seeds 42–46, 95–113 test events each):
  - PR-AUC (operating) 0.8471 ± 0.0154
  - F1 0.8891 ± 0.0124
  - FPR 0.05% ± 0.02%
  - Event recall 0.9963 ± 0.0051
  - PR-AUC lift 0.7396 ± 0.0109

| Directive floor | Requirement | Point | 95% CI | Verdict (point / CI) |
|---|---|---|---|---|
| PR-AUC lift | ≥ +0.65 | 0.7324 | [0.7111, 0.7528] | PASS / PASS |
| F1 | ≥ 0.75 | 0.8911 | [0.8759, 0.9053] | PASS / PASS |
| FPR | < 0.5% (target < 0.1%) | 0.06% | [0.02%, 0.11%] | PASS / PASS (target 0.1% met at the point estimate) |
| Layer-1 latency | < 30 ms (target < 10 ms) | 0.22 ms | n/a | PASS (target met) |

The v1.0.0 numbers (uniform 07:00–21:00 backbone) were PR-AUC lift 0.7120 [0.6840, 0.7351], F1 0.8694
[0.8519, 0.8854] and FPR 0.13% [0.07%, 0.21%]. The difference is not caused by the calibration alone:
- v1.1.0 is a fresh random draw.
- The split cutoffs moved, because `t_min` / `t_max` moved.
- Under v1.0.0 the only night-time rows were slow-chain fraud. Under v1.1.0, benign traffic also runs at night.

See `reports/paysim_calibration.md`.

All data is synthetic: the ground truth comes from the injectors, and PaySim `isFraud` is never used. These results
measure detection of the injected typologies, not real-world performance.

## Key Thesis Principles Enforced

1. **NFR-08 Fail-Safe Default**: Every non-2xx response from this service carries `fail_safe_recommendation: "QUARANTINE"`.
   The gateway must default to `QUARANTINE`, never `CLEAR`, when the service errors, times out or is unreachable.
   The client that enforces this (`integration/risk_client.ts`) is pending (deferred rebuild).
2. **NFR-09 Model Traceability**: Every evaluation returns `model_version` and the artifact's `model_sha256`, for the gateway to record on Hyperledger Fabric during payout commitment (the Fabric commit is not built yet).
3. **Leakage-Free Partitioning**: Test agents are disjoint from train/validation agents, colluding pairs stay in one
   partition, and time windows are strictly ordered (Dal Pozzolo et al., 2018). Validation rows of any fraud event that
   also has rows in train are excluded, so the calibrator never sees an event the model was trained on.
4. **Isotonic Calibration**: p is the XGBoost score mapped by isotonic regression fitted on the validation candidate
   cohort (s ≥ 0.45). On this synthetic data the mapping is nearly binary: test p clusters near 0.02 and 0.99, with almost
   no rows in between. Treat p as a well-ranked, approximately calibrated score for the Layer-2 cohort, not an exact
   posterior. For fast-cleared rows (s < 0.45), p is out of distribution and is recorded for audit only.
