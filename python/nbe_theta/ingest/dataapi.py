"""Polymarket Data API client + parsing.

The Data API (``https://data-api.polymarket.com``) is the wallet-history
and discovery surface: per-wallet trades/activity/positions, per-market
top holders, and leaderboards. Like the Gamma client this depends on the
``Fetcher`` seam (no live calls in unit tests) and parses defensively —
the API has no published stable schema and field names drift.

Trades have no stable server id, so we synthesize a canonical dedupe
id (``source_trade_id``) from the stable economic fields. Re-fetching an
overlapping window therefore upserts the same row rather than duplicating
it — the property the cursor-restart test relies on.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from nbe_theta.common.http import Fetcher

PARSER_VERSION = "data-api-1"
VENUE = "polymarket"
CHAIN_ID = 137  # Polygon


@dataclass(frozen=True)
class ParsedTrade:
    source_trade_id: str
    wallet: str
    condition_id: str
    outcome_token_id: str
    side: str  # BUY | SELL
    price: Decimal
    quantity: Decimal
    notional: Decimal
    occurred_at: datetime
    tx_hash: str | None
    maker_taker: str | None


@dataclass(frozen=True)
class LeaderboardEntry:
    wallet: str
    metric: str  # 'pnl' | 'volume'
    amount: Decimal


@dataclass(frozen=True)
class HolderEntry:
    wallet: str
    condition_id: str
    outcome_token_id: str | None
    shares: Decimal


# ── shared coercion ───────────────────────────────────────────────


def _dec(v: Any) -> Decimal | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _dt_from_unix(v: Any) -> datetime | None:
    """Data API timestamps are unix seconds (sometimes as strings)."""

    if v is None or isinstance(v, bool):
        return None
    try:
        secs = int(float(v))
    except (ValueError, TypeError):
        return None
    if secs <= 0:
        return None
    return datetime.fromtimestamp(secs, tz=UTC)


def _addr(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip().lower()
    return s or None


def _side(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip().upper()
    return s if s in {"BUY", "SELL"} else None


def _synthesize_trade_id(
    wallet: str,
    condition_id: str,
    outcome_token_id: str,
    side: str,
    price: Decimal,
    quantity: Decimal,
    occurred_at: datetime,
    tx_hash: str | None,
) -> str:
    """Deterministic id over the stable economic fields. Includes the tx
    hash when present (distinguishes same-price/size fills in one block);
    without it, the timestamp+size+price triple is the best available
    natural key."""

    basis = json.dumps(
        {
            "w": wallet,
            "c": condition_id,
            "o": outcome_token_id,
            "s": side,
            "p": format(price, "f"),
            "q": format(quantity, "f"),
            "t": int(occurred_at.timestamp()),
            "tx": tx_hash or "",
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


# ── parsers ───────────────────────────────────────────────────────


def parse_trade(raw: dict[str, Any]) -> ParsedTrade | None:
    wallet = _addr(raw.get("proxyWallet") or raw.get("wallet") or raw.get("user"))
    condition_id = raw.get("conditionId") or raw.get("condition_id")
    token = raw.get("asset") or raw.get("outcomeTokenId") or raw.get("token_id")
    side = _side(raw.get("side"))
    price = _dec(raw.get("price"))
    size = _dec(raw.get("size") or raw.get("quantity") or raw.get("shares"))
    ts = _dt_from_unix(raw.get("timestamp") or raw.get("occurredAt") or raw.get("matchTime"))

    if not wallet or not condition_id or not token or side is None or price is None or size is None:
        return None
    if ts is None or price < 0 or size <= 0:
        return None

    tx_hash = raw.get("transactionHash") or raw.get("txHash") or raw.get("tx_hash")
    tx_hash = tx_hash.strip().lower() if isinstance(tx_hash, str) and tx_hash.strip() else None
    mt = raw.get("makerTaker") or raw.get("maker_taker")
    maker_taker = mt if mt in {"maker", "taker"} else None

    notional = (price * size).quantize(Decimal("1.0000000000"))
    sid = _synthesize_trade_id(
        wallet, str(condition_id), str(token), side, price, size, ts, tx_hash
    )
    return ParsedTrade(
        source_trade_id=sid,
        wallet=wallet,
        condition_id=str(condition_id),
        outcome_token_id=str(token),
        side=side,
        price=price,
        quantity=size,
        notional=notional,
        occurred_at=ts,
        tx_hash=tx_hash,
        maker_taker=maker_taker,
    )


def parse_leaderboard_entry(raw: dict[str, Any], metric: str) -> LeaderboardEntry | None:
    wallet = _addr(raw.get("proxyWallet") or raw.get("wallet") or raw.get("user"))
    amount = _dec(raw.get("amount") or raw.get("value") or raw.get("pnl") or raw.get("vol"))
    if not wallet or amount is None:
        return None
    return LeaderboardEntry(wallet=wallet, metric=metric, amount=amount)


def parse_holder(raw: dict[str, Any], condition_id: str) -> HolderEntry | None:
    wallet = _addr(raw.get("proxyWallet") or raw.get("wallet") or raw.get("user"))
    shares = _dec(raw.get("amount") or raw.get("shares") or raw.get("balance"))
    if not wallet or shares is None:
        return None
    token = raw.get("asset") or raw.get("outcomeTokenId") or raw.get("token_id")
    return HolderEntry(
        wallet=wallet,
        condition_id=condition_id,
        outcome_token_id=str(token) if token else None,
        shares=shares,
    )


# ── client ────────────────────────────────────────────────────────


class DataApiClient:
    """Data API access over the Fetcher seam."""

    def __init__(self, fetcher: Fetcher, page_limit: int = 100) -> None:
        self._fetcher = fetcher
        self._page_limit = page_limit

    def leaderboard(self, window: str, order_by: str, limit: int = 100) -> list[LeaderboardEntry]:
        raw, _ = self._fetcher.get_page(
            "/leaderboard", {"window": window, "orderBy": order_by, "limit": limit}
        )
        rows = raw if isinstance(raw, list) else []
        out: list[LeaderboardEntry] = []
        for r in rows:
            if isinstance(r, dict):
                e = parse_leaderboard_entry(r, metric=order_by)
                if e is not None:
                    out.append(e)
        return out

    def holders(self, condition_id: str, limit: int = 100) -> list[HolderEntry]:
        raw, _ = self._fetcher.get_page("/holders", {"market": condition_id, "limit": limit})
        rows = raw if isinstance(raw, list) else []
        out: list[HolderEntry] = []
        for r in rows:
            if isinstance(r, dict):
                h = parse_holder(r, condition_id)
                if h is not None:
                    out.append(h)
        return out

    def iter_trades(
        self, wallet: str, start_offset: int = 0, max_pages: int = 0
    ) -> Iterator[tuple[int, list[ParsedTrade], bytes, int]]:
        """Yield (offset, parsed_trades, raw_bytes, raw_row_count) per page,
        newest-first, offset-paginated. A short page ends the sweep."""

        offset = start_offset
        pages = 0
        while True:
            if max_pages and pages >= max_pages:
                return
            params = {"user": wallet, "limit": self._page_limit, "offset": offset}
            raw, raw_bytes = self._fetcher.get_page("/trades", params)
            rows = raw if isinstance(raw, list) else []
            trades = [parse_trade(r) for r in rows if isinstance(r, dict)]
            parsed = [t for t in trades if t is not None]
            yield offset, parsed, raw_bytes, len(rows)
            pages += 1
            if len(rows) < self._page_limit:
                return
            offset += self._page_limit
