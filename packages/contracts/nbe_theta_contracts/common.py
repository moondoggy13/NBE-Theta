"""Shared primitives: enums, base class, wire conventions.

Design choices:

- Enums are ``Literal[...]`` unions rather than ``Enum`` classes. JSON
  Schema output is cleaner and consumers on both sides (Ajv on TS,
  Pydantic on Python) get better error messages.
- ``ContractBase`` freezes model config so every payload is immutable
  after construction (safer as a wire type) and forbids extras (a
  producer that emits an unknown field is a bug, not a compatibility
  window we silently accept).
- Every durable payload includes ``schema_version`` — inherited from
  ``ContractBase`` — so consumers can reject on mismatch.
"""

import re
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, WithJsonSchema

from nbe_theta_contracts._version import SCHEMA_VERSION

# ── Enums ─────────────────────────────────────────────────────────

Venue = Literal["polymarket"]
"""Prediction-market venue identifier. Kept as a Literal so adding a
second venue (e.g. Kalshi) is an explicit contract change with a
schema-version bump."""

Side = Literal["BUY", "SELL"]

TimeInForce = Literal["GTC", "GTD", "FOK", "FAK"]
"""GTC=good-til-canceled, GTD=good-til-date, FOK=fill-or-kill,
FAK=fill-and-kill."""

EventStatus = Literal["active", "closed", "resolved"]

# Full order lifecycle. Mirrors the state machine in
# docs/adr/0001-polymarket-pivot.md and the plan file.
OrderStatus = Literal[
    "pending",
    "signed",
    "submitted",
    "live",
    "partially_filled",
    "cancel_pending",
    "canceled",
    "filled",
    "rejected",
    "expired",
]

# Outbox row state. Broader than OrderStatus because it covers
# pre-signing (risk approval) and post-fill (settlement/reconcile).
ExecutionIntentStatus = Literal[
    "ready",
    "claimed",
    "risk_approved",
    "risk_rejected",
    "signed",
    "submitted",
    "live",
    "partially_filled",
    "cancel_pending",
    "canceled",
    "filled",
    "rejected",
    "expired",
    "settlement_pending",
    "settled",
    "reconciliation_break",
]

IntentStrategyType = Literal[
    "wallet_follow",
    "wallet_cluster_confirmation",
    "fast_information_alert",
    "news_probability",
    "market_microstructure",
    "future_cross_venue_arbitrage",
]

# ── Money ─────────────────────────────────────────────────────────

# On the Python side, money is a ``Decimal`` — safe arithmetic, no
# float drift. On the wire, it's a JSON *string* matching one of the
# regexes below. Ajv on the TS side validates the same regexes.
#
# IMPORTANT — why FOUR types instead of one: ``WithJsonSchema`` REPLACES
# the field's entire emitted JSON Schema, so per-field constraints like
# ``Field(gt=0, le=1)`` never reach the generated schemas. JSON Schema
# cannot numerically compare strings, so the only way the TS consumer
# can enforce bounds is to encode them in the regex itself. Each type
# below pairs a bound-encoding pattern (wire/consumer enforcement) with
# the Field(gt/le/ge) constraints kept on the models (Python producer
# enforcement). BOTH layers must stay in sync — if you change a bound
# on a model field, change the annotated type too.
#
# All patterns intentionally reject trailing periods (``"1."``), empty
# fractional parts (``".5"``), and non-canonical zero-padded forms
# (``"01"``, ``"00.5"``) — the canonical serializer below never emits
# them, and the consumer fails closed on hand-crafted payloads.


def _canonical_decimal(v: Decimal) -> str:
    """Fixed-point serialization with negative-zero normalized.

    ``Decimal("-0.0")`` passes a ``ge=0`` Pydantic check (it equals 0)
    but ``format(..., "f")`` would emit ``"-0.0"``, which the unsigned
    patterns reject. Normalize so producer output always passes the
    consumer.
    """

    return format(abs(v) if v == 0 else v, "f")


_DECIMAL_SERIALIZER = PlainSerializer(_canonical_decimal, return_type=str)

# Signed decimal: optional minus, no bounds. Use ONLY where a value is
# legitimately signed (e.g. VenuePosition.shares).
_DECIMAL_PATTERN = r"^-?(0|[1-9]\d*)(\.\d+)?$"

# > 0 (strictly positive; rejects all-zero values like "0", "0.0").
_POSITIVE_PATTERN = r"^(?!0+(\.0+)?$)(0|[1-9]\d*)(\.\d+)?$"

# >= 0 (unsigned; "0" and "0.0" are fine).
_NON_NEGATIVE_PATTERN = r"^(0|[1-9]\d*)(\.\d+)?$"

# (0, 1] — a probability-space price: "0.43", "1", "1.0" pass;
# "0", "0.0", "1.5", "-0.4" fail. The closed upper bound is the
# trickiest edge: 1 with only zero decimals is allowed.
_UNIT_PRICE_PATTERN = r"^(?!0(\.0+)?$)(0(\.\d+)?|1(\.0+)?)$"


def _decimal_type(pattern: str) -> object:
    return WithJsonSchema({"type": "string", "format": "decimal", "pattern": pattern})


DecimalStr = Annotated[Decimal, _DECIMAL_SERIALIZER, _decimal_type(_DECIMAL_PATTERN)]
"""Wire-safe SIGNED Decimal. Only for legitimately signed quantities."""

PositiveDecimalStr = Annotated[Decimal, _DECIMAL_SERIALIZER, _decimal_type(_POSITIVE_PATTERN)]
"""Wire-safe Decimal > 0 (quantities, loss budgets). Pair with Field(gt=0)."""

NonNegativeDecimalStr = Annotated[Decimal, _DECIMAL_SERIALIZER, _decimal_type(_NON_NEGATIVE_PATTERN)]
"""Wire-safe Decimal >= 0 (fees, balances, fills). Pair with Field(ge=0)."""

UnitPriceStr = Annotated[Decimal, _DECIMAL_SERIALIZER, _decimal_type(_UNIT_PRICE_PATTERN)]
"""Wire-safe Decimal in (0, 1] — prediction-market outcome prices.
Pair with Field(gt=0, le=1)."""

# ── Base ──────────────────────────────────────────────────────────


class ContractBase(BaseModel):
    """Base for every durable payload.

    - ``schema_version`` defaults to the package-wide constant so
      producers don't have to think about it. Consumers still validate.
    - ``frozen=True`` — models are immutable after construction.
    - ``extra="forbid"`` — an unknown field is an error. If we ever want
      backward-compat we do it via schema-version bumps, not silent
      acceptance.
    - ``populate_by_name=True`` — accept both snake_case and any future
      alias without changing wire keys.
    """

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    # The exact-match pattern is what makes "consumers reject on
    # mismatch" TRUE rather than aspirational: Pydantic enforces it on
    # the producer side, and it flows into the emitted JSON Schema so
    # Ajv enforces it on the consumer side. A version bump in
    # _version.py automatically retargets the pin everywhere on the
    # next regeneration.
    schema_version: str = Field(
        default=SCHEMA_VERSION,
        pattern=rf"^{re.escape(SCHEMA_VERSION)}$",
        description="Schema version of this payload; consumers reject on mismatch.",
    )
