"""
generate_dataset.py
---------------------
End-to-end dataset build: base traffic -> fraud injection -> causal
feature engineering -> labelled CSV (UTF-8).

The synthetic backbone takes its hour-of-day cycle and day-to-day volume
multiplier from the committed PaySim profile (data/paysim_profile.json,
fitted by ``python -m engine.paysim_profile``). A missing profile is an
error, never a silent fallback to uniform timing.

Usage:
    python generate_dataset.py --seed 42
    python generate_dataset.py --paysim-path /path/to/paysim.csv --currency-scale 0.078 --output dataset.csv
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine.base_traffic import generate_synthetic_base_traffic, load_paysim_as_base_traffic
from engine.paysim_profile import load_profile
from engine.features import FEATURE_COLUMNS, build_feature_matrix
from engine.fraud_injector import inject_circular_chaining, inject_commission_stuffing

DEFAULT_PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "paysim_profile.json")


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate a labelled SalesMesh fraud-detection dataset.")
    p.add_argument("--paysim-path", default=None,
                   help="Replay a real PaySim CSV as the backbone (reference only; isFraud is never used).")
    p.add_argument("--currency-scale", type=float, default=None,
                   help="PaySim amount multiplier, replay path only. ~1500/19190 maps the PAYMENT + CASH_IN median "
                        "to KES 1,500; the replay keeps all four types, so it is approximate (reference only).")
    p.add_argument("--profile", default=None,
                   help="PaySim profile JSON for the synthetic backbone (default data/paysim_profile.json).")
    p.add_argument("--output", default="salesmesh_fraud_dataset.csv")
    p.add_argument("--n-agents", type=int, default=300)
    p.add_argument("--n-days", type=int, default=45)
    p.add_argument("--stuffing-sequences", type=int, default=600)
    p.add_argument("--chaining-sequences", type=int, default=300)
    p.add_argument("--chaining-pairs", type=int, default=40)
    p.add_argument("--theta", type=float, default=5000.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)
    if args.currency_scale is not None and not args.paysim_path:
        p.error("--currency-scale applies only with --paysim-path")
    if args.currency_scale is not None and not (math.isfinite(args.currency_scale) and args.currency_scale > 0):
        p.error("--currency-scale must be a finite number > 0")
    if args.profile is not None and args.paysim_path:
        p.error("--profile applies only to the synthetic backbone, not with --paysim-path")
    args.profile = args.profile or DEFAULT_PROFILE
    return args


def main(argv=None) -> None:
    args = parse_args(argv)
    say = (lambda *a: None) if args.quiet else print

    say("[1/4] Building base traffic backbone...")
    if args.paysim_path:
        base = load_paysim_as_base_traffic(args.paysim_path, currency_scale=1.0 if args.currency_scale is None else args.currency_scale)
    else:
        if not os.path.isfile(args.profile):
            sys.exit(f"Error: PaySim profile not found: {args.profile} "
                     "(fit it with: python -m engine.paysim_profile <paysim.csv> --out data/paysim_profile.json)")
        try:
            profile = load_profile(args.profile)
        except (ValueError, OSError) as exc:
            sys.exit(f"Error: invalid PaySim profile {args.profile}: {exc}")
        base = generate_synthetic_base_traffic(n_agents=args.n_agents, n_days=args.n_days, seed=args.seed,
                                               profile=profile)
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
