"""
service/schemas.py
------------------
Pydantic v2 request/response contracts for the SalesMesh ML Risk Assessment
microservice (Module 2), consumed by the Node.js gateway and persisted for
ledger audit traceability.

``POST /evaluate`` accepts EXACTLY ONE of two modes:

* **features** - the 6 engineered features, either nested under ``features``
  or flat at the top level (both together are accepted only when every flat
  value equals its nested counterpart);
* **raw** - ``transaction`` plus the agent's ``history``; the service
  computes the features with the engine's shared
  ``compute_features_from_history`` (train/serve parity, decision Q9).

All inputs forbid unknown fields and reject NaN/Infinity (findings 28, 34);
nothing is ever defaulted.
"""

from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional

import numpy as np
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from engine.cascade import SHAP_UNITS
from engine.features import FEATURE_COLUMNS

POLICY_REFERENCE = "NFR-08: Gateway shall default to QUARANTINE rather than CLEAR upon ML service failure."
MAX_AMOUNT_KES = 1e12

FailSafeCause = Literal["service_unavailable", "inference_error", "invalid_request", "payload_too_large"]

_STRICT_INPUT = ConfigDict(allow_inf_nan=False, extra="forbid")
_FLOAT32_MAX = float(np.finfo(np.float32).max)


def _within_float32(value: float) -> float:
    # The compiled Isolation Forest scores in float32, like sklearn's trees.
    if abs(value) > _FLOAT32_MAX:
        raise ValueError("value is beyond the float32 range used by the model")
    return value


# pandas' datetime64[ns] range, which the feature engine computes in.
MIN_TIMESTAMP = datetime(1678, 1, 1, tzinfo=timezone.utc)
MAX_TIMESTAMP = datetime(2261, 12, 31, tzinfo=timezone.utc)


def _as_utc(value: datetime) -> datetime:
    # Naive timestamps are taken to be UTC, matching engine.features.normalise_timestamps.
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    if not MIN_TIMESTAMP <= value <= MAX_TIMESTAMP:
        raise ValueError(f"timestamp must be between {MIN_TIMESTAMP:%Y-%m-%d} and {MAX_TIMESTAMP:%Y-%m-%d} (UTC)")
    return value


ModelFloat = Annotated[float, AfterValidator(_within_float32)]
UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]
Identifier = Annotated[str, Field(min_length=1, max_length=128)]
AmountKES = Annotated[float, Field(gt=0.0, le=MAX_AMOUNT_KES, description="Transaction amount (KES)")]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class RiskFeatureVector(BaseModel):
    """The 6 causal behavioural features engineered in Module 2 (engine/features.py)."""
    model_config = _STRICT_INPUT

    velocity_v_i: ModelFloat = Field(
        ..., ge=0.0, description="Instantaneous transaction velocity (transactions/hour, thesis Eq. 3.1)",
        examples=[3.5],
    )
    split_ratio_r_s: ModelFloat = Field(
        ..., ge=0.0, le=1.0, description="Sub-theta structuring split ratio (thesis Eq. 3.2)", examples=[0.12],
    )
    entropy_gaps: ModelFloat = Field(
        ..., ge=0.0, description="Shannon entropy (bits) of inter-transaction gaps over 5 fixed log bins",
        examples=[1.25],
    )
    agent_zscore: ModelFloat = Field(
        ..., description="Amount z-score against the agent's prior 30-day baseline", examples=[0.15],
    )
    amount_to_median_ratio: ModelFloat = Field(
        ..., ge=0.0, description="Amount relative to the agent's prior 30-day median", examples=[1.05],
    )
    recipient_reuse_count: ModelFloat = Field(
        ..., ge=0.0, description="Prior transactions to the same counterparty in the last 24 h", examples=[0.0],
    )


class RawTransaction(BaseModel):
    """The transaction being evaluated (raw mode). Its id is the request's ``transaction_id``."""
    model_config = _STRICT_INPUT

    agent_id: Identifier = Field(..., description="Originating sales agent identifier", examples=["AG_042"])
    timestamp: UtcDatetime = Field(
        ..., description="ISO-8601 time of the transaction; naive values are taken as UTC",
        examples=["2026-10-01T10:00:00Z"],
    )
    amount: AmountKES = Field(..., examples=[4500.0])
    counterparty_id: Identifier = Field(..., description="Destination counterparty identifier", examples=["CP_991"])


class HistoryRow(BaseModel):
    """One previously observed transaction of the SAME agent (raw mode)."""
    model_config = _STRICT_INPUT

    transaction_id: Identifier = Field(
        ..., description="Receipt id; breaks same-second ties exactly as the training batch builder does",
    )
    agent_id: Identifier
    timestamp: UtcDatetime
    amount: AmountKES
    counterparty_id: Identifier


class EvaluateRequest(BaseModel):
    """
    Request payload for transaction risk evaluation. Provide exactly one mode:
    ``features`` (nested or flat) or ``transaction`` + ``history`` (raw).
    """
    model_config = _STRICT_INPUT

    transaction_id: Identifier = Field(
        ..., description="Unique transaction receipt or event identifier", examples=["TXN_20261001_882910"],
    )
    agent_id: Optional[Identifier] = Field(default=None, description="Originating sales agent identifier")
    counterparty_id: Optional[Identifier] = Field(default=None, description="Destination counterparty identifier")
    amount: Optional[AmountKES] = None

    # Features mode
    features: Optional[RiskFeatureVector] = Field(default=None, description="Nested 6-feature vector")
    velocity_v_i: Optional[ModelFloat] = Field(default=None, ge=0.0)
    split_ratio_r_s: Optional[ModelFloat] = Field(default=None, ge=0.0, le=1.0)
    entropy_gaps: Optional[ModelFloat] = Field(default=None, ge=0.0)
    agent_zscore: Optional[ModelFloat] = Field(default=None)
    amount_to_median_ratio: Optional[ModelFloat] = Field(default=None, ge=0.0)
    recipient_reuse_count: Optional[ModelFloat] = Field(default=None, ge=0.0)

    # Raw mode
    transaction: Optional[RawTransaction] = Field(default=None, description="Raw transaction (raw mode)")
    history: Optional[List[HistoryRow]] = Field(
        default=None,
        description="The agent's prior transactions (raw mode; may be empty). Rows of other agents are rejected; "
                    "rows stamped after the transaction are ignored. Size is capped by MAX_HISTORY_ROWS.",
    )

    include_shap: bool = Field(default=True, description="Include top SHAP feature attributions")
    top_k_shap: Optional[int] = Field(
        default=None, ge=1, le=6, description="Number of SHAP features to return (default: DEFAULT_TOP_K_SHAP)",
    )

    @model_validator(mode="after")
    def _exactly_one_mode(self) -> "EvaluateRequest":
        flat = {k: getattr(self, k) for k in FEATURE_COLUMNS if getattr(self, k) is not None}
        features_mode = self.features is not None or bool(flat)
        raw_mode = self.transaction is not None or self.history is not None

        if features_mode and raw_mode:
            raise ValueError("Provide exactly one mode: 'features' (nested or flat) OR 'transaction' + 'history', not both")
        if not features_mode and not raw_mode:
            raise ValueError("Provide exactly one mode: 'features' (nested or flat) OR 'transaction' + 'history'")

        if raw_mode:
            if self.transaction is None or self.history is None:
                raise ValueError("Raw mode requires both 'transaction' and 'history' (history may be an empty list)")
            txn = self.transaction
            for name in ("agent_id", "counterparty_id", "amount"):
                top = getattr(self, name)
                if top is not None and top != getattr(txn, name):
                    raise ValueError(f"Top-level '{name}' ({top!r}) conflicts with transaction.{name}")
            foreign = sorted({row.agent_id for row in self.history if row.agent_id != txn.agent_id})
            if foreign:
                raise ValueError(
                    f"history contains rows whose agent_id differs from transaction.agent_id "
                    f"({txn.agent_id!r}): {foreign[:5]}"
                )
            seen, duplicates = set(), set()
            for row in self.history:
                (duplicates if row.transaction_id in seen else seen).add(row.transaction_id)
            if duplicates:
                raise ValueError(f"history contains duplicate transaction_id values: {sorted(duplicates)[:5]}")
            return self

        if self.features is None:
            missing = [k for k in FEATURE_COLUMNS if k not in flat]
            if missing:
                raise ValueError(f"Incomplete flat feature vector. Missing fields: {missing}")
            self.features = RiskFeatureVector(**flat)
        else:
            nested = self.features.model_dump()
            conflicting = sorted(k for k, v in flat.items() if v != nested[k])
            if conflicting:
                raise ValueError(f"Flat feature fields conflict with nested 'features': {conflicting}")
        return self

    @property
    def mode(self) -> Literal["features", "raw"]:
        return "raw" if self.transaction is not None else "features"

    def get_feature_dict(self) -> Dict[str, float]:
        """The validated feature vector (features mode only); never defaulted."""
        if self.features is None:
            raise ValueError("get_feature_dict() is only defined in features mode")
        return self.features.model_dump()


class FeatureVectorOut(BaseModel):
    """The 6 feature values actually scored (echoed or computed in raw mode); output only, unconstrained."""
    velocity_v_i: float
    split_ratio_r_s: float
    entropy_gaps: float
    agent_zscore: float
    amount_to_median_ratio: float
    recipient_reuse_count: float


class ShapFeature(BaseModel):
    """One SHAP TreeExplainer attribution."""
    feature: str = Field(..., description="Name of the behavioural feature")
    attribution: float = Field(
        ...,
        description="SHAP value in UNCALIBRATED XGBoost log-odds (margin) units: + pushes toward fraud, - toward "
                    "benign. It explains the raw margin, not the calibrated xgb_probability.",
    )
    value: float = Field(..., description="Value of the feature for this transaction")


class EvaluateResponse(BaseModel):
    """
    Risk decision emitted by the ML microservice, persisted to the ledger
    (Module 3) for audit and traceability (NFR-09).
    """
    transaction_id: str = Field(..., description="Associated transaction receipt or ID")
    isolation_score: float = Field(
        ..., ge=0.0, le=1.0, description="Layer 1 Isolation Forest anomaly score s(x, n)", examples=[0.4215],
    )
    xgb_probability: float = Field(
        ..., ge=0.0, le=1.0,
        description="Isotonic-calibrated XGBoost P(fraud | x), always computed. When layer2_adjudicated is false it "
                    "did not drive the decision and is an audit value only.",
        examples=[0.0241],
    )
    model_version: str = Field(..., description="Identifier of the trained model artifact (NFR-09)", examples=["v1.0.0"])
    model_sha256: str = Field(..., description="SHA-256 of the loaded model artifact (NFR-09)")
    decision: Literal["CLEAR", "QUARANTINE", "REVIEW"] = Field(
        ..., description="CLEAR (advance to escrow), QUARANTINE (freeze), REVIEW (flagged)", examples=["CLEAR"],
    )
    triggered_layer: int = Field(..., description="Layer that made the decision (1 Isolation Forest, 2 XGBoost)")
    layer2_adjudicated: bool = Field(..., description="True when the calibrated XGBoost probability drove the decision")
    reason: str = Field(..., description="Human-readable decision rationale for audit trails")
    feature_vector: FeatureVectorOut = Field(..., description="The 6 feature values the model scored")
    top_shap_features: List[ShapFeature] = Field(
        default_factory=list, description="Top local attributions, ranked by |value| (units: shap_attribution_units)",
    )
    shap_attribution_units: str = Field(
        default=SHAP_UNITS, description="Units of top_shap_features[].attribution: uncalibrated XGBoost log-odds",
    )
    latency_ms: float = Field(..., description="Feature computation + inference latency in milliseconds")
    evaluated_at: str = Field(default_factory=_utc_now_iso, description="UTC timestamp of the assessment")


class HealthResponse(BaseModel):
    """Readiness probe body: 200 when the model is loaded, 503 otherwise."""
    status: Literal["healthy", "unhealthy"]
    model_version: str
    model_loaded: bool
    model_sha256: Optional[str] = None
    feature_columns: List[str]
    uptime_seconds: float
    reason: Optional[str] = Field(default=None, description="Why the service is not ready (503 only)")
    fail_safe_recommendation: Optional[Literal["QUARANTINE"]] = None
    policy_reference: Optional[str] = None
    fail_safe_cause: Optional[FailSafeCause] = None
    retryable: Optional[bool] = None
    timestamp: str = Field(default_factory=_utc_now_iso)


class ModelInfoResponse(BaseModel):
    """Model metadata for ledger synchronisation and drift auditing."""
    model_version: str
    model_sha256: str
    feature_columns: List[str]
    thresholds: Dict[str, float]
    review_xgb_threshold: float
    training_metadata: Dict[str, Any]
    library_versions: Dict[str, str]
    shap_attribution_units: str
    decision_policy: Dict[str, Any]


class ErrorResponse(BaseModel):
    """Body of every non-2xx response (NFR-08)."""
    error: str
    message: str
    fail_safe_recommendation: Literal["QUARANTINE"] = "QUARANTINE"
    policy_reference: str = POLICY_REFERENCE
    fail_safe_cause: FailSafeCause = Field(
        ..., description="Why the fail-safe applies: outage and inference causes are retryable, request causes are not",
    )
    retryable: bool = Field(
        ..., description="True when re-submitting the same request later may succeed (re-score the quarantine)",
    )
    errors: Optional[List[Dict[str, Any]]] = None
