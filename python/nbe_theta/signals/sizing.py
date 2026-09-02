"""Position sizing and portfolio risk.

Gates decided *whether*. This decides *how much*, and it is the one
place where trade-offs genuinely belong: a thinner book or a weaker
source should shrink a position, not veto it.

Two different mechanisms, deliberately not mixed:

* **Factors** multiply. Quality, confidence and liquidity each scale the
  base size in `[0,1]`. A product means a weak factor shrinks the
  position instead of being averaged away by a strong one.
* **Caps** clamp. Per-entry, per-market, per-cluster, per-correlated-
  theme and the daily budget are hard ceilings applied after the
  factors. A cap is not a preference.

Three rules that are easy to get wrong and expensive when you do:

1. **A drawdown stop blocks new entries. It never liquidates.** Forced
   selling on a paper loss converts it into a realised one at the worst
   available price, in the thinnest book, at the moment everything is
   moving against you. The kill switch stops *dispatch*; flattening is a
   deliberate operator action.
2. **Below the venue minimum we skip.** Never round up. Rounding up is
   a silent override of every cap above it.
3. **Open orders count against exposure.** A cap that ignores in-flight
   orders is not a cap; it is a cap plus however many orders happen to
   be outstanding.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

ZERO = Decimal("0")


@dataclass(frozen=True)
class RiskPolicy:
    version: str = "risk-1"

    # Fractions of NAV.
    max_per_entry: Decimal = Decimal("0.015")
    max_per_market: Decimal = Decimal("0.08")
    max_correlated: Decimal = Decimal("0.25")

    # Halt NEW ENTRIES after this daily drawdown. Not a liquidation
    # trigger — see the module docstring.
    daily_drawdown_halt: Decimal = Decimal("0.15")

    # Never take more than this share of the displayed executable depth.
    # Our own impact is a cost we control by not being large relative to
    # the book.
    max_book_participation: Decimal = Decimal("0.05")


@dataclass
class PortfolioState:
    """Everything sizing needs about where we already stand.

    `open_order_notional` is separate from filled exposure on purpose:
    an order in flight is exposure we have committed to even though no
    fill has landed. Ignoring it is how a system quietly doubles a cap
    under load.
    """

    nav: Decimal
    cash: Decimal
    exposure_by_market: dict[str, Decimal] = field(default_factory=dict)
    exposure_by_cluster: dict[str, Decimal] = field(default_factory=dict)
    exposure_by_theme: dict[str, Decimal] = field(default_factory=dict)
    open_order_notional: dict[str, Decimal] = field(default_factory=dict)
    day_start_nav: Decimal | None = None

    @property
    def daily_drawdown(self) -> Decimal:
        """Fraction below the day's starting NAV. Zero when up."""

        if not self.day_start_nav or self.day_start_nav <= ZERO:
            return ZERO
        loss = self.day_start_nav - self.nav
        return max(ZERO, loss / self.day_start_nav)

    def market_exposure(self, condition_id: str) -> Decimal:
        return self.exposure_by_market.get(condition_id, ZERO) + self.open_order_notional.get(
            condition_id, ZERO
        )


@dataclass
class SizeDecision:
    quantity: Decimal
    notional: Decimal
    factors: dict[str, Any] = field(default_factory=dict)
    caps: dict[str, Any] = field(default_factory=dict)
    skipped_reason: str | None = None

    @property
    def actionable(self) -> bool:
        return self.skipped_reason is None and self.quantity > ZERO


def quality_factor(rank_score: float | None) -> float:
    """Scale by how good the source is, within the eligible band.

    Everything reaching sizing has already passed eligibility, so this
    only distinguishes good from excellent — it maps [0.5, 1.0] onto
    [0.5, 1.0] and floors below that. It cannot admit anyone; a factor
    is not a gate.
    """

    if rank_score is None:
        return 0.5
    return max(0.5, min(1.0, rank_score))


def liquidity_factor(depth: Decimal | None, desired: Decimal) -> float:
    """Shrink when the book is thin relative to what we want.

    Full size when depth is at least 20x the order, scaling down toward
    a floor as it tightens. This is on top of the participation cap, not
    instead of it: the cap bounds our share of the book, this reflects
    that a thin book is evidence the fill will be poor.
    """

    if depth is None or desired <= ZERO:
        return 0.5
    multiple = float(depth / desired) if desired > ZERO else 0.0
    if multiple >= 20.0:
        return 1.0
    return max(0.25, min(1.0, multiple / 20.0))


def size_entry(
    *,
    portfolio: PortfolioState,
    policy: RiskPolicy,
    limit_price: Decimal,
    book_depth: Decimal | None,
    min_order_size: Decimal | None,
    rank_score: float | None,
    confidence: float | None,
    condition_id: str,
    cluster_key: str | None = None,
    theme_key: str | None = None,
) -> SizeDecision:
    """How much to buy, or why nothing."""

    caps: dict[str, Any] = {}
    factors: dict[str, Any] = {}

    if portfolio.nav <= ZERO:
        return SizeDecision(ZERO, ZERO, skipped_reason="no_nav")

    # ── Halt check, first. ────────────────────────────────────────────
    dd = portfolio.daily_drawdown
    caps["daily_drawdown"] = format(dd, "f")
    if dd >= policy.daily_drawdown_halt:
        return SizeDecision(
            ZERO,
            ZERO,
            caps=caps,
            skipped_reason="daily_drawdown_halt",
        )

    # ── Base allocation ───────────────────────────────────────────────
    base = portfolio.nav * policy.max_per_entry
    caps["per_entry"] = format(base, "f")

    # ── Multiplicative factors ────────────────────────────────────────
    qf = quality_factor(rank_score)
    cf = max(0.5, min(1.0, confidence if confidence is not None else 0.5))
    desired_qty = (base / limit_price) if limit_price > ZERO else ZERO
    lf = liquidity_factor(book_depth, desired_qty)
    factors.update({"quality": qf, "confidence": cf, "liquidity": lf})

    notional = base * Decimal(str(qf)) * Decimal(str(cf)) * Decimal(str(lf))

    # ── Hard caps, applied after ──────────────────────────────────────
    market_room = portfolio.nav * policy.max_per_market - portfolio.market_exposure(condition_id)
    caps["per_market_room"] = format(market_room, "f")
    if market_room <= ZERO:
        return SizeDecision(ZERO, ZERO, factors=factors, caps=caps, skipped_reason="market_cap")
    notional = min(notional, market_room)

    if cluster_key:
        used = portfolio.exposure_by_cluster.get(cluster_key, ZERO)
        cluster_room = portfolio.nav * policy.max_correlated - used
        caps["per_cluster_room"] = format(cluster_room, "f")
        if cluster_room <= ZERO:
            return SizeDecision(
                ZERO, ZERO, factors=factors, caps=caps, skipped_reason="cluster_cap"
            )
        notional = min(notional, cluster_room)

    if theme_key:
        used = portfolio.exposure_by_theme.get(theme_key, ZERO)
        theme_room = portfolio.nav * policy.max_correlated - used
        caps["per_theme_room"] = format(theme_room, "f")
        if theme_room <= ZERO:
            return SizeDecision(
                ZERO, ZERO, factors=factors, caps=caps, skipped_reason="correlated_cap"
            )
        notional = min(notional, theme_room)

    notional = min(notional, portfolio.cash)
    caps["cash"] = format(portfolio.cash, "f")
    if notional <= ZERO:
        return SizeDecision(ZERO, ZERO, factors=factors, caps=caps, skipped_reason="no_cash")

    quantity = notional / limit_price if limit_price > ZERO else ZERO

    # ── Participation cap ─────────────────────────────────────────────
    if book_depth is not None:
        participation_cap = book_depth * policy.max_book_participation
        caps["participation"] = format(participation_cap, "f")
        quantity = min(quantity, participation_cap)

    # ── Venue minimum: skip, never round up ───────────────────────────
    if min_order_size is not None and quantity < min_order_size:
        caps["min_order_size"] = format(min_order_size, "f")
        return SizeDecision(
            ZERO,
            ZERO,
            factors=factors,
            caps=caps,
            skipped_reason="below_min_order_size",
        )

    return SizeDecision(
        quantity=quantity,
        notional=quantity * limit_price,
        factors=factors,
        caps=caps,
    )
