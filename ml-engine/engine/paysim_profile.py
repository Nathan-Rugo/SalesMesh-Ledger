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
import tempfile
from datetime import date
from typing import Any, Dict

import numpy as np
import pandas as pd

USED_TYPES = ("PAYMENT", "CASH_IN")
REQUIRED_COLUMNS = ("step", "type", "amount")
BUSY_DAY_FRACTION = 0.5
SENSITIVITY_FRACTIONS = (0.4, 0.6)
QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.95, 0.99)
MAX_STEP = 10_000  # PaySim1 has 743 steps; anything far beyond is corrupt input
CV_BOOTSTRAP = 10_000
CV_BOOTSTRAP_SEED = 0


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
    cv = float(totals.std() / totals.mean())  # population std (ddof=0)
    if not cv > 0:
        raise ValueError(f"busy-day CV is {cv} over {len(kept)} kept day(s) at {fraction} x max; "
                         "need at least two busy days with different totals")
    return kept, dropped, cv


def cv_bootstrap_ci(totals, n_boot: int = CV_BOOTSTRAP, seed: int = CV_BOOTSTRAP_SEED):
    """Seeded percentile 95% interval of the population CV, resampling the kept days with replacement."""
    x = np.asarray(totals, dtype=float)
    samples = np.random.default_rng(seed).choice(x, size=(n_boot, len(x)), replace=True)
    cvs = samples.std(axis=1) / samples.mean(axis=1)
    return [float(np.quantile(cvs, 0.025)), float(np.quantile(cvs, 0.975))]


def validate_profile(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Checks the fields the generator uses; raises ValueError with a clear message."""
    if not isinstance(profile, dict):
        raise ValueError("PaySim profile must be a JSON object")
    missing = [k for k in ("hour_weights", "day_multiplier_cv") if k not in profile]
    if missing:
        raise ValueError(f"PaySim profile is missing keys {missing}")
    try:
        w = np.asarray(profile["hour_weights"], dtype=float)
        cv = float(profile["day_multiplier_cv"])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"PaySim profile has non-numeric hour_weights or day_multiplier_cv: {exc}") from exc
    if w.shape != (24,) or not np.all(np.isfinite(w)) or (w < 0).any() or abs(w.sum() - 1.0) > 1e-6:
        raise ValueError("PaySim profile hour_weights must be 24 finite non-negative numbers summing to 1 (+/- 1e-6)")
    if not (np.isfinite(cv) and cv > 0):
        raise ValueError(f"PaySim profile day_multiplier_cv must be finite and > 0, got {cv}")
    return profile


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
        if (step > MAX_STEP).any():
            raise ValueError(f"PaySim CSV {csv_path} has step values above {MAX_STEP} (max {int(step.max())})")
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
        "day_multiplier_cv_ci95": cv_bootstrap_ci([day_counts[d] for d in kept]),
        "cv_ci_method": f"percentile bootstrap over kept days, {CV_BOOTSTRAP} resamples, seed {CV_BOOTSTRAP_SEED}",
        "cv_estimator": "method of moments over kept-day totals: population std / mean",
        "cv_sensitivity": {str(f): busy_day_cv(day_counts, f)[2] for f in SENSITIVITY_FRACTIONS},
        "amount_quantiles": {str(q): float(np.quantile(all_amounts, q)) for q in QUANTILES},
        "amount_note": "reference only; synthetic amounts stay log-normal (median KES 1,500, sigma 0.9)",
    }


def load_profile(path: str) -> Dict[str, Any]:
    """Loads and validates a profile JSON; malformed JSON or bad fields raise ValueError."""
    with open(path, encoding="utf-8") as fh:
        try:
            profile = json.load(fh)
        except json.JSONDecodeError as exc:
            raise ValueError(f"PaySim profile {path} is not valid JSON: {exc}") from exc
    return validate_profile(profile)


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
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")  # same directory, so os.replace is atomic
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(profile, fh, sort_keys=True, indent=2)
            fh.write("\n")
        os.replace(tmp, args.out)
    except BaseException:
        os.unlink(tmp)
        raise
    print(f"{profile['rows_total']:,} rows read, {profile['rows_used']:,} used; "
          f"kept days {len(profile['kept_days'])}, CV {profile['day_multiplier_cv']:.4f} -> {args.out}")


if __name__ == "__main__":
    main()
