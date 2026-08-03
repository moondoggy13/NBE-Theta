"""nbe_theta_contracts — durable-payload contracts.

Every module here holds Pydantic v2 models that are the source of truth
for one payload family. JSON Schema files are emitted to
``packages/contracts/schemas/`` and TypeScript types are generated to
``packages/contracts/generated/ts/``.
"""

from nbe_theta_contracts._version import SCHEMA_VERSION
from nbe_theta_contracts.common import (
    ContractBase,
    DecimalStr,
    EventStatus,
    ExecutionIntentStatus,
    IntentStrategyType,
    NonNegativeDecimalStr,
    OrderStatus,
    PositiveDecimalStr,
    Side,
    TimeInForce,
    UnitIntervalStr,
    UnitPriceStr,
    UtcDatetime,
    Venue,
)
from nbe_theta_contracts.intel import VenueTrade, WalletPositionSnapshot
from nbe_theta_contracts.intents import ExecutionIntentRow
from nbe_theta_contracts.markets import (
    Event,
    Market,
    MarketRuleVersion,
    Outcome,
    OutcomeInstrument,
)
from nbe_theta_contracts.orders import (
    ExecutionReport,
    OrderIntent,
    VenueFill,
    VenueOrder,
    VenueOrderEvent,
)
from nbe_theta_contracts.positions import VenueAccountState, VenuePosition
from nbe_theta_contracts.signals import Evidence, SignalEnvelope

__all__ = [
    "SCHEMA_VERSION",
    "ContractBase",
    "DecimalStr",
    "Event",
    "EventStatus",
    "Evidence",
    "ExecutionIntentRow",
    "ExecutionIntentStatus",
    "ExecutionReport",
    "IntentStrategyType",
    "Market",
    "MarketRuleVersion",
    "NonNegativeDecimalStr",
    "OrderIntent",
    "OrderStatus",
    "Outcome",
    "OutcomeInstrument",
    "PositiveDecimalStr",
    "Side",
    "SignalEnvelope",
    "TimeInForce",
    "UnitIntervalStr",
    "UnitPriceStr",
    "UtcDatetime",
    "Venue",
    "VenueAccountState",
    "VenueFill",
    "VenueOrder",
    "VenueOrderEvent",
    "VenuePosition",
    "VenueTrade",
    "WalletPositionSnapshot",
]
