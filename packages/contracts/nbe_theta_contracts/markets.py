"""Market registry payloads.

Mirrors the ``events / markets / outcomes / market_rule_versions`` tables
that PR 2 will add. Anything the ingest layer (PR 3) writes must
validate against these types first.
"""


from uuid import UUID

from pydantic import Field

from nbe_theta_contracts.common import ContractBase, EventStatus, UtcDatetime, Venue


class OutcomeInstrument(ContractBase):
    """A tradable outcome token on a venue.

    Used everywhere the executor / signal side needs to identify a
    specific YES/NO share. ``condition_id`` selects the market;
    ``outcome_token_id`` selects the side of it.
    """

    venue: Venue
    condition_id: str = Field(..., min_length=1)
    outcome_token_id: str = Field(..., min_length=1)


class Outcome(ContractBase):
    """A row from a market's outcomes table."""

    venue: Venue
    venue_market_id: str = Field(..., min_length=1)
    outcome_index: int = Field(..., ge=0)
    outcome_name: str = Field(..., min_length=1)
    outcome_token_id: str = Field(..., min_length=1)


class Event(ContractBase):
    """A real-world event that groups related markets."""

    venue: Venue
    venue_event_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    category: str | None = None
    opened_at: UtcDatetime
    closes_at: UtcDatetime | None = None
    status: EventStatus
    raw_object_id: UUID | None = None


class Market(ContractBase):
    """A single market on a venue."""

    venue: Venue
    venue_market_id: str = Field(..., min_length=1)
    venue_event_id: str = Field(..., min_length=1)
    condition_id: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    neg_risk: bool = False
    active: bool
    closed: bool
    resolved: bool
    opened_at: UtcDatetime
    closes_at: UtcDatetime | None = None
    resolved_at: UtcDatetime | None = None
    resolution_source: str | None = None
    current_rule_version_id: UUID | None = None
    outcomes: list[Outcome] = Field(default_factory=list)


class MarketRuleVersion(ContractBase):
    """An observed version of a market's resolution rules.

    We snapshot each observation with a ``rule_hash`` so a mid-market
    rule change becomes a new row rather than an in-place edit.
    """

    id: UUID
    venue: Venue
    venue_market_id: str = Field(..., min_length=1)
    observed_at: UtcDatetime
    rule_hash: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    description: str | None = None
    resolution_source: str | None = None
    close_time: UtcDatetime | None = None
    raw_object_id: UUID | None = None
