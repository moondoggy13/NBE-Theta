"""Candidate-seeder + wallet-backfill replay tests (in-memory store).

Covers the AGENTS.md ingest requirements for this source: recorded
fixtures, pagination edges, dedupe, and cursor-restart with zero
duplicate rows. No live API, no database.
"""

from __future__ import annotations

from typing import Any

import pytest

from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.backfill import WalletBackfillIngestor
from nbe_theta.ingest.candidates import CandidateSeeder, SeedConfig
from nbe_theta.ingest.dataapi import VENUE, DataApiClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import InMemoryWalletStore
from tests.conftest import RecordedDataApiFetcher

WALLET = "0xaaa1000000000000000000000000000000000001"
# page1 has 4 valid trades, page2 has 2 valid (3 malformed dropped).
VALID_TRADE_COUNT = 6


def _no_wait() -> RateLimiter:
    # Deterministic: never actually sleeps.
    return RateLimiter(0.0)


def _backfill(
    store: InMemoryWalletStore,
    trade_pages: list[list[dict[str, Any]]],
    *,
    page_limit: int,
    fail_after: int | None = None,
    max_pages: int = 0,
) -> WalletBackfillIngestor:
    fetcher = RecordedDataApiFetcher(trade_pages=trade_pages, fail_after=fail_after)
    client = DataApiClient(fetcher, page_limit=page_limit)
    return WalletBackfillIngestor(
        client, store, InMemoryArchive(), _no_wait(), page_limit=page_limit, max_pages=max_pages
    )


# ── candidate seeding ─────────────────────────────────────────────


def test_seeder_ranks_leaderboard_and_promotes(leaderboard_rows: Any, holder_rows: Any) -> None:
    store = InMemoryWalletStore()
    fetcher = RecordedDataApiFetcher(leaderboard=leaderboard_rows, holders=holder_rows)
    seeder = CandidateSeeder(
        DataApiClient(fetcher),
        store,
        _no_wait(),
        SeedConfig(leaderboard_windows=("WEEK",), leaderboard_orders=("pnl",)),
    )
    result = seeder.run(condition_ids=["0xcond1001"])

    # 4 valid leaderboard rows + 3 valid holders (malformed dropped).
    assert result.seeded == 7
    assert result.promoted > 0
    # Highest-ranked leaderboard wallet gets the top priority.
    top = [k for k in store.candidates if k[2] == "leaderboard:WEEK:pnl"]
    assert any(k[1] == "0xaaa1000000000000000000000000000000000001" for k in top)
    # Every promoted address is marked, so it won't be re-promoted.
    assert store.list_promotable(10) == []


def test_seeder_keeps_highest_priority_per_source(leaderboard_rows: Any) -> None:
    store = InMemoryWalletStore()
    fetcher = RecordedDataApiFetcher(leaderboard=leaderboard_rows)
    cfg = SeedConfig(leaderboard_windows=("WEEK",), leaderboard_orders=("pnl",))
    CandidateSeeder(DataApiClient(fetcher), store, _no_wait(), cfg).seed_leaderboards()
    first = dict(store.candidates)
    # Re-seeding the same board must not lower a stored priority.
    CandidateSeeder(DataApiClient(fetcher), store, _no_wait(), cfg).seed_leaderboards()
    assert store.candidates == first


# ── backfill ──────────────────────────────────────────────────────


def test_backfill_writes_all_valid_trades(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    result = _backfill(store, trades_pages, page_limit=100).backfill_wallet(WALLET)
    assert result.trades_written == VALID_TRADE_COUNT
    assert len(store.trades) == VALID_TRADE_COUNT
    assert all(k[0] == VENUE for k in store.trades)
    # Wallet identity window spans the observed trades.
    w = store.wallets[(137, WALLET)]
    assert w.first_seen is not None and w.last_seen is not None
    assert w.first_seen < w.last_seen


def test_backfill_pagination_small_pages(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    result = _backfill(store, trades_pages, page_limit=2).backfill_wallet(WALLET)
    assert result.pages >= 4
    assert len(store.trades) == VALID_TRADE_COUNT


def test_backfill_rerun_is_idempotent(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    _backfill(store, trades_pages, page_limit=2).backfill_wallet(WALLET)
    snapshot = dict(store.trades)
    second = _backfill(store, trades_pages, page_limit=2).backfill_wallet(WALLET)
    # Every trade already present → nothing newly written, no dupes.
    assert second.trades_written == 0
    assert store.trades == snapshot


def test_backfill_crash_restart_no_duplicates(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    with pytest.raises(RuntimeError, match="simulated crash"):
        _backfill(store, trades_pages, page_limit=2, fail_after=1).backfill_wallet(WALLET)

    partial = len(store.trades)
    assert 0 < partial < VALID_TRADE_COUNT
    assert store.get_cursor(f"trades:{WALLET}") == '{"offset": 2}'

    _backfill(store, trades_pages, page_limit=2).backfill_wallet(WALLET)
    assert len(store.trades) == VALID_TRADE_COUNT


def test_backfill_max_pages_bounds_run(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    result = _backfill(store, trades_pages, page_limit=2, max_pages=1).backfill_wallet(WALLET)
    assert result.pages == 1
    assert result.completed is False
    # Bounded run keeps its cursor for the next invocation.
    assert store.get_cursor(f"trades:{WALLET}") == '{"offset": 2}'


def test_backfill_records_run_row(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    _backfill(store, trades_pages, page_limit=100).backfill_wallet(WALLET)
    assert all(r["status"] == "completed" for r in store.runs.values())


def test_backfill_records_failure_row(trades_pages: Any) -> None:
    store = InMemoryWalletStore()
    with pytest.raises(RuntimeError):
        _backfill(store, trades_pages, page_limit=2, fail_after=1).backfill_wallet(WALLET)
    assert any(r["status"] == "failed" for r in store.runs.values())


# ── rate limiter ──────────────────────────────────────────────────


def test_rate_limiter_waits_between_acquires() -> None:
    now = [0.0]
    slept: list[float] = []

    def clock() -> float:
        return now[0]

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    rl = RateLimiter(0.5, clock=clock, sleep=sleep)
    rl.acquire()  # first is free
    rl.acquire()  # must wait the full interval
    assert slept == [0.5]

    now[0] += 10.0
    rl.acquire()  # long gap → no wait
    assert slept == [0.5]


def test_rate_limiter_zero_interval_never_sleeps() -> None:
    slept: list[float] = []
    rl = RateLimiter(0.0, clock=lambda: 0.0, sleep=lambda s: slept.append(s))
    rl.acquire()
    rl.acquire()
    assert slept == []
