"""Live triggers: large trades and rapid price moves.

These produce **alerts**, not signals. Nothing downstream trades off a
row written here, and that is a deliberate boundary rather than an
unfinished one:

* A signal is a claim that an edge exists. It has to survive the whole
  statistical apparatus in `analytics/` — event-block bootstrap, FDR,
  out-of-sample persistence — before it earns the name.
* A trigger is a claim that something *unusual* happened. It survives
  nothing. It is a prompt for a human to look.

Conflating the two is the failure mode the project's core principle
names directly: *do not equate profitability with insider activity*. A
wallet that buys $80k of a longshot forty minutes before a resolution is
interesting. It is not evidence of anything, and a system that lets that
observation reach an order router has skipped every check that
distinguishes an edge from a coincidence. So these rows land in
`wallet_anomaly_events`, feed the Tier-C watch list, and stop there.

Severity is a 0–1 *salience* score for ranking an operator's attention
queue. It is explicitly not a probability of anything.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg

KIND_LARGE_TRADE = "large_trade"
KIND_RAPID_MOVE = "rapid_move"

ZERO = Decimal("0")


@dataclass(frozen=True)
class AnomalyEvent:
    wallet: str
    kind: str
    ts: datetime
    severity: float
    evidence: dict[str, Any]


@dataclass(frozen=True)
class TriggerConfig:
    # Notional (USDC) at or above which a single trade is worth surfacing.
    large_trade_usd: Decimal = Decimal("25000")
    # Notional at which severity saturates at 1.0. Between the two,
    # severity scales linearly — a $26k trade and a $500k trade should
    # not sort identically in the attention queue.
    large_trade_saturation_usd: Decimal = Decimal("250000")
    # Absolute mid move (in probability) within `rapid_move_window`.
    rapid_move_delta: Decimal = Decimal("0.10")
    rapid_move_window: timedelta = timedelta(minutes=5)
    rapid_move_saturation: Decimal = Decimal("0.40")


def _scale(value: Decimal, floor: Decimal, ceiling: Decimal) -> float:
    """Linear 0–1 salience between floor and ceiling."""

    if ceiling <= floor:
        return 1.0
    frac = (value - floor) / (ceiling - floor)
    return max(0.0, min(1.0, float(frac)))


def detect_large_trade(
    *,
    wallet: str,
    condition_id: str,
    outcome_token_id: str,
    notional: Decimal,
    price: Decimal,
    occurred_at: datetime,
    config: TriggerConfig | None = None,
) -> AnomalyEvent | None:
    """Flag a single trade whose size is unusual in absolute terms.

    Absolute, not relative-to-the-wallet's-own-history, on purpose: a
    brand-new wallet has no history to be unusual against, and a first
    large trade from an unknown address is exactly the case worth
    surfacing. Relative sizing would systematically miss it.
    """

    cfg = config or TriggerConfig()
    if notional < cfg.large_trade_usd:
        return None
    return AnomalyEvent(
        wallet=wallet,
        kind=KIND_LARGE_TRADE,
        ts=occurred_at,
        severity=_scale(notional, cfg.large_trade_usd, cfg.large_trade_saturation_usd),
        evidence={
            "condition_id": condition_id,
            "outcome_token_id": outcome_token_id,
            "notional_usd": format(notional, "f"),
            "price": format(price, "f"),
            "threshold_usd": format(cfg.large_trade_usd, "f"),
            # Stated on every row so a reader of the raw table cannot
            # mistake it for a trading instruction.
            "interpretation": "alert only; not a signal and not evidence of informed trading",
        },
    )


@dataclass
class RapidMoveDetector:
    """Flags a mid that moves sharply inside a short window.

    Keeps a bounded per-token trail of (time, mid) and compares the
    newest observation against the oldest still inside the window. It
    deliberately does NOT compare against the previous observation:
    consecutive-tick deltas miss a move that happens in ten small steps,
    which is the shape an informed participant working an order actually
    produces.
    """

    config: TriggerConfig = field(default_factory=TriggerConfig)
    _trail: dict[str, list[tuple[datetime, Decimal]]] = field(default_factory=dict)

    def observe(
        self, outcome_token_id: str, mid: Decimal, at: datetime, *, condition_id: str | None = None
    ) -> AnomalyEvent | None:
        trail = self._trail.setdefault(outcome_token_id, [])
        trail.append((at, mid))

        cutoff = at - self.config.rapid_move_window
        # Drop everything that fell out of the window, but keep the most
        # recent expired point as the window's left edge — otherwise a
        # slow drift that crosses the threshold exactly as points expire
        # would never be measured against anything.
        keep_from = 0
        for i, (t, _) in enumerate(trail):
            if t >= cutoff:
                keep_from = max(0, i - 1)
                break
        else:
            keep_from = max(0, len(trail) - 1)
        del trail[:keep_from]

        if len(trail) < 2:
            return None
        oldest_mid = trail[0][1]
        delta = mid - oldest_mid
        if abs(delta) < self.config.rapid_move_delta:
            return None

        return AnomalyEvent(
            # A price move has no wallet. The column is not nullable, so
            # this sentinel keeps market-level anomalies in the same
            # attention queue without pretending to attribute them.
            wallet="",
            kind=KIND_RAPID_MOVE,
            ts=at,
            severity=_scale(
                abs(delta), self.config.rapid_move_delta, self.config.rapid_move_saturation
            ),
            evidence={
                "condition_id": condition_id,
                "outcome_token_id": outcome_token_id,
                "from_mid": format(oldest_mid, "f"),
                "to_mid": format(mid, "f"),
                "delta": format(delta, "f"),
                "window_s": self.config.rapid_move_window.total_seconds(),
                "interpretation": "alert only; a price move is not attributable to any wallet",
            },
        )


# ── persistence ───────────────────────────────────────────────────────


class AnomalyStore(ABC):
    @abstractmethod
    def record(self, events: list[AnomalyEvent]) -> int: ...


@dataclass
class InMemoryAnomalyStore(AnomalyStore):
    events: list[AnomalyEvent] = field(default_factory=list)

    def record(self, events: list[AnomalyEvent]) -> int:
        self.events.extend(events)
        return len(events)


class PostgresAnomalyStore(AnomalyStore):
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def record(self, events: list[AnomalyEvent]) -> int:
        if not events:
            return 0
        with self._conn.cursor() as cur:
            for e in events:
                cur.execute(
                    "insert into wallet_anomaly_events (wallet, kind, ts, severity, evidence) "
                    "values (%s,%s,%s,%s,%s::jsonb)",
                    (e.wallet, e.kind, e.ts, e.severity, json.dumps(e.evidence)),
                )
        return len(events)
