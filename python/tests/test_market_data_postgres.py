"""PostgresQuoteStore integration test.

Covers the SQL itself — the append-only conflict rule, the guarded
latest-upsert, and the `price_at` lookup that markouts and CLV read
through. Skipped unless DATABASE_URL is set, so the DB-less `python` CI
job still passes; the in-memory tests cover the same behaviour at the
logic level.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.ingest.clob import SOURCE_HISTORY, SOURCE_RESYNC, SOURCE_WS, Quote
from nbe_theta.ingest.quote_store import PostgresQuoteStore

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresQuoteStore integration test skipped",
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
TOKEN = "pg-tok-1"
COND = "0xpgcond"


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from market_quotes where outcome_token_id like 'pg-tok-%'")
        cur.execute("delete from market_quote_latest where outcome_token_id like 'pg-tok-%'")
    conn.commit()


def _quote(at: datetime, *, bid: str, ask: str, source: str = SOURCE_WS) -> Quote:
    return Quote(
        condition_id=COND,
        outcome_token_id=TOKEN,
        observed_at=at,
        source=source,
        best_bid=Decimal(bid),
        best_ask=Decimal(ask),
    )


def test_history_is_append_only_and_replay_safe() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)

        q = _quote(T0, bid="0.40", ask="0.42")
        assert store.record_quotes([q], stream_connected=True) == 1
        # Re-applying an archived message is the SAME observation, not a
        # correction. It must not append a second row.
        assert store.record_quotes([q], stream_connected=True) == 0
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("select count(*) from market_quotes where outcome_token_id=%s", (TOKEN,))
            assert cur.fetchone()[0] == 1  # type: ignore[index]


def test_the_same_instant_from_two_paths_is_two_observations() -> None:
    """`ws` and `rest_resync` at one instant are genuinely different
    facts — the unique key includes `source` so a repair does not silently
    replace what the stream saw."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)
        store.record_quotes(
            [
                _quote(T0, bid="0.40", ask="0.42", source=SOURCE_WS),
                _quote(T0, bid="0.41", ask="0.43", source=SOURCE_RESYNC),
            ],
            stream_connected=False,
        )
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("select count(*) from market_quotes where outcome_token_id=%s", (TOKEN,))
            assert cur.fetchone()[0] == 2  # type: ignore[index]


def test_latest_never_moves_backwards() -> None:
    """A history backfill running beside the live collector writes older
    rows. The read-model must not regress to them."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)
        store.record_quotes(
            [_quote(T0 + timedelta(hours=1), bid="0.50", ask="0.52")], stream_connected=True
        )
        store.record_quotes(
            [
                Quote(
                    condition_id=COND,
                    outcome_token_id=TOKEN,
                    observed_at=T0,  # older
                    source=SOURCE_HISTORY,
                    mid_price=Decimal("0.10"),
                )
            ],
            stream_connected=False,
        )
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select observed_at, mid from market_quote_latest where outcome_token_id=%s",
                (TOKEN,),
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == T0 + timedelta(hours=1)
        assert Decimal(str(row[1])) == Decimal("0.51")


def test_history_rows_carry_a_mid_with_no_fabricated_spread() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)
        store.record_quotes(
            [
                Quote(
                    condition_id=COND,
                    outcome_token_id=TOKEN,
                    observed_at=T0,
                    source=SOURCE_HISTORY,
                    mid_price=Decimal("0.33"),
                )
            ],
            stream_connected=False,
        )
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select mid, best_bid, best_ask, spread from market_quotes "
                "where outcome_token_id=%s",
                (TOKEN,),
            )
            row = cur.fetchone()
        assert row is not None
        assert Decimal(str(row[0])) == Decimal("0.33")
        # Null, not zero: a zero spread claims a perfectly tight market.
        assert row[1] is None and row[2] is None and row[3] is None


def test_price_at_reads_the_nearest_preceding_quote_and_honours_as_of() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)
        store.record_quotes(
            [
                _quote(T0, bid="0.39", ask="0.41"),
                _quote(T0 + timedelta(minutes=5), bid="0.49", ask="0.51"),
                _quote(T0 + timedelta(minutes=10), bid="0.89", ask="0.91"),
            ],
            stream_connected=True,
        )
        conn.commit()

        assert store.price_at(TOKEN, T0 - timedelta(minutes=1)) is None
        assert store.price_at(TOKEN, T0 + timedelta(minutes=7)) == Decimal("0.5000000000")
        # as_of clamps below the requested instant.
        assert store.price_at(
            TOKEN, T0 + timedelta(minutes=20), as_of=T0 + timedelta(minutes=6)
        ) == Decimal("0.5000000000")


def test_freshness_ages_against_the_supplied_clock() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresQuoteStore(conn)
        store.record_quotes([_quote(T0, bid="0.40", ask="0.42")], stream_connected=True)
        conn.commit()

        rows = store.freshness([TOKEN], now=T0 + timedelta(seconds=90))
        assert len(rows) == 1
        assert rows[0].age_s == pytest.approx(90.0)
        assert rows[0].stream_connected is True
