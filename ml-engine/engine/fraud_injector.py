"""
fraud_injector.py
------------------
Synthetic fraud generators for the two typologies this research targets
(thesis Section 2.3.1, directive Section 2.2), applied on top of a
base-traffic DataFrame from ``base_traffic.py``. Ground truth comes only
from these generators - PaySim's ``isFraud`` is never used.

Commission stuffing (structuring)
    A legitimate deposit of amount A with theta < A <= 6.79*theta (the
    "anchor", drawn WITHOUT replacement) is REMOVED and replaced by k
    sub-threshold deposits from the same agent to the same counterparty
    within a 20-minute window, where::

        k ~ U{max(3, ceil(A / (0.97*theta))), ..., 7}
        sum_j a_j = A  (exact to the cent),   100 <= a_j < 0.98*theta

    so every split is below theta while the cumulative sum exceeds it.
    The upper anchor bound 6.79*theta = 7 * 0.97*theta guarantees the k
    range is non-empty. Splits are rejection-sampled from a symmetric
    Dirichlet whose concentration is escalated until a draw satisfies the
    bounds (the equal split always does, so sampling terminates).

Circular chaining (float recycling)
    ``n_pairs`` FIXED, mutually disjoint colluding agent pairs recycle
    near-identical float back and forth (strictly alternating sender)
    with no end-customer sale. Each chain has a fast (30 min - 3 h) or
    slow (3 h - 24 h) tempo, so spans run from 30 min to 24 h.

Each event shares a ``group_id``; stuffing rows also carry the removed
``anchor_transaction_id`` for audit. Both functions return a new,
unsorted DataFrame.
"""

import math
from typing import Tuple

import numpy as np
import pandas as pd

ANCHOR_COLUMN = "anchor_transaction_id"


def _next_free_id(df: pd.DataFrame) -> int:
    existing_ids = df["transaction_id"].str.replace("TXN", "", regex=False).astype(np.int64)
    return int(existing_ids.max()) + 1


def _next_group_id(df: pd.DataFrame) -> int:
    if "group_id" in df.columns and df["group_id"].notna().any():
        return int(df["group_id"].max()) + 1
    return 1


def _ensure_anchor_column(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if ANCHOR_COLUMN not in out.columns:
        out[ANCHOR_COLUMN] = pd.Series([None] * len(out), dtype=object, index=out.index)
    return out


def sample_splits(
    rng: np.random.Generator,
    total: float,
    k: int,
    lower: float,
    upper: float,
    tries_per_level: int = 200,
) -> np.ndarray:
    """
    Rejection-samples k amounts (2 d.p.) summing exactly to ``total`` with
    ``lower <= a_j < upper``. Feasibility is checked on the cent-level equal
    split used as the final fallback: floor(total/k) >= lower and
    ceil(total/k) < upper (in cents); otherwise ValueError.
    """
    total_cents = int(round(total * 100))
    lower_cents, upper_cents = lower * 100, upper * 100
    if total_cents // k < lower_cents or -(-total_cents // k) >= upper_cents:
        raise ValueError(f"Infeasible split: total={total}, k={k}, bounds=[{lower}, {upper})")
    for alpha in (1.0, 4.0, 16.0, 64.0, 256.0, 1024.0, 4096.0):
        for _ in range(tries_per_level):
            weights = rng.dirichlet(np.full(k, alpha))
            cents = np.floor(weights * total_cents).astype(np.int64)
            cents[rng.integers(0, k)] += total_cents - int(cents.sum())
            amounts = cents / 100.0
            if amounts.min() >= lower and amounts.max() < upper:
                return amounts
    base, rem = divmod(total_cents, k)
    cents = np.full(k, base, dtype=np.int64)
    cents[:rem] += 1
    return rng.permutation(cents) / 100.0


def inject_commission_stuffing(
    df: pd.DataFrame,
    n_sequences: int = 600,
    theta: float = 5000.0,
    k_max: int = 7,
    window_minutes: float = 20.0,
    min_split: float = 100.0,
    split_cap_fraction: float = 0.98,
    k_floor_fraction: float = 0.97,
    seed: int = 7,
) -> pd.DataFrame:
    """Replaces ``n_sequences`` anchor deposits with stuffing bursts (see module docstring)."""
    rng = np.random.default_rng(seed)
    df = _ensure_anchor_column(df)
    max_anchor = k_max * k_floor_fraction * theta
    candidates = df.index[(df["fraud_type"] == "none") & (df["amount"] > theta) & (df["amount"] <= max_anchor)]
    if len(candidates) < n_sequences:
        raise ValueError(
            f"Only {len(candidates)} anchor deposits in ({theta}, {max_anchor}] for {n_sequences} sequences"
        )
    anchor_idx = rng.choice(np.asarray(candidates), size=n_sequences, replace=False)

    next_id = _next_free_id(df)
    group_id = _next_group_id(df)
    window_s = window_minutes * 60.0
    new_rows = []
    for idx in anchor_idx:
        anchor = df.loc[idx]
        total = float(anchor["amount"])
        k_lo = max(3, math.ceil(total / (k_floor_fraction * theta)))
        k = int(rng.integers(k_lo, k_max + 1))
        amounts = sample_splits(rng, total, k, min_split, split_cap_fraction * theta)
        offsets = np.sort(np.concatenate([[0.0], rng.uniform(0.0, window_s, k - 1)]))
        anchor_ts = pd.Timestamp(anchor["timestamp"])
        for amt, off in zip(amounts, offsets):
            row = anchor.to_dict()
            row.update({
                "transaction_id": f"TXN{next_id:09d}",
                "timestamp": anchor_ts + pd.Timedelta(seconds=float(off)),
                "amount": float(amt),
                "is_fraud": 1,
                "fraud_type": "commission_stuffing",
                "native_fraud_label": 0,
                "group_id": group_id,
                ANCHOR_COLUMN: anchor["transaction_id"],
            })
            new_rows.append(row)
            next_id += 1
        group_id += 1

    kept = df.drop(index=anchor_idx)
    return pd.concat([kept, pd.DataFrame(new_rows, columns=df.columns)], ignore_index=True)


def inject_circular_chaining(
    df: pd.DataFrame,
    n_chains: int = 300,
    n_pairs: int = 40,
    chain_length_range: Tuple[int, int] = (4, 10),
    amount_range: Tuple[float, float] = (800.0, 6000.0),
    fast_span_minutes: Tuple[float, float] = (30.0, 180.0),
    slow_span_hours: Tuple[float, float] = (3.0, 24.0),
    p_fast: float = 0.5,
    seed: int = 11,
) -> pd.DataFrame:
    """Injects ``n_chains`` float-recycling chains over ``n_pairs`` fixed disjoint pairs."""
    rng = np.random.default_rng(seed)
    df = _ensure_anchor_column(df)
    agents = np.array(sorted(df["agent_id"].unique()))
    if 2 * n_pairs > len(agents):
        raise ValueError(f"{n_pairs} disjoint pairs need {2 * n_pairs} agents; only {len(agents)} available")
    pairs = rng.choice(agents, size=2 * n_pairs, replace=False).reshape(n_pairs, 2)
    pair_order = rng.permutation(np.arange(n_chains) % n_pairs)

    ts_all = pd.to_datetime(df["timestamp"])
    t_min, t_max = ts_all.min(), ts_all.max()
    next_id = _next_free_id(df)
    group_id = _next_group_id(df)
    new_rows = []
    for pair_idx in pair_order:
        agent_a, agent_b = rng.permutation(pairs[pair_idx])
        if rng.random() < p_fast:
            span_s = float(rng.uniform(*fast_span_minutes)) * 60.0
        else:
            span_s = float(rng.uniform(*slow_span_hours)) * 3600.0
        span = pd.Timedelta(seconds=span_s)

        own = ts_all[(df["agent_id"] == agent_a) & (df["fraud_type"] == "none") & (ts_all <= t_max - span)]
        if len(own) > 0:
            anchor_ts = pd.Timestamp(own.iloc[int(rng.integers(0, len(own)))])
        else:
            room = (t_max - span - t_min).total_seconds()
            anchor_ts = t_min + pd.Timedelta(seconds=float(rng.uniform(0.0, max(room, 0.0))))

        length = int(rng.integers(chain_length_range[0], chain_length_range[1] + 1))
        inner = np.sort(rng.uniform(0.0, span_s, length - 2))
        offsets = np.concatenate([[0.0], inner, [span_s]])
        base_amount = float(rng.uniform(*amount_range))
        for step, off in enumerate(offsets):
            sender, receiver = (agent_a, agent_b) if step % 2 == 0 else (agent_b, agent_a)
            new_rows.append({
                "transaction_id": f"TXN{next_id:09d}",
                "agent_id": sender,
                "counterparty_id": receiver,
                "timestamp": anchor_ts + pd.Timedelta(seconds=float(off)),
                "amount": round(base_amount * float(rng.uniform(0.97, 1.03)), 2),
                "source_channel": "DARAJA_STK",
                "is_fraud": 1,
                "fraud_type": "circular_chaining",
                "native_fraud_label": 0,
                "group_id": group_id,
                ANCHOR_COLUMN: None,
            })
            next_id += 1
        group_id += 1

    return pd.concat([df, pd.DataFrame(new_rows, columns=df.columns)], ignore_index=True)
