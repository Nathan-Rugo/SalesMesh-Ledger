"""
split.py
--------
Chronological, agent-component-grouped partitioning (Dal Pozzolo et al.,
2018; thesis Section 3.2.4; review decision D1).

1. Agent components: agents are joined by union-find whenever they take
   part in the same fraud event (``group_id``) - e.g. both colluders of a
   circular-chaining pair. A component is never split across partitions,
   which removes cross-partition group leakage (finding 12).
2. Agent partition: components are shuffled with ``seed`` and assigned to
   the TEST side until it holds >= ``test_agent_fraction`` (40%) of the
   agents; the rest are DEV agents.
3. Time partition over the span [t_min, t_max]::

       train: DEV agents,  t <= t_min + 0.55 * span
       val:   DEV agents,  t_min + 0.55 * span < t <= t_min + 0.70 * span
       test:  TEST agents, t >  t_min + 0.70 * span

   so t_train <= t_val <= t_test and A_test is disjoint from A_train and
   A_val. Features are computed on the full history BEFORE splitting,
   which is causal: pre-cutoff history is legitimately available online.
4. Event exclusion: val rows of any fraud event (``group_id``) that also
   has rows in train (events straddling the 0.55 cutoff) are dropped, so
   the calibrator never sees an event the model trained on. Counts are
   recorded in the metadata.
"""

from typing import Any, Dict, Hashable, Tuple

import numpy as np
import pandas as pd


class _UnionFind:
    def __init__(self) -> None:
        self.parent: Dict[Hashable, Hashable] = {}

    def add(self, x: Hashable) -> None:
        self.parent.setdefault(x, x)

    def find(self, x: Hashable) -> Hashable:
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: Hashable, b: Hashable) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # deterministic: smaller label becomes the root
            if str(rb) < str(ra):
                ra, rb = rb, ra
            self.parent[rb] = ra


def agent_components(df: pd.DataFrame) -> Dict[str, str]:
    """
    Maps every agent_id to a component label (the smallest agent_id in
    its component). Agents in the same fraud group, including
    counterparties that are themselves agents, share a component.
    """
    uf = _UnionFind()
    agents = set(df["agent_id"].unique())
    for a in agents:
        uf.add(a)
    fraud = df[df["group_id"].notna()]
    for _, grp in fraud.groupby("group_id"):
        members = set(grp["agent_id"])
        if "counterparty_id" in grp.columns:
            members |= set(grp["counterparty_id"]) & agents
        members = sorted(members)
        for other in members[1:]:
            uf.union(members[0], other)
    return {a: str(uf.find(a)) for a in agents}


def _events(df: pd.DataFrame) -> int:
    return int(df.loc[df["is_fraud"] == 1, "group_id"].nunique())


def chronological_agent_grouped_split(
    df: pd.DataFrame,
    test_agent_fraction: float = 0.40,
    train_time_fraction: float = 0.55,
    val_time_fraction: float = 0.70,
    seed: int = 42,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, Dict[str, Any]]:
    """
    Returns ``(train_df, val_df, test_df, metadata)`` per the module docstring.
    """
    if not 0.0 < test_agent_fraction < 1.0:
        raise ValueError("test_agent_fraction must be in (0, 1)")
    if not 0.0 < train_time_fraction < val_time_fraction < 1.0:
        raise ValueError("Require 0 < train_time_fraction < val_time_fraction < 1")

    data = df.copy()
    data["timestamp"] = pd.to_datetime(data["timestamp"])
    data = data.sort_values(["timestamp", "transaction_id"], kind="mergesort").reset_index(drop=True)

    t_min, t_max = data["timestamp"].min(), data["timestamp"].max()
    span = t_max - t_min
    t_split1 = t_min + span * train_time_fraction
    t_split2 = t_min + span * val_time_fraction

    comp_of = agent_components(data)
    members: Dict[str, list] = {}
    for agent, comp in comp_of.items():
        members.setdefault(comp, []).append(agent)
    comp_labels = sorted(members)
    rng = np.random.RandomState(seed)
    order = rng.permutation(len(comp_labels))

    n_agents = len(comp_of)
    target_test = int(round(n_agents * test_agent_fraction))
    test_agents: set = set()
    for i in order:
        if len(test_agents) >= target_test:
            break
        test_agents.update(members[comp_labels[i]])
    dev_agents = set(comp_of) - test_agents

    is_dev = data["agent_id"].isin(dev_agents)
    train_df = data[is_dev & (data["timestamp"] <= t_split1)].reset_index(drop=True)
    val_df = data[is_dev & (data["timestamp"] > t_split1) & (data["timestamp"] <= t_split2)].reset_index(drop=True)
    # Events straddling t_split1 would put rows of one event in both train and
    # the calibration set; drop their val rows so calibration never sees an
    # event the model trained on.
    train_groups = set(train_df["group_id"].dropna().unique())
    shared = val_df["group_id"].isin(train_groups)
    excluded_val_events = int(val_df.loc[shared, "group_id"].nunique())
    excluded_val_rows = int(shared.sum())
    val_df = val_df[~shared].reset_index(drop=True)
    test_df = data[~is_dev & (data["timestamp"] > t_split2)].reset_index(drop=True)

    fraud = data[data["is_fraud"] == 1]
    bounds = fraud.groupby("group_id")["timestamp"].agg(["min", "max"])
    straddling = int((((bounds["min"] <= t_split1) & (bounds["max"] > t_split1))
                      | ((bounds["min"] <= t_split2) & (bounds["max"] > t_split2))).sum())

    metadata: Dict[str, Any] = {
        "seed": seed,
        "t_min": str(t_min),
        "t_max": str(t_max),
        "t_split1": str(t_split1),
        "t_split2": str(t_split2),
        "test_agent_fraction": test_agent_fraction,
        "train_time_fraction": train_time_fraction,
        "val_time_fraction": val_time_fraction,
        "total_agents": n_agents,
        "total_components": len(comp_labels),
        "dev_agents_count": len(dev_agents),
        "test_agents_count": len(test_agents),
        "train_agents_count": int(train_df["agent_id"].nunique()),
        "val_agents_count": int(val_df["agent_id"].nunique()),
        "train_rows": len(train_df),
        "val_rows": len(val_df),
        "test_rows": len(test_df),
        "train_frauds": int(train_df["is_fraud"].sum()),
        "val_frauds": int(val_df["is_fraud"].sum()),
        "test_frauds": int(test_df["is_fraud"].sum()),
        "train_fraud_events": _events(train_df),
        "val_fraud_events": _events(val_df),
        "test_fraud_events": _events(test_df),
        "events_straddling_time_cutoffs": straddling,
        "val_events_excluded_shared_with_train": excluded_val_events,
        "val_rows_excluded_shared_with_train": excluded_val_rows,
    }
    return train_df, val_df, test_df, metadata
