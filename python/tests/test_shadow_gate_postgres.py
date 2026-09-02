"""Shadow-gate evidence collection against real Postgres (migration 018).

The pure decision logic is covered in `test_shadow_gate.py`. What is
tested here is the half that cannot be: whether the SQL actually finds
what the criteria assume it found. Two things in particular, because
both are silent when wrong:

* **the duplicate queries.** A duplicate-detection query that matches
  nothing looks identical to a clean system. So this file inserts a real
  duplicate — one source action carrying two accepted evaluations under
  two policy versions, which is what a mid-run policy bump produces —
  and asserts the collector finds it.
* **the settled/open split.** A query that swept open lots into the P&L
  would report a profit the book has not made.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.signals.gate import INSUFFICIENT, PASS
from nbe_theta.signals.gate_store import collect, latest_passing, record, run_gate

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; shadow-gate integration test skipped",
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
START = T0 - timedelta(days=31)
END = T0 + timedelta(days=1)
PFX = "sg-"


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from shadow_fills where condition_id like 'sg-%'")
        cur.execute("delete from strategy_lots where condition_id like 'sg-%'")
        cur.execute("delete from signal_evaluations where condition_id like 'sg-%'")
        cur.execute("delete from source_actions where condition_id like 'sg-%'")
        cur.execute("delete from reconciliation_breaks where description like 'sg-%'")
        cur.execute("delete from shadow_gate_runs where created_by = 'sg-test'")
    conn.commit()


def _action(conn: Any, *, key: str, latency_s: int) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "insert into source_actions (wallet, condition_id, outcome_token_id, side, "
            "dedupe_key, quantity, notional, vwap, first_fill_at, last_fill_at, detected_at) "
            "values ('sg-w','sg-cond','sg-tok','BUY',%s,100,40,0.4,%s,%s,%s) returning id",
            (key, T0, T0, T0 + timedelta(seconds=latency_s)),
        )
        return str((cur.fetchone() or [""])[0])


def _evaluation(
    conn: Any, *, action_id: str | None, accepted: bool, version: str, reason: str | None = None
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "insert into signal_evaluations (source_action_id, wallet, condition_id, "
            "outcome_token_id, side, evaluated_at, policy_version, accepted, reject_reason) "
            "values (%s,'sg-w','sg-cond','sg-tok','BUY',%s,%s,%s,%s) returning id",
            (action_id, T0, version, accepted, reason),
        )
        return str((cur.fetchone() or [""])[0])


def _lot(conn: Any, *, evaluation_id: str | None, status: str, pnl: str, qty_open: str) -> str:
    lot_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "insert into strategy_lots (id, mode, source_wallet, signal_evaluation_id, "
            "condition_id, outcome_token_id, side, opened_at, entry_price, quantity_opened, "
            "quantity_open, realized_pnl, status) "
            "values (%s,'shadow','sg-w',%s,'sg-cond','sg-tok','BUY',%s,0.4,100,%s,%s,%s)",
            (lot_id, evaluation_id, T0, qty_open, pnl, status),
        )
    return lot_id


def _fill(conn: Any, *, evaluation_id: str, filled: bool, reason: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into shadow_fills (signal_evaluation_id, condition_id, outcome_token_id, "
            "side, attempted_at, filled, fill_reason, requested_quantity, filled_quantity, "
            "limit_price, slippage_vs_source) "
            "values (%s,'sg-cond','sg-tok','BUY',%s,%s,%s,100,%s,0.42,0.005)",
            (evaluation_id, T0, filled, reason, 100 if filled else 0),
        )


def test_collect_splits_settled_from_open() -> None:
    """Open lots are counted and reported, never added to realised P&L."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        a = _action(conn, key=f"{PFX}a1", latency_s=10)
        e = _evaluation(conn, action_id=a, accepted=True, version="v1")
        _lot(conn, evaluation_id=e, status="settled", pnl="25", qty_open="0")
        _lot(conn, evaluation_id=None, status="closed", pnl="-5", qty_open="0")
        _lot(conn, evaluation_id=None, status="open", pnl="0", qty_open="100")
        conn.commit()

        ev = collect(conn, window_start=START, window_end=END)
        assert len(ev.settled_lots) == 2
        assert sum(lot.realized_pnl for lot in ev.settled_lots) == 20
        assert ev.lots_opened == 3
        assert ev.lots_open == 1
        # 0.4 entry * 100 open — reported, and deliberately not P&L.
        assert ev.open_cost_basis == 40
        _clean(conn)


def test_collect_finds_a_real_duplicate() -> None:
    """One source action, two accepted evaluations under two policy
    versions — what a mid-run policy bump produces, and the shape the
    unique constraint does NOT stop."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        a = _action(conn, key=f"{PFX}dup", latency_s=10)
        _evaluation(conn, action_id=a, accepted=True, version="v1")
        _evaluation(conn, action_id=a, accepted=True, version="v2")
        conn.commit()

        ev = collect(conn, window_start=START, window_end=END)
        kinds = {d.kind for d in ev.duplicates}
        assert "multiple_accepted_evaluations" in kinds
        assert ev.qualified_signals == 2
        _clean(conn)


def test_collect_finds_two_lots_from_one_evaluation() -> None:
    """Nothing in the schema constrains this, so the query has to."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        a = _action(conn, key=f"{PFX}two-lots", latency_s=10)
        e = _evaluation(conn, action_id=a, accepted=True, version="v1")
        _lot(conn, evaluation_id=e, status="open", pnl="0", qty_open="100")
        _lot(conn, evaluation_id=e, status="open", pnl="0", qty_open="100")
        conn.commit()

        ev = collect(conn, window_start=START, window_end=END)
        assert any(d.kind == "multiple_lots_per_evaluation" for d in ev.duplicates)
        _clean(conn)


def test_collect_reads_latency_reject_and_fill_histograms() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        a1 = _action(conn, key=f"{PFX}h1", latency_s=12)
        _action(conn, key=f"{PFX}h2", latency_s=300)
        e1 = _evaluation(conn, action_id=a1, accepted=True, version="v1")
        _evaluation(conn, action_id=None, accepted=False, version="v1", reason="price_cap")
        _evaluation(conn, action_id=None, accepted=False, version="v1", reason="price_cap")
        _evaluation(conn, action_id=None, accepted=False, version="v1", reason="depth")
        _fill(conn, evaluation_id=e1, filled=True, reason="filled")
        conn.commit()

        ev = collect(conn, window_start=START, window_end=END)
        assert sorted(ev.detection_latencies) == [12.0, 300.0]
        assert ev.reject_reasons == {"price_cap": 2, "depth": 1}
        assert ev.fill_reasons == {"filled": 1}
        assert ev.filled_orders == 1
        assert ev.slippages == [0.005]
        assert ev.policy_versions == ["v1"]
        _clean(conn)


def test_unresolved_incidents_are_not_windowed() -> None:
    """A break opened long before the shadow window still means local
    state and venue truth disagree now."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        with conn.cursor() as cur:
            cur.execute(
                "insert into reconciliation_breaks (detected_at, scope, description) "
                "values (%s, 'orders', 'sg-ancient drift')",
                (START - timedelta(days=400),),
            )
            cur.execute(
                "insert into reconciliation_breaks (detected_at, scope, description, resolved_at) "
                "values (%s, 'orders', 'sg-fixed one', %s)",
                (START - timedelta(days=400), T0),
            )
        conn.commit()

        ev = collect(conn, window_start=START, window_end=END)
        descriptions = {i["description"] for i in ev.unresolved_incidents}
        assert "sg-ancient drift" in descriptions
        assert "sg-fixed one" not in descriptions
        _clean(conn)


def test_an_empty_window_records_as_insufficient_not_pass() -> None:
    """End to end, through the real tables: nothing happened, and the
    packet must not say that is fine."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        packet = run_gate(conn, window_days=30, now=T0)
        assert packet.verdict == INSUFFICIENT
        assert not packet.passed

        run_id = record(conn, packet, note="sg empty window", created_by="sg-test")
        conn.commit()
        assert run_id

        # And the promotion query must not see it.
        with conn.cursor() as cur:
            cur.execute(
                "select verdict from shadow_gate_runs where id = %s",
                (run_id,),
            )
            assert (cur.fetchone() or [""])[0] == INSUFFICIENT
        _clean(conn)


def test_latest_passing_only_sees_passing_packets() -> None:
    """The query `/api/console/mode` enforces against. If it returned the
    newest packet of any verdict, an insufficient run would authorise
    live trading."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        with conn.cursor() as cur:
            for verdict, when in [
                (PASS, T0 - timedelta(days=2)),
                (INSUFFICIENT, T0),
            ]:
                cur.execute(
                    "insert into shadow_gate_runs (evaluated_at, window_start, window_end, "
                    "verdict, created_by) values (%s,%s,%s,%s,'sg-test')",
                    (when, START, END, verdict),
                )
        conn.commit()

        found = latest_passing(conn)
        assert found is not None
        assert found["evaluated_at"].startswith("2027-05-30")
        _clean(conn)
