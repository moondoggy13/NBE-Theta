"""Wallet-intelligence payloads.

Mirrors the ``venue_trades`` (007) and ``wallet_positions`` (011)
tables. Anything the wallet-activity ingestors (`theta-wallet-backfill`,
`theta-live-monitor`) write must validate against these types first —
the same producer-side gate the registry ingestor applies to
Event/Market/Outcome.

These are OBSERVATIONS of other wallets, not our own account state —
which is why they live apart from ``VenuePosition``/``VenueFill``
(executor-owned truth). ``VenueTrade.side`` is the observed wallet's
side, from its own perspective.
"""

from typing import Literal
from uuid import UUID

from pydantic import Field

from nbe_theta_contracts.common import (
    ContractBase,
    DecimalStr,
    NonNegativeDecimalStr,
    PositiveDecimalStr,
    Side,
    UnitIntervalStr,
    UnitPriceStr,
    UtcDatetime,
    Venue,
)

# Polygon address, lowercased by the ingest layer before validation so a
# checksum-cased and lowercase report of the same wallet can never split
# into two identities.
_ADDRESS_PATTERN = r"^0x[0-9a-f]{40}$"


class VenueTrade(ContractBase):
    """One observed trade by a tracked (or candidate) wallet.

    ``source_trade_id`` is the venue's stable id where one exists; the
    Data API exposes none for /trades rows, so the ingest layer
    synthesizes a canonical content hash — either way it is unique per
    venue and is the dedupe key (``unique (venue, source_trade_id)``).
    """

    venue: Venue
    source_trade_id: str = Field(..., min_length=1)
    wallet: str = Field(..., pattern=_ADDRESS_PATTERN)
    condition_id: str = Field(..., min_length=1)
    outcome_token_id: str = Field(..., min_length=1)
    side: Side
    price: UnitPriceStr = Field(..., gt=0, le=1)
    quantity: PositiveDecimalStr = Field(..., gt=0)
    notional: NonNegativeDecimalStr = Field(..., ge=0)
    occurred_at: UtcDatetime
    tx_hash: str | None = None
    maker_taker: Literal["maker", "taker"] | None = None
    raw_object_id: UUID | None = None


class WalletPositionSnapshot(ContractBase):
    """A tracked wallet's current holding of one outcome token.

    Snapshot semantics: the ingest layer replaces a wallet's full row
    set on each refresh, so consumers treat ``captured_at`` as the
    as-of time and absence as "no longer held". P&L fields are signed
    (losses are negative); prices are [0, 1] marks — a resolved-losing
    token legitimately marks at exactly 0.
    """

    venue: Venue
    wallet: str = Field(..., pattern=_ADDRESS_PATTERN)
    condition_id: str = Field(..., min_length=1)
    outcome_token_id: str = Field(..., min_length=1)
    outcome_name: str | None = None
    outcome_index: int | None = Field(default=None, ge=0)
    size: NonNegativeDecimalStr = Field(..., ge=0)
    avg_price: UnitIntervalStr | None = Field(default=None, ge=0, le=1)
    cur_price: UnitIntervalStr | None = Field(default=None, ge=0, le=1)
    initial_value: NonNegativeDecimalStr | None = Field(default=None, ge=0)
    current_value: NonNegativeDecimalStr | None = Field(default=None, ge=0)
    cash_pnl: DecimalStr | None = None
    percent_pnl: DecimalStr | None = None
    realized_pnl: DecimalStr | None = None
    total_bought: NonNegativeDecimalStr | None = Field(default=None, ge=0)
    redeemable: bool = False
    neg_risk: bool = False
    title: str | None = None
    slug: str | None = None
    event_slug: str | None = None
    end_date: UtcDatetime | None = None
    captured_at: UtcDatetime
