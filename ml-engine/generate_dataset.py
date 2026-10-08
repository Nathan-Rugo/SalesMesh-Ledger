"""
generate_dataset.py
---------------------
End-to-end dataset build: base traffic -> fraud injection -> causal
feature engineering -> labelled CSV (UTF-8).

Usage:
    python generate_dataset.py --output salesmesh_fraud_dataset.csv --n-agents 300 --n-days 45
    python generate_dataset.py --paysim-path /path/to/paysim.csv --output dataset.csv
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine.base_traffic import generate_synthetic_base_traffic, load_paysim_as_base_traffic
from engine.features import FEATURE_COLUMNS, build_feature_matrix
from engine.fraud_injector import inject_circular_chaining, inject_commission_stuffing


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate a labelled SalesMesh fraud-detection dataset.")
    p.add_argument("--paysim-path", default=None, help="Path to a real PaySim CSV (optional; isFraud is never used).")
    p.add_argument("--output", default="salesmesh_fraud_dataset.csv")
    p.add_argument("--n-agents", type=int, default=300)
    p.add_argument("--n-days", type=int, default=45)
    p.add_argument("--stuffing-sequences", type=int, default=600)
    p.add_argument("--chaining-sequences", type=int, default=300)
    p.add_argument("--chaining-pairs", type=int, default=40)
    p.add_argument("--theta", type=float, default=5000.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--quiet", action="store_true")
    return p.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    say = (lambda *a: None) if args.quiet else print

    say("[1/4] Building base traffic backbone...")
    if args.paysim_path:
        base = load_paysim_as_base_traffic(args.paysim_path)
    else:
        base = generate_synthetic_base_traffic(n_agents=args.n_agents, n_days=args.n_days, seed=args.seed)
    say(f"      {len(base):,} base rows")

    say(f"[2/4] Injecting {args.stuffing_sequences} commission-stuffing events (anchor replacement)...")
    full = inject_commission_stuffing(base, n_sequences=args.stuffing_sequences, theta=args.theta, seed=args.seed + 1)

    say(f"[3/4] Injecting {args.chaining_sequences} circular-chaining events over {args.chaining_pairs} pairs...")
    full = inject_circular_chaining(full, n_chains=args.chaining_sequences, n_pairs=args.chaining_pairs,
                                    seed=args.seed + 2)

    say("[4/4] Engineering causal features...")
    featured = build_feature_matrix(full, theta=args.theta)
    featured.to_csv(args.output, index=False, encoding="utf-8")

    fraud = featured[featured["is_fraud"] == 1]
    say("\n--- Dataset summary ---")
    say(f"Total transactions : {len(featured):,}")
    say(f"Fraud rows         : {len(fraud):,} ({len(fraud) / len(featured):.3%})")
    say(f"Fraud events       : {fraud.groupby('fraud_type')['group_id'].nunique().to_dict()}")
    say(f"Saved to           : {args.output}")
    say("\n--- Mean feature values by fraud_type ---")
    say(featured.groupby("fraud_type")[FEATURE_COLUMNS].mean().round(3).to_string())


if __name__ == "__main__":
    main()
