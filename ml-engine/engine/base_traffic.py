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

  2. generate_synthetic_base_traffic() - produces a statistically
     realistic stand-in when PaySim is not available, so the rest of
     the pipeline (fraud injection, feature engineering, and later
     model training) can be built and tested end-to-end without
     waiting on the dataset.

Per the documentation review (ml_engine_review_and_improvements.md,
Section 3.2.1), PaySim's native `isFraud` label is NOT used as ground
truth here - it models account takeover (transfer-then-cash-out to
empty an account), not commission stuffing or circular chaining. It is
preserved as `native_fraud_label` for optional secondary use (e.g. as
a third minority class during later experimentation) but the labels
that matter for this project come from fraud_injector.py.
"""

from datetime import datetime, timedelta

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
) -> pd.DataFrame:
    """
    Produce a synthetic but realistic mobile-money agent transaction
    backbone: log-normal amounts, Poisson-distributed daily transaction
    counts per agent, timestamps scattered within business hours
    (07:00-21:00), and rotating customer counterparties.

    Every row starts with is_fraud=0 / fraud_type='none' - fraud is
    added afterwards by fraud_injector.py, on top of this backbone.
    """
    rng = np.random.default_rng(seed)
    start = datetime.fromisoformat(start_date)
    agent_ids = [f"AGT{i:05d}" for i in range(n_agents)]

    rows = []
    tx_counter = 0

    for day in range(n_days):
        day_date = start + timedelta(days=day)
        for agent_id in agent_ids:
            n_tx = rng.poisson(avg_tx_per_agent_per_day)
            for _ in range(n_tx):
                hour = rng.uniform(7, 21)
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

    `currency_scale` rescales PaySim's generic amount units if needed;
    inspect a few rows first and set this so the median amount lands
    near your expected commission-eligible transaction size.
    """
    raw = pd.read_csv(csv_path)
    raw = raw[raw["type"].isin(keep_types)].copy()

    start = datetime.fromisoformat(start_date)
    raw["timestamp"] = raw["step"].apply(lambda s: start + timedelta(hours=float(s) * step_hours))

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
