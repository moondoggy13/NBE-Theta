"""``theta-live-monitor`` command.

  theta-live-monitor run           24/7 loop (watchlist sync, positions,
                                   leaderboard, heartbeat)
  theta-live-monitor run --once    a single tick, then exit (cron-friendly)
  theta-live-monitor watch 0x…     add wallet(s) to the watchlist

The loop assumes `theta-wallet-backfill` has already seeded candidates
and backfilled history; the monitor only keeps the tracked set current.
Connects via DATABASE_URL and the real httpx fetcher; unit tests drive
LiveMonitor directly with fixtures.
"""

from __future__ import annotations

import time

import typer

from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.http import HttpxFetcher
from nbe_theta.common.logging import configure_logging, get_logger
from nbe_theta.ingest.archive import FsArchive
from nbe_theta.ingest.dataapi import DataApiClient
from nbe_theta.ingest.intel_store import PostgresIntelStore
from nbe_theta.ingest.monitor import LiveMonitor, MonitorConfig
from nbe_theta.ingest.positions import PositionsClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import PostgresWalletStore

app = typer.Typer(add_completion=False, help="Polymarket wallet live monitor.")


def _fetcher(settings) -> HttpxFetcher:  # type: ignore[no-untyped-def]
    return HttpxFetcher(
        base_url=settings.data_api_base_url,
        timeout_s=settings.data_api_timeout_s,
        ca_bundle=settings.ca_bundle,
    )


def _config(settings) -> MonitorConfig:  # type: ignore[no-untyped-def]
    return MonitorConfig(
        sync_overlap_s=settings.sync_overlap_s,
        sync_max_pages=settings.sync_max_pages,
        positions_refresh_s=settings.positions_refresh_s,
        leaderboard_refresh_s=settings.leaderboard_refresh_s,
        leaderboard_limit=settings.leaderboard_limit,
    )


@app.command()
def run(
    interval_s: float = typer.Option(
        0.0, help="Seconds between ticks (default: MONITOR_INTERVAL_S)."
    ),
    once: bool = typer.Option(False, help="Run a single tick and exit (cron-friendly)."),
) -> None:
    """Keep tracked wallets current: trades, positions, leaderboard."""

    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("ingest.monitor_cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    fetcher = _fetcher(settings)
    client = DataApiClient(fetcher, page_limit=settings.data_api_page_limit)
    positions = PositionsClient(fetcher, page_limit=settings.data_api_page_limit)
    limiter = RateLimiter(settings.data_api_min_interval_s)
    archive = FsArchive(settings.raw_archive_dir)
    cfg = _config(settings)
    sleep_s = interval_s or settings.monitor_interval_s

    while True:
        with connect(settings.database_url) as conn:
            monitor = LiveMonitor(
                client,
                positions,
                PostgresWalletStore(conn),
                PostgresIntelStore(conn),
                archive,
                limiter,
                cfg,
            )
            result = monitor.tick()
            log.info(
                "tick done",
                synced=result.wallets_synced,
                trades=result.sync_trades,
                positions=result.positions_refreshed,
                leaderboard=result.leaderboard_swept,
                errors=len(result.errors),
            )
        if once:
            break
        time.sleep(sleep_s)


@app.command()
def watch(
    wallet: list[str] = typer.Argument(..., help="Wallet address(es) to start tracking."),
    copy: bool = typer.Option(False, help="Mark as 'copy' rather than 'watch'."),
    note: str = typer.Option("", help="Optional operator note."),
) -> None:
    """Add wallets to the watchlist (insert-only; never overwrites)."""

    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("ingest.monitor_cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    status = "copy" if copy else "watch"
    added = 0
    with connect(settings.database_url) as conn:
        intel = PostgresIntelStore(conn)
        for raw in wallet:
            addr = raw.strip().lower()
            if not (addr.startswith("0x") and len(addr) == 42):
                raise typer.BadParameter(f"not a wallet address: {raw!r}")
            if intel.add_watchlist(addr, status=status, note=note or None, added_by="cli"):
                added += 1
        conn.commit()
    log.info("watchlist updated", requested=len(wallet), added=added, status=status)


if __name__ == "__main__":
    app()
