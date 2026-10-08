"""
service/app.py
--------------
FastAPI microservice for the SalesMesh ML Risk Assessment Engine (Module 2).
Exposes ``POST /evaluate``, ``GET /health`` and ``GET /model/info``.

Hardening (findings 28-34 and the service-packaging spec):

* Handlers are plain ``def`` so CPU-bound inference runs in the threadpool
  instead of blocking the event loop.
* A pure-ASGI limiter caps request bodies at ``MAX_REQUEST_BYTES``, counting
  chunked bodies as well as declared ``Content-Length`` (413).
* CORS is installed only when ``CORS_ALLOW_ORIGINS`` is non-empty, never with
  credentials.
* The lifespan loads the artifact with the pinned ``MODEL_SHA256`` and records
  a short ``load_error`` category (full detail is logged server-side only);
  ``/health`` returns 503 until a model is loaded.
* Every non-2xx body carries ``fail_safe_recommendation: "QUARANTINE"`` and
  ``policy_reference`` (NFR-08), and never a stack trace.
"""

import logging
import os
import sys
import time
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Add project root to sys.path so engine is importable
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_ROOT = os.path.dirname(CURRENT_DIR)
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

from engine.cascade import SHAP_UNITS, ArtifactIntegrityError, RiskCascadePipeline
from engine.features import MAX_LOOKBACK_SECONDS, compute_features_from_history
from service.config import ServiceSettings, settings
from service.schemas import (
    POLICY_REFERENCE,
    ErrorResponse,
    EvaluateRequest,
    EvaluateResponse,
    HealthResponse,
    ModelInfoResponse,
    ShapFeature,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("salesmesh.ml_engine")

_HISTORY_COLUMNS = ["transaction_id", "agent_id", "timestamp", "amount", "counterparty_id"]
_ERROR_NAMES = {
    400: "BadRequest",
    404: "NotFound",
    405: "MethodNotAllowed",
    413: "PayloadTooLarge",
    422: "UnprocessableEntity",
    500: "InternalServerError",
    503: "ServiceUnavailable",
}


def fail_safe_cause(status_code: int) -> Tuple[str, bool]:
    """
    (cause, retryable) for a non-2xx status. Outage and inference failures are
    retryable, so the gateway can re-score those quarantines once the service
    recovers; request failures are not (the request itself must change).
    """
    if status_code == 503:
        return "service_unavailable", True
    if status_code >= 500:
        return "inference_error", True
    if status_code == 413:
        return "payload_too_large", False
    return "invalid_request", False


def error_body(status_code: int, message: str, errors: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The NFR-08 error body shared by every non-2xx response."""
    cause, retryable = fail_safe_cause(status_code)
    body = ErrorResponse(
        error=_ERROR_NAMES.get(status_code, "HTTPError"),
        message=message,
        fail_safe_cause=cause,
        retryable=retryable,
        errors=errors,
    ).model_dump()
    if errors is None:
        body.pop("errors")
    return body


class BodySizeLimitMiddleware:
    """
    Pure-ASGI request-body limiter. Rejects a declared ``Content-Length`` above
    ``max_bytes`` immediately; otherwise buffers the body (at most
    ``max_bytes``) counting every ``http.request`` chunk, so chunked
    transfer-encoding cannot bypass the limit, and replays it to the app.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = int(max_bytes)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            content=error_body(413, f"Request body exceeds MAX_REQUEST_BYTES ({self.max_bytes} bytes)."),
        )
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
                if declared is not None and declared > self.max_bytes:
                    await self._reject(scope, receive, send)
                    return

        chunks: List[bytes] = []
        total = 0
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > self.max_bytes:
                await self._reject(scope, receive, send)
                return
            chunks.append(chunk)
            more_body = bool(message.get("more_body", False))

        body = b"".join(chunks)
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


class ResponseTimeHeaderMiddleware:
    """Pure-ASGI middleware adding ``X-Response-Time-Ms`` to every response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()

        async def send_with_timing(message: Message) -> None:
            if message["type"] == "http.response.start":
                elapsed_ms = (time.perf_counter() - start) * 1000.0
                headers = list(message.get("headers", []))
                headers.append((b"x-response-time-ms", f"{elapsed_ms:.2f}".encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_timing)


#: Short, non-sensitive categories exposed to callers when the model is not loaded.
#: Paths, digests and library versions are logged server-side only.
LOAD_ERROR_MISSING = "artifact_missing"
LOAD_ERROR_INTEGRITY = "integrity_mismatch"
LOAD_ERROR_LIBRARY = "library_mismatch"
LOAD_ERROR_FAILED = "load_failed"


def _classify_load_error(exc: Exception) -> str:
    if isinstance(exc, ArtifactIntegrityError):
        # cascade.load raises one exception type; library checks are the "Library version mismatch" branch.
        return LOAD_ERROR_LIBRARY if str(exc).startswith("Library version mismatch") else LOAD_ERROR_INTEGRITY
    return LOAD_ERROR_FAILED


def _load_pipeline(app: FastAPI, cfg: ServiceSettings) -> None:
    app.state.pipeline = None
    app.state.load_error = None
    model_path = cfg.MODEL_PATH
    if cfg.ENVIRONMENT.strip().lower() == "production" and not cfg.MODEL_SHA256:
        logger.warning("ENVIRONMENT=production but MODEL_SHA256 is not set: only the co-located sidecar "
                       "protects the artifact; pin its digest outside models/.")
    if not os.path.exists(model_path):
        app.state.load_error = LOAD_ERROR_MISSING
        logger.error("Critical [%s]: model artifact not found at %s", LOAD_ERROR_MISSING, model_path)
        return
    try:
        logger.info("Loading RiskCascadePipeline artifact from: %s (pinned digest: %s)",
                    model_path, "yes" if cfg.MODEL_SHA256 else "no")
        t0 = time.perf_counter()
        pipeline = RiskCascadePipeline.load(model_path, expected_sha256=cfg.MODEL_SHA256)
    except Exception as exc:  # any load failure leaves the service not-ready (503), never half-loaded
        app.state.load_error = _classify_load_error(exc)
        logger.exception("Critical [%s]: model artifact failed to load: %s: %s",
                         app.state.load_error, type(exc).__name__, exc)
        return
    app.state.pipeline = pipeline
    logger.info(
        "Model loaded in %.2f ms [version %s, sha256 %s, %d features]",
        (time.perf_counter() - t0) * 1000.0, pipeline.model_version, pipeline.artifact_sha256,
        len(pipeline.feature_columns),
    )


def _ready_pipeline(request: Request) -> RiskCascadePipeline:
    pipeline: Optional[RiskCascadePipeline] = getattr(request.app.state, "pipeline", None)
    if pipeline is None:
        reason = getattr(request.app.state, "load_error", None) or LOAD_ERROR_FAILED
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Model artifact is not loaded ({reason}); apply the fail-safe decision.",
        )
    return pipeline


def _within_lookback(history_times: List[datetime], t: datetime) -> List[bool]:
    """True for rows at or after ``t - MAX_LOOKBACK_SECONDS``; older rows never influence a feature."""
    cutoff = t - timedelta(seconds=MAX_LOOKBACK_SECONDS)
    return [ts >= cutoff for ts in history_times]


def _raw_features(payload: EvaluateRequest) -> Dict[str, float]:
    txn = payload.transaction
    # Drop rows older than the longest feature window before building the frame (latency only:
    # compute_features_from_history would ignore them anyway).
    keep = _within_lookback([row.timestamp for row in payload.history], txn.timestamp)
    history = pd.DataFrame(
        [[row.transaction_id, row.agent_id, row.timestamp, row.amount, row.counterparty_id]
         for row, k in zip(payload.history, keep) if k],
        columns=_HISTORY_COLUMNS,
    )
    return compute_features_from_history(
        history,
        {
            "transaction_id": payload.transaction_id,
            "agent_id": txn.agent_id,
            "timestamp": txn.timestamp,
            "amount": txn.amount,
            "counterparty_id": txn.counterparty_id,
        },
    )


def create_app(app_settings: Optional[ServiceSettings] = None) -> FastAPI:
    """Builds the service. Tests pass their own settings for isolated app instances."""
    cfg = app_settings if app_settings is not None else settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Initializing ML Risk Engine microservice (environment: %s)", cfg.ENVIRONMENT)
        app.state.start_time = time.time()
        _load_pipeline(app, cfg)
        yield
        logger.info("Shutting down ML Risk Engine microservice")

    app = FastAPI(
        title="SalesMesh ML Risk Assessment Microservice",
        description=(
            "Module 2 Analytical Core: two-layer cascade (unsupervised Isolation Forest + supervised "
            "isotonic-calibrated XGBoost with SHAP attributions) for retail commission fraud detection."
        ),
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.settings = cfg
    app.state.pipeline = None
    app.state.load_error = LOAD_ERROR_FAILED

    # Middleware: the last added is the outermost -> CORS > timing > body limit, so a 413
    # still carries CORS and X-Response-Time-Ms headers.
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=cfg.MAX_REQUEST_BYTES)
    app.add_middleware(ResponseTimeHeaderMiddleware)
    if cfg.CORS_ALLOW_ORIGINS:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cfg.CORS_ALLOW_ORIGINS),
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )

    # ------------------------------------------------------------------
    # Error handlers (NFR-08 body everywhere)
    # ------------------------------------------------------------------
    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.status_code, str(exc.detail)),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Only loc/msg/type: raw inputs (e.g. NaN) and exception objects are not JSON-safe.
        errors = [
            {"loc": [str(p) for p in err.get("loc", ())], "msg": str(err.get("msg", "")), "type": str(err.get("type", ""))}
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=error_body(422, "Request failed validation.", errors=errors),
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception during %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=error_body(500, "An unexpected error occurred during risk assessment."),
        )

    # ------------------------------------------------------------------
    # Routes (sync: run in the threadpool)
    # ------------------------------------------------------------------
    error_responses = {
        code: {"model": ErrorResponse} for code in (413, 422, 500, 503)
    }

    @app.get(
        "/health",
        response_model=HealthResponse,
        summary="Readiness probe",
        tags=["System"],
        responses={503: {"model": HealthResponse}},
    )
    def health_check(request: Request):
        """200 ``healthy`` when the model is loaded; 503 ``unhealthy`` with a reason otherwise."""
        pipeline: Optional[RiskCascadePipeline] = getattr(request.app.state, "pipeline", None)
        uptime = round(time.time() - getattr(request.app.state, "start_time", time.time()), 2)
        if pipeline is not None:
            return HealthResponse(
                status="healthy",
                model_version=pipeline.model_version,
                model_loaded=True,
                model_sha256=pipeline.artifact_sha256,
                feature_columns=pipeline.feature_columns,
                uptime_seconds=uptime,
            )
        body = HealthResponse(
            status="unhealthy",
            model_version="unavailable",
            model_loaded=False,
            feature_columns=[],
            uptime_seconds=uptime,
            reason=getattr(request.app.state, "load_error", None) or LOAD_ERROR_FAILED,
            fail_safe_recommendation="QUARANTINE",
            policy_reference=POLICY_REFERENCE,
            fail_safe_cause=fail_safe_cause(503)[0],
            retryable=fail_safe_cause(503)[1],
        )
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=body.model_dump())

    @app.get(
        "/model/info",
        response_model=ModelInfoResponse,
        summary="Model metadata and thresholds",
        tags=["System"],
        responses={503: {"model": ErrorResponse}},
    )
    def model_info(request: Request) -> ModelInfoResponse:
        """Thresholds, training metadata, artifact digest and library versions (NFR-09 traceability)."""
        pipeline = _ready_pipeline(request)
        return ModelInfoResponse(
            model_version=pipeline.model_version,
            model_sha256=pipeline.artifact_sha256,
            feature_columns=pipeline.feature_columns,
            thresholds={
                "quarantine_isolation_threshold": pipeline.quarantine_isolation_threshold,
                "quarantine_xgb_threshold": pipeline.quarantine_xgb_threshold,
                "filter_isolation_threshold": pipeline.filter_isolation_threshold,
                "review_xgb_threshold": pipeline.review_xgb_threshold,
            },
            review_xgb_threshold=pipeline.review_xgb_threshold,
            training_metadata=pipeline.training_metadata,
            library_versions=dict(pipeline.training_metadata.get("library_versions", {})),
            shap_attribution_units=pipeline.training_metadata.get("shap_attribution_units", SHAP_UNITS),
            decision_policy={
                "bypass_layer2_on_extreme_anomaly": pipeline.bypass_layer2_on_extreme_anomaly,
                "calibration_method": "isotonic",
                "layer1_target_budget_ms": 30.0,
            },
        )

    @app.post(
        "/evaluate",
        response_model=EvaluateResponse,
        summary="Evaluate transaction risk",
        tags=["Risk Assessment"],
        responses=error_responses,
    )
    def evaluate_transaction(payload: EvaluateRequest, request: Request) -> EvaluateResponse:
        """
        Scores one transaction through the two-layer cascade.

        * features mode: the 6 engineered features (nested or flat);
        * raw mode: ``transaction`` + the agent's ``history``; features are
          computed with ``engine.features.compute_features_from_history``,
          the same function the training batch builder uses.

        Routing: s >= 0.72 -> QUARANTINE (layer 1 bypass); s < 0.45 -> CLEAR
        (layer 1 fast-clear); otherwise calibrated p >= 0.85 -> QUARANTINE,
        0.50 <= p < 0.85 -> REVIEW, else CLEAR (layer 2).
        """
        if payload.history is not None and len(payload.history) > cfg.MAX_HISTORY_ROWS:
            raise RequestValidationError([{
                "loc": ("body", "history"),
                "msg": f"history has {len(payload.history)} rows; MAX_HISTORY_ROWS is {cfg.MAX_HISTORY_ROWS}",
                "type": "too_long",
            }])
        pipeline = _ready_pipeline(request)

        t_start = time.perf_counter()
        try:
            # Input ranges (timestamps included) are enforced by the schema, so a failure from here
            # on is a service fault: logged, 500, retryable - never blamed on the request.
            features = _raw_features(payload) if payload.mode == "raw" else payload.get_feature_dict()
            result = pipeline.evaluate_transaction(
                features,
                include_shap=payload.include_shap and cfg.ENABLE_SHAP,
                top_k_shap=payload.top_k_shap if payload.top_k_shap is not None else cfg.DEFAULT_TOP_K_SHAP,
            )
        except Exception:
            logger.exception("Inference failure on transaction %s", payload.transaction_id)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Inference failure; apply the fail-safe decision.",
            ) from None
        latency_ms = (time.perf_counter() - t_start) * 1000.0

        return EvaluateResponse(
            transaction_id=payload.transaction_id,
            isolation_score=result["isolation_score"],
            xgb_probability=result["xgb_probability"],
            model_version=result["model_version"],
            model_sha256=pipeline.artifact_sha256,
            decision=result["decision"],
            triggered_layer=result["triggered_layer"],
            layer2_adjudicated=result["layer2_adjudicated"],
            reason=result["reason"],
            feature_vector={c: features[c] for c in pipeline.feature_columns},
            top_shap_features=[ShapFeature(**item) for item in result["top_shap_features"]],
            latency_ms=round(latency_ms, 2),
        )

    return app


app = create_app()
