"""
stability.py
-------------
Repeated-split stability check (finding 25: previously never executed).

Re-runs split -> fit -> evaluate for ``n_repeats`` seeds. Each seed
changes which agent components become test agents (time cutoffs stay
fixed) and the model random seeds. Point estimates only - the cluster
bootstrap quantifies sampling uncertainty within one split; this
quantifies sensitivity to the agent assignment and model seed.
"""

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from engine.baseline import NaiveRuleBaseline
from engine.cascade import RiskCascadePipeline
from engine.eval import run_full_evaluation
from engine.split import agent_components, chronological_agent_grouped_split

STABILITY_METRICS = (
    "pr_auc_operating", "pr_auc_xgb_standalone", "f1", "precision", "recall", "fpr",
    "event_recall", "pr_auc_lift",
)


def repeated_split_evaluation(
    df: pd.DataFrame,
    n_repeats: int = 5,
    base_seed: int = 42,
    model_version_prefix: str = "stab",
    **cascade_kwargs: Any,
) -> Dict[str, Any]:
    """Returns per-repeat metrics and mean/std/min/max summaries."""
    if n_repeats < 1:
        raise ValueError("n_repeats must be >= 1")
    components = agent_components(df)
    per_repeat: List[Dict[str, Any]] = []
    for i in range(n_repeats):
        seed = base_seed + i
        train_df, val_df, test_df, meta = chronological_agent_grouped_split(df, seed=seed)
        pipeline = RiskCascadePipeline(model_version=f"{model_version_prefix}-s{seed}", random_state=seed,
                                       **cascade_kwargs)
        pipeline.fit(train_df, val_df=val_df)
        baseline = NaiveRuleBaseline().fit(train_df)
        res = run_full_evaluation(pipeline, test_df, baseline, components, n_bootstrap=0, include_latency=False)
        c = res["bootstrap"]["cascade"]
        per_repeat.append({
            "seed": seed,
            "test_rows": meta["test_rows"],
            "test_fraud_rows": meta["test_frauds"],
            "test_fraud_events": meta["test_fraud_events"],
            "val_fraud_events": meta["val_fraud_events"],
            "xgb_cohort": pipeline.training_metadata["xgb_cohort"],
            "calibration_cohort": pipeline.training_metadata["calibration_cohort"],
            "pr_auc_operating": c["pr_auc"]["point"],
            "pr_auc_xgb_standalone": res["bootstrap"]["xgb_calibrated_standalone"]["pr_auc"]["point"],
            "f1": c["f1"]["point"],
            "precision": c["precision"]["point"],
            "recall": c["recall"]["point"],
            "fpr": c["fpr"]["point"],
            "event_recall": c["event_recall"]["point"],
            "pr_auc_lift": res["bootstrap"]["cascade_vs_baseline"]["pr_auc_lift"]["point"],
        })

    summary = {}
    for m in STABILITY_METRICS:
        v = np.array([r[m] for r in per_repeat], dtype=float)
        v = v[np.isfinite(v)]
        summary[m] = {
            "mean": float(v.mean()) if v.size else None,
            "std": float(v.std(ddof=1)) if v.size > 1 else (0.0 if v.size == 1 else None),
            "min": float(v.min()) if v.size else None,
            "max": float(v.max()) if v.size else None,
        }
    events = [r["test_fraud_events"] for r in per_repeat]
    return {
        "n_repeats": n_repeats,
        "seeds": [r["seed"] for r in per_repeat],
        "per_repeat": per_repeat,
        "summary": summary,
        "test_events_range": [int(min(events)), int(max(events))],
    }
