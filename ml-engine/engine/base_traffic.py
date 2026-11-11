"""
base_traffic.py
----------------
Generates or loads the "normal" transaction backbone used as background
traffic for the SalesMesh ML Risk Engine (Module 2).

Two modes:

  1. load_paysim_as_base_traffic() - reads a real PaySim CSV (the mobile-
     money simulator by Lopez-Rojas et al., 2016) and reshapes it into
     the SalesMesh transaction schema. Use this once you have a local
     copy of PaySim (it is not bundled here - see README.md).

  2. generate_synthetic_base_traffic() - the backbone actually used for
     training. Given the PaySim profile (data/paysim_profile.json, fitted
     by engine/paysim_profile.py from PAYMENT + CASH_IN rows), its
     hour-of-day cycle and day-to-day volume multiplier are taken from
     PaySim; amounts stay log-normal. Without a profile it falls back to
     the legacy uniform 07:00-21:00 / plain Poisson behaviour (tests).

Per the documentation review (ml_engine_review_and_improvements.md,
Section 3.2.1), PaySim's native `isFraud` label is NOT used as ground
truth here - it models account takeover (transfer-then-cash-out to
empty an account), not commission stuffing or circular chaining. It is
preserved as `native_fraud_label` for optional secondary use (e.g. as
a third minority class during later experimentation) but the labels
that matter for this project come from fraud_injector.py.
"""

from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd

SALESMESH_COLUMNS = [
    "transaction_id", "agent_id", "counterparty_id", "timestamp",
    "amount", "source_channel", "is_fraud", "fraud_type",
    "native_fraud_label", "group_id",
]


def _make_transaction_id(i: int) -> str:
    return f"TXN{i:09d}"


def generate_synthetic_base_traffic(
    n_agents: int = 300,
    n_days: int = 45,
    avg_tx_per_agent_per_day: float = 6.0,
    amount_median_kes: float = 1500.0,
    amount_sigma: float = 0.9,
    start_date: str = "2026-01-01",
    seed: int = 42,
    profile: Optional[dict] = None,
) -> pd.DataFrame:
    """
    Produce a synthetic mobile-money agent transaction backbone:
    log-normal amounts, Poisson daily counts per agent and rotating
    customer counterparties.

    With ``profile`` (the PaySim profile dict), each day d draws a shared
    multiplier g_d ~ Gamma(1/CV^2, scale CV^2) (mean 1, CV from PaySim's
    busy days), each agent-day count is Poisson(avg * g_d), and each
    timestamp is a categorical hour drawn from PaySim's hour weights plus
    a uniform offset within that hour. With ``profile=None`` the legacy
    behaviour is kept exactly: Poisson(avg) and uniform 07:00-21:00.

    Every row starts with is_fraud=0 / fraud_type='none' - fraud is
    added afterwards by fraud_injector.py, on top of this backbone.
    """
    rng = np.random.default_rng(seed)
    start = datetime.fromisoformat(start_date)
    agent_ids = [f"AGT{i:05d}" for i in range(n_agents)]

    if profile is not None:
        from engine.paysim_profile import validate_profile  # lazy: `python -m engine.paysim_profile` would import itself twice
        validate_profile(profile)
        hour_weights = np.asarray(profile["hour_weights"], dtype=float)
        cv2 = float(profile["day_multiplier_cv"]) ** 2

    rows = []
    tx_counter = 0

    for day in range(n_days):
        day_date = start + timedelta(days=day)
        day_rate = avg_tx_per_agent_per_day * (1.0 if profile is None else rng.gamma(1.0 / cv2, cv2))
        for agent_id in agent_ids:
            n_tx = rng.poisson(day_rate)
            for _ in range(n_tx):
                hour = rng.uniform(7, 21) if profile is None else rng.choice(24, p=hour_weights) + rng.uniform()
                ts = day_date + timedelta(hours=float(hour))
                amount = float(rng.lognormal(mean=np.log(amount_median_kes), sigma=amount_sigma))
                amount = round(min(max(amount, 50.0), 250_000.0), 2)
                counterparty_id = f"CUST{rng.integers(0, n_agents * 40):06d}"

                rows.append((
                    _make_transaction_id(tx_counter), agent_id, counterparty_id,
                    ts, amount, "DARAJA_STK", 0, "none", 0, np.nan,
                ))
                tx_counter += 1

    df = pd.DataFrame(rows, columns=SALESMESH_COLUMNS)
    df.sort_values("timestamp", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def load_paysim_as_base_traffic(
    csv_path: str,
    currency_scale: float = 1.0,
    keep_types=("CASH_OUT", "TRANSFER", "CASH_IN", "PAYMENT"),
    step_hours: float = 1.0,
    start_date: str = "2026-01-01",
) -> pd.DataFrame:
    """
    Load the real PaySim dataset and reshape it into the SalesMesh
    transaction schema.

    Expected PaySim columns: step, type, amount, nameOrig, oldbalanceOrg,
    newbalanceOrig, nameDest, oldbalanceDest, newbalanceDest, isFraud,
    isFlaggedFraud.

    NOTE: nameOrig/nameDest in PaySim are generic account identifiers,
    not specifically "sales agents" - this mapping borrows PaySim's
    realistic volume/timing/amount structure, not its literal semantics.
    For a true agent-level test set you will eventually want a (even
    small) sample of real Daraja sandbox transactions - see the review
    file's "Open questions" section.

    `currency_scale` rescales PaySim's generic amount units; about
    1500/19190 (~0.078) maps the PAYMENT + CASH_IN median recorded in
    data/paysim_profile.json onto the synthetic KES 1,500 median.
    This replay path is reference-only and is not used for training.
    """
    raw = pd.read_csv(csv_path)
    raw = raw[raw["type"].isin(keep_types)].copy()

    start = datetime.fromisoformat(start_date)
    # step s covers hours [s-1, s), so step 1 starts at start_date 00:00
    raw["timestamp"] = raw["step"].apply(lambda s: start + timedelta(hours=float(s - 1) * step_hours))

    channel_map = {
        "CASH_OUT": "DARAJA_B2C", "TRANSFER": "DARAJA_STK",
        "CASH_IN": "C2B", "PAYMENT": "POS",
    }

    df = pd.DataFrame({
        "transaction_id": [_make_transaction_id(i) for i in range(len(raw))],
        "agent_id": raw["nameOrig"].values,
        "counterparty_id": raw["nameDest"].values,
        "timestamp": raw["timestamp"].values,
        "amount": (raw["amount"].values * currency_scale).round(2),
        "source_channel": raw["type"].map(channel_map).values,
        "is_fraud": 0,
        "fraud_type": "none",
        "native_fraud_label": raw["isFraud"].values,
        "group_id": np.nan,
    })
    df.sort_values("timestamp", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df
