"""Data API parser tests: coercion edges + dedupe-id synthesis."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from nbe_theta.ingest.dataapi import (
    parse_holder,
    parse_leaderboard_entry,
    parse_trade,
)


def _raw(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "proxyWallet": "0xABC0000000000000000000000000000000000001",
        "conditionId": "0xcond",
        "asset": "tok1",
        "side": "BUY",
        "price": "0.43",
        "size": "250",
        "timestamp": 1814227200,
        "transactionHash": "0xTX",
    }
    base.update(over)
    return base


def test_trade_parses_and_lowercases_addresses() -> None:
    t = parse_trade(_raw())
    assert t is not None
    assert t.wallet == "0xabc0000000000000000000000000000000000001"
    assert t.tx_hash == "0xtx"
    assert t.price == Decimal("0.43")
    assert t.quantity == Decimal("250")
    # notional = price * size
    assert t.notional == Decimal("107.5000000000")
    assert t.occurred_at.tzinfo is not None


def test_trade_id_is_deterministic_for_identical_input() -> None:
    a = parse_trade(_raw())
    b = parse_trade(_raw())
    assert a is not None and b is not None
    assert a.source_trade_id == b.source_trade_id


def test_trade_id_differs_when_an_economic_field_differs() -> None:
    base = parse_trade(_raw())
    other = parse_trade(_raw(size="251"))
    assert base is not None and other is not None
    assert base.source_trade_id != other.source_trade_id


def test_trade_id_differs_across_tx_hashes() -> None:
    a = parse_trade(_raw(transactionHash="0xAAA"))
    b = parse_trade(_raw(transactionHash="0xBBB"))
    assert a is not None and b is not None
    assert a.source_trade_id != b.source_trade_id


def test_trade_accepts_alternate_field_names() -> None:
    t = parse_trade(
        {
            "wallet": "0xdef0000000000000000000000000000000000002",
            "condition_id": "0xc2",
            "token_id": "tok2",
            "side": "sell",
            "price": 0.5,
            "quantity": 10,
            "occurredAt": 1814227200,
        }
    )
    assert t is not None
    assert t.side == "SELL"
    assert t.outcome_token_id == "tok2"


def test_trade_dropped_when_required_fields_missing_or_invalid() -> None:
    assert parse_trade(_raw(proxyWallet=None)) is None
    assert parse_trade(_raw(conditionId=None)) is None
    assert parse_trade(_raw(side="HOLD")) is None
    assert parse_trade(_raw(size="0")) is None
    assert parse_trade(_raw(timestamp=0)) is None
    assert parse_trade(_raw(price="not-a-number")) is None


def test_leaderboard_entry_parsing() -> None:
    e = parse_leaderboard_entry({"proxyWallet": "0xAbC", "amount": "100.5"}, metric="pnl")
    assert e is not None
    assert e.wallet == "0xabc"
    assert e.amount == Decimal("100.5")
    assert parse_leaderboard_entry({"amount": "1"}, metric="pnl") is None


def test_holder_parsing() -> None:
    h = parse_holder({"proxyWallet": "0xAbC", "asset": "tok", "amount": "500"}, "0xcond")
    assert h is not None
    assert h.condition_id == "0xcond"
    assert h.shares == Decimal("500")
    assert parse_holder({"amount": "1"}, "0xcond") is None
