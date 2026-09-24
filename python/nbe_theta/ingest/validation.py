"""Contract validation at the ingest boundary.

``packages/contracts`` is the source of truth for durable payloads, and
AGENTS.md requires every consumer to validate against it. This module is
the single place the ingest layer does that, so the backfill and the
live monitor — which write the SAME ``venue_trades`` rows — cannot drift
into validating differently (or one of them not validating at all).

A row that fails validation is logged and dropped, never written: a
malformed row in a normalized table is worse than a missing one, because
everything downstream (ledger reconstruction, wallet scoring, the alpha
gate) treats these tables as already-clean.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from nbe_theta_contracts import VenueTrade, WalletPositionSnapshot
from pydantic import ValidationError

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.dataapi import ParsedTrade
from nbe_theta.ingest.positions import ParsedPosition

log = get_logger("ingest.validation")

# dataapi.VENUE is a plain str; the contracts need the Literal so the
# producer side is checked as strictly as the wire schema.
VENUE: Literal["polymarket"] = "polymarket"


def validate_trade(t: ParsedTrade, raw_object_id: uuid.UUID) -> bool:
    """True if this trade satisfies the VenueTrade contract."""

    try:
        VenueTrade(
            venue=VENUE,
            source_trade_id=t.source_trade_id,
            wallet=t.wallet,
            condition_id=t.condition_id,
            outcome_token_id=t.outcome_token_id,
            side=t.side,  # type: ignore[arg-type]
            price=t.price,
            quantity=t.quantity,
            notional=t.notional,
            occurred_at=t.occurred_at,
            tx_hash=t.tx_hash,
            maker_taker=t.maker_taker,  # type: ignore[arg-type]
            raw_object_id=raw_object_id,
        )
    except ValidationError as e:
        log.warning("trade failed contract validation", trade=t.source_trade_id, error=str(e))
        return False
    return True


def validate_position(p: ParsedPosition, captured_at: datetime) -> bool:
    """True if this position satisfies the WalletPositionSnapshot contract."""

    try:
        WalletPositionSnapshot(
            venue=VENUE,
            wallet=p.wallet,
            condition_id=p.condition_id,
            outcome_token_id=p.outcome_token_id,
            outcome_name=p.outcome_name,
            outcome_index=p.outcome_index,
            size=p.size,
            avg_price=p.avg_price,
            cur_price=p.cur_price,
            initial_value=p.initial_value,
            current_value=p.current_value,
            cash_pnl=p.cash_pnl,
            percent_pnl=p.percent_pnl,
            realized_pnl=p.realized_pnl,
            total_bought=p.total_bought,
            redeemable=p.redeemable,
            neg_risk=p.neg_risk,
            title=p.title,
            slug=p.slug,
            event_slug=p.event_slug,
            end_date=p.end_date,
            captured_at=captured_at,
        )
    except ValidationError as e:
        log.warning(
            "position failed contract validation",
            wallet=p.wallet,
            token=p.outcome_token_id,
            error=str(e),
        )
        return False
    return True
