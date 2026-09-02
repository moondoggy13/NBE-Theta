"""Wallet scoring at a point in time.

**The no-look-ahead contract.** Every score is computed `as_of` an
explicit timestamp, and the only inputs allowed are facts that were
observable at that instant: episodes that had already closed, and
resolutions that had already settled. This is not a nicety — walk-forward
validation is worthless if a score at T quietly used a resolution from
T+30, and that leak is invisible in the output. So the filter lives in
one place (`filter_as_of`), is applied before any metric runs, and is
asserted by a dedicated test.

Skill and confidence are deliberately stored as SEPARATE scores. A
wallet with a huge edge over 6 episodes and one with a modest edge over
600 must not collapse to the same number; tiering reads both.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from nbe_theta.analytics import metrics as M
from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.analytics.statistics import (
    BootstrapResult,
    benjamini_hochberg,
    bh_q_values,
    effective_events,
    event_block_bootstrap,
    fit_population_prior,
    one_sided_p_value,
    posterior_accuracy,
)
from nbe_theta.ingest.quote_store import QuoteLookup

MODEL_VERSION = "wallet-skill-0.1.0"
POPULATION_VERSION = "pop-0.1.0"


@dataclass
class WalletScore:
    wallet: str
    as_of: datetime
    model_version: str
    population_version: str
    n_fills: int
    n_episodes: int
    n_effective_events: float | None
    posterior_accuracy_mean: float | None
    posterior_accuracy_lcb: float | None
    mean_excess_edge: float | None
    edge_lcb: float | None
    brier_delta: float | None
    clv: float | None
    markout_5m: float | None
    markout_1h: float | None
    markout_24h: float | None
    drawdown: float | None
    profit_concentration: float | None
    fdr_q: float | None
    out_of_sample_score: float | None
    skill_score: float | None
    confidence_score: float | None
    rationale: dict[str, Any] = field(default_factory=dict)


def filter_as_of(scored: list[ScoredEpisode], as_of: datetime) -> list[ScoredEpisode]:
    """Keep only episodes fully observable at ``as_of``.

    Observability is the SETTLEMENT time, not the last fill. Every metric
    here is a function of ``realized_payoff``, which does not exist until
    the market resolves — so even an episode the wallet traded out of in
    January is unscoreable until the market settles in March. Filtering
    on ``closed_at`` instead would import a future outcome into a past
    score, and walk-forward validation cannot detect that after the fact.
    """

    out: list[ScoredEpisode] = []
    for s in scored:
        observable = s.observable_at
        if observable is None or observable > as_of:
            continue
        if s.episode.opened_at > as_of:
            continue
        out.append(s)
    return out


def _markout(
    scored: list[ScoredEpisode],
    quotes: QuoteLookup | None,
    horizon_key: str,
    as_of: datetime,
) -> float | None:
    """Markout at a named horizon, or None when there is no price source.

    None means "not measured", not "no edge". Callers persist it as SQL
    NULL for exactly that reason — a 0.0 here would be indistinguishable
    from a wallet the market never moved toward.
    """

    if quotes is None:
        return None
    return M.markout(scored, quotes, M.MARKOUT_HORIZONS[horizon_key], as_of=as_of)


def score_wallet(
    wallet: str,
    scored: list[ScoredEpisode],
    as_of: datetime,
    *,
    prior: tuple[float, float],
    quotes: QuoteLookup | None = None,
    market_closes: dict[str, datetime] | None = None,
    seed: int = 12345,
) -> WalletScore:
    """Score one wallet from its already-as_of-filtered episodes.

    ``quotes`` supplies the price history that markouts and closing-line
    value are computed from (PR 6). It is optional: with no quote
    coverage those columns stay null, which is the honest answer — they
    are unmeasured, not zero. ``market_closes`` maps condition_id →
    close time and is likewise required only for CLV.
    """

    closes = market_closes or {}
    n_ep = len(scored)
    n_fills = sum(s.episode.n_fills for s in scored)
    clusters = [s.event_cluster_id for s in scored]
    n_eff = effective_events(clusters) if scored else 0.0

    successes = sum(1 for s in scored if s.correct)
    post = posterior_accuracy(successes, n_ep, prior) if n_ep else None

    edges = [float(s.excess_edge) for s in scored]
    boot: BootstrapResult | None = (
        event_block_bootstrap(edges, clusters, seed=seed) if edges else None
    )

    rationale: dict[str, Any] = {
        "episodes": n_ep,
        "fills": n_fills,
        "effective_events": n_eff,
        "hit_rate": M.hit_rate(scored),
        "prior": {"alpha": prior[0], "beta": prior[1]},
        "notes": [
            "excess_edge (payoff - entry price - fees) is the primary metric; "
            "hit_rate is reported for interpretability only",
            "confidence intervals come from an event-block bootstrap, so "
            "correlated markets do not inflate significance",
        ],
    }
    if boot is not None:
        rationale["edge_ci"] = {"lower": boot.lower, "upper": boot.upper}

    skill = M.mean_excess_edge(scored)
    # Confidence blends how much independent evidence exists with how
    # tight the interval is — separate from the size of the edge itself.
    confidence = None
    if boot is not None and n_eff > 0:
        width = max(1e-9, boot.upper - boot.lower)
        tightness = 1.0 / (1.0 + width)
        volume = min(1.0, n_eff / 30.0)
        confidence = tightness * volume

    return WalletScore(
        wallet=wallet,
        as_of=as_of,
        model_version=MODEL_VERSION,
        population_version=POPULATION_VERSION,
        n_fills=n_fills,
        n_episodes=n_ep,
        n_effective_events=n_eff,
        posterior_accuracy_mean=post.mean if post else None,
        posterior_accuracy_lcb=post.lower_credible_bound() if post else None,
        mean_excess_edge=skill,
        edge_lcb=boot.lower if boot else None,
        brier_delta=M.calibration_gap(scored),
        clv=(
            M.closing_line_value(scored, quotes, closes, as_of=as_of)
            if quotes is not None
            else None
        ),
        markout_5m=_markout(scored, quotes, "5m", as_of),
        markout_1h=_markout(scored, quotes, "1h", as_of),
        markout_24h=_markout(scored, quotes, "24h", as_of),
        drawdown=M.max_drawdown(scored),
        profit_concentration=M.profit_concentration(scored),
        fdr_q=None,  # filled by the universe-level pass below
        out_of_sample_score=None,  # filled by walk-forward
        skill_score=skill,
        confidence_score=confidence,
        rationale=rationale,
    )


def score_universe(
    per_wallet: dict[str, list[ScoredEpisode]],
    as_of: datetime,
    *,
    q: float = 0.10,
    seed: int = 12345,
    quotes: QuoteLookup | None = None,
    market_closes: dict[str, datetime] | None = None,
) -> list[WalletScore]:
    """Score every wallet, then apply FDR across the whole universe.

    The population prior is fitted from the same universe (empirical
    Bayes), and FDR is applied across all wallets at once — screening
    thousands of wallets one-at-a-time at α=0.05 would label ~5% of pure
    noise as skilled.

    ``quotes``/``market_closes`` are threaded to every wallet so markouts
    and CLV are computed against one consistent price history.
    """

    filtered = {w: filter_as_of(eps, as_of) for w, eps in per_wallet.items()}
    filtered = {w: eps for w, eps in filtered.items() if eps}
    if not filtered:
        return []

    rates = [sum(1 for s in eps if s.correct) / len(eps) for eps in filtered.values() if eps]
    prior = fit_population_prior(rates)

    scores = [
        score_wallet(
            w,
            eps,
            as_of,
            prior=prior,
            seed=seed,
            quotes=quotes,
            market_closes=market_closes,
        )
        for w, eps in filtered.items()
    ]

    # One-sided test that mean excess edge exceeds zero.
    p_values: list[float] = []
    for w in filtered:
        eps = filtered[w]
        boot = event_block_bootstrap(
            [float(s.excess_edge) for s in eps],
            [s.event_cluster_id for s in eps],
            seed=seed,
        )
        p_values.append(one_sided_p_value(boot) if boot else 1.0)

    qs = bh_q_values(p_values)
    survived = benjamini_hochberg(p_values, q=q)
    for sc, qv, surv in zip(scores, qs, survived, strict=True):
        sc.fdr_q = qv
        sc.rationale["fdr_survivor"] = surv
    return scores


# ── tiering ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class TierPolicy:
    min_effective_events: float = 20.0
    max_profit_concentration: float = 0.5
    fdr_q: float = 0.10
    min_edge_lcb: float = 0.0


def assign_tier(score: WalletScore, policy: TierPolicy | None = None) -> tuple[str, dict[str, Any]]:
    """A / B / C with the per-criterion evidence.

    Tier A is deliberately hard to reach: it is the only tier the
    executor may act on, so every criterion is a veto, and an
    out-of-sample check is REQUIRED — an in-sample-only wallet caps at B
    no matter how strong it looks.
    """

    p = policy or TierPolicy()
    checks = {
        "effective_events": (score.n_effective_events or 0.0) >= p.min_effective_events,
        "edge_lcb_positive": (score.edge_lcb is not None and score.edge_lcb > p.min_edge_lcb),
        "fdr_survivor": bool(score.rationale.get("fdr_survivor")),
        "concentration_ok": (
            score.profit_concentration is None
            or score.profit_concentration <= p.max_profit_concentration
        ),
        "out_of_sample_positive": (
            score.out_of_sample_score is not None and score.out_of_sample_score > 0
        ),
    }
    if all(checks.values()):
        tier = "A"
    elif checks["edge_lcb_positive"] and checks["concentration_ok"]:
        tier = "B"
    else:
        tier = "C"
    rationale = {
        "checks": checks,
        "policy": {
            "min_effective_events": p.min_effective_events,
            "max_profit_concentration": p.max_profit_concentration,
            "fdr_q": p.fdr_q,
        },
        "note": (
            "Tier A requires an out-of-sample window; in-sample-only "
            "wallets cap at B. Tier C is watch-only and is never copied."
        ),
    }
    return tier, rationale
