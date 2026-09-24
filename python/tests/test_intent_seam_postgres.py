"""The Python → TypeScript seam, against a real database.

ADR-0002's central resolution was that Python owns Intelligence and
Signal, TypeScript owns Execution, and "the seam is the durable
`execution_intents` outbox, which already exists". The table has existed
since migration 010, the contracts since PR 2, the consumer since PR 10.
**Nothing had ever written a row.** The executor claimed from a queue no
producer filled.

These tests are the seam's first exercise. Two properties matter most:

1. **The evaluation and its intent are one transaction.** That is the
   guarantee ADR-0002 rejected Redis for, and it had never been
   demonstrated because nothing enqueued. The rollback test is the one
   that proves it rather than assuming it.
2. **Shadow enqueues nothing, and live opens no lot.** Before PR 15
   `mode` only tagged the lot: live would have simulated a fill and
   recorded a position the account does not hold.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from nbe_theta.common.db import connect
from nbe_theta.signals.actions import Fill, group_fills
from nbe_theta.signals.gates import MarketContext, SourceContext
from nbe_theta.signals.intents import build_order_intent, enqueue, intent_dedupe_key
from nbe_theta.signals.pipeline import evaluate_action
from nbe_theta.signals.sizing import PortfolioState
from nbe_theta.signals.store import PostgresSignalStore

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; intent-seam integration test skipped",
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
WALLET = "seam-wallet"
COND = "seam-cond"
TOKEN = "seam-tok"
ACCOUNT = "0xaccount"


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        # NOT by dedupe_key: SourceAction.dedupe_key() is a SHA-256
        # digest, so an intent key is "<64 hex>:<policy>" and never
        # carries the fixture prefix. Key off the payload instead.
        cur.execute(
            "delete from execution_intents where payload->'instrument'->>'condition_id' = %s",
            (COND,),
        )
        cur.execute("delete from shadow_fills where condition_id like 'seam-%'")
        cur.execute("delete from strategy_lots where condition_id like 'seam-%'")
        cur.execute("delete from signal_evaluations where condition_id like 'seam-%'")
        cur.execute("delete from source_actions where condition_id like 'seam-%'")
    conn.commit()


def _action(qty: str = "1000"):  # type: ignore[no-untyped-def]
    fill = Fill(
        wallet=WALLET,
        condition_id=COND,
        outcome_token_id=TOKEN,
        side="BUY",
        price=Decimal("0.40"),
        quantity=Decimal(qty),
        occurred_at=T0,
        tx_hash="0xseam",
    )
    return group_fills(
        [fill],
        detected_at=T0 + timedelta(seconds=20),
        positions_before={(WALLET, TOKEN): Decimal("10000")},
    )[0]


def _market() -> MarketContext:
    return MarketContext(
        condition_id=COND,
        outcome_token_id=TOKEN,
        active=True,
        closed=False,
        resolved=False,
        accepting_orders=True,
        neg_risk=False,
        closes_at=T0 + timedelta(days=7),
        tick_size=Decimal("0.01"),
        min_order_size=Decimal("5"),
        fee_rate=Decimal("0.02"),
        levels=[(Decimal("0.41"), Decimal("500000"))],
        quote_age_s=2.0,
        is_sports=False,
    )


def _source() -> SourceContext:
    return SourceContext(
        wallet=WALLET,
        in_feeder_set=True,
        rank_score=0.9,
        cluster_key="seam-cluster",
        agreeing_clusters=0,
    )


def _portfolio() -> PortfolioState:
    return PortfolioState(
        nav=Decimal("100000"), cash=Decimal("100000"), day_start_nav=Decimal("100000")
    )


def _evaluate(mode: str):  # type: ignore[no-untyped-def]
    return evaluate_action(
        _action(),
        _source(),
        _market(),
        _portfolio(),
        now=T0 + timedelta(seconds=20),
        mode=mode,
    )


def _intents(conn: Any) -> list[tuple[Any, ...]]:
    with conn.cursor() as cur:
        cur.execute(
            "select id, strategy_type, dedupe_key, payload, status "
            "from execution_intents "
            "where payload->'instrument'->>'condition_id' = %s",
            (COND,),
        )
        return list(cur.fetchall())


class TestLiveEnqueues:
    def test_an_accepted_live_evaluation_enqueues_exactly_one_intent(self) -> None:
        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            store = PostgresSignalStore(conn, account_id=ACCOUNT)
            action = _action()
            action_id = store.record_action(action)
            ev = _evaluate("live")
            assert ev.accepted, "fixture must produce an accepted evaluation"
            store.record_evaluation(ev, action_id, emit_intent=True)
            conn.commit()

            rows = _intents(conn)
            assert len(rows) == 1
            _, strategy_type, dedupe_key, payload, status = rows[0]
            assert strategy_type == "wallet_follow"
            # Opaque by design: the producer key is the action's SHA-256
            # digest plus the policy version, so one decision seen twice
            # cannot diverge into two keys.
            assert dedupe_key.endswith(":signal-1")
            assert status == "ready"
            _clean(conn)

    def test_the_payload_is_what_the_executor_expects(self) -> None:
        """The consumer revalidates this payload. A producer that wrote
        a shape the contract does not describe would be discovered after
        the claim, on a row that then has to go to reconciliation_break
        because nobody knows if it reached the venue."""

        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            store = PostgresSignalStore(conn, account_id=ACCOUNT)
            action = _action()
            ev = _evaluate("live")
            store.record_evaluation(ev, store.record_action(action), emit_intent=True)
            conn.commit()

            payload = _intents(conn)[0][3]
            if isinstance(payload, str):  # driver-dependent
                payload = json.loads(payload)

            assert payload["venue"] == "polymarket"
            assert payload["account_id"] == ACCOUNT
            assert payload["side"] == "BUY"
            assert payload["time_in_force"] == "FOK"  # never a resting order
            assert payload["post_only"] is False
            assert payload["instrument"]["condition_id"] == COND
            assert payload["instrument"]["outcome_token_id"] == TOKEN
            assert Decimal(str(payload["quantity"])) > 0
            assert Decimal("0") < Decimal(str(payload["limit_price"])) <= Decimal("1")
            _clean(conn)

    def test_live_opens_no_lot(self) -> None:
        """The bug this PR fixes. `mode` used to tag the lot only, so
        live simulated a fill and recorded a position the account does
        not hold."""

        ev = _evaluate("live")
        assert ev.accepted
        assert ev.lot is None
        assert ev.fill is None
        assert ev.notes.get("live_intent_pending") is True


class TestShadowEnqueuesNothing:
    def test_shadow_writes_no_intent(self) -> None:
        """Shadow has its own fill path, which is the gate's evidence.
        Enqueuing as well would double-count every copied trade."""

        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            store = PostgresSignalStore(conn, account_id=ACCOUNT)
            ev = _evaluate("shadow")
            store.record_evaluation(ev, store.record_action(_action()), emit_intent=False)
            conn.commit()
            assert _intents(conn) == []
            _clean(conn)

    def test_shadow_still_opens_its_lot(self) -> None:
        ev = _evaluate("shadow")
        assert ev.fill is not None
        assert ev.lot is not None
        assert ev.lot.mode == "shadow"


class TestAtomicity:
    def test_rolling_back_loses_the_evaluation_and_the_intent_together(self) -> None:
        """The property ADR-0002 rejected Redis for.

        A queue outside the database cannot join this transaction, so a
        crash between "record the decision" and "enqueue the order"
        either loses an order or duplicates one — and neither is
        detectable afterwards. Here, both vanish or neither does.
        """

        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            store = PostgresSignalStore(conn, account_id=ACCOUNT)
            action = _action()
            action_id = store.record_action(action)
            conn.commit()  # the action is committed; the decision is not

            ev = _evaluate("live")
            store.record_evaluation(ev, action_id, emit_intent=True)
            conn.rollback()

            with conn.cursor() as cur:
                cur.execute(
                    "select count(*) from signal_evaluations where condition_id=%s", (COND,)
                )
                evaluations = cur.fetchone()[0]  # type: ignore[index]
            assert evaluations == 0
            assert _intents(conn) == []
            _clean(conn)

    def test_a_retried_producer_does_not_enqueue_twice(self) -> None:
        """A network glitch mid-insert must not become a second order.

        This drives `enqueue` DIRECTLY rather than calling
        `record_evaluation` twice. The obvious version of this test is
        vacuous: the second `record_evaluation` hits the unique
        constraint on (source_action_id, policy_version), returns a None
        id, and never reaches the enqueue at all — so it proves the
        EVALUATION dedupe and leaves `on conflict (dedupe_key)` on
        execution_intents entirely unexercised. Deleting that clause
        left the suite green until this test was rewritten.
        """

        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            ev = _evaluate("live")
            intent = build_order_intent(ev, account_id=ACCOUNT, now=T0)
            key = intent_dedupe_key(ev)

            with conn.cursor() as cur:
                first = enqueue(cur, intent, dedupe_key=key)
                second = enqueue(cur, intent, dedupe_key=key)
            conn.commit()

            assert first is not None
            assert second is None  # absorbed by the unique constraint
            assert len(_intents(conn)) == 1
            _clean(conn)

    def test_refuses_to_enqueue_without_an_account(self) -> None:
        """An intent against the wrong account should not be reachable
        by forgetting a constructor argument."""

        with connect(os.environ["DATABASE_URL"]) as conn:
            _clean(conn)
            store = PostgresSignalStore(conn)  # no account_id
            action = _action()
            action_id = store.record_action(action)
            ev = _evaluate("live")
            # Matching the guard's own wording, not just "account_id":
            # Pydantic's ValidationError is itself a ValueError and
            # mentions the field name, so a looser match passes whether
            # or not this guard exists.
            with pytest.raises(ValueError, match="construct PostgresSignalStore"):
                store.record_evaluation(ev, action_id, emit_intent=True)
            conn.rollback()
            _clean(conn)


class TestTheIntentItself:
    def test_dedupe_key_separates_policy_versions(self) -> None:
        """Re-evaluating one action under a NEW policy is a genuinely
        different decision; re-running the same policy is not."""

        ev = _evaluate("live")
        first = intent_dedupe_key(ev)
        ev.policy_version = "signal-v2"
        assert intent_dedupe_key(ev) != first

    def test_refuses_to_build_an_intent_for_a_rejected_evaluation(self) -> None:
        """Not a degraded intent — a bug. The caller should never reach
        here."""

        ev = _evaluate("live")
        ev.size = None
        with pytest.raises(ValueError, match="not accepted"):
            build_order_intent(ev, account_id=ACCOUNT, now=T0)

    def test_the_intent_expires_so_a_stale_copy_is_never_placed(self) -> None:
        """Copying is a latency race. An intent that sat in the queue is
        describing a book that no longer exists, and executing it then
        is a new trade nobody decided on."""

        ev = _evaluate("live")
        intent = build_order_intent(ev, account_id=ACCOUNT, now=T0)
        assert intent.expires_at > T0
        assert intent.expires_at <= T0 + timedelta(seconds=300)
