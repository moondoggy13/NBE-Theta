"""Strategy lots: our positions, attributed to the source that caused them.

Attribution is the whole point. When a source cuts 40% of its position
we sell 40% of the lots **we opened from that source** — not 40% of our
total holding in that market, which may include lots from a different
source with a different view and a different entry.

Three invariants, each blocking a specific way copy-trading goes wrong:

1. **We never go short.** A source SELL is mirrored only against lots we
   actually hold from that source. If it sells more than we hold, we
   sell what we have and stop. Selling beyond that would open a short
   position nobody asked for, on the theory that the source "must know
   something" — which is inventing a signal, not copying one.

2. **We never infer a reversal.** A source going from long-YES to
   long-NO is two decisions to it and, to us, one exit; the NO entry is
   a fresh signal that must pass the gates on its own merits.

3. **Settlement closes lots.** A copied market that resolves and leaves
   an open lot makes the book drift from reality forever. Resolution is
   an event we act on, not one we wait to be told about.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

ZERO = Decimal("0")

STATUS_OPEN = "open"
STATUS_CLOSED = "closed"
STATUS_SETTLED = "settled"


@dataclass
class StrategyLot:
    id: str
    mode: str
    source_wallet: str
    condition_id: str
    outcome_token_id: str
    side: str
    opened_at: datetime
    entry_price: Decimal
    quantity_opened: Decimal
    quantity_open: Decimal
    fees_paid: Decimal = ZERO
    realized_pnl: Decimal = ZERO
    status: str = STATUS_OPEN
    source_cluster_key: str | None = None
    closed_at: datetime | None = None
    settled_at: datetime | None = None
    settlement_price: Decimal | None = None

    @property
    def cost_basis(self) -> Decimal:
        return self.entry_price * self.quantity_open


@dataclass
class ExitLeg:
    lot_id: str
    quantity: Decimal
    entry_price: Decimal


@dataclass
class ExitPlan:
    """What to sell, and why nothing when that is the answer."""

    legs: list[ExitLeg] = field(default_factory=list)
    requested_ratio: Decimal | None = None
    reason: str | None = None

    @property
    def total_quantity(self) -> Decimal:
        return sum((leg.quantity for leg in self.legs), ZERO)

    @property
    def actionable(self) -> bool:
        return self.total_quantity > ZERO


def open_lot(
    *,
    mode: str,
    source_wallet: str,
    source_cluster_key: str | None,
    condition_id: str,
    outcome_token_id: str,
    side: str,
    opened_at: datetime,
    entry_price: Decimal,
    quantity: Decimal,
    fees: Decimal = ZERO,
) -> StrategyLot:
    return StrategyLot(
        id=str(uuid.uuid4()),
        mode=mode,
        source_wallet=source_wallet,
        source_cluster_key=source_cluster_key,
        condition_id=condition_id,
        outcome_token_id=outcome_token_id,
        side=side,
        opened_at=opened_at,
        entry_price=entry_price,
        quantity_opened=quantity,
        quantity_open=quantity,
        fees_paid=fees,
    )


def plan_exit(
    lots: list[StrategyLot],
    *,
    source_wallet: str,
    outcome_token_id: str,
    reduction_ratio: Decimal | None,
) -> ExitPlan:
    """Mirror a source's proportional reduction onto our own lots.

    ``reduction_ratio`` is the fraction of ITS position the source cut.
    We apply the same fraction to the total we hold from that source in
    that token, then allocate across lots oldest-first.

    Returns an empty plan with a reason when there is nothing to mirror.
    An empty plan is a legitimate outcome — a source selling something we
    never copied is simply not our trade.
    """

    if reduction_ratio is None or reduction_ratio <= ZERO:
        return ExitPlan(reason="no_reduction_ratio", requested_ratio=reduction_ratio)

    ours = [
        lot
        for lot in lots
        if lot.status == STATUS_OPEN
        and lot.source_wallet == source_wallet
        and lot.outcome_token_id == outcome_token_id
        and lot.quantity_open > ZERO
    ]
    if not ours:
        # The source is reducing something we do not hold from them. Not
        # an error and emphatically not a short: it is simply not ours.
        return ExitPlan(reason="no_matching_lots", requested_ratio=reduction_ratio)

    held = sum((lot.quantity_open for lot in ours), ZERO)
    # Cap at 1.0: a source can exit more than 100% of its *starting*
    # position by reversing, but we mirror at most everything we hold.
    ratio = min(reduction_ratio, Decimal("1"))
    target = held * ratio
    if target <= ZERO:
        return ExitPlan(reason="ratio_rounds_to_zero", requested_ratio=reduction_ratio)

    legs: list[ExitLeg] = []
    remaining = target
    for lot in sorted(ours, key=lambda lot: lot.opened_at):
        if remaining <= ZERO:
            break
        take = min(remaining, lot.quantity_open)
        if take <= ZERO:
            continue
        legs.append(ExitLeg(lot_id=lot.id, quantity=take, entry_price=lot.entry_price))
        remaining -= take

    return ExitPlan(legs=legs, requested_ratio=reduction_ratio)


def apply_exit(
    lots: dict[str, StrategyLot],
    plan: ExitPlan,
    *,
    exit_price: Decimal,
    at: datetime,
    fees: Decimal = ZERO,
) -> Decimal:
    """Reduce lots by the plan and realise P&L. Returns proceeds."""

    proceeds = ZERO
    fee_per_unit = (fees / plan.total_quantity) if plan.total_quantity > ZERO else ZERO
    for leg in plan.legs:
        lot = lots.get(leg.lot_id)
        if lot is None:
            continue
        qty = min(leg.quantity, lot.quantity_open)
        if qty <= ZERO:
            continue
        leg_fees = fee_per_unit * qty
        gross = exit_price * qty
        lot.quantity_open -= qty
        lot.realized_pnl += gross - (lot.entry_price * qty) - leg_fees
        lot.fees_paid += leg_fees
        proceeds += gross - leg_fees
        if lot.quantity_open <= ZERO:
            lot.status = STATUS_CLOSED
            lot.closed_at = at
    return proceeds


def settle_lots(
    lots: list[StrategyLot],
    *,
    outcome_token_id: str,
    resolution_price: Decimal,
    at: datetime,
) -> list[StrategyLot]:
    """Close open lots at a settled outcome price.

    Without this a copied market that resolves leaves an open lot
    forever and the portfolio drifts from reality — every NAV, every
    exposure cap and every drawdown check reads off a position that no
    longer exists.
    """

    settled: list[StrategyLot] = []
    for lot in lots:
        if lot.status != STATUS_OPEN or lot.outcome_token_id != outcome_token_id:
            continue
        qty = lot.quantity_open
        if qty <= ZERO:
            continue
        payoff = resolution_price * qty
        lot.realized_pnl += payoff - (lot.entry_price * qty)
        lot.quantity_open = ZERO
        lot.status = STATUS_SETTLED
        lot.settled_at = at
        lot.settlement_price = resolution_price
        lot.closed_at = at
        settled.append(lot)
    return settled


def exposure_by_market(lots: list[StrategyLot]) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for lot in lots:
        if lot.status != STATUS_OPEN:
            continue
        out[lot.condition_id] = out.get(lot.condition_id, ZERO) + lot.cost_basis
    return out


def exposure_by_cluster(lots: list[StrategyLot]) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for lot in lots:
        if lot.status != STATUS_OPEN:
            continue
        key = lot.source_cluster_key or lot.source_wallet
        out[key] = out.get(key, ZERO) + lot.cost_basis
    return out
