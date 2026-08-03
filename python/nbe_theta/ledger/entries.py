"""Ledger entry construction.

Turns normalized `venue_trades` rows into signed share/cash/fee deltas —
the double-entry-ish primitive everything downstream reconstructs from.

Sign convention (from the wallet's perspective):
  BUY  → shares in  (+share_delta), cash out (-cash_delta)
  SELL → shares out (-share_delta), cash in  (+cash_delta)

Fees are stored separately (always ≥ 0) rather than folded into cash so
that gross vs net economics stay separable — the skill metrics need
both (a wallet that is only profitable pre-fee is not profitable).

Idempotence is the DB's job: `unique (source_type, source_id, wallet,
outcome_token_id, entry_type)` means re-deriving the ledger from the
same trades can never double-count. That property is what lets the
builder be re-run freely as new trades land.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

SOURCE_TYPE_VENUE_TRADE = "venue_trade"

# Ledger entry types. Only buy/sell are derivable from Data API trades;
# transfer/split/merge/redeem require the chain indexer (PR 7) and are
# declared here so the vocabulary is fixed in one place.
ENTRY_BUY = "buy"
ENTRY_SELL = "sell"
ENTRY_TRANSFER_IN = "transfer_in"
ENTRY_TRANSFER_OUT = "transfer_out"
ENTRY_SPLIT = "split"
ENTRY_MERGE = "merge"
ENTRY_REDEEM = "redeem"

# Cost-basis quality. Trades give exact basis; inventory that arrives by
# transfer has unknowable basis until the chain layer resolves it, and
# marking that explicitly keeps unearned precision out of the metrics.
QUALITY_EXACT = "exact"
QUALITY_ESTIMATED = "estimated"
QUALITY_UNKNOWN = "unknown"


@dataclass(frozen=True)
class LedgerEntry:
    wallet: str
    condition_id: str
    outcome_token_id: str
    occurred_at: datetime
    entry_type: str
    share_delta: Decimal
    cash_delta: Decimal
    fee_delta: Decimal
    source_type: str
    source_id: str
    cost_basis_quality: str = QUALITY_EXACT


@dataclass(frozen=True)
class TradeRow:
    """A `venue_trades` row, as the ledger builder consumes it."""

    source_trade_id: str
    wallet: str
    condition_id: str
    outcome_token_id: str
    side: str  # BUY | SELL
    price: Decimal
    quantity: Decimal
    notional: Decimal
    occurred_at: datetime
    fee: Decimal = Decimal("0")


def entry_from_trade(trade: TradeRow) -> LedgerEntry:
    """One trade → one ledger entry, with the wallet-perspective signs."""

    is_buy = trade.side.upper() == "BUY"
    shares = trade.quantity if is_buy else -trade.quantity
    # notional is always positive; direction of cash is the inverse of shares.
    cash = -trade.notional if is_buy else trade.notional
    return LedgerEntry(
        wallet=trade.wallet,
        condition_id=trade.condition_id,
        outcome_token_id=trade.outcome_token_id,
        occurred_at=trade.occurred_at,
        entry_type=ENTRY_BUY if is_buy else ENTRY_SELL,
        share_delta=shares,
        cash_delta=cash,
        fee_delta=trade.fee,
        source_type=SOURCE_TYPE_VENUE_TRADE,
        source_id=trade.source_trade_id,
        cost_basis_quality=QUALITY_EXACT,
    )


def entries_from_trades(trades: list[TradeRow]) -> list[LedgerEntry]:
    return [entry_from_trade(t) for t in trades]
