"""
features.py
------------
Causal behavioural feature engineering for the SalesMesh ML Risk Engine
(Module 2, directive Section 4).

Every feature is computed by ONE pure per-transaction function,
:func:`compute_transaction_features`, from the agent's *prior* history
only. The batch builder (:func:`build_feature_matrix`, used for training)
and the online path (:func:`compute_features_from_history`, used at
serving time) both call it, which is what guarantees train/serve parity.

Notation for transaction i of an agent at time t_i (seconds) with amount
A_i and counterparty D_i; ``prior`` means rows of the same agent that
precede i in (timestamp, transaction_id) order:

1. Instantaneous velocity (per hour), with a 1-second floor on the gap
   because Daraja timestamps are per-second and collisions are common::

       V_i = 3600 / max(t_i - t_{i-1}, 1 s)          (0 if no prior row)

2. Split ratio (theta = KES 5,000, eps = 1e-9)::

       R_s = sum_{t in [t_i-20m, t_i], A < theta} A
             / (sum_{t in [t_i-24h, t_i]} A + eps)

   Both windows include the current transaction (it is known at decision
   time); R_s is therefore in [0, 1].

3. Entropy of inter-transaction gaps over the 24 h window (including the
   gap to the current transaction), discretised into B = 5 FIXED
   logarithmic bins with edges [1 s, 1 min, 10 min, 1 h, 6 h, 24 h]
   (gaps are clipped into [1 s, 24 h]); eps_H = 1e-12::

       H = max(0, -sum_b p_b * log2(p_b + eps_H))

   Fixed edges make H comparable across agents and windows (auto-ranged
   bins would make it scale invariant). The max(0, .) only removes the
   -1.4e-12 produced by eps when all gaps share one bin.

4. Agent-relative z-score over the 30-day PRIOR window (>= 3 prior rows
   required, else 0)::

       Z_i = (A_i - mu_30d) / max(sigma_30d, 100)

5. Amount-to-median ratio over the same 30-day prior window (>= 3 prior
   rows required, else 1)::

       M_r = A_i / max(median_30d, 50)

6. Recipient reuse over the prior 24 h::

       C_reuse = sum_{k prior, t_k in [t_i - 24h, t_i)} 1(D_k = D_i)
"""

from typing import Any, Dict, Mapping

import numpy as np
import pandas as pd

FEATURE_COLUMNS = [
    "velocity_v_i", "split_ratio_r_s", "entropy_gaps",
    "agent_zscore", "amount_to_median_ratio", "recipient_reuse_count",
]

#: Auxiliary (non-model) column used only by the naive rule baseline:
#: number of the agent's transactions in [t_i - 24h, t_i], including i.
BASELINE_COUNT_COLUMN = "txn_count_24h"

ENTROPY_BIN_EDGES_SECONDS = np.array([1.0, 60.0, 600.0, 3600.0, 21600.0, 86400.0])

EPSILON = 1e-9
ENTROPY_EPSILON = 1e-12
MIN_GAP_SECONDS = 1.0
ZSCORE_SIGMA_FLOOR = 100.0
MEDIAN_FLOOR = 50.0
MIN_PRIOR_ROWS_FOR_BASELINE = 3

_STUFFING_WINDOW_S = 20 * 60.0
_REFERENCE_WINDOW_S = 24 * 3600.0
_PAIR_WINDOW_S = 24 * 3600.0
_BASELINE_WINDOW_S = 30 * 24 * 3600.0

#: Longest backward window any feature uses (the 30-day agent baseline). Prior rows
#: older than ``t - MAX_LOOKBACK_SECONDS`` never influence a feature.
MAX_LOOKBACK_SECONDS = _BASELINE_WINDOW_S


def normalise_timestamps(values: Any) -> pd.Series:
    """
    Single normalisation path for scalars and sequences: parses to
    datetime, converts tz-aware values to UTC and drops the tz (naive
    values are taken to already be UTC), and returns a UTC-naive
    ``datetime64[ns]`` Series. Raises ValueError on NaT/missing values.
    """
    is_sequence = isinstance(values, (pd.Series, pd.Index, np.ndarray, list, tuple))
    series = values if isinstance(values, pd.Series) else pd.Series(list(values) if is_sequence else [values])
    try:
        parsed = pd.to_datetime(series, utc=True)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Unparseable timestamp(s): {exc}") from None
    if parsed.isna().any():
        raise ValueError(f"{int(parsed.isna().sum())} missing/NaT timestamp(s)")
    return parsed.dt.tz_localize(None).astype("datetime64[ns]")


def to_epoch_seconds(values: Any) -> np.ndarray:
    """
    Converts timestamps (datetime-like Series/array/scalar, naive or
    tz-aware) to float POSIX seconds via :func:`normalise_timestamps` and an
    int64-nanosecond representation, so the batch and online paths perform
    bit-identical arithmetic.
    """
    return normalise_timestamps(values).to_numpy().astype("int64") / 1e9


def _gap_entropy(gaps_seconds: np.ndarray) -> float:
    """Shannon entropy (bits) of gaps histogrammed into the fixed log bins."""
    if gaps_seconds.size == 0:
        return 0.0
    clipped = np.clip(gaps_seconds, ENTROPY_BIN_EDGES_SECONDS[0], ENTROPY_BIN_EDGES_SECONDS[-1])
    counts, _ = np.histogram(clipped, bins=ENTROPY_BIN_EDGES_SECONDS)
    probs = counts[counts > 0] / counts.sum()
    h = float(-(probs * np.log2(probs + ENTROPY_EPSILON)).sum())
    return max(0.0, h)


def compute_transaction_features(
    prior_times: np.ndarray,
    prior_amounts: np.ndarray,
    prior_cps: np.ndarray,
    t: float,
    amount: float,
    cp: Any,
    theta: float = 5000.0,
) -> Dict[str, float]:
    """
    Pure, causal feature function for ONE transaction.

    Args:
        prior_times: ascending float POSIX seconds of the agent's prior rows
            (all <= ``t``). Rows older than 30 days may be omitted - they
            never influence any feature.
        prior_amounts: amounts (KES) aligned with ``prior_times``.
        prior_cps: counterparty identifiers aligned with ``prior_times``.
        t: current transaction time (float POSIX seconds).
        amount: current transaction amount (KES).
        cp: current transaction counterparty.
        theta: structuring threshold (KES).

    Returns:
        dict keyed by :data:`FEATURE_COLUMNS` (see module docstring for maths).
    """
    prior_times = np.asarray(prior_times, dtype=float)
    prior_amounts = np.asarray(prior_amounts, dtype=float)
    prior_cps = np.asarray(prior_cps, dtype=object)
    n = prior_times.size
    amount = float(amount)
    t = float(t)

    # 1. Velocity (Eq. 3.1) with 1 s gap floor.
    if n > 0:
        velocity = 3600.0 / max(t - prior_times[-1], MIN_GAP_SECONDS)
    else:
        velocity = 0.0

    # 2. Split ratio (Eq. 3.2).
    ref_start = int(np.searchsorted(prior_times, t - _REFERENCE_WINDOW_S, side="left"))
    stuff_start = int(np.searchsorted(prior_times, t - _STUFFING_WINDOW_S, side="left"))
    stuff_amounts = prior_amounts[stuff_start:]
    numerator = float(stuff_amounts[stuff_amounts < theta].sum()) + (amount if amount < theta else 0.0)
    denominator = float(prior_amounts[ref_start:].sum()) + amount + EPSILON
    split_ratio = numerator / denominator

    # 3. Entropy of gaps in the 24 h window (gaps among window rows + current).
    window_times = np.append(prior_times[ref_start:], t)
    entropy = _gap_entropy(np.diff(window_times))

    # 4./5. Agent baseline over the 30-day prior window.
    base_start = int(np.searchsorted(prior_times, t - _BASELINE_WINDOW_S, side="left"))
    base_amounts = prior_amounts[base_start:]
    if base_amounts.size >= MIN_PRIOR_ROWS_FOR_BASELINE:
        mu = float(base_amounts.mean())
        sigma = float(base_amounts.std())
        zscore = (amount - mu) / max(sigma, ZSCORE_SIGMA_FLOOR)
        median_ratio = amount / max(float(np.median(base_amounts)), MEDIAN_FLOOR)
    else:
        zscore = 0.0
        median_ratio = 1.0

    # 6. Recipient reuse over prior 24 h.
    pair_start = int(np.searchsorted(prior_times, t - _PAIR_WINDOW_S, side="left"))
    reuse = float(np.count_nonzero(prior_cps[pair_start:] == cp)) if n > 0 else 0.0

    return {
        "velocity_v_i": float(velocity),
        "split_ratio_r_s": float(split_ratio),
        "entropy_gaps": float(entropy),
        "agent_zscore": float(zscore),
        "amount_to_median_ratio": float(median_ratio),
        "recipient_reuse_count": reuse,
    }


def compute_features_from_history(
    history: pd.DataFrame,
    transaction: Mapping[str, Any],
    theta: float = 5000.0,
) -> Dict[str, float]:
    """
    Online path: computes the feature vector for ``transaction`` from a
    DataFrame of the agent's previously observed transactions (columns
    ``agent_id``, ``timestamp``, ``amount``, ``counterparty_id``).

    Rows belonging to other agents or stamped after the transaction are
    ignored, so the result is causal by construction. When both the
    transaction and ``history`` carry ``transaction_id``, the batch
    ordering (timestamp, transaction_id) is reproduced exactly: the
    transaction's own row is dropped and a same-second row counts as prior
    only if its transaction_id sorts lower. Without ids, every row with
    timestamp <= t counts as prior.
    """
    for key in ("agent_id", "timestamp", "amount", "counterparty_id"):
        if key not in transaction:
            raise ValueError(f"transaction is missing required field '{key}'")
    t = float(to_epoch_seconds(transaction["timestamp"])[0])
    hist = history[history["agent_id"] == transaction["agent_id"]]
    use_ids = transaction.get("transaction_id") is not None and "transaction_id" in hist.columns
    if use_ids:
        hist = hist[hist["transaction_id"] != transaction["transaction_id"]]
    if len(hist) > 0:
        ordered = pd.DataFrame({
            "_t": to_epoch_seconds(hist["timestamp"]),
            "_id": hist["transaction_id"].to_numpy(dtype=object) if use_ids else np.zeros(len(hist)),
            "amount": hist["amount"].to_numpy(dtype=float),
            "cp": hist["counterparty_id"].to_numpy(dtype=object),
        }).sort_values(["_t", "_id"], kind="mergesort")
        times = ordered["_t"].to_numpy()
        if use_ids:
            ids = ordered["_id"].to_numpy(dtype=object)
            keep = (times < t) | ((times == t) & (ids < transaction["transaction_id"]))
        else:
            keep = times <= t
        times = times[keep]
        amounts = ordered["amount"].to_numpy()[keep]
        cps = ordered["cp"].to_numpy(dtype=object)[keep]
    else:
        times = np.empty(0)
        amounts = np.empty(0)
        cps = np.empty(0, dtype=object)
    return compute_transaction_features(
        times, amounts, cps, t, float(transaction["amount"]), transaction["counterparty_id"], theta=theta
    )


def build_feature_matrix(df: pd.DataFrame, theta: float = 5000.0) -> pd.DataFrame:
    """
    Batch path: returns a copy of ``df`` sorted by (agent_id, timestamp,
    transaction_id) with the 6 :data:`FEATURE_COLUMNS` plus the auxiliary
    :data:`BASELINE_COUNT_COLUMN`, each row computed by
    :func:`compute_transaction_features` from that agent's preceding rows.
    """
    out = df.copy()
    out["timestamp"] = normalise_timestamps(out["timestamp"]).to_numpy()
    out = out.sort_values(["agent_id", "timestamp", "transaction_id"], kind="mergesort").reset_index(drop=True)

    all_times = to_epoch_seconds(out["timestamp"])
    all_amounts = out["amount"].to_numpy(dtype=float)
    all_cps = out["counterparty_id"].to_numpy(dtype=object)
    feats = np.zeros((len(out), len(FEATURE_COLUMNS)), dtype=float)
    counts = np.zeros(len(out), dtype=float)

    agent_codes = out["agent_id"].to_numpy()
    boundaries = np.flatnonzero(agent_codes[1:] != agent_codes[:-1]) + 1
    starts = np.concatenate([[0], boundaries])
    ends = np.concatenate([boundaries, [len(out)]])

    for s, e in zip(starts, ends):
        times = all_times[s:e]
        amounts = all_amounts[s:e]
        cps = all_cps[s:e]
        for j in range(e - s):
            f = compute_transaction_features(
                times[:j], amounts[:j], cps[:j], times[j], amounts[j], cps[j], theta=theta
            )
            feats[s + j] = [f[c] for c in FEATURE_COLUMNS]
            ref_start = int(np.searchsorted(times[:j], times[j] - _REFERENCE_WINDOW_S, side="left"))
            counts[s + j] = float(j - ref_start + 1)

    for k, col in enumerate(FEATURE_COLUMNS):
        out[col] = feats[:, k]
    out[BASELINE_COUNT_COLUMN] = counts
    return out
