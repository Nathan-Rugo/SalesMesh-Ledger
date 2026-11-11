"""
cascade.py
----------
Two-layer risk cascade for SalesMesh (Module 2, directive Section 5).

Layer 1 - Isolation Forest (Liu et al., 2008), scored through the compiled
traversal in ``fast_iforest.py``. Anomaly score s = -score_samples(x).

Layer 2 - XGBoost (Chen & Guestrin, 2016) trained on the Layer-1 candidate
cohort (s >= 0.45, decision Q1), with isotonic calibration
(Niculescu-Mizil & Caruana, 2005) fitted on the VALIDATION candidate
cohort - the population Layer 2 actually adjudicates (finding 14).

Routing (decisions Q2, Q3; thresholds fixed, never tuned on test)::

    s >= 0.72 and bypass on     -> QUARANTINE  (layer 1)
    s <  0.45 (fast-clear)      -> CLEAR       (layer 1)
    otherwise, p = calibrated P(fraud | x):
        p >= 0.85               -> QUARANTINE  (layer 2)
        0.50 <= p < 0.85        -> REVIEW      (layer 2)
        p <  0.50               -> CLEAR       (layer 2)

The calibrated p is ALWAYS computed and returned (it feeds the NOT NULL
``VERIFICATION_EVENTS.xgboost_fraud_prob`` audit column), together with
``layer2_adjudicated`` saying whether p drove the decision (finding 16).
For fast-cleared rows p is out of distribution (the calibrator never saw
s < 0.45) and is an audit value only.

Operating score (finding 22) ranks rows exactly as the cascade routes them::

    fast-clear -> s / 0.45  in [0, 1)
    layer 2    -> 1 + p     in [1, 2]
    bypass     -> 2 + s     in [2.72, 3]

SHAP attributions come from ``shap.TreeExplainer`` on the raw XGBoost
model and are in LOG-ODDS (margin) units of the UNCALIBRATED model - they
explain the raw margin, not the calibrated probability (finding 20).
"""

import hashlib
import io
import logging
import os
import platform
import warnings
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Union

import joblib
import numpy as np
import pandas as pd
import shap
import sklearn
import xgboost as xgb
from sklearn.ensemble import IsolationForest
from sklearn.isotonic import IsotonicRegression

from engine.fast_iforest import CompiledIsolationForest
from engine.features import FEATURE_COLUMNS

logger = logging.getLogger("salesmesh.ml_engine.cascade")

MAX_MODEL_VERSION_LENGTH = 20  # DB column is VARCHAR(20)
SHAP_UNITS = "xgboost_log_odds_margin_uncalibrated"
_EXACT_VERSION_LIBS = ("scikit-learn", "xgboost")
_MINOR_VERSION_LIBS = ("numpy", "joblib")

CLEAR, REVIEW, QUARANTINE = "CLEAR", "REVIEW", "QUARANTINE"


class ArtifactIntegrityError(ValueError):
    """Raised when a model artifact fails its hash or library-version check."""


def library_versions() -> Dict[str, str]:
    """Versions of every library whose objects are pickled into the artifact."""
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "scikit-learn": sklearn.__version__,
        "xgboost": xgb.__version__,
        "shap": shap.__version__,
        "joblib": joblib.__version__,
    }


def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _major_minor(version: str) -> str:
    return ".".join(version.split(".")[:2])


class RiskCascadePipeline:
    """Two-layer risk cascade: compiled Isolation Forest + calibrated XGBoost."""

    def __init__(
        self,
        model_version: str = "v1.1.0",
        isolation_contamination: float = 0.01,
        isolation_estimators: int = 100,
        xgb_max_depth: int = 6,
        xgb_learning_rate: float = 0.1,
        quarantine_isolation_threshold: float = 0.72,
        quarantine_xgb_threshold: float = 0.85,
        filter_isolation_threshold: float = 0.45,
        review_xgb_threshold: float = 0.50,
        bypass_layer2_on_extreme_anomaly: bool = True,
        feature_columns: Optional[List[str]] = None,
        random_state: int = 42,
    ):
        if not model_version or len(model_version) > MAX_MODEL_VERSION_LENGTH:
            raise ValueError(
                f"model_version must be 1-{MAX_MODEL_VERSION_LENGTH} characters, got {model_version!r}"
            )
        for name, value in (
            ("quarantine_isolation_threshold", quarantine_isolation_threshold),
            ("quarantine_xgb_threshold", quarantine_xgb_threshold),
            ("filter_isolation_threshold", filter_isolation_threshold),
            ("review_xgb_threshold", review_xgb_threshold),
        ):
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be in [0, 1], got {value}")
        if filter_isolation_threshold >= quarantine_isolation_threshold:
            raise ValueError(
                f"filter_isolation_threshold ({filter_isolation_threshold}) must be < "
                f"quarantine_isolation_threshold ({quarantine_isolation_threshold})"
            )
        if review_xgb_threshold > quarantine_xgb_threshold:
            raise ValueError(
                f"review_xgb_threshold ({review_xgb_threshold}) must be <= "
                f"quarantine_xgb_threshold ({quarantine_xgb_threshold})"
            )

        self.model_version = model_version
        self.isolation_contamination = isolation_contamination
        self.isolation_estimators = isolation_estimators
        self.xgb_max_depth = xgb_max_depth
        self.xgb_learning_rate = xgb_learning_rate
        self.quarantine_isolation_threshold = quarantine_isolation_threshold
        self.quarantine_xgb_threshold = quarantine_xgb_threshold
        self.filter_isolation_threshold = filter_isolation_threshold
        self.review_xgb_threshold = review_xgb_threshold
        self.bypass_layer2_on_extreme_anomaly = bypass_layer2_on_extreme_anomaly
        self.feature_columns = list(feature_columns or FEATURE_COLUMNS)
        self.random_state = random_state

        self.isolation_forest: Optional[IsolationForest] = None
        self.compiled_forest: Optional[CompiledIsolationForest] = None
        self.xgb_model: Optional[xgb.XGBClassifier] = None
        self.calibrator: Optional[IsotonicRegression] = None
        self.explainer: Optional[shap.TreeExplainer] = None
        self.training_metadata: Dict[str, Any] = {}
        self.artifact_sha256: Optional[str] = None

    # ------------------------------------------------------------------
    # Feature extraction (strict - finding 18)
    # ------------------------------------------------------------------
    def _extract_features(self, data: Union[pd.DataFrame, pd.Series, Mapping[str, Any], np.ndarray]) -> np.ndarray:
        """
        Returns an (n, 6) float array in ``feature_columns`` order. Raises
        ValueError naming any feature that is missing, non-numeric, NaN or
        infinite - nothing is ever defaulted.
        """
        if isinstance(data, pd.DataFrame):
            missing = [c for c in self.feature_columns if c not in data.columns]
            if missing:
                raise ValueError(f"Missing feature column(s): {missing}")
            arr = data[self.feature_columns].to_numpy(dtype=float)
        elif isinstance(data, (pd.Series, Mapping)):
            missing = [c for c in self.feature_columns if c not in data]
            if missing:
                raise ValueError(f"Missing feature(s): {missing}")
            values = []
            for c in self.feature_columns:
                v = data[c]
                if v is None or isinstance(v, bool):
                    raise ValueError(f"Feature '{c}' must be a finite number, got {v!r}")
                try:
                    values.append(float(v))
                except (TypeError, ValueError):
                    raise ValueError(f"Feature '{c}' must be a finite number, got {v!r}") from None
            arr = np.array([values], dtype=float)
        elif isinstance(data, np.ndarray):
            arr = data.reshape(1, -1).astype(float) if data.ndim == 1 else data.astype(float)
            if arr.ndim != 2 or arr.shape[1] != len(self.feature_columns):
                raise ValueError(f"Expected {len(self.feature_columns)} feature columns, got shape {data.shape}")
        else:
            raise TypeError(f"Unsupported data type for feature extraction: {type(data)}")

        bad = ~np.isfinite(arr)
        if bad.any():
            cols = [self.feature_columns[j] for j in np.flatnonzero(bad.any(axis=0))]
            raise ValueError(f"Non-finite (NaN/inf) value(s) in feature(s): {cols}")
        # The compiled forest casts to float32 (like sklearn trees); larger values would become inf.
        too_big = np.abs(arr) > np.finfo(np.float32).max
        if too_big.any():
            cols = [self.feature_columns[j] for j in np.flatnonzero(too_big.any(axis=0))]
            raise ValueError(f"Value(s) beyond float32 range in feature(s): {cols}")
        return arr

    def _require_fitted(self) -> None:
        if self.compiled_forest is None or self.xgb_model is None or self.calibrator is None:
            raise RuntimeError("RiskCascadePipeline has not been fitted or loaded.")

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------
    def compute_isolation_score(self, X: Any) -> np.ndarray:
        """Layer-1 anomaly score s(x, n) = -score_samples(x) via the compiled forest."""
        if self.compiled_forest is None:
            raise RuntimeError("Isolation Forest has not been fitted yet.")
        return self.compiled_forest.anomaly_score(self._extract_features(X))

    def predict_xgb_probability(self, X: Any, calibrated: bool = True) -> np.ndarray:
        """Raw or isotonic-calibrated XGBoost P(fraud | x)."""
        if self.xgb_model is None or self.calibrator is None:
            raise RuntimeError("XGBoost model has not been fitted yet.")
        raw = self.xgb_model.predict_proba(self._extract_features(X))[:, 1]
        return self.calibrator.predict(raw) if calibrated else raw

    # ------------------------------------------------------------------
    # Routing (single source of truth for decisions and operating score)
    # ------------------------------------------------------------------
    def _route_masks(self, iso_scores: np.ndarray, bypass: Optional[bool], fast_clear: bool):
        s = np.asarray(iso_scores, dtype=float)
        use_bypass = self.bypass_layer2_on_extreme_anomaly if bypass is None else bypass
        bypassed = (s >= self.quarantine_isolation_threshold) & use_bypass
        if fast_clear and self.filter_isolation_threshold > 0.0:
            cleared = (s < self.filter_isolation_threshold) & ~bypassed
        else:
            cleared = np.zeros_like(bypassed)
        return s, bypassed, cleared, ~(bypassed | cleared)

    def route(
        self,
        iso_scores: np.ndarray,
        probabilities: np.ndarray,
        bypass: Optional[bool] = None,
        fast_clear: bool = True,
    ) -> Dict[str, np.ndarray]:
        """
        Applies the routing table to arrays of (s, p). ``bypass`` overrides
        the configured bypass policy and ``fast_clear=False`` disables the
        Layer-1 fast-clear band; both exist for ablations on fixed models.
        """
        _, bypassed, cleared, layer2 = self._route_masks(iso_scores, bypass, fast_clear)
        p = np.asarray(probabilities, dtype=float)
        l2_decision = np.where(
            p >= self.quarantine_xgb_threshold, QUARANTINE,
            np.where(p >= self.review_xgb_threshold, REVIEW, CLEAR),
        )
        decisions = np.where(bypassed, QUARANTINE, np.where(cleared, CLEAR, l2_decision)).astype(object)
        return {
            "decisions": decisions,
            "triggered_layer": np.where(layer2, 2, 1),
            "layer2_adjudicated": layer2,
        }

    def operating_score(
        self,
        iso_scores: np.ndarray,
        probabilities: np.ndarray,
        bypass: Optional[bool] = None,
        fast_clear: bool = True,
    ) -> np.ndarray:
        """Ranking score consistent with routing: s/filter, 1 + p, or 2 + s."""
        s, bypassed, cleared, _ = self._route_masks(iso_scores, bypass, fast_clear)
        p = np.asarray(probabilities, dtype=float)
        denom = self.filter_isolation_threshold if self.filter_isolation_threshold > 0 else 1.0
        return np.where(bypassed, 2.0 + s, np.where(cleared, s / denom, 1.0 + p))

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------
    def fit(
        self,
        train_df: pd.DataFrame,
        val_df: Optional[pd.DataFrame] = None,
        filter_training_for_xgb: bool = True,
        scale_pos_weight: Optional[float] = None,
    ) -> "RiskCascadePipeline":
        """
        1. Fit IsolationForest on all training rows; compile it.
        2. XGBoost cohort = train rows with s >= filter (``candidates``). If
           that cohort lacks a class, warn and use all rows (``full_fallback``).
        3. scale_pos_weight = n_neg / n_pos on the cohort; fit XGBoost.
        4. Calibrate on val rows with s >= filter (``val_candidates``); fall
           back to all val rows (``val_full_fallback``) or identity
           (``identity_no_val``) with a warning when a class is missing.
        """
        X_train = self._extract_features(train_df)
        y_train = train_df["is_fraud"].to_numpy().astype(int)
        if y_train.sum() == 0 or y_train.sum() == len(y_train):
            raise ValueError("Training data must contain both fraud and legitimate rows")

        self.isolation_forest = IsolationForest(
            contamination=self.isolation_contamination,
            n_estimators=self.isolation_estimators,
            random_state=self.random_state,
        ).fit(X_train)
        self.compiled_forest = CompiledIsolationForest(self.isolation_forest)
        s_train = self.compiled_forest.anomaly_score(X_train)

        if filter_training_for_xgb:
            mask = s_train >= self.filter_isolation_threshold
            n_pos_c = int(y_train[mask].sum())
            n_neg_c = int(mask.sum()) - n_pos_c
            if n_pos_c > 0 and n_neg_c > 0:
                cohort = "candidates"
            else:
                cohort = "full_fallback"
                mask = np.ones_like(mask)
                msg = (
                    f"Layer-1 filter (s >= {self.filter_isolation_threshold}) left {n_pos_c} positive and "
                    f"{n_neg_c} negative training rows; XGBoost trained on the full set "
                    "(xgb_cohort=full_fallback)."
                )
                warnings.warn(msg, UserWarning, stacklevel=2)
                logger.warning(msg)
        else:
            cohort = "full"
            mask = np.ones(len(y_train), dtype=bool)
        X_xgb, y_xgb = X_train[mask], y_train[mask]

        n_pos = int(y_xgb.sum())
        n_neg = int(len(y_xgb) - n_pos)
        spw = float(n_neg / n_pos) if scale_pos_weight is None else float(scale_pos_weight)
        self.xgb_model = xgb.XGBClassifier(
            max_depth=self.xgb_max_depth,
            learning_rate=self.xgb_learning_rate,
            scale_pos_weight=spw,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=self.random_state,
            n_jobs=1,
        )
        self.xgb_model.fit(X_xgb, y_xgb)
        self.explainer = shap.TreeExplainer(self.xgb_model)

        self.calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        cal_rows, cal_pos = 0, 0
        cal_cohort = "identity_no_val"
        if val_df is not None and len(val_df) > 0:
            X_val = self._extract_features(val_df)
            y_val = val_df["is_fraud"].to_numpy().astype(int)
            s_val = self.compiled_forest.anomaly_score(X_val)
            cand = s_val >= self.filter_isolation_threshold
            if 0 < y_val[cand].sum() < cand.sum():
                cal_cohort, sel = "val_candidates", cand
            elif 0 < y_val.sum() < len(y_val):
                cal_cohort, sel = "val_full_fallback", np.ones(len(y_val), dtype=bool)
            else:
                sel = None
            if sel is not None:
                raw_val = self.xgb_model.predict_proba(X_val[sel])[:, 1]
                self.calibrator.fit(raw_val, y_val[sel])
                cal_rows, cal_pos = int(sel.sum()), int(y_val[sel].sum())
        if cal_cohort == "identity_no_val":
            self.calibrator.fit(np.array([0.0, 1.0]), np.array([0.0, 1.0]))
        if cal_cohort == "identity_no_val":
            msg = ("Calibration cohort fell back to 'identity_no_val' (no validation data supplied, "
                   "or validation data lacked a class); calibrated p equals raw p.")
        elif cal_cohort != "val_candidates":
            msg = f"Calibration cohort fell back to '{cal_cohort}' (val candidate cohort lacked a class)."
        if cal_cohort != "val_candidates":
            warnings.warn(msg, UserWarning, stacklevel=2)
            logger.warning(msg)

        self.training_metadata = {
            "model_version": self.model_version,
            "trained_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "train_samples_total": int(len(y_train)),
            "train_positives_total": int(y_train.sum()),
            "xgb_cohort": cohort,
            "train_samples_xgb": int(len(y_xgb)),
            "train_positives_xgb": n_pos,
            "train_negatives_xgb": n_neg,
            "scale_pos_weight": round(spw, 4),
            "calibration_cohort": cal_cohort,
            "calibration_rows": cal_rows,
            "calibration_positives": cal_pos,
            "filter_isolation_threshold": self.filter_isolation_threshold,
            "quarantine_isolation_threshold": self.quarantine_isolation_threshold,
            "quarantine_xgb_threshold": self.quarantine_xgb_threshold,
            "review_xgb_threshold": self.review_xgb_threshold,
            "bypass_layer2_on_extreme_anomaly": self.bypass_layer2_on_extreme_anomaly,
            "feature_columns": self.feature_columns,
            "shap_attribution_units": SHAP_UNITS,
            "library_versions": library_versions(),
        }
        return self

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------
    def evaluate_transaction(
        self,
        transaction_features: Union[Mapping[str, Any], pd.Series, np.ndarray],
        include_shap: bool = True,
        top_k_shap: int = 3,
    ) -> Dict[str, Any]:
        """
        Evaluates one transaction. Returns ``isolation_score``,
        ``xgb_probability`` (always the real calibrated p), ``model_version``,
        ``decision``, ``triggered_layer``, ``layer2_adjudicated``, ``reason``
        and ``top_shap_features`` (attributions in log-odds margin units of
        the uncalibrated XGBoost model, ranked by |value|).
        """
        self._require_fitted()
        if top_k_shap < 1:
            raise ValueError(f"top_k_shap must be >= 1, got {top_k_shap}")
        feats = self._extract_features(transaction_features)
        if feats.shape[0] != 1:
            raise ValueError(f"evaluate_transaction expects exactly one row, got {feats.shape[0]}; use evaluate_batch")
        s = float(self.compiled_forest.anomaly_score(feats)[0])
        p = float(self.calibrator.predict(self.xgb_model.predict_proba(feats)[:, 1])[0])
        routed = self.route(np.array([s]), np.array([p]))
        decision = str(routed["decisions"][0])
        layer = int(routed["triggered_layer"][0])
        adjudicated = bool(routed["layer2_adjudicated"][0])

        if not adjudicated and decision == QUARANTINE:
            reason = (
                f"Layer 1 Isolation Forest score ({s:.4f}) >= threshold "
                f"({self.quarantine_isolation_threshold:.2f}); Layer 2 bypassed per policy"
            )
        elif not adjudicated:
            reason = f"Passed Layer 1 fast pre-filter ({s:.4f} < {self.filter_isolation_threshold:.2f})"
        elif decision == QUARANTINE:
            reason = f"Layer 2 calibrated XGBoost P(fraud) ({p:.4f}) >= threshold ({self.quarantine_xgb_threshold:.2f})"
        elif decision == REVIEW:
            reason = f"Layer 2 calibrated XGBoost P(fraud) ({p:.4f}) >= review threshold ({self.review_xgb_threshold:.2f})"
        else:
            reason = f"Cleared by Layer 2 calibrated XGBoost P(fraud) ({p:.4f} < {self.review_xgb_threshold:.2f})"

        top: List[Dict[str, Any]] = []
        if include_shap and self.explainer is not None:
            shap_vals = np.asarray(self.explainer.shap_values(feats))[0]
            for idx in np.argsort(np.abs(shap_vals))[::-1][:top_k_shap]:
                top.append({
                    "feature": self.feature_columns[idx],
                    "attribution": round(float(shap_vals[idx]), 4),
                    "value": round(float(feats[0, idx]), 4),
                })

        return {
            "isolation_score": s,
            "xgb_probability": p,
            "model_version": self.model_version,
            "decision": decision,
            "triggered_layer": layer,
            "layer2_adjudicated": adjudicated,
            "reason": reason,
            "top_shap_features": top,
        }

    def evaluate_batch(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """
        Vectorised cascade over a DataFrame. Returns arrays
        ``isolation_scores``, ``probabilities`` (real calibrated p for every
        row), ``raw_probabilities``, ``decisions``, ``triggered_layer``,
        ``layer2_adjudicated`` and ``operating_scores``.
        """
        self._require_fitted()
        X = self._extract_features(df)
        s = self.compiled_forest.anomaly_score(X)
        raw = self.xgb_model.predict_proba(X)[:, 1]
        p = self.calibrator.predict(raw)
        routed = self.route(s, p)
        return {
            "isolation_scores": s,
            "probabilities": p,
            "raw_probabilities": raw,
            "decisions": routed["decisions"],
            "triggered_layer": routed["triggered_layer"],
            "layer2_adjudicated": routed["layer2_adjudicated"],
            "operating_scores": self.operating_score(s, p),
        }

    # ------------------------------------------------------------------
    # Persistence (finding 19)
    # ------------------------------------------------------------------
    def save(self, filepath: str) -> str:
        """
        Writes the joblib artifact and a ``<filepath>.sha256`` sidecar
        (``sha256sum`` format). Returns the hex digest.
        """
        self._require_fitted()
        os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
        artifact = {
            "model_version": self.model_version,
            "isolation_forest": self.isolation_forest,
            "xgb_model": self.xgb_model,
            "calibrator": self.calibrator,
            "feature_columns": self.feature_columns,
            "isolation_contamination": self.isolation_contamination,
            "isolation_estimators": self.isolation_estimators,
            "xgb_max_depth": self.xgb_max_depth,
            "xgb_learning_rate": self.xgb_learning_rate,
            "quarantine_isolation_threshold": self.quarantine_isolation_threshold,
            "quarantine_xgb_threshold": self.quarantine_xgb_threshold,
            "filter_isolation_threshold": self.filter_isolation_threshold,
            "review_xgb_threshold": self.review_xgb_threshold,
            "bypass_layer2_on_extreme_anomaly": self.bypass_layer2_on_extreme_anomaly,
            "random_state": self.random_state,
            "training_metadata": self.training_metadata,
            "library_versions": library_versions(),
        }
        joblib.dump(artifact, filepath)
        digest = _sha256_of(filepath)
        with open(f"{filepath}.sha256", "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f"{digest}  {os.path.basename(filepath)}\n")
        self.artifact_sha256 = digest
        return digest

    @classmethod
    def load(cls, filepath: str, expected_sha256: Optional[str] = None) -> "RiskCascadePipeline":
        """
        Verifies the SHA-256 sidecar BEFORE unpickling (joblib.load executes
        code), then verifies library versions (exact for scikit-learn and
        xgboost, major.minor for numpy and joblib). Raises
        ArtifactIntegrityError on any mismatch.

        ``expected_sha256`` is an externally pinned digest (e.g. the
        service's ``MODEL_SHA256`` setting). The co-located sidecar only
        detects corruption; a pin held outside ``models/`` also detects a
        swapped artifact+sidecar pair. ``None`` means no pin; any other
        value (case/whitespace-insensitive) must equal the artifact digest,
        so an empty string is refused rather than ignored.
        """
        sidecar = f"{filepath}.sha256"
        if not os.path.exists(sidecar):
            raise ArtifactIntegrityError(f"Missing integrity sidecar {sidecar}; load refused")
        with open(sidecar, "r", encoding="utf-8") as fh:
            parts = fh.read().split()
        expected = parts[0].lower() if parts else ""
        with open(filepath, "rb") as fh:
            data = fh.read()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise ArtifactIntegrityError(
                f"SHA-256 mismatch for {filepath} (expected {expected}, got {actual}); load refused"
            )
        if expected_sha256 is not None:
            pinned = expected_sha256.strip().lower()
            if actual != pinned:
                raise ArtifactIntegrityError(
                    f"SHA-256 of {filepath} does not match the pinned digest "
                    f"(pinned {pinned or '<empty>'}, got {actual}); load refused"
                )

        # Unpickle exactly the bytes that were hashed (no re-open -> no TOCTOU window).
        artifact = joblib.load(io.BytesIO(data))
        saved = artifact.get("library_versions") or {}
        current = library_versions()
        problems = [
            f"{lib} {saved.get(lib)} != {current[lib]}"
            for lib in _EXACT_VERSION_LIBS if saved.get(lib) != current[lib]
        ] + [
            f"{lib} {saved.get(lib)} !~ {current[lib]}"
            for lib in _MINOR_VERSION_LIBS
            if _major_minor(str(saved.get(lib))) != _major_minor(current[lib])
        ]
        if problems:
            raise ArtifactIntegrityError(f"Library version mismatch: {problems}; load refused")

        instance = cls(
            model_version=artifact["model_version"],
            isolation_contamination=artifact["isolation_contamination"],
            isolation_estimators=artifact["isolation_estimators"],
            xgb_max_depth=artifact["xgb_max_depth"],
            xgb_learning_rate=artifact["xgb_learning_rate"],
            quarantine_isolation_threshold=artifact["quarantine_isolation_threshold"],
            quarantine_xgb_threshold=artifact["quarantine_xgb_threshold"],
            filter_isolation_threshold=artifact["filter_isolation_threshold"],
            review_xgb_threshold=artifact["review_xgb_threshold"],
            bypass_layer2_on_extreme_anomaly=artifact["bypass_layer2_on_extreme_anomaly"],
            feature_columns=artifact["feature_columns"],
            random_state=artifact["random_state"],
        )
        instance.isolation_forest = artifact["isolation_forest"]
        instance.compiled_forest = CompiledIsolationForest(instance.isolation_forest)
        instance.xgb_model = artifact["xgb_model"]
        instance.calibrator = artifact["calibrator"]
        instance.training_metadata = artifact["training_metadata"]
        instance.explainer = shap.TreeExplainer(instance.xgb_model)
        instance.artifact_sha256 = actual
        return instance
