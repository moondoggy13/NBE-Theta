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
# float drift. On the wire, it's a JSON *string* matching the regex
# below. Ajv on the TS side validates the same regex.
#
# The pattern accepts an optional leading minus, at least one digit,
# and an optional decimal part with at least one digit. It intentionally
# rejects trailing periods (``"1."``) and empty fractional parts
# (``".5"``) — those are ambiguous and produce round-trip drift.
_DECIMAL_PATTERN = r"^-?\d+(\.\d+)?$"

DecimalStr = Annotated[
    Decimal,
    PlainSerializer(lambda v: format(v, "f"), return_type=str),
    WithJsonSchema(
        {
            "type": "string",
            "format": "decimal",
            "pattern": _DECIMAL_PATTERN,
        }
    ),
]
"""Wire-safe Decimal.

Serializes to a fixed-point string; validates against the shared regex.
Use this everywhere a monetary or share quantity crosses the wire.
"""

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

    schema_version: str = Field(
        default=SCHEMA_VERSION,
        description="Schema version of this payload; consumers reject on mismatch.",
    )
