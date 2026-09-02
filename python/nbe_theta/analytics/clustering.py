"""Correlated-wallet clustering.

Five wallets run by one desk are **one opinion**. If we treat them as
five, two things break at once:

* "Two independent sources agree" becomes a false statement, and the
  consensus requirement — the main protection against following a single
  wallet into a bad trade — silently stops protecting anything.
* Per-source position caps stop binding, because one entity occupies
  five slots and takes five times the intended exposure.

So co-trading wallets are collapsed into a cluster, and a cluster counts
once everywhere downstream.

**What this does and does not claim.** A cluster is a statement about
*observed co-activity*, not about ownership, identity, or intent. Wallets
can trade together because one desk runs them, because one copies the
other, or because both read the same public signal. This module cannot
distinguish those and does not try. It only asserts: *these wallets'
trades are not independent evidence.* That is exactly the property
sizing and consensus need, and it is a far weaker — and far more
defensible — claim than "same person".

The measure is directional-coincidence over a window: how often does B
take the same side of the same outcome within `window` of A? Scored
asymmetrically and then symmetrised by the **minimum**, because a small
wallet that shadows a large one produces a high rate in one direction and
a low one in the other; requiring both keeps a popular wallet from
absorbing everyone who happens to follow it.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

MODEL_VERSION = "cluster-1"

# Spec defaults: >80% repeated same-market/same-outcome activity within
# five minutes, over 30 days.
DEFAULT_WINDOW = timedelta(minutes=5)
DEFAULT_LOOKBACK = timedelta(days=30)
DEFAULT_THRESHOLD = 0.80
# Below this many shared opportunities a coincidence rate is noise: two
# wallets that each traded one market, the same one, are not a cluster.
DEFAULT_MIN_OVERLAP = 5


@dataclass(frozen=True)
class Action:
    """One wallet's directional action on one outcome."""

    wallet: str
    outcome_token_id: str
    direction: str
    occurred_at: datetime


@dataclass(frozen=True)
class PairScore:
    a: str
    b: str
    # Coincidence rate in each direction, and the symmetric minimum.
    rate_ab: float
    rate_ba: float
    score: float
    overlap: int


@dataclass
class Cluster:
    cluster_key: str
    wallets: list[str]
    max_pair_score: float | None = None
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def size(self) -> int:
        return len(self.wallets)


def _directional_rate(
    source: list[Action], other_by_key: dict[tuple[str, str], list[datetime]], window: timedelta
) -> tuple[float, int]:
    """Share of `source`'s actions matched by the other wallet.

    Matched = same outcome token, same direction, within `window` either
    side. Returns (rate, matched_count).
    """

    if not source:
        return 0.0, 0
    matched = 0
    for act in source:
        times = other_by_key.get((act.outcome_token_id, act.direction))
        if not times:
            continue
        if any(abs((t - act.occurred_at).total_seconds()) <= window.total_seconds() for t in times):
            matched += 1
    return matched / len(source), matched


def score_pair(
    a_actions: list[Action],
    b_actions: list[Action],
    *,
    window: timedelta = DEFAULT_WINDOW,
) -> PairScore | None:
    """Symmetric co-activity score for two wallets."""

    if not a_actions or not b_actions:
        return None
    a = a_actions[0].wallet
    b = b_actions[0].wallet
    if a == b:
        return None

    a_by_key: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    for act in a_actions:
        a_by_key[(act.outcome_token_id, act.direction)].append(act.occurred_at)
    b_by_key: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    for act in b_actions:
        b_by_key[(act.outcome_token_id, act.direction)].append(act.occurred_at)

    rate_ab, matched_ab = _directional_rate(a_actions, b_by_key, window)
    rate_ba, matched_ba = _directional_rate(b_actions, a_by_key, window)

    # Minimum, not mean. A tiny wallet that mirrors a whale on every trade
    # scores 1.0 in one direction; the whale, trading hundreds of markets
    # the follower never touches, scores near 0 in the other. Averaging
    # would drag the whale into a cluster with every one of its followers
    # and collapse the entire cohort into one blob.
    score = min(rate_ab, rate_ba)
    overlap = min(matched_ab, matched_ba)
    return PairScore(a=a, b=b, rate_ab=rate_ab, rate_ba=rate_ba, score=score, overlap=overlap)


class _UnionFind:
    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def add(self, x: str) -> None:
        self._parent.setdefault(x, x)

    def find(self, x: str) -> str:
        self.add(x)
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        # Path compression.
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, x: str, y: str) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self._parent[ry] = rx


def build_clusters(
    actions_by_wallet: dict[str, list[Action]],
    as_of: datetime,
    *,
    window: timedelta = DEFAULT_WINDOW,
    lookback: timedelta = DEFAULT_LOOKBACK,
    threshold: float = DEFAULT_THRESHOLD,
    min_overlap: int = DEFAULT_MIN_OVERLAP,
) -> list[Cluster]:
    """Group wallets whose activity is not independent.

    Every wallet gets a cluster, including singletons — downstream code
    should never have to ask "is this wallet clustered?" and handle two
    shapes. A lone wallet is a cluster of one.
    """

    cutoff = as_of - lookback
    windowed: dict[str, list[Action]] = {}
    for wallet, acts in actions_by_wallet.items():
        kept = [a for a in acts if cutoff <= a.occurred_at <= as_of]
        if kept:
            windowed[wallet] = sorted(kept, key=lambda a: a.occurred_at)

    wallets = sorted(windowed)
    uf = _UnionFind()
    for w in wallets:
        uf.add(w)

    pairs: list[PairScore] = []
    for i, a in enumerate(wallets):
        for b in wallets[i + 1 :]:
            ps = score_pair(windowed[a], windowed[b], window=window)
            if ps is None:
                continue
            if ps.overlap < min_overlap:
                # Too little shared activity for the rate to mean
                # anything. Two wallets that both traded one market on the
                # same afternoon are a coincidence, not an entity.
                continue
            if ps.score >= threshold:
                pairs.append(ps)
                uf.union(a, b)

    grouped: dict[str, list[str]] = defaultdict(list)
    for w in wallets:
        grouped[uf.find(w)].append(w)

    best: dict[str, float] = {}
    for ps in pairs:
        root = uf.find(ps.a)
        best[root] = max(best.get(root, 0.0), ps.score)

    clusters: list[Cluster] = []
    for root, members in sorted(grouped.items()):
        members_sorted = sorted(members)
        clusters.append(
            Cluster(
                # Keyed by the lexicographically smallest member so the
                # key is stable across runs when membership is stable.
                cluster_key=members_sorted[0],
                wallets=members_sorted,
                max_pair_score=best.get(root),
                evidence={
                    "window_s": window.total_seconds(),
                    "lookback_days": lookback.days,
                    "threshold": threshold,
                    "min_overlap": min_overlap,
                    "note": (
                        "co-activity only; asserts non-independence, "
                        "NOT shared ownership or identity"
                    ),
                },
            )
        )
    return clusters


def cluster_of(clusters: list[Cluster]) -> dict[str, str]:
    """wallet → cluster_key, for the downstream one-slot-per-cluster rule."""

    out: dict[str, str] = {}
    for c in clusters:
        for w in c.wallets:
            out[w] = c.cluster_key
    return out
