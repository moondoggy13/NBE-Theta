"""Gamma API client + response parsing.

Polymarket's Gamma API (``https://gamma-api.polymarket.com``) is the
market-discovery surface. We sweep ``/events`` because it nests full
market objects — one paginated pass yields events, their markets, and
outcome tokens together, already grouped.

Parsing is deliberately DEFENSIVE. Gamma has no published stable
schema; fields come and go and several are JSON-encoded strings
(``outcomes``, ``clobTokenIds`` arrive as ``"[\\"Yes\\", \\"No\\"]"``).
Every raw page is archived (see ``registry``) so that if the shape
shifts we can re-parse historical data with a newer parser version
rather than having lost it.

``PARSER_VERSION`` is stamped into every ``raw_objects`` row; bump it
when the parsing logic changes in a way that would produce different
normalized rows from the same bytes.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from nbe_theta.common.http import Fetcher

PARSER_VERSION = "gamma-registry-1"

# Typed as the contracts' Venue literal so it satisfies Event/Market/
# Outcome(venue=...) without a cast.
VENUE: Literal["polymarket"] = "polymarket"


@dataclass(frozen=True)
class ParsedOutcome:
    outcome_index: int
    outcome_name: str
    outcome_token_id: str
    # Settled payoff (0 or 1), captured ONLY for resolved markets. For an
    # active market Gamma's `outcomePrices` is the current mid, which is
    # not a settlement — recording it as one would corrupt every skill
    # metric downstream, so it stays None until the market resolves.
    resolution_price: Decimal | None = None


@dataclass(frozen=True)
class ParsedMarket:
    venue_market_id: str
    venue_event_id: str
    condition_id: str
    question: str
    neg_risk: bool
    active: bool
    closed: bool
    resolved: bool
    opened_at: datetime
    closes_at: datetime | None
    resolved_at: datetime | None
    resolution_source: str | None
    description: str | None
    outcomes: list[ParsedOutcome]


@dataclass(frozen=True)
class ParsedEvent:
    venue_event_id: str
    title: str
    category: str | None
    opened_at: datetime
    closes_at: datetime | None
    status: str  # active | closed | resolved
    markets: list[ParsedMarket] = field(default_factory=list)


@dataclass(frozen=True)
class GammaPage:
    """One archived page: the parsed events plus the raw bytes to store."""

    events: list[ParsedEvent]
    raw_bytes: bytes
    row_count: int


# ── parsing helpers ───────────────────────────────────────────────


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes"}
    return bool(v)


def _parse_dt(v: Any) -> datetime | None:
    """Parse an ISO-8601 timestamp to an aware UTC datetime, else None."""

    if not v or not isinstance(v, str):
        return None
    s = v.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _decode_str_array(v: Any) -> list[str]:
    """Gamma encodes arrays as JSON strings. Accept both the encoded
    string and an already-decoded list."""

    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        try:
            decoded = json.loads(s)
        except json.JSONDecodeError:
            return []
        if isinstance(decoded, list):
            return [str(x) for x in decoded]
    return []


def parse_outcomes(raw_market: dict[str, Any], resolved: bool = False) -> list[ParsedOutcome]:
    """Zip outcome names with clob token ids into outcome rows.

    If the two arrays disagree in length (or token ids are absent), we
    keep whatever pairs up cleanly and drop the rest — a partial row is
    worse than a missing one for a token-id-keyed table.
    """

    names = _decode_str_array(raw_market.get("outcomes"))
    token_ids = _decode_str_array(raw_market.get("clobTokenIds"))
    prices = _decode_str_array(raw_market.get("outcomePrices")) if resolved else []
    out: list[ParsedOutcome] = []
    for i, name in enumerate(names):
        if i >= len(token_ids):
            break
        token = token_ids[i]
        if not token:
            continue
        price: Decimal | None = None
        if i < len(prices):
            candidate: Decimal | None
            try:
                candidate = Decimal(prices[i])
            except (InvalidOperation, ValueError):
                candidate = None
            # A settled binary outcome pays 0 or 1. Anything outside
            # [0,1] is not a settlement we understand — drop it rather
            # than persist a number the scorer would trust.
            if candidate is not None and Decimal("0") <= candidate <= Decimal("1"):
                price = candidate
        out.append(
            ParsedOutcome(
                outcome_index=i,
                outcome_name=name,
                outcome_token_id=token,
                resolution_price=price,
            )
        )
    return out


def _market_resolved(raw: dict[str, Any]) -> bool:
    if "resolved" in raw:
        return _as_bool(raw.get("resolved"))
    uma = raw.get("umaResolutionStatus")
    if isinstance(uma, str):
        return uma.strip().lower() == "resolved"
    return False


def parse_market(raw: dict[str, Any], venue_event_id: str) -> ParsedMarket | None:
    """Parse one raw market dict. Returns None if it lacks the identity
    fields we key on (id, conditionId) — such rows are unusable."""

    market_id = raw.get("id")
    condition_id = raw.get("conditionId")
    question = raw.get("question")
    if not market_id or not condition_id or not question:
        return None

    resolved = _market_resolved(raw)
    opened = _parse_dt(raw.get("startDate")) or _parse_dt(raw.get("createdAt"))
    if opened is None:
        # A market with no discernible open time is still worth keeping;
        # anchor to epoch-unknown via createdAt fallback already tried,
        # so use "now" is wrong for history — skip instead.
        return None

    return ParsedMarket(
        venue_market_id=str(market_id),
        venue_event_id=venue_event_id,
        condition_id=str(condition_id),
        question=str(question),
        neg_risk=_as_bool(raw.get("negRisk")),
        active=_as_bool(raw.get("active")),
        closed=_as_bool(raw.get("closed")),
        resolved=resolved,
        opened_at=opened,
        closes_at=_parse_dt(raw.get("endDate")),
        resolved_at=_parse_dt(raw.get("updatedAt")) if resolved else None,
        resolution_source=(raw.get("resolutionSource") or None),
        description=(raw.get("description") or None),
        outcomes=parse_outcomes(raw, resolved=resolved),
    )


def _event_category(raw: dict[str, Any]) -> str | None:
    cat = raw.get("category")
    if isinstance(cat, str) and cat.strip():
        return cat.strip()
    tags = raw.get("tags")
    if isinstance(tags, list) and tags:
        first = tags[0]
        if isinstance(first, dict):
            label = first.get("label") or first.get("slug")
            if isinstance(label, str) and label.strip():
                return label.strip()
        elif isinstance(first, str) and first.strip():
            return first.strip()
    return None


def _event_status(raw: dict[str, Any], markets: list[ParsedMarket]) -> str:
    if _as_bool(raw.get("closed")):
        # Closed + every market resolved → resolved; else just closed.
        if markets and all(m.resolved for m in markets):
            return "resolved"
        return "closed"
    return "active"


def parse_event(raw: dict[str, Any]) -> ParsedEvent | None:
    """Parse one raw event (with nested markets). None if unusable."""

    event_id = raw.get("id")
    title = raw.get("title")
    if not event_id or not title:
        return None
    opened = _parse_dt(raw.get("startDate")) or _parse_dt(raw.get("createdAt"))
    if opened is None:
        return None

    raw_markets = raw.get("markets")
    markets: list[ParsedMarket] = []
    if isinstance(raw_markets, list):
        for rm in raw_markets:
            if isinstance(rm, dict):
                pm = parse_market(rm, venue_event_id=str(event_id))
                if pm is not None:
                    markets.append(pm)

    return ParsedEvent(
        venue_event_id=str(event_id),
        title=str(title),
        category=_event_category(raw),
        opened_at=opened,
        closes_at=_parse_dt(raw.get("endDate")),
        status=_event_status(raw, markets),
        markets=markets,
    )


def parse_page(raw_json: Any) -> list[ParsedEvent]:
    """Parse a raw ``/events`` page (a JSON array of events)."""

    if not isinstance(raw_json, list):
        return []
    events: list[ParsedEvent] = []
    for item in raw_json:
        if isinstance(item, dict):
            ev = parse_event(item)
            if ev is not None:
                events.append(ev)
    return events


# ── client ────────────────────────────────────────────────────────


class GammaClient:
    """Paginates the Gamma ``/events`` endpoint.

    Offset pagination ordered by ``id`` ascending. A page shorter than
    ``page_limit`` marks the end of the sweep. Each yielded ``GammaPage``
    carries the raw bytes so the caller can archive them.
    """

    def __init__(self, fetcher: Fetcher, page_limit: int = 100) -> None:
        self._fetcher = fetcher
        self._page_limit = page_limit

    def iter_events(
        self, start_offset: int = 0, max_pages: int = 0
    ) -> Iterator[tuple[int, GammaPage]]:
        """Yield (offset, page) tuples starting at ``start_offset``.

        ``max_pages`` of 0 means unbounded (to the end of the sweep).
        The offset yielded is the offset the page was fetched AT, so a
        caller persisting it as the cursor resumes by re-fetching the
        same page (idempotent upserts make the overlap harmless).
        """

        offset = start_offset
        pages_done = 0
        while True:
            if max_pages and pages_done >= max_pages:
                return
            params = {
                "limit": self._page_limit,
                "offset": offset,
                "order": "id",
                "ascending": "true",
            }
            raw_json, raw_bytes = self._fetcher.get_page("/events", params)
            events = parse_page(raw_json)
            row_count = len(raw_json) if isinstance(raw_json, list) else 0
            yield offset, GammaPage(events=events, raw_bytes=raw_bytes, row_count=row_count)
            pages_done += 1
            # A short page (fewer raw items than the limit) is the last one.
            if row_count < self._page_limit:
                return
            offset += self._page_limit
