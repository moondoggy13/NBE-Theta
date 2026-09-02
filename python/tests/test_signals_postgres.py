"""PostgresSignalStore integration test (migration 016).

Covers the SQL that keeps the live path safe: the dedupe key that makes
an overlapping re-poll idempotent, and the evaluation rows that carry
every rejection reason.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.signals.actions import Fill, group_fills
from nbe_theta.signals.gates import MarketContext, SourceContext
from nbe_theta.signals.pipeline import evaluate_action
from nbe_theta.signals.sizing import PortfolioState
from nbe_theta.signals.store import PostgresSignalStore

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresSignalStore integration test skipped",
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
WALLET = "pg-src"
COND = "pg-cond"
TOKEN = "pg-tok"


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from shadow_fills where condition_id like 'pg-%'")
        cur.execute("delete from strategy_lots where condition_id like 'pg-%'")
        cur.execute("delete from signal_evaluations where condition_id like 'pg-%'")
        cur.execute("delete from source_actions where condition_id like 'pg-%'")
    conn.commit()


def _action(qty: str = "1000", detected_offset: int = 20):  # type: ignore[no-untyped-def]
    fill = Fill(
        wallet=WALLET,
        condition_id=COND,
        outcome_token_id=TOKEN,
        side="BUY",
        price=Decimal("0.40"),
        quantity=Decimal(qty),
        occurred_at=T0,
        tx_hash="0xpg",
    )
    return group_fills(
        [fill],
        detected_at=T0 + timedelta(seconds=detected_offset),
        positions_before={(WALLET, TOKEN): Decimal("10000")},
    )[0]


def _market(**over: Any) -> MarketContext:
    base: dict[str, Any] = {
        "condition_id": COND,
        "outcome_token_id": TOKEN,
        "active": True,
        "closed": False,
        "resolved": False,
        "accepting_orders": True,
        "neg_risk": False,
        "closes_at": T0 + timedelta(days=7),
        "tick_size": Decimal("0.01"),
        "min_order_size": Decimal("5"),
        "fee_rate": Decimal("0.02"),
        "levels": [(Decimal("0.41"), Decimal("500000"))],
        "quote_age_s": 2.0,
        "is_sports": False,
    }
    base.update(over)
    return MarketContext(**base)


def _source(**over: Any) -> SourceContext:
    base: dict[str, Any] = {
        "wallet": WALLET,
        "in_feeder_set": True,
        "rank_score": 0.9,
        "cluster_key": "pg-cluster",
        "agreeing_clusters": 0,
    }
    base.update(over)
    return SourceContext(**base)


def _portfolio() -> PortfolioState:
    return PortfolioState(
        nav=Decimal("100000"), cash=Decimal("100000"), day_start_nav=Decimal("100000")
    )


def test_an_overlapping_repoll_cannot_create_a_second_action() -> None:
    """The idempotency the whole live path rests on: seeing one decision
    twice must not place the order twice."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresSignalStore(conn)
        action = _action()
        first = store.record_action(action)
        second = store.record_action(action)
        conn.commit()

        assert first is not None
        assert second is None  # already known

        with conn.cursor() as cur:
            cur.execute("select count(*) from source_actions where condition_id=%s", (COND,))
            assert cur.fetchone()[0] == 1  # type: ignore[index]


def test_a_rejected_evaluation_is_persisted_with_its_reason() -> None:
    """Rejections ARE the output early on — a store that kept only
    accepted signals could not produce the histogram the gate needs."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresSignalStore(conn)
        action = _action()
        action_id = store.record_action(action)
        ev = evaluate_action(
            action,
            _source(in_feeder_set=False),
            _market(),
            _portfolio(),
            now=T0 + timedelta(seconds=20),
        )
        store.record_evaluation(ev, action_id)
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select accepted, reject_reason, gates from signal_evaluations "
                "where condition_id=%s",
                (COND,),
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] is False
        assert row[1] == "feeder_member"
        # The full gate picture survives, not just the first failure.
        assert "non_sports" in row[2]


def test_an_accepted_evaluation_writes_a_fill_and_a_lot() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresSignalStore(conn)
        action = _action()
        action_id = store.record_action(action)
        ev = evaluate_action(
            action, _source(), _market(), _portfolio(), now=T0 + timedelta(seconds=20)
        )
        assert ev.accepted, ev.qualification.as_dict()

        evaluation_id = store.record_evaluation(ev, action_id)
        assert ev.lot is not None
        store.record_lot(ev.lot, evaluation_id)
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select filled, vwap, slippage_vs_source from shadow_fills where condition_id=%s",
                (COND,),
            )
            fill = cur.fetchone()
        assert fill is not None and fill[0] is True

        lots = store.open_lots(mode="shadow")
        assert any(lot.condition_id == COND for lot in lots)


def test_summary_reports_fill_rate_and_reject_histogram() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresSignalStore(conn)

        good = _action(qty="1000")
        gid = store.record_action(good)
        store.record_evaluation(
            evaluate_action(
                good, _source(), _market(), _portfolio(), now=T0 + timedelta(seconds=20)
            ),
            gid,
        )

        thin = _action(qty="1001")
        tid = store.record_action(thin)
        store.record_evaluation(
            evaluate_action(
                thin,
                _source(),
                _market(levels=[(Decimal("0.41"), Decimal("1"))]),
                _portfolio(),
                now=T0 + timedelta(seconds=20),
            ),
            tid,
        )
        conn.commit()

        stats = store.shadow_summary()
        assert stats["evaluations"] == 2
        assert stats["accepted"] == 1
        assert isinstance(stats["reject_reasons"], dict)
        assert "depth" in stats["reject_reasons"]
        assert stats["fill_rate"] == 1.0  # one order attempted, one filled
