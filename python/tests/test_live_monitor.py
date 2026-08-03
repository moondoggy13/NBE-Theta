"""LiveMonitor tick tests: watermark-incremental sync, positions
full-replace + cadence gating, leaderboard cadence, and per-phase error
isolation. In-memory stores + recorded fetchers only (no live DB/API)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.dataapi import DataApiClient
from nbe_theta.ingest.intel_store import InMemoryIntelStore
from nbe_theta.ingest.monitor import (
    STREAM_LEADERBOARD,
    LiveMonitor,
    MonitorConfig,
    merge_watermark,
    positions_stream_key,
    read_watermark,
    trades_stream_key,
)
from nbe_theta.ingest.positions import PositionsClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import InMemoryWalletStore
from tests.conftest import RecordedDataApiFetcher

W1 = "0xaaa1000000000000000000000000000000000001"
W2 = "0xbbb2000000000000000000000000000000000002"

# The fixture corpus' newest trade timestamp (max across both pages).
NEWEST_TS = 1814659200
NOW = datetime.fromtimestamp(NEWEST_TS + 3600, tz=UTC)


class Clock:
    """Injectable, advanceable now()."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now = self.now + timedelta(seconds=seconds)


def _monitor(
    fetcher: RecordedDataApiFetcher,
    wallet_store: InMemoryWalletStore,
    intel: InMemoryIntelStore,
    clock: Clock,
    **overrides: Any,
) -> LiveMonitor:
    return LiveMonitor(
        DataApiClient(fetcher, page_limit=2),
        PositionsClient(fetcher, page_limit=2),
        wallet_store,
        intel,
        InMemoryArchive(),
        RateLimiter(0.0),
        MonitorConfig(**overrides),
        now_fn=clock,
    )


# ── cursor helpers ────────────────────────────────────────────────


def test_merge_watermark_preserves_backfill_cursor_fields() -> None:
    """The monitor shares trades:<wallet> with the backfill — advancing
    the watermark must never clobber the backfill's offset/complete."""

    backfill_cursor = '{"complete": true, "offset": 400, "total": 812}'
    ts = datetime.fromtimestamp(NEWEST_TS, tz=UTC)
    merged = merge_watermark(backfill_cursor, ts)
    assert read_watermark(merged) == ts
    import json

    payload = json.loads(merged)
    assert payload["complete"] is True
    assert payload["offset"] == 400
    assert payload["total"] == 812


def test_read_watermark_tolerates_garbage() -> None:
    assert read_watermark(None) is None
    assert read_watermark("not json") is None
    assert read_watermark("[]") is None
    assert read_watermark('{"offset": 5}') is None
    assert read_watermark('{"watermark": "nonsense"}') is None


# ── sync ──────────────────────────────────────────────────────────


def test_sync_ingests_watchlist_trades_and_sets_watermark(
    trades_pages: list[list[dict[str, Any]]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="watch", note=None, added_by="test")
    fetcher = RecordedDataApiFetcher(trade_pages=trades_pages)
    clock = Clock(NOW)

    result = _monitor(fetcher, ws, intel, clock).tick()

    assert result.wallets_synced == 1
    assert result.sync_trades > 0
    assert len(ws.trades) == result.sync_trades
    wm = read_watermark(ws.get_cursor(trades_stream_key(W1)))
    assert wm is not None and int(wm.timestamp()) == NEWEST_TS
    assert intel.heartbeats["theta-live-monitor"]["errors"] == 0


def test_second_tick_dedupes_the_overlap(
    trades_pages: list[list[dict[str, Any]]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="copy", note=None, added_by="test")
    fetcher = RecordedDataApiFetcher(trade_pages=trades_pages)
    clock = Clock(NOW)
    monitor = _monitor(fetcher, ws, intel, clock)

    first = monitor.tick()
    assert first.sync_trades > 0
    before = len(ws.trades)

    # Same corpus: every row is already stored, so the deliberate
    # re-read of the overlap window writes nothing new.
    second = monitor.tick()
    assert second.sync_trades == 0
    assert len(ws.trades) == before


def test_only_watchlisted_wallets_are_synced(
    trades_pages: list[list[dict[str, Any]]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="watch", note=None, added_by="test")
    intel.add_watchlist(W2, status="mute", note="noisy", added_by="operator")
    fetcher = RecordedDataApiFetcher(trade_pages=trades_pages)

    result = _monitor(fetcher, ws, intel, Clock(NOW)).tick()

    assert result.wallets_synced == 1  # muted wallet skipped entirely
    assert ws.get_cursor(trades_stream_key(W2)) is None


# ── positions ─────────────────────────────────────────────────────


def test_positions_replace_snapshot_and_respect_cadence(
    position_rows: list[dict[str, Any]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="watch", note=None, added_by="test")
    fetcher = RecordedDataApiFetcher(positions=position_rows)
    clock = Clock(NOW)
    monitor = _monitor(fetcher, ws, intel, clock, positions_refresh_s=300.0)

    first = monitor.tick()
    assert first.positions_refreshed == 1
    assert len(intel.positions[W1]) == 3  # malformed row dropped
    assert intel.positions_captured_at[W1] == NOW

    # Not yet due: the shrunken corpus is ignored.
    clock.advance(30)
    fetcher.positions = position_rows[:1]
    assert monitor.tick().positions_refreshed == 0
    assert len(intel.positions[W1]) == 3

    # Past the cadence: full-replace, so exits disappear.
    clock.advance(300)
    assert monitor.tick().positions_refreshed == 1
    assert len(intel.positions[W1]) == 1


# ── leaderboard ───────────────────────────────────────────────────


def test_leaderboard_sweep_honors_interval_and_files_candidates(
    leaderboard_rows: list[dict[str, Any]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    fetcher = RecordedDataApiFetcher(leaderboard=leaderboard_rows)
    clock = Clock(NOW)
    monitor = _monitor(fetcher, ws, intel, clock, leaderboard_refresh_s=3600.0)

    assert monitor.tick().leaderboard_swept
    rows_after_first = len(intel.leaderboard_rows)
    assert rows_after_first > 0
    # Ranked wallets entered the existing candidate funnel.
    assert len(ws.candidates) > 0
    wm = read_watermark(ws.get_cursor(STREAM_LEADERBOARD))
    assert wm == NOW

    clock.advance(60)
    assert not monitor.tick().leaderboard_swept
    assert len(intel.leaderboard_rows) == rows_after_first

    clock.advance(3700)
    assert monitor.tick().leaderboard_swept
    assert len(intel.leaderboard_rows) == rows_after_first * 2


# ── isolation ─────────────────────────────────────────────────────


def test_positions_failure_does_not_abort_the_tick(
    trades_pages: list[list[dict[str, Any]]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="watch", note=None, added_by="test")
    fetcher = RecordedDataApiFetcher(trade_pages=trades_pages, fail_paths={"/positions"})

    result = _monitor(fetcher, ws, intel, Clock(NOW)).tick()

    # Trades still synced; the positions phase is recorded as an error.
    assert result.wallets_synced == 1
    assert result.sync_trades > 0
    assert result.positions_refreshed == 0
    assert any(f"positions:{W1}" in e for e in result.errors)
    assert ws.runs[result.run_id]["status"] == "failed"
    assert intel.heartbeats["theta-live-monitor"]["errors"] == len(result.errors)


def test_sync_failure_for_one_wallet_leaves_others_working(
    position_rows: list[dict[str, Any]],
) -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    intel.add_watchlist(W1, status="watch", note=None, added_by="test")
    fetcher = RecordedDataApiFetcher(positions=position_rows, fail_paths={"/trades"})

    result = _monitor(fetcher, ws, intel, Clock(NOW)).tick()

    assert result.wallets_synced == 0
    assert any(f"sync:{W1}" in e for e in result.errors)
    # The positions phase for the same wallet still ran.
    assert result.positions_refreshed == 1
    assert len(intel.positions[W1]) == 3


def test_positions_cadence_is_per_wallet() -> None:
    ws, intel = InMemoryWalletStore(), InMemoryIntelStore()
    clock = Clock(NOW)
    monitor = _monitor(RecordedDataApiFetcher(), ws, intel, clock, positions_refresh_s=300.0)
    # W1 refreshed a moment ago, W2 never → only W2 is due.
    ws.set_cursor(positions_stream_key(W1), merge_watermark(None, NOW))
    assert monitor._positions_due(W1) is False
    assert monitor._positions_due(W2) is True


# ── watchlist curation ────────────────────────────────────────────


def test_add_watchlist_never_overwrites_operator_curation() -> None:
    intel = InMemoryIntelStore()
    assert intel.add_watchlist(W1, status="mute", note="operator", added_by="operator")
    assert not intel.add_watchlist(W1, status="watch", note="auto", added_by="discovery")
    assert intel.watchlist_rows[W1].status == "mute"
    assert intel.watchlist(statuses=("watch", "copy")) == []
