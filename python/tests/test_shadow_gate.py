"""The shadow gate: the packet that authorises real money.

The tests that matter most here are the ones asserting the gate does
NOT open. A promotion gate that is merely correct on the happy path is
not doing its job — the failure that costs money is the one where a
system with no track record reads four vacuously-true conditions and
promotes itself.

So the centrepiece is `TestVacuousPasses`: for each criterion that could
be trivially satisfied by an empty window, there is a test proving it
reports `insufficient_evidence` instead of `pass`. Each of those was
checked against the mutation it guards — flip the criterion to a plain
boolean and the corresponding test fails.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.signals.gate import (
    FAIL,
    INSUFFICIENT,
    PASS,
    DuplicateFinding,
    GateEvidence,
    GatePolicy,
    SettledLot,
    evaluate,
    percentile,
)

NOW = datetime(2027, 6, 1, tzinfo=UTC)
POLICY = GatePolicy()


def _lots(pnls: list[float], *, events: list[str] | None = None) -> list[SettledLot]:
    keys = events or [f"evt-{i}" for i in range(len(pnls))]
    return [
        SettledLot(
            lot_id=f"lot-{i}", realized_pnl=Decimal(str(p)), fees_paid=Decimal("0.5"), event_key=k
        )
        for i, (p, k) in enumerate(zip(pnls, keys, strict=True))
    ]


def healthy(**overrides: object) -> GateEvidence:
    """A window that should pass every criterion. Tests mutate one thing."""

    pnls = [12.0, -4.0, 9.0, 15.0, -3.0, 20.0, 7.0, 11.0]
    ev = GateEvidence(
        window_start=NOW - timedelta(days=31),
        window_end=NOW,
        qualified_signals=140,
        filled_orders=61,
        reject_reasons={"price_cap": 220, "depth": 40},
        fill_reasons={"filled": 61, "limit_exceeded": 79},
        slippages=[0.004, 0.006, 0.002],
        detection_latencies=[10.0] * 95 + [40.0] * 5,
        settled_lots=_lots(pnls),
        lots_opened=10,
        lots_open=2,
        open_cost_basis=Decimal("300"),
        policy_versions=["signal-v1"],
    )
    for key, value in overrides.items():
        setattr(ev, key, value)
    return ev


def by_name(packet: object, name: str):  # type: ignore[no-untyped-def]
    return next(c for c in packet.criteria if c.name == name)  # type: ignore[attr-defined]


class TestHappyPath:
    def test_a_complete_healthy_window_passes(self) -> None:
        packet = evaluate(healthy())
        assert packet.verdict == PASS
        assert packet.passed
        assert packet.blocking == []

    def test_every_criterion_is_reported_even_when_passing(self) -> None:
        """A packet has to explain itself, not just answer yes/no."""

        packet = evaluate(healthy())
        names = {c.name for c in packet.criteria}
        assert names == {
            "window_duration",
            "qualified_signal_count",
            "net_positive_after_costs",
            "detection_freshness_p95",
            "zero_duplicate_orders",
            "zero_unresolved_incidents",
        }
        for c in packet.criteria:
            assert c.status in {PASS, FAIL, INSUFFICIENT}

    def test_headline_travels_with_the_verdict(self) -> None:
        """ADR-0002 §G: fill rate and rejections are the finding, and they
        must not need recomputing from data that may have aged out."""

        packet = evaluate(healthy())
        h = packet.headline
        assert h["qualified_signals"] == 140
        assert h["filled_orders"] == 61
        assert h["fill_rate"] == 61 / 140
        assert h["reject_reasons"]["price_cap"] == 220

    def test_fill_rate_is_not_a_criterion(self) -> None:
        """The spec sets no threshold on it. Inventing one here would be
        inventing policy, so a terrible fill rate is reported, not
        judged."""

        packet = evaluate(healthy(filled_orders=1))
        assert packet.headline["fill_rate"] == 1 / 140
        assert packet.verdict == PASS


class TestVacuousPasses:
    """An empty window must never authorise trading.

    This is the class the module exists for. Every criterion below is
    trivially satisfiable by a system that has never done anything.
    """

    def test_completely_empty_window_is_not_a_pass(self) -> None:
        ev = GateEvidence(window_start=NOW - timedelta(days=60), window_end=NOW)
        packet = evaluate(ev)
        assert packet.verdict == INSUFFICIENT
        assert not packet.passed

    def test_zero_duplicates_among_zero_orders_is_not_evidence(self) -> None:
        """The one most likely to be got wrong: no orders means nothing
        could have duplicated, which is not the same as 'we do not
        duplicate'."""

        packet = evaluate(healthy(qualified_signals=0, filled_orders=0))
        assert by_name(packet, "zero_duplicate_orders").status == INSUFFICIENT

    def test_break_even_is_not_net_positive(self) -> None:
        """Exactly zero is the value an empty or perfectly hedged book
        returns, and `>= 0` would call it a pass."""

        packet = evaluate(
            healthy(settled_lots=_lots([5.0, -3.0, -2.0]), lots_opened=3, lots_open=0)
        )
        crit = by_name(packet, "net_positive_after_costs")
        assert crit.value == 0.0
        assert crit.status == FAIL

    def test_too_few_settled_lots_is_not_a_pass(self) -> None:
        """Two profitable lots is not a track record, and it is below the
        floor at which the bootstrap will even run."""

        packet = evaluate(healthy(settled_lots=_lots([50.0, 40.0]), lots_opened=2, lots_open=0))
        crit = by_name(packet, "net_positive_after_costs")
        assert crit.status == INSUFFICIENT
        assert crit.detail["settled_lots"] == 2

    def test_no_latency_observations_is_not_fresh(self) -> None:
        packet = evaluate(healthy(detection_latencies=[]))
        assert by_name(packet, "detection_freshness_p95").status == INSUFFICIENT

    def test_short_window_is_unfinished_not_failed(self) -> None:
        """A three-week-old shadow period has not failed anything. Calling
        it `fail` would invite widening the window until it changed."""

        packet = evaluate(healthy(window_start=NOW - timedelta(days=21)))
        crit = by_name(packet, "window_duration")
        assert crit.status == INSUFFICIENT
        assert packet.verdict == INSUFFICIENT

    def test_too_few_signals_is_unfinished_not_failed(self) -> None:
        packet = evaluate(healthy(qualified_signals=99))
        assert by_name(packet, "qualified_signal_count").status == INSUFFICIENT

    def test_ninety_nine_signals_does_not_round_up_to_a_hundred(self) -> None:
        assert evaluate(healthy(qualified_signals=99)).verdict == INSUFFICIENT
        assert evaluate(healthy(qualified_signals=100)).verdict == PASS


class TestSettlementCoverage:
    """Winners and losers do not resolve at the same rate."""

    def test_mostly_unsettled_book_cannot_be_judged(self) -> None:
        """Four profitable settled lots out of forty opened is a slice
        chosen by resolution timing, not a result."""

        packet = evaluate(
            healthy(settled_lots=_lots([10.0, 8.0, 12.0, 6.0]), lots_opened=40, lots_open=36)
        )
        crit = by_name(packet, "net_positive_after_costs")
        assert crit.status == INSUFFICIENT
        assert crit.detail["settlement_coverage"] == 0.1

    def test_open_lots_are_never_counted_as_profit(self) -> None:
        """Marking open positions to market would let a book full of
        unresolved losers report a gain."""

        packet = evaluate(
            healthy(
                settled_lots=_lots([-5.0, -6.0, -7.0, -8.0, -9.0, -10.0]),
                lots_opened=8,
                lots_open=2,
                open_cost_basis=Decimal("99999"),
            )
        )
        crit = by_name(packet, "net_positive_after_costs")
        assert crit.status == FAIL
        assert crit.value == -45.0
        # The open exposure is reported, so an operator sees it — it is
        # simply not added to the result.
        assert crit.detail["open_cost_basis"] == 99999.0


class TestFreshness:
    def test_p95_uses_nearest_rank_not_interpolation(self) -> None:
        """Interpolating invents a latency between two observed ones, and
        at p95 the invented value sits below the real 95th observation —
        biased towards passing."""

        values = [float(i) for i in range(1, 101)]
        assert percentile(values, 0.95) == 95.0
        assert percentile(values, 1.0) == 100.0
        assert percentile(values, 0.5) == 50.0

    def test_percentile_of_empty_is_none_not_zero(self) -> None:
        assert percentile([], 0.95) is None

    def test_a_fat_tail_fails_even_with_a_good_median(self) -> None:
        """p50 of 5 s and p95 of 300 s is a system that misses the trades
        that move, and a mean would have hidden it."""

        packet = evaluate(healthy(detection_latencies=[5.0] * 90 + [300.0] * 10))
        crit = by_name(packet, "detection_freshness_p95")
        assert crit.status == FAIL
        assert crit.value == 300.0
        assert crit.detail["p50"] == 5.0

    def test_exactly_ninety_seconds_fails(self) -> None:
        """The spec says below 90 s."""

        packet = evaluate(healthy(detection_latencies=[90.0] * 100))
        assert by_name(packet, "detection_freshness_p95").status == FAIL


class TestDuplicatesAndIncidents:
    def test_one_duplicate_is_enough_to_fail(self) -> None:
        """Zero means zero. There is no 'few duplicates' tolerance."""

        packet = evaluate(
            healthy(duplicates=[DuplicateFinding("multiple_accepted_evaluations", "a-1", 2)])
        )
        crit = by_name(packet, "zero_duplicate_orders")
        assert crit.status == FAIL
        assert crit.detail["findings"][0]["key"] == "a-1"

    def test_an_old_unresolved_break_still_blocks_today(self) -> None:
        """Not windowed on purpose: a break from before the shadow period
        means local state and venue truth disagree right now."""

        packet = evaluate(
            healthy(unresolved_incidents=[{"id": "b-1", "scope": "orders", "description": "drift"}])
        )
        assert by_name(packet, "zero_unresolved_incidents").status == FAIL

    def test_no_incidents_is_a_real_pass_not_insufficient(self) -> None:
        """Unlike duplicates, 'nothing is broken' is a genuine answer over
        an empty window."""

        ev = GateEvidence(window_start=NOW - timedelta(days=60), window_end=NOW)
        packet = evaluate(ev)
        assert by_name(packet, "zero_unresolved_incidents").status == PASS


class TestVerdictPrecedence:
    def test_a_measured_failure_beats_a_missing_measurement(self) -> None:
        """A negative result is not softened by an unfinished criterion
        sitting next to it."""

        packet = evaluate(
            healthy(
                qualified_signals=10,  # insufficient
                detection_latencies=[500.0] * 20,  # measured failure
            )
        )
        assert packet.verdict == FAIL

    def test_verdict_is_pass_only_when_every_criterion_passes(self) -> None:
        for field, value in [
            ("qualified_signals", 5),
            ("detection_latencies", [500.0] * 10),
            ("duplicates", [DuplicateFinding("multiple_lots_per_evaluation", "e-1", 2)]),
            ("unresolved_incidents", [{"id": "x"}]),
            ("settled_lots", _lots([-1.0, -2.0, -3.0])),
        ]:
            packet = evaluate(healthy(**{field: value}))
            assert packet.verdict != PASS, f"{field} should have blocked promotion"

    def test_blocking_names_what_to_fix(self) -> None:
        packet = evaluate(healthy(qualified_signals=3, detection_latencies=[]))
        names = {c.name for c in packet.blocking}
        assert names == {"qualified_signal_count", "detection_freshness_p95"}


class TestBootstrapAndProvenance:
    def test_the_interval_is_reported_beside_the_point_estimate(self) -> None:
        """+$4 over a hundred signals is noise wearing a plus sign. The
        spec's bar is the point estimate; the interval is what stops an
        operator promoting on one."""

        packet = evaluate(healthy(settled_lots=_lots([100.0, -99.0, 90.0, -88.0, 5.0, -4.0])))
        crit = by_name(packet, "net_positive_after_costs")
        assert crit.status == PASS  # net is +4.0
        assert crit.detail["bootstrap"]["available"] is True
        assert crit.detail["bootstrap"]["excludes_zero"] is False

    def test_correlated_lots_resample_as_one_event(self) -> None:
        """Ten outcome tokens on one election are one opinion resolving
        once. Resampling them individually would shrink the interval by
        ~sqrt(10)."""

        one_event = ["evt-a"] * 10
        packet = evaluate(
            healthy(settled_lots=_lots([9.0] * 10, events=one_event), lots_opened=10, lots_open=0)
        )
        crit = by_name(packet, "net_positive_after_costs")
        # A single block is below the bootstrap's floor, so it declines
        # to produce an interval rather than reporting a zero-width one.
        assert crit.detail["bootstrap"]["available"] is False

    def test_multiple_policy_versions_are_surfaced(self) -> None:
        """A packet spanning a policy change measures two systems."""

        packet = evaluate(healthy(policy_versions=["signal-v1", "signal-v2", "signal-v1"]))
        assert packet.policy_versions == ["signal-v1", "signal-v2"]

    def test_packet_serialises_with_the_thresholds_it_was_judged_against(self) -> None:
        """A verdict is meaningless if the bar it cleared is not recorded
        alongside it."""

        d = evaluate(healthy()).as_dict()
        assert d["verdict"] == PASS
        assert d["policy_version"] == POLICY.version
        assert d["criteria"]["detection_freshness_p95"]["threshold"] == 90.0
        assert d["criteria"]["qualified_signal_count"]["threshold"] == 100.0
