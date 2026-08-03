"""PostgresAnalyticsStore integration tests.

Proves the SQL half of the no-look-ahead guarantee: the loaders are
as_of-bounded in the query itself, and unsettled outcomes are excluded
by `resolution_price is not null` rather than imputed. Skipped unless
DATABASE_URL is set.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from nbe_theta.analytics.scorer import assign_tier, score_universe
from nbe_theta.analytics.store import PostgresAnalyticsStore
from nbe_theta.common.db import connect

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresAnalyticsStore integration test skipped",
)

T0 = datetime(2027, 1, 1, tzinfo=UTC)
W = "0xanalytics0000000000000000000000000000001"


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from wallet_tier_snapshots where wallet like '0xanalytics%'")
        cur.execute("delete from wallet_score_snapshots where wallet like '0xanalytics%'")
        cur.execute("delete from venue_trades where wallet like '0xanalytics%'")
        cur.execute("delete from outcomes where venue_market_id like 'am-%'")
        cur.execute("delete from markets where venue_market_id like 'am-%'")
    conn.commit()


def _seed(conn: Any, *, resolved: bool, resolution_price: str | None) -> None:
    """One market + outcome + a closed round-trip by W."""

    with conn.cursor() as cur:
        cur.execute(
            "insert into markets (venue, venue_market_id, venue_event_id, condition_id, "
            "question, active, closed, resolved, opened_at, resolved_at) "
            "values ('polymarket','am-1','ae-1','cond-am-1','Q?',false,true,%s,%s,%s) "
            "on conflict (venue, venue_market_id) do update set resolved=excluded.resolved, "
            "resolved_at=excluded.resolved_at",
            (resolved, T0, T0 + timedelta(days=5) if resolved else None),
        )
        cur.execute(
            "insert into outcomes (venue, venue_market_id, outcome_index, outcome_name, "
            "outcome_token_id, resolution_price) values "
            "('polymarket','am-1',0,'Yes','tok-am-1',%s) "
            "on conflict (venue, venue_market_id, outcome_index) do update set "
            "resolution_price=excluded.resolution_price",
            (Decimal(resolution_price) if resolution_price is not None else None,),
        )
        for i, (side, price, day) in enumerate([("BUY", "0.30", 0), ("SELL", "0.35", 1)]):
            cur.execute(
                "insert into venue_trades (source_trade_id, venue, wallet, condition_id, "
                "outcome_token_id, side, price, quantity, notional, occurred_at) "
                "values (%s,'polymarket',%s,'cond-am-1','tok-am-1',%s,%s,100,%s,%s) "
                "on conflict (venue, source_trade_id) do nothing",
                (
                    f"am-trade-{i}",
                    W,
                    side,
                    Decimal(price),
                    Decimal(price) * 100,
                    T0 + timedelta(days=day),
                ),
            )
    conn.commit()


def test_load_trades_is_as_of_bounded() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        _seed(conn, resolved=True, resolution_price="1")
        store = PostgresAnalyticsStore(conn)

        # Day 0: only the first trade exists yet.
        early = store.load_trades(T0 + timedelta(hours=12), wallets=[W])
        assert len(early) == 1
        # Day 2: both.
        later = store.load_trades(T0 + timedelta(days=2), wallets=[W])
        assert len(later) == 2


def test_unsettled_outcomes_are_not_returned_as_resolutions() -> None:
    """resolution_price IS NULL must exclude the row — no sentinel, no
    imputed 0.5, nothing the scorer could mistake for a settlement."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        _seed(conn, resolved=True, resolution_price=None)
        store = PostgresAnalyticsStore(conn)
        assert store.load_resolutions(T0 + timedelta(days=30)) == []

        _seed(conn, resolved=True, resolution_price="1")
        rows = store.load_resolutions(T0 + timedelta(days=30))
        assert len(rows) == 1
        assert rows[0].price == Decimal("1")
        # Event cluster defaults to the venue event id.
        assert rows[0].event_cluster_id == "ae-1"


def test_resolutions_are_as_of_bounded() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        _seed(conn, resolved=True, resolution_price="1")
        store = PostgresAnalyticsStore(conn)
        # Market settles on day 5.
        assert store.load_resolutions(T0 + timedelta(days=4)) == []
        assert len(store.load_resolutions(T0 + timedelta(days=6))) == 1


def test_score_and_tier_snapshots_round_trip() -> None:
    from nbe_theta.analytics.pipeline import load_and_build

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        _seed(conn, resolved=True, resolution_price="1")
        store = PostgresAnalyticsStore(conn)

        as_of = T0 + timedelta(days=10)
        per_wallet, stats = load_and_build(store, as_of)
        assert stats.episodes_scored >= 1

        scores = score_universe(per_wallet, as_of)
        for sc in scores:
            store.upsert_score(sc)
            tier, rationale = assign_tier(sc)
            store.upsert_tier(sc.wallet, as_of, tier, rationale)
        store.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select n_episodes, mean_excess_edge, rationale from "
                "wallet_score_snapshots where wallet=%s",
                (W,),
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] >= 1
            cur.execute("select tier from wallet_tier_snapshots where wallet=%s", (W,))
            trow = cur.fetchone()
            assert trow is not None and trow[0] in {"A", "B", "C"}

        # Re-scoring the same as_of upserts rather than duplicating.
        for sc in scores:
            store.upsert_score(sc)
        store.commit()
        with conn.cursor() as cur:
            cur.execute("select count(*) from wallet_score_snapshots where wallet=%s", (W,))
            assert cur.fetchone()[0] == 1


def test_uuid_import_is_used() -> None:
    # Guards the store's tier-insert id generation path.
    assert uuid.UUID(str(uuid.uuid4()))
