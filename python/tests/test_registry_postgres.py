"""PostgresStore integration test.

Proves the real SQL (upserts, rule versioning, cursor) against a live
Postgres with the migrations applied. Skipped unless DATABASE_URL is
set, so the DB-less ``python`` CI job passes; run locally or in an
environment with the migrated schema. The in-memory replay tests cover
the same behavior at the logic level; this covers the SQL itself.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.gamma import GammaClient
from nbe_theta.ingest.registry import RegistryIngestor
from nbe_theta.ingest.store import PostgresStore
from tests.conftest import RecordedFetcher, load_fixture

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresStore integration test skipped",
)

VALID_MARKET_IDS = {"1001", "1002", "1010", "1020"}


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from outcomes where venue='polymarket'")
        cur.execute("delete from market_rule_versions where venue='polymarket'")
        cur.execute("delete from markets where venue='polymarket'")
        cur.execute("delete from events where venue='polymarket'")
        cur.execute("delete from ingest_cursors where source='gamma'")
        cur.execute("delete from ingest_runs where source='gamma'")
        cur.execute("delete from raw_objects where source='gamma'")
    conn.commit()


def _count(conn: Any, sql: str) -> int:
    with conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
        return int(row[0]) if row else 0


@pytest.fixture
def pages() -> list[list[dict[str, Any]]]:
    return [load_fixture("gamma_events_page1.json"), load_fixture("gamma_events_page2.json")]


def _run(conn: Any, pages: list[list[dict[str, Any]]], **kw: Any) -> None:
    fetcher = RecordedFetcher(pages, fail_after=kw.pop("fail_after", None))
    client = GammaClient(fetcher, page_limit=kw.pop("page_limit", 2))
    ingestor = RegistryIngestor(client, PostgresStore(conn), InMemoryArchive(), page_limit=2, **kw)
    ingestor.run()


def test_postgres_full_sweep_and_idempotent(pages: list[list[dict[str, Any]]]) -> None:
    url = os.environ["DATABASE_URL"]
    with connect(url) as conn:
        _clean(conn)

        _run(conn, pages)
        markets = _count(conn, "select count(*) from markets where venue='polymarket'")
        rule_versions = _count(
            conn, "select count(*) from market_rule_versions where venue='polymarket'"
        )
        assert markets == len(VALID_MARKET_IDS)
        assert rule_versions == len(VALID_MARKET_IDS)
        # Every market points at a rule version.
        assert _count(
            conn,
            "select count(*) from markets where venue='polymarket' "
            "and current_rule_version_id is not null",
        ) == len(VALID_MARKET_IDS)

        # Re-sweep: idempotent, no new rows.
        _run(conn, pages)
        assert _count(conn, "select count(*) from markets where venue='polymarket'") == markets
        assert (
            _count(conn, "select count(*) from market_rule_versions where venue='polymarket'")
            == rule_versions
        )


def test_postgres_crash_restart_no_duplicates(pages: list[list[dict[str, Any]]]) -> None:
    url = os.environ["DATABASE_URL"]
    with connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("delete from outcomes where venue='polymarket'")
            cur.execute("delete from market_rule_versions where venue='polymarket'")
            cur.execute("delete from markets where venue='polymarket'")
            cur.execute("delete from events where venue='polymarket'")
            cur.execute("delete from ingest_cursors where source='gamma'")
            cur.execute("delete from ingest_runs where source='gamma'")
            cur.execute("delete from raw_objects where source='gamma'")
        conn.commit()

        with pytest.raises(RuntimeError, match="simulated crash"):
            _run(conn, pages, fail_after=1)
        partial = _count(conn, "select count(*) from markets where venue='polymarket'")
        assert 0 < partial < len(VALID_MARKET_IDS)

        # Restart resumes from the persisted cursor; ends with each market once.
        _run(conn, pages)
        assert _count(conn, "select count(*) from markets where venue='polymarket'") == len(
            VALID_MARKET_IDS
        )
        assert _count(
            conn, "select count(*) from market_rule_versions where venue='polymarket'"
        ) == len(VALID_MARKET_IDS)
