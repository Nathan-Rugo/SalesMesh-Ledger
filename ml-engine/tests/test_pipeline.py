"""
tests/test_pipeline.py
----------------------
Step 1: feature mathematics, train/serve parity, and fraud-injector
invariants for the SalesMesh ML Risk Engine (Module 2).

Run from ``ml-engine/``:  ``py -3.11 -m pytest tests/test_pipeline.py -q``
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from engine.base_traffic import generate_synthetic_base_traffic
from engine.features import (
    ENTROPY_BIN_EDGES_SECONDS,
    FEATURE_COLUMNS,
    build_feature_matrix,
    compute_features_from_history,
    compute_transaction_features,
)
from engine.fraud_injector import inject_circular_chaining, inject_commission_stuffing

THETA = 5000.0
HOUR = 3600.0
DAY = 24 * HOUR


def _feats(prior_times, prior_amounts, prior_cps, t, amount, cp):
    return compute_transaction_features(
        np.asarray(prior_times, dtype=float),
        np.asarray(prior_amounts, dtype=float),
        np.asarray(prior_cps, dtype=object),
        float(t),
        float(amount),
        cp,
    )


# ---------------------------------------------------------------------------
# Feature mathematics
# ---------------------------------------------------------------------------

def test_first_transaction_has_neutral_history_features():
    f = _feats([], [], [], 1_000.0, 1200.0, "C1")
    assert f["velocity_v_i"] == 0.0
    assert f["agent_zscore"] == 0.0
    assert f["amount_to_median_ratio"] == 1.0
    assert f["recipient_reuse_count"] == 0.0
    assert f["entropy_gaps"] == 0.0
    assert set(f) == set(FEATURE_COLUMNS)


def test_velocity_floors_same_second_gap_to_one_second():
    f = _feats([1_000.0], [500.0], ["C0"], 1_000.0, 700.0, "C1")
    assert f["velocity_v_i"] == pytest.approx(3600.0)
    g = _feats([1_000.0], [500.0], ["C0"], 1_000.0 + 1800.0, 700.0, "C1")
    assert g["velocity_v_i"] == pytest.approx(2.0)  # 30-minute gap -> 2 per hour


def test_entropy_uses_fixed_log_bins_and_is_scale_sensitive():
    assert list(ENTROPY_BIN_EDGES_SECONDS) == [1.0, 60.0, 600.0, 3600.0, 21600.0, 86400.0]
    # Two gaps in two different fixed bins (30 s and 2 h) -> H = 1 bit.
    f = _feats([0.0, 30.0], [100.0, 100.0], ["a", "b"], 30.0 + 7200.0, 100.0, "c")
    assert f["entropy_gaps"] == pytest.approx(1.0, abs=1e-9)
    # All gaps in the same bin -> H = 0 regardless of exact spacing.
    g = _feats([0.0, 100.0, 250.0], [100.0] * 3, ["a"] * 3, 400.0, 100.0, "c")
    assert g["entropy_gaps"] == pytest.approx(0.0, abs=1e-9)
    # Same gap *pattern* scaled x100 lands in different bins -> not scale invariant.
    h = _feats([0.0, 3.0], [100.0, 100.0], ["a", "b"], 3.0 + 3.0, 100.0, "c")
    k = _feats([0.0, 300.0], [100.0, 100.0], ["a", "b"], 300.0 + 30000.0, 100.0, "c")
    assert h["entropy_gaps"] == pytest.approx(0.0, abs=1e-9)
    assert k["entropy_gaps"] == pytest.approx(1.0, abs=1e-9)


def test_entropy_matches_closed_form_for_uniform_five_bins():
    # One gap in each of the 5 fixed bins -> H = log2(5).
    gaps = [30.0, 300.0, 1800.0, 7200.0, 30000.0]
    times = np.concatenate([[0.0], np.cumsum(gaps)])
    f = _feats(times[:-1], [100.0] * 5, ["a"] * 5, times[-1], 100.0, "z")
    # window is 24 h: total span = 39330 s < 86400 s, so all 5 gaps are in-window
    assert f["entropy_gaps"] == pytest.approx(math.log2(5), abs=1e-9)


def test_zscore_uses_prior_rows_only_with_sigma_floor_100():
    prior_t = [0.0, HOUR, 2 * HOUR]
    prior_a = [1000.0, 1010.0, 990.0]  # sigma ~ 8 -> floored to 100
    f = _feats(prior_t, prior_a, ["a", "b", "c"], 3 * HOUR, 1500.0, "d")
    assert f["agent_zscore"] == pytest.approx((1500.0 - 1000.0) / 100.0)
    # A large current amount must not inflate its own baseline (prior-only).
    big = _feats(prior_t, prior_a, ["a", "b", "c"], 3 * HOUR, 100_000.0, "d")
    assert big["agent_zscore"] == pytest.approx((100_000.0 - 1000.0) / 100.0)


def test_zscore_and_median_need_three_prior_rows_in_30_day_window():
    two = _feats([0.0, HOUR], [1000.0, 2000.0], ["a", "b"], 2 * HOUR, 9000.0, "c")
    assert two["agent_zscore"] == 0.0
    assert two["amount_to_median_ratio"] == 1.0
    # Three rows exist but one is older than 30 days -> only 2 in window.
    t_now = 31 * DAY
    old = _feats([0.0, 30.5 * DAY, 30.6 * DAY], [1.0, 1000.0, 2000.0], ["a", "b", "c"], t_now, 9000.0, "d")
    assert old["agent_zscore"] == 0.0
    assert old["amount_to_median_ratio"] == 1.0


def test_median_ratio_floor_50():
    f = _feats([0.0, HOUR, 2 * HOUR], [10.0, 20.0, 30.0], ["a", "b", "c"], 3 * HOUR, 500.0, "d")
    assert f["amount_to_median_ratio"] == pytest.approx(500.0 / 50.0)
    g = _feats([0.0, HOUR, 2 * HOUR], [1000.0, 2000.0, 3000.0], ["a", "b", "c"], 3 * HOUR, 500.0, "d")
    assert g["amount_to_median_ratio"] == pytest.approx(500.0 / 2000.0)


def test_split_ratio_formula_with_epsilon():
    # 24 h window: 6000 (old, > 20 min ago), 4000 and 3000 (within 20 min).
    prior_t = [0.0, 10 * HOUR, 10 * HOUR + 300.0]
    prior_a = [6000.0, 4000.0, 3000.0]
    f = _feats(prior_t, prior_a, ["a", "b", "c"], 10 * HOUR + 600.0, 2000.0, "d")
    expected = (4000.0 + 3000.0 + 2000.0) / (6000.0 + 4000.0 + 3000.0 + 2000.0 + 1e-9)
    assert f["split_ratio_r_s"] == pytest.approx(expected, rel=1e-12)
    # Amounts >= theta never enter the numerator.
    g = _feats([], [], [], 0.0, 7000.0, "x")
    assert g["split_ratio_r_s"] == 0.0


def test_recipient_reuse_counts_prior_24h_only():
    prior_t = [0.0, 2 * HOUR, 20 * HOUR, 23 * HOUR]
    prior_cp = ["X", "X", "Y", "X"]
    f = _feats(prior_t, [100.0] * 4, prior_cp, 26 * HOUR + 1, 100.0, "X")
    # window [t-24h, t): rows at 20h ('Y') and 23h ('X'); 2h is 24h+1s ago -> excluded
    assert f["recipient_reuse_count"] == 1.0


# ---------------------------------------------------------------------------
# Train/serve parity
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def small_dataset():
    base = generate_synthetic_base_traffic(n_agents=40, n_days=12, seed=1)
    with_stuffing = inject_commission_stuffing(base, n_sequences=30, theta=THETA, seed=2)
    full = inject_circular_chaining(with_stuffing, n_chains=20, n_pairs=5, seed=3)
    return base, full, build_feature_matrix(full, theta=THETA)


def test_batch_and_online_features_are_equal(small_dataset):
    _, raw, featured = small_dataset
    rng = np.random.default_rng(0)
    sample_idx = rng.choice(len(featured), size=60, replace=False)
    ordered = featured.reset_index(drop=True)
    fraud_idx = ordered.index[ordered["is_fraud"] == 1][:20].to_numpy()
    for i in np.concatenate([sample_idx, fraud_idx]):
        row = ordered.iloc[int(i)]
        same_agent = ordered[ordered["agent_id"] == row["agent_id"]]
        history = same_agent.loc[same_agent.index < i, ["agent_id", "timestamp", "amount", "counterparty_id"]]
        online = compute_features_from_history(
            history.sample(frac=1.0, random_state=1),  # order must not matter if timestamps are distinct
            {
                "agent_id": row["agent_id"],
                "timestamp": row["timestamp"],
                "amount": row["amount"],
                "counterparty_id": row["counterparty_id"],
            },
            theta=THETA,
        )
        for col in FEATURE_COLUMNS:
            assert abs(online[col] - float(row[col])) <= 1e-9, (col, i, online[col], row[col])


def test_no_missing_values_in_engineered_features(small_dataset):
    _, _, featured = small_dataset
    assert not featured[FEATURE_COLUMNS].isna().any().any()
    assert np.isfinite(featured[FEATURE_COLUMNS].to_numpy()).all()
    assert (featured["split_ratio_r_s"] <= 1.0).all()
    assert (featured["entropy_gaps"] >= 0.0).all()


# ---------------------------------------------------------------------------
# Injector invariants
# ---------------------------------------------------------------------------

def test_commission_stuffing_invariants(small_dataset):
    base, raw, _ = small_dataset
    stuffing = raw[raw["fraud_type"] == "commission_stuffing"]
    assert stuffing["group_id"].nunique() == 30
    base_by_id = base.set_index("transaction_id")
    anchors = stuffing.groupby("group_id")["anchor_transaction_id"].first()
    assert anchors.is_unique  # anchors drawn without replacement
    for gid, grp in stuffing.groupby("group_id"):
        k = len(grp)
        assert 3 <= k <= 7
        assert (grp["amount"] < THETA).all()
        assert (grp["amount"] >= 100.0).all()
        total = grp["amount"].sum()
        assert total > THETA
        anchor_id = anchors[gid]
        anchor = base_by_id.loc[anchor_id]
        assert anchor_id not in set(raw["transaction_id"])  # anchor row removed
        assert total == pytest.approx(anchor["amount"], abs=0.011)
        assert grp["agent_id"].nunique() == 1 and grp["agent_id"].iloc[0] == anchor["agent_id"]
        assert grp["counterparty_id"].nunique() == 1
        assert grp["counterparty_id"].iloc[0] == anchor["counterparty_id"]
        span = (pd.to_datetime(grp["timestamp"]).max() - pd.to_datetime(grp["timestamp"]).min())
        assert span <= pd.Timedelta(minutes=20)


def test_circular_chaining_uses_fixed_disjoint_pairs(small_dataset):
    _, raw, _ = small_dataset
    chaining = raw[raw["fraud_type"] == "circular_chaining"]
    assert chaining["group_id"].nunique() == 20
    pairs = set()
    for _, grp in chaining.groupby("group_id"):
        parties = set(grp["agent_id"]) | set(grp["counterparty_id"])
        assert len(parties) == 2
        assert set(grp["agent_id"]) == parties  # both colluders transact
        pairs.add(frozenset(parties))
        ts = pd.to_datetime(grp["timestamp"]).sort_values()
        span = ts.max() - ts.min()
        assert pd.Timedelta(minutes=30) * 0.999 <= span <= pd.Timedelta(hours=24)
        # strict alternation of sender
        senders = grp.sort_values("timestamp")["agent_id"].tolist()
        assert all(a != b for a, b in zip(senders, senders[1:]))
    assert len(pairs) <= 5
    agents_in_pairs = [a for p in pairs for a in p]
    assert len(agents_in_pairs) == len(set(agents_in_pairs))  # pairs are disjoint


def test_ids_unique_and_native_label_unused(small_dataset):
    _, raw, _ = small_dataset
    assert raw["transaction_id"].is_unique
    assert (raw.loc[raw["is_fraud"] == 1, "native_fraud_label"] == 0).all()
    assert set(raw.loc[raw["is_fraud"] == 0, "fraud_type"]) == {"none"}


def test_fraud_rows_shift_features_in_expected_direction(small_dataset):
    _, _, featured = small_dataset
    normal = featured[featured["fraud_type"] == "none"]
    stuffing = featured[featured["fraud_type"] == "commission_stuffing"]
    chaining = featured[featured["fraud_type"] == "circular_chaining"]
    assert stuffing["split_ratio_r_s"].mean() > normal["split_ratio_r_s"].mean()
    assert stuffing["velocity_v_i"].median() > normal["velocity_v_i"].median()
    assert chaining["recipient_reuse_count"].mean() > normal["recipient_reuse_count"].mean()


# ---------------------------------------------------------------------------
# Review follow-ups: tie parity, timestamp normalisation, baseline counts, splits
# ---------------------------------------------------------------------------

def _tied_frame():
    secs = [0, 0, 0, 60, 60, 3600, 3600, 90000]
    return pd.DataFrame({
        "transaction_id": [f"TXN{i:09d}" for i in (5, 2, 9, 1, 7, 3, 4, 8)],
        "agent_id": ["A"] * len(secs),
        "counterparty_id": ["X", "Y", "X", "X", "Z", "Y", "X", "X"],
        "timestamp": pd.Timestamp("2026-01-01") + pd.to_timedelta(secs, unit="s"),
        "amount": [1200.0, 4900.0, 300.0, 2500.0, 4100.0, 800.0, 6200.0, 950.0],
        "is_fraud": 0, "fraud_type": "none", "native_fraud_label": 0, "group_id": np.nan,
    })


def test_online_parity_with_tied_timestamps_and_self_in_history():
    raw = _tied_frame()
    batch = build_feature_matrix(raw)
    for _, row in batch.iterrows():
        txn = {k: row[k] for k in ("transaction_id", "agent_id", "timestamp", "amount", "counterparty_id")}
        # full history, shuffled, including the transaction itself and same-second later-id rows
        online = compute_features_from_history(raw.sample(frac=1.0, random_state=3), txn)
        for col in FEATURE_COLUMNS:
            assert abs(online[col] - row[col]) <= 1e-9, (row["transaction_id"], col, online[col], row[col])
    first = batch.iloc[0]  # earliest second, lowest transaction_id among the ties
    assert first["velocity_v_i"] == 0.0
    assert batch.iloc[1]["velocity_v_i"] == pytest.approx(3600.0)


def test_to_epoch_seconds_normalises_timezones_and_rejects_missing():
    from engine.features import to_epoch_seconds

    naive = pd.Series(pd.to_datetime(["2026-01-01 10:00:00", "2026-01-01 11:30:00"]))
    aware = naive.dt.tz_localize("Africa/Nairobi")  # UTC+3
    np.testing.assert_array_equal(to_epoch_seconds(aware), to_epoch_seconds(naive) - 3 * 3600)
    scalar = pd.Timestamp("2026-01-01 13:00:00", tz="Africa/Nairobi")
    assert to_epoch_seconds(scalar)[0] == to_epoch_seconds(pd.Timestamp("2026-01-01 10:00:00"))[0]
    with pytest.raises(ValueError):
        to_epoch_seconds(pd.Series([pd.Timestamp("2026-01-01"), pd.NaT]))
    with pytest.raises(ValueError):
        to_epoch_seconds(None)


def test_baseline_count_column_on_hand_built_history():
    from engine.features import BASELINE_COUNT_COLUMN

    df = pd.DataFrame({
        "transaction_id": ["TXN000000001", "TXN000000002", "TXN000000003"],
        "agent_id": ["A", "A", "A"],
        "counterparty_id": ["X", "Y", "Z"],
        "timestamp": pd.Timestamp("2026-01-01") + pd.to_timedelta([0, 1, 25], unit="h"),
        "amount": [100.0, 200.0, 300.0],
    })
    out = build_feature_matrix(df)
    assert out[BASELINE_COUNT_COLUMN].tolist() == [1.0, 2.0, 2.0]


def test_sample_splits_rejects_infeasible_inputs():
    from engine.fraud_injector import sample_splits

    rng = np.random.default_rng(0)
    with pytest.raises(ValueError):
        sample_splits(rng, 14700.0, 3, 100.0, 4900.0)  # ceil(total/k) == cap -> infeasible
    with pytest.raises(ValueError):
        sample_splits(rng, 250.0, 3, 100.0, 4900.0)  # floor(total/k) < lower
    amounts = sample_splits(rng, 14699.97, 3, 100.0, 4900.0)
    assert amounts.sum() == pytest.approx(14699.97) and (amounts < 4900.0).all()
