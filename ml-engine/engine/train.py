"""
train.py
--------
Training + evaluation pipeline for the SalesMesh two-layer risk cascade.

1. Load the featured dataset; summarise fraud events.
2. Chronological, agent-component-grouped split (seed 42 by default).
3. Fit the cascade (IsolationForest -> XGBoost on s >= 0.45 -> isotonic on
   val candidates) with FIXED thresholds 0.45 / 0.72 / 0.85 / 0.50.
4. Fit the naive baseline on train percentiles.
5. Evaluate on test with cluster-bootstrap CIs, event recall, ablations,
   fast-clear leakage, latency and floor verdicts.
6. Run the repeated-split stability check.
7. Save the artifact (+ .sha256 sidecar), metrics.json and the Markdown
   report (UTF-8).
"""

import argparse
import hashlib
import json
import math
import os
import sys
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.baseline import NaiveRuleBaseline
from engine.cascade import RiskCascadePipeline
from engine.eval import generate_markdown_report, run_full_evaluation
from engine.features import BASELINE_COUNT_COLUMN, FEATURE_COLUMNS
from engine.split import agent_components, chronological_agent_grouped_split
from engine.stability import repeated_split_evaluation


def to_jsonable(obj: Any) -> Any:
    """Recursively converts numpy/pandas scalars and NaN/inf to JSON-safe values."""
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [to_jsonable(v) for v in obj.tolist()]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if math.isfinite(f) else None
    return obj


def dataset_summary(df: pd.DataFrame) -> Dict[str, Any]:
    fraud = df[df["is_fraud"] == 1]
    return {
        "rows": int(len(df)),
        "agents": int(df["agent_id"].nunique()),
        "fraud_rows": int(len(fraud)),
        "fraud_events": int(fraud["group_id"].nunique()),
        "events_by_typology": {k: int(v) for k, v in fraud.groupby("fraud_type")["group_id"].nunique().items()},
    }


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _log(verbose: bool, msg: str) -> None:
    if verbose:
        print(msg, flush=True)


def train_and_evaluate(
    dataset_path: str,
    model_version: str = "v1.1.0",
    output_model: Optional[str] = "models/risk_cascade_v1.1.0.joblib",
    output_report: Optional[str] = "reports/evaluation_report.md",
    output_metrics: Optional[str] = "reports/metrics.json",
    seed: int = 42,
    stability_repeats: int = 5,
    n_bootstrap: int = 1000,
    verbose: bool = True,
) -> Dict[str, Any]:
    """Runs the full pipeline and returns the metrics dictionary written to ``output_metrics``."""
    _log(verbose, f"[1/6] Loading {dataset_path}")
    df = pd.read_csv(dataset_path)
    missing = [c for c in FEATURE_COLUMNS + [BASELINE_COUNT_COLUMN, "group_id", "is_fraud"] if c not in df.columns]
    if missing:
        raise ValueError(f"Dataset is missing columns {missing}; regenerate it with generate_dataset.py")
    summary = dataset_summary(df)
    _log(verbose, f"      {summary['rows']:,} rows, {summary['fraud_rows']:,} fraud rows, "
                  f"{summary['fraud_events']} events {summary['events_by_typology']}")

    _log(verbose, "[2/6] Chronological, agent-component-grouped split")
    train_df, val_df, test_df, split_meta = chronological_agent_grouped_split(df, seed=seed)
    components = agent_components(df)
    for part in ("train", "val", "test"):
        _log(verbose, f"      {part:5s}: {split_meta[part + '_rows']:,} rows, {split_meta[part + '_frauds']} fraud rows, "
                      f"{split_meta[part + '_fraud_events']} events")

    _log(verbose, "[3/6] Fitting cascade and baseline")
    pipeline = RiskCascadePipeline(model_version=model_version, random_state=seed)
    pipeline.fit(train_df, val_df=val_df)
    baseline = NaiveRuleBaseline().fit(train_df)
    tm = pipeline.training_metadata
    _log(verbose, f"      XGBoost cohort {tm['xgb_cohort']}: {tm['train_samples_xgb']:,} rows "
                  f"({tm['train_positives_xgb']} fraud); calibration {tm['calibration_cohort']}: "
                  f"{tm['calibration_rows']:,} rows ({tm['calibration_positives']} fraud)")

    _log(verbose, f"[4/6] Evaluating on test ({n_bootstrap} cluster-bootstrap resamples)")
    results = run_full_evaluation(pipeline, test_df, baseline, components, n_bootstrap=n_bootstrap, seed=seed)
    for key, f in results["floors"].items():
        ci = "" if f["ci_low"] is None else f" CI [{f['ci_low']:.4f}, {f['ci_high']:.4f}]"
        _log(verbose, f"      {key:14s} {f['point']:.4f}{ci} -> point {'PASS' if f['point_pass'] else 'FAIL'}, "
                      f"CI {f['ci_verdict']}")

    stability = None
    if stability_repeats > 0:
        _log(verbose, f"[5/6] Stability check ({stability_repeats} repeats)")
        stability = repeated_split_evaluation(df, n_repeats=stability_repeats, base_seed=seed)
        s = stability["summary"]
        _log(verbose, f"      PR-AUC(op) {s['pr_auc_operating']['mean']:.4f} +/- {s['pr_auc_operating']['std']:.4f}; "
                      f"F1 {s['f1']['mean']:.4f} +/- {s['f1']['std']:.4f}")

    _log(verbose, "[6/6] Writing artifacts")
    if output_model:
        digest = pipeline.save(output_model)
        _log(verbose, f"      model  -> {output_model} (sha256 {digest[:12]}...)")
    metrics = to_jsonable({
        "model_version": model_version,
        "model_sha256": pipeline.artifact_sha256,
        "dataset": {"path": os.path.basename(dataset_path), "sha256": file_sha256(dataset_path), **summary},
        "split_metadata": split_meta,
        "training_metadata": tm,
        "evaluation": results,
        "stability_check": stability,
    })
    if output_metrics:
        os.makedirs(os.path.dirname(os.path.abspath(output_metrics)), exist_ok=True)
        with open(output_metrics, "w", encoding="utf-8") as fh:
            json.dump(metrics, fh, indent=2, ensure_ascii=False, allow_nan=False)
        _log(verbose, f"      metrics -> {output_metrics}")
    if output_report:
        os.makedirs(os.path.dirname(os.path.abspath(output_report)), exist_ok=True)
        report = generate_markdown_report(results, split_meta, tm, summary, stability)
        with open(output_report, "w", encoding="utf-8") as fh:
            fh.write(report)
        _log(verbose, f"      report  -> {output_report}")
    return metrics


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train and evaluate the SalesMesh ML risk cascade.")
    p.add_argument("--dataset", default="salesmesh_fraud_dataset.csv", help="Featured dataset CSV.")
    p.add_argument("--model-version", default="v1.1.0", help="Model version tag (<= 20 chars).")
    p.add_argument("--output-model", default=None, help="Artifact path (default models/risk_cascade_<version>.joblib).")
    p.add_argument("--output-report", default="reports/evaluation_report.md")
    p.add_argument("--output-metrics", default="reports/metrics.json")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--stability-repeats", type=int, default=5, help="Repeated splits (0 to skip).")
    p.add_argument("--n-bootstrap", type=int, default=1000, help="Cluster-bootstrap resamples.")
    return p.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    if not os.path.exists(args.dataset):
        print(f"Error: dataset not found: {args.dataset}", file=sys.stderr)
        sys.exit(1)
    train_and_evaluate(
        dataset_path=args.dataset,
        model_version=args.model_version,
        output_model=args.output_model or f"models/risk_cascade_{args.model_version}.joblib",
        output_report=args.output_report,
        output_metrics=args.output_metrics,
        seed=args.seed,
        stability_repeats=args.stability_repeats,
        n_bootstrap=args.n_bootstrap,
    )


if __name__ == "__main__":
    main()
