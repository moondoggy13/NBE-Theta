"""PostgresWalletStore integration tests.

Proves the real SQL for the wallet path — candidate upsert/promotion,
wallet identity least/greatest merging, and the
``unique(venue, source_trade_id)`` dedupe that makes the backfill
restart-safe. Skipped unless DATABASE_URL is set.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.backfill import WalletBackfillIngestor
from nbe_theta.ingest.dataapi import DataApiClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import PostgresWalletStore
from tests.conftest import RecordedDataApiFetcher, load_fixture

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresWalletStore integration test skipped",
)

WALLET = "0xaaa1000000000000000000000000000000000001"
VALID_TRADE_COUNT = 6


@pytest.fixture
def trade_pages() -> list[list[dict[str, Any]]]:
    return [
        load_fixture("dataapi_trades_page1.json"),
        load_fixture("dataapi_trades_page2.json"),
    ]


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from venue_trades where venue='polymarket'")
        cur.execute("delete from wallet_candidates where chain_id=137")
        cur.execute("delete from wallets where chain_id=137")
        cur.execute("delete from ingest_cursors where source='data-api'")
        cur.execute("delete from ingest_runs where source='data-api'")
        cur.execute("delete from raw_objects where source='data-api'")
    conn.commit()


def _count(conn: Any, sql: str) -> int:
    with conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
        return int(row[0]) if row else 0


def _ingestor(
    conn: Any,
    pages: list[list[dict[str, Any]]],
    *,
    page_limit: int = 2,
    fail_after: int | None = None,
) -> WalletBackfillIngestor:
    fetcher = RecordedDataApiFetcher(trade_pages=pages, fail_after=fail_after)
    return WalletBackfillIngestor(
        DataApiClient(fetcher, page_limit=page_limit),
        PostgresWalletStore(conn),
        InMemoryArchive(),
        RateLimiter(0.0),
        page_limit=page_limit,
    )


def test_postgres_backfill_and_idempotent(trade_pages: list[list[dict[str, Any]]]) -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        _ingestor(conn, trade_pages).backfill_wallet(WALLET)
        assert _count(conn, "select count(*) from venue_trades") == VALID_TRADE_COUNT
        assert _count(conn, f"select count(*) from wallets where address='{WALLET}'") == 1

        # Re-run: the unique(venue, source_trade_id) dedupe holds.
        _ingestor(conn, trade_pages).backfill_wallet(WALLET)
        assert _count(conn, "select count(*) from venue_trades") == VALID_TRADE_COUNT


def test_postgres_backfill_crash_restart_no_duplicates(
    trade_pages: list[list[dict[str, Any]]],
) -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        with pytest.raises(RuntimeError, match="simulated crash"):
            _ingestor(conn, trade_pages, fail_after=1).backfill_wallet(WALLET)
        partial = _count(conn, "select count(*) from venue_trades")
        assert 0 < partial < VALID_TRADE_COUNT

        _ingestor(conn, trade_pages).backfill_wallet(WALLET)
        assert _count(conn, "select count(*) from venue_trades") == VALID_TRADE_COUNT


def test_postgres_candidate_upsert_keeps_max_priority() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresWalletStore(conn)
        from datetime import UTC, datetime

        now = datetime.now(tz=UTC)
        store.upsert_candidate(WALLET, "leaderboard:WEEK:pnl", 0.9, now)
        store.upsert_candidate(WALLET, "leaderboard:WEEK:pnl", 0.4, now)
        store.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select priority_score from wallet_candidates where address=%s and source=%s",
                (WALLET, "leaderboard:WEEK:pnl"),
            )
            row = cur.fetchone()
        assert row is not None
        assert float(row[0]) == 0.9

        # Promotion removes it from the promotable list.
        assert WALLET in store.list_promotable(10)
        store.promote_candidate(WALLET, now)
        store.commit()
        assert WALLET not in store.list_promotable(10)


def test_postgres_wallet_identity_window_merges() -> None:
    from datetime import UTC, datetime

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresWalletStore(conn)
        early = datetime(2027, 1, 1, tzinfo=UTC)
        late = datetime(2027, 6, 1, tzinfo=UTC)
        store.upsert_wallet(WALLET, late, late)
        store.upsert_wallet(WALLET, early, early)
        store.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select first_seen, last_seen from wallets where chain_id=137 and address=%s",
                (WALLET,),
            )
            row = cur.fetchone()
        assert row is not None
        # least(first_seen) / greatest(last_seen) widen the window.
        assert row[0] == early
        assert row[1] == late
