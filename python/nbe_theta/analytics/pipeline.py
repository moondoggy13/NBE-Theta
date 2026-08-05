"""Trades → ledger → episodes → scored episodes.

The assembly seam between the ledger and analytics layers. Two rules
it enforces, both load-bearing for the alpha gate:

1. **Unresolved outcomes are excluded, never imputed.** An episode with
   no settled payoff has no measurable edge. Guessing one (0.5, last
   price, anything) would manufacture signal from ignorance.
2. **Event clusters, not markets.** Episodes carry the market's event
   id, so the bootstrap resamples correlated markets together.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.analytics.store import ResolutionRow
from nbe_theta.ledger.entries import TradeRow, entries_from_trades
from nbe_theta.ledger.episodes import Episode, EpisodeAlgorithm, build_all

# Polymarket's taker fee, applied per episode as a price-space haircut.
# Conservative default: an edge that only survives at zero fees is not
# an edge we can trade.
DEFAULT_FEE_RATE = Decimal("0.02")


@dataclass(frozen=True)
class PipelineStats:
    episodes_built: int
    episodes_scored: int
    episodes_unresolved: int


def _payoff_for(episode: Episode, settled_price: Decimal) -> Decimal:
    """Realized payoff from the wallet's directional perspective.

    Long the token → it pays the settled price. Short → it pays the
    complement (the short profits when the outcome does NOT happen).
    """

    if episode.direction == "BUY":
        return settled_price
    return Decimal("1") - settled_price


def build_scored_episodes(
    trades: list[TradeRow],
    resolutions: list[ResolutionRow],
    *,
    algorithm: EpisodeAlgorithm | None = None,
    fee_rate: Decimal = DEFAULT_FEE_RATE,
) -> tuple[dict[str, list[ScoredEpisode]], PipelineStats]:
    """Full assembly, grouped by wallet."""

    res_by_key = {(r.condition_id, r.outcome_token_id): r for r in resolutions}
    price_map = {k: r.price for k, r in res_by_key.items()}

    entries = entries_from_trades(trades)
    episodes = build_all(entries, algorithm=algorithm, resolutions=price_map)

    per_wallet: dict[str, list[ScoredEpisode]] = {}
    scored_n = 0
    unresolved_n = 0
    for ep in episodes:
        key = (ep.condition_id, ep.outcome_token_id)
        row = res_by_key.get(key)
        if row is None or ep.entry_vwap is None:
            # No settlement (or no entry price) → not measurable. Drop it
            # rather than invent a payoff.
            unresolved_n += 1
            continue
        scored = ScoredEpisode(
            episode=ep,
            realized_payoff=_payoff_for(ep, row.price),
            entry_price=ep.entry_vwap,
            fee_rate=fee_rate,
            event_cluster_id=row.event_cluster_id,
            # Settlement, not last fill — see filter_as_of.
            settled_at=row.resolved_at,
        )
        per_wallet.setdefault(ep.wallet, []).append(scored)
        scored_n += 1

    return per_wallet, PipelineStats(
        episodes_built=len(episodes),
        episodes_scored=scored_n,
        episodes_unresolved=unresolved_n,
    )


def load_and_build(
    store: object,
    as_of: datetime,
    *,
    wallets: list[str] | None = None,
    algorithm: EpisodeAlgorithm | None = None,
    fee_rate: Decimal = DEFAULT_FEE_RATE,
) -> tuple[dict[str, list[ScoredEpisode]], PipelineStats]:
    """Load as_of-bounded inputs from a store and assemble them."""

    trades = store.load_trades(as_of, wallets)  # type: ignore[attr-defined]
    resolutions = store.load_resolutions(as_of)  # type: ignore[attr-defined]
    return build_scored_episodes(trades, resolutions, algorithm=algorithm, fee_rate=fee_rate)
