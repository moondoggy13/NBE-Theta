"""Walk-forward evaluation — the alpha gate.

Rank wallets using only data available at T, then measure what those
wallets actually did over (T, T+h]. Repeat across a rolling series of
T's. This is the only evidence that distinguishes a real edge from a
story fitted to history, and it is the gate the plan puts before any
further investment in chain indexing or execution.

The comparison that matters is not "did the selected wallets make
money" — in a rising sample almost everyone does. It is whether they
beat the stated baselines: leaderboard-only selection, random wallets,
and (later) large-trade and top-holder heuristics. If selection adds
nothing over "copy the leaderboard", the wallet-scoring thesis has not
earned its complexity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from statistics import mean

from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.analytics.scorer import WalletScore, filter_as_of, score_universe


@dataclass
class FoldResult:
    as_of: datetime
    horizon_end: datetime
    n_wallets_scored: int
    selected: list[str]
    selected_forward_edge: float | None
    baseline_all_forward_edge: float | None
    baseline_random_forward_edge: float | None
    persistence: float | None


@dataclass
class WalkForwardResult:
    folds: list[FoldResult] = field(default_factory=list)

    @property
    def mean_selected_edge(self) -> float | None:
        vals = [f.selected_forward_edge for f in self.folds if f.selected_forward_edge is not None]
        return mean(vals) if vals else None

    @property
    def mean_baseline_edge(self) -> float | None:
        vals = [
            f.baseline_all_forward_edge
            for f in self.folds
            if f.baseline_all_forward_edge is not None
        ]
        return mean(vals) if vals else None

    @property
    def lift(self) -> float | None:
        """Selected minus universe baseline. THE number that decides
        whether wallet selection is worth anything."""

        s, b = self.mean_selected_edge, self.mean_baseline_edge
        if s is None or b is None:
            return None
        return s - b

    @property
    def mean_persistence(self) -> float | None:
        vals = [f.persistence for f in self.folds if f.persistence is not None]
        return mean(vals) if vals else None


def _forward_episodes(
    scored: list[ScoredEpisode], start: datetime, end: datetime
) -> list[ScoredEpisode]:
    """Episodes that became observable strictly inside (start, end].

    Uses settlement time for the same reason ``filter_as_of`` does: an
    episode is not out-of-sample evidence until its payoff is known.
    """

    out = []
    for s in scored:
        c = s.observable_at
        if c is not None and start < c <= end:
            out.append(s)
    return out


def _mean_edge(eps: list[ScoredEpisode]) -> float | None:
    if not eps:
        return None
    return float(sum(s.excess_edge for s in eps) / len(eps))


def run_walk_forward(
    per_wallet: dict[str, list[ScoredEpisode]],
    *,
    start: datetime,
    end: datetime,
    step: timedelta,
    horizon: timedelta,
    top_n: int = 10,
    seed: int = 12345,
) -> WalkForwardResult:
    """Roll T from ``start`` to ``end``; at each T select the top-N by
    skill using only ≤T data, then score them on (T, T+horizon]."""

    result = WalkForwardResult()
    t = start
    rng_seed = seed
    while t + horizon <= end:
        scores: list[WalletScore] = score_universe(per_wallet, t, seed=rng_seed)
        ranked = [
            s
            for s in sorted(
                scores,
                key=lambda s: s.skill_score if s.skill_score is not None else -1e9,
                reverse=True,
            )
            if s.skill_score is not None
        ]
        selected = [s.wallet for s in ranked[:top_n]]

        horizon_end = t + horizon
        sel_eps: list[ScoredEpisode] = []
        all_eps: list[ScoredEpisode] = []
        for w, eps in per_wallet.items():
            fwd = _forward_episodes(eps, t, horizon_end)
            all_eps.extend(fwd)
            if w in selected:
                sel_eps.extend(fwd)

        # Random baseline: same count, deterministic per fold.
        import random as _random

        rnd = _random.Random(rng_seed)
        pool = list(per_wallet)
        picks = rnd.sample(pool, min(top_n, len(pool))) if pool else []
        rnd_eps: list[ScoredEpisode] = []
        for w in picks:
            rnd_eps.extend(_forward_episodes(per_wallet[w], t, horizon_end))

        # Persistence: of the wallets selected at T, what share still
        # show a positive edge in the forward window?
        persistence = None
        if selected:
            still_good = 0
            counted = 0
            for w in selected:
                fwd = _forward_episodes(per_wallet[w], t, horizon_end)
                e = _mean_edge(fwd)
                if e is None:
                    continue
                counted += 1
                if e > 0:
                    still_good += 1
            persistence = (still_good / counted) if counted else None

        result.folds.append(
            FoldResult(
                as_of=t,
                horizon_end=horizon_end,
                n_wallets_scored=len(scores),
                selected=selected,
                selected_forward_edge=_mean_edge(sel_eps),
                baseline_all_forward_edge=_mean_edge(all_eps),
                baseline_random_forward_edge=_mean_edge(rnd_eps),
                persistence=persistence,
            )
        )
        t += step
        rng_seed += 1
    return result


def attach_out_of_sample(
    scores: list[WalletScore],
    per_wallet: dict[str, list[ScoredEpisode]],
    as_of: datetime,
    horizon: timedelta,
) -> None:
    """Fill ``out_of_sample_score`` in place from the window after as_of.

    Tier A requires this to be positive, so a scoring run with no
    forward window available simply cannot mint Tier-A wallets — which
    is the intended fail-closed behavior.
    """

    end = as_of + horizon
    for sc in scores:
        eps = per_wallet.get(sc.wallet, [])
        sc.out_of_sample_score = _mean_edge(_forward_episodes(eps, as_of, end))


__all__ = [
    "FoldResult",
    "WalkForwardResult",
    "run_walk_forward",
    "attach_out_of_sample",
    "filter_as_of",
]
