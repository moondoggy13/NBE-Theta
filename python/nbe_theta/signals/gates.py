"""Qualification gates.

ADR-0002 §A replaced the spec's `S = 0.45Q + …  ≥ 0.75` with this: an
ordered list of **boolean** gates, each recording its own outcome and
reason.

Why the shape matters, restated because it is the load-bearing decision
of the whole execution path: a weighted sum lets a failing liquidity
check be compensated for by a high-quality source. That is nonsense — a
book that cannot absorb the order does not become deeper because the
wallet is good. These are necessary conditions, and necessary conditions
do not trade off. Size, which genuinely *is* a trade-off, is computed
separately in `sizing`.

Every gate is evaluated even after one fails, so the console shows the
whole picture rather than the first stumble. `reject_reason` names the
first failure for triage, and the histogram of those reasons across a
shadow run is the single most informative artefact this system produces
early on: if 90% of signals die on `price_cap`, the finding is that we
cannot win the latency race, and that is a product answer rather than a
bug.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from nbe_theta.analytics.copyability import price_cap
from nbe_theta.signals.actions import SourceAction

ZERO = Decimal("0")
ONE = Decimal("1")


@dataclass(frozen=True)
class SignalPolicy:
    """Versioned qualification thresholds."""

    version: str = "signal-1"

    # Materiality: BOTH halves. Absolute size alone copies a whale's
    # rounding error; relative size alone copies a small account's entire
    # bankroll on a $20 trade.
    min_notional_usd: Decimal = Decimal("250")
    min_position_delta_ratio: Decimal = Decimal("0.025")

    # Freshness. Beyond this the source's own trade has usually moved the
    # price and we are buying the move rather than the view.
    max_detection_latency_s: float = 90.0

    # Market tradability.
    min_seconds_to_close: float = 4 * 3600
    max_spread: Decimal = Decimal("0.03")
    # Book must hold this multiple of our order inside the limit price.
    min_depth_multiple: Decimal = Decimal("20")
    # V1 excludes neg-risk: buying NO on one outcome is economically close
    # to buying YES across the others, so mirroring naively can double
    # real exposure while the per-market cap still reads as satisfied.
    exclude_neg_risk: bool = True

    # Consensus. A source this good may act alone; below it, two
    # INDEPENDENT clusters must agree. Clusters, not wallets — five
    # wallets from one desk are one opinion (see analytics.clustering).
    solo_rank_score: float = 0.80
    consensus_window: timedelta = timedelta(minutes=10)
    required_clusters: int = 2


@dataclass(frozen=True)
class MarketContext:
    """What the venue says about the market, at evaluation time."""

    condition_id: str
    outcome_token_id: str
    active: bool
    closed: bool
    resolved: bool
    accepting_orders: bool
    neg_risk: bool
    closes_at: datetime | None
    tick_size: Decimal | None
    min_order_size: Decimal | None
    fee_rate: Decimal
    # Book, best-first. Asks for a BUY, bids for a SELL.
    levels: list[tuple[Decimal, Decimal]] = field(default_factory=list)
    quote_age_s: float | None = None
    # Decided non-sports classification. None = undecided, which fails.
    is_sports: bool | None = None


@dataclass(frozen=True)
class SourceContext:
    """What we know about the wallet that traded."""

    wallet: str
    in_feeder_set: bool
    rank_score: float | None
    cluster_key: str | None
    # Distinct OTHER clusters that took the same side of the same outcome
    # inside the consensus window.
    agreeing_clusters: int = 0


@dataclass
class GateResult:
    name: str
    passed: bool
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class Qualification:
    gates: list[GateResult]
    limit_price: Decimal | None
    max_quantity_by_depth: Decimal | None

    @property
    def accepted(self) -> bool:
        return all(g.passed for g in self.gates)

    @property
    def reject_reason(self) -> str | None:
        for g in self.gates:
            if not g.passed:
                return g.name
        return None

    def as_dict(self) -> dict[str, Any]:
        return {g.name: {"passed": g.passed, **g.detail} for g in self.gates}


def walk_book(levels: list[tuple[Decimal, Decimal]], limit: Decimal, side: str) -> Decimal:
    """Total quantity available at or better than `limit`.

    "Better" is direction-dependent: for a BUY we can take asks at or
    below the limit, for a SELL we can hit bids at or above it.
    """

    total = ZERO
    for price, size in levels:
        acceptable = price <= limit if side == "BUY" else price >= limit
        if acceptable:
            total += size
    return total


def vwap_for(
    levels: list[tuple[Decimal, Decimal]], quantity: Decimal, side: str
) -> tuple[Decimal, Decimal] | None:
    """Volume-weighted price to fill `quantity`, walking the book.

    Returns (vwap, filled) or None if the book cannot fill it at all.
    Levels are consumed best-first, so they are sorted here rather than
    trusting the caller — the venue does not document a stable order and
    a wrong sort silently produces a flattering price.
    """

    if quantity <= ZERO:
        return None
    ordered = sorted(levels, key=lambda lv: lv[0], reverse=(side == "SELL"))
    remaining = quantity
    cost = ZERO
    for price, size in ordered:
        take = min(remaining, size)
        if take <= ZERO:
            continue
        cost += take * price
        remaining -= take
        if remaining <= ZERO:
            break
    filled = quantity - remaining
    if filled <= ZERO:
        return None
    return (cost / filled, filled)


def qualify(
    action: SourceAction,
    source: SourceContext,
    market: MarketContext,
    policy: SignalPolicy,
    *,
    now: datetime,
    proposed_quantity: Decimal | None = None,
) -> Qualification:
    """Run every gate. Order is presentation order, cheapest first."""

    gates: list[GateResult] = []

    def gate(name: str, passed: bool, **detail: Any) -> None:
        gates.append(GateResult(name=name, passed=passed, detail=detail))

    # ── Source ────────────────────────────────────────────────────────
    gate("feeder_member", source.in_feeder_set, wallet=source.wallet)

    # ── Direction ─────────────────────────────────────────────────────
    # Entries only. An exit is mirrored from our own lots (see `lots`),
    # never qualified as a fresh signal, because a source SELL we cannot
    # link to a lot we opened is not an instruction to go short.
    gate("is_entry", action.side == "BUY", side=action.side)

    # ── Materiality ───────────────────────────────────────────────────
    ratio = action.position_delta_ratio
    gate(
        "materiality_absolute",
        action.notional >= policy.min_notional_usd,
        notional=format(action.notional, "f"),
        threshold=format(policy.min_notional_usd, "f"),
    )
    gate(
        "materiality_relative",
        ratio is not None and ratio >= policy.min_position_delta_ratio,
        ratio=(format(ratio, "f") if ratio is not None else None),
        threshold=format(policy.min_position_delta_ratio, "f"),
        note=None if ratio is not None else "no pre-trade position known; fails closed",
    )

    # ── Freshness ─────────────────────────────────────────────────────
    latency = action.detection_latency_s
    gate(
        "freshness",
        latency <= policy.max_detection_latency_s,
        latency_s=latency,
        threshold_s=policy.max_detection_latency_s,
    )

    # ── Market tradability ────────────────────────────────────────────
    gate(
        "market_open",
        market.active and not market.closed and not market.resolved,
        active=market.active,
        closed=market.closed,
        resolved=market.resolved,
    )
    gate("accepting_orders", market.accepting_orders)
    gate(
        "not_neg_risk",
        (not policy.exclude_neg_risk) or (not market.neg_risk),
        neg_risk=market.neg_risk,
        note="V1 excludes neg-risk: mirroring can double real exposure",
    )
    # Undecided classification fails: we cannot assert non-sports from
    # silence (see analytics.taxonomy).
    gate(
        "non_sports",
        market.is_sports is False,
        is_sports=market.is_sports,
        note=None if market.is_sports is not None else "unclassified; fails closed",
    )

    seconds_left = (
        (market.closes_at - now).total_seconds() if market.closes_at is not None else None
    )
    gate(
        "time_to_close",
        seconds_left is not None and seconds_left >= policy.min_seconds_to_close,
        seconds_left=seconds_left,
        threshold_s=policy.min_seconds_to_close,
    )
    gate(
        "market_metadata",
        market.tick_size is not None and market.min_order_size is not None,
        tick_size=(format(market.tick_size, "f") if market.tick_size else None),
        min_order_size=(format(market.min_order_size, "f") if market.min_order_size else None),
    )

    # ── Book quality ──────────────────────────────────────────────────
    best = (
        min((p for p, _ in market.levels), default=None)
        if action.side == "BUY"
        else max((p for p, _ in market.levels), default=None)
    )
    spread = None
    if len(market.levels) >= 2:
        prices = sorted(p for p, _ in market.levels)
        spread = prices[-1] - prices[0]
    gate(
        "book_present",
        best is not None,
        levels=len(market.levels),
    )

    # ── Price cap ─────────────────────────────────────────────────────
    # The all-in price we would pay must not exceed the source's own by
    # more than the cap, which scales with distance from certainty
    # (see copyability.price_cap).
    cap = price_cap(action.vwap)
    limit = action.vwap + cap if action.side == "BUY" else action.vwap - cap
    limit = max(ZERO, min(ONE, limit))

    depth = walk_book(market.levels, limit, action.side) if market.levels else ZERO
    gate(
        "price_cap",
        best is not None and ((best <= limit) if action.side == "BUY" else (best >= limit)),
        source_vwap=format(action.vwap, "f"),
        cap=format(cap, "f"),
        limit=format(limit, "f"),
        best=(format(best, "f") if best is not None else None),
    )

    if spread is not None:
        gate(
            "spread",
            spread <= policy.max_spread,
            spread=format(spread, "f"),
            threshold=format(policy.max_spread, "f"),
        )

    # Depth is checked against the proposed order when we have one;
    # otherwise against the venue minimum, so a market with essentially
    # no book still fails here rather than downstream.
    reference = proposed_quantity or market.min_order_size or ONE
    gate(
        "depth",
        depth >= reference * policy.min_depth_multiple,
        depth=format(depth, "f"),
        required=format(reference * policy.min_depth_multiple, "f"),
        reference_quantity=format(reference, "f"),
    )

    # ── Consensus ─────────────────────────────────────────────────────
    # A strong enough source acts alone; otherwise two independent
    # CLUSTERS must agree. Counting wallets instead of clusters is what
    # lets one desk manufacture its own confirmation.
    rank = source.rank_score if source.rank_score is not None else 0.0
    solo_ok = rank >= policy.solo_rank_score
    consensus_ok = solo_ok or (source.agreeing_clusters + 1) >= policy.required_clusters
    gate(
        "consensus",
        consensus_ok,
        rank_score=rank,
        solo_threshold=policy.solo_rank_score,
        agreeing_clusters=source.agreeing_clusters,
        required=policy.required_clusters,
        note="solo permitted" if solo_ok else "needs an independent cluster",
    )

    return Qualification(
        gates=gates,
        limit_price=limit,
        max_quantity_by_depth=depth if market.levels else None,
    )
