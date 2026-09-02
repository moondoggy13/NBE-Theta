"""Market websocket seam + book state machine.

The CLOB market channel pushes four message types for a subscribed
outcome token:

* ``book``             — a full snapshot of both sides. Replaces state.
* ``price_change``     — deltas. A level with size 0 is a deletion.
* ``last_trade_price`` — the print of a trade; no book effect.
* ``tick_size_change`` — the minimum price increment moved.

Everything here is synchronous, matching the rest of the worker
(`LiveMonitor` is a sync tick loop). The only asynchronous thing a
websocket needs is *waiting*, and a blocking read expresses that fine.

The seam is ``MarketStream``. Production wires ``WebsocketMarketStream``;
tests wire ``ReplayMarketStream`` over a recorded JSONL file, so no unit
test opens a socket (AGENTS.md).

**The correctness property this module exists to protect.** A delta
protocol is only safe if you know your snapshot was current when the
deltas started. Miss one ``price_change`` — a dropped frame, a
reconnect, a parse failure — and the book is silently wrong from then
on, with no error and no crash. It just quietly reports a price that
never existed, forever. So `BookState` tracks whether it is
`synced`, and every path that could have lost a message clears that
flag. An unsynced book yields no quotes at all until a REST snapshot
re-establishes truth. Refusing to emit is the whole point: a missing
quote is visible in the freshness metrics, whereas a wrong quote is
invisible and poisons every markout computed from it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from nbe_theta.ingest.clob import (
    SOURCE_WS,
    Quote,
    size_value,
    text_value,
    ts_from_millis,
    unit_price,
)

ZERO = Decimal("0")

EVENT_BOOK = "book"
EVENT_PRICE_CHANGE = "price_change"
EVENT_LAST_TRADE = "last_trade_price"
EVENT_TICK_SIZE = "tick_size_change"


class StreamClosed(Exception):
    """The stream ended or dropped.

    Raised by the transport, caught by the collector, and answered with a
    REST resync — never with a blind resume of the delta feed.
    """


@dataclass(frozen=True)
class StreamMessage:
    event_type: str
    outcome_token_id: str
    raw: dict[str, Any]
    received_at: datetime


class MarketStream(Protocol):
    """Yields market messages for a set of subscribed tokens."""

    def subscribe(self, tokens: list[str]) -> Iterator[StreamMessage]: ...

    def close(self) -> None: ...


# ── book state ────────────────────────────────────────────────────────


@dataclass
class BookState:
    """One outcome token's book, maintained from stream messages.

    ``synced`` is the load-bearing field. False means "we may have missed
    a delta"; while it is False this book yields no quotes. It flips to
    True only on a full snapshot (a ``book`` message or a REST resync),
    never as a side effect of applying a delta.
    """

    outcome_token_id: str
    condition_id: str | None = None
    bids: dict[Decimal, Decimal] = field(default_factory=dict)
    asks: dict[Decimal, Decimal] = field(default_factory=dict)
    last_trade_price: Decimal | None = None
    tick_size: Decimal | None = None
    venue_ts: datetime | None = None
    updated_at: datetime | None = None
    synced: bool = False

    def apply_snapshot(
        self,
        bids: dict[Decimal, Decimal],
        asks: dict[Decimal, Decimal],
        *,
        condition_id: str | None,
        venue_ts: datetime | None,
        at: datetime,
    ) -> None:
        """Replace both sides wholesale and mark the book trustworthy."""

        self.bids = {p: s for p, s in bids.items() if s > ZERO}
        self.asks = {p: s for p, s in asks.items() if s > ZERO}
        if condition_id:
            self.condition_id = condition_id
        self.venue_ts = venue_ts
        self.updated_at = at
        self.synced = True

    def apply_change(
        self,
        side: str,
        price: Decimal,
        size: Decimal,
        *,
        venue_ts: datetime | None,
        at: datetime,
    ) -> None:
        """Apply one level delta. Size 0 deletes the level.

        Deliberately a no-op when the book is unsynced: applying deltas to
        a book we know is torn would produce a self-consistent-looking
        state that is wrong, which is worse than no state.
        """

        if not self.synced:
            return
        book = self.bids if side == "BUY" else self.asks
        if size <= ZERO:
            book.pop(price, None)
        else:
            book[price] = size
        self.venue_ts = venue_ts
        self.updated_at = at

    def desync(self) -> None:
        """Mark the book untrustworthy. Called on reconnect, on a parse
        failure, and on a crossed book."""

        self.synced = False

    def quote(self, *, source: str = SOURCE_WS, at: datetime | None = None) -> Quote | None:
        """Top of book, or None if this book cannot be trusted.

        Returns None when unsynced, when the condition id is unknown (we
        would not know which market the price belongs to), and when the
        book is crossed. A crossed book also self-desyncs: bid > ask is
        physically impossible, so our view is torn and only a fresh
        snapshot can fix it.
        """

        if not self.synced or self.condition_id is None:
            return None
        bb = max(self.bids) if self.bids else None
        ba = min(self.asks) if self.asks else None
        if bb is not None and ba is not None and bb > ba:
            self.desync()
            return None
        return Quote(
            condition_id=self.condition_id,
            outcome_token_id=self.outcome_token_id,
            observed_at=at or self.updated_at or datetime.now(tz=UTC),
            source=source,
            best_bid=bb,
            best_ask=ba,
            bid_size=self.bids.get(bb) if bb is not None else None,
            ask_size=self.asks.get(ba) if ba is not None else None,
            last_trade_price=self.last_trade_price,
            venue_ts=self.venue_ts,
        )


# ── message parsing ───────────────────────────────────────────────────


def _levels_map(raw: Any) -> dict[Decimal, Decimal]:
    out: dict[Decimal, Decimal] = {}
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        price = unit_price(item.get("price") or item.get("p"))
        size = size_value(item.get("size") or item.get("s"))
        if price is None or size is None:
            continue
        out[price] = size
    return out


def _side(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip().upper()
    if s in {"BUY", "BID"}:
        return "BUY"
    if s in {"SELL", "ASK"}:
        return "SELL"
    return None


def message_token(raw: dict[str, Any]) -> str | None:
    return text_value(raw.get("asset_id") or raw.get("assetId") or raw.get("token_id"))


def apply_message(book: BookState, msg: StreamMessage) -> None:
    """Fold one stream message into a book.

    Unknown event types are ignored (the venue adds message types without
    warning, and an unrecognized message is not evidence of loss). A
    *malformed* message of a known type is different: it means we cannot
    tell what changed, so the book desyncs and waits for a snapshot.
    """

    raw = msg.raw
    at = msg.received_at
    venue_ts = ts_from_millis(raw.get("timestamp") or raw.get("ts"))

    if msg.event_type == EVENT_BOOK:
        bids = _levels_map(raw.get("bids") or raw.get("buys"))
        asks = _levels_map(raw.get("asks") or raw.get("sells"))
        book.apply_snapshot(
            bids,
            asks,
            condition_id=text_value(raw.get("market") or raw.get("condition_id")),
            venue_ts=venue_ts,
            at=at,
        )
        return

    if msg.event_type == EVENT_PRICE_CHANGE:
        changes = raw.get("changes")
        if changes is None:
            # Some builds send a single flat change instead of a list.
            changes = [raw]
        if not isinstance(changes, list):
            book.desync()
            return
        for ch in changes:
            if not isinstance(ch, dict):
                book.desync()
                return
            side = _side(ch.get("side"))
            price = unit_price(ch.get("price") or ch.get("p"))
            size = size_value(ch.get("size") or ch.get("s"))
            if side is None or price is None or size is None:
                # We know a level moved but not which one — the book is
                # now unknowable until a snapshot arrives.
                book.desync()
                return
            book.apply_change(side, price, size, venue_ts=venue_ts, at=at)
        return

    if msg.event_type == EVENT_LAST_TRADE:
        price = unit_price(raw.get("price") or raw.get("p"))
        if price is not None:
            book.last_trade_price = price
            book.updated_at = at
        return

    if msg.event_type == EVENT_TICK_SIZE:
        tick = unit_price(raw.get("new_tick_size") or raw.get("tick_size"))
        if tick is not None:
            book.tick_size = tick
        return


# ── transports ────────────────────────────────────────────────────────


class ReplayMarketStream:
    """Replays recorded messages from a JSONL file (or a list).

    Each line is one raw venue message. A line of exactly
    ``{"__disconnect__": true}`` raises ``StreamClosed`` at that point —
    that is how the resync test forces a mid-stream drop without any
    network or timing games.
    """

    DISCONNECT_KEY = "__disconnect__"

    def __init__(self, messages: list[dict[str, Any]], *, clock: Any = None) -> None:
        self._messages = messages
        self._i = 0
        self._closed = False
        self._now = clock or (lambda: datetime.now(tz=UTC))
        self.subscribed: list[str] = []

    @classmethod
    def from_jsonl(cls, path: str | Path, *, clock: Any = None) -> ReplayMarketStream:
        rows: list[dict[str, Any]] = []
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            obj = json.loads(line)
            if isinstance(obj, dict):
                rows.append(obj)
        return cls(rows, clock=clock)

    def subscribe(self, tokens: list[str]) -> Iterator[StreamMessage]:
        self.subscribed = list(tokens)
        wanted = set(tokens)
        while self._i < len(self._messages):
            raw = self._messages[self._i]
            self._i += 1
            if raw.get(self.DISCONNECT_KEY):
                raise StreamClosed("replay disconnect marker")
            token = message_token(raw)
            if token is None or (wanted and token not in wanted):
                continue
            event = text_value(raw.get("event_type") or raw.get("type"))
            if event is None:
                continue
            yield StreamMessage(
                event_type=event,
                outcome_token_id=token,
                raw=raw,
                received_at=self._now(),
            )

    @property
    def exhausted(self) -> bool:
        return self._i >= len(self._messages)

    def close(self) -> None:
        self._closed = True


class WebsocketMarketStream:
    """Real transport: a blocking websocket client.

    The `websockets` import is deliberately function-local. It is the only
    module in the worker that needs a socket library, and keeping the
    import off the module path means the parsing and book logic — which
    is all of the logic — imports and tests without it.
    """

    def __init__(
        self,
        url: str,
        *,
        open_timeout_s: float = 10.0,
        recv_timeout_s: float = 60.0,
    ) -> None:
        self._url = url
        self._open_timeout_s = open_timeout_s
        self._recv_timeout_s = recv_timeout_s
        self._conn: Any = None

    def subscribe(self, tokens: list[str]) -> Iterator[StreamMessage]:
        from websockets.sync.client import connect  # local: see class docstring

        try:
            self._conn = connect(self._url, open_timeout=self._open_timeout_s)
        except Exception as exc:  # noqa: BLE001 — any failure to open is a closed stream
            raise StreamClosed(f"connect failed: {exc}") from exc

        try:
            # `assets_ids` is the venue's spelling, not a typo here.
            self._conn.send(json.dumps({"assets_ids": tokens, "type": "market"}))
            while True:
                try:
                    frame = self._conn.recv(timeout=self._recv_timeout_s)
                except Exception as exc:  # noqa: BLE001 — timeout or drop, same answer
                    raise StreamClosed(f"recv failed: {exc}") from exc

                payload = frame.decode("utf-8") if isinstance(frame, bytes) else frame
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    # Unparseable frame: we cannot know what it changed.
                    # Treat as a gap so the collector resyncs, rather than
                    # skipping it and drifting.
                    raise StreamClosed("unparseable frame") from None

                # The venue batches messages into a JSON array.
                items = parsed if isinstance(parsed, list) else [parsed]
                now = datetime.now(tz=UTC)
                for raw in items:
                    if not isinstance(raw, dict):
                        continue
                    token = message_token(raw)
                    event = text_value(raw.get("event_type") or raw.get("type"))
                    if token is None or event is None:
                        continue
                    yield StreamMessage(
                        event_type=event,
                        outcome_token_id=token,
                        raw=raw,
                        received_at=now,
                    )
        finally:
            self.close()

    def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 — closing a dead socket is not an error
                pass
