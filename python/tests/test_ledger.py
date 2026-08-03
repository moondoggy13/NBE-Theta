"""Ledger + episode construction tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.ledger.entries import (
    ENTRY_BUY,
    ENTRY_SELL,
    TradeRow,
    entries_from_trades,
    entry_from_trade,
)
from nbe_theta.ledger.episodes import EpisodeAlgorithm, build_all, build_episodes

T0 = datetime(2027, 1, 1, tzinfo=UTC)


def trade(
    *,
    side: str = "BUY",
    price: str = "0.40",
    qty: str = "100",
    minutes: int = 0,
    tid: str | None = None,
    token: str = "tok1",
    cid: str = "c1",
) -> TradeRow:
    p, q = Decimal(price), Decimal(qty)
    return TradeRow(
        source_trade_id=tid or f"{side}-{price}-{qty}-{minutes}",
        wallet="0xw1",
        condition_id=cid,
        outcome_token_id=token,
        side=side,
        price=p,
        quantity=q,
        notional=p * q,
        occurred_at=T0 + timedelta(minutes=minutes),
    )


# ── entries ───────────────────────────────────────────────────────


def test_buy_is_shares_in_cash_out() -> None:
    e = entry_from_trade(trade(side="BUY", price="0.40", qty="100"))
    assert e.entry_type == ENTRY_BUY
    assert e.share_delta == Decimal("100")
    assert e.cash_delta == Decimal("-40.00")


def test_sell_is_shares_out_cash_in() -> None:
    e = entry_from_trade(trade(side="SELL", price="0.60", qty="50"))
    assert e.entry_type == ENTRY_SELL
    assert e.share_delta == Decimal("-50")
    assert e.cash_delta == Decimal("30.00")


def test_entries_preserve_source_id_for_idempotence() -> None:
    ts = [trade(tid="a"), trade(tid="b", minutes=1)]
    assert [e.source_id for e in entries_from_trades(ts)] == ["a", "b"]


# ── episodes ──────────────────────────────────────────────────────


def test_scaling_in_is_one_episode_not_many() -> None:
    """The core correction: 4 fills of one decision must not count as 4
    independent observations."""

    entries = entries_from_trades(
        [
            trade(tid="1", qty="25", minutes=0),
            trade(tid="2", qty="25", minutes=5),
            trade(tid="3", qty="25", minutes=10),
            trade(tid="4", qty="25", minutes=15),
        ]
    )
    eps = build_episodes(entries)
    assert len(eps) == 1
    assert eps[0].n_fills == 4
    assert eps[0].maximum_shares == Decimal("100")


def test_flat_then_new_activity_starts_new_episode() -> None:
    entries = entries_from_trades(
        [
            trade(tid="1", side="BUY", qty="100", minutes=0),
            trade(tid="2", side="SELL", qty="100", minutes=10),  # back to flat
            trade(tid="3", side="BUY", qty="50", minutes=20),  # new decision
        ]
    )
    eps = build_episodes(entries)
    assert len(eps) == 2
    assert eps[0].status == "closed"


def test_inactivity_gap_splits_episodes() -> None:
    algo = EpisodeAlgorithm(version="test-1h", inactivity_gap=timedelta(hours=1))
    entries = entries_from_trades(
        [
            trade(tid="1", qty="10", minutes=0),
            trade(tid="2", qty="10", minutes=30),  # within gap
            trade(tid="3", qty="10", minutes=300),  # 4.5h later → new episode
        ]
    )
    eps = build_episodes(entries, algorithm=algo)
    assert len(eps) == 2
    assert eps[0].n_fills == 2


def test_reversal_starts_new_episode() -> None:
    entries = entries_from_trades(
        [
            trade(tid="1", side="BUY", qty="100", minutes=0),
            trade(tid="2", side="SELL", qty="150", minutes=5),  # flips to short
        ]
    )
    eps = build_episodes(entries)
    assert len(eps) == 2
    assert eps[0].direction == "BUY"
    assert eps[1].direction == "SELL"


def test_entry_and_exit_vwap_are_not_blended() -> None:
    entries = entries_from_trades(
        [
            trade(tid="1", side="BUY", price="0.40", qty="100", minutes=0),
            trade(tid="2", side="BUY", price="0.60", qty="100", minutes=5),
            trade(tid="3", side="SELL", price="0.90", qty="200", minutes=10),
        ]
    )
    eps = build_episodes(entries)
    assert len(eps) == 1
    assert eps[0].entry_vwap == Decimal("0.5")  # (40+60)/200
    assert eps[0].exit_vwap == Decimal("0.9")


def test_open_inventory_priced_at_resolution() -> None:
    entries = entries_from_trades([trade(tid="1", side="BUY", price="0.30", qty="100")])
    eps = build_episodes(entries, resolution_price=Decimal("1"), resolved=True)
    assert len(eps) == 1
    assert eps[0].status == "resolved"
    # 100 shares × $1 settled.
    assert eps[0].resolution_pnl == Decimal("100")
    # Cash leg was -$30.
    assert eps[0].realized_pnl == Decimal("-30.00")


def test_unresolved_open_inventory_stays_open() -> None:
    entries = entries_from_trades([trade(tid="1", side="BUY", qty="100")])
    eps = build_episodes(entries)
    assert eps[0].status == "open"
    assert eps[0].resolution_pnl is None
    assert eps[0].closed_at is None


def test_build_all_groups_by_wallet_and_outcome() -> None:
    entries = entries_from_trades(
        [
            trade(tid="1", token="tokA", cid="cA"),
            trade(tid="2", token="tokB", cid="cB"),
        ]
    )
    eps = build_all(entries)
    assert len(eps) == 2
    assert {e.outcome_token_id for e in eps} == {"tokA", "tokB"}


def test_algorithm_version_is_recorded() -> None:
    algo = EpisodeAlgorithm(version="gap-99h", inactivity_gap=timedelta(hours=99))
    eps = build_episodes(entries_from_trades([trade(tid="1")]), algorithm=algo)
    assert eps[0].episode_algorithm_version == "gap-99h"


def test_alternative_algorithms_can_disagree() -> None:
    """Different gaps must produce different groupings — the reason the
    version is persisted rather than assumed."""

    entries = entries_from_trades(
        [trade(tid="1", qty="10", minutes=0), trade(tid="2", qty="10", minutes=90)]
    )
    tight = build_episodes(entries, algorithm=EpisodeAlgorithm("tight", timedelta(minutes=30)))
    loose = build_episodes(entries, algorithm=EpisodeAlgorithm("loose", timedelta(hours=6)))
    assert len(tight) == 2
    assert len(loose) == 1


def test_empty_input_yields_no_episodes() -> None:
    assert build_episodes([]) == []
    assert build_all([]) == []


def test_entries_sorted_regardless_of_input_order() -> None:
    entries = entries_from_trades(
        [trade(tid="late", qty="10", minutes=60), trade(tid="early", qty="10", minutes=0)]
    )
    eps = build_episodes(list(reversed(entries)))
    assert eps[0].opened_at == T0


def test_sell_side_entry_type() -> None:
    e = entry_from_trade(trade(side="SELL"))
    assert e.entry_type == ENTRY_SELL
