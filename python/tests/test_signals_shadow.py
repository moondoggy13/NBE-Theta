"""The copy pipeline: actions, gates, sizing, lots, shadow fills.

Every test here targets a specific way a copy-trading system loses money
quietly rather than loudly:

* copying each fill of one scale-in as a separate decision,
* a gate being compensated for instead of enforced,
* a partial fill being recorded as a smaller position,
* an exit selling more than we hold and opening a short,
* a drawdown stop liquidating instead of blocking entries,
* a resolved market leaving an open lot forever.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.signals.actions import Fill, group_fills, is_tradable
from nbe_theta.signals.gates import (
    MarketContext,
    SignalPolicy,
    SourceContext,
    qualify,
    vwap_for,
    walk_book,
)
from nbe_theta.signals.lots import (
    STATUS_OPEN,
    STATUS_SETTLED,
    apply_exit,
    open_lot,
    plan_exit,
    settle_lots,
)
from nbe_theta.signals.pipeline import apply_to_portfolio, evaluate_action
from nbe_theta.signals.shadow import (
    REASON_INSUFFICIENT_DEPTH,
    REASON_LIMIT_EXCEEDED,
    REASON_STALE_BOOK,
    ShadowStats,
    simulate,
)
from nbe_theta.signals.sizing import PortfolioState, RiskPolicy, size_entry

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
WALLET = "0xsource"
COND = "0xcond"
TOKEN = "tok-1"


def _fill(
    *,
    at: datetime,
    price: str = "0.40",
    qty: str = "1000",
    side: str = "BUY",
    tx: str | None = None,
    kind: str | None = None,
) -> Fill:
    return Fill(
        wallet=WALLET,
        condition_id=COND,
        outcome_token_id=TOKEN,
        side=side,
        price=Decimal(price),
        quantity=Decimal(qty),
        occurred_at=at,
        tx_hash=tx,
        kind=kind,
    )


# ── source actions ────────────────────────────────────────────────────


def test_a_scale_in_is_one_decision_not_five() -> None:
    """The error that would multiply our exposure by the fill count."""

    fills = [_fill(at=T0 + timedelta(seconds=20 * i), qty="200") for i in range(5)]
    actions = group_fills(fills, detected_at=T0 + timedelta(minutes=3))
    assert len(actions) == 1
    assert actions[0].n_fills == 5
    assert actions[0].quantity == Decimal("1000")


def test_decisions_hours_apart_are_separate() -> None:
    fills = [_fill(at=T0, qty="200"), _fill(at=T0 + timedelta(hours=4), qty="300")]
    actions = group_fills(fills, detected_at=T0 + timedelta(hours=5))
    assert len(actions) == 2


def test_position_threads_through_consecutive_actions() -> None:
    """Each action's denominator is the previous action's result, so a
    wallet scaling in over three decisions gets three correct
    materiality ratios rather than three copies of its start."""

    fills = [
        _fill(at=T0, qty="100"),
        _fill(at=T0 + timedelta(hours=1), qty="100"),
        _fill(at=T0 + timedelta(hours=2), qty="100"),
    ]
    actions = group_fills(
        fills,
        detected_at=T0 + timedelta(hours=3),
        positions_before={(WALLET, TOKEN): Decimal("1000")},
    )
    assert [a.position_before for a in actions] == [
        Decimal("1000"),
        Decimal("1100"),
        Decimal("1200"),
    ]


def test_non_trade_activity_is_ignored() -> None:
    """A reward credit is not a buy."""

    for kind in ("deposit", "reward", "merge", "split", "conversion", "redeem"):
        assert not is_tradable(_fill(at=T0, kind=kind)), kind
    assert is_tradable(_fill(at=T0, kind="trade"))
    assert is_tradable(_fill(at=T0))  # no kind == the trades endpoint


def test_dedupe_key_is_stable_across_an_overlapping_repoll() -> None:
    """The collector re-polls overlapping windows on every catch-up. The
    same decision seen twice must produce the same key, or we place the
    order twice."""

    fills = [_fill(at=T0, tx="0xaa"), _fill(at=T0 + timedelta(seconds=30), tx="0xbb")]
    first = group_fills(fills, detected_at=T0 + timedelta(minutes=1))[0]
    second = group_fills(list(reversed(fills)), detected_at=T0 + timedelta(minutes=5))[0]
    assert first.dedupe_key() == second.dedupe_key()


def test_different_decisions_get_different_keys() -> None:
    a = group_fills([_fill(at=T0, tx="0xaa")], detected_at=T0)[0]
    b = group_fills([_fill(at=T0, tx="0xbb")], detected_at=T0)[0]
    assert a.dedupe_key() != b.dedupe_key()


# ── gates ─────────────────────────────────────────────────────────────


def _market(**over: object) -> MarketContext:
    base: dict[str, object] = {
        "condition_id": COND,
        "outcome_token_id": TOKEN,
        "active": True,
        "closed": False,
        "resolved": False,
        "accepting_orders": True,
        "neg_risk": False,
        "closes_at": T0 + timedelta(days=7),
        "tick_size": Decimal("0.01"),
        "min_order_size": Decimal("5"),
        "fee_rate": Decimal("0.02"),
        "levels": [(Decimal("0.41"), Decimal("50000"))],
        "quote_age_s": 2.0,
        "is_sports": False,
    }
    base.update(over)
    return MarketContext(**base)  # type: ignore[arg-type]


def _source(**over: object) -> SourceContext:
    base: dict[str, object] = {
        "wallet": WALLET,
        "in_feeder_set": True,
        "rank_score": 0.9,
        "cluster_key": "c1",
        "agreeing_clusters": 0,
    }
    base.update(over)
    return SourceContext(**base)  # type: ignore[arg-type]


def _action(**over: object):  # type: ignore[no-untyped-def]
    fills = [_fill(at=T0, qty="1000", price="0.40")]
    action = group_fills(
        fills,
        detected_at=T0 + timedelta(seconds=20),
        positions_before={(WALLET, TOKEN): Decimal("10000")},
    )[0]
    for k, v in over.items():
        setattr(action, k, v)
    return action


def test_a_fully_qualified_action_passes() -> None:
    q = qualify(_action(), _source(), _market(), SignalPolicy(), now=T0 + timedelta(seconds=20))
    assert q.accepted, q.as_dict()


def test_unclassified_market_fails_the_non_sports_gate() -> None:
    q = qualify(
        _action(),
        _source(),
        _market(is_sports=None),
        SignalPolicy(),
        now=T0 + timedelta(seconds=20),
    )
    assert not q.accepted
    assert q.as_dict()["non_sports"]["passed"] is False


def test_neg_risk_is_excluded_in_v1() -> None:
    q = qualify(
        _action(), _source(), _market(neg_risk=True), SignalPolicy(), now=T0 + timedelta(seconds=20)
    )
    assert not q.accepted
    assert q.reject_reason == "not_neg_risk"


def test_a_stale_detection_is_rejected() -> None:
    """Beyond the freshness bound we are buying the source's own move."""

    q = qualify(
        _action(detected_at=T0 + timedelta(minutes=5)),
        _source(),
        _market(),
        SignalPolicy(),
        now=T0 + timedelta(minutes=5),
    )
    assert not q.accepted
    assert q.as_dict()["freshness"]["passed"] is False


def test_a_high_quality_source_cannot_rescue_a_thin_book() -> None:
    """The property the spec's weighted sum could not express. A book
    that cannot absorb the order does not become deeper because the
    wallet is excellent."""

    q = qualify(
        _action(),
        _source(rank_score=1.0),
        _market(levels=[(Decimal("0.41"), Decimal("1"))]),
        SignalPolicy(),
        now=T0 + timedelta(seconds=20),
    )
    assert not q.accepted
    assert q.as_dict()["depth"]["passed"] is False


def test_a_weak_source_needs_an_independent_cluster() -> None:
    weak = _source(rank_score=0.6, agreeing_clusters=0)
    q = qualify(_action(), weak, _market(), SignalPolicy(), now=T0 + timedelta(seconds=20))
    assert q.as_dict()["consensus"]["passed"] is False

    confirmed = _source(rank_score=0.6, agreeing_clusters=1)
    q2 = qualify(_action(), confirmed, _market(), SignalPolicy(), now=T0 + timedelta(seconds=20))
    assert q2.as_dict()["consensus"]["passed"] is True


def test_price_cap_rejects_a_book_that_ran_away() -> None:
    """Source bought at 0.40; by the time we look the ask is 0.55."""

    q = qualify(
        _action(),
        _source(),
        _market(levels=[(Decimal("0.55"), Decimal("50000"))]),
        SignalPolicy(),
        now=T0 + timedelta(seconds=20),
    )
    assert not q.accepted
    assert q.as_dict()["price_cap"]["passed"] is False


def test_every_gate_is_evaluated_even_after_one_fails() -> None:
    """The console shows the whole picture, not the first stumble."""

    q = qualify(
        _action(),
        _source(in_feeder_set=False),
        _market(neg_risk=True, is_sports=None),
        SignalPolicy(),
        now=T0 + timedelta(seconds=20),
    )
    d = q.as_dict()
    assert d["feeder_member"]["passed"] is False
    assert d["not_neg_risk"]["passed"] is False
    assert d["non_sports"]["passed"] is False
    assert q.reject_reason == "feeder_member"  # first failure, for triage


def test_walk_book_and_vwap_respect_direction() -> None:
    asks = [(Decimal("0.40"), Decimal("10")), (Decimal("0.50"), Decimal("10"))]
    assert walk_book(asks, Decimal("0.45"), "BUY") == Decimal("10")
    priced = vwap_for(asks, Decimal("20"), "BUY")
    assert priced is not None
    assert priced[0] == Decimal("0.45")  # walked both levels, not the top


# ── sizing ────────────────────────────────────────────────────────────


def _portfolio(**over: object) -> PortfolioState:
    base: dict[str, object] = {
        "nav": Decimal("100000"),
        "cash": Decimal("100000"),
        "day_start_nav": Decimal("100000"),
    }
    base.update(over)
    return PortfolioState(**base)  # type: ignore[arg-type]


def test_entry_is_capped_at_the_per_entry_fraction() -> None:
    d = size_entry(
        portfolio=_portfolio(),
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000000"),
        min_order_size=Decimal("5"),
        rank_score=1.0,
        confidence=1.0,
        condition_id=COND,
    )
    # 1.5% of 100k = 1500, all factors at 1.0.
    assert d.notional <= Decimal("1500")
    assert d.actionable


def test_drawdown_halt_blocks_entries_and_does_not_liquidate() -> None:
    """A stop that force-sells converts a paper loss into a realised one
    at the worst price. It blocks new entries and nothing else."""

    p = _portfolio(nav=Decimal("80000"), day_start_nav=Decimal("100000"))
    d = size_entry(
        portfolio=p,
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000000"),
        min_order_size=Decimal("5"),
        rank_score=1.0,
        confidence=1.0,
        condition_id=COND,
    )
    assert not d.actionable
    assert d.skipped_reason == "daily_drawdown_halt"
    # No exit was planned, nothing was sold: the halt is entry-side only.
    assert d.quantity == Decimal("0")


def test_open_orders_count_against_the_market_cap() -> None:
    """A cap that ignores in-flight orders is a cap plus however many
    orders happen to be outstanding."""

    p = _portfolio()
    p.open_order_notional[COND] = Decimal("8000")  # already at the 8% cap
    d = size_entry(
        portfolio=p,
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000000"),
        min_order_size=Decimal("5"),
        rank_score=1.0,
        confidence=1.0,
        condition_id=COND,
    )
    assert d.skipped_reason == "market_cap"


def test_below_the_venue_minimum_we_skip_never_round_up() -> None:
    """Rounding up is a silent override of every cap above it."""

    d = size_entry(
        portfolio=_portfolio(nav=Decimal("100"), cash=Decimal("100"), day_start_nav=Decimal("100")),
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000000"),
        min_order_size=Decimal("500"),
        rank_score=1.0,
        confidence=1.0,
        condition_id=COND,
    )
    assert d.skipped_reason == "below_min_order_size"
    assert d.quantity == Decimal("0")


def test_participation_cap_bounds_our_share_of_the_book() -> None:
    d = size_entry(
        portfolio=_portfolio(),
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000"),
        min_order_size=Decimal("1"),
        rank_score=1.0,
        confidence=1.0,
        condition_id=COND,
    )
    # 5% of 1000 units.
    assert d.quantity <= Decimal("50")


def test_cluster_cap_binds_across_wallets_of_one_desk() -> None:
    p = _portfolio()
    p.exposure_by_cluster["desk-A"] = Decimal("25000")  # at the 25% cap
    d = size_entry(
        portfolio=p,
        policy=RiskPolicy(),
        limit_price=Decimal("0.40"),
        book_depth=Decimal("1000000"),
        min_order_size=Decimal("5"),
        rank_score=1.0,
        confidence=1.0,
        condition_id="other-market",
        cluster_key="desk-A",
    )
    assert d.skipped_reason == "cluster_cap"


# ── shadow broker ─────────────────────────────────────────────────────


def test_fok_is_all_or_nothing() -> None:
    """A partial fill recorded as a smaller position would invent
    liquidity and inflate the fill rate the gate exists to measure."""

    fill = simulate(
        side="BUY",
        quantity=Decimal("1000"),
        limit_price=Decimal("0.42"),
        levels=[(Decimal("0.41"), Decimal("100"))],
        fee_rate=Decimal("0.02"),
    )
    assert not fill.filled
    assert fill.reason == REASON_INSUFFICIENT_DEPTH
    assert fill.filled_quantity == Decimal("0")


def test_depth_beyond_the_limit_is_absent_not_expensive() -> None:
    """Levels worse than the limit are not liquidity we can reach.

    The top of book (0.41) is inside a 0.42 limit, but only 100 units sit
    there; the 0.44 level is unreachable. A bounded order does not "walk
    through" its own limit to fill, so this is an insufficient-depth
    rejection, not a fill at a worse average.
    """

    fill = simulate(
        side="BUY",
        quantity=Decimal("200"),
        limit_price=Decimal("0.42"),
        levels=[(Decimal("0.41"), Decimal("100")), (Decimal("0.44"), Decimal("100"))],
        fee_rate=Decimal("0"),
    )
    assert not fill.filled
    assert fill.reason == REASON_INSUFFICIENT_DEPTH


def test_a_filled_vwap_never_exceeds_the_limit() -> None:
    """The invariant that makes a separate VWAP check unnecessary: every
    consumed level is within the bound, so their weighted average is."""

    fill = simulate(
        side="BUY",
        quantity=Decimal("150"),
        limit_price=Decimal("0.45"),
        levels=[
            (Decimal("0.41"), Decimal("100")),
            (Decimal("0.44"), Decimal("100")),
            (Decimal("0.90"), Decimal("100")),  # unreachable
        ],
        fee_rate=Decimal("0"),
    )
    assert fill.filled
    assert fill.vwap is not None and fill.vwap <= Decimal("0.45")


def test_no_reachable_level_is_a_limit_rejection() -> None:
    fill = simulate(
        side="BUY",
        quantity=Decimal("10"),
        limit_price=Decimal("0.42"),
        levels=[(Decimal("0.55"), Decimal("10000"))],
        fee_rate=Decimal("0"),
    )
    assert not fill.filled
    assert fill.reason == REASON_LIMIT_EXCEEDED


def test_a_stale_book_does_not_fill() -> None:
    fill = simulate(
        side="BUY",
        quantity=Decimal("10"),
        limit_price=Decimal("0.42"),
        levels=[(Decimal("0.41"), Decimal("10000"))],
        fee_rate=Decimal("0"),
        book_age_s=120.0,
    )
    assert not fill.filled
    assert fill.reason == REASON_STALE_BOOK


def test_a_good_fill_prices_at_vwap_and_charges_fees() -> None:
    fill = simulate(
        side="BUY",
        quantity=Decimal("100"),
        limit_price=Decimal("0.45"),
        levels=[(Decimal("0.40"), Decimal("50")), (Decimal("0.44"), Decimal("50"))],
        fee_rate=Decimal("0.02"),
        source_price=Decimal("0.40"),
    )
    assert fill.filled
    assert fill.vwap == Decimal("0.42")
    assert fill.fees == Decimal("0.42") * Decimal("100") * Decimal("0.02")
    assert fill.slippage_vs_source == Decimal("0.02")


def test_shadow_stats_report_fill_rate_over_qualified_signals() -> None:
    stats = ShadowStats()
    stats.observe(
        simulate(
            side="BUY",
            quantity=Decimal("10"),
            limit_price=Decimal("0.45"),
            levels=[(Decimal("0.41"), Decimal("100"))],
            fee_rate=Decimal("0"),
            source_price=Decimal("0.40"),
        )
    )
    for _ in range(3):
        stats.observe(
            simulate(
                side="BUY",
                quantity=Decimal("1000"),
                limit_price=Decimal("0.45"),
                levels=[(Decimal("0.41"), Decimal("10"))],
                fee_rate=Decimal("0"),
            )
        )
    assert stats.qualified == 4
    assert stats.filled == 1
    assert stats.fill_rate == 0.25
    assert stats.reasons[REASON_INSUFFICIENT_DEPTH] == 3


# ── lots ──────────────────────────────────────────────────────────────


def _lot(qty: str = "100", at: datetime = T0, source: str = WALLET):  # type: ignore[no-untyped-def]
    return open_lot(
        mode="shadow",
        source_wallet=source,
        source_cluster_key="c1",
        condition_id=COND,
        outcome_token_id=TOKEN,
        side="BUY",
        opened_at=at,
        entry_price=Decimal("0.40"),
        quantity=Decimal(qty),
    )


def test_exit_mirrors_the_sources_percentage_not_its_absolute_size() -> None:
    lots = [_lot("100"), _lot("300", at=T0 + timedelta(hours=1))]
    plan = plan_exit(
        lots, source_wallet=WALLET, outcome_token_id=TOKEN, reduction_ratio=Decimal("0.25")
    )
    # 25% of the 400 we hold from this source.
    assert plan.total_quantity == Decimal("100")
    # Oldest lot first.
    assert plan.legs[0].lot_id == lots[0].id


def test_we_never_sell_lots_opened_from_a_different_source() -> None:
    """Our holding in a market may include lots from another source with
    a different view and a different entry."""

    ours = _lot("100", source=WALLET)
    theirs = _lot("900", source="0xother")
    plan = plan_exit(
        [ours, theirs],
        source_wallet=WALLET,
        outcome_token_id=TOKEN,
        reduction_ratio=Decimal("1.0"),
    )
    assert plan.total_quantity == Decimal("100")
    assert all(leg.lot_id == ours.id for leg in plan.legs)


def test_a_source_selling_something_we_never_copied_is_not_our_trade() -> None:
    plan = plan_exit(
        [], source_wallet=WALLET, outcome_token_id=TOKEN, reduction_ratio=Decimal("0.5")
    )
    assert not plan.actionable
    assert plan.reason == "no_matching_lots"


def test_we_never_go_short_even_if_the_source_reverses() -> None:
    """A source can exit more than 100% of its starting position by
    flipping. We mirror at most everything we hold."""

    lot = _lot("100")
    plan = plan_exit(
        [lot], source_wallet=WALLET, outcome_token_id=TOKEN, reduction_ratio=Decimal("2.5")
    )
    assert plan.total_quantity == Decimal("100")

    lots = {lot.id: lot}
    apply_exit(lots, plan, exit_price=Decimal("0.50"), at=T0 + timedelta(days=1))
    assert lot.quantity_open == Decimal("0")
    assert lot.status == "closed"
    assert lot.realized_pnl == Decimal("10")  # (0.50-0.40) * 100


def test_settlement_closes_open_lots() -> None:
    """A resolved market that leaves an open lot makes every NAV,
    exposure cap and drawdown check read off a position that no longer
    exists."""

    lot = _lot("100")
    settled = settle_lots(
        [lot], outcome_token_id=TOKEN, resolution_price=Decimal("1"), at=T0 + timedelta(days=30)
    )
    assert len(settled) == 1
    assert lot.status == STATUS_SETTLED
    assert lot.quantity_open == Decimal("0")
    assert lot.realized_pnl == Decimal("60")  # (1.00-0.40) * 100
    assert lot.settlement_price == Decimal("1")


def test_settlement_at_zero_realises_the_full_loss() -> None:
    lot = _lot("100")
    settle_lots(
        [lot], outcome_token_id=TOKEN, resolution_price=Decimal("0"), at=T0 + timedelta(days=30)
    )
    assert lot.realized_pnl == Decimal("-40")


# ── pipeline ──────────────────────────────────────────────────────────


def test_pipeline_accepts_sizes_fills_and_opens_a_lot() -> None:
    ev = evaluate_action(
        _action(),
        _source(),
        _market(levels=[(Decimal("0.41"), Decimal("500000"))]),
        _portfolio(),
        now=T0 + timedelta(seconds=20),
    )
    assert ev.accepted, ev.qualification.as_dict()
    assert ev.fill is not None and ev.fill.filled
    assert ev.lot is not None
    assert ev.lot.status == STATUS_OPEN
    assert ev.reject_reason is None


def test_pipeline_records_a_rejection_rather_than_returning_nothing() -> None:
    """The rejected evaluations ARE the output early on."""

    ev = evaluate_action(
        _action(),
        _source(in_feeder_set=False),
        _market(),
        _portfolio(),
        now=T0 + timedelta(seconds=20),
    )
    assert not ev.accepted
    assert ev.reject_reason == "feeder_member"
    assert ev.qualification.as_dict()  # full gate picture retained
    assert ev.lot is None


def test_passing_gates_but_sized_to_zero_is_a_rejection_not_an_acceptance() -> None:
    p = _portfolio(nav=Decimal("80000"), day_start_nav=Decimal("100000"))
    ev = evaluate_action(
        _action(),
        _source(),
        _market(levels=[(Decimal("0.41"), Decimal("500000"))]),
        p,
        now=T0 + timedelta(seconds=20),
    )
    assert ev.qualification.accepted
    assert not ev.accepted
    assert ev.reject_reason == "daily_drawdown_halt"


def test_evaluation_is_pure_until_applied() -> None:
    """A dry run must not mutate the book it is measuring against."""

    p = _portfolio()
    cash_before = p.cash
    ev = evaluate_action(
        _action(),
        _source(),
        _market(levels=[(Decimal("0.41"), Decimal("500000"))]),
        p,
        now=T0 + timedelta(seconds=20),
    )
    assert p.cash == cash_before
    apply_to_portfolio(p, ev)
    assert p.cash < cash_before
    assert p.exposure_by_market[COND] > Decimal("0")
    assert p.exposure_by_cluster["c1"] > Decimal("0")
