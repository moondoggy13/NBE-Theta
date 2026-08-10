"""Market-data collection: parsing, book state, and gap repair.

The tests that matter here are not the parsing ones. They are:

* `test_disconnect_leaves_no_token_serving_a_pre_gap_price` — the
  property the whole resync path exists for.
* `test_unsynced_book_refuses_to_quote` — a torn book must go quiet, not
  guess.
* `test_deleting_the_best_level_falls_through_to_real_depth` — the bug a
  top-of-book-only resync would have introduced.
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from nbe_theta.ingest.clob import (
    SOURCE_RESYNC,
    ClobClient,
    best_ask,
    best_bid,
    parse_book,
    parse_history,
    parse_levels,
)
from nbe_theta.ingest.collector import CollectorConfig, MarketDataCollector
from nbe_theta.ingest.marketstream import (
    BookState,
    ReplayMarketStream,
    StreamClosed,
    StreamMessage,
    apply_message,
)
from nbe_theta.ingest.quote_store import InMemoryQuoteStoreAdapter
from tests.conftest import RecordedClobFetcher

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
TOKEN_A = "22220001"
TOKEN_B = "22220002"


def _msg(event: str, token: str, at: datetime, **fields: Any) -> StreamMessage:
    raw: dict[str, Any] = {"event_type": event, "asset_id": token, "market": "0xcond2001"}
    raw.update(fields)
    return StreamMessage(event_type=event, outcome_token_id=token, raw=raw, received_at=at)


def _snapshot_msg(token: str, at: datetime, bids: list[Any], asks: list[Any]) -> StreamMessage:
    return _msg("book", token, at, bids=bids, asks=asks)


# ── parsing ───────────────────────────────────────────────────────────


def test_best_bid_and_ask_do_not_depend_on_venue_sort_order(clob_book: Any) -> None:
    """The fixture lists both sides out of order on purpose.

    A parser that trusted position (levels[0] / levels[-1]) would return
    the *worst* price here — and would do it silently, forever.
    """

    book = parse_book(clob_book, observed_at=T0)
    assert book is not None
    assert best_bid(book.bids) is not None
    assert best_bid(book.bids).price == Decimal("0.43")  # type: ignore[union-attr]
    assert best_ask(book.asks).price == Decimal("0.45")  # type: ignore[union-attr]

    reversed_payload = copy.deepcopy(clob_book)
    reversed_payload["bids"] = list(reversed(reversed_payload["bids"]))
    reversed_payload["asks"] = list(reversed(reversed_payload["asks"]))
    other = parse_book(reversed_payload, observed_at=T0)
    assert other is not None
    assert other.quote(SOURCE_RESYNC).mid == book.quote(SOURCE_RESYNC).mid


def test_out_of_range_and_zero_size_levels_are_dropped_not_clamped() -> None:
    levels = parse_levels(
        [
            {"price": "0.30", "size": "100"},
            {"price": "1.40", "size": "50"},  # impossible probability
            {"price": "-0.10", "size": "50"},
            {"price": "0.35", "size": "0"},  # deletion marker, not depth
            {"price": "bogus", "size": "10"},
        ]
    )
    assert [level.price for level in levels] == [Decimal("0.30")]


def test_one_sided_book_has_no_mid_rather_than_an_invented_one() -> None:
    book = parse_book(
        {
            "asset_id": TOKEN_A,
            "market": "0xc",
            "bids": [{"price": "0.40", "size": "10"}],
            "asks": [],
        },
        observed_at=T0,
    )
    assert book is not None
    q = book.quote(SOURCE_RESYNC)
    assert q.best_bid == Decimal("0.40")
    assert q.best_ask is None
    assert q.mid is None
    assert q.spread is None


def test_history_parses_ascending_and_drops_incomplete_points(clob_history: Any) -> None:
    payload = copy.deepcopy(clob_history)
    payload["history"].insert(0, {"t": 1814231700, "p": 0.61})  # out of order
    payload["history"].append({"p": 0.9})  # no timestamp
    payload["history"].append({"t": 1814232600})  # no price
    points = parse_history(payload, TOKEN_A)
    assert len(points) == 6
    assert points == sorted(points, key=lambda p: p.observed_at)


# ── book state machine ────────────────────────────────────────────────


def test_unsynced_book_refuses_to_quote() -> None:
    book = BookState(outcome_token_id=TOKEN_A, condition_id="0xc")
    apply_message(
        book,
        _msg("price_change", TOKEN_A, T0, changes=[{"price": "0.4", "size": "10", "side": "BUY"}]),
    )
    # No snapshot has ever arrived, so the delta must not create a book.
    assert book.quote() is None
    assert not book.synced
    assert book.bids == {}


def test_malformed_delta_desyncs_rather_than_being_skipped() -> None:
    book = BookState(outcome_token_id=TOKEN_A)
    apply_message(
        book,
        _snapshot_msg(
            TOKEN_A, T0, [{"price": "0.42", "size": "100"}], [{"price": "0.45", "size": "100"}]
        ),
    )
    assert book.synced

    # A change we cannot interpret means a level moved and we do not know
    # which. Skipping it would leave a book that looks fine and is wrong.
    apply_message(
        book,
        _msg("price_change", TOKEN_A, T0, changes=[{"price": "???", "size": "10", "side": "BUY"}]),
    )
    assert not book.synced
    assert book.quote() is None


def test_deleting_the_best_level_falls_through_to_real_depth() -> None:
    """The case a top-of-book-only resync would get wrong.

    Two bid levels exist. The better one is deleted. The book must fall
    through to the genuine next-best (0.42), not to nothing and not to
    whatever arrives next.
    """

    book = BookState(outcome_token_id=TOKEN_A)
    apply_message(
        book,
        _snapshot_msg(
            TOKEN_A,
            T0,
            [{"price": "0.42", "size": "100"}, {"price": "0.44", "size": "50"}],
            [{"price": "0.46", "size": "100"}],
        ),
    )
    assert book.quote().best_bid == Decimal("0.44")  # type: ignore[union-attr]

    apply_message(
        book,
        _msg("price_change", TOKEN_A, T0, changes=[{"price": "0.44", "size": "0", "side": "BUY"}]),
    )
    q = book.quote()
    assert q is not None
    assert q.best_bid == Decimal("0.42")


def test_crossed_book_desyncs_instead_of_reporting_free_money() -> None:
    book = BookState(outcome_token_id=TOKEN_A)
    apply_message(
        book,
        _snapshot_msg(
            TOKEN_A, T0, [{"price": "0.42", "size": "100"}], [{"price": "0.45", "size": "100"}]
        ),
    )
    apply_message(
        book,
        _msg("price_change", TOKEN_A, T0, changes=[{"price": "0.60", "size": "10", "side": "BUY"}]),
    )
    assert book.quote() is None
    assert not book.synced


def test_last_trade_price_does_not_move_the_book() -> None:
    book = BookState(outcome_token_id=TOKEN_A)
    apply_message(
        book,
        _snapshot_msg(
            TOKEN_A, T0, [{"price": "0.42", "size": "100"}], [{"price": "0.45", "size": "100"}]
        ),
    )
    apply_message(book, _msg("last_trade_price", TOKEN_A, T0, price="0.44"))
    q = book.quote()
    assert q is not None
    assert q.last_trade_price == Decimal("0.44")
    assert q.best_bid == Decimal("0.42")
    assert q.best_ask == Decimal("0.45")


# ── replay + resync ───────────────────────────────────────────────────


def _collector(
    fetcher: RecordedClobFetcher, stream: ReplayMarketStream, clock: Any
) -> tuple[MarketDataCollector, InMemoryQuoteStoreAdapter]:
    store = InMemoryQuoteStoreAdapter()
    collector = MarketDataCollector(
        clob=ClobClient(fetcher, clock=clock),
        stream=stream,
        store=store,
        # 0 so every book update in the short fixture is persisted;
        # the throttle is exercised by its own test.
        config=CollectorConfig(min_quote_interval_s=0.0),
        clock=clock,
    )
    return collector, store


def _books_for(tokens: list[str], mid: str = "0.50") -> dict[str, Any]:
    lo = Decimal(mid) - Decimal("0.01")
    hi = Decimal(mid) + Decimal("0.01")
    return {
        t: {
            "asset_id": t,
            "market": "0xcond2001",
            "bids": [{"price": str(lo), "size": "100"}],
            "asks": [{"price": str(hi), "size": "100"}],
        }
        for t in tokens
    }


def test_replay_stream_raises_at_the_disconnect_marker(market_stream_path: Any) -> None:
    stream = ReplayMarketStream.from_jsonl(market_stream_path, clock=lambda: T0)
    seen = []
    with pytest.raises(StreamClosed):
        for msg in stream.subscribe([TOKEN_A, TOKEN_B]):
            seen.append(msg)
    assert len(seen) == 6
    assert not stream.exhausted  # messages remain after the gap


def test_disconnect_leaves_no_token_serving_a_pre_gap_price(market_stream_path: Any) -> None:
    """The plan's PR 6 verification, stated as a property.

    We cannot replay the messages the venue sent while we were
    disconnected — it does not offer that. What we CAN guarantee, and
    what actually protects a markout, is that no subscribed token is left
    holding a pre-gap price while presenting itself as live. After the
    cycle every token must carry a quote observed at or after the repair.
    """

    now = {"t": T0}

    def clock() -> datetime:
        return now["t"]

    tokens = [TOKEN_A, TOKEN_B]
    fetcher = RecordedClobFetcher(books=_books_for(tokens, mid="0.60"))
    stream = ReplayMarketStream.from_jsonl(market_stream_path, clock=clock)
    collector, store = _collector(fetcher, stream, clock)

    # Cold start: REST snapshot both tokens.
    result_cold = collector.resync(tokens)
    assert len(result_cold) == 2
    collector._persist(result_cold, stream_connected=False, force=True)  # noqa: SLF001
    pre_gap = {t: store.inner.latest[t].observed_at for t in tokens}

    # Time advances, then the stream drops mid-cycle.
    now["t"] = T0 + timedelta(seconds=30)
    result = collector.run_cycle(tokens)

    assert result.stream_connected is False
    assert result.errors and "stream_closed" in result.errors[0]
    assert result.resyncs >= 1
    assert result.resynced_tokens == len(tokens)

    for t in tokens:
        latest = store.inner.latest[t]
        assert latest.observed_at > pre_gap[t], f"{t} still serving a pre-gap price"
        assert latest.source == SOURCE_RESYNC
        assert collector.books()[t].synced


def test_a_token_whose_repair_fails_stays_silent_and_shows_up_stale(
    market_stream_path: Any,
) -> None:
    """One failing token must not abort the others, and must not keep
    quoting. Going quiet is the correct visible outcome."""

    now = {"t": T0}

    def clock() -> datetime:
        return now["t"]

    tokens = [TOKEN_A, TOKEN_B]
    fetcher = RecordedClobFetcher(books=_books_for(tokens), fail_tokens={TOKEN_B})
    stream = ReplayMarketStream.from_jsonl(market_stream_path, clock=clock)
    collector, store = _collector(fetcher, stream, clock)

    result = collector.run_cycle(tokens)

    assert collector.books()[TOKEN_A].synced
    assert not collector.books()[TOKEN_B].synced
    assert collector.books()[TOKEN_B].quote() is None

    # TOKEN_B has a RECENT quote (the pre-gap websocket snapshot) but a
    # torn book, so an age-only freshness check would report it healthy
    # while no further quote can ever arrive. Both reports must name it.
    assert TOKEN_B in result.desynced_tokens
    assert TOKEN_B in result.stale_tokens
    assert TOKEN_A not in result.desynced_tokens


def test_quotes_seen_before_the_gap_are_not_discarded(market_stream_path: Any) -> None:
    """A mid-iteration StreamClosed must not throw away the observations
    already collected — those are real, and dropping them is the very
    data loss the resync is supposed to prevent."""

    now = {"t": T0}

    def clock() -> datetime:
        return now["t"]

    tokens = [TOKEN_A, TOKEN_B]
    fetcher = RecordedClobFetcher(books=_books_for(tokens))
    stream = ReplayMarketStream.from_jsonl(market_stream_path, clock=clock)
    collector, store = _collector(fetcher, stream, clock)
    collector.run_cycle(tokens)

    ws_quotes = [q for q in store.inner.quotes if q.source == "ws"]
    assert ws_quotes, "pre-gap websocket quotes were dropped on disconnect"


def test_quote_throttle_limits_history_growth_without_losing_the_series() -> None:
    now = {"t": T0}

    def clock() -> datetime:
        return now["t"]

    fetcher = RecordedClobFetcher(books=_books_for([TOKEN_A]))
    messages: list[dict[str, Any]] = [
        {
            "event_type": "book",
            "asset_id": TOKEN_A,
            "market": "0xcond2001",
            "bids": [{"price": "0.40", "size": "10"}],
            "asks": [{"price": "0.42", "size": "10"}],
        }
    ]
    for i in range(1, 6):
        messages.append(
            {
                "event_type": "price_change",
                "asset_id": TOKEN_A,
                "market": "0xcond2001",
                "changes": [{"price": f"0.4{i}", "size": "10", "side": "BUY"}],
            }
        )
    stream = ReplayMarketStream(messages, clock=clock)
    store = InMemoryQuoteStoreAdapter()
    collector = MarketDataCollector(
        clob=ClobClient(fetcher, clock=clock),
        stream=stream,
        store=store,
        config=CollectorConfig(min_quote_interval_s=60.0),
        clock=clock,
    )
    collector.run_cycle([TOKEN_A])
    # The clock never advances in this replay, so the throttle should
    # admit the cold-start snapshot and then suppress the rest.
    assert len(store.inner.quotes) == 1
