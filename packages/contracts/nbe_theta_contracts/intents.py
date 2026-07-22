"""Execution-intent outbox row shape.

Producers (signal generators) insert one of these rows; the executor
claims them with ``FOR UPDATE SKIP LOCKED``. ``dedupe_key`` is unique
per row and lets producers safely retry an insert without duplicating
the intent (e.g. after a network glitch).
"""


from uuid import UUID

from pydantic import Field

from nbe_theta_contracts.common import (
    ContractBase,
    ExecutionIntentStatus,
    IntentStrategyType,
    UtcDatetime,
)
from nbe_theta_contracts.orders import OrderIntent


class ExecutionIntentRow(ContractBase):
    """One row in the ``execution_intents`` table.

    ``payload`` is the nested ``OrderIntent`` that the executor will
    revalidate before submitting. Everything else on this row is
    executor bookkeeping — status transitions, retry counters, claim
    ownership.
    """

    id: UUID
    strategy_type: IntentStrategyType
    dedupe_key: str = Field(..., min_length=1)
    payload: OrderIntent
    status: ExecutionIntentStatus
    available_at: UtcDatetime
    expires_at: UtcDatetime
    attempt_count: int = Field(default=0, ge=0)
    claimed_at: UtcDatetime | None = None
    claimed_by: str | None = None
    last_error: str | None = None
    created_at: UtcDatetime
    updated_at: UtcDatetime
