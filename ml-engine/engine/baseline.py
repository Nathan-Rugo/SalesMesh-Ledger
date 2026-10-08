"""
baseline.py
-----------
Naive rule-based baseline (thesis Section "Model Validation and Testing";
decision Q7; finding 27): "a static ceiling on single-transaction amounts
and a daily transaction frequency cap".

Both limits are fitted on the TRAIN partition only::

    amount_ceiling = P99.5(train amount)
    count_cap      = P99.5(train txn_count_24h)

where ``txn_count_24h`` is the agent's number of transactions in the
trailing 24 h including the current one (computed causally by
``features.build_feature_matrix``). A row is flagged when
``amount > amount_ceiling`` OR ``txn_count_24h > count_cap``.

``score`` = max(amount / amount_ceiling, txn_count_24h / count_cap) is a
ranking score for PR-AUC only - it is NOT a probability, so no Brier
score is reported for the baseline.
"""

from typing import Optional

import numpy as np
import pandas as pd

from engine.features import BASELINE_COUNT_COLUMN


class NaiveRuleBaseline:
    """Amount ceiling + trailing-24 h count cap, both set from train percentiles."""

    def __init__(self, amount_percentile: float = 99.5, count_percentile: float = 99.5):
        self.amount_percentile = amount_percentile
        self.count_percentile = count_percentile
        self.amount_ceiling: Optional[float] = None
        self.count_cap: Optional[float] = None

    @staticmethod
    def _check_columns(df: pd.DataFrame) -> None:
        for col in ("amount", BASELINE_COUNT_COLUMN):
            if col not in df.columns:
                raise ValueError(f"NaiveRuleBaseline requires column '{col}'")

    def fit(self, train_df: pd.DataFrame) -> "NaiveRuleBaseline":
        self._check_columns(train_df)
        self.amount_ceiling = float(np.percentile(train_df["amount"].to_numpy(dtype=float), self.amount_percentile))
        self.count_cap = float(np.percentile(train_df[BASELINE_COUNT_COLUMN].to_numpy(dtype=float), self.count_percentile))
        return self

    def _require_fitted(self) -> None:
        if self.amount_ceiling is None or self.count_cap is None:
            raise RuntimeError("NaiveRuleBaseline must be fitted on the train partition first")

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        """1 = flagged, 0 = pass."""
        self._require_fitted()
        self._check_columns(df)
        flagged = (df["amount"].to_numpy(dtype=float) > self.amount_ceiling) | (
            df[BASELINE_COUNT_COLUMN].to_numpy(dtype=float) > self.count_cap
        )
        return flagged.astype(int)

    def score(self, df: pd.DataFrame) -> np.ndarray:
        """Continuous ranking score (> 1 exactly when flagged)."""
        self._require_fitted()
        self._check_columns(df)
        amt = df["amount"].to_numpy(dtype=float) / max(self.amount_ceiling, 1e-9)
        cnt = df[BASELINE_COUNT_COLUMN].to_numpy(dtype=float) / max(self.count_cap, 1e-9)
        return np.maximum(amt, cnt)
