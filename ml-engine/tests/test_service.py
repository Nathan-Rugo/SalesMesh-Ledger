"""
tests/test_service.py
---------------------
Unit and integration tests for the SalesMesh ML Risk Assessment FastAPI microservice (Step 3).
Tests request validation, health checks, model metadata, risk cascade execution, SHAP explanations,
and header latency measurements using FastAPI's TestClient.
"""

import asyncio
import inspect
import importlib
import json
import os
import shutil
import sys

import numpy as np
import pandas as pd
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

# Ensure backend/ml-engine root is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.cascade import SHAP_UNITS
from engine.features import FEATURE_COLUMNS, build_feature_matrix
from service.app import BodySizeLimitMiddleware, app, create_app
from service.config import ServiceSettings, settings


@pytest.fixture(scope="module")
def client():
    """TestClient context manager that triggers FastAPI lifespan startup/shutdown."""
    with TestClient(app) as test_client:
        yield test_client


def test_health_check(client):
    """Verifies that the /health endpoint reports healthy status and loaded model version."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["model_loaded"] is True
    assert data["model_version"] == "v1.1.0"
    assert len(data["feature_columns"]) == 6
    assert data["uptime_seconds"] >= 0.0


def test_model_info(client):
    """Verifies that /model/info returns model thresholds, metadata, and policies."""
    response = client.get("/model/info")
    assert response.status_code == 200
    data = response.json()
    assert data["model_version"] == "v1.1.0"
    assert "quarantine_isolation_threshold" in data["thresholds"]
    assert "quarantine_xgb_threshold" in data["thresholds"]
    assert data["thresholds"]["quarantine_isolation_threshold"] == 0.72
    assert data["thresholds"]["quarantine_xgb_threshold"] == 0.85
    assert len(data["feature_columns"]) == 6


def test_evaluate_benign_transaction_nested(client):
    """Verifies that normal, benign transactions are evaluated as CLEAR."""
    payload = {
        "transaction_id": "TXN_BENIGN_001",
        "agent_id": "AG_100",
        "amount": 1500.0,
        "features": {
            "velocity_v_i": 2.1,
            "split_ratio_r_s": 0.08,
            "entropy_gaps": 1.65,
            "agent_zscore": -0.10,
            "amount_to_median_ratio": 1.02,
            "recipient_reuse_count": 0.0,
        },
        "include_shap": True,
        "top_k_shap": 3,
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["transaction_id"] == "TXN_BENIGN_001"
    assert data["decision"] == "CLEAR"
    assert data["model_version"] == "v1.1.0"
    assert 0.0 <= data["isolation_score"] <= 1.0
    assert 0.0 <= data["xgb_probability"] <= 1.0
    assert len(data["top_shap_features"]) <= 3
    assert data["latency_ms"] >= 0.0
    assert "X-Response-Time-Ms" in response.headers


def test_evaluate_flat_payload_format(client):
    """Verifies that the microservice accepts flat feature keys without nested features dict."""
    payload = {
        "transaction_id": "TXN_FLAT_002",
        "agent_id": "AG_102",
        "velocity_v_i": 1.5,
        "split_ratio_r_s": 0.05,
        "entropy_gaps": 1.80,
        "agent_zscore": 0.0,
        "amount_to_median_ratio": 1.0,
        "recipient_reuse_count": 0.0,
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["transaction_id"] == "TXN_FLAT_002"
    assert data["decision"] == "CLEAR"


def test_evaluate_extreme_anomaly_quarantine(client):
    """
    Verifies that high-velocity, high structuring, or collusive transactions trigger QUARANTINE.
    """
    payload = {
        "transaction_id": "TXN_FRAUD_STUFFING_001",
        "agent_id": "AG_FRAUD_01",
        "amount": 4900.0,
        "features": {
            "velocity_v_i": 120.0,  # Extreme velocity burst
            "split_ratio_r_s": 0.85,  # High sub-theta concentration
            "entropy_gaps": 0.20,  # Rhythmic, automated timing
            "agent_zscore": 3.8,  # Huge deviation from history
            "amount_to_median_ratio": 4.5,
            "recipient_reuse_count": 8.0,  # Repeated counterparty reuse
        },
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["transaction_id"] == "TXN_FRAUD_STUFFING_001"
    assert data["decision"] == "QUARANTINE"
    assert data["model_version"] == "v1.1.0"
    assert len(data["top_shap_features"]) > 0


def test_evaluate_validation_error_missing_features(client):
    """Verifies that incomplete feature payloads return HTTP 422 Unprocessable Entity."""
    payload = {
        "transaction_id": "TXN_INVALID_001",
        # Missing velocity and other required fields
        "amount": 2500.0,
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 422


def test_evaluate_validation_error_negative_velocity(client):
    """Verifies that out-of-bound feature values (e.g. negative velocity) return 422."""
    payload = {
        "transaction_id": "TXN_INVALID_002",
        "velocity_v_i": -5.0,  # Velocity cannot be negative
        "split_ratio_r_s": 0.1,
        "entropy_gaps": 1.0,
        "agent_zscore": 0.0,
        "amount_to_median_ratio": 1.0,
        "recipient_reuse_count": 0.0,
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 422


def test_shap_feature_attributions_format(client):
    """Verifies the exact structure and schema of SHAP feature explanations."""
    payload = {
        "transaction_id": "TXN_SHAP_001",
        "features": {
            "velocity_v_i": 25.0,
            "split_ratio_r_s": 0.40,
            "entropy_gaps": 0.90,
            "agent_zscore": 1.5,
            "amount_to_median_ratio": 2.0,
            "recipient_reuse_count": 2.0,
        },
        "include_shap": True,
        "top_k_shap": 3,
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 200
    data = response.json()
    shap_list = data["top_shap_features"]
    assert len(shap_list) == 3
    for feat in shap_list:
        assert isinstance(feat["feature"], str)
        assert isinstance(feat["attribution"], float)
        assert isinstance(feat["value"], float)


# ===========================================================================
# Hardening, raw mode and the I/O & edge-case matrix (service packaging spec)
# ===========================================================================

SHIPPED_MODEL = settings.MODEL_PATH
FEATURES_OK = {
    "velocity_v_i": 2.1,
    "split_ratio_r_s": 0.08,
    "entropy_gaps": 1.65,
    "agent_zscore": -0.10,
    "amount_to_median_ratio": 1.02,
    "recipient_reuse_count": 0.0,
}


def _sidecar_digest(model_path: str = SHIPPED_MODEL) -> str:
    with open(model_path + ".sha256", encoding="utf-8") as fh:
        return fh.read().split()[0]


def assert_nfr08(response, status_code: int) -> dict:
    """Every non-2xx body must carry the NFR-08 fail-safe fields and no stack trace."""
    assert response.status_code == status_code, response.text
    body = response.json()
    assert body["fail_safe_recommendation"] == "QUARANTINE"
    assert body["policy_reference"].startswith("NFR-08")
    assert "Traceback" not in response.text
    expected_cause, expected_retryable = _EXPECTED_CAUSE[status_code]
    assert body["fail_safe_cause"] == expected_cause
    assert body["retryable"] is expected_retryable
    return body


# Elicitation E2: the gateway re-scores outage quarantines (retryable) but not bad requests.
_EXPECTED_CAUSE = {
    404: ("invalid_request", False),
    405: ("invalid_request", False),
    413: ("payload_too_large", False),
    422: ("invalid_request", False),
    500: ("inference_error", True),
    503: ("service_unavailable", True),
}


def _post_raw_json(client, text: str):
    return client.post("/evaluate", content=text.encode("utf-8"), headers={"Content-Type": "application/json"})


def _iso(ts: pd.Timestamp) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture(scope="module")
def agent_rows() -> pd.DataFrame:
    """One agent's history with same-second ties, repeat counterparties and sub-theta bursts."""
    rng = np.random.default_rng(7)
    t0 = pd.Timestamp("2026-03-01T08:00:00")
    offsets = np.cumsum(rng.choice([0, 1, 30, 400, 3600, 20000], size=60))
    rows = []
    for i, off in enumerate(offsets):
        rows.append({
            "transaction_id": f"TXN{i:05d}",
            "agent_id": "AGT_PARITY",
            "timestamp": t0 + pd.Timedelta(seconds=int(off)),
            "amount": float(np.round(rng.choice([4900.0, 1200.0, 15000.0]) * rng.uniform(0.5, 1.0), 2)),
            "counterparty_id": f"CUST{int(rng.integers(0, 5)):03d}",
        })
    return pd.DataFrame(rows)


def _raw_payload(rows: pd.DataFrame, target_idx: int, **extra) -> dict:
    target = rows.iloc[target_idx]
    history = rows.drop(index=rows.index[target_idx])
    return {
        "transaction_id": target["transaction_id"],
        "transaction": {
            "agent_id": target["agent_id"],
            "timestamp": _iso(target["timestamp"]),
            "amount": float(target["amount"]),
            "counterparty_id": target["counterparty_id"],
        },
        "history": [
            {
                "transaction_id": r.transaction_id,
                "agent_id": r.agent_id,
                "timestamp": _iso(r.timestamp),
                "amount": float(r.amount),
                "counterparty_id": r.counterparty_id,
            }
            for r in history.itertuples()
        ],
        **extra,
    }


# --- features mode ----------------------------------------------------------

def test_features_mode_response_carries_audit_fields(client):
    response = client.post("/evaluate", json={"transaction_id": "TXN_AUDIT_1", "features": FEATURES_OK})
    assert response.status_code == 200
    data = response.json()
    assert data["decision"] in ("CLEAR", "REVIEW", "QUARANTINE")
    assert isinstance(data["layer2_adjudicated"], bool)
    assert data["feature_vector"] == FEATURES_OK
    assert data["model_sha256"] == _sidecar_digest()
    assert data["shap_attribution_units"] == SHAP_UNITS


def test_consistent_flat_and_nested_features_are_accepted(client):
    payload = {"transaction_id": "TXN_BOTH_OK", "features": FEATURES_OK, **FEATURES_OK}
    assert client.post("/evaluate", json=payload).status_code == 200


def test_conflicting_flat_and_nested_features_are_rejected(client):
    payload = {"transaction_id": "TXN_CONFLICT", "features": FEATURES_OK, "velocity_v_i": 99.0}
    body = assert_nfr08(client.post("/evaluate", json=payload), 422)
    assert "velocity_v_i" in json.dumps(body["errors"])


# --- raw mode ---------------------------------------------------------------

def test_raw_mode_feature_vector_matches_batch_builder(client, agent_rows):
    batch = build_feature_matrix(agent_rows).set_index("transaction_id")
    for idx in (0, 1, 2, 17, 31, 45, len(agent_rows) - 1):
        payload = _raw_payload(agent_rows, idx, include_shap=False)
        response = client.post("/evaluate", json=payload)
        assert response.status_code == 200, response.text
        data = response.json()
        expected = batch.loc[payload["transaction_id"], FEATURE_COLUMNS].to_numpy(dtype=float)
        got = np.array([data["feature_vector"][c] for c in FEATURE_COLUMNS])
        np.testing.assert_allclose(got, expected, rtol=0, atol=1e-9)
        assert data["model_sha256"] == _sidecar_digest()
        assert isinstance(data["layer2_adjudicated"], bool)


def test_parity_fixture_exercises_same_second_ties(agent_rows):
    assert agent_rows["timestamp"].duplicated().any()


def test_raw_mode_with_empty_history_is_first_transaction(client):
    payload = {
        "transaction_id": "TXN_FIRST",
        "transaction": {"agent_id": "AG_1", "timestamp": "2026-03-01T08:00:00Z",
                        "amount": 1500.0, "counterparty_id": "CP_1"},
        "history": [],
    }
    response = client.post("/evaluate", json=payload)
    assert response.status_code == 200
    fv = response.json()["feature_vector"]
    assert fv["velocity_v_i"] == 0.0 and fv["agent_zscore"] == 0.0
    assert fv["amount_to_median_ratio"] == 1.0 and fv["recipient_reuse_count"] == 0.0


# --- mode selection -----------------------------------------------------------

def test_both_modes_rejected(client, agent_rows):
    assert_nfr08(client.post("/evaluate", json=_raw_payload(agent_rows, 5, features=FEATURES_OK)), 422)
    assert_nfr08(client.post("/evaluate", json=_raw_payload(agent_rows, 5, **FEATURES_OK)), 422)


def test_neither_mode_rejected(client):
    assert_nfr08(client.post("/evaluate", json={"transaction_id": "TXN_NONE"}), 422)


def test_raw_mode_requires_transaction_and_history(client, agent_rows):
    payload = _raw_payload(agent_rows, 5)
    without_history = {k: v for k, v in payload.items() if k != "history"}
    without_txn = {k: v for k, v in payload.items() if k != "transaction"}
    assert_nfr08(client.post("/evaluate", json=without_history), 422)
    assert_nfr08(client.post("/evaluate", json=without_txn), 422)


def test_raw_mode_rejects_conflicting_top_level_fields(client, agent_rows):
    assert_nfr08(client.post("/evaluate", json=_raw_payload(agent_rows, 5, agent_id="SOMEONE_ELSE")), 422)
    assert_nfr08(client.post("/evaluate", json=_raw_payload(agent_rows, 5, amount=123456.0)), 422)


# --- NaN / Inf / missing / extra ---------------------------------------------

_FLAT_REST = '"split_ratio_r_s": 0.1, "entropy_gaps": 1.0, "amount_to_median_ratio": 1.0, "recipient_reuse_count": 0.0'


@pytest.mark.parametrize("text", [
    '{"transaction_id": "T1", "velocity_v_i": NaN, "agent_zscore": 0.0, ' + _FLAT_REST + '}',
    '{"transaction_id": "T2", "features": {"velocity_v_i": Infinity, "agent_zscore": 0.0, ' + _FLAT_REST + '}}',
    '{"transaction_id": "T3", "features": {"velocity_v_i": 1.0, "agent_zscore": -Infinity, ' + _FLAT_REST + '}}',
    '{"transaction_id": "T4", "transaction": {"agent_id": "A", "timestamp": "2026-03-01T08:00:00Z",'
    ' "amount": NaN, "counterparty_id": "C"}, "history": []}',
    '{"transaction_id": "T5", "transaction": {"agent_id": "A", "timestamp": "2026-03-01T08:00:00Z",'
    ' "amount": 10.0, "counterparty_id": "C"}, "history": [{"transaction_id": "H", "agent_id": "A",'
    ' "timestamp": "2026-03-01T07:00:00Z", "amount": Infinity, "counterparty_id": "C"}]}',
])
def test_non_finite_values_rejected_in_every_mode(client, text):
    assert_nfr08(_post_raw_json(client, text), 422)


def test_values_beyond_float32_range_rejected(client):
    payload = {"transaction_id": "TXN_HUGE", "features": dict(FEATURES_OK, agent_zscore=1e300)}
    assert_nfr08(client.post("/evaluate", json=payload), 422)


def test_missing_and_extra_fields_rejected(client, agent_rows):
    nested_missing = {k: v for k, v in FEATURES_OK.items() if k != "entropy_gaps"}
    assert_nfr08(client.post("/evaluate", json={"transaction_id": "M1", "features": nested_missing}), 422)
    flat_missing = {k: v for k, v in FEATURES_OK.items() if k != "agent_zscore"}
    assert_nfr08(client.post("/evaluate", json={"transaction_id": "M2", **flat_missing}), 422)
    assert_nfr08(client.post("/evaluate", json={"transaction_id": "X1", "features": FEATURES_OK, "foo": 1}), 422)
    assert_nfr08(client.post("/evaluate", json={"transaction_id": "X2",
                                                "features": dict(FEATURES_OK, bar=2.0)}), 422)
    raw = _raw_payload(agent_rows, 3)
    raw["transaction"]["channel"] = "USSD"
    assert_nfr08(client.post("/evaluate", json=raw), 422)
    raw = _raw_payload(agent_rows, 3)
    raw["history"][0]["is_fraud"] = 0
    assert_nfr08(client.post("/evaluate", json=raw), 422)
    raw = _raw_payload(agent_rows, 3)
    del raw["history"][0]["counterparty_id"]
    assert_nfr08(client.post("/evaluate", json=raw), 422)


def test_null_feature_is_not_defaulted(client):
    payload = {"transaction_id": "TXN_NULL", **dict(FEATURES_OK, recipient_reuse_count=None)}
    assert_nfr08(client.post("/evaluate", json=payload), 422)


# --- history limits -----------------------------------------------------------

def test_history_from_foreign_agent_rejected(client, agent_rows):
    payload = _raw_payload(agent_rows, 10)
    payload["history"][0]["agent_id"] = "AGT_OTHER"
    body = assert_nfr08(client.post("/evaluate", json=payload), 422)
    assert "agent_id" in json.dumps(body)


def test_history_longer_than_max_rows_rejected(agent_rows):
    with TestClient(create_app(ServiceSettings(MAX_HISTORY_ROWS=10))) as c:
        at_limit = _raw_payload(agent_rows.iloc[:11], 10)
        assert len(at_limit["history"]) == 10
        assert c.post("/evaluate", json=at_limit).status_code == 200
        over = _raw_payload(agent_rows.iloc[:12], 11)
        body = assert_nfr08(c.post("/evaluate", json=over), 422)
        assert len(body["errors"]) == 1
        assert body["errors"][0]["loc"] == ["body", "history"]
        assert "10" in body["errors"][0]["msg"]


# --- body size ----------------------------------------------------------------

def test_body_over_limit_rejected_with_content_length(client):
    blob = b"{" + b" " * (settings.MAX_REQUEST_BYTES + 1) + b"}"
    response = client.post("/evaluate", content=blob, headers={"Content-Type": "application/json"})
    assert_nfr08(response, 413)
    assert "X-Response-Time-Ms" in response.headers  # limiter sits inside the timing middleware


def test_413_passes_through_cors_middleware():
    allowed = "https://admin.salesmesh.local"
    with TestClient(create_app(ServiceSettings(CORS_ALLOW_ORIGINS=[allowed], MAX_REQUEST_BYTES=64))) as c:
        response = c.post("/evaluate", content=b"{" + b" " * 100 + b"}",
                          headers={"Content-Type": "application/json", "Origin": allowed})
        assert_nfr08(response, 413)
        assert response.headers.get("access-control-allow-origin") == allowed
        assert "X-Response-Time-Ms" in response.headers


def test_chunked_body_over_limit_rejected(client):
    def chunks():
        yield b'{"transaction_id": "'
        for _ in range(settings.MAX_REQUEST_BYTES // 65536 + 2):
            yield b"A" * 65536
        yield b'"}'

    response = client.post("/evaluate", content=chunks(), headers={"Content-Type": "application/json"})
    assert "content-length" not in {k.lower() for k in response.request.headers}
    assert_nfr08(response, 413)


def test_body_limiter_counts_multi_chunk_asgi_bodies():
    """Drive the pure-ASGI limiter directly with a body split across many messages."""
    reached = []

    async def inner(scope, receive, send):
        message = await receive()
        reached.append(message["body"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    def run(chunks):
        sent = []
        queue = [{"type": "http.request", "body": c, "more_body": i < len(chunks) - 1} for i, c in enumerate(chunks)]

        async def receive():
            return queue.pop(0)

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/evaluate", "headers": []}
        asyncio.run(BodySizeLimitMiddleware(inner, max_bytes=10)(scope, receive, send))
        return sent

    ok = run([b"abc", b"def", b"ghij"])
    assert ok[0]["status"] == 200 and reached == [b"abcdefghij"]
    rejected = run([b"abc", b"def", b"ghij", b"k"])
    assert rejected[0]["status"] == 413 and reached == [b"abcdefghij"]
    body = json.loads(b"".join(m.get("body", b"") for m in rejected if m["type"] == "http.response.body"))
    assert body["fail_safe_recommendation"] == "QUARANTINE"


# --- readiness ----------------------------------------------------------------

def _not_ready_checks(app_settings: ServiceSettings, category: str) -> None:
    """503 everywhere, a short category as the reason, and no paths/digests/versions leaked."""
    secrets = [app_settings.MODEL_PATH, os.path.basename(app_settings.MODEL_PATH), _sidecar_digest(),
               "1.6.1", "2.1.3"]
    if app_settings.MODEL_SHA256:
        secrets.append(app_settings.MODEL_SHA256)
    with TestClient(create_app(app_settings)) as c:
        health = c.get("/health")
        body = assert_nfr08(health, 503)
        assert body["status"] == "unhealthy"
        assert body["model_loaded"] is False
        assert body["reason"] == category
        evaluate = c.post("/evaluate", json={"transaction_id": "T", "features": FEATURES_OK})
        assert category in assert_nfr08(evaluate, 503)["message"]
        info = c.get("/model/info")
        assert category in assert_nfr08(info, 503)["message"]
        for response in (health, evaluate, info):
            for secret in secrets:
                assert secret not in response.text


def test_missing_model_is_not_ready(tmp_path):
    _not_ready_checks(ServiceSettings(MODEL_PATH=str(tmp_path / "absent.joblib")), "artifact_missing")


def test_tampered_model_is_not_ready(tmp_path):
    path = tmp_path / "risk_cascade_v1.1.0.joblib"
    shutil.copyfile(SHIPPED_MODEL, path)
    shutil.copyfile(SHIPPED_MODEL + ".sha256", str(path) + ".sha256")
    with open(path, "ab") as fh:
        fh.write(b"\x00")
    _not_ready_checks(ServiceSettings(MODEL_PATH=str(path)), "integrity_mismatch")


def test_pinned_digest_mismatch_is_not_ready():
    _not_ready_checks(ServiceSettings(MODEL_SHA256="0" * 64), "integrity_mismatch")


def test_library_version_mismatch_is_not_ready(monkeypatch):
    import engine.cascade as cascade_mod

    real = cascade_mod.library_versions()
    monkeypatch.setattr(cascade_mod, "library_versions", lambda: dict(real, **{"scikit-learn": "9.9.9"}))
    _not_ready_checks(ServiceSettings(), "library_mismatch")


def test_production_without_pinned_digest_logs_warning(caplog):
    with caplog.at_level("WARNING", logger="salesmesh.ml_engine"):
        with TestClient(create_app(ServiceSettings(ENVIRONMENT="production"))) as c:
            assert c.get("/health").status_code == 200
    assert any("MODEL_SHA256" in r.getMessage() and r.levelname == "WARNING" for r in caplog.records)
    caplog.clear()
    with caplog.at_level("WARNING", logger="salesmesh.ml_engine"):
        with TestClient(create_app(ServiceSettings(ENVIRONMENT="production", MODEL_SHA256=_sidecar_digest()))):
            pass
    assert not any("MODEL_SHA256" in r.getMessage() for r in caplog.records)


def test_pinned_digest_match_is_ready():
    with TestClient(create_app(ServiceSettings(MODEL_SHA256=_sidecar_digest().upper()))) as c:
        response = c.get("/health")
        assert response.status_code == 200
        assert response.json()["model_sha256"] == _sidecar_digest()


# --- unexpected failures --------------------------------------------------------

def test_inference_exception_returns_500_without_internals(client, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr(client.app.state.pipeline, "evaluate_transaction", boom)
    response = client.post("/evaluate", json={"transaction_id": "TXN_BOOM", "features": FEATURES_OK})
    assert_nfr08(response, 500)
    assert "secret-internal-detail" not in response.text


def test_unhandled_exception_returns_500_nfr08():
    boom_app = create_app(ServiceSettings())

    @boom_app.get("/boom")
    def boom():
        raise RuntimeError("secret-internal-detail")

    with TestClient(boom_app, raise_server_exceptions=False) as c:
        response = c.get("/boom")
        assert_nfr08(response, 500)
        assert "secret-internal-detail" not in response.text


def test_unknown_route_and_wrong_method_carry_nfr08(client):
    assert_nfr08(client.get("/does-not-exist"), 404)
    assert_nfr08(client.get("/evaluate"), 405)


# --- CORS ---------------------------------------------------------------------

def test_no_cors_headers_by_default(client):
    response = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in response.headers}
    preflight = client.options("/evaluate", headers={"Origin": "https://evil.example",
                                                     "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in {k.lower() for k in preflight.headers}


def test_cors_only_for_configured_origins():
    allowed = "https://admin.salesmesh.local"
    with TestClient(create_app(ServiceSettings(CORS_ALLOW_ORIGINS=[allowed]))) as c:
        ok = c.get("/health", headers={"Origin": allowed})
        assert ok.headers.get("access-control-allow-origin") == allowed
        assert "access-control-allow-credentials" not in {k.lower() for k in ok.headers}
        other = c.get("/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in {k.lower() for k in other.headers}


# --- settings -----------------------------------------------------------------

def test_settings_defaults_and_env_names(monkeypatch, tmp_path):
    for name in ("MODEL_SHA256", "CORS_ALLOW_ORIGINS", "MAX_REQUEST_BYTES", "MAX_HISTORY_ROWS"):
        monkeypatch.delenv(name, raising=False)
    defaults = ServiceSettings()
    assert defaults.MODEL_SHA256 is None
    assert defaults.CORS_ALLOW_ORIGINS == []
    assert defaults.MAX_REQUEST_BYTES == 524288
    assert defaults.MAX_HISTORY_ROWS == 2000
    assert defaults.FAIL_SAFE_DECISION == "QUARANTINE"

    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "m.joblib"))
    monkeypatch.setenv("PORT", "9100")
    monkeypatch.setenv("ENABLE_SHAP", "false")
    monkeypatch.setenv("DEFAULT_TOP_K_SHAP", "2")
    monkeypatch.setenv("MODEL_SHA256", "  " + "ABCDEF" * 10 + "ABCD  ")
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://a.example, https://b.example")
    monkeypatch.setenv("MAX_REQUEST_BYTES", "1024")
    monkeypatch.setenv("MAX_HISTORY_ROWS", "50")
    s = ServiceSettings()
    assert s.MODEL_PATH == str(tmp_path / "m.joblib")
    assert s.PORT == 9100 and s.ENABLE_SHAP is False and s.DEFAULT_TOP_K_SHAP == 2
    assert s.MODEL_SHA256 == "abcdef" * 10 + "abcd"
    assert s.CORS_ALLOW_ORIGINS == ["https://a.example", "https://b.example"]
    assert s.MAX_REQUEST_BYTES == 1024 and s.MAX_HISTORY_ROWS == 50

    monkeypatch.setenv("MODEL_SHA256", "")
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "")
    s = ServiceSettings()
    assert s.MODEL_SHA256 is None and s.CORS_ALLOW_ORIGINS == []


def test_fail_safe_decision_cannot_be_configured_away(monkeypatch):
    monkeypatch.setenv("FAIL_SAFE_DECISION", "CLEAR")
    with pytest.raises(ValueError):
        ServiceSettings()


# --- model info & handler shape -------------------------------------------------

def test_model_info_exposes_traceability_fields(client):
    data = client.get("/model/info").json()
    assert data["review_xgb_threshold"] == 0.50
    assert data["model_sha256"] == _sidecar_digest()
    assert data["library_versions"]["scikit-learn"] == "1.6.1"
    assert data["library_versions"]["xgboost"] == "2.1.3"
    assert data["shap_attribution_units"] == SHAP_UNITS


def test_route_handlers_are_sync():
    routes = [r for r in app.routes if isinstance(r, APIRoute)]
    assert {"/evaluate", "/health", "/model/info"} <= {r.path for r in routes}
    assert not any(inspect.iscoroutinefunction(r.endpoint) for r in routes)



# --- review follow-ups ---------------------------------------------------------

@pytest.mark.parametrize("bad", [
    "sha256:" + "a" * 64,
    "a" * 64 + "  risk_cascade_v1.1.0.joblib",
    "a" * 63,
    "g" * 64,
])
def test_malformed_model_sha256_rejected_at_settings_time(bad):
    with pytest.raises(ValueError, match="64 hexadecimal"):
        ServiceSettings(MODEL_SHA256=bad)


def test_cors_origins_json_list_from_env(monkeypatch):
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", '["https://a.example", "https://b.example"]')
    assert ServiceSettings().CORS_ALLOW_ORIGINS == ["https://a.example", "https://b.example"]


def test_default_top_k_shap_setting_applies_when_request_omits_it():
    with TestClient(create_app(ServiceSettings(DEFAULT_TOP_K_SHAP=2))) as c:
        response = c.post("/evaluate", json={"transaction_id": "TXN_K2", "features": FEATURES_OK})
        assert response.status_code == 200
        assert len(response.json()["top_shap_features"]) == 2


def test_enable_shap_false_overrides_request():
    with TestClient(create_app(ServiceSettings(ENABLE_SHAP=False))) as c:
        payload = {"transaction_id": "TXN_NOSHAP", "features": FEATURES_OK, "include_shap": True, "top_k_shap": 3}
        response = c.post("/evaluate", json=payload)
        assert response.status_code == 200
        assert response.json()["top_shap_features"] == []


def test_raw_mode_parity_with_offset_and_naive_timestamps(client, agent_rows):
    """Rows sent as +03:00 (EAT) and as naive (taken as UTC) score like the UTC rows in the batch builder."""
    batch = build_feature_matrix(agent_rows).set_index("transaction_id")
    eat = pd.Timedelta(hours=3)

    def fmt(i: int, ts: pd.Timestamp) -> str:
        if i % 2 == 0:
            return (ts + eat).strftime("%Y-%m-%dT%H:%M:%S+03:00")
        return ts.strftime("%Y-%m-%dT%H:%M:%S")

    for idx in (3, 20, 40, len(agent_rows) - 1):
        payload = _raw_payload(agent_rows, idx, include_shap=False)
        payload["transaction"]["timestamp"] = fmt(idx, agent_rows.iloc[idx]["timestamp"])
        history = agent_rows.drop(index=agent_rows.index[idx]).reset_index(drop=True)
        for j, row in enumerate(payload["history"]):
            row["timestamp"] = fmt(j, history.iloc[j]["timestamp"])
        response = client.post("/evaluate", json=payload)
        assert response.status_code == 200, response.text
        expected = batch.loc[payload["transaction_id"], FEATURE_COLUMNS].to_numpy(dtype=float)
        got = np.array([response.json()["feature_vector"][c] for c in FEATURE_COLUMNS])
        np.testing.assert_allclose(got, expected, rtol=0, atol=1e-9)


def test_duplicate_history_transaction_ids_rejected(client, agent_rows):
    payload = _raw_payload(agent_rows, 10)
    payload["history"] = payload["history"] + [dict(payload["history"][0]), dict(payload["history"][0])]
    body = assert_nfr08(client.post("/evaluate", json=payload), 422)
    assert "duplicate" in json.dumps(body["errors"])


def test_raw_timestamp_outside_pandas_range_is_422(client):
    payload = {
        "transaction_id": "TXN_FAR_FUTURE",
        "transaction": {"agent_id": "AG_1", "timestamp": "2300-01-01T00:00:00Z",
                        "amount": 1500.0, "counterparty_id": "CP_1"},
        "history": [{"transaction_id": "H1", "agent_id": "AG_1", "timestamp": "2299-12-31T23:00:00Z",
                     "amount": 1000.0, "counterparty_id": "CP_1"}],
    }
    body = assert_nfr08(client.post("/evaluate", json=payload), 422)
    # Elicitation E3: rejected by schema validation, not by catching engine errors.
    locs = [e["loc"] for e in body["errors"]]
    assert ["body", "transaction", "timestamp"] in locs
    assert ["body", "history", "0", "timestamp"] in locs


def test_feature_computation_bug_is_500_not_422(client, agent_rows, monkeypatch):
    app_module = importlib.import_module("service.app")

    def broken(*_args, **_kwargs):
        raise ValueError("simulated engine bug")

    monkeypatch.setattr(app_module, "compute_features_from_history", broken)
    body = assert_nfr08(client.post("/evaluate", json=_raw_payload(agent_rows, 10)), 500)
    assert "simulated engine bug" not in json.dumps(body)


def test_history_older_than_lookback_is_ignored(client, agent_rows):
    payload = _raw_payload(agent_rows, 40)
    baseline = client.post("/evaluate", json=payload).json()["feature_vector"]
    t = pd.Timestamp(payload["transaction"]["timestamp"])
    stale = [{"transaction_id": f"OLD{i}", "agent_id": payload["transaction"]["agent_id"],
              "timestamp": _iso(t - pd.Timedelta(days=31 + i)), "amount": 99999.0,
              "counterparty_id": payload["transaction"]["counterparty_id"]} for i in range(5)]
    payload["history"] = stale + payload["history"]
    with_stale = client.post("/evaluate", json=payload).json()["feature_vector"]
    assert with_stale == baseline


def test_trim_keeps_rows_exactly_at_lookback_boundary():
    app_module = importlib.import_module("service.app")
    from engine.features import MAX_LOOKBACK_SECONDS

    t = pd.Timestamp("2026-03-31T12:00:00Z")
    rows = [("A", t - pd.Timedelta(seconds=MAX_LOOKBACK_SECONDS)), ("B", t - pd.Timedelta(seconds=MAX_LOOKBACK_SECONDS + 1))]
    kept = app_module._within_lookback([r[1].to_pydatetime() for r in rows], t.to_pydatetime())
    assert kept == [True, False]


def test_feature_vector_follows_pipeline_feature_columns(client):
    data = client.post("/evaluate", json={"transaction_id": "TXN_COLS", "features": FEATURES_OK}).json()
    assert list(data["feature_vector"]) == list(client.app.state.pipeline.feature_columns)
