"""
fast_iforest.py
---------------
Vectorised traversal of a fitted scikit-learn ``IsolationForest``
(finding 21: sklearn's per-call overhead made single-row Layer-1 scoring
~16 ms, missing the < 10 ms target).

All trees are packed into flat node arrays. Leaves point to themselves,
so iterating ``max_depth`` steps of::

    node <- left[node] if x[feature[node]] <= threshold[node] else right[node]

across every tree at once lands each tree on its leaf. Exactly as in
``IsolationForest._compute_score_samples``::

    h(x)   = sum_trees ( depth(leaf) + c(n_leaf) - 1 )
    score  = -2 ** ( -h(x) / (n_trees * c(max_samples)) )   # == score_samples
    s(x,n) = -score                                         # cascade anomaly score

Inputs are cast to float32 first, matching sklearn's tree input dtype, so
split decisions are identical; the only difference is floating-point
summation order (|delta| ~ 1e-15, verified < 1e-9 by the test suite).
"""

from typing import Union

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.ensemble._iforest import _average_path_length

_CHUNK_ROWS = 8192


class CompiledIsolationForest:
    """Pre-compiled, vectorised scorer equivalent to ``IsolationForest.score_samples``."""

    def __init__(self, forest: IsolationForest):
        if not hasattr(forest, "estimators_"):
            raise ValueError("IsolationForest must be fitted before compilation")
        n_features = int(forest.n_features_in_)
        subsample = forest._max_features != n_features
        lefts, rights, feats, thrs, vals, roots = [], [], [], [], [], []
        offset = 0
        max_depth = 0
        for t_idx, (est, est_features) in enumerate(zip(forest.estimators_, forest.estimators_features_)):
            tree = est.tree_
            n_nodes = tree.node_count
            node_ids = np.arange(n_nodes)
            is_leaf = tree.children_left == -1
            left = np.where(is_leaf, node_ids, tree.children_left) + offset
            right = np.where(is_leaf, node_ids, tree.children_right) + offset
            local_feat = np.where(is_leaf, 0, tree.feature)
            global_feat = np.asarray(est_features)[local_feat] if subsample else local_feat
            leaf_value = (
                np.asarray(forest._decision_path_lengths[t_idx], dtype=np.float64)
                + np.asarray(forest._average_path_length_per_tree[t_idx], dtype=np.float64)
                - 1.0
            )
            lefts.append(left)
            rights.append(right)
            feats.append(global_feat)
            thrs.append(np.where(is_leaf, np.inf, tree.threshold))
            vals.append(leaf_value)
            roots.append(offset)
            offset += n_nodes
            max_depth = max(max_depth, int(tree.max_depth))

        self.left = np.concatenate(lefts).astype(np.int64)
        self.right = np.concatenate(rights).astype(np.int64)
        self.feature = np.concatenate(feats).astype(np.int64)
        self.threshold = np.concatenate(thrs).astype(np.float64)
        self.leaf_value = np.concatenate(vals)
        self.roots = np.asarray(roots, dtype=np.int64)
        self.max_depth = max_depth
        self.n_features = n_features
        self.n_trees = len(roots)
        self.denominator = float(self.n_trees * _average_path_length([forest._max_samples])[0])

    def _depths(self, X: np.ndarray) -> np.ndarray:
        n = X.shape[0]
        nodes = np.broadcast_to(self.roots, (n, self.n_trees)).copy()
        rows = np.arange(n)[:, None]
        for _ in range(self.max_depth):
            go_left = X[rows, self.feature[nodes]] <= self.threshold[nodes]
            nodes = np.where(go_left, self.left[nodes], self.right[nodes])
        return self.leaf_value[nodes].sum(axis=1)

    def score_samples(self, X: Union[np.ndarray, list]) -> np.ndarray:
        """Same values and sign convention as ``IsolationForest.score_samples``."""
        X = np.asarray(X, dtype=np.float32).astype(np.float64)
        if X.ndim == 1:
            X = X.reshape(1, -1)
        if X.shape[1] != self.n_features:
            raise ValueError(f"Expected {self.n_features} features, got {X.shape[1]}")
        depths = np.empty(X.shape[0], dtype=np.float64)
        for start in range(0, X.shape[0], _CHUNK_ROWS):
            depths[start:start + _CHUNK_ROWS] = self._depths(X[start:start + _CHUNK_ROWS])
        if self.denominator == 0:
            return -np.ones_like(depths)
        return -(2.0 ** (-depths / self.denominator))

    def anomaly_score(self, X: Union[np.ndarray, list]) -> np.ndarray:
        """Cascade anomaly score s(x, n) = -score_samples(X), in (0, 1]."""
        return -self.score_samples(X)
