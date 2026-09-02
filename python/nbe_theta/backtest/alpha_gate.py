"""The alpha gate's verdict.

`run_walk_forward` produces a lift — selected wallets' forward edge minus
the universe baseline. The README calls it "the decision point the whole
plan is organized around", and a non-positive value a STOP.

Until now it was reported as a bare number. That is inconsistent with
every other statistical claim this codebase makes, and the inconsistency
runs the wrong way: the scorer refuses to bootstrap below three event
clusters, the shadow gate carries an interval on its P&L and has a third
verdict for "not measurable yet", and a missing price is stored as NULL
rather than 0.0 — but the single number that decides whether the project
continues had no interval, no minimum evidence, and no way to say "I
cannot tell".

A lift of +0.004 over two folds and nine episodes would have printed
exactly like a lift of +0.004 over forty folds and nine thousand. The
first is noise and the second is a finding, and the operator had no way
to tell them apart.

So this module gives the alpha gate the same discipline as ADR-0003's
shadow gate: named criteria, three outcomes each, and an interval beside
the point estimate.

**Why the interval resamples event clusters, not folds.** Folds overlap —
consecutive horizons share settled episodes — so they are not
independent draws, and there are rarely more than a handful of them.
Event clusters are the block the rest of the codebase already trusts as
approximately independent, and pooling forward episodes across folds
gives the bootstrap enough to work with.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.analytics.statistics import event_block_bootstrap
from nbe_theta.backtest.walkforward import WalkForwardResult, cluster_ids

# The verdict vocabulary is imported rather than redefined so the two
# gates cannot drift into meaning different things by the same words.
from nbe_theta.signals.gate import FAIL, INSUFFICIENT, PASS, Criterion


@dataclass(frozen=True)
class AlphaGatePolicy:
    version: str = "alpha-gate-v1"

    #: Folds below this and the rolling evaluation has not rolled.
    min_folds: int = 3
    #: Distinct event clusters across the forward windows. Three is the
    #: floor at which `event_block_bootstrap` will run at all; below it
    #: every resample draws the same blocks and the interval collapses to
    #: zero width, which would make a one-event record look infinitely
    #: certain.
    min_event_clusters: int = 3
    #: Forward episodes in total. A gate decided on four trades is not a
    #: gate.
    min_forward_episodes: int = 30
    #: Above this share, "selected" and "the universe" are nearly the
    #: same set and lift cannot distinguish them however it reads.
    max_selection_share: float = 0.5


def _pooled(result: WalkForwardResult) -> tuple[list[ScoredEpisode], list[ScoredEpisode]]:
    """Forward episodes across every fold: (selected, universe)."""

    selected: list[ScoredEpisode] = []
    universe: list[ScoredEpisode] = []
    for f in result.folds:
        selected.extend(f.selected_episodes)
        universe.extend(f.all_episodes)
    return selected, universe


def _folds(result: WalkForwardResult, policy: AlphaGatePolicy) -> Criterion:
    n = len(result.folds)
    if n < policy.min_folds:
        return Criterion(
            "sufficient_folds",
            INSUFFICIENT,
            value=float(n),
            threshold=float(policy.min_folds),
            detail={"reason": "the rolling evaluation has barely rolled"},
        )
    return Criterion("sufficient_folds", PASS, value=float(n), threshold=float(policy.min_folds))


def _evidence(result: WalkForwardResult, policy: AlphaGatePolicy) -> Criterion:
    _, universe = _pooled(result)
    n_eps = len(universe)
    n_clusters = len(set(cluster_ids(universe)))

    if n_eps < policy.min_forward_episodes or n_clusters < policy.min_event_clusters:
        return Criterion(
            "sufficient_evidence",
            INSUFFICIENT,
            value=float(n_eps),
            threshold=float(policy.min_forward_episodes),
            detail={
                "reason": "too few settled forward episodes or event clusters to measure",
                "forward_episodes": n_eps,
                "event_clusters": n_clusters,
                "min_event_clusters": policy.min_event_clusters,
            },
        )
    return Criterion(
        "sufficient_evidence",
        PASS,
        value=float(n_eps),
        threshold=float(policy.min_forward_episodes),
        detail={"event_clusters": n_clusters},
    )


def _separation(result: WalkForwardResult, policy: AlphaGatePolicy) -> Criterion:
    """Is selection actually selecting?

    If the top-N is most of the universe, the "selected" and "everyone"
    sets overlap so heavily that lift is near zero by construction. That
    is a fact about how few wallets we are scoring, and reporting it as
    "selection adds nothing" would be a false negative — the opposite
    error from the one the other criteria guard.
    """

    shares = [f.selection_share for f in result.folds if f.selection_share is not None]
    if not shares:
        return Criterion(
            "selection_is_selective",
            INSUFFICIENT,
            threshold=policy.max_selection_share,
            detail={"reason": "no fold recorded a universe size"},
        )
    worst = max(shares)
    if worst > policy.max_selection_share:
        return Criterion(
            "selection_is_selective",
            INSUFFICIENT,
            value=round(worst, 4),
            threshold=policy.max_selection_share,
            detail={
                "reason": (
                    "selected set is most of the universe; lift cannot distinguish "
                    "selection from the baseline at this cohort size"
                ),
                "universe_sizes": [f.n_universe for f in result.folds],
            },
        )
    return Criterion(
        "selection_is_selective",
        PASS,
        value=round(worst, 4),
        threshold=policy.max_selection_share,
    )


def _lift(result: WalkForwardResult, policy: AlphaGatePolicy) -> Criterion:
    """Positive lift, with an event-clustered interval beside it.

    The criterion tests the stated bar — the README says a non-positive
    lift is a stop, so positive lift is what passes. The interval does
    not gate; it is reported because a lift whose interval spans zero is
    a number nobody should act on, and an operator deciding whether to
    commit the next phase of the project should see that before deciding
    rather than after.
    """

    lift = result.lift
    if lift is None:
        return Criterion(
            "positive_lift",
            INSUFFICIENT,
            threshold=0.0,
            detail={"reason": "no fold produced both a selected and a baseline edge"},
        )

    selected, _universe = _pooled(result)

    # Resample event clusters among the SELECTED forward episodes, with
    # the baseline subtracted as a constant. Two notes on what that does
    # and does not claim:
    #
    # * The block structure is preserved — a cluster is drawn whole, so
    #   ten outcome tokens on one election cannot masquerade as ten
    #   independent draws in the interval any more than they can in the
    #   point estimate.
    # * Holding the baseline fixed ignores its own sampling error, so
    #   this interval is slightly NARROWER than the truth. The direction
    #   matters: it is the optimistic direction, so a result whose
    #   interval already spans zero definitely spans zero. It is reported
    #   rather than gated on for exactly that reason.
    interval: dict[str, Any] = {"available": False}
    baseline = result.mean_baseline_edge
    if selected and baseline is not None:
        paired = [float(e.excess_edge) - baseline for e in selected]
        boot = event_block_bootstrap(paired, list(cluster_ids(selected)))
        if boot is not None:
            interval = {
                "available": True,
                "point": round(boot.point_estimate, 6),
                "lower": round(boot.lower, 6),
                "upper": round(boot.upper, 6),
                "excludes_zero": boot.excludes_zero,
            }

    status = PASS if lift > 0 else FAIL
    return Criterion(
        "positive_lift",
        status,
        value=round(lift, 6),
        threshold=0.0,
        detail={
            "selected_edge": result.mean_selected_edge,
            "baseline_edge": result.mean_baseline_edge,
            "bootstrap": interval,
        },
    )


@dataclass
class AlphaVerdict:
    policy: AlphaGatePolicy
    criteria: list[Criterion]
    persistence: float | None
    folds: int
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def verdict(self) -> str:
        """`fail` > `insufficient_evidence` > `pass`, as ADR-0003.

        A measured negative lift is a stop even when another criterion
        lacks evidence — a bad result is not softened by an unfinished
        one beside it.
        """

        if any(c.status == FAIL for c in self.criteria):
            return FAIL
        if any(c.status == INSUFFICIENT for c in self.criteria):
            return INSUFFICIENT
        return PASS

    @property
    def passed(self) -> bool:
        return self.verdict == PASS

    @property
    def blocking(self) -> list[Criterion]:
        return [c for c in self.criteria if c.status != PASS]

    def as_dict(self) -> dict[str, Any]:
        return {
            "policy_version": self.policy.version,
            "verdict": self.verdict,
            "folds": self.folds,
            "persistence": self.persistence,
            "criteria": {c.name: c.as_dict() for c in self.criteria},
            **self.extra,
        }


def evaluate(result: WalkForwardResult, policy: AlphaGatePolicy | None = None) -> AlphaVerdict:
    """Judge a walk-forward run. Pure — no I/O, fixed bootstrap seed."""

    pol = policy or AlphaGatePolicy()
    return AlphaVerdict(
        policy=pol,
        criteria=[
            _folds(result, pol),
            _evidence(result, pol),
            _separation(result, pol),
            _lift(result, pol),
        ],
        persistence=result.mean_persistence,
        folds=len(result.folds),
    )
