"""Position / account payloads."""

from decimal import Decimal
from typing import Literal

from pydantic import Field

from nbe_theta_contracts.common import ContractBase, DecimalStr, NonNegativeDecimalStr, Venue


class VenuePosition(ContractBase):
    """A per-outcome inventory row on a venue.

    ``shares`` is the signed inventory: positive = long the outcome,
    negative = short it (Polymarket doesn't currently support short but
    the shape stays neutral).
    ``cost_basis`` is total dollars in for the current inventory;
    combined with the last mid it produces unrealized P&L for the
    dashboard.
    """

    venue: Venue
    account_id: str = Field(..., min_length=1)
    condition_id: str = Field(..., min_length=1)
    outcome_token_id: str = Field(..., min_length=1)
    shares: DecimalStr
    cost_basis: NonNegativeDecimalStr = Field(default=Decimal("0"), ge=Decimal("0"))


class VenueAccountState(ContractBase):
    """Executor's known state of one venue account.

    ``collateral_balance`` is available margin / USDC. ``open_intent_count``
    lets the risk engine reserve for in-flight orders.
    """

    venue: Venue
    account_id: str = Field(..., min_length=1)
    collateral_balance: NonNegativeDecimalStr = Field(..., ge=Decimal("0"))
    open_intent_count: int = Field(..., ge=0)
    open_order_count: int = Field(..., ge=0)
    connectivity: Literal["ok", "degraded", "down"] = "ok"
