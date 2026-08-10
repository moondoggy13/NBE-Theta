"""Quote persistence + historical price lookup.

Two responsibilities, deliberately in one place because they are two
views of the same rows:

* **Write** — the collector appends quote observations and upserts the
  per-token latest read-model.
* **Read** — the Signal layer asks "what was this token worth at instant
  X?", which is what markouts and closing-line value are made of.

The read side is the one with a correctness trap in it, so it gets the
explicit type: ``QuoteLookup`` (see ``price_at``). Every lookup is
bounded by an ``as_of`` ceiling, because these rows feed wallet scoring
and scoring at ``as_of = T`` must be a function of what was observable
at T and nothing else. A lookup that could see past T would reintroduce
exactly the look-ahead leak PR 5 fixed for settlement, one layer down.
"""

from __future__ import annotations

import bisect
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Protocol

import psycopg

from nbe_theta.ingest.clob import Quote


@dataclass(frozen=True)
class QuoteFreshness:
    outcome_token_id: str
    observed_at: datetime
    age_s: float
    stream_connected: bool
    source: str


class QuoteLookup(Protocol):
    """Historical price access for the Signal layer.

    Replaces the ``dict[str, Decimal]`` that `analytics.metrics.markout`
    used to take. The dict was keyed
    ``condition_id:outcome_token_id:horizon``, which silently collided
    whenever one wallet traded the same token in two separate episodes —
    both got whichever forward price was written last, so at least one
    markout was measured from the wrong entry time. A lookup keyed by
    (token, instant) cannot express that bug: the caller passes the
    episode's own entry time, so two episodes necessarily ask two
    different questions.
    """

    def price_at(
        self, outcome_token_id: str, when: datetime, *, as_of: datetime | None = None
    ) -> Decimal | None:
        """Mid at or immediately before ``when``.

        Returns None rather than interpolating or reaching forward. A
        missing price is missing data; inventing one silently fabricates
        edge.
        """
        ...


# ── in-memory (tests + backtests) ─────────────────────────────────────


@dataclass
class InMemoryQuoteStore:
    """Sorted-by-time price series per token.

    Backs unit tests, and is also the natural shape for a walk-forward
    backtest that loads one market's history once and then asks it
    thousands of questions.
    """

    # token -> ascending list of (observed_at, mid)
    series: dict[str, list[tuple[datetime, Decimal]]] = field(default_factory=dict)
    quotes: list[Quote] = field(default_factory=list)
    latest: dict[str, Quote] = field(default_factory=dict)

    def record(self, quote: Quote) -> None:
        self.quotes.append(quote)
        prev = self.latest.get(quote.outcome_token_id)
        if prev is None or quote.observed_at >= prev.observed_at:
            self.latest[quote.outcome_token_id] = quote
        mid = quote.mid
        if mid is not None:
            self.add_point(quote.outcome_token_id, quote.observed_at, mid)

    def add_point(self, token: str, when: datetime, mid: Decimal) -> None:
        pts = self.series.setdefault(token, [])
        # Keep ascending without re-sorting the whole list on every append
        # (collectors append in time order; history backfill may not).
        idx = bisect.bisect_right([p[0] for p in pts], when)
        pts.insert(idx, (when, mid))

    def price_at(
        self, outcome_token_id: str, when: datetime, *, as_of: datetime | None = None
    ) -> Decimal | None:
        pts = self.series.get(outcome_token_id)
        if not pts:
            return None
        ceiling = when if as_of is None else min(when, as_of)
        times = [p[0] for p in pts]
        idx = bisect.bisect_right(times, ceiling)
        if idx == 0:
            return None
        return pts[idx - 1][1]


# ── store interface ───────────────────────────────────────────────────


class QuoteStore(ABC):
    @abstractmethod
    def record_quotes(self, quotes: list[Quote], *, stream_connected: bool) -> int:
        """Append observations and refresh the latest read-model."""

    @abstractmethod
    def freshness(self, tokens: list[str], *, now: datetime) -> list[QuoteFreshness]: ...

    @abstractmethod
    def price_at(
        self, outcome_token_id: str, when: datetime, *, as_of: datetime | None = None
    ) -> Decimal | None: ...


class InMemoryQuoteStoreAdapter(QuoteStore):
    """`InMemoryQuoteStore` behind the write interface."""

    def __init__(self, inner: InMemoryQuoteStore | None = None) -> None:
        self.inner = inner or InMemoryQuoteStore()

    def record_quotes(self, quotes: list[Quote], *, stream_connected: bool) -> int:
        for q in quotes:
            self.inner.record(q)
        return len(quotes)

    def freshness(self, tokens: list[str], *, now: datetime) -> list[QuoteFreshness]:
        out: list[QuoteFreshness] = []
        for t in tokens:
            q = self.inner.latest.get(t)
            if q is None:
                continue
            out.append(
                QuoteFreshness(
                    outcome_token_id=t,
                    observed_at=q.observed_at,
                    age_s=(now - q.observed_at).total_seconds(),
                    stream_connected=q.source == "ws",
                    source=q.source,
                )
            )
        return out

    def price_at(
        self, outcome_token_id: str, when: datetime, *, as_of: datetime | None = None
    ) -> Decimal | None:
        return self.inner.price_at(outcome_token_id, when, as_of=as_of)


# ── postgres ──────────────────────────────────────────────────────────


class PostgresQuoteStore(QuoteStore):
    """Writes `market_quotes` + `market_quote_latest` (migration 014)."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def record_quotes(self, quotes: list[Quote], *, stream_connected: bool) -> int:
        if not quotes:
            return 0
        written = 0
        with self._cur() as cur:
            for q in quotes:
                # ON CONFLICT DO NOTHING, not DO UPDATE: history is
                # append-only and a replayed message is the same
                # observation, not a correction. Overwriting would let a
                # re-run silently rewrite the past.
                cur.execute(
                    "insert into market_quotes (venue, condition_id, outcome_token_id, "
                    "observed_at, venue_ts, source, best_bid, best_ask, mid, spread, "
                    "bid_size, ask_size, last_trade_price) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "on conflict (outcome_token_id, observed_at, source) do nothing",
                    (
                        "polymarket",
                        q.condition_id,
                        q.outcome_token_id,
                        q.observed_at,
                        q.venue_ts,
                        q.source,
                        q.best_bid,
                        q.best_ask,
                        q.mid,
                        q.spread,
                        q.bid_size,
                        q.ask_size,
                        q.last_trade_price,
                    ),
                )
                written += cur.rowcount or 0

                # Latest is guarded on observed_at so an out-of-order
                # write (a history backfill running beside the live
                # collector) cannot drag the read-model backwards.
                cur.execute(
                    "insert into market_quote_latest (outcome_token_id, venue, condition_id, "
                    "observed_at, venue_ts, source, best_bid, best_ask, mid, spread, "
                    "bid_size, ask_size, last_trade_price, stream_connected, updated_at) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now()) "
                    "on conflict (outcome_token_id) do update set "
                    "condition_id=excluded.condition_id, observed_at=excluded.observed_at, "
                    "venue_ts=excluded.venue_ts, source=excluded.source, "
                    "best_bid=excluded.best_bid, best_ask=excluded.best_ask, "
                    "mid=excluded.mid, spread=excluded.spread, "
                    "bid_size=excluded.bid_size, ask_size=excluded.ask_size, "
                    "last_trade_price=excluded.last_trade_price, "
                    "stream_connected=excluded.stream_connected, updated_at=now() "
                    "where market_quote_latest.observed_at <= excluded.observed_at",
                    (
                        q.outcome_token_id,
                        "polymarket",
                        q.condition_id,
                        q.observed_at,
                        q.venue_ts,
                        q.source,
                        q.best_bid,
                        q.best_ask,
                        q.mid,
                        q.spread,
                        q.bid_size,
                        q.ask_size,
                        q.last_trade_price,
                        stream_connected,
                    ),
                )
        return written

    def freshness(self, tokens: list[str], *, now: datetime) -> list[QuoteFreshness]:
        if not tokens:
            return []
        with self._cur() as cur:
            cur.execute(
                "select outcome_token_id, observed_at, source, stream_connected "
                "from market_quote_latest where outcome_token_id = any(%s)",
                (list(tokens),),
            )
            return [
                QuoteFreshness(
                    outcome_token_id=row[0],
                    observed_at=row[1],
                    age_s=(now - row[1]).total_seconds(),
                    stream_connected=bool(row[3]),
                    source=row[2],
                )
                for row in cur.fetchall()
            ]

    def price_at(
        self, outcome_token_id: str, when: datetime, *, as_of: datetime | None = None
    ) -> Decimal | None:
        ceiling = when if as_of is None else min(when, as_of)
        with self._cur() as cur:
            cur.execute(
                "select mid from market_quotes "
                "where outcome_token_id = %s and observed_at <= %s and mid is not null "
                "order by observed_at desc limit 1",
                (outcome_token_id, ceiling),
            )
            row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return Decimal(str(row[0]))
