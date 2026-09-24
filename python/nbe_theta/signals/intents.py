"""The producer half of the execution seam.

ADR-0002's central architectural resolution was one sentence:

> Python owns Intelligence + Signal. TypeScript owns Execution. **The
> seam is the durable `execution_intents` outbox, which already
> exists.**

The outbox table has existed since migration 010. The contracts —
`OrderIntent`, `ExecutionIntentRow` — have existed since PR 2. The
consumer has existed since PR 10 and, since PR 14, is tested against a
real schema. **Nothing had ever written a row.** The executor claimed
from a queue that no producer filled, and the two halves of the system
had never been connected.

This module is that producer.

**Why an intent instead of a simulated fill.** Until now
`evaluate_action` ran the shadow broker in *every* mode and used `mode`
only to tag the lot it opened. In `live` that meant: simulate a fill
against the observed book, open a lot labelled `live` priced from that
simulation, and never place an order. The system would have recorded
positions it did not hold. Live mode now enqueues an intent and opens
no lot — the lot belongs to the executor's real fill, reported back
through `venue_fills`.

**Why the intent is built through the Pydantic model** rather than
assembled as a dict: a malformed payload should fail here, at the
producer, in the transaction that is recording why the intent exists.
The alternative is discovering it in the executor, after the claim, on
a row that must then go to `reconciliation_break` because nobody knows
whether it reached the venue.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from nbe_theta_contracts.markets import OutcomeInstrument
from nbe_theta_contracts.orders import OrderIntent

if TYPE_CHECKING:  # pragma: no cover - import cycle guard only
    from nbe_theta.signals.pipeline import Evaluation

#: How long an unclaimed intent stays worth executing.
#:
#: This is the *signal freshness* deadline, not the venue's order TIF.
#: Copying is a latency race (ADR-0002 §G): an intent that has sat in
#: the queue for minutes is describing a book that no longer exists, and
#: executing it then is a new trade nobody decided on rather than a late
#: copy of one somebody did.
DEFAULT_TTL_SECONDS = 120

#: The venue-side primitive. Bounded fill-or-kill, never a market order
#: and never a resting order — ADR-0001, restated in ADR-0002: a resting
#: copy order is a free option written to the market.
TIME_IN_FORCE = "FOK"

#: Copy trading is `wallet_follow` in the contract's vocabulary.
STRATEGY_TYPE = "wallet_follow"


def build_order_intent(
    ev: Evaluation,
    *,
    account_id: str,
    now: datetime,
    signal_id: uuid.UUID | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    venue: str = "polymarket",
) -> OrderIntent:
    """Turn an accepted, sized evaluation into a contract-valid intent.

    Raises if the evaluation is not actionable. That is deliberate: an
    intent for a signal that did not qualify is not a degraded intent,
    it is a bug, and the caller should never reach here.
    """

    if not ev.accepted or ev.size is None:
        raise ValueError("refusing to build an intent for an evaluation that was not accepted")
    limit_price = ev.qualification.limit_price
    if limit_price is None:  # pragma: no cover - accepted implies a limit
        raise ValueError("accepted evaluation has no limit price")

    return OrderIntent(
        intent_id=uuid.uuid4(),
        venue=venue,  # type: ignore[arg-type]
        account_id=account_id,
        instrument=OutcomeInstrument(
            venue=venue,  # type: ignore[arg-type]
            condition_id=ev.action.condition_id,
            outcome_token_id=ev.action.outcome_token_id,
        ),
        side=ev.action.side,  # type: ignore[arg-type]
        quantity=ev.size.quantity,
        limit_price=limit_price,
        time_in_force=TIME_IN_FORCE,  # type: ignore[arg-type]
        expiration=None,
        post_only=False,
        strategy_type=STRATEGY_TYPE,  # type: ignore[arg-type]
        signal_id=signal_id or uuid.uuid4(),
        expires_at=now + timedelta(seconds=ttl_seconds),
    )


def intent_dedupe_key(ev: Evaluation) -> str:
    """Identity of the *decision*, not of the attempt.

    Derived from the source action's own dedupe key plus the policy
    version, so a producer that retries after a network glitch inserts
    nothing the second time — the unique constraint on
    `execution_intents.dedupe_key` absorbs it.

    Including the policy version is deliberate. Re-evaluating one action
    under a *new* policy is a genuinely different decision and should be
    able to produce its own intent; re-running the same policy over the
    same action must not.
    """

    return f"{ev.action.dedupe_key()}:{ev.policy_version}"


ENQUEUE_SQL = """
  insert into execution_intents
    (strategy_type, dedupe_key, payload, status, available_at, expires_at)
  values (%s, %s, %s::jsonb, 'ready', now(), %s)
  on conflict (dedupe_key) do nothing
  returning id
"""


def enqueue(
    cur: Any,
    intent: OrderIntent,
    *,
    dedupe_key: str,
) -> str | None:
    """Insert one intent. Returns its id, or None if already enqueued.

    **The caller must not commit around this.** It is written to run
    inside the same transaction as the `signal_evaluations` row that
    justifies it — see `PostgresSignalStore.record_evaluation`. That
    atomicity is the entire reason ADR-0002 rejected Redis: a queue
    outside the database cannot join this transaction, so a crash
    between "record the decision" and "enqueue the order" either loses
    an order or duplicates one, and neither is detectable afterwards.

    `on conflict do nothing` makes a producer retry idempotent, in the
    same shape `record_action` already uses for source actions.
    """

    cur.execute(
        ENQUEUE_SQL,
        (
            intent.strategy_type,
            dedupe_key,
            # by_alias/mode="json" so Decimals and UUIDs serialise the
            # way the TypeScript consumer's generated types expect,
            # rather than however Python's json module would guess.
            json.dumps(intent.model_dump(mode="json", by_alias=True)),
            intent.expires_at,
        ),
    )
    row = cur.fetchone()
    return str(row[0]) if row else None


def quantity_as_decimal(intent: OrderIntent) -> Decimal:
    """The order size, for callers reasoning about exposure."""

    return Decimal(str(intent.quantity))
