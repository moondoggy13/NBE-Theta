"""Shadow broker: what a bounded FOK order would have done.

Shadow mode is not a toy. It is the instrument that answers the question
ADR-0002 §G says is the product's central risk: **among signals that
qualify, how often do we actually get the price?** Copying is a latency
race, and a shadow run that reports 100% fills is a shadow run with a
bug in it.

So the simulation is deliberately pessimistic in the places where
optimism would flatter us:

* **Fill-or-kill means all or nothing.** A partial fill is recorded as a
  rejection, not as a smaller position. Real FOK orders do not partially
  fill, and modelling them as if they did would invent liquidity that
  was never there.
* **We walk the book.** The price is the VWAP of the levels actually
  consumed, not the top of book. Taking size at the best price is the
  single most common way a backtest manufactures returns.
* **Fees come off the fill**, at the venue's rate for that market.
* **A stale book does not fill.** If the quote we are pricing against is
  older than the freshness bound, we cannot claim to know what was
  there. Unknown is a rejection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from nbe_theta.signals.gates import vwap_for

ZERO = Decimal("0")

REASON_FILLED = "filled"
REASON_NO_BOOK = "no_book"
REASON_STALE_BOOK = "stale_book"
REASON_INSUFFICIENT_DEPTH = "insufficient_depth"
REASON_LIMIT_EXCEEDED = "limit_exceeded"
REASON_ZERO_QUANTITY = "zero_quantity"


@dataclass(frozen=True)
class ShadowConfig:
    # Beyond this a quote is not evidence of what the book held.
    max_book_age_s: float = 30.0


@dataclass
class ShadowFill:
    filled: bool
    reason: str
    requested_quantity: Decimal
    filled_quantity: Decimal
    limit_price: Decimal
    vwap: Decimal | None = None
    fees: Decimal = ZERO
    slippage_vs_source: Decimal | None = None
    book_snapshot: dict[str, Any] = field(default_factory=dict)

    @property
    def notional(self) -> Decimal:
        if self.vwap is None:
            return ZERO
        return self.vwap * self.filled_quantity


def simulate(
    *,
    side: str,
    quantity: Decimal,
    limit_price: Decimal,
    levels: list[tuple[Decimal, Decimal]],
    fee_rate: Decimal,
    source_price: Decimal | None = None,
    book_age_s: float | None = None,
    config: ShadowConfig | None = None,
) -> ShadowFill:
    """Price a bounded fill-or-kill order against the observed book."""

    cfg = config or ShadowConfig()
    snapshot = {
        "levels": [[format(p, "f"), format(s, "f")] for p, s in levels[:10]],
        "book_age_s": book_age_s,
    }

    if quantity <= ZERO:
        return ShadowFill(
            False, REASON_ZERO_QUANTITY, quantity, ZERO, limit_price, book_snapshot=snapshot
        )

    if not levels:
        return ShadowFill(
            False, REASON_NO_BOOK, quantity, ZERO, limit_price, book_snapshot=snapshot
        )

    if book_age_s is not None and book_age_s > cfg.max_book_age_s:
        # We do not know what the book held. Claiming a fill here is the
        # difference between a backtest and a fantasy.
        return ShadowFill(
            False, REASON_STALE_BOOK, quantity, ZERO, limit_price, book_snapshot=snapshot
        )

    # Only levels at or better than the limit are takeable.
    takeable = [
        (p, s) for p, s in levels if (p <= limit_price if side == "BUY" else p >= limit_price)
    ]
    if not takeable:
        return ShadowFill(
            False, REASON_LIMIT_EXCEEDED, quantity, ZERO, limit_price, book_snapshot=snapshot
        )

    available = sum((s for _, s in takeable), ZERO)
    if available < quantity:
        # FOK: all or nothing. Recording a partial here would invent
        # liquidity and quietly inflate the fill rate — the exact number
        # the shadow gate exists to measure.
        return ShadowFill(
            False,
            REASON_INSUFFICIENT_DEPTH,
            quantity,
            ZERO,
            limit_price,
            book_snapshot={**snapshot, "available": format(available, "f")},
        )

    priced = vwap_for(takeable, quantity, side)
    if priced is None:
        return ShadowFill(
            False, REASON_INSUFFICIENT_DEPTH, quantity, ZERO, limit_price, book_snapshot=snapshot
        )

    vwap, filled = priced
    # No VWAP-versus-limit check here, and that is not an omission.
    # `takeable` already excludes every level worse than the limit, so
    # the VWAP is a weighted average of prices that are each within the
    # bound and is therefore within it too. A check here would be
    # unreachable — and an unreachable safety check is worse than none,
    # because it advertises a protection that is not doing anything.
    #
    # This also matches the venue: a bounded limit order never matches an
    # individual lot at a worse price than its limit. Depth beyond the
    # limit is not expensive liquidity, it is absent liquidity, and it
    # surfaces above as `insufficient_depth`.
    fees = vwap * filled * fee_rate
    slippage = None
    if source_price is not None:
        move = vwap - source_price
        slippage = move if side == "BUY" else -move

    return ShadowFill(
        filled=True,
        reason=REASON_FILLED,
        requested_quantity=quantity,
        filled_quantity=filled,
        limit_price=limit_price,
        vwap=vwap,
        fees=fees,
        slippage_vs_source=slippage,
        book_snapshot=snapshot,
    )


@dataclass
class ShadowStats:
    """Headline shadow-gate numbers.

    `fill_rate` is over QUALIFIED signals — signals that passed every
    gate and were sized. That is the number ADR-0002 §G calls the
    product's central risk, and it is meaningless if computed over all
    evaluations (most of which never got as far as an order).
    """

    qualified: int = 0
    filled: int = 0
    reasons: dict[str, int] = field(default_factory=dict)
    slippages: list[float] = field(default_factory=list)

    def observe(self, fill: ShadowFill) -> None:
        self.qualified += 1
        self.reasons[fill.reason] = self.reasons.get(fill.reason, 0) + 1
        if fill.filled:
            self.filled += 1
            if fill.slippage_vs_source is not None:
                self.slippages.append(float(fill.slippage_vs_source))

    @property
    def fill_rate(self) -> float | None:
        return (self.filled / self.qualified) if self.qualified else None

    @property
    def mean_slippage(self) -> float | None:
        return (sum(self.slippages) / len(self.slippages)) if self.slippages else None

    def summary(self) -> dict[str, Any]:
        return {
            "qualified": self.qualified,
            "filled": self.filled,
            "fill_rate": self.fill_rate,
            "mean_slippage_vs_source": self.mean_slippage,
            "reasons": dict(sorted(self.reasons.items(), key=lambda kv: -kv[1])),
        }
