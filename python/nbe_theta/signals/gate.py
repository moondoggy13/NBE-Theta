"""The shadow gate: the decision packet that authorises live trading.

ADR-0002 adopts the spec's step 6 verbatim in spirit:

> Run the 30-day/100-signal shadow gate; require net-positive modeled
> results after dynamic fees/slippage, p95 detection freshness below 90
> seconds, zero duplicate orders, and zero unresolved critical incidents.

This module turns that sentence into six named criteria, each of which
reports its own outcome and the number that decided it. Nothing is
averaged, and there is no overall score: the same objection ADR-0002 §A
raises against the spec's `S ≥ 0.75` formula applies here with more
force. "Profitable enough to make up for a duplicate order" is not a
sentence anyone should be able to write.

**The third outcome is the point of this module.**

Every criterion returns `pass`, `fail`, or `insufficient_evidence`, and
only an all-`pass` packet authorises promotion. A two-valued gate has a
failure mode that is easy to miss and expensive to hit: over an empty
window, "zero duplicate orders" is trivially true, "no unresolved
incidents" is trivially true, and a net P&L of exactly zero is not
negative. A boolean gate would read four vacuous truths and open. The
system would promote itself to live on the strength of never having
done anything.

So each criterion states not just whether it passed but whether it had
enough evidence to be asked. That is the same discipline the analytics
layer already applies when it refuses to bootstrap below three event
clusters, and when it stores an unmeasured price as NULL rather than
0.0: *unmeasured* and *fine* are different claims, and conflating them
is how a system talks itself into a trade.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from nbe_theta.analytics.statistics import BootstrapResult, event_block_bootstrap

ZERO = Decimal("0")

PASS = "pass"
FAIL = "fail"
INSUFFICIENT = "insufficient_evidence"

# ── The spec's thresholds ─────────────────────────────────────────────
# These are the numbers from ADR-0002 / the NBE-Overlord spec step 6.
# They live here as one frozen policy object so a packet can name the
# thresholds it was judged against — a verdict is meaningless if the bar
# it cleared is not recorded alongside it.


@dataclass(frozen=True)
class GatePolicy:
    version: str = "shadow-gate-v1"

    #: Calendar days the shadow period must span.
    min_window_days: int = 30
    #: Qualified signals — evaluations that passed every gate and were
    #: sized, i.e. ones that produced an order attempt. Evaluations that
    #: died on a gate are not evidence about execution.
    min_qualified_signals: int = 100
    #: Detection freshness: p95 of (we saw it) − (venue timestamped it).
    max_p95_detection_latency_s: float = 90.0
    #: The spec says zero. Not "few".
    max_duplicate_orders: int = 0
    max_unresolved_incidents: int = 0

    #: Minimum settled lots before the P&L question can be asked at all.
    #: Three is not a statistical claim, it is the floor below which the
    #: event-block bootstrap refuses to run (one cluster resamples to
    #: itself and reports a zero-width interval). Asking for a verdict on
    #: fewer would be asking for a number the statistics layer already
    #: declines to produce.
    min_settled_lots: int = 3
    #: Fraction of opened lots that must have reached settlement before
    #: realised P&L represents the book rather than a self-selected slice
    #: of it. Winners and losers do not resolve at the same rate; a gate
    #: run while most positions are still open is measuring whichever
    #: ones happened to finish.
    min_settlement_coverage: float = 0.60


@dataclass
class Criterion:
    """One named condition, its outcome, and the number behind it."""

    name: str
    status: str
    #: The measured quantity, when there was one. `None` means the
    #: measurement could not be taken — which is why `status` exists
    #: separately and is never inferred from a missing value.
    value: float | None = None
    threshold: float | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == PASS

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status}
        if self.value is not None:
            out["value"] = self.value
        if self.threshold is not None:
            out["threshold"] = self.threshold
        out.update(self.detail)
        return out


@dataclass
class SettledLot:
    """A closed or settled strategy lot, with the event it belongs to.

    ``event_key`` groups correlated markets (an event and its outcomes)
    so the bootstrap resamples whole events. Ten outcome tokens on one
    election are one opinion resolving once, not ten independent draws.
    """

    lot_id: str
    realized_pnl: Decimal
    fees_paid: Decimal
    event_key: str | None


@dataclass
class DuplicateFinding:
    """An observed duplicate, named concretely enough to go and look."""

    kind: str
    key: str
    count: int


@dataclass
class GateEvidence:
    """Everything the gate needs, already measured. No I/O in here.

    Separating collection from judgement is deliberate: the whole
    decision is then testable without a database, which is what makes
    the vacuous-pass cases below cheap enough to actually write tests
    for.
    """

    window_start: datetime
    window_end: datetime

    #: Evaluations that passed every gate and were sized.
    qualified_signals: int = 0
    #: Of those, how many the shadow broker actually filled.
    filled_orders: int = 0
    #: Rejection histogram over ALL evaluations, by first failing gate.
    reject_reasons: dict[str, int] = field(default_factory=dict)
    #: Fill-attempt outcomes among qualified signals (filled, no_book,
    #: stale_book, insufficient_depth, limit_exceeded...).
    fill_reasons: dict[str, int] = field(default_factory=dict)
    slippages: list[float] = field(default_factory=list)

    #: Detection latency in seconds, one per source action in the window.
    detection_latencies: list[float] = field(default_factory=list)

    settled_lots: list[SettledLot] = field(default_factory=list)
    #: Lots opened in the window, whatever their current status. The
    #: denominator for settlement coverage.
    lots_opened: int = 0
    #: Lots still open — reported, never counted as P&L.
    lots_open: int = 0
    open_cost_basis: Decimal = ZERO

    duplicates: list[DuplicateFinding] = field(default_factory=list)
    unresolved_incidents: list[dict[str, Any]] = field(default_factory=list)

    policy_versions: list[str] = field(default_factory=list)

    @property
    def window_days(self) -> float:
        return (self.window_end - self.window_start) / timedelta(days=1)


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile. ``q`` in [0, 1].

    Nearest-rank rather than interpolated, and that choice matters for a
    threshold test. Interpolating invents a latency between two observed
    ones, and at p95 on a heavy-tailed distribution the invented value
    sits below the real 95th observation — which biases the answer
    towards passing. Every value this returns is a latency we actually
    measured.
    """

    if not values or not 0.0 <= q <= 1.0:
        return None
    ordered = sorted(values)
    # Rank in 1..n, so q=1.0 selects the maximum and q=0 the minimum.
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def _window(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    days = ev.window_days
    if days < policy.min_window_days:
        # Not a failure — a shadow period that is only three weeks old
        # has not failed anything, it is simply not finished. Calling it
        # `fail` would invite someone to "fix" it by widening the window
        # until the answer changed.
        return Criterion(
            "window_duration",
            INSUFFICIENT,
            value=round(days, 2),
            threshold=float(policy.min_window_days),
            detail={"reason": "shadow period not yet long enough"},
        )
    return Criterion(
        "window_duration", PASS, value=round(days, 2), threshold=float(policy.min_window_days)
    )


def _sample_size(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    n = ev.qualified_signals
    if n < policy.min_qualified_signals:
        return Criterion(
            "qualified_signal_count",
            INSUFFICIENT,
            value=float(n),
            threshold=float(policy.min_qualified_signals),
            detail={"reason": "not enough qualified signals yet"},
        )
    return Criterion(
        "qualified_signal_count",
        PASS,
        value=float(n),
        threshold=float(policy.min_qualified_signals),
    )


def _net_positive(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    """Realised P&L on lots that actually resolved, net of fees.

    Three things this deliberately does not do:

    * **It does not mark open lots to market.** An open position has no
      realised result, and valuing it at the current mid would let a
      book full of losers-that-have-not-resolved-yet report a profit.
      This is the same rule the scorer follows — an episode is
      unscoreable until its market settles, even one the wallet exited
      months ago.
    * **It does not add fees back.** `realized_pnl` is already net of the
      fees charged on each leg; `fees_paid` is carried alongside for
      reporting only. Subtracting it again would double-count.
    * **It does not decide on the point estimate alone.** The spec's bar
      is "net-positive", so that is what the criterion tests, but the
      packet also carries an event-clustered bootstrap interval. A
      +$4 result over a hundred signals is noise wearing a plus sign,
      and an operator about to commit capital should see that before
      promoting, not after.
    """

    n_settled = len(ev.settled_lots)
    coverage = (n_settled / ev.lots_opened) if ev.lots_opened else 0.0

    if n_settled < policy.min_settled_lots:
        return Criterion(
            "net_positive_after_costs",
            INSUFFICIENT,
            threshold=0.0,
            detail={
                "reason": "too few settled lots to measure a result",
                "settled_lots": n_settled,
                "min_settled_lots": policy.min_settled_lots,
                "lots_open": ev.lots_open,
                "open_cost_basis": float(ev.open_cost_basis),
            },
        )

    if coverage < policy.min_settlement_coverage:
        # Most of the book has not resolved. Whatever the settled slice
        # says, it is a slice chosen by resolution timing rather than at
        # random, and short-dated markets are not a fair sample of the
        # strategy.
        return Criterion(
            "net_positive_after_costs",
            INSUFFICIENT,
            threshold=0.0,
            detail={
                "reason": "most opened lots have not settled",
                "settlement_coverage": round(coverage, 4),
                "min_settlement_coverage": policy.min_settlement_coverage,
                "settled_lots": n_settled,
                "lots_opened": ev.lots_opened,
                "lots_open": ev.lots_open,
                "open_cost_basis": float(ev.open_cost_basis),
            },
        )

    net = sum((lot.realized_pnl for lot in ev.settled_lots), ZERO)
    fees = sum((lot.fees_paid for lot in ev.settled_lots), ZERO)

    boot: BootstrapResult | None = event_block_bootstrap(
        [float(lot.realized_pnl) for lot in ev.settled_lots],
        [lot.event_key for lot in ev.settled_lots],
    )
    interval: dict[str, Any] = {"available": boot is not None}
    if boot is not None:
        interval.update(
            {
                "mean_pnl_per_lot": round(boot.point_estimate, 6),
                "lower": round(boot.lower, 6),
                "upper": round(boot.upper, 6),
                "excludes_zero": boot.excludes_zero,
            }
        )

    detail: dict[str, Any] = {
        "settled_lots": n_settled,
        "settlement_coverage": round(coverage, 4),
        "fees_paid": float(fees),
        "lots_open": ev.lots_open,
        "open_cost_basis": float(ev.open_cost_basis),
        "bootstrap": interval,
    }

    # Strictly greater than zero. Breaking even is not a positive result,
    # and it is the value an empty or perfectly-hedged book returns.
    status = PASS if net > ZERO else FAIL
    return Criterion(
        "net_positive_after_costs", status, value=float(net), threshold=0.0, detail=detail
    )


def _freshness(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    p95 = percentile(ev.detection_latencies, 0.95)
    if p95 is None:
        return Criterion(
            "detection_freshness_p95",
            INSUFFICIENT,
            threshold=policy.max_p95_detection_latency_s,
            detail={"reason": "no detection latencies recorded", "observations": 0},
        )
    status = PASS if p95 < policy.max_p95_detection_latency_s else FAIL
    return Criterion(
        "detection_freshness_p95",
        status,
        value=round(p95, 3),
        threshold=policy.max_p95_detection_latency_s,
        detail={
            "observations": len(ev.detection_latencies),
            "p50": round(percentile(ev.detection_latencies, 0.50) or 0.0, 3),
            "max": round(max(ev.detection_latencies), 3),
        },
    )


def _duplicates(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    """Zero duplicate orders.

    This is the criterion most at risk of passing vacuously, because
    "no duplicates" is exactly what an empty table says. So it is only
    answerable once orders exist: with no order attempts in the window
    there is no evidence either way, and the packet says so.

    What counts as a duplicate is defined by `gate_store.collect`, and
    the cases it looks for are the ones that are actually reachable —
    one source action yielding two accepted evaluations (which a policy
    version bump mid-run will do), and more than one lot or fill hung
    off a single evaluation. `signal_evaluations` has a unique constraint
    on (source_action_id, policy_version) and `source_actions` on
    dedupe_key, so those two shapes cannot occur while the constraints
    stand; the checks that remain are the ones nothing else enforces.
    """

    if ev.qualified_signals == 0:
        return Criterion(
            "zero_duplicate_orders",
            INSUFFICIENT,
            threshold=float(policy.max_duplicate_orders),
            detail={
                "reason": "no qualified signals in window; nothing could have duplicated",
            },
        )
    n = len(ev.duplicates)
    status = PASS if n <= policy.max_duplicate_orders else FAIL
    return Criterion(
        "zero_duplicate_orders",
        status,
        value=float(n),
        threshold=float(policy.max_duplicate_orders),
        detail={
            "findings": [
                {"kind": d.kind, "key": d.key, "count": d.count} for d in ev.duplicates[:20]
            ]
        },
    )


def _incidents(ev: GateEvidence, policy: GatePolicy) -> Criterion:
    """Zero unresolved critical incidents.

    Unlike duplicates, this one is meaningful over an empty window: an
    unresolved reconciliation break from before the shadow period still
    blocks promotion today, because it means local state and venue truth
    disagree right now. So there is no `insufficient_evidence` branch —
    "nothing is broken" is a real answer here, where "nothing duplicated
    among zero orders" is not.
    """

    n = len(ev.unresolved_incidents)
    status = PASS if n <= policy.max_unresolved_incidents else FAIL
    return Criterion(
        "zero_unresolved_incidents",
        status,
        value=float(n),
        threshold=float(policy.max_unresolved_incidents),
        detail={"incidents": ev.unresolved_incidents[:20]},
    )


@dataclass
class DecisionPacket:
    policy: GatePolicy
    window_start: datetime
    window_end: datetime
    criteria: list[Criterion]
    headline: dict[str, Any]
    policy_versions: list[str]

    @property
    def verdict(self) -> str:
        """`fail` beats `insufficient_evidence` beats `pass`.

        A measured failure is reported as a failure even when some other
        criterion lacks evidence — a negative result is not softened by
        an unfinished one sitting next to it.
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

    def criteria_dict(self) -> dict[str, Any]:
        return {c.name: c.as_dict() for c in self.criteria}

    def as_dict(self) -> dict[str, Any]:
        return {
            "policy_version": self.policy.version,
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "verdict": self.verdict,
            "criteria": self.criteria_dict(),
            "headline": self.headline,
            "policy_versions": self.policy_versions,
        }


def headline_metrics(ev: GateEvidence) -> dict[str, Any]:
    """ADR-0002 §G: fill rate and the rejection histogram.

    Not a criterion. The spec sets no threshold on fill rate, and
    inventing one here would be inventing policy — but this is the
    finding the shadow period exists to produce ("we can detect the good
    traders but almost never get their price" is an answer), so it
    travels with the verdict instead of being left to be recomputed
    later from data that may have aged out.
    """

    qualified = ev.qualified_signals
    slips = ev.slippages
    return {
        "qualified_signals": qualified,
        "filled_orders": ev.filled_orders,
        "fill_rate": (ev.filled_orders / qualified) if qualified else None,
        "mean_slippage_vs_source": (sum(slips) / len(slips)) if slips else None,
        "median_slippage_vs_source": percentile(slips, 0.50),
        "reject_reasons": dict(sorted(ev.reject_reasons.items(), key=lambda kv: -kv[1])),
        "fill_reasons": dict(sorted(ev.fill_reasons.items(), key=lambda kv: -kv[1])),
        "lots_open": ev.lots_open,
        "open_cost_basis": float(ev.open_cost_basis),
    }


def evaluate(ev: GateEvidence, policy: GatePolicy | None = None) -> DecisionPacket:
    """Judge one shadow window. Pure — no I/O, no clock, no randomness
    beyond the bootstrap's fixed seed."""

    pol = policy or GatePolicy()
    criteria = [
        _window(ev, pol),
        _sample_size(ev, pol),
        _net_positive(ev, pol),
        _freshness(ev, pol),
        _duplicates(ev, pol),
        _incidents(ev, pol),
    ]
    return DecisionPacket(
        policy=pol,
        window_start=ev.window_start,
        window_end=ev.window_end,
        criteria=criteria,
        headline=headline_metrics(ev),
        policy_versions=sorted(set(ev.policy_versions)),
    )
