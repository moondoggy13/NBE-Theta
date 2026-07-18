"""Order-side payloads.

The executor's public surface. Wire types the strategy → outbox →
executor → venue chain must all agree on.

Money handling:

- All prices, quantities, notionals and fees are ``Decimal`` serialized
  as JSON *strings* — Pydantic v2's default. This avoids float drift
  the moment we do anything (fee application, cost basis, notional
  caps) and matches what the CLOB API accepts.
- Consumers on the TS side validate via a ``decimal`` string format
  regex (see ``packages/contracts/src/validators.ts``).
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import Field

from nbe_theta_contracts.common import (
    ContractBase,
    DecimalStr,
    IntentStrategyType,
    OrderStatus,
    Side,
    TimeInForce,
    Venue,
)
from nbe_theta_contracts.markets import OutcomeInstrument


class OrderIntent(ContractBase):
    """The venue-neutral intent the executor consumes from the outbox.

    Limit orders are the wire primitive — there is no market order.
    An immediate purchase is a marketable limit with an explicit
    ``limit_price`` (the executor's max acceptable price).

    ``expiration`` is only meaningful for ``time_in_force == "GTD"``;
    consumers ignore it otherwise. ``expires_at`` is separate: it's the
    signal-freshness deadline used by the pre-order risk check.
    """

    intent_id: UUID
    venue: Venue
    account_id: str = Field(..., min_length=1)
    instrument: OutcomeInstrument
    side: Side
    quantity: DecimalStr = Field(..., gt=Decimal("0"))
    limit_price: DecimalStr = Field(..., gt=Decimal("0"), le=Decimal("1"))
    time_in_force: TimeInForce
    expiration: datetime | None = None
    post_only: bool = False
    strategy_type: IntentStrategyType
    signal_id: UUID
    expires_at: datetime


class ExecutionReport(ContractBase):
    """Immediate response to a submitIntent call.

    ``venue_order_id`` is present if the venue accepted the order and
    returned an id. ``status`` is the current known state — ``live`` /
    ``rejected`` / ``partially_filled`` / etc.
    """

    intent_id: UUID
    venue_order_id: str | None = None
    status: OrderStatus
    submitted_at: datetime
    reason: str | None = Field(
        default=None,
        description="Rejection reason from the venue or the executor's risk gate.",
    )


class VenueOrder(ContractBase):
    """Executor-side snapshot of an order as we currently believe it."""

    venue_order_id: str = Field(..., min_length=1)
    client_intent_id: UUID
    venue: Venue
    account_id: str = Field(..., min_length=1)
    instrument: OutcomeInstrument
    side: Side
    quantity: DecimalStr = Field(..., gt=Decimal("0"))
    limit_price: DecimalStr = Field(..., gt=Decimal("0"), le=Decimal("1"))
    time_in_force: TimeInForce
    status: OrderStatus
    filled_quantity: DecimalStr = Field(default=Decimal("0"), ge=Decimal("0"))
    fees_paid: DecimalStr = Field(default=Decimal("0"), ge=Decimal("0"))
    created_at: datetime
    updated_at: datetime


class VenueOrderEvent(ContractBase):
    """One row in the append-only ``venue_order_events`` table.

    Never rewrite an order row to erase history — write a new event and
    project the current-state read model off events.
    """

    id: UUID
    venue_order_id: str = Field(..., min_length=1)
    event_type: Literal[
        "submitted",
        "acknowledged",
        "partial_fill",
        "fill",
        "cancel_requested",
        "canceled",
        "rejected",
        "expired",
    ]
    occurred_at: datetime
    payload: dict[str, str] = Field(
        default_factory=dict,
        description="Free-form event payload; keys/values are strings for wire stability.",
    )


class VenueFill(ContractBase):
    """One fill against a venue order."""

    venue_order_id: str = Field(..., min_length=1)
    venue_fill_id: str = Field(..., min_length=1)
    occurred_at: datetime
    price: DecimalStr = Field(..., gt=Decimal("0"), le=Decimal("1"))
    quantity: DecimalStr = Field(..., gt=Decimal("0"))
    fee: DecimalStr = Field(..., ge=Decimal("0"))
    liquidity: Literal["maker", "taker"]
