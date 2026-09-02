"""The alpha gate: whether wallet selection is worth anything.

`lift` is the number the whole plan is organised around, and until PR 13
it was a bare mean with no interval, no minimum evidence, and no way to
say "I cannot tell". A lift of +0.004 over two folds and nine episodes
printed exactly like the same lift over forty folds and nine thousand.

So the tests that matter here are the ones asserting the gate does NOT
answer: a rolling evaluation that has barely rolled, a handful of
correlated episodes, or a "selected" set that is most of the universe
must all report `insufficient_evidence` rather than a verdict.

The other half is the clustering fix. `_mean_edge` used to average raw
episodes, so a wallet that split one opinion across ten outcome tokens
got ten times the weight of one that did not — a fact about market
structure being read as forecasting skill.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.analytics.metrics import Episode, ScoredEpisode
from nbe_theta.backtest.alpha_gate import AlphaGatePolicy, evaluate
from nbe_theta.backtest.walkforward import FoldResult, WalkForwardResult, _mean_edge
from nbe_theta.signals.gate import FAIL, INSUFFICIENT, PASS

T0 = datetime(2027, 1, 1, tzinfo=UTC)


def episode(edge: float, cluster: str | None, *, wallet: str = "w") -> ScoredEpisode:
    """A ScoredEpisode whose excess_edge is exactly `edge`.

    `excess_edge` is payoff − entry − fees, so a zero entry price and
    zero fee rate make the payoff the edge directly. That keeps these
    tests about aggregation rather than about the metric.
    """

    ep = Episode(
        wallet=wallet,
        condition_id=cluster or "c",
        outcome_token_id="t",
        direction="BUY",
        opened_at=T0,
        closed_at=T0 + timedelta(days=1),
        entry_vwap=Decimal("0"),
        exit_vwap=None,
        maximum_shares=Decimal("1"),
        maximum_cost=Decimal("0"),
        realized_pnl=Decimal("0"),
        resolution_pnl=None,
        status="resolved",
        episode_algorithm_version="gap-6h-v1",
        event_cluster_id=cluster,
    )
    return ScoredEpisode(
        episode=ep,
        realized_payoff=Decimal(str(edge)),
        entry_price=Decimal("0"),
        fee_rate=Decimal("0"),
        event_cluster_id=cluster,
        settled_at=T0 + timedelta(days=1),
    )


def fold(
    *,
    selected_edges: list[tuple[float, str | None]],
    all_edges: list[tuple[float, str | None]],
    n_universe: int = 100,
    n_selected: int = 10,
    persistence: float | None = 0.6,
) -> FoldResult:
    sel = [episode(e, c) for e, c in selected_edges]
    allx = [episode(e, c) for e, c in all_edges]
    return FoldResult(
        as_of=T0,
        horizon_end=T0 + timedelta(days=30),
        n_wallets_scored=n_universe,
        selected=[f"w{i}" for i in range(n_selected)],
        selected_forward_edge=_mean_edge(sel),
        baseline_all_forward_edge=_mean_edge(allx),
        baseline_random_forward_edge=None,
        persistence=persistence,
        n_universe=n_universe,
        selected_episodes=sel,
        all_episodes=allx,
    )


def healthy(n_folds: int = 4) -> WalkForwardResult:
    """Enough evidence, clearly positive lift, well-separated selection."""

    r = WalkForwardResult()
    for f in range(n_folds):
        r.folds.append(
            fold(
                selected_edges=[(0.10, f"evt-{f}-{i}") for i in range(10)],
                all_edges=[(0.01, f"evt-{f}-{i}") for i in range(10)],
            )
        )
    return r


def by_name(v, name: str):  # type: ignore[no-untyped-def]
    return next(c for c in v.criteria if c.name == name)


class TestClusteredAggregation:
    def test_ten_tokens_on_one_event_count_once(self) -> None:
        """The bug this replaces. One opinion split ten ways used to
        outweigh ten separate opinions."""

        one_event = [episode(1.0, "evt-a") for _ in range(10)]
        ten_events = [episode(0.0, f"evt-{i}") for i in range(10)]
        # Cluster-aware: one block at 1.0 and ten at 0.0 → 1/11.
        assert _mean_edge(one_event + ten_events) == 1.0 / 11
        # Episode-averaged, the old behaviour, would have been 0.5.

    def test_unclustered_episodes_stay_separate(self) -> None:
        """A missing cluster id must not collapse unrelated episodes into
        one block — that would under-weight them instead."""

        eps = [episode(1.0, None), episode(0.0, None)]
        assert _mean_edge(eps) == 0.5

    def test_empty_is_none_not_zero(self) -> None:
        # "No episodes" and "no edge" are different claims.
        assert _mean_edge([]) is None


class TestInsufficientEvidence:
    """The gate must decline rather than guess."""

    def test_too_few_folds(self) -> None:
        v = evaluate(healthy(n_folds=2))
        assert by_name(v, "sufficient_folds").status == INSUFFICIENT
        assert v.verdict == INSUFFICIENT

    def test_too_few_forward_episodes(self) -> None:
        r = WalkForwardResult()
        for f in range(4):
            r.folds.append(
                fold(
                    selected_edges=[(0.2, f"evt-{f}")],
                    all_edges=[(0.01, f"evt-{f}")],
                )
            )
        v = evaluate(r)
        crit = by_name(v, "sufficient_evidence")
        assert crit.status == INSUFFICIENT
        assert crit.detail["forward_episodes"] == 4

    def test_many_episodes_but_all_one_event(self) -> None:
        """Volume is not evidence when it is all one opinion."""

        r = WalkForwardResult()
        for _ in range(4):
            r.folds.append(
                fold(
                    selected_edges=[(0.2, "evt-single") for _ in range(20)],
                    all_edges=[(0.01, "evt-single") for _ in range(20)],
                )
            )
        v = evaluate(r)
        crit = by_name(v, "sufficient_evidence")
        assert crit.status == INSUFFICIENT
        assert crit.detail["event_clusters"] == 1

    def test_selecting_most_of_the_universe_is_not_a_measurement(self) -> None:
        """Top 10 of 12 makes lift near zero by construction. Reporting
        that as 'selection adds nothing' would be a false STOP."""

        r = WalkForwardResult()
        for f in range(4):
            r.folds.append(
                fold(
                    selected_edges=[(0.10, f"evt-{f}-{i}") for i in range(10)],
                    all_edges=[(0.01, f"evt-{f}-{i}") for i in range(10)],
                    n_universe=12,
                    n_selected=10,
                )
            )
        v = evaluate(r)
        crit = by_name(v, "selection_is_selective")
        assert crit.status == INSUFFICIENT
        assert v.verdict == INSUFFICIENT

    def test_an_empty_run_is_not_a_pass(self) -> None:
        v = evaluate(WalkForwardResult())
        assert v.verdict == INSUFFICIENT
        assert not v.passed

    def test_no_lift_at_all_is_insufficient_not_fail(self) -> None:
        """Folds that produced no comparable edges have not shown a
        negative result, they have shown nothing."""

        r = WalkForwardResult()
        for _ in range(4):
            r.folds.append(fold(selected_edges=[], all_edges=[]))
        assert by_name(evaluate(r), "positive_lift").status == INSUFFICIENT


class TestTheVerdict:
    def test_a_healthy_run_passes(self) -> None:
        v = evaluate(healthy())
        assert v.verdict == PASS
        assert v.blocking == []

    def test_negative_lift_fails(self) -> None:
        r = WalkForwardResult()
        for f in range(4):
            r.folds.append(
                fold(
                    selected_edges=[(-0.05, f"evt-{f}-{i}") for i in range(10)],
                    all_edges=[(0.02, f"evt-{f}-{i}") for i in range(10)],
                )
            )
        v = evaluate(r)
        assert by_name(v, "positive_lift").status == FAIL
        assert v.verdict == FAIL

    def test_exactly_zero_lift_fails(self) -> None:
        """The README's bar is a POSITIVE lift. Break-even is the value a
        system that copies the universe produces."""

        r = WalkForwardResult()
        for f in range(4):
            r.folds.append(
                fold(
                    selected_edges=[(0.03, f"evt-{f}-{i}") for i in range(10)],
                    all_edges=[(0.03, f"evt-{f}-{i}") for i in range(10)],
                )
            )
        v = evaluate(r)
        assert by_name(v, "positive_lift").value == 0.0
        assert v.verdict == FAIL

    def test_a_measured_failure_beats_a_missing_measurement(self) -> None:
        r = healthy(n_folds=2)  # insufficient folds
        for f in r.folds:
            f.selected_forward_edge = -0.5  # and a measured negative lift
        assert evaluate(r).verdict == FAIL

    def test_verdict_serialises_with_its_thresholds(self) -> None:
        d = evaluate(healthy()).as_dict()
        assert d["verdict"] == PASS
        assert d["policy_version"] == AlphaGatePolicy().version
        assert d["criteria"]["sufficient_folds"]["threshold"] == 3.0


class TestTheInterval:
    def test_lift_carries_an_event_clustered_interval(self) -> None:
        crit = by_name(evaluate(healthy()), "positive_lift")
        boot = crit.detail["bootstrap"]
        assert boot["available"] is True
        assert boot["lower"] <= boot["point"] <= boot["upper"]

    def test_a_noisy_positive_lift_is_flagged_as_spanning_zero(self) -> None:
        """+0.004 from wildly scattered episodes still clears the stated
        bar. The interval is what stops someone acting on it."""

        r = WalkForwardResult()
        for f in range(4):
            edges = [2.0, -2.0, 1.5, -1.5, 0.9, -0.9, 0.4, -0.38, 0.1, -0.1]
            r.folds.append(
                fold(
                    selected_edges=[(e, f"evt-{f}-{i}") for i, e in enumerate(edges)],
                    all_edges=[(0.0, f"evt-{f}-{i}") for i in range(10)],
                )
            )
        crit = by_name(evaluate(r), "positive_lift")
        assert crit.status == PASS
        assert crit.detail["bootstrap"]["excludes_zero"] is False

    def test_a_consistent_lift_excludes_zero(self) -> None:
        crit = by_name(evaluate(healthy(n_folds=6)), "positive_lift")
        assert crit.detail["bootstrap"]["excludes_zero"] is True
