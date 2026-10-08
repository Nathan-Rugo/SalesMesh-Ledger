"""
SalesMesh ML Risk Engine (Module 2)
"""

from engine.base_traffic import (
    generate_synthetic_base_traffic,
    load_paysim_as_base_traffic,
)
from engine.baseline import NaiveRuleBaseline
from engine.cascade import ArtifactIntegrityError, RiskCascadePipeline, library_versions
from engine.eval import (
    benchmark_latency,
    cluster_bootstrap,
    point_metrics,
    run_full_evaluation,
)
from engine.fast_iforest import CompiledIsolationForest
from engine.features import (
    BASELINE_COUNT_COLUMN,
    FEATURE_COLUMNS,
    build_feature_matrix,
    compute_features_from_history,
    compute_transaction_features,
)
from engine.fraud_injector import (
    inject_circular_chaining,
    inject_commission_stuffing,
)
from engine.split import agent_components, chronological_agent_grouped_split
from engine.stability import repeated_split_evaluation
from engine.train import train_and_evaluate

__all__ = [
    "FEATURE_COLUMNS",
    "BASELINE_COUNT_COLUMN",
    "build_feature_matrix",
    "compute_transaction_features",
    "compute_features_from_history",
    "generate_synthetic_base_traffic",
    "load_paysim_as_base_traffic",
    "inject_commission_stuffing",
    "inject_circular_chaining",
    "agent_components",
    "chronological_agent_grouped_split",
    "CompiledIsolationForest",
    "NaiveRuleBaseline",
    "RiskCascadePipeline",
    "ArtifactIntegrityError",
    "library_versions",
    "point_metrics",
    "cluster_bootstrap",
    "benchmark_latency",
    "run_full_evaluation",
    "repeated_split_evaluation",
    "train_and_evaluate",
]
