"""Signal envelope.

Every strategy family (wallet_follow, wallet_cluster_confirmation, …)
emits a SignalEnvelope. The executor does NOT trust ``maximum_loss_usd``
as sizing — it recomputes allowable size from its own risk snapshot.
The signal's role is to declare the trade thesis, freshness deadline,
and evidence lineage; the executor decides how much to actually risk.
"""


from decimal import Decimal
from uuid import UUID

from pydantic import Field

from nbe_theta_contracts.common import (
    ContractBase,
    IntentStrategyType,
    PositiveDecimalStr,
    Side,
    UnitPriceStr,
    UtcDatetime,
)
from nbe_theta_contracts.markets import OutcomeInstrument


class Evidence(ContractBase):
    """One item in a signal's evidence chain.

    ``kind`` is the evidence family (e.g. "wallet_trade", "cluster_agree",
    "news_headline"); ``ref`` is a stable identifier the dashboard can
    dereference (wallet address + tx hash, article URL, etc.). ``weight``
    is the signal's own attribution — how much this evidence contributes
    to the confidence score.
    """

    kind: str = Field(..., min_length=1)
    ref: str = Field(..., min_length=1)
    weight: float = Field(..., ge=0, le=1)
    detail: dict[str, str] = Field(default_factory=dict)


class SignalEnvelope(ContractBase):
    """The wire type a signal generator emits into the signal outbox.

    ``expires_at`` is the freshness deadline (the executor rejects the
    intent if it stales). ``confidence`` is a probability in [0, 1] on
    the signal's own model scale — NOT a calibrated market probability.

    Note: ``maximum_price`` and ``maximum_loss_usd`` are DECLARED by the
    signal but ENFORCED by the executor's own risk snapshot; sizes here
    are advisory, not authoritative.
    """

    signal_id: UUID
    strategy_type: IntentStrategyType
    market: OutcomeInstrument
    direction: Side
    maximum_price: UnitPriceStr = Field(..., gt=Decimal("0"), le=Decimal("1"))
    maximum_loss_usd: PositiveDecimalStr = Field(..., gt=Decimal("0"))
    expires_at: UtcDatetime
    confidence: float = Field(..., ge=0, le=1)
    evidence: list[Evidence] = Field(default_factory=list)
    model_version: str = Field(..., min_length=1)
    created_at: UtcDatetime
