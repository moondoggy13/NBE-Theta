"""Data API positions: current holdings of a tracked wallet.

Complements ``dataapi.DataApiClient`` (trades / leaderboard / holders)
with the ``/positions`` surface, which the live monitor snapshots on a
cadence. Kept in its own module so the backfill path — which only needs
trades — is unaffected.

Snapshot semantics: the store replaces a wallet's full row set per
refresh, so a row's ABSENCE means "no longer held as of captured_at".
No tombstones, no partial merges.

Parsing follows the same defensive contract as ``dataapi``: numbers may
arrive as JSON numbers or strings, and marks outside [0, 1] are dropped
to None rather than persisted as nonsense (a resolved-losing token
legitimately marks at exactly 0, which is why the bound is closed).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from nbe_theta.common.http import Fetcher
from nbe_theta.ingest.dataapi import _addr, _dec

PARSER_VERSION = "data-api-positions-1"


@dataclass(frozen=True)
class ParsedPosition:
    wallet: str
    condition_id: str
    outcome_token_id: str
    outcome_name: str | None
    outcome_index: int | None
    size: Decimal
    avg_price: Decimal | None
    cur_price: Decimal | None
    initial_value: Decimal | None
    current_value: Decimal | None
    cash_pnl: Decimal | None
    percent_pnl: Decimal | None
    realized_pnl: Decimal | None
    total_bought: Decimal | None
    redeemable: bool
    neg_risk: bool
    title: str | None
    slug: str | None
    event_slug: str | None
    end_date: datetime | None


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes"}
    return bool(v)


def _as_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, (str, float)):
        try:
            return int(float(v))
        except (ValueError, OverflowError):
            return None
    return None


def _as_str(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _parse_iso(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v.strip():
        return None
    s = v.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(UTC)


def _unit(v: Any) -> Decimal | None:
    """A [0, 1] mark, or None when absent/out of range."""

    d = _dec(v)
    if d is None or d < 0 or d > 1:
        return None
    return d


def parse_position(raw: dict[str, Any], wallet_hint: str | None = None) -> ParsedPosition | None:
    wallet = _addr(raw.get("proxyWallet")) or (_addr(wallet_hint) if wallet_hint else None)
    condition_id = raw.get("conditionId") or raw.get("condition_id")
    token = raw.get("asset") or raw.get("outcomeTokenId") or raw.get("token_id")
    size = _dec(raw.get("size") or raw.get("shares"))
    if not wallet or not condition_id or not token or size is None or size < 0:
        return None

    return ParsedPosition(
        wallet=wallet,
        condition_id=str(condition_id),
        outcome_token_id=str(token),
        outcome_name=_as_str(raw.get("outcome")),
        outcome_index=_as_int(raw.get("outcomeIndex")),
        size=size,
        avg_price=_unit(raw.get("avgPrice")),
        cur_price=_unit(raw.get("curPrice")),
        initial_value=_dec(raw.get("initialValue")),
        current_value=_dec(raw.get("currentValue")),
        cash_pnl=_dec(raw.get("cashPnl")),
        percent_pnl=_dec(raw.get("percentPnl")),
        realized_pnl=_dec(raw.get("realizedPnl")),
        total_bought=_dec(raw.get("totalBought")),
        redeemable=_as_bool(raw.get("redeemable")),
        neg_risk=_as_bool(raw.get("negativeRisk")),
        title=_as_str(raw.get("title")),
        slug=_as_str(raw.get("slug")),
        event_slug=_as_str(raw.get("eventSlug")),
        end_date=_parse_iso(raw.get("endDate")),
    )


def parse_positions_page(raw: Any, wallet_hint: str | None = None) -> list[ParsedPosition]:
    rows = raw if isinstance(raw, list) else []
    out: list[ParsedPosition] = []
    for r in rows:
        if isinstance(r, dict):
            p = parse_position(r, wallet_hint)
            if p is not None:
                out.append(p)
    return out


class PositionsClient:
    """Offset-paginated ``/positions`` reader over the Fetcher seam."""

    def __init__(self, fetcher: Fetcher, page_limit: int = 100) -> None:
        self._fetcher = fetcher
        self._page_limit = page_limit

    def iter_positions(
        self, wallet: str, max_pages: int = 0
    ) -> Iterator[tuple[int, list[ParsedPosition], bytes, int]]:
        """Yield (offset, parsed, raw_bytes, raw_row_count) per page. A
        short page ends the sweep — same convention as ``iter_trades``."""

        offset = 0
        pages = 0
        while True:
            if max_pages and pages >= max_pages:
                return
            params = {"user": wallet, "limit": self._page_limit, "offset": offset}
            raw, raw_bytes = self._fetcher.get_page("/positions", params)
            rows = raw if isinstance(raw, list) else []
            yield offset, parse_positions_page(rows, wallet), raw_bytes, len(rows)
            pages += 1
            if len(rows) < self._page_limit:
                return
            offset += self._page_limit
