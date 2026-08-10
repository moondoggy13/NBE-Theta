"""Market-data collector: stream → books → quotes, with REST resync.

One cycle:

1. Resolve the token set (outcome tokens of markets the watchlist is
   actually exposed to, plus any explicitly pinned).
2. REST-snapshot every token. This is the *starting* truth — a delta
   stream is meaningless without it.
3. Consume the stream, folding messages into books and persisting
   quotes.
4. On any stream failure, desync every book, REST-resync, and only then
   resume.

Step 4 is the point of the module, and it is the truth hierarchy from
AGENTS.md applied literally: the websocket is fastest (source 1) but a
gap in it is repaired from REST (source 2), never by assuming the deltas
we did receive were complete. "Order uncertainty triggers
reconciliation, not a blind retry" is written there about orders; a torn
book is the same failure with the same answer.

What "drops zero events" means here, precisely: after a disconnect,
every subscribed token ends up with a quote whose `observed_at` is later
than the disconnect. Not "we replayed the missed messages" — we cannot,
the venue does not offer that — but "no token is left carrying a price
from before the gap while pretending to be live." The distinction
matters because the second property is the one that keeps a stale price
out of a markout.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.clob import (
    SOURCE_RESYNC,
    SOURCE_WS,
    ClobClient,
    Quote,
)
from nbe_theta.ingest.marketstream import (
    BookState,
    MarketStream,
    StreamClosed,
    StreamMessage,
    apply_message,
)
from nbe_theta.ingest.quote_store import QuoteStore

log = get_logger(__name__)


def _utcnow() -> datetime:
    return datetime.now(tz=UTC)


@dataclass
class CollectorConfig:
    # Stop a cycle after this many stream messages so the caller gets
    # control back (heartbeats, watchlist refresh, shutdown). Not a rate
    # limit — the stream is push-based.
    max_messages_per_cycle: int = 500
    # Persist at most one quote per token per this many seconds. A busy
    # market can emit hundreds of book updates a second; storing all of
    # them would grow the history without improving any metric computed
    # from it, because every consumer asks "price at instant X" and reads
    # the nearest preceding row.
    min_quote_interval_s: float = 1.0
    # Beyond this age a token's quote is reported stale in the freshness
    # metrics. Not an error on its own: an illiquid market legitimately
    # goes quiet.
    stale_after_s: float = 120.0


@dataclass
class CycleResult:
    run_id: uuid.UUID
    tokens: int = 0
    messages: int = 0
    quotes_written: int = 0
    resyncs: int = 0
    resynced_tokens: int = 0
    stream_connected: bool = False
    stale_tokens: list[str] = field(default_factory=list)
    desynced_tokens: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class MarketDataCollector:
    def __init__(
        self,
        *,
        clob: ClobClient,
        stream: MarketStream,
        store: QuoteStore,
        config: CollectorConfig | None = None,
        clock: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._clob = clob
        self._stream = stream
        self._store = store
        self._cfg = config or CollectorConfig()
        self._now = clock
        self._books: dict[str, BookState] = {}
        self._last_persist: dict[str, datetime] = {}

    # ── books ─────────────────────────────────────────────────────────

    def _book(self, token: str) -> BookState:
        book = self._books.get(token)
        if book is None:
            book = BookState(outcome_token_id=token)
            self._books[token] = book
        return book

    def desync_all(self) -> None:
        for book in self._books.values():
            book.desync()

    # ── REST snapshot / resync ────────────────────────────────────────

    def resync(self, tokens: Iterable[str], *, source: str = SOURCE_RESYNC) -> list[Quote]:
        """Re-establish truth for ``tokens`` from the REST book.

        Applies the FULL snapshot — every level, both sides — not just
        the resulting top-of-book. Rebuilding from the top alone would
        leave a book that is correct right up until the venue deletes the
        best level, at which point our view would fall through to
        whatever delta happened to arrive rather than to the real
        next-best price.

        A token whose fetch fails stays desynced on purpose. It emits no
        quotes and shows up in the freshness report — the correct visible
        outcome, rather than a book that keeps serving a pre-gap price as
        if it were live.
        """

        out: list[Quote] = []
        for token in tokens:
            try:
                snapshot, _raw = self._clob.book(token)
            except Exception as exc:  # noqa: BLE001 — one bad token must not abort the resync
                log.warning("resync_failed", token=token, error=str(exc))
                continue
            if snapshot is None:
                continue
            book = self._book(token)
            book.apply_snapshot(
                snapshot.levels_map("BUY"),
                snapshot.levels_map("SELL"),
                condition_id=snapshot.condition_id,
                venue_ts=snapshot.venue_ts,
                at=snapshot.observed_at,
            )
            out.append(snapshot.quote(source))
        return out

    # ── one cycle ─────────────────────────────────────────────────────

    def run_cycle(self, tokens: list[str]) -> CycleResult:
        run_id = uuid.uuid4()
        result = CycleResult(run_id=run_id, tokens=len(tokens))
        if not tokens:
            return result

        # Cold tokens (never snapshotted, or desynced by a previous
        # failure) need REST truth before any delta can mean anything.
        cold = [t for t in tokens if not self._book(t).synced]
        if cold:
            snapshots = self.resync(cold)
            result.resyncs += 1
            result.resynced_tokens += len(snapshots)
            result.quotes_written += self._persist(snapshots, stream_connected=False, force=True)

        # `pending` is owned here, not inside _consume, so that a
        # mid-iteration StreamClosed does not discard the quotes we had
        # already built. Those are real observations from before the gap;
        # throwing them away would be the very data loss this cycle
        # claims to prevent.
        pending: list[Quote] = []
        try:
            result.messages = self._consume(tokens, pending)
            result.stream_connected = True
        except StreamClosed as exc:
            # The gap is here. Everything we hold may be missing deltas,
            # so nothing is trusted until REST says otherwise.
            result.errors.append(f"stream_closed: {exc}")
            result.stream_connected = False
            result.quotes_written += self._persist(pending, stream_connected=True)
            pending = []
            self.desync_all()
            repaired = self.resync(tokens)
            result.resyncs += 1
            result.resynced_tokens += len(repaired)
            result.quotes_written += self._persist(repaired, stream_connected=False, force=True)
        else:
            result.quotes_written += self._persist(pending, stream_connected=True)

        result.stale_tokens = self._stale(tokens)
        result.desynced_tokens = self._desynced(tokens)
        return result

    def _consume(self, tokens: list[str], pending: list[Quote]) -> int:
        seen = 0
        for msg in self._stream.subscribe(tokens):
            seen += 1
            self._handle(msg, pending)
            if seen >= self._cfg.max_messages_per_cycle:
                break
        return seen

    def _handle(self, msg: StreamMessage, pending: list[Quote]) -> None:
        book = self._book(msg.outcome_token_id)
        apply_message(book, msg)
        quote = book.quote(source=SOURCE_WS, at=msg.received_at)
        if quote is None:
            return
        if not self._due(msg.outcome_token_id, quote.observed_at):
            return
        pending.append(quote)

    def _due(self, token: str, when: datetime) -> bool:
        last = self._last_persist.get(token)
        if last is None:
            return True
        return (when - last).total_seconds() >= self._cfg.min_quote_interval_s

    def _persist(self, quotes: list[Quote], *, stream_connected: bool, force: bool = False) -> int:
        if not quotes:
            return 0
        written = self._store.record_quotes(quotes, stream_connected=stream_connected)
        for q in quotes:
            prev = self._last_persist.get(q.outcome_token_id)
            if force or prev is None or q.observed_at > prev:
                self._last_persist[q.outcome_token_id] = q.observed_at
        return written

    def _stale(self, tokens: list[str]) -> list[str]:
        """Tokens whose price we cannot currently be said to know.

        Three distinct conditions, all of which must report as stale:

        1. No quote at all — the most stale a token can be, and easy to
           miss because there is no row to compute an age from.
        2. The last quote is older than the threshold.
        3. **The book is desynced.** This is the non-obvious one. A token
           can have a quote from two seconds ago and a torn book: the
           quote is real, but no further quote is coming until a REST
           repair succeeds, so reporting it as fresh is a lie with a
           short shelf life. Age alone would show green through an
           outage — which is exactly the failure mode the
           `stream_connected` column in migration 014 exists to prevent,
           and it has to be enforced here too, not just stored.
        """

        now = self._now()
        fresh = {f.outcome_token_id: f for f in self._store.freshness(tokens, now=now)}
        stale: list[str] = []
        for t in tokens:
            f = fresh.get(t)
            if f is None or f.age_s > self._cfg.stale_after_s:
                stale.append(t)
            elif not self._book(t).synced:
                stale.append(t)
        return stale

    def _desynced(self, tokens: list[str]) -> list[str]:
        """Tokens whose book cannot be trusted right now.

        Reported separately from staleness because the operator response
        differs: a stale-but-synced token is a quiet market, while a
        desynced one is a repair that keeps failing.
        """

        return [t for t in tokens if not self._book(t).synced]

    def books(self) -> dict[str, BookState]:
        return dict(self._books)
