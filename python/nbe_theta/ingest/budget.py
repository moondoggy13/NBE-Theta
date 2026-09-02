"""Polling budget arithmetic, as an assertable object.

ADR-0002 §E: the NBE-Overlord spec's own polling schedule is
over-subscribed against its own rate cap.

    feeder      150 wallets / 10 s   = 150.0 req/10s
    cohort      850 wallets / 120 s  =  70.8
    positions   150 / 5 min          =   5.0
    positions   850 / 30 min         =   4.7
                              total  ≈ 230.5 / 250  (92 %)

92 % utilisation leaves nothing for the 180-day backfill of new
entrants, retries, the six-hour cohort refresh, or a single
`Retry-After` pause — and a rate limiter that is already at the ceiling
does not degrade gracefully, it 429s and drops the freshness we are
paying for.

The fix is not a comment. It is this module: the schedule is data, the
utilisation is computed, and a test asserts it stays under the headroom
target. A future change that adds a poller or tightens an interval fails
CI instead of silently starving the feeder.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Self-imposed ceiling, deliberately below the venue's documented global
# budget so our own bugs cannot exhaust someone else's allowance.
DEFAULT_CAP_PER_10S = 250.0

# Fraction of the cap the steady-state schedule may consume. The
# remainder absorbs backfill, retries, and cohort refresh bursts.
DEFAULT_HEADROOM_TARGET = 0.75


@dataclass(frozen=True)
class PollTask:
    """One repeating poll: `count` entities, each every `interval_s`."""

    name: str
    count: int
    interval_s: float
    # Requests per entity per pass. Usually 1; a paginated sweep is more.
    requests_per_entity: float = 1.0

    def requests_per_10s(self) -> float:
        if self.interval_s <= 0:
            raise ValueError(f"{self.name}: interval_s must be positive")
        return (self.count * self.requests_per_entity) * (10.0 / self.interval_s)


@dataclass(frozen=True)
class PollBudget:
    tasks: list[PollTask] = field(default_factory=list)
    cap_per_10s: float = DEFAULT_CAP_PER_10S
    headroom_target: float = DEFAULT_HEADROOM_TARGET

    def total_per_10s(self) -> float:
        return sum(t.requests_per_10s() for t in self.tasks)

    def utilisation(self) -> float:
        return self.total_per_10s() / self.cap_per_10s

    def within_headroom(self) -> bool:
        return self.utilisation() <= self.headroom_target

    def breakdown(self) -> dict[str, float]:
        return {t.name: round(t.requests_per_10s(), 2) for t in self.tasks}

    def explain(self) -> str:
        lines = [f"{n:<24} {v:>8.1f} req/10s" for n, v in self.breakdown().items()]
        lines.append(f"{'TOTAL':<24} {self.total_per_10s():>8.1f} req/10s")
        lines.append(
            f"{'utilisation':<24} {self.utilisation() * 100:>7.1f}% "
            f"of {self.cap_per_10s:.0f} (target ≤ {self.headroom_target * 100:.0f}%)"
        )
        return "\n".join(lines)


def spec_schedule() -> PollBudget:
    """The schedule exactly as the spec proposes it. Over-subscribed.

    Kept so the test can demonstrate the problem rather than merely
    assert the fix — a regression that reverts to these numbers should
    fail against a named alternative, not a bare threshold.
    """

    return PollBudget(
        tasks=[
            PollTask("feeder_activity", 150, 10.0),
            PollTask("cohort_activity", 850, 120.0),
            PollTask("feeder_positions", 150, 300.0),
            PollTask("cohort_positions", 850, 1800.0),
        ]
    )


def adopted_schedule() -> PollBudget:
    """What we actually run: feeder polling at 15 s.

    Trades ~5 s of median detection latency for the headroom that keeps
    the whole schedule from collapsing under a single retry storm. The
    latency cost is real but small relative to the copy delay we already
    assume (`copyability.DEFAULT_DELAY_SECONDS`), and it is far cheaper
    than being rate-limited into a gap.
    """

    return PollBudget(
        tasks=[
            PollTask("feeder_activity", 150, 15.0),
            PollTask("cohort_activity", 850, 120.0),
            PollTask("feeder_positions", 150, 300.0),
            PollTask("cohort_positions", 850, 1800.0),
        ]
    )
