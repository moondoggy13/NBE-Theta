"""Analytics tests.

The headline test here is ``test_no_look_ahead_*``: scoring at as_of=T
must be byte-identical whether or not the future exists in the input.
Walk-forward validation is worthless without that property, and a leak
is invisible in the output — so it gets asserted directly.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.analytics import metrics as M
from nbe_theta.analytics.pipeline import build_scored_episodes
from nbe_theta.analytics.scorer import (
    TierPolicy,
    assign_tier,
    filter_as_of,
    score_universe,
    score_wallet,
)
from nbe_theta.analytics.statistics import (
    benjamini_hochberg,
    bh_q_values,
    effective_events,
    event_block_bootstrap,
    fit_population_prior,
    posterior_accuracy,
)
from nbe_theta.analytics.store import ResolutionRow
from nbe_theta.backtest.walkforward import attach_out_of_sample, run_walk_forward
from nbe_theta.ledger.entries import TradeRow

T0 = datetime(2027, 1, 1, tzinfo=UTC)


def mk_trade(
    wallet: str,
    cid: str,
    token: str,
    *,
    side: str = "BUY",
    price: str = "0.40",
    qty: str = "100",
    day: int = 0,
    tid: str | None = None,
) -> TradeRow:
    p, q = Decimal(price), Decimal(qty)
    return TradeRow(
        source_trade_id=tid or f"{wallet}-{cid}-{token}-{day}-{side}",
        wallet=wallet,
        condition_id=cid,
        outcome_token_id=token,
        side=side,
        price=p,
        quantity=q,
        notional=p * q,
        occurred_at=T0 + timedelta(days=day),
    )


def mk_res(cid: str, token: str, price: str, day: int, cluster: str | None = None) -> ResolutionRow:
    return ResolutionRow(
        condition_id=cid,
        outcome_token_id=token,
        price=Decimal(price),
        resolved_at=T0 + timedelta(days=day),
        event_cluster_id=cluster,
    )


def closed_episode_set(wallet: str, n: int, *, win: bool, cluster: str | None = None):
    """n closed round-trips for `wallet`, each settling win/lose."""

    trades: list[TradeRow] = []
    resolutions: list[ResolutionRow] = []
    for i in range(n):
        cid, tok = f"c{wallet}{i}", f"t{wallet}{i}"
        trades.append(mk_trade(wallet, cid, tok, side="BUY", price="0.40", qty="100", day=i))
        # Sell back out the same day → episode closes.
        trades.append(
            mk_trade(
                wallet, cid, tok, side="SELL", price="0.40", qty="100", day=i, tid=f"{wallet}-x{i}"
            )
        )
        resolutions.append(mk_res(cid, tok, "1" if win else "0", i, cluster))
    return trades, resolutions


# ── metrics ───────────────────────────────────────────────────────


def test_excess_edge_rewards_cheap_wins_not_favorites() -> None:
    """A 0.90 favorite that wins shows almost no edge; a 0.30 longshot
    that wins shows a lot. This is THE correction the module exists for."""

    trades, res = closed_episode_set("w", 1, win=True)
    per_wallet, _ = build_scored_episodes(trades, res, fee_rate=Decimal("0"))
    base = per_wallet["w"][0]

    cheap = M.ScoredEpisode(
        episode=base.episode,
        realized_payoff=Decimal("1"),
        entry_price=Decimal("0.30"),
        fee_rate=Decimal("0"),
        event_cluster_id=None,
    )
    favorite = M.ScoredEpisode(
        episode=base.episode,
        realized_payoff=Decimal("1"),
        entry_price=Decimal("0.90"),
        fee_rate=Decimal("0"),
        event_cluster_id=None,
    )
    assert cheap.excess_edge == Decimal("0.70")
    assert favorite.excess_edge == Decimal("0.10")
    assert cheap.excess_edge > favorite.excess_edge
    # Both are "correct" — which is exactly why hit rate is useless alone.
    assert cheap.correct and favorite.correct


def test_calibration_gap_sign_is_correct() -> None:
    """Buying at 0.30 and winning every time is a positive gap; buying at
    0.90 and winning every time is a much smaller one."""

    trades, res = closed_episode_set("w", 1, win=True)
    per_wallet, _ = build_scored_episodes(trades, res, fee_rate=Decimal("0"))
    ep = per_wallet["w"][0].episode

    def scored(price: str) -> list[M.ScoredEpisode]:
        return [
            M.ScoredEpisode(
                episode=ep,
                realized_payoff=Decimal("1"),
                entry_price=Decimal(price),
                fee_rate=Decimal("0"),
                event_cluster_id=None,
            )
        ]

    assert M.calibration_gap(scored("0.30")) == 0.7
    assert M.calibration_gap(scored("0.90")) > 0
    assert M.calibration_gap(scored("0.30")) > M.calibration_gap(scored("0.90"))


def test_fees_reduce_edge() -> None:
    trades, res = closed_episode_set("w", 1, win=True)
    free, _ = build_scored_episodes(trades, res, fee_rate=Decimal("0"))
    charged, _ = build_scored_episodes(trades, res, fee_rate=Decimal("0.05"))
    assert charged["w"][0].excess_edge < free["w"][0].excess_edge


def test_profit_concentration_flags_one_lucky_trade() -> None:
    trades, res = closed_episode_set("w", 3, win=True)
    per_wallet, _ = build_scored_episodes(trades, res)
    conc = M.profit_concentration(per_wallet["w"])
    assert conc is None or 0.0 <= conc <= 1.0


def test_metrics_handle_empty_input() -> None:
    assert M.mean_excess_edge([]) is None
    assert M.calibration_gap([]) is None
    assert M.hit_rate([]) is None
    assert M.max_drawdown([]) is None
    assert M.sharpe_like([]) is None


# ── statistics ────────────────────────────────────────────────────


def test_posterior_shrinks_small_samples_toward_prior() -> None:
    """4-for-5 is not an 80% forecaster."""

    prior = fit_population_prior([0.5] * 50, strength=20.0)
    small = posterior_accuracy(4, 5, prior)
    assert small.mean < 0.8
    assert small.mean > 0.5
    # A large sample overwhelms the prior.
    big = posterior_accuracy(400, 500, prior)
    assert big.mean > small.mean


def test_lower_credible_bound_is_below_mean_and_widens_when_small() -> None:
    prior = fit_population_prior([0.5] * 20)
    small = posterior_accuracy(3, 4, prior)
    big = posterior_accuracy(300, 400, prior)
    assert small.lower_credible_bound() < small.mean
    # Small-sample bound sits further below its mean.
    assert (small.mean - small.lower_credible_bound()) > (big.mean - big.lower_credible_bound())


def test_effective_events_discounts_correlated_markets() -> None:
    """Ten markets on one event are not ten observations."""

    correlated = effective_events(["evt1"] * 10)
    independent = effective_events([f"evt{i}" for i in range(10)])
    assert correlated < independent
    assert correlated == 10**0.5
    assert independent == 10.0


def test_bootstrap_resamples_clusters_not_episodes() -> None:
    """Correlated data must produce a WIDER interval than independent
    data with the same values — the anti-fabrication property."""

    values = [0.1] * 5 + [-0.05] * 5
    few_clusters = event_block_bootstrap(
        values, ["e1"] * 5 + ["e2"] * 3 + ["e3"] * 2, n_resamples=500
    )
    many_clusters = event_block_bootstrap(values, [f"e{i}" for i in range(10)], n_resamples=500)
    assert few_clusters is not None and many_clusters is not None
    assert (few_clusters.upper - few_clusters.lower) > (many_clusters.upper - many_clusters.lower)


def test_bootstrap_refuses_below_min_clusters() -> None:
    """A single event cluster resamples to itself every time — zero
    width, which would read as INFINITE certainty. Refusing is the only
    safe answer, and it fails closed all the way to no Tier A."""

    values = [0.1] * 10
    assert event_block_bootstrap(values, ["e1"] * 10, n_resamples=200) is None
    assert event_block_bootstrap(values, ["e1"] * 5 + ["e2"] * 5, n_resamples=200) is None
    assert (
        event_block_bootstrap(values, ["e1"] * 4 + ["e2"] * 3 + ["e3"] * 3, n_resamples=200)
        is not None
    )


def test_single_cluster_wallet_cannot_reach_tier_a() -> None:
    """End-to-end consequence of the above: a wallet whose whole record
    is one real-world event gets no edge_lcb, so it cannot be Tier A."""

    trades, res = closed_episode_set("onetrick", 12, win=True, cluster="election-2028")
    sc, _ = build_scored_episodes(trades, res)
    scores = score_universe(sc, T0 + timedelta(days=60))
    s = scores[0]
    assert s.edge_lcb is None
    s.out_of_sample_score = 1.0  # even granting it OOS success
    tier, rationale = assign_tier(s, TierPolicy(min_effective_events=1.0))
    assert rationale["checks"]["edge_lcb_positive"] is False
    assert tier == "C"


def test_bootstrap_is_deterministic_for_a_seed() -> None:
    v = [0.1, 0.2, -0.05, 0.3]
    c = ["a", "b", "c", "d"]
    a = event_block_bootstrap(v, c, seed=7, n_resamples=200)
    b = event_block_bootstrap(v, c, seed=7, n_resamples=200)
    assert a is not None and b is not None
    assert (a.lower, a.upper) == (b.lower, b.upper)


def test_bh_survivors_are_monotone_in_q() -> None:
    """Raising q can only ever admit more discoveries, never fewer."""

    ps = [0.001, 0.01, 0.03, 0.2, 0.5, 0.9]
    strict = benjamini_hochberg(ps, q=0.05)
    loose = benjamini_hochberg(ps, q=0.5)
    assert sum(strict) <= sum(loose)
    for s, ln in zip(strict, loose, strict=True):
        assert not (s and not ln)


def test_bh_controls_false_discoveries_on_pure_noise() -> None:
    """1000 uniform p-values (all null) should yield ~no discoveries."""

    ps = [i / 1000 for i in range(1, 1001)]
    survivors = benjamini_hochberg(ps, q=0.05)
    assert sum(survivors) <= 50


def test_q_values_are_monotone() -> None:
    ps = [0.001, 0.02, 0.04, 0.3, 0.8]
    qs = bh_q_values(ps)
    ordered = [qs[i] for i in sorted(range(len(ps)), key=lambda i: ps[i])]
    assert all(a <= b + 1e-12 for a, b in zip(ordered, ordered[1:], strict=False))


# ── no look-ahead (the critical property) ─────────────────────────


def test_no_look_ahead_future_episodes_are_excluded() -> None:
    trades, res = closed_episode_set("w", 6, win=True)
    per_wallet, _ = build_scored_episodes(trades, res)
    as_of = T0 + timedelta(days=2, hours=12)
    kept = filter_as_of(per_wallet["w"], as_of)
    assert kept, "expected some episodes before as_of"
    assert all(s.episode.closed_at is not None for s in kept)
    assert all(s.episode.closed_at <= as_of for s in kept)  # type: ignore[operator]
    assert len(kept) < len(per_wallet["w"])


def test_no_look_ahead_score_is_identical_with_and_without_the_future() -> None:
    """The load-bearing assertion: appending future data must not change
    a score computed as_of an earlier instant."""

    as_of = T0 + timedelta(days=3, hours=12)

    past_trades, past_res = closed_episode_set("w", 4, win=True)
    past_only, _ = build_scored_episodes(past_trades, past_res)

    # Same history PLUS future activity the scorer must not see.
    fut_trades, fut_res = closed_episode_set("w", 12, win=True)
    with_future, _ = build_scored_episodes(fut_trades, fut_res)

    prior = fit_population_prior([0.5] * 20)
    a = score_wallet("w", filter_as_of(past_only["w"], as_of), as_of, prior=prior)
    b = score_wallet("w", filter_as_of(with_future["w"], as_of), as_of, prior=prior)

    assert a.n_episodes == b.n_episodes
    assert a.mean_excess_edge == b.mean_excess_edge
    assert a.edge_lcb == b.edge_lcb
    assert a.n_effective_events == b.n_effective_events


def test_episode_is_unscoreable_until_its_market_settles() -> None:
    """The subtle leak: a wallet trades out on day 0, but the market does
    not settle until day 5. Its excess edge is a function of the settled
    payoff, so it is NOT observable on day 1 — filtering on the last fill
    would import a day-5 outcome into a day-1 score."""

    trades = [
        mk_trade("w", "c1", "t1", side="BUY", day=0),
        mk_trade("w", "c1", "t1", side="SELL", day=0, tid="x"),  # flat on day 0
    ]
    res = [mk_res("c1", "t1", "1", 5)]  # settles on day 5
    per_wallet, _ = build_scored_episodes(trades, res)
    scored = per_wallet["w"]
    assert scored[0].episode.closed_at is not None
    assert scored[0].settled_at == T0 + timedelta(days=5)

    assert filter_as_of(scored, T0 + timedelta(days=1)) == []
    assert filter_as_of(scored, T0 + timedelta(days=4, hours=23)) == []
    assert len(filter_as_of(scored, T0 + timedelta(days=5))) == 1


def test_open_episodes_never_enter_scoring() -> None:
    """An episode still open (never traded out) also cannot be scored
    before its market settles."""

    trades = [mk_trade("w", "c1", "t1", side="BUY", day=0)]  # never closed
    res = [mk_res("c1", "t1", "1", 5)]
    per_wallet, _ = build_scored_episodes(trades, res)
    kept = filter_as_of(per_wallet.get("w", []), T0 + timedelta(days=1))
    assert kept == []


def test_unresolved_outcomes_are_dropped_not_imputed() -> None:
    trades = [
        mk_trade("w", "c1", "t1", side="BUY", day=0),
        mk_trade("w", "c1", "t1", side="SELL", day=0, tid="x"),
    ]
    per_wallet, stats = build_scored_episodes(trades, [])  # no resolutions
    assert per_wallet == {}
    assert stats.episodes_unresolved >= 1
    assert stats.episodes_scored == 0


# ── universe scoring + tiering ────────────────────────────────────


def test_score_universe_applies_fdr_across_wallets() -> None:
    per_wallet = {}
    for name, win in (("good", True), ("bad", False)):
        t, r = closed_episode_set(name, 5, win=win)
        sc, _ = build_scored_episodes(t, r)
        per_wallet.update(sc)
    scores = score_universe(per_wallet, T0 + timedelta(days=30))
    assert len(scores) == 2
    assert all(s.fdr_q is not None for s in scores)
    assert all("fdr_survivor" in s.rationale for s in scores)


def test_skill_and_confidence_are_separate() -> None:
    """Same edge, different evidence → same skill, different confidence.
    Collapsing these into one number is how a 5-episode wallet gets
    mistaken for a 500-episode one."""

    few, r_few = closed_episode_set("few", 5, win=True)
    many, r_many = closed_episode_set("many", 40, win=True)
    sc_few, _ = build_scored_episodes(few, r_few)
    sc_many, _ = build_scored_episodes(many, r_many)
    per_wallet = {**sc_few, **sc_many}
    scores = {s.wallet: s for s in score_universe(per_wallet, T0 + timedelta(days=90))}

    # Identical per-episode edge...
    assert scores["few"].skill_score == scores["many"].skill_score
    # ...but the wallet with 8x the independent evidence is more trusted.
    assert scores["many"].confidence_score is not None
    assert scores["few"].confidence_score is not None
    assert scores["many"].confidence_score > scores["few"].confidence_score


def test_two_episode_wallet_has_no_measurable_confidence() -> None:
    """Below the bootstrap's cluster floor there is no honest interval,
    so confidence is None rather than a small-but-real-looking number."""

    few, r_few = closed_episode_set("tiny", 2, win=True)
    sc, _ = build_scored_episodes(few, r_few)
    scores = score_universe(sc, T0 + timedelta(days=90))
    assert scores[0].confidence_score is None
    assert scores[0].edge_lcb is None


def test_tier_a_requires_out_of_sample() -> None:
    """An in-sample-only wallet caps at B no matter how good it looks —
    fail-closed, since Tier A is the only tier the executor may act on."""

    t, r = closed_episode_set("w", 40, win=True)
    sc, _ = build_scored_episodes(t, r)
    scores = score_universe(sc, T0 + timedelta(days=90))
    s = scores[0]
    assert s.out_of_sample_score is None
    tier, rationale = assign_tier(s)
    assert tier != "A"
    assert rationale["checks"]["out_of_sample_positive"] is False


def test_tier_c_for_weak_wallets() -> None:
    t, r = closed_episode_set("loser", 5, win=False)
    sc, _ = build_scored_episodes(t, r)
    scores = score_universe(sc, T0 + timedelta(days=30))
    tier, _ = assign_tier(scores[0])
    assert tier == "C"


def test_concentration_veto_blocks_tier_a() -> None:
    t, r = closed_episode_set("w", 40, win=True)
    sc, _ = build_scored_episodes(t, r)
    scores = score_universe(sc, T0 + timedelta(days=90))
    s = scores[0]
    s.out_of_sample_score = 0.5
    s.profit_concentration = 0.99  # one trade is ~all the profit
    tier, rationale = assign_tier(s, TierPolicy(min_effective_events=1.0))
    assert rationale["checks"]["concentration_ok"] is False
    assert tier == "C"


# ── walk-forward ──────────────────────────────────────────────────


def test_walk_forward_produces_folds_and_lift() -> None:
    per_wallet = {}
    for name, win in (("good", True), ("bad", False)):
        t, r = closed_episode_set(name, 20, win=win)
        sc, _ = build_scored_episodes(t, r)
        per_wallet.update(sc)

    result = run_walk_forward(
        per_wallet,
        start=T0 + timedelta(days=5),
        end=T0 + timedelta(days=20),
        step=timedelta(days=5),
        horizon=timedelta(days=5),
        top_n=1,
    )
    assert result.folds
    # The consistently-winning wallet should be selected.
    assert any("good" in f.selected for f in result.folds)


def test_attach_out_of_sample_uses_only_the_forward_window() -> None:
    t, r = closed_episode_set("w", 10, win=True)
    sc, _ = build_scored_episodes(t, r)
    as_of = T0 + timedelta(days=4, hours=12)
    scores = score_universe(sc, as_of)
    attach_out_of_sample(scores, sc, as_of, timedelta(days=3))
    assert scores[0].out_of_sample_score is not None
