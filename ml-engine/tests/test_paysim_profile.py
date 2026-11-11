"""
tests/test_paysim_profile.py
----------------------------
gh-18: the streamed PaySim profiler (on a tiny fake PaySim CSV) and the
profile-driven synthetic backbone (hour shares, determinism, anchor supply).
"""

import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd
import pytest

import generate_dataset
from engine.base_traffic import generate_synthetic_base_traffic, load_paysim_as_base_traffic
from engine.paysim_profile import fit_profile, load_profile
from engine.paysim_profile import main as profile_main

PROFILE = load_profile(generate_dataset.DEFAULT_PROFILE)
COLUMNS = ["step", "type", "amount", "nameOrig", "oldbalanceOrg", "newbalanceOrig", "nameDest",
           "oldbalanceDest", "newbalanceDest", "isFraud", "isFlaggedFraud"]


def _fake_paysim(path, day_sizes=(100, 80, 3, 90, 2), seed=0, fraud=0):
    """day_sizes[d] PAYMENT/CASH_IN rows on day d, plus TRANSFER noise that must be ignored."""
    rng = np.random.default_rng(seed)
    rows = []
    for d, n in enumerate(day_sizes):
        for _ in range(n):
            step = 24 * d + int(rng.integers(1, 25))  # steps 24d+1 .. 24d+24 -> day d
            rows.append([step, str(rng.choice(["PAYMENT", "CASH_IN"])), float(rng.uniform(10, 5000)),
                         "C1", 0, 0, "M1", 0, 0, fraud, 0])
        rows.append([24 * d + 1, "TRANSFER", 9e6, "C2", 0, 0, "C3", 0, 0, 1, 0])
    pd.DataFrame(rows, columns=COLUMNS).to_csv(path, index=False)
    return pd.DataFrame(rows, columns=COLUMNS)


def _fitted_fields(p):
    return {k: v for k, v in p.items() if k not in ("source", "fit_date")}


def test_profile_weights_and_busy_day_rule(tmp_path):
    raw = _fake_paysim(tmp_path / "ps.csv")
    p = fit_profile(str(tmp_path / "ps.csv"), chunksize=37)  # small chunks exercise the streaming merge
    assert len(p["hour_weights"]) == 24 and sum(p["hour_weights"]) == pytest.approx(1.0, abs=1e-12)
    used = raw[raw["type"].isin(["PAYMENT", "CASH_IN"])]
    assert p["rows_total"] == len(raw) and p["rows_used"] == len(used)
    assert p["hour_counts"] == np.bincount((used["step"] - 1) % 24, minlength=24).tolist()
    assert p["kept_days"] == [0, 1, 3] and p["dropped_days"] == [2, 4]  # >= 0.5 x 100
    totals = np.array([100, 80, 90], dtype=float)
    assert p["day_multiplier_cv"] == pytest.approx(totals.std() / totals.mean())
    assert set(p["cv_sensitivity"]) == {"0.4", "0.6"}


def test_isfraud_never_changes_the_fit(tmp_path):
    _fake_paysim(tmp_path / "a.csv", fraud=0)
    _fake_paysim(tmp_path / "b.csv", fraud=1)
    a, b = fit_profile(str(tmp_path / "a.csv")), fit_profile(str(tmp_path / "b.csv"))
    assert a["source"]["sha256"] != b["source"]["sha256"]
    assert _fitted_fields(a) == _fitted_fields(b)


@pytest.mark.parametrize("mutate", [
    lambda df: df.drop(columns=["step"]),
    lambda df: df.assign(amount="abc"),
    lambda df: df.assign(step=df["step"].astype(float) + 0.5),
    lambda df: df.assign(step=0),
    lambda df: df.assign(step=10_001),  # corrupt huge step would build a giant day range
    lambda df: df.assign(type="TRANSFER"),  # no PAYMENT / CASH_IN rows
    lambda df: df.iloc[0:0],  # header only
    lambda df: df[df["step"] <= 24],  # one busy day -> CV 0
], ids=["no-step", "text-amount", "fractional-step", "step-0", "huge-step", "no-used-types", "header-only",
        "one-busy-day"])
def test_garbled_input_errors_and_writes_nothing(tmp_path, mutate):
    raw = _fake_paysim(tmp_path / "ok.csv")
    mutate(raw).to_csv(tmp_path / "bad.csv", index=False)
    with pytest.raises(ValueError):
        fit_profile(str(tmp_path / "bad.csv"))
    out = tmp_path / "out.json"
    with pytest.raises(SystemExit) as exc:
        profile_main([str(tmp_path / "bad.csv"), "--out", str(out)])
    assert exc.value.code != 0 and not out.exists()


def test_committed_profile_matches_spec():
    assert PROFILE["rows_total"] == 6_362_620
    assert len(PROFILE["kept_days"]) == 14 and PROFILE["day_multiplier_cv"] == pytest.approx(0.11, abs=0.01)
    assert sum(PROFILE["hour_weights"]) == pytest.approx(1.0, abs=1e-12)


def test_generated_hour_shares_follow_profile():
    base = generate_synthetic_base_traffic(n_agents=100, n_days=40, seed=3, profile=PROFILE)
    n = len(base)
    assert n >= 20_000
    counts = np.bincount(pd.to_datetime(base["timestamp"]).dt.hour, minlength=24)
    w = np.asarray(PROFILE["hour_weights"])
    sigma = np.sqrt(n * w * (1 - w))
    assert np.all(np.abs(counts - n * w) <= 4 * sigma), (counts, n * w)
    assert counts[[0, 1, 2, 3, 4, 5, 22, 23]].min() > 0  # benign traffic now runs at night


def test_legacy_backbone_unchanged_without_profile():
    base = generate_synthetic_base_traffic(n_agents=20, n_days=5, seed=1)
    hours = pd.to_datetime(base["timestamp"]).dt.hour
    assert hours.min() >= 7 and hours.max() < 21


def _sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def test_same_seed_gives_byte_identical_dataset(tmp_path):
    args = ["--n-agents", "40", "--n-days", "12", "--stuffing-sequences", "30", "--chaining-sequences", "20",
            "--chaining-pairs", "5", "--seed", "7", "--quiet"]
    generate_dataset.main(args + ["--output", str(tmp_path / "a.csv")])
    generate_dataset.main(args + ["--output", str(tmp_path / "b.csv")])
    assert _sha(tmp_path / "a.csv") == _sha(tmp_path / "b.csv")


def test_missing_profile_exits_nonzero(tmp_path):
    with pytest.raises(SystemExit) as exc:
        generate_dataset.main(["--profile", str(tmp_path / "nope.json"), "--output", str(tmp_path / "x.csv")])
    assert exc.value.code not in (0, None) and not (tmp_path / "x.csv").exists()


@pytest.mark.parametrize("n_agents,n_days,seed,needed", [(40, 12, 1, 30), (60, 20, 10, 120), (70, 21, 42, 140), (300, 45, 42, 600)])
def test_profile_backbone_has_enough_stuffing_anchors(n_agents, n_days, seed, needed):
    base = generate_synthetic_base_traffic(n_agents=n_agents, n_days=n_days, seed=seed, profile=PROFILE)
    theta = 5000.0
    anchors = ((base["amount"] > theta) & (base["amount"] <= 7 * 0.97 * theta)).sum()
    assert anchors >= needed


def test_committed_profile_records_cv_interval():
    lo, hi = PROFILE["day_multiplier_cv_ci95"]
    assert 0 < lo < PROFILE["day_multiplier_cv"] < hi


def _write_profile(path, **overrides):
    p = {"hour_weights": PROFILE["hour_weights"], "day_multiplier_cv": PROFILE["day_multiplier_cv"], **overrides}
    path.write_text(json.dumps(p), encoding="utf-8")
    return path


BAD_PROFILES = {
    "cv-zero": {"day_multiplier_cv": 0.0},
    "cv-nan": {"day_multiplier_cv": float("nan")},
    "short-weights": {"hour_weights": [1 / 23] * 23},
    "negative-weight": {"hour_weights": [-0.1, 0.1 + 1 / 24] + [1 / 24] * 22},
    "nan-weight": {"hour_weights": [float("nan")] + [1 / 24] * 23},
    "not-normalised": {"hour_weights": [0.05] * 24},
    "missing-key": {"hour_weights": None},
}


@pytest.mark.parametrize("name", list(BAD_PROFILES))
def test_bad_profile_is_rejected_at_load_and_by_the_cli(tmp_path, name):
    over = BAD_PROFILES[name]
    path = tmp_path / "p.json"
    if name == "missing-key":
        path.write_text(json.dumps({"day_multiplier_cv": 0.1}), encoding="utf-8")
    else:
        _write_profile(path, **over)
    with pytest.raises(ValueError, match="PaySim profile"):
        load_profile(str(path))
    with pytest.raises(SystemExit) as exc:
        generate_dataset.main(["--profile", str(path), "--output", str(tmp_path / "x.csv"), "--quiet"])
    assert exc.value.code not in (0, None) and not (tmp_path / "x.csv").exists()


def test_bad_profile_dict_is_rejected_by_the_generator():
    with pytest.raises(ValueError, match="day_multiplier_cv"):
        generate_synthetic_base_traffic(n_agents=2, n_days=1, profile={**PROFILE, "day_multiplier_cv": 0})


def test_malformed_profile_json_exits_cleanly(tmp_path):
    path = tmp_path / "p.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        load_profile(str(path))
    with pytest.raises(SystemExit) as exc:
        generate_dataset.main(["--profile", str(path), "--output", str(tmp_path / "x.csv"), "--quiet"])
    assert exc.value.code not in (0, None)


def test_replay_maps_step_1_to_midnight_and_scales_amounts(tmp_path):
    raw = _fake_paysim(tmp_path / "ps.csv")
    out = load_paysim_as_base_traffic(str(tmp_path / "ps.csv"), currency_scale=0.5, start_date="2026-01-01")
    first = raw[raw["step"] == 1].iloc[0]
    row = out[out["counterparty_id"].eq(first["nameDest"]) & out["amount"].eq(round(first["amount"] * 0.5, 2))]
    assert not row.empty and (row["timestamp"] == pd.Timestamp("2026-01-01 00:00")).all()
    assert out["timestamp"].min() == pd.Timestamp("2026-01-01 00:00")
    assert len(out) == len(raw)  # replay keeps all four types (reference only)


@pytest.mark.parametrize("argv", [
    ["--currency-scale", "0.1"],  # replay-only flag without --paysim-path
    ["--paysim-path", "x.csv", "--currency-scale", "0"],
    ["--paysim-path", "x.csv", "--currency-scale", "-1"],
    ["--paysim-path", "x.csv", "--currency-scale", "nan"],
    ["--paysim-path", "x.csv", "--currency-scale", "inf"],
    ["--paysim-path", "x.csv", "--profile", "p.json"],  # profile would be silently ignored
])
def test_cli_rejects_invalid_flag_combinations(argv):
    with pytest.raises(SystemExit) as exc:
        generate_dataset.parse_args(argv)
    assert exc.value.code == 2
