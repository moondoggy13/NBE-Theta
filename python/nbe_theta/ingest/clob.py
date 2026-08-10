"""Polymarket CLOB REST client + order-book parsing.

The CLOB (``https://clob.polymarket.com``) is the executable-price
surface. Everything the Signal layer says about skill is measured
against prices from here: `excess_edge` needs the price a wallet paid,
markouts need the price N minutes later, and closing-line value needs
the price at market close.

Three endpoints matter:

* ``/book``           — full order book for one outcome token. The live
                        quote, and the resync source of truth after a
                        websocket gap.
* ``/midpoint``       — just the mid. Cheap; used for liveness probes.
* ``/prices-history`` — historical price series for one token. This is
                        the one that makes PR 6 useful *today*: without
                        it, CLV and markouts would only ever exist for
                        episodes that happened after the collector was
                        first switched on, which is exactly the wrong
                        half of the data for scoring a wallet's past.

Like the Gamma and Data API clients this depends on the ``Fetcher``
seam, so no unit test reaches the network (AGENTS.md), and it parses
defensively: a malformed level is dropped, never coerced.

**Schema provenance.** The Polymarket API publishes no versioned schema
and the field names drift, so — as with `gamma.py` and `dataapi.py` —
the parsers accept several spellings per field and the test fixtures are
built to the *documented* shapes rather than captured from live traffic
(the venue hosts are unreachable from CI). The defensive parsing is not
decoration; it is the actual contract.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from nbe_theta.common.http import Fetcher

PARSER_VERSION = "clob-1"
VENUE = "polymarket"

# Quote provenance. Mirrors the `source` check constraint in migration 014.
SOURCE_WS = "ws"
SOURCE_RESYNC = "rest_resync"
SOURCE_POLL = "rest_poll"
SOURCE_HISTORY = "rest_history"

ZERO = Decimal("0")
ONE = Decimal("1")


@dataclass(frozen=True)
class BookLevel:
    price: Decimal
    size: Decimal


@dataclass(frozen=True)
class Quote:
    """One observation of the top of book for one outcome token.

    ``best_bid`` / ``best_ask`` are None for a one-sided (or empty) book.
    That is a real market state, not an error — a market with no bid is
    not a market with a bid of zero, and writing 0 would turn into a
    100% spread and a 0.50 mid downstream. For the same reason ``mid``
    is None unless BOTH sides exist: an imputed mid is a fabricated
    price, and these rows feed skill measurement.
    """

    condition_id: str
    outcome_token_id: str
    observed_at: datetime
    source: str
    best_bid: Decimal | None = None
    best_ask: Decimal | None = None
    bid_size: Decimal | None = None
    ask_size: Decimal | None = None
    last_trade_price: Decimal | None = None
    venue_ts: datetime | None = None
    # A directly-reported mid with no book behind it — what
    # `/prices-history` returns. Set this INSTEAD of bid/ask for those
    # rows: filling bid and ask with the same number would compute a
    # spread of exactly zero, which is not a coarse measurement of a real
    # spread, it is a false one. A null spread says "unknown"; a zero
    # spread says "this market was perfectly tight", and downstream code
    # that ranks markets by liquidity would believe it.
    mid_price: Decimal | None = None

    @property
    def mid(self) -> Decimal | None:
        if self.mid_price is not None:
            return self.mid_price
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / Decimal("2")

    @property
    def spread(self) -> Decimal | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    @property
    def is_crossed(self) -> bool:
        """Bid above ask. Physically impossible in a consistent book, so
        it means our view is torn — usually a websocket delta applied to
        a stale snapshot. The collector treats it as a resync trigger
        rather than persisting a price that implies free money."""

        if self.best_bid is None or self.best_ask is None:
            return False
        return self.best_bid > self.best_ask


@dataclass(frozen=True)
class HistoryPoint:
    outcome_token_id: str
    observed_at: datetime
    price: Decimal


# ── coercion ──────────────────────────────────────────────────────────


def _dec(v: Any) -> Decimal | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        d = Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


def unit_price(v: Any) -> Decimal | None:
    """A probability price: must land in [0, 1].

    Out-of-range is dropped, not clamped. A price of 1.4 is a parser
    failure or a venue bug; clamping it to 1.0 would launder that into a
    plausible-looking number and quietly corrupt every metric computed
    from it.
    """

    d = _dec(v)
    if d is None or d < ZERO or d > ONE:
        return None
    return d


def size_value(v: Any) -> Decimal | None:
    d = _dec(v)
    if d is None or d < ZERO:
        return None
    return d


def ts_from_millis(v: Any) -> datetime | None:
    """CLOB timestamps are unix milliseconds, often as strings.

    Tolerates seconds too: anything below ~1e11 is far too small to be a
    plausible millisecond stamp for a live venue, so it is read as
    seconds instead of silently producing a 1970 date.
    """

    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(float(v))
    except (ValueError, TypeError):
        return None
    if n <= 0:
        return None
    secs = n / 1000.0 if n > 100_000_000_000 else float(n)
    try:
        return datetime.fromtimestamp(secs, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def ts_from_seconds(v: Any) -> datetime | None:
    """Unix seconds (the /prices-history stamp)."""

    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(float(v))
    except (ValueError, TypeError):
        return None
    if n <= 0:
        return None
    try:
        return datetime.fromtimestamp(float(n), tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def text_value(v: Any) -> str | None:
    if isinstance(v, str) and v.strip():
        return v.strip()
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    return None


# ── parsers ───────────────────────────────────────────────────────────


def parse_levels(raw: Any) -> list[BookLevel]:
    """Parse one side of a book. Malformed levels are dropped."""

    if not isinstance(raw, list):
        return []
    out: list[BookLevel] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        price = unit_price(item.get("price") or item.get("p"))
        size = size_value(item.get("size") or item.get("s"))
        if price is None or size is None:
            continue
        # A zero-size level is a deletion marker in the delta protocol,
        # not a resting order. It must not count as depth.
        if size == ZERO:
            continue
        out.append(BookLevel(price=price, size=size))
    return out


def best_bid(levels: list[BookLevel]) -> BookLevel | None:
    """Highest bid.

    Computed by max() rather than by taking an end of the list on
    purpose: the CLOB does not document a stable sort order for book
    sides, and different endpoints have been observed returning bids
    ascending and descending. Picking `levels[0]` or `levels[-1]` would
    be a coin flip that silently produces the *worst* price half the
    time — and a wrong best-bid does not crash anything, it just makes
    every spread and mid subtly wrong forever.
    """

    return max(levels, key=lambda level: level.price, default=None)


def best_ask(levels: list[BookLevel]) -> BookLevel | None:
    """Lowest ask. Same reasoning as `best_bid`."""

    return min(levels, key=lambda level: level.price, default=None)


@dataclass(frozen=True)
class BookSnapshot:
    """A full ``/book`` response: both sides, every level.

    The collector needs the whole book, not just the top of it. A resync
    that kept only the best bid/ask would look correct until the venue
    deleted that level — the true next-best exists at the venue but not
    in our reconstructed book, so our "best" would jump to whatever
    arrived next, or to nothing. That is precisely the silent-wrongness
    the stream's `synced` flag exists to prevent, so the repair path must
    not reintroduce it.
    """

    condition_id: str
    outcome_token_id: str
    observed_at: datetime
    bids: list[BookLevel]
    asks: list[BookLevel]
    venue_ts: datetime | None = None

    def levels_map(self, side: str) -> dict[Decimal, Decimal]:
        levels = self.bids if side == "BUY" else self.asks
        return {level.price: level.size for level in levels}

    def quote(self, source: str) -> Quote:
        bb = best_bid(self.bids)
        ba = best_ask(self.asks)
        return Quote(
            condition_id=self.condition_id,
            outcome_token_id=self.outcome_token_id,
            observed_at=self.observed_at,
            source=source,
            best_bid=bb.price if bb else None,
            best_ask=ba.price if ba else None,
            bid_size=bb.size if bb else None,
            ask_size=ba.size if ba else None,
            venue_ts=self.venue_ts,
        )


def parse_book(
    raw: dict[str, Any],
    *,
    observed_at: datetime,
    condition_id_hint: str | None = None,
    token_hint: str | None = None,
) -> BookSnapshot | None:
    """Parse a ``/book`` response into a full snapshot.

    ``observed_at`` is supplied by the caller — our clock, not the
    venue's. See migration 014: the venue's stamp is recorded for latency
    measurement but must never decide what a backtest could have known.
    """

    token = (
        text_value(raw.get("asset_id") or raw.get("assetId") or raw.get("token_id")) or token_hint
    )
    condition = (
        text_value(raw.get("market") or raw.get("condition_id") or raw.get("conditionId"))
        or condition_id_hint
    )
    if not token or not condition:
        return None

    return BookSnapshot(
        condition_id=condition,
        outcome_token_id=token,
        observed_at=observed_at,
        bids=parse_levels(raw.get("bids") or raw.get("buys")),
        asks=parse_levels(raw.get("asks") or raw.get("sells")),
        venue_ts=ts_from_millis(raw.get("timestamp") or raw.get("ts")),
    )


def parse_history(raw: Any, token: str) -> list[HistoryPoint]:
    """Parse ``/prices-history`` into points, ascending by time.

    Shape: ``{"history": [{"t": <unix s>, "p": <price>}, ...]}``. Points
    missing either field are dropped — a history point with no timestamp
    cannot be placed on the timeline, and one with no price is not a
    price.
    """

    rows: Any = raw
    if isinstance(raw, dict):
        rows = raw.get("history") or raw.get("prices") or []
    if not isinstance(rows, list):
        return []

    out: list[HistoryPoint] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        when = ts_from_seconds(item.get("t") or item.get("timestamp"))
        price = unit_price(item.get("p") if "p" in item else item.get("price"))
        if when is None or price is None:
            continue
        out.append(HistoryPoint(outcome_token_id=token, observed_at=when, price=price))
    out.sort(key=lambda p: p.observed_at)
    return out


# ── client ────────────────────────────────────────────────────────────


class ClobClient:
    """CLOB REST access over the Fetcher seam."""

    def __init__(self, fetcher: Fetcher, *, clock: Any = None) -> None:
        self._fetcher = fetcher
        # Injectable clock so the resync tests are deterministic. Default
        # is wall time.
        self._now = clock or (lambda: datetime.now(tz=UTC))

    def book(
        self, token: str, *, condition_id_hint: str | None = None
    ) -> tuple[BookSnapshot | None, bytes]:
        """Fetch one token's full book.

        Returns (snapshot, raw_bytes) — the bytes so the caller can
        archive them for deterministic replay, the full snapshot rather
        than a top-of-book quote because the collector rebuilds its
        entire book state from this (see `BookSnapshot`).
        """

        raw, raw_bytes = self._fetcher.get_page("/book", {"token_id": token})
        if not isinstance(raw, dict):
            return None, raw_bytes
        snapshot = parse_book(
            raw,
            observed_at=self._now(),
            condition_id_hint=condition_id_hint,
            token_hint=token,
        )
        return snapshot, raw_bytes

    def books(self, tokens: list[str]) -> Iterator[tuple[str, BookSnapshot | None, bytes]]:
        """Fetch several books, one request each.

        The venue does expose a batched endpoint, but it is a POST and
        the ``Fetcher`` seam is deliberately GET-only (it is also the
        archive boundary). Looping is N requests instead of 1; at
        watchlist scale, behind the shared rate-limit budget, that is a
        few seconds — cheap enough not to widen the seam for.
        """

        for token in tokens:
            snapshot, raw_bytes = self.book(token)
            yield token, snapshot, raw_bytes

    def midpoint(self, token: str) -> Decimal | None:
        raw, _ = self._fetcher.get_page("/midpoint", {"token_id": token})
        if not isinstance(raw, dict):
            return None
        return unit_price(raw.get("mid") or raw.get("midpoint"))

    def prices_history(
        self,
        token: str,
        *,
        start_ts: int | None = None,
        end_ts: int | None = None,
        interval: str | None = None,
        fidelity: int | None = None,
    ) -> tuple[list[HistoryPoint], bytes]:
        """Historical price series for one token.

        ``interval`` (e.g. ``"1m"``, ``"1d"``, ``"max"``) and an explicit
        start/end window are mutually exclusive at the venue; pass one or
        the other. ``fidelity`` is the bucket size in minutes.
        """

        params: dict[str, Any] = {"market": token}
        if start_ts is not None:
            params["startTs"] = start_ts
        if end_ts is not None:
            params["endTs"] = end_ts
        if interval is not None:
            params["interval"] = interval
        if fidelity is not None:
            params["fidelity"] = fidelity
        raw, raw_bytes = self._fetcher.get_page("/prices-history", params)
        return parse_history(raw, token), raw_bytes
