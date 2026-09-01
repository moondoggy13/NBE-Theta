"""The copy pipeline: source action → gates → sizing → shadow → lots.

One function, `evaluate_action`, does the whole decision for one source
action and returns a record of it whether or not anything happened. That
shape is deliberate: the rejected evaluations are the output early on,
not a byproduct. A pipeline that returned `None` on rejection would
throw away the histogram that tells us whether copying is viable at all.

Order is cheapest-first and fail-fast on cost, not on correctness: gates
run before sizing because a rejected signal should not cost a portfolio
read, but *every* gate is still evaluated so the console shows the whole
picture.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from nbe_theta.signals.actions import SourceAction
from nbe_theta.signals.gates import (
    MarketContext,
    Qualification,
    SignalPolicy,
    SourceContext,
    qualify,
)
from nbe_theta.signals.lots import StrategyLot, open_lot
from nbe_theta.signals.shadow import ShadowConfig, ShadowFill, simulate
from nbe_theta.signals.sizing import (
    PortfolioState,
    RiskPolicy,
    SizeDecision,
    size_entry,
)

ZERO = Decimal("0")


@dataclass
class Evaluation:
    """Everything that happened for one source action."""

    action: SourceAction
    qualification: Qualification
    size: SizeDecision | None = None
    fill: ShadowFill | None = None
    lot: StrategyLot | None = None
    policy_version: str = "signal-1"
    cluster_key: str | None = None
    notes: dict[str, Any] = field(default_factory=dict)

    @property
    def accepted(self) -> bool:
        """Accepted means an order was actually placed (or would have
        been). Passing the gates but being sized to zero is a rejection
        with a different reason, not an acceptance."""

        return self.qualification.accepted and self.size is not None and self.size.actionable

    @property
    def reject_reason(self) -> str | None:
        if not self.qualification.accepted:
            return self.qualification.reject_reason
        if self.size is not None and self.size.skipped_reason:
            return self.size.skipped_reason
        if self.fill is not None and not self.fill.filled:
            return self.fill.reason
        return None


def evaluate_action(
    action: SourceAction,
    source: SourceContext,
    market: MarketContext,
    portfolio: PortfolioState,
    *,
    now: datetime,
    signal_policy: SignalPolicy | None = None,
    risk_policy: RiskPolicy | None = None,
    shadow_config: ShadowConfig | None = None,
    mode: str = "shadow",
    theme_key: str | None = None,
) -> Evaluation:
    """Decide, simulate, and return the whole record."""

    sp = signal_policy or SignalPolicy()
    rp = risk_policy or RiskPolicy()

    qualification = qualify(action, source, market, sp, now=now)
    ev = Evaluation(
        action=action,
        qualification=qualification,
        policy_version=sp.version,
        cluster_key=source.cluster_key,
    )
    if not qualification.accepted or qualification.limit_price is None:
        return ev

    size = size_entry(
        portfolio=portfolio,
        policy=rp,
        limit_price=qualification.limit_price,
        book_depth=qualification.max_quantity_by_depth,
        min_order_size=market.min_order_size,
        rank_score=source.rank_score,
        confidence=source.rank_score,
        condition_id=market.condition_id,
        cluster_key=source.cluster_key,
        theme_key=theme_key,
    )
    ev.size = size
    if not size.actionable:
        return ev

    fill = simulate(
        side=action.side,
        quantity=size.quantity,
        limit_price=qualification.limit_price,
        levels=market.levels,
        fee_rate=market.fee_rate,
        source_price=action.vwap,
        book_age_s=market.quote_age_s,
        config=shadow_config,
    )
    ev.fill = fill
    if not fill.filled or fill.vwap is None:
        return ev

    ev.lot = open_lot(
        mode=mode,
        source_wallet=action.wallet,
        source_cluster_key=source.cluster_key,
        condition_id=market.condition_id,
        outcome_token_id=market.outcome_token_id,
        side=action.side,
        opened_at=now,
        entry_price=fill.vwap,
        quantity=fill.filled_quantity,
        fees=fill.fees,
    )
    return ev


def apply_to_portfolio(portfolio: PortfolioState, ev: Evaluation) -> None:
    """Fold an executed evaluation back into portfolio state.

    Kept separate from `evaluate_action` so evaluation stays pure and a
    dry run cannot accidentally mutate the book it is measuring against.
    """

    if ev.lot is None or ev.fill is None or ev.fill.vwap is None:
        return
    cost = ev.fill.vwap * ev.fill.filled_quantity + ev.fill.fees
    portfolio.cash -= cost
    cid = ev.lot.condition_id
    portfolio.exposure_by_market[cid] = portfolio.exposure_by_market.get(cid, ZERO) + cost
    key = ev.lot.source_cluster_key or ev.lot.source_wallet
    portfolio.exposure_by_cluster[key] = portfolio.exposure_by_cluster.get(key, ZERO) + cost
