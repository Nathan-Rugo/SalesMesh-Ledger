"""
tests/test_evaluation.py
------------------------
Step 2b: statistically valid evaluation - cluster bootstrap, event-level
recall, operating-score PR-AUC, fast-clear leakage, floor verdicts, the
end-to-end train CLI (stability executed, UTF-8 reports) and the
regenerated dataset/model acceptance criteria.
"""

import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import average_precision_score

import generate_dataset
from engine.cascade import RiskCascadePipeline
from engine.eval import cluster_bootstrap, event_recall, floor_verdict, point_metrics
from engine.features import FEATURE_COLUMNS
from engine.split import agent_components, chronological_agent_grouped_split
from engine.train import main as train_main

DATASET = os.path.join(ROOT, "salesmesh_fraud_dataset.csv")
MODEL = os.path.join(ROOT, "models", "risk_cascade_v1.0.0.joblib")


def _toy(n_comp=4, rows_per_comp=5):
    rows = []
    for c in range(n_comp):
        for r in range(rows_per_comp):
            rows.append({"agent_id": f"A{c}", "group_id": float(c), "is_fraud": 1,
                         "fraud_type": "commission_stuffing" if c % 2 == 0 else "circular_chaining"})
    for c in range(n_comp):
        for r in range(20):
            rows.append({"agent_id": f"A{c}", "group_id": np.nan, "is_fraud": 0, "fraud_type": "none"})
    df = pd.DataFrame(rows)
    return df, {f"A{c}": f"A{c}" for c in range(n_comp)}


# ---------------------------------------------------------------------------
# Primitive metrics
# ---------------------------------------------------------------------------

def test_event_recall_counts_event_detected_by_any_row():
    df = pd.DataFrame({
        "agent_id": ["a"] * 6,
        "group_id": [1, 1, 1, 2, 2, np.nan],
        "is_fraud": [1, 1, 1, 1, 1, 0],
        "fraud_type": ["commission_stuffing"] * 3 + ["circular_chaining"] * 2 + ["none"],
    })
    flagged = np.array([0, 0, 1, 0, 0, 1], dtype=bool)
    ev = event_recall(df, flagged)
    assert ev["events"] == 2 and ev["detected"] == 1
    assert ev["event_recall"] == pytest.approx(0.5)
    assert ev["commission_stuffing"]["event_recall"] == 1.0
    assert ev["circular_chaining"]["event_recall"] == 0.0


def test_floor_verdicts():
    assert floor_verdict(0.8, 0.76, 0.85, ">=", 0.75)["ci_verdict"] == "pass"
    assert floor_verdict(0.8, 0.70, 0.85, ">=", 0.75)["ci_verdict"] == "inconclusive"
    v = floor_verdict(0.6, 0.50, 0.70, ">=", 0.75)
    assert v["ci_verdict"] == "fail" and v["point_pass"] is False
    assert floor_verdict(0.001, 0.0005, 0.002, "<", 0.005)["ci_verdict"] == "pass"
    assert floor_verdict(0.004, 0.002, 0.007, "<", 0.005)["ci_verdict"] == "inconclusive"
    assert floor_verdict(12.0, None, None, "<", 30.0)["ci_verdict"] == "n/a"


# ---------------------------------------------------------------------------
# Cluster bootstrap
# ---------------------------------------------------------------------------

def test_cluster_bootstrap_resamples_whole_components():
    df, comps = _toy()
    y = df["is_fraud"].to_numpy()
    pred = (df["agent_id"] == "A0").to_numpy() & (y == 1)  # only component A0's event is caught
    score = pred.astype(float) + 0.01 * y
    out = cluster_bootstrap(df, comps, {"m": {"score": score, "pred": pred}}, n_boot=300, seed=1,
                            return_samples=True)
    recall = out["m"]["recall"]["samples"]
    assert set(np.round(recall, 10)) <= {0.0, 0.25, 0.5, 0.75, 1.0}  # multiples of one component
    assert out["m"]["recall"]["point"] == pytest.approx(0.25)
    assert out["m"]["event_recall"]["point"] == pytest.approx(0.25)
    assert out["m"]["recall"]["ci_low"] <= 0.25 <= out["m"]["recall"]["ci_high"]
    again = cluster_bootstrap(df, comps, {"m": {"score": score, "pred": pred}}, n_boot=300, seed=1)
    assert again["m"]["recall"]["ci_low"] == out["m"]["recall"]["ci_low"]  # deterministic per seed


def test_bootstrap_point_estimates_match_unweighted_metrics():
    rng = np.random.default_rng(0)
    n = 400
    df = pd.DataFrame({
        "agent_id": [f"A{i % 20}" for i in range(n)],
        "is_fraud": (rng.random(n) < 0.1).astype(int),
    })
    df["group_id"] = np.where(df["is_fraud"] == 1, np.arange(n), np.nan)
    df["fraud_type"] = np.where(df["is_fraud"] == 1, "commission_stuffing", "none")
    score = df["is_fraud"].to_numpy() * 0.5 + rng.random(n)
    pred = score > 1.0
    prob = np.clip(score / 1.5, 0, 1)
    out = cluster_bootstrap(df, agent_components(df), {"m": {"score": score, "pred": pred, "prob": prob}},
                            n_boot=0)
    ref = point_metrics(df["is_fraud"].to_numpy(), score, pred, prob)
    for k in ("precision", "recall", "f1", "fpr", "brier"):
        assert out["m"][k]["point"] == pytest.approx(ref[k], abs=1e-12)
        assert out["m"][k]["ci_low"] is None
    assert out["m"]["pr_auc"]["point"] == pytest.approx(average_precision_score(df["is_fraud"], score))


# ---------------------------------------------------------------------------
# End-to-end: generate -> train CLI -> metrics.json / report
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def e2e(tmp_path_factory):
    d = tmp_path_factory.mktemp("e2e")
    csv = d / "ds.csv"
    generate_dataset.main(["--output", str(csv), "--n-agents", "70", "--n-days", "21",
                           "--stuffing-sequences", "140", "--chaining-sequences", "70",
                           "--chaining-pairs", "8", "--quiet"])
    model, metrics, report = d / "m.joblib", d / "metrics.json", d / "report.md"
    train_main(["--dataset", str(csv), "--model-version", "e2e-v1", "--output-model", str(model),
                "--output-metrics", str(metrics), "--output-report", str(report),
                "--stability-repeats", "2", "--n-bootstrap", "40"])
    return csv, model, metrics, report


def test_generate_dataset_defaults():
    args = generate_dataset.parse_args([])
    assert (args.stuffing_sequences, args.chaining_sequences, args.chaining_pairs) == (600, 300, 40)
    assert (args.n_agents, args.n_days) == (300, 45)


def test_metrics_json_has_stability_cis_and_event_recall(e2e):
    _, model, metrics_path, _ = e2e
    with open(metrics_path, encoding="utf-8") as fh:
        m = json.load(fh)
    assert m["stability_check"] is not None and m["stability_check"]["n_repeats"] == 2
    assert len(m["stability_check"]["per_repeat"]) == 2
    ev = m["evaluation"]
    for system in ("cascade", "baseline", "xgb_calibrated_standalone"):
        for metric in ("pr_auc", "f1", "precision", "recall", "fpr", "event_recall"):
            entry = ev["bootstrap"][system][metric]
            assert entry["ci_low"] is not None and entry["ci_high"] is not None, (system, metric)
    assert ev["bootstrap"]["cascade"]["brier_layer2"]["ci_low"] is not None
    assert ev["bootstrap"]["cascade_vs_baseline"]["pr_auc_lift"]["ci_low"] is not None
    assert ev["event_recall"]["cascade"]["events"] > 0
    assert set(ev["floors"]) == {"pr_auc_lift", "f1", "fpr", "l1_latency_ms"}
    assert m["model_sha256"] and open(str(model) + ".sha256", encoding="utf-8").read().startswith(m["model_sha256"])
    assert len(m["model_version"]) <= 20


def test_operating_score_and_leakage_are_consistent(e2e):
    csv, model, metrics_path, _ = e2e
    m = json.load(open(metrics_path, encoding="utf-8"))["evaluation"]
    pipe = RiskCascadePipeline.load(str(model))
    df = pd.read_csv(csv)
    _, _, test_df, _ = chronological_agent_grouped_split(df, seed=42)
    b = pipe.evaluate_batch(test_df)
    y = test_df["is_fraud"].to_numpy()
    assert m["bootstrap"]["cascade"]["pr_auc"]["point"] == pytest.approx(average_precision_score(y, b["operating_scores"]))
    assert m["bootstrap"]["xgb_calibrated_standalone"]["pr_auc"]["point"] == pytest.approx(
        average_precision_score(y, b["probabilities"]))
    fast_cleared = b["isolation_scores"] < 0.45
    assert m["fast_clear_leakage"]["fraud_rows_fast_cleared"] == int((fast_cleared & (y == 1)).sum())
    assert "no fast-clear" in m["ablations"] and "bypass off" in m["ablations"]


def test_report_states_floors_with_ci_in_utf8(e2e):
    _, _, _, report = e2e
    text = open(report, encoding="utf-8").read()
    assert "—" in text and "�" not in text
    for label in ("PR-AUC lift over baseline", "F1 (QUARANTINE)", "FPR", "Layer-1 latency"):
        assert label in text
    floor_lines = [ln for ln in text.splitlines() if ln.startswith("| PR-AUC lift") or ln.startswith("| F1 (")]
    assert all("[" in ln and ("PASS" in ln or "FAIL" in ln) for ln in floor_lines)
    assert "Stability" in text and "Event-Level" in text and "Fast-Clear Leakage" in text


# ---------------------------------------------------------------------------
# Acceptance on the regenerated artifacts (skipped until they exist)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not os.path.exists(DATASET), reason="regenerated dataset not present")
def test_regenerated_dataset_split_meets_event_floors():
    df = pd.read_csv(DATASET)
    train_df, val_df, test_df, meta = chronological_agent_grouped_split(df, seed=42)
    assert meta["test_fraud_events"] >= 60
    assert meta["val_fraud_events"] >= 40
    comp = agent_components(df)
    dev = {comp[a] for a in pd.concat([train_df, val_df])["agent_id"]}
    assert dev.isdisjoint({comp[a] for a in test_df["agent_id"]})


@pytest.mark.skipif(not os.path.exists(MODEL), reason="trained artifact not present")
def test_shipped_model_l1_parity_and_latency():
    pipe = RiskCascadePipeline.load(MODEL)
    rng = np.random.default_rng(0)
    X = np.abs(rng.normal(0, 2, size=(2000, len(FEATURE_COLUMNS))))
    np.testing.assert_allclose(pipe.compute_isolation_score(X), -pipe.isolation_forest.score_samples(X),
                               rtol=0, atol=1e-9)
    row = dict(zip(FEATURE_COLUMNS, X[0]))
    pipe.compute_isolation_score(row)
    t0 = time.perf_counter()
    for _ in range(200):
        pipe.compute_isolation_score(row)
    assert (time.perf_counter() - t0) * 1000 / 200 < 10.0


# ---------------------------------------------------------------------------
# Review follow-ups
# ---------------------------------------------------------------------------

def test_event_recall_exact_interval_when_all_detected():
    from engine.eval import clopper_pearson

    n = 84
    df = pd.DataFrame({"agent_id": ["a"] * n, "group_id": np.arange(n, dtype=float), "is_fraud": 1,
                       "fraud_type": ["commission_stuffing"] * n})
    ev = event_recall(df, np.ones(n, dtype=bool))
    assert ev["event_recall"] == 1.0
    assert ev["exact_ci_high"] == 1.0 and ev["exact_ci_low"] < 1.0
    assert ev["exact_ci_low"] == pytest.approx(0.025 ** (1 / n), rel=1e-9)  # closed form: (alpha/2)^(1/n)
    assert ev["commission_stuffing"]["exact_ci_low"] == ev["exact_ci_low"]
    lo, hi = clopper_pearson(0, 10)
    assert lo == 0.0 and 0.0 < hi < 1.0


def test_brier_layer2_uses_prob_mask():
    rng = np.random.default_rng(2)
    n = 300
    df = pd.DataFrame({"agent_id": [f"A{i % 15}" for i in range(n)], "is_fraud": (rng.random(n) < 0.2).astype(int)})
    df["group_id"] = np.where(df["is_fraud"] == 1, np.arange(n), np.nan)
    df["fraud_type"] = np.where(df["is_fraud"] == 1, "circular_chaining", "none")
    p = rng.random(n)
    mask = rng.random(n) < 0.4
    out = cluster_bootstrap(df, agent_components(df),
                            {"m": {"score": p, "pred": p > 0.5, "prob": p, "prob_mask": mask}}, n_boot=0)
    y = df["is_fraud"].to_numpy()
    assert out["m"]["brier_layer2"]["point"] == pytest.approx(np.mean((p[mask] - y[mask]) ** 2), abs=1e-12)
    assert out["m"]["brier"]["point"] == pytest.approx(np.mean((p - y) ** 2), abs=1e-12)


def test_floors_cross_check_bootstrap_and_directive_values(e2e):
    from engine.eval import FLOORS

    _, _, metrics_path, _ = e2e
    m = json.load(open(metrics_path, encoding="utf-8"))
    ev, boot = m["evaluation"], m["evaluation"]["bootstrap"]
    source = {"pr_auc_lift": boot["cascade_vs_baseline"]["pr_auc_lift"], "f1": boot["cascade"]["f1"],
              "fpr": boot["cascade"]["fpr"]}
    for key, entry in source.items():
        f = ev["floors"][key]
        direction, floor, _ = FLOORS[key]
        assert (f["direction"], f["floor"]) == (direction, floor)
        assert (f["point"], f["ci_low"], f["ci_high"]) == (entry["point"], entry["ci_low"], entry["ci_high"])
        ok = (lambda v: v >= floor) if direction == ">=" else (lambda v: v < floor)
        assert f["point_pass"] == ok(entry["point"])
        expected = ("pass" if ok(entry["ci_low"]) and ok(entry["ci_high"])
                    else "fail" if not ok(entry["ci_low"]) and not ok(entry["ci_high"]) else "inconclusive")
        assert f["ci_verdict"] == expected
    lat = ev["floors"]["l1_latency_ms"]
    assert lat["point"] == ev["latency"]["l1_compiled_mean_ms"] and lat["floor"] == FLOORS["l1_latency_ms"][1]
    assert m["dataset"]["sha256"] and len(m["dataset"]["sha256"]) == 64
