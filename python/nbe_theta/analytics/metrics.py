"""Skill metrics.

The central correction this module encodes: **a wallet that buys YES at
0.90 and wins 90% of the time has demonstrated no skill.** It matched
the market. Raw directional accuracy is therefore never a headline
metric here — every accuracy-shaped number is benchmarked against the
price the wallet actually paid.

Primary metric — excess payoff per episode:

    excess = realized_payoff − entry_price − fee_rate

where `realized_payoff` ∈ {0, 1} for a settled binary outcome (from the
wallet's directional perspective) and `entry_price` is the
contemporaneous executable price it paid. Positive mean excess = the
wallet bought outcomes cheaper than they turned out to be worth. That
is forecasting edge; hit rate is not.

Deliberately NOT primary:
  * raw hit rate — see above;
  * episode Sharpe — holding periods are irregular, returns are
    non-normal, capital deployment varies, and settlements cluster, so
    the ratio is not comparable across wallets;
  * total P&L — dominated by size, not skill.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from nbe_theta.ingest.quote_store import QuoteLookup
from nbe_theta.ledger.episodes import Episode

ZERO = Decimal("0")

# Markout horizons. Short enough that a move is plausibly attributable to
# the wallet's own information rather than to everything that happened
# afterwards.
MARKOUT_HORIZONS: dict[str, timedelta] = {
    "5m": timedelta(minutes=5),
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
}


@dataclass(frozen=True)
class ScoredEpisode:
    """An episode paired with its settled outcome and derived metrics."""

    episode: Episode
    # 1.0 if the outcome the wallet was long resolved YES (or short → NO).
    realized_payoff: Decimal
    entry_price: Decimal
    fee_rate: Decimal
    event_cluster_id: str | None
    # When this episode's payoff became KNOWABLE — the market's
    # resolution time, not the last fill. Every metric here is a function
    # of realized_payoff, so nothing about this episode is observable
    # before settlement, even if the wallet traded out of it earlier.
    # This is the timestamp the no-look-ahead filter must use.
    settled_at: datetime | None = None

    @property
    def observable_at(self) -> datetime | None:
        """The instant this episode could first be scored."""

        if self.settled_at is not None:
            return self.settled_at
        return self.episode.closed_at

    @property
    def excess_edge(self) -> Decimal:
        """Payoff minus the price paid minus fees — the primary metric."""

        return self.realized_payoff - self.entry_price - self.fee_rate

    @property
    def correct(self) -> bool:
        """Directional correctness. Reported for interpretability only —
        never used alone (a 0.95-priced favorite is trivially 'correct')."""

        return self.realized_payoff > Decimal("0.5")

    @property
    def capital_at_risk(self) -> Decimal:
        return self.episode.maximum_cost

    @property
    def pnl(self) -> Decimal:
        base = self.episode.realized_pnl
        if self.episode.resolution_pnl is not None:
            base += self.episode.resolution_pnl
        return base


def brier_score(forecast: Decimal, outcome: Decimal) -> float:
    """(forecast − outcome)². Lower is better."""

    d = float(forecast) - float(outcome)
    return d * d


def calibration_gap(scored: list[ScoredEpisode]) -> float | None:
    """Realized win rate minus mean price paid — the calibration gap.

    Populates the ``brier_delta`` column. Read it as: "across everything
    this wallet bought, how much more often did those outcomes happen
    than the prices implied?" Zero = the wallet is exactly as good as the
    market it traded against. Positive = it systematically bought
    underpriced outcomes.

    Why not a literal Brier improvement: a Brier comparison needs two
    DIFFERENT forecasts, and we only observe one number — the price the
    wallet paid. Scoring the wallet's price against its own counterparty's
    price is degenerate; the algebra collapses to (2p − 1) on wins, which
    would reward buying 0.95 favorites and punish buying 0.05 longshots —
    precisely inverted from edge. A true Brier delta needs an independent
    probability model as the baseline, which arrives with the news layer
    (PR 10). Until then this gap is the honest, correctly-signed measure.

    It is the aggregate of the same quantity ``excess_edge`` measures
    per-episode (before fees), stated in probability space so it can be
    read as calibration.
    """

    if not scored:
        return None
    realized = sum(float(s.realized_payoff) for s in scored) / len(scored)
    implied = sum(float(s.entry_price) for s in scored) / len(scored)
    return realized - implied


def mean_brier(scored: list[ScoredEpisode]) -> float | None:
    """Mean Brier score of the prices the wallet paid, as a raw
    calibration diagnostic. Lower is better, but do NOT rank wallets on
    it: it is dominated by the price range a wallet trades in, not by
    skill."""

    if not scored:
        return None
    return sum(brier_score(s.entry_price, s.realized_payoff) for s in scored) / len(scored)


def mean_excess_edge(scored: list[ScoredEpisode]) -> float | None:
    if not scored:
        return None
    return float(sum(s.excess_edge for s in scored) / len(scored))


def capital_normalized_pnl(scored: list[ScoredEpisode]) -> float | None:
    """Total P&L divided by total capital at risk.

    Size-independent, unlike raw P&L: a wallet that made $10k on $1M
    deployed is not better than one that made $1k on $10k.
    """

    if not scored:
        return None
    capital = sum(s.capital_at_risk for s in scored)
    if capital <= ZERO:
        return None
    return float(sum(s.pnl for s in scored) / capital)


def profit_concentration(scored: list[ScoredEpisode]) -> float | None:
    """Share of total gross profit from the single best episode.

    A wallet whose entire record is one lucky trade is not a repeatable
    edge; near 1.0 here should veto a Tier-A assignment no matter how
    good the mean looks.
    """

    gains = [float(s.pnl) for s in scored if s.pnl > ZERO]
    if not gains:
        return None
    total = sum(gains)
    if total <= 0:
        return None
    return max(gains) / total


def max_drawdown(scored: list[ScoredEpisode]) -> float | None:
    """Peak-to-trough drawdown of the cumulative P&L curve, in dollars,
    walking episodes in close order."""

    if not scored:
        return None
    ordered = sorted(scored, key=lambda s: s.episode.closed_at or s.episode.opened_at)
    cum = 0.0
    peak = 0.0
    worst = 0.0
    for s in ordered:
        cum += float(s.pnl)
        peak = max(peak, cum)
        worst = min(worst, cum - peak)
    return abs(worst)


def hit_rate(scored: list[ScoredEpisode]) -> float | None:
    """Raw directional accuracy. Reported for the dashboard's benefit,
    never used as a skill input on its own."""

    if not scored:
        return None
    return sum(1 for s in scored if s.correct) / len(scored)


def markout(
    scored: list[ScoredEpisode],
    quotes: QuoteLookup,
    horizon: timedelta,
    *,
    as_of: datetime | None = None,
) -> float | None:
    """Mean price move in the wallet's favor ``horizon`` after entry.

    Answers: did the market move toward this wallet's view shortly after
    it traded? A wallet that is right *eventually* may just be patient; a
    wallet the market agrees with within an hour is more likely to be
    early rather than lucky.

    Episodes with no recorded price at the horizon are skipped, never
    imputed — a missing markout is missing data, and filling it with 0
    would dilute a real edge toward zero while making a wallet with no
    coverage look average instead of unmeasured.

    ``as_of`` clamps the lookup so a scoring run at time T cannot consult
    a quote observed after T, even for an episode whose horizon has since
    elapsed. Without that clamp a walk-forward backtest would quietly
    read the future.

    This used to take ``dict[str, Decimal]`` keyed
    ``condition:token:horizon``. That key could not distinguish two
    episodes on the same token, so a wallet that re-entered a market got
    one forward price for both — at least one of them measured from the
    wrong entry time. Passing the lookup instead makes each episode ask
    about its own ``opened_at``, so the collision is unrepresentable.
    """

    vals: list[float] = []
    for s in scored:
        entry_at = s.episode.opened_at
        fwd = quotes.price_at(s.episode.outcome_token_id, entry_at + horizon, as_of=as_of)
        if fwd is None:
            continue
        move = float(fwd - s.entry_price)
        # A short position profits from a fall.
        vals.append(move if s.episode.direction == "BUY" else -move)
    if not vals:
        return None
    return sum(vals) / len(vals)


def closing_line_value(
    scored: list[ScoredEpisode],
    quotes: QuoteLookup,
    closes: dict[str, datetime],
    *,
    as_of: datetime | None = None,
) -> float | None:
    """Mean edge against the closing line.

    The sports-betting measure, and the single most useful non-outcome
    signal available: beating the closing price is evidence of skill that
    does not depend on how the event happened to resolve. A wallet can
    win a coin flip; it cannot repeatedly buy at 0.40 what the market
    prices at 0.55 by the time it closes without knowing something.

    Per episode: ``closing_price − entry_price``, signed by direction.

    ``closes`` maps ``condition_id`` → market close time. An episode
    whose market has no recorded close is skipped: CLV is undefined
    before there is a closing line, and substituting "the last price we
    happen to have" would silently measure something else.

    Look-ahead: the closing price becomes knowable at close, which is at
    or before settlement — and `ScoredEpisode` is already unscoreable
    until settlement (see ``observable_at``). So CLV introduces no
    observability earlier than the episode already had. The ``as_of``
    clamp is still applied, because "the caller already filtered" is
    exactly the assumption that produced the settlement leak in PR 5.
    """

    vals: list[float] = []
    for s in scored:
        closed_at = closes.get(s.episode.condition_id)
        if closed_at is None:
            continue
        if as_of is not None and closed_at > as_of:
            continue
        close_px = quotes.price_at(s.episode.outcome_token_id, closed_at, as_of=as_of)
        if close_px is None:
            continue
        move = float(close_px - s.entry_price)
        vals.append(move if s.episode.direction == "BUY" else -move)
    if not vals:
        return None
    return sum(vals) / len(vals)


def sharpe_like(scored: list[ScoredEpisode]) -> float | None:
    """Mean/σ of per-episode excess edge.

    Explicitly a SECONDARY diagnostic (see module docstring): irregular
    holding periods and clustered settlements make this non-comparable
    across wallets. Never feed it to tiering as a primary criterion.
    """

    if len(scored) < 2:
        return None
    xs = [float(s.excess_edge) for s in scored]
    mean = sum(xs) / len(xs)
    var = sum((x - mean) ** 2 for x in xs) / (len(xs) - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    return mean / sd
