"""``theta-market-data`` command.

  theta-market-data run              collector loop (stream → quotes)
  theta-market-data run --once       a single cycle, then exit
  theta-market-data snapshot <tok>   one REST book, printed
  theta-market-data backfill <tok>   fill quote history from /prices-history

`backfill` is the one to reach for first. The live collector only ever
records prices from the moment it starts, so on a cold database every
markout and every CLV is null no matter how long the stream has been up.
Backfilling the tokens a wallet actually traded is what makes those
columns computable for its *past* record — which is the only record the
alpha gate can score.
"""

from __future__ import annotations

import time

import typer

from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.http import HttpxFetcher
from nbe_theta.common.logging import configure_logging, get_logger
from nbe_theta.ingest.clob import SOURCE_HISTORY, ClobClient, Quote
from nbe_theta.ingest.collector import CollectorConfig, MarketDataCollector
from nbe_theta.ingest.marketstream import WebsocketMarketStream
from nbe_theta.ingest.quote_store import PostgresQuoteStore
from nbe_theta.ingest.tokens import resolve_watchlist_tokens

app = typer.Typer(add_completion=False, help="Polymarket CLOB market-data collector.")
log = get_logger(__name__)


def _fetcher(settings) -> HttpxFetcher:  # type: ignore[no-untyped-def]
    return HttpxFetcher(
        base_url=settings.clob_base_url,
        timeout_s=settings.clob_timeout_s,
        ca_bundle=settings.ca_bundle,
    )


def _collector_config(settings) -> CollectorConfig:  # type: ignore[no-untyped-def]
    return CollectorConfig(
        max_messages_per_cycle=settings.market_max_messages,
        min_quote_interval_s=settings.market_min_quote_interval_s,
        stale_after_s=settings.market_stale_after_s,
    )


@app.command()
def run(
    interval_s: float = typer.Option(0.0, help="Seconds between cycles (default: MARKET_CYCLE_S)."),
    once: bool = typer.Option(False, help="Run a single cycle and exit."),
    token: list[str] = typer.Option(
        [], "--token", help="Pin an outcome token id (repeatable). Adds to the watchlist set."
    ),
) -> None:
    """Stream CLOB market data for watchlisted markets into `market_quotes`."""

    settings = get_settings()
    configure_logging(settings.log_level)
    every = interval_s or settings.market_cycle_s

    fetcher = _fetcher(settings)
    stream = WebsocketMarketStream(settings.clob_ws_url)
    with connect(settings.database_url) as conn:
        store = PostgresQuoteStore(conn)
        collector = MarketDataCollector(
            clob=ClobClient(fetcher),
            stream=stream,
            store=store,
            config=_collector_config(settings),
        )
        while True:
            tokens = resolve_watchlist_tokens(conn, pinned=list(token))
            if len(tokens) > settings.market_max_tokens:
                # Log the truncation rather than silently covering less
                # than the caller asked for — a quietly short subscription
                # looks identical to a quiet market.
                log.warning(
                    "token_cap_exceeded",
                    requested=len(tokens),
                    cap=settings.market_max_tokens,
                    dropped=len(tokens) - settings.market_max_tokens,
                )
                tokens = tokens[: settings.market_max_tokens]

            result = collector.run_cycle(tokens)
            conn.commit()
            log.info(
                "market_cycle",
                tokens=result.tokens,
                messages=result.messages,
                quotes=result.quotes_written,
                resyncs=result.resyncs,
                stream_connected=result.stream_connected,
                stale=len(result.stale_tokens),
                errors=result.errors,
            )
            if once:
                return
            time.sleep(every)


@app.command()
def snapshot(token_id: str) -> None:
    """Fetch and print one token's top of book (no writes)."""

    settings = get_settings()
    configure_logging(settings.log_level)
    client = ClobClient(_fetcher(settings))
    book, _raw = client.book(token_id)
    if book is None:
        typer.echo("no book returned")
        raise typer.Exit(code=1)
    q = book.quote("rest_poll")
    typer.echo(
        f"{q.outcome_token_id}  bid={q.best_bid}  ask={q.best_ask}  "
        f"mid={q.mid}  spread={q.spread}  levels={len(book.bids)}/{len(book.asks)}"
    )


@app.command()
def backfill(
    token_id: str,
    interval: str = typer.Option("max", help="Venue interval: 1m | 1h | 1d | max."),
    fidelity: int = typer.Option(1, help="Bucket size in minutes."),
    condition_id: str = typer.Option(..., help="Market condition id the token belongs to."),
) -> None:
    """Backfill `market_quotes` for one token from `/prices-history`.

    Writes `mid` only. History buckets carry no bid/ask, and inventing a
    spread around a historical mid would put a fabricated executable
    price into the table that measures execution quality.
    """

    settings = get_settings()
    configure_logging(settings.log_level)
    client = ClobClient(_fetcher(settings))
    points, _raw = client.prices_history(token_id, interval=interval, fidelity=fidelity)
    if not points:
        typer.echo("no history returned")
        raise typer.Exit(code=1)

    quotes = [
        Quote(
            condition_id=condition_id,
            outcome_token_id=p.outcome_token_id,
            observed_at=p.observed_at,
            source=SOURCE_HISTORY,
            mid_price=p.price,
        )
        for p in points
    ]
    with connect(settings.database_url) as conn:
        written = PostgresQuoteStore(conn).record_quotes(quotes, stream_connected=False)
        conn.commit()
    typer.echo(f"backfilled {written} quote(s) for {token_id} ({len(points)} history points)")
