"""
service/config.py
-----------------
Runtime settings for the SalesMesh ML Risk Engine FastAPI microservice,
read from environment variables by pydantic-settings (finding 33).

Environment variables (names unchanged from the original service, plus the
four introduced by the service-packaging spec):

=====================  ==========================================  =====================
Variable               Meaning                                     Default
=====================  ==========================================  =====================
MODEL_PATH             joblib artifact (``.sha256`` sidecar next   models/risk_cascade_v1.1.0.joblib
                       to it is mandatory)
MODEL_SHA256           pinned artifact digest (exactly 64 hex);    unset (sidecar only)
                       is refused on mismatch
HOST / PORT            bind address used by ``run_server.py``      localhost / 8000
ENVIRONMENT            free-text deployment label                  development
DEFAULT_TOP_K_SHAP     SHAP attributions returned when the         3
                       request omits ``top_k_shap`` (1-6)
ENABLE_SHAP            global SHAP switch                          true
CORS_ALLOW_ORIGINS     comma-separated (or JSON list) origins;     empty -> no CORS
                       empty disables CORS entirely
MAX_REQUEST_BYTES      request body limit, chunked bodies          524288
                       included (413 above it)
MAX_HISTORY_ROWS       max ``history`` rows in raw mode (422)      2000
=====================  ==========================================  =====================

``FAIL_SAFE_DECISION`` is fixed to ``QUARANTINE`` (NFR-08) and cannot be
configured to anything else.
"""

import json
import re
from pathlib import Path
from typing import Annotated, Any, List, Literal, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_ROOT = Path(__file__).resolve().parent.parent
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")


class ServiceSettings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=True, extra="ignore")

    BASE_DIR: Path = _ROOT
    MODEL_PATH: str = Field(
        default=str(_ROOT / "models" / "risk_cascade_v1.1.0.joblib"),
        description="Filesystem path to the serialized RiskCascadePipeline joblib artifact",
    )
    MODEL_SHA256: Optional[str] = Field(
        default=None,
        description="Pinned SHA-256 of the artifact, held outside models/; load is refused on mismatch",
    )

    HOST: str = Field(default="localhost", description="Host address to bind")
    PORT: int = Field(default=8000, ge=1, le=65535, description="Port to listen on")
    ENVIRONMENT: str = Field(default="development", description="Deployment environment label")

    DEFAULT_TOP_K_SHAP: int = Field(default=3, ge=1, le=6, description="Default number of SHAP attributions")
    ENABLE_SHAP: bool = Field(default=True, description="Toggle SHAP explanation generation")

    CORS_ALLOW_ORIGINS: Annotated[List[str], NoDecode] = Field(
        default_factory=list,
        description="Origins allowed by CORS; empty (default) installs no CORS middleware",
    )
    MAX_REQUEST_BYTES: int = Field(default=524288, ge=1, description="Maximum request body size in bytes")
    MAX_HISTORY_ROWS: int = Field(default=2000, ge=0, description="Maximum history rows in raw /evaluate mode")

    FAIL_SAFE_DECISION: Literal["QUARANTINE"] = Field(
        default="QUARANTINE",
        description="Fail-safe decision the gateway must apply on any ML failure (NFR-08); not configurable",
    )

    @field_validator("MODEL_SHA256", mode="before")
    @classmethod
    def _normalise_digest(cls, value: Any) -> Any:
        if value is None:
            return None
        text = str(value).strip().lower()
        if not text:
            return None
        # Exactly the bare 64-hex digest: no "sha256:" prefix, no "  <filename>" suffix.
        if not _SHA256_HEX.fullmatch(text):
            raise ValueError("MODEL_SHA256 must be exactly 64 hexadecimal characters (the bare SHA-256 digest)")
        return text

    @field_validator("CORS_ALLOW_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                return json.loads(text)
            return [part.strip() for part in text.split(",") if part.strip()]
        return value


settings = ServiceSettings()
