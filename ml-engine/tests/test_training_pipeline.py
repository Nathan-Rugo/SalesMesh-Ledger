"""
tests/test_training_pipeline.py
-------------------------------
Step 2: leak-free splitting, the compiled Isolation Forest, the risk
cascade (routing, calibration cohort, strict extraction, artifact
integrity), and the fitted naive baseline.
"""

import os
import sys
import time
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest
from sklearn.ensemble import IsolationForest

from engine.base_traffic import generate_synthetic_base_traffic
from engine.baseline import NaiveRuleBaseline
from engine.cascade import ArtifactIntegrityError, RiskCascadePipeline
from engine.fast_iforest import CompiledIsolationForest
from engine.features import BASELINE_COUNT_COLUMN, FEATURE_COLUMNS, build_feature_matrix
from engine.fraud_injector import inject_circular_chaining, inject_commission_stuffing
from engine.split import agent_components, chronological_agent_grouped_split


@pytest.fixture(scope="module")
def featured():
    base = generate_synthetic_base_traffic(n_agents=60, n_days=20, seed=10)
    with_stuffing = inject_commission_stuffing(base, n_sequences=120, seed=11)
    full = inject_circular_chaining(with_stuffing, n_chains=60, n_pairs=8, seed=12)
    return build_feature_matrix(full)


@pytest.fixture(scope="module")
def split(featured):
    return chronological_agent_grouped_split(featured, seed=42)


@pytest.fixture(scope="module")
def fitted(split):
    train_df, val_df, _, _ = split
    pipe = RiskCascadePipeline(model_version="test_v1", isolation_estimators=100, random_state=42)
    pipe.fit(train_df, val_df=val_df)
    return pipe


# ---------------------------------------------------------------------------
# Split
# ---------------------------------------------------------------------------

def test_union_find_keeps_colluding_pairs_together(featured):
    comp = agent_components(featured)
    chaining = featured[featured["fraud_type"] == "circular_chaining"]
    for _, grp in chaining.groupby("group_id"):
        parties = set(grp["agent_id"]) | set(grp["counterparty_id"])
        assert len({comp[a] for a in parties}) == 1
    assert set(comp) == set(featured["agent_id"])


def test_split_is_chronological_component_disjoint_and_sized(featured, split):
    train_df, val_df, test_df, meta = split
    comp = agent_components(featured)
    dev_comps = {comp[a] for a in pd.concat([train_df, val_df])["agent_id"]}
    test_comps = {comp[a] for a in test_df["agent_id"]}
    assert dev_comps.isdisjoint(test_comps)
    assert set(train_df["agent_id"]).isdisjoint(test_df["agent_id"])
    assert set(val_df["agent_id"]).isdisjoint(test_df["agent_id"])
    assert train_df["timestamp"].max() <= val_df["timestamp"].min()
    assert val_df["timestamp"].max() <= test_df["timestamp"].min()
    t = pd.to_datetime(featured["timestamp"])
    span = t.max() - t.min()
    assert pd.Timestamp(meta["t_split1"]) == t.min() + span * 0.55
    assert pd.Timestamp(meta["t_split2"]) == t.min() + span * 0.70
    assert 0.38 <= meta["test_agents_count"] / meta["total_agents"] <= 0.45
    assert meta["test_fraud_events"] > 0 and meta["val_fraud_events"] > 0


# ---------------------------------------------------------------------------
# Compiled Isolation Forest
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("max_features", [1.0, 0.5])
def test_compiled_iforest_matches_score_samples(max_features):
    rng = np.random.default_rng(3)
    X = np.vstack([rng.normal(size=(2000, 6)), rng.normal(5, 1, size=(20, 6))])
    forest = IsolationForest(n_estimators=100, contamination=0.01, max_features=max_features, random_state=0).fit(X)
    compiled = CompiledIsolationForest(forest)
    Xq = np.vstack([X[:500], rng.normal(0, 3, size=(500, 6))])
    np.testing.assert_allclose(compiled.score_samples(Xq), forest.score_samples(Xq), rtol=0, atol=1e-9)


def test_cascade_l1_score_matches_sklearn_and_is_fast(fitted, split):
    _, _, test_df, _ = split
    X = test_df[FEATURE_COLUMNS].to_numpy(dtype=float)
    np.testing.assert_allclose(
        fitted.compute_isolation_score(test_df), -fitted.isolation_forest.score_samples(X), rtol=0, atol=1e-9
    )
    row = test_df.iloc[0][FEATURE_COLUMNS].to_dict()
    fitted.compute_isolation_score(row)
    t0 = time.perf_counter()
    for _ in range(200):
        fitted.compute_isolation_score(row)
    mean_ms = (time.perf_counter() - t0) * 1000 / 200
    assert mean_ms < 10.0


# ---------------------------------------------------------------------------
# Cascade construction and extraction
# ---------------------------------------------------------------------------

def test_threshold_and_version_validation():
    with pytest.raises(ValueError):
        RiskCascadePipeline(filter_isolation_threshold=0.72, quarantine_isolation_threshold=0.72)
    with pytest.raises(ValueError):
        RiskCascadePipeline(review_xgb_threshold=0.9, quarantine_xgb_threshold=0.85)
    with pytest.raises(ValueError):
        RiskCascadePipeline(model_version="v" * 21)
    RiskCascadePipeline(model_version="v" * 20)


def test_strict_feature_extraction(fitted):
    good = {c: 0.5 for c in FEATURE_COLUMNS}
    missing = dict(good)
    del missing["entropy_gaps"]
    with pytest.raises(ValueError, match="entropy_gaps"):
        fitted.evaluate_transaction(missing)
    bad = dict(good, agent_zscore=float("nan"))
    with pytest.raises(ValueError, match="agent_zscore"):
        fitted.evaluate_transaction(bad)
    with pytest.raises(ValueError, match="velocity_v_i"):
        fitted.compute_isolation_score(pd.DataFrame([dict(good, velocity_v_i=np.inf)]))


# ---------------------------------------------------------------------------
# Routing, operating score, calibration cohort
# ---------------------------------------------------------------------------

def test_fast_clear_and_bypass_report_real_probability(fitted, split):
    _, _, test_df, _ = split
    s = fitted.compute_isolation_score(test_df)
    low = test_df.iloc[int(np.argmin(s))][FEATURE_COLUMNS].to_dict()
    res = fitted.evaluate_transaction(low, include_shap=False)
    assert res["decision"] == "CLEAR" and res["triggered_layer"] == 1
    assert res["layer2_adjudicated"] is False
    assert res["xgb_probability"] == pytest.approx(float(fitted.predict_xgb_probability(low)[0]), abs=1e-12)

    extreme = {"velocity_v_i": 3600.0, "split_ratio_r_s": 1.0, "entropy_gaps": 0.0,
               "agent_zscore": 60.0, "amount_to_median_ratio": 40.0, "recipient_reuse_count": 12.0}
    res = fitted.evaluate_transaction(extreme, include_shap=False)
    assert res["isolation_score"] >= 0.72
    assert res["decision"] == "QUARANTINE" and res["triggered_layer"] == 1
    assert res["layer2_adjudicated"] is False
    assert res["xgb_probability"] == pytest.approx(float(fitted.predict_xgb_probability(extreme)[0]), abs=1e-12)


def test_routing_and_operating_score_bands(fitted):
    s = np.array([0.30, 0.50, 0.60, 0.70, 0.80])
    p = np.array([0.99, 0.20, 0.60, 0.90, 0.10])
    r = fitted.route(s, p)
    assert list(r["decisions"]) == ["CLEAR", "CLEAR", "REVIEW", "QUARANTINE", "QUARANTINE"]
    assert list(r["triggered_layer"]) == [1, 2, 2, 2, 1]
    assert list(r["layer2_adjudicated"]) == [False, True, True, True, False]
    np.testing.assert_allclose(fitted.operating_score(s, p), [0.30 / 0.45, 1.20, 1.60, 1.90, 2.80])
    no_bypass = fitted.route(s, p, bypass=False)
    assert no_bypass["decisions"][-1] == "CLEAR" and no_bypass["layer2_adjudicated"][-1]
    no_fc = fitted.route(s, p, fast_clear=False)
    assert no_fc["decisions"][0] == "QUARANTINE"
    np.testing.assert_allclose(fitted.operating_score(s, p, fast_clear=False)[0], 1.99)


def test_calibration_cohort_is_val_candidates(fitted, split):
    _, val_df, _, _ = split
    meta = fitted.training_metadata
    s_val = fitted.compute_isolation_score(val_df)
    assert meta["calibration_cohort"] == "val_candidates"
    assert meta["calibration_rows"] == int((s_val >= 0.45).sum())
    assert meta["xgb_cohort"] == "candidates"
    probs = fitted.predict_xgb_probability(val_df)
    assert ((probs >= 0) & (probs <= 1)).all()


def test_full_fallback_when_filter_drops_all_positives():
    rng = np.random.default_rng(5)
    X = rng.normal(0, 1, size=(3000, len(FEATURE_COLUMNS)))
    y = np.zeros(3000, dtype=int)
    centre = np.argsort(np.linalg.norm(X, axis=1))[:30]  # most "normal" rows labelled fraud
    y[centre] = 1
    df = pd.DataFrame(X, columns=FEATURE_COLUMNS)
    df["is_fraud"] = y
    pipe = RiskCascadePipeline(model_version="fb", random_state=0)
    with pytest.warns(UserWarning, match="full_fallback"):
        pipe.fit(df, val_df=df)
    assert pipe.training_metadata["xgb_cohort"] == "full_fallback"
    assert pipe.training_metadata["train_samples_xgb"] == 3000


# ---------------------------------------------------------------------------
# Artifact integrity
# ---------------------------------------------------------------------------

def test_save_load_roundtrip_with_sidecar(fitted, split, tmp_path):
    _, _, test_df, _ = split
    path = tmp_path / "model.joblib"
    digest = fitted.save(str(path))
    sidecar = tmp_path / "model.joblib.sha256"
    assert sidecar.read_text(encoding="utf-8").split()[0] == digest
    loaded = RiskCascadePipeline.load(str(path))
    assert loaded.model_version == "test_v1"
    assert loaded.artifact_sha256 == digest
    assert loaded.training_metadata["library_versions"]["scikit-learn"]
    np.testing.assert_allclose(loaded.compute_isolation_score(test_df), fitted.compute_isolation_score(test_df))
    np.testing.assert_allclose(loaded.predict_xgb_probability(test_df), fitted.predict_xgb_probability(test_df))


def test_tampered_or_unsigned_artifact_is_refused(fitted, tmp_path):
    path = tmp_path / "model.joblib"
    fitted.save(str(path))
    with open(path, "ab") as fh:
        fh.write(b"\x00")
    with pytest.raises(ArtifactIntegrityError):
        RiskCascadePipeline.load(str(path))
    other = tmp_path / "other.joblib"
    fitted.save(str(other))
    os.remove(str(other) + ".sha256")
    with pytest.raises(ArtifactIntegrityError):
        RiskCascadePipeline.load(str(other))


def test_expected_sha256_pin_is_enforced(fitted, tmp_path):
    path = tmp_path / "model.joblib"
    digest = fitted.save(str(path))
    assert RiskCascadePipeline.load(str(path), expected_sha256=digest).artifact_sha256 == digest
    assert RiskCascadePipeline.load(str(path), expected_sha256=f"  {digest.upper()}\n").artifact_sha256 == digest
    with pytest.raises(ArtifactIntegrityError, match="pinned"):
        RiskCascadePipeline.load(str(path), expected_sha256="0" * 64)
    with pytest.raises(ArtifactIntegrityError, match="pinned"):
        RiskCascadePipeline.load(str(path), expected_sha256="")


def test_library_version_mismatch_is_refused(fitted, tmp_path, monkeypatch):
    import engine.cascade as cascade_mod

    real = cascade_mod.library_versions()
    monkeypatch.setattr(cascade_mod, "library_versions", lambda: dict(real, **{"scikit-learn": "0.0.1"}))
    path = tmp_path / "model.joblib"
    fitted.save(str(path))
    monkeypatch.setattr(cascade_mod, "library_versions", lambda: real)
    with pytest.raises(ArtifactIntegrityError, match="scikit-learn"):
        RiskCascadePipeline.load(str(path))


# ---------------------------------------------------------------------------
# Baseline
# ---------------------------------------------------------------------------

def test_baseline_fit_uses_train_percentiles(split):
    train_df, _, test_df, _ = split
    base = NaiveRuleBaseline().fit(train_df)
    assert base.amount_ceiling == pytest.approx(np.percentile(train_df["amount"], 99.5))
    assert base.count_cap == pytest.approx(np.percentile(train_df[BASELINE_COUNT_COLUMN], 99.5))
    pred = base.predict(test_df)
    expected = (test_df["amount"] > base.amount_ceiling) | (test_df[BASELINE_COUNT_COLUMN] > base.count_cap)
    np.testing.assert_array_equal(pred, expected.astype(int).to_numpy())
    with pytest.raises(RuntimeError):
        NaiveRuleBaseline().predict(test_df)


# ---------------------------------------------------------------------------
# Review follow-ups
# ---------------------------------------------------------------------------

def test_no_fraud_event_shared_between_train_and_val(featured, split):
    train_df, val_df, _, meta = split
    shared = set(train_df["group_id"].dropna()) & set(val_df["group_id"].dropna())
    assert shared == set()
    assert meta["val_events_excluded_shared_with_train"] >= 0
    assert meta["val_rows_excluded_shared_with_train"] >= meta["val_events_excluded_shared_with_train"]
    # the excluded rows really are straddling events: recompute without the exclusion
    t = pd.to_datetime(featured["timestamp"])
    t1 = pd.Timestamp(meta["t_split1"])
    t2 = pd.Timestamp(meta["t_split2"])
    dev = set(train_df["agent_id"]) | set(val_df["agent_id"])
    raw_val = featured[featured["agent_id"].isin(dev) & (t > t1) & (t <= t2)]
    assert len(raw_val) - len(val_df) == meta["val_rows_excluded_shared_with_train"]


def test_evaluate_transaction_input_guards(fitted):
    good = {c: 0.5 for c in FEATURE_COLUMNS}
    with pytest.raises(ValueError, match="exactly one row"):
        fitted.evaluate_transaction(pd.DataFrame([good, good]))
    with pytest.raises(ValueError, match="exactly one row"):
        fitted.evaluate_transaction(np.zeros((2, len(FEATURE_COLUMNS))))
    with pytest.raises(ValueError, match="top_k_shap"):
        fitted.evaluate_transaction(good, top_k_shap=0)
    with pytest.raises(ValueError, match="amount_to_median_ratio"):
        fitted.evaluate_transaction(dict(good, amount_to_median_ratio=1e39))


def test_evaluate_batch_matches_per_row_evaluate_transaction(fitted, split):
    _, _, test_df, _ = split
    s = fitted.compute_isolation_score(test_df)
    # sample across all three routes
    idx = list(np.argsort(s)[:5]) + list(np.argsort(s)[-5:]) + list(range(0, len(test_df), max(len(test_df) // 20, 1)))
    sample = test_df.iloc[idx].reset_index(drop=True)
    b = fitted.evaluate_batch(sample)
    for i in range(len(sample)):
        r = fitted.evaluate_transaction(sample.iloc[i][FEATURE_COLUMNS].to_dict(), include_shap=False)
        assert r["decision"] == b["decisions"][i]
        assert r["xgb_probability"] == pytest.approx(b["probabilities"][i], abs=1e-12)
        assert r["isolation_score"] == pytest.approx(b["isolation_scores"][i], abs=1e-12)
        assert r["layer2_adjudicated"] == bool(b["layer2_adjudicated"][i])
        assert r["triggered_layer"] == int(b["triggered_layer"][i])


def _outlier_frame(n, n_pos, rng, centre_positives):
    X = rng.normal(0, 1, size=(n, len(FEATURE_COLUMNS)))
    y = np.zeros(n, dtype=int)
    if centre_positives:
        y[np.argsort(np.linalg.norm(X, axis=1))[:n_pos]] = 1
    else:
        X[:n_pos] += 6.0
        y[:n_pos] = 1
    df = pd.DataFrame(X, columns=FEATURE_COLUMNS)
    df["is_fraud"] = y
    return df


def test_calibration_fallback_cohorts():
    rng = np.random.default_rng(7)
    train = _outlier_frame(3000, 40, rng, centre_positives=False)
    val = _outlier_frame(1000, 20, rng, centre_positives=True)  # val candidates hold no positives
    pipe = RiskCascadePipeline(model_version="calfb", random_state=0)
    with pytest.warns(UserWarning, match="val_full_fallback"):
        pipe.fit(train, val_df=val)
    assert pipe.training_metadata["calibration_cohort"] == "val_full_fallback"
    assert pipe.training_metadata["calibration_rows"] == 1000

    ident = RiskCascadePipeline(model_version="calid", random_state=0)
    with pytest.warns(UserWarning, match="no validation data"):
        ident.fit(train, val_df=None)
    assert ident.training_metadata["calibration_cohort"] == "identity_no_val"
    np.testing.assert_allclose(ident.predict_xgb_probability(train, calibrated=True),
                               ident.predict_xgb_probability(train, calibrated=False), rtol=0, atol=1e-12)


def test_baseline_score_is_max_ratio_and_exceeds_one_exactly_when_flagged(split):
    train_df, _, test_df, _ = split
    base = NaiveRuleBaseline().fit(train_df)
    score = base.score(test_df)
    expected = np.maximum(test_df["amount"] / base.amount_ceiling,
                          test_df[BASELINE_COUNT_COLUMN] / base.count_cap).to_numpy()
    np.testing.assert_allclose(score, expected, rtol=1e-12)
    np.testing.assert_array_equal(score > 1.0, base.predict(test_df) == 1)
