"""
eval.py
-------
Statistically valid evaluation for the SalesMesh ML Risk Engine
(review decision D1; findings 22, 24, 26).

Metrics (test partition only; nothing here is tuned on test):

* PR-AUC = average precision (step-wise PR integral, sklearn
  ``average_precision_score``; Saito & Rehmsmeier, 2015). The CASCADE
  PR-AUC is computed on the operating score (fast-clear -> s/0.45,
  layer 2 -> 1 + p, bypass -> 2 + s), so it reflects the routing; the
  standalone XGBoost PR-AUC on p is reported alongside it.
* F1 / precision / recall / FPR with QUARANTINE as the positive decision
  (FPR = wrongful freezes / legitimate rows; thesis ceiling < 0.5%).
* Event recall: an injected fraud event (``group_id``) present in the
  partition counts as detected if ANY of its rows is quarantined; also
  reported per typology.
* Brier score on calibrated p, over the Layer-2-adjudicated rows (the
  cohort p is calibrated for) and over all rows.

Uncertainty: cluster bootstrap. Rows are grouped by agent component
(agents joined through shared fraud events, ``split.agent_components``);
each of ``n_boot`` (default 1000) resamples draws components with
replacement and recomputes every metric with multiplicity weights, so
correlated rows of one agent/event never get treated as independent.
95% CIs are the 2.5/97.5 percentiles of the resampled values (resamples
where a metric is undefined, e.g. no positives, are dropped and counted).
Lifts over the baseline are paired (same resample for both systems).
"""

import time
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from scipy.stats import beta as beta_dist
from sklearn.metrics import average_precision_score

from engine.baseline import NaiveRuleBaseline
from engine.cascade import QUARANTINE, REVIEW, RiskCascadePipeline

#: Directive Section 8 floors: metric -> (direction, floor, target or None)
FLOORS: Dict[str, Tuple[str, float, Optional[float]]] = {
    "pr_auc_lift": (">=", 0.65, None),
    "f1": (">=", 0.75, None),
    "fpr": ("<", 0.005, 0.001),
    "l1_latency_ms": ("<", 30.0, 10.0),
}

TYPOLOGIES = ("commission_stuffing", "circular_chaining")


# ---------------------------------------------------------------------------
# Primitive metrics
# ---------------------------------------------------------------------------

def _rates(tp, fp, fn, tn) -> Dict[str, Any]:
    tp, fp, fn, tn = (np.asarray(v, dtype=float) for v in (tp, fp, fn, tn))
    with np.errstate(divide="ignore", invalid="ignore"):
        precision = np.where(tp + fp > 0, tp / (tp + fp), 0.0)
        recall = np.where(tp + fn > 0, tp / (tp + fn), np.nan)
        f1 = np.where(2 * tp + fp + fn > 0, 2 * tp / (2 * tp + fp + fn), 0.0)
        fpr = np.where(fp + tn > 0, fp / (fp + tn), np.nan)
    return {"precision": precision, "recall": recall, "f1": f1, "fpr": fpr}


def _ap(y: np.ndarray, score: np.ndarray, weight: Optional[np.ndarray] = None) -> float:
    w = np.ones(len(y)) if weight is None else weight
    if np.sum(w * y) <= 0:
        return float("nan")
    return float(average_precision_score(y, score, sample_weight=w))


def point_metrics(
    y_true: np.ndarray,
    score: np.ndarray,
    pred: np.ndarray,
    prob: Optional[np.ndarray] = None,
    name: str = "model",
) -> Dict[str, Any]:
    """Unweighted point metrics for one system (row level)."""
    y = np.asarray(y_true).astype(int)
    pr = np.asarray(pred).astype(bool)
    tp = int(np.sum(pr & (y == 1)))
    fp = int(np.sum(pr & (y == 0)))
    fn = int(np.sum(~pr & (y == 1)))
    tn = int(np.sum(~pr & (y == 0)))
    rates = {k: float(v) for k, v in _rates(tp, fp, fn, tn).items()}
    out: Dict[str, Any] = {
        "model": name,
        "pr_auc": _ap(y, np.asarray(score, dtype=float)),
        **rates,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "true_negatives": tn,
        "n_rows": int(len(y)),
        "n_positive_rows": int(y.sum()),
    }
    if prob is not None:
        out["brier"] = float(np.mean((np.asarray(prob, dtype=float) - y) ** 2))
    return out


def event_table(df: pd.DataFrame, flagged: np.ndarray) -> pd.DataFrame:
    """One row per fraud event present in ``df``: group_id, fraud_type, n_rows, detected."""
    fraud = df["is_fraud"].to_numpy() == 1
    sub = pd.DataFrame({
        "group_id": df["group_id"].to_numpy()[fraud],
        "fraud_type": df["fraud_type"].to_numpy()[fraud],
        "agent_id": df["agent_id"].to_numpy()[fraud],
        "flagged": np.asarray(flagged).astype(bool)[fraud],
    })
    if sub.empty:
        return pd.DataFrame(columns=["group_id", "fraud_type", "agent_id", "n_rows", "detected"])
    return (
        sub.groupby("group_id", sort=True)
        .agg(fraud_type=("fraud_type", "first"), agent_id=("agent_id", "first"),
             n_rows=("flagged", "size"), detected=("flagged", "any"))
        .reset_index()
    )


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> Tuple[Optional[float], Optional[float]]:
    """
    Exact (Clopper-Pearson) 1 - alpha binomial interval for k successes in n
    trials. Unlike the percentile bootstrap it does not collapse to zero
    width at 0% or 100% (e.g. 84/84 -> [0.957, 1.0]).
    """
    if n <= 0:
        return None, None
    lo = 0.0 if k == 0 else float(beta_dist.ppf(alpha / 2, k, n - k + 1))
    hi = 1.0 if k == n else float(beta_dist.ppf(1 - alpha / 2, k + 1, n - k))
    return lo, hi


def _recall_entry(detected: pd.Series) -> Dict[str, Any]:
    n, k = int(len(detected)), int(detected.sum()) if len(detected) else 0
    lo, hi = clopper_pearson(k, n)
    return {"events": n, "detected": k, "event_recall": k / n if n else float("nan"),
            "exact_ci_low": lo, "exact_ci_high": hi}


def event_recall(df: pd.DataFrame, flagged: np.ndarray) -> Dict[str, Any]:
    """
    Overall and per-typology event recall with exact Clopper-Pearson 95%
    intervals (events treated as independent Bernoulli trials).
    """
    ev = event_table(df, flagged)
    out: Dict[str, Any] = _recall_entry(ev["detected"])
    for typ in TYPOLOGIES:
        out[typ] = _recall_entry(ev.loc[ev["fraud_type"] == typ, "detected"])
    return out


# ---------------------------------------------------------------------------
# Cluster bootstrap
# ---------------------------------------------------------------------------

def _ci(values: np.ndarray, alpha: float) -> Tuple[Optional[float], Optional[float], int]:
    v = values[np.isfinite(values)]
    if v.size == 0:
        return None, None, 0
    return float(np.percentile(v, 100 * alpha / 2)), float(np.percentile(v, 100 * (1 - alpha / 2))), int(v.size)


def cluster_bootstrap(
    df: pd.DataFrame,
    components: Mapping[str, str],
    systems: Mapping[str, Mapping[str, np.ndarray]],
    lifts: Sequence[Tuple[str, str]] = (),
    n_boot: int = 1000,
    seed: int = 0,
    alpha: float = 0.05,
    return_samples: bool = False,
) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """
    Point estimates and cluster-bootstrap (1 - alpha) CIs.

    ``systems[name]`` holds ``score`` (ranking score for PR-AUC), ``pred``
    (bool flag) and optionally ``prob`` (for Brier) and ``prob_mask``
    (rows over which the cohort Brier ``brier_layer2`` is computed).
    ``lifts`` are (system, reference) pairs giving paired
    ``pr_auc_lift`` / ``f1_lift`` / ``event_recall_lift``.

    Returns ``{system: {metric: {"point", "ci_low", "ci_high", "n_valid"}}}``
    with lifts under ``"<system>_vs_<reference>"``; with ``return_samples``
    each entry also carries the raw resampled values under ``"samples"``.
    """
    y = df["is_fraud"].to_numpy().astype(int)
    comp_codes, comp_labels = pd.factorize(df["agent_id"].map(components), sort=True)
    if (comp_codes < 0).any():
        raise ValueError("Every agent in df must have a component label")
    n_comp = len(comp_labels)

    rng = np.random.default_rng(seed)
    # Row 0 = the original sample (all multiplicities 1).
    weights = np.ones((1 + n_boot, n_comp))
    if n_boot > 0:
        draws = rng.integers(0, n_comp, size=(n_boot, n_comp))
        weights[1:] = np.stack([np.bincount(d, minlength=n_comp) for d in draws])

    def per_comp(values: np.ndarray) -> np.ndarray:
        return np.bincount(comp_codes, weights=values.astype(float), minlength=n_comp)

    fraud_mask = y == 1
    gids = df["group_id"].to_numpy()
    types = df["fraud_type"].to_numpy()

    raw: Dict[str, Dict[str, np.ndarray]] = {}
    for name, sysd in systems.items():
        pred = np.asarray(sysd["pred"]).astype(bool)
        score = np.asarray(sysd["score"], dtype=float)
        counts = [per_comp(m) for m in (pred & fraud_mask, pred & ~fraud_mask, ~pred & fraud_mask, ~pred & ~fraud_mask)]
        tp, fp, fn, tn = (weights @ c for c in counts)
        metrics = _rates(tp, fp, fn, tn)

        ev = event_table(df, pred)
        ev_comp = pd.Series(ev["agent_id"]).map(components)
        ev_codes = comp_labels.get_indexer(ev_comp) if len(ev) else np.array([], dtype=int)
        def ev_rate(sel: np.ndarray) -> np.ndarray:
            n_ev = np.bincount(ev_codes[sel], minlength=n_comp).astype(float)
            n_det = np.bincount(ev_codes[sel], weights=ev["detected"].to_numpy()[sel].astype(float), minlength=n_comp)
            tot = weights @ n_ev
            with np.errstate(divide="ignore", invalid="ignore"):
                return np.where(tot > 0, (weights @ n_det) / tot, np.nan)
        all_sel = np.ones(len(ev), dtype=bool)
        metrics["event_recall"] = ev_rate(all_sel)
        for typ in TYPOLOGIES:
            metrics[f"event_recall_{typ}"] = ev_rate((ev["fraud_type"] == typ).to_numpy() if len(ev) else all_sel)

        metrics["pr_auc"] = np.array([_ap(y, score, weights[i, comp_codes]) for i in range(weights.shape[0])])

        if "prob" in sysd:
            prob = np.asarray(sysd["prob"], dtype=float)
            sq = (prob - y) ** 2
            with np.errstate(divide="ignore", invalid="ignore"):
                metrics["brier"] = (weights @ per_comp(sq)) / (weights @ per_comp(np.ones_like(sq)))
                if "prob_mask" in sysd:
                    m = np.asarray(sysd["prob_mask"]).astype(bool)
                    den = weights @ per_comp(m.astype(float))
                    metrics["brier_layer2"] = np.where(den > 0, (weights @ per_comp(sq * m)) / den, np.nan)
        raw[name] = metrics

    for sys_name, ref in lifts:
        raw[f"{sys_name}_vs_{ref}"] = {
            "pr_auc_lift": raw[sys_name]["pr_auc"] - raw[ref]["pr_auc"],
            "f1_lift": raw[sys_name]["f1"] - raw[ref]["f1"],
            "event_recall_lift": raw[sys_name]["event_recall"] - raw[ref]["event_recall"],
        }

    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for name, metrics in raw.items():
        out[name] = {}
        for metric, values in metrics.items():
            values = np.asarray(values, dtype=float)
            point = float(values[0])
            if n_boot > 0:
                lo, hi, n_valid = _ci(values[1:], alpha)
            else:
                lo, hi, n_valid = None, None, 0
            out[name][metric] = {"point": point, "ci_low": lo, "ci_high": hi, "n_valid": n_valid}
            if return_samples:
                out[name][metric]["samples"] = values[1:]
    out["_meta"] = {"bootstrap": {"n_boot": n_boot, "seed": seed, "alpha": alpha,
                                  "n_components": n_comp, "unit": "agent component"}}
    return out


def floor_verdict(point: float, ci_low: Optional[float], ci_high: Optional[float],
                  direction: str, floor: float) -> Dict[str, Any]:
    """
    Point pass/fail plus a CI verdict: ``pass`` (whole CI meets the floor),
    ``fail`` (whole CI misses it) or ``inconclusive`` (CI straddles it).
    """
    def ok(v: float) -> bool:
        return v >= floor if direction == ">=" else v < floor
    point_pass = bool(np.isfinite(point) and ok(point))
    if ci_low is None or ci_high is None:
        ci_verdict = "n/a"
    elif ok(ci_low) and ok(ci_high):
        ci_verdict = "pass"
    elif not ok(ci_low) and not ok(ci_high):
        ci_verdict = "fail"
    else:
        ci_verdict = "inconclusive"
    return {"direction": direction, "floor": floor, "point": point, "ci_low": ci_low,
            "ci_high": ci_high, "point_pass": point_pass, "ci_verdict": ci_verdict}


# ---------------------------------------------------------------------------
# Latency
# ---------------------------------------------------------------------------

def benchmark_latency(pipeline: RiskCascadePipeline, sample_rows: pd.DataFrame, n_iterations: int = 200) -> Dict[str, Any]:
    """Single-row latency (ms): compiled Layer 1, sklearn Layer 1, cascade with/without SHAP."""
    row = sample_rows.iloc[0][pipeline.feature_columns].to_dict()
    x = pipeline._extract_features(row)
    for _ in range(10):
        pipeline.evaluate_transaction(row, include_shap=True)

    def timed(fn, n):
        out = np.empty(n)
        for i in range(n):
            t0 = time.perf_counter()
            fn()
            out[i] = (time.perf_counter() - t0) * 1000.0
        return out

    l1 = timed(lambda: pipeline.compute_isolation_score(row), n_iterations)
    l1_sklearn = timed(lambda: pipeline.isolation_forest.score_samples(x), min(n_iterations, 50))
    no_shap = timed(lambda: pipeline.evaluate_transaction(row, include_shap=False), n_iterations)
    with_shap = timed(lambda: pipeline.evaluate_transaction(row, include_shap=True), min(n_iterations, 50))
    return {
        "n_iterations": n_iterations,
        "l1_compiled_mean_ms": float(l1.mean()),
        "l1_compiled_p50_ms": float(np.percentile(l1, 50)),
        "l1_compiled_p99_ms": float(np.percentile(l1, 99)),
        "l1_sklearn_mean_ms": float(l1_sklearn.mean()),
        "cascade_without_shap_mean_ms": float(no_shap.mean()),
        "cascade_with_shap_mean_ms": float(with_shap.mean()),
        "cascade_with_shap_p99_ms": float(np.percentile(with_shap, 99)),
    }


# ---------------------------------------------------------------------------
# Full evaluation
# ---------------------------------------------------------------------------

def _reliability(prob: np.ndarray, y: np.ndarray, edges: Sequence[float]) -> List[Dict[str, Any]]:
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (prob >= lo) & ((prob < hi) if hi < 1.0 else (prob <= hi))
        rows.append({"bin": f"[{lo:.2f}, {hi:.2f}{']' if hi >= 1.0 else ')'}", "n": int(m.sum()),
                     "mean_p": float(prob[m].mean()) if m.any() else None,
                     "observed_rate": float(y[m].mean()) if m.any() else None})
    return rows


def run_full_evaluation(
    pipeline: RiskCascadePipeline,
    test_df: pd.DataFrame,
    baseline: NaiveRuleBaseline,
    components: Mapping[str, str],
    n_bootstrap: int = 1000,
    seed: int = 0,
    include_latency: bool = True,
    latency_iterations: int = 200,
) -> Dict[str, Any]:
    """Evaluates the fitted cascade and the fitted baseline on ``test_df``."""
    y = test_df["is_fraud"].to_numpy().astype(int)
    b = pipeline.evaluate_batch(test_df)
    s, p, raw, dec, adj, op = (b[k] for k in ("isolation_scores", "probabilities", "raw_probabilities",
                                              "decisions", "layer2_adjudicated", "operating_scores"))
    quarantined = dec == QUARANTINE
    flagged_incl_review = quarantined | (dec == REVIEW)
    base_pred = baseline.predict(test_df).astype(bool)
    base_score = baseline.score(test_df)
    thr = pipeline.quarantine_xgb_threshold

    systems = {
        "cascade": {"score": op, "pred": quarantined, "prob": p, "prob_mask": adj},
        "xgb_calibrated_standalone": {"score": p, "pred": p >= thr, "prob": p},
        "xgb_raw_standalone": {"score": raw, "pred": raw >= thr, "prob": raw},
        "baseline": {"score": base_score, "pred": base_pred},
    }
    boot = cluster_bootstrap(test_df, components, systems, lifts=[("cascade", "baseline")],
                             n_boot=n_bootstrap, seed=seed)

    # Ablations on the SAME fitted models (decision policy only).
    ablations: Dict[str, Any] = {}
    for label, kwargs in (("primary (bypass on, fast-clear on)", {}),
                          ("bypass off", {"bypass": False}),
                          ("no fast-clear", {"fast_clear": False}),
                          ("no fast-clear, bypass off", {"bypass": False, "fast_clear": False})):
        r = pipeline.route(s, p, **kwargs)
        q = r["decisions"] == QUARANTINE
        m = point_metrics(y, pipeline.operating_score(s, p, **kwargs), q, name=label)
        m["event_recall"] = event_recall(test_df, q)["event_recall"]
        m["layer2_share_of_rows"] = float(np.mean(r["layer2_adjudicated"]))
        ablations[label] = m
    incl_review = point_metrics(y, op, flagged_incl_review, name="cascade (QUARANTINE or REVIEW)")
    incl_review["event_recall"] = event_recall(test_df, flagged_incl_review)["event_recall"]
    ablations["flag = QUARANTINE or REVIEW"] = incl_review

    # Fast-clear leakage.
    fast_cleared = ~adj & ~quarantined
    fraud = y == 1
    ev_fc = event_table(test_df, ~fast_cleared)  # "detected" here = any row NOT fast-cleared
    leakage = {
        "fraud_rows": int(fraud.sum()),
        "fraud_rows_fast_cleared": int((fast_cleared & fraud).sum()),
        "fraud_row_leakage_rate": float((fast_cleared & fraud).sum() / max(fraud.sum(), 1)),
        "fraud_events": int(len(ev_fc)),
        "fraud_events_fully_fast_cleared": int((~ev_fc["detected"]).sum()) if len(ev_fc) else 0,
        "fraud_event_leakage_rate": float((~ev_fc["detected"]).mean()) if len(ev_fc) else float("nan"),
        "legit_rows_fast_cleared_share": float(fast_cleared[~fraud].mean()) if (~fraud).any() else float("nan"),
        "routing_share": {
            "fast_clear": float(fast_cleared.mean()),
            "layer2": float(adj.mean()),
            "bypass_quarantine": float((~adj & quarantined).mean()),
        },
        "by_typology": {
            typ: float((fast_cleared & (test_df["fraud_type"].to_numpy() == typ)).sum()
                       / max((test_df["fraud_type"].to_numpy() == typ).sum(), 1))
            for typ in TYPOLOGIES
        },
    }

    point = {name: point_metrics(y, sysd["score"], sysd["pred"], sysd.get("prob"), name=name)
             for name, sysd in systems.items()}
    events = {"cascade": event_recall(test_df, quarantined),
              "cascade_incl_review": event_recall(test_df, flagged_incl_review),
              "baseline": event_recall(test_df, base_pred)}
    row_recall_by_typology = {
        typ: float(quarantined[test_df["fraud_type"].to_numpy() == typ].mean())
        if (test_df["fraud_type"].to_numpy() == typ).any() else float("nan")
        for typ in TYPOLOGIES
    }

    latency = benchmark_latency(pipeline, test_df, latency_iterations) if include_latency else None

    c, lift = boot["cascade"], boot["cascade_vs_baseline"]
    floors = {
        "pr_auc_lift": floor_verdict(lift["pr_auc_lift"]["point"], lift["pr_auc_lift"]["ci_low"],
                                     lift["pr_auc_lift"]["ci_high"], ">=", FLOORS["pr_auc_lift"][1]),
        "f1": floor_verdict(c["f1"]["point"], c["f1"]["ci_low"], c["f1"]["ci_high"], ">=", FLOORS["f1"][1]),
        "fpr": floor_verdict(c["fpr"]["point"], c["fpr"]["ci_low"], c["fpr"]["ci_high"], "<", FLOORS["fpr"][1]),
    }
    floors["fpr"]["target"] = FLOORS["fpr"][2]
    floors["fpr"]["target_point_met"] = bool(c["fpr"]["point"] < FLOORS["fpr"][2])
    if latency is not None:
        floors["l1_latency_ms"] = floor_verdict(latency["l1_compiled_mean_ms"], None, None, "<",
                                                FLOORS["l1_latency_ms"][1])
        floors["l1_latency_ms"]["target"] = FLOORS["l1_latency_ms"][2]
        floors["l1_latency_ms"]["target_point_met"] = bool(latency["l1_compiled_mean_ms"] < FLOORS["l1_latency_ms"][2])

    return {
        "test_rows": int(len(y)),
        "test_fraud_rows": int(fraud.sum()),
        "bootstrap": boot,
        "point_metrics": point,
        "event_recall": events,
        "row_recall_by_typology": row_recall_by_typology,
        "fast_clear_leakage": leakage,
        "ablations": ablations,
        "calibration": {
            "brier_layer2_cohort": c.get("brier_layer2", {}).get("point"),
            "brier_all_rows": c["brier"]["point"],
            "reliability_layer2_cohort": _reliability(
                p[adj], y[adj], (0.0, 0.1, 0.3, pipeline.review_xgb_threshold, thr, 1.0)),
        },
        "baseline_parameters": {"amount_ceiling": baseline.amount_ceiling, "count_cap": baseline.count_cap,
                                "amount_percentile": baseline.amount_percentile,
                                "count_percentile": baseline.count_percentile},
        "latency": latency,
        "floors": floors,
    }


# ---------------------------------------------------------------------------
# Markdown report
# ---------------------------------------------------------------------------

def _fmt(v: Optional[float], nd: int = 4, pct: bool = False) -> str:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "n/a"
    return f"{v * 100:.{max(nd - 2, 2)}f}%" if pct else f"{v:.{nd}f}"


def _ci_str(m: Mapping[str, Any], nd: int = 4, pct: bool = False) -> str:
    if m.get("ci_low") is None:
        return _fmt(m["point"], nd, pct)
    return f"{_fmt(m['point'], nd, pct)} [{_fmt(m['ci_low'], nd, pct)}, {_fmt(m['ci_high'], nd, pct)}]"


def generate_markdown_report(
    results: Dict[str, Any],
    split_metadata: Mapping[str, Any],
    training_metadata: Mapping[str, Any],
    dataset_summary: Mapping[str, Any],
    stability: Optional[Mapping[str, Any]] = None,
) -> str:
    """Renders the evaluation as Markdown (written by train.py as UTF-8)."""
    boot = results["bootstrap"]
    c, b, lift = boot["cascade"], boot["baseline"], boot["cascade_vs_baseline"]
    xc, xr = boot["xgb_calibrated_standalone"], boot["xgb_raw_standalone"]
    nb = boot["_meta"]["bootstrap"]
    tm = training_metadata
    f_thr, q_iso = tm["filter_isolation_threshold"], tm["quarantine_isolation_threshold"]
    r_thr, q_xgb = tm["review_xgb_threshold"], tm["quarantine_xgb_threshold"]
    md: List[str] = []
    md.append(f"# SalesMesh ML Risk Engine (Module 2) — Evaluation Report ({training_metadata.get('model_version')})\n\n")
    md.append(
        "All intervals are 95% cluster-bootstrap CIs "
        f"({nb['n_boot']} resamples of {nb['n_components']} agent components in the test partition). "
        f"Thresholds are fixed at s {f_thr:.2f} / {q_iso:.2f} and p {r_thr:.2f} / {q_xgb:.2f} and were never tuned on test. "
        "PR-AUC = average precision.\n\n"
    )

    md.append("## 1. Floors (directive Section 8)\n\n| Floor | Requirement | Point | 95% CI | Point verdict | CI verdict |\n|---|---|---|---|---|---|\n")
    labels = {"pr_auc_lift": "PR-AUC lift over baseline", "f1": "F1 (QUARANTINE)", "fpr": "FPR",
              "l1_latency_ms": "Layer-1 latency (ms, mean)"}
    for key, f in results["floors"].items():
        pct = key == "fpr"
        req = f"{f['direction']} {_fmt(f['floor'], 4, pct) if pct else f['floor']}"
        if f.get("target") is not None:
            req += f" (target < {_fmt(f['target'], 4, pct) if pct else f['target']})"
        ci = "n/a" if f["ci_low"] is None else f"[{_fmt(f['ci_low'], 4, pct)}, {_fmt(f['ci_high'], 4, pct)}]"
        md.append(f"| {labels[key]} | {req} | {_fmt(f['point'], 4, pct)} | {ci} | "
                  f"{'PASS' if f['point_pass'] else 'FAIL'} | {f['ci_verdict'].upper()} |\n")
    md.append("\n*CI verdict: PASS = whole CI meets the floor, FAIL = whole CI misses it, "
              "INCONCLUSIVE = CI straddles the floor.*\n\n")

    md.append("## 2. Data and Split\n\n")
    md.append(f"- Dataset: {dataset_summary['rows']:,} rows, {dataset_summary['fraud_rows']:,} fraud rows, "
              f"{dataset_summary['fraud_events']} fraud events "
              f"({dataset_summary['events_by_typology'].get('commission_stuffing', 0)} stuffing, "
              f"{dataset_summary['events_by_typology'].get('circular_chaining', 0)} chaining).\n")
    sm = split_metadata
    md.append(f"- Split seed {sm['seed']}: {sm['total_agents']} agents in {sm['total_components']} components; "
              f"{sm['dev_agents_count']} dev / {sm['test_agents_count']} test agents. "
              f"{sm['events_straddling_time_cutoffs']} events straddle a time cutoff; "
              f"{sm['val_events_excluded_shared_with_train']} validation "
              + ("event" if sm["val_events_excluded_shared_with_train"] == 1 else "events") +
              f" ({sm['val_rows_excluded_shared_with_train']} rows) with rows also in train "
              + ("was" if sm["val_events_excluded_shared_with_train"] == 1 else "were") + " excluded "
              "from validation so the calibrator never sees a training event.\n\n")
    md.append("| Partition | Agents | Window | Rows | Fraud rows | Fraud events |\n|---|---|---|---|---|---|\n")
    md.append(f"| Train | {sm['train_agents_count']} (dev) | <= {sm['t_split1']} | {sm['train_rows']:,} | {sm['train_frauds']} | {sm['train_fraud_events']} |\n")
    md.append(f"| Validation (calibration) | {sm['val_agents_count']} (dev) | ({sm['t_split1']}, {sm['t_split2']}] | {sm['val_rows']:,} | {sm['val_frauds']} | {sm['val_fraud_events']} |\n")
    md.append(f"| Test (unseen agents, out of time) | {sm['test_agents_count']} | > {sm['t_split2']} | {sm['test_rows']:,} | {sm['test_frauds']} | {sm['test_fraud_events']} |\n\n")

    md.append("## 3. Headline Metrics (test partition)\n\n| System | PR-AUC | F1 | Precision | Recall | FPR | Event recall | Brier |\n|---|---|---|---|---|---|---|---|\n")
    for label, m, brier in (
        ("**Cascade** (PR-AUC on operating score)", c, c.get("brier_layer2")),
        (f"XGBoost calibrated, standalone (p >= {q_xgb:.2f} on all rows)", xc, xc.get("brier")),
        ("XGBoost raw, standalone", xr, xr.get("brier")),
        ("Naive baseline (P99.5 amount ceiling + 24 h count cap)", b, None),
    ):
        md.append(f"| {label} | {_ci_str(m['pr_auc'])} | {_ci_str(m['f1'])} | {_ci_str(m['precision'])} | "
                  f"{_ci_str(m['recall'])} | {_ci_str(m['fpr'], 4, True)} | {_ci_str(m['event_recall'])} | "
                  f"{_ci_str(brier, 5) if brier else 'n/a'} |\n")
    md.append(f"\n- Paired lift over baseline: PR-AUC {_ci_str(lift['pr_auc_lift'])}, F1 {_ci_str(lift['f1_lift'])}, "
              f"event recall {_ci_str(lift['event_recall_lift'])}.\n")
    md.append(f"- Operating-score (cascade) PR-AUC {_fmt(c['pr_auc']['point'])} vs standalone calibrated XGBoost "
              f"PR-AUC {_fmt(xc['pr_auc']['point'])}: the difference is what the Layer-1 routing costs or adds to the ranking.\n")
    md.append(f"- Cascade Brier is over Layer-2-adjudicated rows (the cohort p is calibrated for); "
              f"over all rows it is {_ci_str(c['brier'], 5)}.\n\n")

    md.append("## 4. Event-Level and Per-Typology Recall (QUARANTINE)\n\n"
              "| Typology | Events | Detected | Event recall (cluster-bootstrap 95% CI) | "
              "Exact 95% CI (Clopper–Pearson) | Row recall |\n|---|---|---|---|---|---|\n")
    ev = results["event_recall"]["cascade"]

    def _exact(e: Mapping[str, Any]) -> str:
        return "n/a" if e["exact_ci_low"] is None else f"[{_fmt(e['exact_ci_low'])}, {_fmt(e['exact_ci_high'])}]"

    md.append(f"| All | {ev['events']} | {ev['detected']} | {_ci_str(c['event_recall'])} | {_exact(ev)} | "
              f"{_ci_str(c['recall'])} |\n")
    for typ in TYPOLOGIES:
        md.append(f"| {typ} | {ev[typ]['events']} | {ev[typ]['detected']} | {_ci_str(c['event_recall_' + typ])} | "
                  f"{_exact(ev[typ])} | {_fmt(results['row_recall_by_typology'][typ])} |\n")
    md.append("\n*The percentile bootstrap collapses to zero width when every event is detected; "
              "the exact Clopper–Pearson interval does not.*\n")
    evr = results["event_recall"]["cascade_incl_review"]
    md.append(f"\nCounting REVIEW as a flag as well: event recall {_fmt(evr['event_recall'])} "
              f"({evr['detected']}/{evr['events']}).\n\n")

    lk = results["fast_clear_leakage"]
    md.append(f"## 5. Fast-Clear Leakage (s < {f_thr:.2f} cleared without Layer 2)\n\n")
    md.append(f"- Fraud rows fast-cleared: {lk['fraud_rows_fast_cleared']}/{lk['fraud_rows']} "
              f"({_fmt(lk['fraud_row_leakage_rate'], 4, True)}); by typology: "
              + ", ".join(f"{k} {_fmt(v, 4, True)}" for k, v in lk["by_typology"].items()) + ".\n")
    md.append(f"- Fraud events with EVERY row fast-cleared: {lk['fraud_events_fully_fast_cleared']}/{lk['fraud_events']} "
              f"({_fmt(lk['fraud_event_leakage_rate'], 4, True)}).\n")
    md.append(f"- Routing share of test rows: fast-clear {_fmt(lk['routing_share']['fast_clear'], 4, True)}, "
              f"Layer 2 {_fmt(lk['routing_share']['layer2'], 4, True)}, bypass {_fmt(lk['routing_share']['bypass_quarantine'], 4, True)}.\n\n")

    md.append("## 6. Ablations (same fitted models, decision policy only; point estimates)\n\n| Policy | PR-AUC (operating score) | F1 | Precision | Recall | FPR | FP | Event recall | Layer-2 share |\n|---|---|---|---|---|---|---|---|---|\n")
    for label, m in results["ablations"].items():
        md.append(f"| {label} | {_fmt(m['pr_auc'])} | {_fmt(m['f1'])} | {_fmt(m['precision'])} | {_fmt(m['recall'])} | "
                  f"{_fmt(m['fpr'], 4, True)} | {m['false_positives']} | {_fmt(m['event_recall'])} | "
                  f"{_fmt(m.get('layer2_share_of_rows'), 4, True) if 'layer2_share_of_rows' in m else '—'} |\n")
    md.append("\n")

    md.append("## 7. Training Cohorts and Calibration\n\n")
    md.append(f"- XGBoost cohort: `{tm['xgb_cohort']}` — {tm['train_samples_xgb']:,} rows "
              f"({tm['train_positives_xgb']} fraud), scale_pos_weight = {tm['scale_pos_weight']}.\n")
    md.append(f"- Isotonic calibration cohort: `{tm['calibration_cohort']}` — {tm['calibration_rows']:,} val rows "
              f"({tm['calibration_positives']} fraud).\n")
    md.append(f"- SHAP attributions are in {tm['shap_attribution_units']} units.\n\n")
    md.append("Reliability on the Layer-2 cohort of the test partition:\n\n| p bin | n | mean p | observed fraud rate |\n|---|---|---|---|\n")
    for r in results["calibration"]["reliability_layer2_cohort"]:
        md.append(f"| {r['bin']} | {r['n']} | {_fmt(r['mean_p'])} | {_fmt(r['observed_rate'])} |\n")
    bp = results["baseline_parameters"]
    md.append(f"\nBaseline (fitted on train): amount ceiling KES {bp['amount_ceiling']:,.2f}, "
              f"24 h count cap {bp['count_cap']:.2f}.\n\n")

    lat = results.get("latency")
    if lat:
        md.append("## 8. Latency (single row, ms)\n\n")
        md.append(f"- Layer 1 compiled traversal: mean {lat['l1_compiled_mean_ms']:.3f}, p50 {lat['l1_compiled_p50_ms']:.3f}, "
                  f"p99 {lat['l1_compiled_p99_ms']:.3f} (sklearn `score_samples`: mean {lat['l1_sklearn_mean_ms']:.3f}).\n")
        md.append(f"- Full cascade without SHAP: mean {lat['cascade_without_shap_mean_ms']:.3f}; "
                  f"with top-3 SHAP: mean {lat['cascade_with_shap_mean_ms']:.3f}, p99 {lat['cascade_with_shap_p99_ms']:.3f}.\n\n")

    if stability:
        md.append(format_stability_markdown(stability))
    return "".join(md)


def format_stability_markdown(stability: Mapping[str, Any]) -> str:
    s = stability["summary"]
    lo, hi = stability["test_events_range"]
    md = [f"## 9. Stability: {stability['n_repeats']} Repeated Splits\n\n",
          f"Seeds {stability['seeds']} change which agent components are test agents and the model seeds; "
          f"time cutoffs are fixed. Test fraud events per repeat: {lo}–{hi}.\n\n",
          "| Metric | Mean | Std | Min | Max |\n|---|---|---|---|---|\n"]
    for name, v in s.items():
        md.append(f"| {name} | {_fmt(v['mean'])} | {_fmt(v['std'])} | {_fmt(v['min'])} | {_fmt(v['max'])} |\n")
    md.append("\n")
    return "".join(md)
