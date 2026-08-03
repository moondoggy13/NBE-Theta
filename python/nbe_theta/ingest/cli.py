"""``theta-registry`` command.

  theta-registry run              one full sweep (or bounded by GAMMA_MAX_PAGES)
  theta-registry run --loop       re-sweep continuously (registry stays fresh)
  theta-registry run --max-pages N  bound this invocation to N pages

Connects to Postgres via DATABASE_URL and to Gamma via the real httpx
fetcher. Unit tests never invoke this — they drive RegistryIngestor with
injected fixtures/fakes.
"""

from __future__ import annotations

import time

import typer

from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.http import HttpxFetcher
from nbe_theta.common.logging import configure_logging, get_logger
from nbe_theta.ingest.archive import FsArchive
from nbe_theta.ingest.gamma import GammaClient
from nbe_theta.ingest.registry import RegistryIngestor
from nbe_theta.ingest.store import PostgresStore

app = typer.Typer(add_completion=False, help="Polymarket Gamma market-registry ingestor.")


@app.command()
def run(
    loop: bool = typer.Option(
        False, help="Re-sweep continuously instead of exiting after one sweep."
    ),
    interval_s: float = typer.Option(60.0, help="Seconds between sweeps in --loop mode."),
    max_pages: int = typer.Option(0, help="Bound this run to N pages (0 = unbounded / to end)."),
) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("ingest.cli")

    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    fetcher = HttpxFetcher(
        base_url=settings.gamma_base_url,
        timeout_s=settings.gamma_timeout_s,
        ca_bundle=settings.ca_bundle,
    )
    client = GammaClient(fetcher, page_limit=settings.gamma_page_limit)
    archive = FsArchive(settings.raw_archive_dir)
    bound = max_pages or settings.gamma_max_pages

    while True:
        with connect(settings.database_url) as conn:
            store = PostgresStore(conn)
            ingestor = RegistryIngestor(
                client, store, archive, page_limit=settings.gamma_page_limit, max_pages=bound
            )
            result = ingestor.run()
            log.info(
                "sweep done",
                markets=result.markets_written,
                events=result.events_written,
                rule_versions=result.rule_versions_written,
            )
        if not loop:
            break
        time.sleep(interval_s)


if __name__ == "__main__":
    app()
