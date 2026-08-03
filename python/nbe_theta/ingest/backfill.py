"""Wallet history backfill.

Stage 3 of the funnel: for each promoted wallet, page the Data API
``/trades`` and normalize into ``venue_trades``, updating the wallet's
identity window (first_seen/last_seen) as trades stream in.

Restart-safety mirrors the registry ingestor: the per-wallet cursor
(``trades:<address>``) advances only after a page's rows + raw manifest
commit atomically, so a crash re-does the in-flight page and the
``unique(venue, source_trade_id)`` upsert dedupes it → zero duplicate
trades across kill/restart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.archive import Archive
from nbe_theta.ingest.dataapi import PARSER_VERSION, DataApiClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import WalletStore

log = get_logger("ingest.backfill")


@dataclass
class WalletBackfillResult:
    wallet: str
    pages: int
    trades_written: int
    completed: bool


def _now() -> datetime:
    return datetime.now(tz=UTC)


def _stream_key(wallet: str) -> str:
    return f"trades:{wallet}"


def _offset_cursor(offset: int) -> str:
    return json.dumps({"offset": offset})


def _cursor_offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        return max(0, int(json.loads(cursor).get("offset", 0)))
    except (json.JSONDecodeError, ValueError, TypeError):
        return 0


class WalletBackfillIngestor:
    def __init__(
        self,
        client: DataApiClient,
        store: WalletStore,
        archive: Archive,
        limiter: RateLimiter,
        *,
        page_limit: int,
        max_pages: int = 0,
    ) -> None:
        self._client = client
        self._store = store
        self._archive = archive
        self._limiter = limiter
        self._page_limit = page_limit
        self._max_pages = max_pages

    def backfill_wallet(self, wallet: str) -> WalletBackfillResult:
        stream = _stream_key(wallet)
        cursor_before = self._store.get_cursor(stream)
        start_offset = _cursor_offset(cursor_before)
        run_id = self._store.start_run("wallet-backfill", cursor_before)
        log.info("backfill start", wallet=wallet, start_offset=start_offset)

        pages = 0
        written = 0
        rows_read = 0
        last_offset = start_offset
        reached_end = True
        # Track the identity window across the whole wallet sweep.
        min_ts: datetime | None = None
        max_ts: datetime | None = None

        try:
            for offset, trades, raw_bytes, raw_count in self._client.iter_trades(
                wallet, start_offset=start_offset, max_pages=self._max_pages
            ):
                self._limiter.acquire()
                rows_read += raw_count
                reached_end = raw_count < self._page_limit
                uri, sha = self._archive.persist(run_id, offset, raw_bytes)
                raw_id = self._store.record_raw_object(
                    uri=uri,
                    sha256=sha,
                    parser_version=PARSER_VERSION,
                    row_count=raw_count,
                    captured_at=_now(),
                )
                for t in trades:
                    if self._store.upsert_trade(t, raw_id):
                        written += 1
                    min_ts = t.occurred_at if min_ts is None else min(min_ts, t.occurred_at)
                    max_ts = t.occurred_at if max_ts is None else max(max_ts, t.occurred_at)

                # Update identity window, advance cursor, commit the page.
                self._store.upsert_wallet(wallet, min_ts, max_ts)
                next_offset = offset + self._page_limit
                self._store.set_cursor(stream, _offset_cursor(next_offset))
                self._store.commit()
                last_offset = next_offset
                pages += 1

            if reached_end:
                # Whole history swept → reset so the next run re-checks for
                # new trades from the top (newest-first ordering).
                self._store.set_cursor(stream, _offset_cursor(0))
                self._store.commit()
                last_offset = 0

            self._store.finish_run(
                run_id,
                status="completed",
                rows_read=rows_read,
                rows_written=written,
                cursor_after=_offset_cursor(last_offset),
                error=None,
            )
            log.info("backfill complete", wallet=wallet, pages=pages, trades=written)
            return WalletBackfillResult(
                wallet=wallet, pages=pages, trades_written=written, completed=reached_end
            )
        except Exception as exc:  # noqa: BLE001
            self._store.rollback()
            self._store.finish_run(
                run_id,
                status="failed",
                rows_read=rows_read,
                rows_written=written,
                cursor_after=_offset_cursor(last_offset),
                error=str(exc),
            )
            log.error("backfill failed", wallet=wallet, error=str(exc))
            raise

    def run(self, wallets: list[str]) -> list[WalletBackfillResult]:
        return [self.backfill_wallet(w) for w in wallets]
