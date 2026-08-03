"""``theta-wallet-backfill`` command.

  theta-wallet-backfill seed [--market CID ...]   discover + promote candidates
  theta-wallet-backfill run  [--wallet ADDR ...]  backfill promoted wallets
                                                  [--limit N] [--max-pages N]

`seed` pulls leaderboards (and optional per-market holders) into the
wallet_candidates queue and promotes by materiality. `run` backfills the
Data API trade history for promoted wallets (or the explicit --wallet
list). Both connect via DATABASE_URL and the real httpx fetcher; unit
tests drive the components directly with fixtures.
"""

from __future__ import annotations

import typer

from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.http import HttpxFetcher
from nbe_theta.common.logging import configure_logging, get_logger
from nbe_theta.ingest.archive import FsArchive
from nbe_theta.ingest.backfill import WalletBackfillIngestor
from nbe_theta.ingest.candidates import CandidateSeeder
from nbe_theta.ingest.dataapi import DataApiClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import PostgresWalletStore

app = typer.Typer(add_completion=False, help="Polymarket wallet candidate + history ingestor.")


def _client(settings) -> DataApiClient:  # type: ignore[no-untyped-def]
    fetcher = HttpxFetcher(
        base_url=settings.data_api_base_url,
        timeout_s=settings.data_api_timeout_s,
        ca_bundle=settings.ca_bundle,
    )
    return DataApiClient(fetcher, page_limit=settings.data_api_page_limit)


@app.command()
def seed(
    market: list[str] = typer.Option(
        [], "--market", help="condition_id(s) to also seed top holders from."
    ),
) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("ingest.wallet_cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    limiter = RateLimiter(settings.data_api_min_interval_s)
    with connect(settings.database_url) as conn:
        store = PostgresWalletStore(conn)
        seeder = CandidateSeeder(_client(settings), store, limiter)
        result = seeder.run(condition_ids=list(market) or None)
    log.info("seed done", seeded=result.seeded, promoted=result.promoted)


@app.command()
def run(
    wallet: list[str] = typer.Option([], "--wallet", help="Explicit wallet(s) to backfill."),
    limit: int = typer.Option(50, help="Max promoted wallets to backfill when --wallet is empty."),
    max_pages: int = typer.Option(0, help="Bound each wallet to N pages (0 = full history)."),
) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("ingest.wallet_cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    limiter = RateLimiter(settings.data_api_min_interval_s)
    archive = FsArchive(settings.raw_archive_dir)
    with connect(settings.database_url) as conn:
        store = PostgresWalletStore(conn)
        wallets = list(wallet) or store.list_promotable(limit)
        ingestor = WalletBackfillIngestor(
            _client(settings),
            store,
            archive,
            limiter,
            page_limit=settings.data_api_page_limit,
            max_pages=max_pages,
        )
        results = ingestor.run(wallets)
    log.info(
        "backfill done",
        wallets=len(results),
        trades=sum(r.trades_written for r in results),
    )


if __name__ == "__main__":
    app()
