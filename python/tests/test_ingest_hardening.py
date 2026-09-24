"""Regression tests for three ingest-integrity gaps.

Each of these protects a property the ingest layer already claims to
have. They are grouped because they share one theme: what reaches
``venue_trades`` must be exactly the set of real, valid fills — no
duplicates, no unvalidated rows — since ledger reconstruction and
wallet scoring treat that table as already-clean.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.backfill import WalletBackfillIngestor
from nbe_theta.ingest.candidates import CandidateSeeder, SeedConfig
from nbe_theta.ingest.dataapi import DataApiClient, _synthesize_trade_id, parse_trade
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.validation import validate_trade
from nbe_theta.ingest.wallet_store import InMemoryWalletStore
from tests.conftest import RecordedDataApiFetcher

TS = datetime.fromtimestamp(1814227200, tz=UTC)
W = "0xaaa1000000000000000000000000000000000001"
COND, TOKEN = "0xcond1001", "11110001"


def _id(price: Decimal, qty: Decimal) -> str:
    return _synthesize_trade_id(W, COND, TOKEN, "BUY", price, qty, TS, "0xtx1")


# ── 1. dedupe id is representation-independent ────────────────────


def test_trailing_zeros_do_not_fork_the_dedupe_id() -> None:
    """ "0.40" and 0.4 are the SAME fill. If they hash apart, the unique
    constraint never fires and the trade is inserted twice."""

    assert _id(Decimal("0.40"), Decimal("250")) == _id(Decimal("0.4"), Decimal("250"))
    assert _id(Decimal("0.43"), Decimal("250")) == _id(Decimal("0.43"), Decimal("250.0"))
    assert _id(Decimal(".5"), Decimal("250")) == _id(Decimal("0.50"), Decimal("250"))


def test_exponent_and_zero_forms_are_canonical() -> None:
    assert _id(Decimal("0.43"), Decimal("1000")) == _id(Decimal("0.43"), Decimal("1E+3"))
    # -0, 0.0 and 0 must not fork (quantity is guarded elsewhere, but the
    # canonicalizer itself has to be total).
    assert _id(Decimal("0.43"), Decimal("-0")) == _id(Decimal("0.43"), Decimal("0.0"))


def test_genuinely_different_fills_still_hash_apart() -> None:
    """Canonicalization must not over-collapse — distinct economics stay distinct."""

    base = _id(Decimal("0.43"), Decimal("250"))
    assert base != _id(Decimal("0.44"), Decimal("250"))
    assert base != _id(Decimal("0.43"), Decimal("251"))
    assert base != _synthesize_trade_id(
        W, COND, "22220002", "BUY", Decimal("0.43"), Decimal("250"), TS, "0xtx1"
    )
    assert base != _synthesize_trade_id(
        W, COND, TOKEN, "SELL", Decimal("0.43"), Decimal("250"), TS, "0xtx1"
    )


def test_reingesting_the_same_fill_written_two_ways_is_idempotent() -> None:
    """End-to-end: the same fill served with 0.40 then 0.4 must produce
    ONE row, not two."""

    row_a = {
        "proxyWallet": W,
        "conditionId": COND,
        "asset": TOKEN,
        "side": "BUY",
        "price": "0.40",
        "size": "250",
        "timestamp": 1814227200,
        "transactionHash": "0xTX0001",
    }
    row_b = dict(row_a, price=0.4, size=250)  # same fill, numeric form

    store = InMemoryWalletStore()
    raw_id = uuid.uuid4()
    for row in (row_a, row_b):
        t = parse_trade(row)
        assert t is not None
        store.upsert_trade(t, raw_id)
    assert len(store.trades) == 1


# ── 2. contract validation gates the backfill ─────────────────────


def _bad_price_row() -> dict[str, Any]:
    """price > 1 is impossible for an outcome token; the parser lets it
    through (it only rejects < 0), so the contract is the real gate."""

    return {
        "proxyWallet": W,
        "conditionId": COND,
        "asset": TOKEN,
        "side": "BUY",
        "price": "1.40",
        "size": "250",
        "timestamp": 1814227200,
        "transactionHash": "0xBAD01",
    }


def test_parser_alone_does_not_reject_an_impossible_price() -> None:
    t = parse_trade(_bad_price_row())
    assert t is not None and t.price == Decimal("1.40")
    assert validate_trade(t, uuid.uuid4()) is False


def _run_backfill(rows: list[dict[str, Any]]) -> tuple[int, InMemoryWalletStore]:
    store = InMemoryWalletStore()
    ingestor = WalletBackfillIngestor(
        DataApiClient(RecordedDataApiFetcher(trade_pages=[rows]), page_limit=50),
        store,
        InMemoryArchive(),
        RateLimiter(0.0),
        page_limit=50,
    )
    return ingestor.backfill_wallet(W).trades_written, store


def test_backfill_drops_contract_invalid_rows(trades_pages: list[list[dict[str, Any]]]) -> None:
    """Adding a contract-invalid row must change nothing that lands."""

    good = [r for p in trades_pages for r in p]
    control, _ = _run_backfill(good)
    written, store = _run_backfill([*good, _bad_price_row()])

    assert written == control  # the bad row contributed nothing
    assert all(t.price <= Decimal("1") for t in store.trades.values())


# ── 3. the global tape seeds candidates ───────────────────────────


def _seeder(fetcher: RecordedDataApiFetcher, store: InMemoryWalletStore) -> CandidateSeeder:
    return CandidateSeeder(
        DataApiClient(fetcher, page_limit=50),
        store,
        RateLimiter(0.0),
        SeedConfig(large_trade_min_usd=500.0, large_trade_limit=100),
    )


def test_tape_seeds_wallets_acting_right_now(tape_rows: list[dict[str, Any]]) -> None:
    store = InMemoryWalletStore()
    seeded = _seeder(RecordedDataApiFetcher(recent_trades=tape_rows), store).seed_large_trades()

    # 4 raw rows; the malformed address is dropped.
    assert seeded == 3
    sources = {src for (_chain, _addr, src) in store.candidates}
    assert sources == {"large-trade"}


def test_tape_priority_is_magnitude_ranked_and_bounded(
    tape_rows: list[dict[str, Any]],
) -> None:
    store = InMemoryWalletStore()
    _seeder(RecordedDataApiFetcher(recent_trades=tape_rows), store).seed_large_trades()

    whale = store.candidates[
        (137, "0xeee5000000000000000000000000000000000005", "large-trade")
    ].priority_score
    minnow = store.candidates[
        (137, "0xaaa1000000000000000000000000000000000001", "large-trade")
    ].priority_score
    # $10k notional outranks $645, but log-scaling keeps it on the same
    # [0,1] scale the leaderboard/holder sources use.
    assert whale > minnow
    assert 0.0 < minnow <= whale <= 1.0


def test_tape_applies_the_notional_floor_server_side(
    tape_rows: list[dict[str, Any]],
) -> None:
    fetcher = RecordedDataApiFetcher(recent_trades=tape_rows)
    _seeder(fetcher, InMemoryWalletStore()).seed_large_trades()
    assert fetcher.calls == ["/trades"]  # one request, floor pushed to the venue


def test_seed_run_includes_the_tape(
    leaderboard_rows: list[dict[str, Any]], tape_rows: list[dict[str, Any]]
) -> None:
    """The tape is part of the standard seed, not an opt-in extra."""

    store = InMemoryWalletStore()
    fetcher = RecordedDataApiFetcher(leaderboard=leaderboard_rows, recent_trades=tape_rows)
    result = _seeder(fetcher, store).run()

    assert "/trades" in fetcher.calls
    tape_seeded = {a for (_c, a, src) in store.candidates if src == "large-trade"}
    assert len(tape_seeded) == 3
    assert result.seeded > len(tape_seeded)  # leaderboard contributed too
