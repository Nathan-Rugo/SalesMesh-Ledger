"""
paysim_profile.py
-----------------
Fits the base-traffic calibration profile (hour-of-day weights and a
day-to-day volume multiplier) from the real PaySim1 CSV, streamed in
chunks so the 6.36M-row file is never loaded whole.

Source: PaySim1 (Lopez-Rojas, Elmir & Axelsson, 2016), Kaggle
``ealaxi/paysim1``, CC BY-SA 4.0. The CSV is not committed; only the
fitted parameters are (``data/paysim_profile.json``).

Mapping (spec gh-18): step s covers hours [s-1, s), so hour = (s-1) mod 24
and day = (s-1) // 24. Only PAYMENT and CASH_IN rows are used, with no
other filter. Only ``step``, ``type`` and ``amount`` are read, so
``isFraud`` / ``isFlaggedFraud`` can never influence the fit.

Usage (from ml-engine/):
    python -m engine.paysim_profile CSV --out data/paysim_profile.json
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import date
from typing import Any, Dict

import numpy as np
import pandas as pd

USED_TYPES = ("PAYMENT", "CASH_IN")
REQUIRED_COLUMNS = ("step", "type", "amount")
BUSY_DAY_FRACTION = 0.5
SENSITIVITY_FRACTIONS = (0.4, 0.6)
QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.95, 0.99)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def busy_day_cv(day_totals: Dict[int, int], fraction: float):
    """Keeps days with total >= fraction * max; returns (kept, dropped, method-of-moments CV of kept totals)."""
    peak = max(day_totals.values())
    kept = sorted(d for d, n in day_totals.items() if n >= fraction * peak)
    dropped = sorted(d for d in day_totals if d not in kept)
    totals = np.array([day_totals[d] for d in kept], dtype=float)
    return kept, dropped, float(totals.std() / totals.mean())  # population std (ddof=0)


def fit_profile(csv_path: str, chunksize: int = 500_000) -> Dict[str, Any]:
    """Streams ``csv_path`` and returns the profile dict. Raises ValueError on missing or garbled columns."""
    header = pd.read_csv(csv_path, nrows=0).columns
    missing = [c for c in REQUIRED_COLUMNS if c not in header]
    if missing:
        raise ValueError(f"PaySim CSV {csv_path} is missing columns {missing}")

    hour_counts = np.zeros(24, dtype=np.int64)
    day_counts: Dict[int, int] = {}
    amounts = []  # only the PAYMENT/CASH_IN amount column (~3.6M floats, ~29 MB) is kept for exact quantiles
    rows_total = rows_used = max_step = 0
    for chunk in pd.read_csv(csv_path, usecols=list(REQUIRED_COLUMNS), chunksize=chunksize):
        rows_total += len(chunk)
        try:
            step = pd.to_numeric(chunk["step"], errors="raise")
            amount = pd.to_numeric(chunk["amount"], errors="raise")
        except (ValueError, TypeError) as exc:
            raise ValueError(f"PaySim CSV {csv_path} has non-numeric step/amount: {exc}") from exc
        if step.isna().any() or amount.isna().any() or (step != np.floor(step)).any() or (step < 1).any():
            raise ValueError(f"PaySim CSV {csv_path} has missing, fractional or < 1 step values, or missing amounts")
        max_step = max(max_step, int(step.max()))
        used = chunk["type"].isin(USED_TYPES).to_numpy()
        s = step.to_numpy()[used].astype(np.int64) - 1
        hour_counts += np.bincount(s % 24, minlength=24)
        days, counts = np.unique(s // 24, return_counts=True)
        for d, n in zip(days.tolist(), counts.tolist()):
            day_counts[d] = day_counts.get(d, 0) + n
        amounts.append(amount.to_numpy()[used])
        rows_used += int(used.sum())
    if rows_used == 0:
        raise ValueError(f"PaySim CSV {csv_path} has no {'/'.join(USED_TYPES)} rows")

    # days with no PAYMENT/CASH_IN rows (e.g. PaySim's last day) still count, as zero-total dropped days
    day_counts = {d: day_counts.get(d, 0) for d in range((max_step - 1) // 24 + 1)}
    kept, dropped, cv = busy_day_cv(day_counts, BUSY_DAY_FRACTION)
    all_amounts = np.concatenate(amounts)
    return {
        "source": {
            "dataset": "PaySim1 (Lopez-Rojas, Elmir & Axelsson, 2016)",
            "url": "https://www.kaggle.com/datasets/ealaxi/paysim1",
            "licence": "CC BY-SA 4.0",
            "file": os.path.basename(csv_path),
            "sha256": _sha256(csv_path),
        },
        "fit_date": date.today().isoformat(),
        "mapping": {
            "step_to_time": "step s covers hours [s-1, s): hour = (s-1) mod 24, day = (s-1) // 24",
            "types_used": list(USED_TYPES),
            "other_filters": "none (isFraud / isFlaggedFraud are never read)",
        },
        "rows_total": rows_total,
        "rows_used": rows_used,
        "hour_counts": hour_counts.tolist(),
        "hour_weights": (hour_counts / hour_counts.sum()).tolist(),
        "day_totals": [day_counts[d] for d in sorted(day_counts)],  # index = day
        "busy_day_rule": f"keep days with total >= {BUSY_DAY_FRACTION} x the largest day's total",
        "kept_days": kept,
        "dropped_days": dropped,
        "day_multiplier_cv": cv,
        "cv_estimator": "method of moments over kept-day totals: population std / mean",
        "cv_sensitivity": {str(f): busy_day_cv(day_counts, f)[2] for f in SENSITIVITY_FRACTIONS},
        "amount_quantiles": {str(q): float(np.quantile(all_amounts, q)) for q in QUANTILES},
        "amount_note": "reference only; synthetic amounts stay log-normal (median KES 1,500, sigma 0.9)",
    }


def load_profile(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description="Fit the base-traffic profile from the PaySim1 CSV.")
    p.add_argument("csv", help="Path to PaySim1 Synthetic_Financial_datasets_log.csv")
    p.add_argument("--out", default="data/paysim_profile.json")
    args = p.parse_args(argv)
    try:
        profile = fit_profile(args.csv)
    except (ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(profile, fh, sort_keys=True, indent=2)
        fh.write("\n")
    print(f"{profile['rows_total']:,} rows read, {profile['rows_used']:,} used; "
          f"kept days {len(profile['kept_days'])}, CV {profile['day_multiplier_cv']:.4f} -> {args.out}")


if __name__ == "__main__":
    main()
