"""The selection layer: taxonomy, copyability, clustering, eligibility.

This is the layer that decides whom we mirror, so the tests target the
ways it could quietly select the wrong wallets:

* an unclassified market being treated as non-sports,
* a skilled but uncopyable wallet being promoted anyway,
* five wallets from one desk occupying five feeder slots,
* copyability reading a price from after `as_of`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from nbe_theta.analytics.clustering import Action, build_clusters, cluster_of, score_pair
from nbe_theta.analytics.cohort import (
    STATUS_EXCLUDED,
    STATUS_FEEDER,
    CohortPolicy,
    WalletFacts,
    evaluate,
    feeder_wallets,
    select,
    summarize,
)
from nbe_theta.analytics.copyability import CopyabilityScore, compose, measure, price_cap
from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.analytics.scorer import WalletScore
from nbe_theta.analytics.taxonomy import classify, is_eligible_category
from nbe_theta.ingest.budget import adopted_schedule, spec_schedule
from nbe_theta.ingest.quote_store import InMemoryQuoteStore
from nbe_theta.ledger.episodes import Episode

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)


# ── taxonomy ──────────────────────────────────────────────────────────


def test_unclassifiable_event_is_ineligible_not_assumed_safe() -> None:
    """The fail-closed rule. An event we cannot classify must not slip
    into a non-sports cohort just because nothing matched."""

    c = classify(venue_event_id="e1", title="Some ambiguous question", category=None)
    assert c is None
    assert is_eligible_category(c) is False


def test_venue_category_decides_when_it_is_known() -> None:
    sports = classify(venue_event_id="e2", title="Who wins?", category="NFL")
    assert sports is not None and sports.is_sports

    politics = classify(venue_event_id="e3", title="Who wins the primary?", category="Politics")
    assert politics is not None and not politics.is_sports
    assert is_eligible_category(politics)


def test_title_terms_can_only_push_toward_sports_never_away() -> None:
    """A miscategorised sports event must still be caught, but text that
    merely fails to look like sports is not evidence that it isn't."""

    override = classify(
        venue_event_id="e4",
        title="Lakers vs Celtics game 7",
        category="Culture",
    )
    assert override is not None and override.is_sports
    assert override.evidence["reason"] == "title_override"

    # No category, no terms → undecidable, NOT non-sports.
    assert classify(venue_event_id="e5", title="Will the bill pass?") is None


def test_word_boundaries_stop_false_positives() -> None:
    """`nba` must not fire inside `urbanbank`."""

    c = classify(venue_event_id="e6", title="Will urbanbank open a branch?", category=None)
    assert c is None


def test_election_vs_phrasing_is_a_known_false_positive_and_is_documented() -> None:
    """`" vs "` genuinely fires on "Trump vs Biden".

    This is the classifier's main weakness and the test exists to pin it:
    the category check runs first, so a correctly-categorised election is
    safe. Only an election with NO category is misfiled — and misfiling
    toward sports costs a missed copy, not a scope breach.
    """

    with_category = classify(venue_event_id="e7", title="Trump vs Biden", category="Politics")
    assert with_category is not None
    assert with_category.is_sports is True  # documented false positive

    uncategorised = classify(venue_event_id="e8", title="Trump vs Biden")
    assert uncategorised is not None and uncategorised.is_sports


# ── copyability ───────────────────────────────────────────────────────


def _episode(*, opened_at: datetime, token: str = "tok-1", direction: str = "BUY") -> Episode:
    return Episode(
        wallet="0xw",
        condition_id="0xc",
        outcome_token_id=token,
        direction=direction,
        opened_at=opened_at,
        closed_at=opened_at + timedelta(minutes=1),
        entry_vwap=Decimal("0.40"),
        exit_vwap=None,
        maximum_shares=Decimal("100"),
        maximum_cost=Decimal("40"),
        realized_pnl=Decimal("0"),
        resolution_pnl=None,
        status="resolved",
        episode_algorithm_version="gap-6h-v1",
    )


def _scored(ep: Episode, entry: str = "0.40") -> ScoredEpisode:
    return ScoredEpisode(
        episode=ep,
        realized_payoff=Decimal("1"),
        entry_price=Decimal(entry),
        fee_rate=Decimal("0"),
        event_cluster_id="evt-1",
        settled_at=ep.opened_at + timedelta(days=30),
    )


def _quotes(points: list[tuple[datetime, str]], token: str = "tok-1") -> InMemoryQuoteStore:
    q = InMemoryQuoteStore()
    for when, mid in points:
        q.add_point(token, when, Decimal(mid))
    return q


def test_price_cap_tightens_at_the_tails() -> None:
    """2c over on a 0.50 market is a 4% worse entry; 2c over on a 0.03
    longshot is 67% worse. The cap has to scale with distance from
    certainty or it is far too permissive where it matters most."""

    assert price_cap(Decimal("0.50")) == Decimal("0.02")
    assert price_cap(Decimal("0.03")) < Decimal("0.01")
    # Never below the floor.
    assert price_cap(Decimal("0.001")) == Decimal("0.005")


def test_a_wallet_whose_price_runs_away_is_uncopyable() -> None:
    """The core case. The source buys at 0.40; by the time a copier can
    act the price is 0.55. Skill scoring sees a great trade. Copyability
    sees a trade we could never have taken."""

    eps = [_scored(_episode(opened_at=T0 + timedelta(hours=i))) for i in range(10)]
    points: list[tuple[datetime, str]] = []
    for i in range(10):
        points.append((T0 + timedelta(hours=i), "0.40"))
        points.append((T0 + timedelta(hours=i, seconds=45), "0.55"))
    quotes = _quotes(points)

    result = measure("0xw", eps, quotes, T0 + timedelta(days=60))
    assert result.n_measured == 10
    assert result.copyable_fraction == 0.0
    assert result.adverse_drift is not None and result.adverse_drift > 0.1
    assert result.copyability is not None and result.copyability < 0.2


def test_a_wallet_whose_price_holds_is_copyable() -> None:
    eps = [_scored(_episode(opened_at=T0 + timedelta(hours=i))) for i in range(10)]
    points: list[tuple[datetime, str]] = []
    for i in range(10):
        points.append((T0 + timedelta(hours=i), "0.40"))
        points.append((T0 + timedelta(hours=i, seconds=45), "0.401"))
    quotes = _quotes(points)

    result = measure("0xw", eps, quotes, T0 + timedelta(days=60))
    assert result.copyable_fraction == 1.0
    assert result.copyability is not None and result.copyability > 0.9


def test_unmeasured_entries_are_excluded_from_the_denominator() -> None:
    """No quote coverage is not evidence of uncopyability. Counting it
    either way would make thin data look identical to a bad wallet, and
    those need opposite responses."""

    covered = _scored(_episode(opened_at=T0))
    uncovered = _scored(_episode(opened_at=T0 + timedelta(days=5), token="tok-none"))
    quotes = _quotes([(T0, "0.40"), (T0 + timedelta(seconds=45), "0.401")])

    result = measure("0xw", [covered, uncovered], quotes, T0 + timedelta(days=60))
    assert result.n_entries == 2
    assert result.n_measured == 1
    assert result.copyable_fraction == 1.0  # over measured entries only


def test_no_coverage_at_all_yields_none_not_zero() -> None:
    eps = [_scored(_episode(opened_at=T0, token="tok-none"))]
    result = measure("0xw", eps, _quotes([]), T0 + timedelta(days=60))
    assert result.n_measured == 0
    assert result.copyable_fraction is None
    assert result.copyability is None


def test_copyability_is_clamped_to_as_of() -> None:
    """A measurement taken at T must be reproducible from the data that
    existed at T."""

    ep = _scored(_episode(opened_at=T0))
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(seconds=20), "0.402"),
            (T0 + timedelta(seconds=45), "0.99"),  # after as_of
        ]
    )
    early = measure("0xw", [ep], quotes, T0 + timedelta(seconds=30))
    assert early.n_measured == 1
    assert early.copyable_fraction == 1.0  # saw 0.402, never 0.99


def test_favourable_drift_is_not_rewarded() -> None:
    """The market drifting our way is luck, not the wallet's doing. It
    must not inflate a copyability score."""

    assert compose(1.0, -0.05, None) == compose(1.0, 0.0, None)


def test_composite_is_a_product_so_one_bad_factor_dominates() -> None:
    """A weighted sum would let a tight spread rescue catastrophic
    slippage. Necessary conditions do not substitute for each other."""

    good = compose(1.0, 0.001, 0.005)
    bad_slippage = compose(1.0, 0.08, 0.005)
    assert good is not None and bad_slippage is not None
    assert bad_slippage < good / 3


# ── clustering ────────────────────────────────────────────────────────


def _acts(wallet: str, times: list[datetime], token: str = "m1") -> list[Action]:
    return [
        Action(wallet=wallet, outcome_token_id=token, direction="BUY", occurred_at=t) for t in times
    ]


def test_wallets_trading_together_form_one_cluster() -> None:
    base = [T0 + timedelta(days=i) for i in range(8)]
    a = _acts("0xa", base)
    b = _acts("0xb", [t + timedelta(minutes=2) for t in base])

    clusters = build_clusters({"0xa": a, "0xb": b}, T0 + timedelta(days=10))
    keys = cluster_of(clusters)
    assert keys["0xa"] == keys["0xb"]
    assert len([c for c in clusters if c.size == 2]) == 1


def test_wallets_outside_the_window_stay_separate() -> None:
    base = [T0 + timedelta(days=i) for i in range(8)]
    a = _acts("0xa", base)
    # Same markets, but hours apart — not coincident.
    b = _acts("0xb", [t + timedelta(hours=6) for t in base])

    clusters = build_clusters({"0xa": a, "0xb": b}, T0 + timedelta(days=10))
    keys = cluster_of(clusters)
    assert keys["0xa"] != keys["0xb"]


def test_a_whale_is_not_dragged_into_a_cluster_by_its_followers() -> None:
    """The asymmetry that makes `min` the right symmetriser.

    A tiny wallet mirrors the whale on every one of its own trades
    (rate 1.0 one way). The whale trades 50 other markets the follower
    never touches (rate ~0.1 the other way). Averaging would cluster
    them and, repeated across followers, collapse the whole cohort into
    one blob.
    """

    shared = [T0 + timedelta(days=i) for i in range(6)]
    whale = _acts("0xwhale", shared)
    for i in range(50):
        whale += _acts("0xwhale", [T0 + timedelta(days=i, hours=3)], token=f"other-{i}")
    follower = _acts("0xfollow", [t + timedelta(minutes=1) for t in shared])

    ps = score_pair(whale, follower)
    assert ps is not None
    assert ps.rate_ba > 0.9  # follower shadows the whale
    assert ps.rate_ab < 0.2  # the whale does not shadow the follower
    assert ps.score < 0.2  # min, so they are NOT clustered

    # as_of inside the lookback window, so both wallets' activity counts.
    clusters = build_clusters({"0xwhale": whale, "0xfollow": follower}, T0 + timedelta(days=20))
    keys = cluster_of(clusters)
    assert keys["0xwhale"] != keys["0xfollow"]


def test_wallets_with_no_activity_in_the_window_are_simply_absent() -> None:
    """`build_clusters` only knows about wallets that traded in the
    lookback window. Callers treat an absent wallet as its own singleton
    (see `cohort.select`), so a dormant wallet is never accidentally
    grouped with anyone."""

    stale = _acts("0xstale", [T0])
    clusters = build_clusters({"0xstale": stale}, T0 + timedelta(days=90))
    keys = cluster_of(clusters)
    assert "0xstale" not in keys
    assert keys.get("0xstale", "0xstale") == "0xstale"


def test_thin_overlap_is_not_a_cluster() -> None:
    """Two wallets that each traded one market, the same one, on the same
    afternoon are a coincidence."""

    a = _acts("0xa", [T0])
    b = _acts("0xb", [T0 + timedelta(minutes=1)])
    clusters = build_clusters({"0xa": a, "0xb": b}, T0 + timedelta(days=1))
    keys = cluster_of(clusters)
    assert keys["0xa"] != keys["0xb"]


def test_every_wallet_gets_a_cluster_including_singletons() -> None:
    clusters = build_clusters({"0xsolo": _acts("0xsolo", [T0])}, T0 + timedelta(days=1))
    assert cluster_of(clusters)["0xsolo"] == "0xsolo"


# ── eligibility ───────────────────────────────────────────────────────


def _score(
    *,
    skill: float = 0.05,
    lcb: float = 0.01,
    fdr: bool = True,
    n_eff: float = 30.0,
    conc: float | None = 0.2,
    conf: float = 0.6,
) -> WalletScore:
    return WalletScore(
        wallet="0xw",
        as_of=T0,
        model_version="m",
        population_version="p",
        n_fills=100,
        n_episodes=50,
        n_effective_events=n_eff,
        posterior_accuracy_mean=0.6,
        posterior_accuracy_lcb=0.55,
        mean_excess_edge=skill,
        edge_lcb=lcb,
        brier_delta=0.05,
        clv=0.03,
        markout_5m=0.01,
        markout_1h=0.02,
        markout_24h=0.03,
        drawdown=100.0,
        profit_concentration=conc,
        fdr_q=0.01,
        out_of_sample_score=0.02,
        skill_score=skill,
        confidence_score=conf,
        rationale={"fdr_survivor": fdr},
    )


def _cop(*, fraction: float = 0.9, score: float = 0.8, measured: int = 40) -> CopyabilityScore:
    return CopyabilityScore(
        wallet="0xw",
        as_of=T0,
        model_version="c",
        delay_seconds=45,
        n_entries=measured,
        n_measured=measured,
        copyable_fraction=fraction,
        adverse_drift=0.001,
        median_slippage=0.002,
        median_spread=0.01,
        copyability=score,
    )


def _facts(wallet: str = "0xw", **over: Any) -> WalletFacts:
    base: dict[str, Any] = {
        "wallet": wallet,
        "n_active_days": 120,
        "n_closed_markets": 60,
        "traded_notional": Decimal("50000"),
        "sports_share": 0.0,
        "score": _score(),
        "copyability": _cop(),
    }
    base.update(over)
    return WalletFacts(**base)


def test_a_fully_qualified_wallet_passes_every_gate() -> None:
    d = evaluate(_facts(), CohortPolicy())
    assert d.eligible, d.checks
    assert d.reason is None


def test_a_skilled_but_uncopyable_wallet_is_rejected() -> None:
    """The keystone case, and the whole reason copyability is a veto
    rather than a weighted term. This wallet has a real, FDR-surviving
    edge — and we could not have captured any of it."""

    d = evaluate(_facts(copyability=_cop(fraction=0.05, score=0.05)), CohortPolicy())
    assert not d.eligible
    assert d.checks["edge_lcb_positive"] is True  # the skill is real
    assert d.checks["fdr_survivor"] is True
    assert d.checks["copyable_fraction"] is False
    assert d.reason == "copyable_fraction"


def test_unmeasured_copyability_is_not_a_pass() -> None:
    d = evaluate(_facts(copyability=None), CohortPolicy())
    assert not d.eligible
    assert d.checks["copyability_measured"] is False


def test_unclassified_activity_fails_the_scope_gate() -> None:
    """`sports_share is None` must fail. We cannot assert a wallet trades
    non-sports from a history we could not classify."""

    d = evaluate(_facts(sports_share=None), CohortPolicy())
    assert not d.eligible
    assert d.checks["non_sports"] is False


def test_failing_fdr_is_not_offset_by_a_strong_edge() -> None:
    """The property a weighted sum cannot express: necessary conditions
    do not trade off. A huge edge that did not survive multiple-testing
    correction is exactly what luck looks like."""

    d = evaluate(_facts(score=_score(skill=0.5, lcb=0.4, fdr=False)), CohortPolicy())
    assert not d.eligible
    assert d.checks["fdr_survivor"] is False


def test_one_feeder_slot_per_cluster() -> None:
    """Five wallets from one desk are one opinion and must not take five
    slots and five times the exposure."""

    facts = [_facts(wallet=f"0x{i}") for i in range(5)]
    clusters = {f"0x{i}": "desk-A" for i in range(5)}
    decisions = select(facts, CohortPolicy(max_feeder=10), clusters=clusters)

    feeders = feeder_wallets(decisions)
    assert len(feeders) == 1
    blocked = [d for d in decisions if d.reason == "cluster_slot_taken"]
    assert len(blocked) == 4
    # Blocked members stay in the cohort — still useful for consensus.
    assert all(d.status != STATUS_FEEDER for d in blocked)


def test_unclustered_wallets_each_get_a_slot() -> None:
    facts = [_facts(wallet=f"0x{i}") for i in range(5)]
    decisions = select(facts, CohortPolicy(max_feeder=10))
    assert len(feeder_wallets(decisions)) == 5


def test_feeder_set_is_bounded() -> None:
    facts = [_facts(wallet=f"0x{i}") for i in range(20)]
    decisions = select(facts, CohortPolicy(max_feeder=3))
    assert len(feeder_wallets(decisions)) == 3


def test_exclusions_are_recorded_not_dropped() -> None:
    """An excluded wallet with a named reason answers 'why is the feeder
    set empty?'. An absence answers nothing."""

    facts = [
        _facts(wallet="0xgood"),
        _facts(wallet="0xthin", n_closed_markets=2),
        _facts(wallet="0xuncopyable", copyability=_cop(fraction=0.01, score=0.01)),
    ]
    decisions = select(facts, CohortPolicy())
    assert len(decisions) == 3

    summary = summarize(decisions)
    assert summary["total"] == 3
    assert summary["by_status"][STATUS_EXCLUDED] == 2
    assert "closed_markets" in summary["exclusion_reasons"]
    assert "copyable_fraction" in summary["exclusion_reasons"]


def test_policy_hash_changes_when_a_threshold_changes() -> None:
    """A cohort decision cites its policy. If the hash did not move when
    a threshold moved, 'we changed a number and forgot' would be
    invisible — the most likely way this system starts following the
    wrong wallets."""

    a = CohortPolicy()
    b = CohortPolicy(min_copyability=0.9)
    assert a.policy_hash() != b.policy_hash()
    assert CohortPolicy().policy_hash() == a.policy_hash()


# ── polling budget ────────────────────────────────────────────────────


def test_the_spec_schedule_is_over_subscribed() -> None:
    """ADR-0002 §E, as an executable claim rather than a comment."""

    spec = spec_schedule()
    assert spec.utilisation() > 0.9
    assert not spec.within_headroom()


def test_the_adopted_schedule_leaves_headroom() -> None:
    adopted = adopted_schedule()
    assert adopted.within_headroom(), adopted.explain()
    assert adopted.total_per_10s() < spec_schedule().total_per_10s()
