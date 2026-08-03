"""``theta-live-monitor``: the always-on wallet-tracking loop.

Where `theta-wallet-backfill` is the one-shot deep sweep (candidates →
full history), this is the steady state that keeps the Smart Money
cockpit current. One tick does four things, in order, each isolated so a
venue hiccup in one never aborts the others:

1. **Watchlist sync** — for every ``watch``/``copy`` wallet, read the
   newest ``/trades`` pages until a whole page predates
   ``watermark - overlap``. Rows are upserted through the backfill's
   dedupe key, so the deliberate overlap costs nothing and guarantees no
   gap at the seam. Bounded pages: one hyperactive wallet cannot starve
   the tick.
2. **Positions refresh** — on a cadence, snapshot each wallet's current
   holdings (full-replace, so absence means "exited").
3. **Leaderboard sweep** — hourly, capture rankings and file unseen
   wallets into the existing candidate funnel.
4. **Heartbeat** — one ``process_heartbeats`` row so the dashboard can
   prove the loop is alive rather than merely deployed.

Cursors live in ``ingest_cursors`` under ``source='data-api'`` with keys
``trades:<wallet>`` (shared with the backfill — the monitor only ever
advances the watermark, never rewinds the backfill's offset) and
``positions:<wallet>`` / ``leaderboard`` for the cadence gates.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Literal, TypeVar

from nbe_theta_contracts import VenueTrade, WalletPositionSnapshot
from pydantic import ValidationError

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.archive import Archive
from nbe_theta.ingest.dataapi import DataApiClient, ParsedTrade
from nbe_theta.ingest.intel_store import IntelStore, LeaderboardRow
from nbe_theta.ingest.positions import PARSER_VERSION as POSITIONS_PARSER_VERSION
from nbe_theta.ingest.positions import ParsedPosition, PositionsClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import WalletStore

log = get_logger("ingest.monitor")

# dataapi.VENUE is a plain str; the contracts need the Literal so the
# producer side is checked as strictly as the wire schema.
VENUE: Literal["polymarket"] = "polymarket"

TRADES_PARSER_VERSION = "data-api-1"
STREAM_LEADERBOARD = "leaderboard"

NowFn = Callable[[], datetime]
_T = TypeVar("_T")


def _utcnow() -> datetime:
    return datetime.now(tz=UTC)


def trades_stream_key(wallet: str) -> str:
    return f"trades:{wallet}"


def positions_stream_key(wallet: str) -> str:
    return f"positions:{wallet}"


# ── cursor helpers ────────────────────────────────────────────────
# Cursors are JSON so they can grow fields without a migration. The
# backfill writes {"offset": N} / {"complete": true, ...}; the monitor
# only reads/writes the "watermark" field, leaving the rest intact.


def read_watermark(cursor: str | None) -> datetime | None:
    if not cursor:
        return None
    try:
        val = json.loads(cursor)
    except json.JSONDecodeError:
        return None
    if not isinstance(val, dict):
        return None
    raw = val.get("watermark")
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def merge_watermark(cursor: str | None, watermark: datetime) -> str:
    """Set/advance ``watermark`` while preserving every other key the
    backfill may have written (offset, complete, total)."""

    payload: dict[str, object] = {}
    if cursor:
        try:
            parsed = json.loads(cursor)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = {}
    payload["watermark"] = watermark.isoformat()
    return json.dumps(payload)


# ── contract validation ───────────────────────────────────────────


def validate_trade(t: ParsedTrade, raw_id: uuid.UUID) -> bool:
    try:
        VenueTrade(
            venue=VENUE,
            source_trade_id=t.source_trade_id,
            wallet=t.wallet,
            condition_id=t.condition_id,
            outcome_token_id=t.outcome_token_id,
            side=t.side,  # type: ignore[arg-type]
            price=t.price,
            quantity=t.quantity,
            notional=t.notional,
            occurred_at=t.occurred_at,
            tx_hash=t.tx_hash,
            maker_taker=t.maker_taker,  # type: ignore[arg-type]
            raw_object_id=raw_id,
        )
    except ValidationError as e:
        log.warning("trade failed contract validation", trade=t.source_trade_id, error=str(e))
        return False
    return True


def validate_position(p: ParsedPosition, captured_at: datetime) -> bool:
    try:
        WalletPositionSnapshot(
            venue=VENUE,
            wallet=p.wallet,
            condition_id=p.condition_id,
            outcome_token_id=p.outcome_token_id,
            outcome_name=p.outcome_name,
            outcome_index=p.outcome_index,
            size=p.size,
            avg_price=p.avg_price,
            cur_price=p.cur_price,
            initial_value=p.initial_value,
            current_value=p.current_value,
            cash_pnl=p.cash_pnl,
            percent_pnl=p.percent_pnl,
            realized_pnl=p.realized_pnl,
            total_bought=p.total_bought,
            redeemable=p.redeemable,
            neg_risk=p.neg_risk,
            title=p.title,
            slug=p.slug,
            event_slug=p.event_slug,
            end_date=p.end_date,
            captured_at=captured_at,
        )
    except ValidationError as e:
        log.warning(
            "position failed contract validation",
            wallet=p.wallet,
            token=p.outcome_token_id,
            error=str(e),
        )
        return False
    return True


# ── config + results ──────────────────────────────────────────────


@dataclass
class MonitorConfig:
    sync_overlap_s: float = 120.0
    sync_max_pages: int = 5
    positions_refresh_s: float = 300.0
    leaderboard_refresh_s: float = 3600.0
    leaderboard_windows: tuple[str, ...] = ("WEEK", "MONTH")
    leaderboard_limit: int = 50
    heartbeat_process: str = "theta-live-monitor"


@dataclass
class SyncResult:
    wallet: str
    pages: int
    trades_written: int


@dataclass
class TickResult:
    run_id: uuid.UUID
    wallets_synced: int
    sync_trades: int
    positions_refreshed: int
    leaderboard_swept: bool
    errors: list[str]


# ── components ────────────────────────────────────────────────────


class WalletSync:
    """Incremental newest-first pass for one wallet."""

    def __init__(
        self,
        client: DataApiClient,
        store: WalletStore,
        archive: Archive,
        limiter: RateLimiter,
        *,
        overlap_s: float = 120.0,
        max_pages: int = 5,
        now_fn: NowFn = _utcnow,
    ) -> None:
        self._client = client
        self._store = store
        self._archive = archive
        self._limiter = limiter
        self._overlap = timedelta(seconds=overlap_s)
        self._max_pages = max_pages
        self._now = now_fn

    def run(self, run_id: uuid.UUID, wallet: str) -> SyncResult:
        key = trades_stream_key(wallet)
        cursor = self._store.get_cursor(key)
        watermark = read_watermark(cursor)
        cutoff = (watermark - self._overlap) if watermark else None

        pages = 0
        written = 0
        newest = watermark
        for offset, parsed, raw_bytes, row_count in self._client.iter_trades(
            wallet, start_offset=0, max_pages=self._max_pages
        ):
            self._limiter.acquire()
            uri, sha = self._archive.persist(run_id, offset, raw_bytes)
            raw_id = self._store.record_raw_object(
                uri=uri,
                sha256=sha,
                parser_version=TRADES_PARSER_VERSION,
                row_count=row_count,
                captured_at=self._now(),
            )
            valid = [t for t in parsed if validate_trade(t, raw_id)]
            for t in valid:
                self._store.upsert_wallet(t.wallet, t.occurred_at, t.occurred_at)
                if self._store.upsert_trade(t, raw_id):
                    written += 1
                if newest is None or t.occurred_at > newest:
                    newest = t.occurred_at
            if newest is not None:
                self._store.set_cursor(key, merge_watermark(self._store.get_cursor(key), newest))
            self._store.commit()
            pages += 1
            # Whole page older than the cutoff → everything deeper is
            # already ingested.
            if cutoff is not None and valid and all(t.occurred_at < cutoff for t in valid):
                break

        return SyncResult(wallet=wallet, pages=pages, trades_written=written)


class PositionsRefresh:
    def __init__(
        self,
        client: PositionsClient,
        wallet_store: WalletStore,
        intel: IntelStore,
        archive: Archive,
        limiter: RateLimiter,
        *,
        now_fn: NowFn = _utcnow,
    ) -> None:
        self._client = client
        self._store = wallet_store
        self._intel = intel
        self._archive = archive
        self._limiter = limiter
        self._now = now_fn

    def run(self, run_id: uuid.UUID, wallet: str) -> int:
        key = positions_stream_key(wallet)
        now = self._now()
        collected: list[ParsedPosition] = []
        for offset, parsed, raw_bytes, row_count in self._client.iter_positions(wallet):
            self._limiter.acquire()
            uri, sha = self._archive.persist(run_id, offset, raw_bytes)
            self._store.record_raw_object(
                uri=uri,
                sha256=sha,
                parser_version=POSITIONS_PARSER_VERSION,
                row_count=row_count,
                captured_at=now,
            )
            collected.extend(p for p in parsed if validate_position(p, now))
        written = self._intel.replace_wallet_positions(wallet, collected, now)
        self._store.set_cursor(key, merge_watermark(None, now))
        self._store.commit()
        return written


class LeaderboardSweep:
    """Capture rankings; file unseen wallets into the candidate funnel."""

    def __init__(
        self,
        client: DataApiClient,
        wallet_store: WalletStore,
        intel: IntelStore,
        limiter: RateLimiter,
        cfg: MonitorConfig,
        *,
        now_fn: NowFn = _utcnow,
    ) -> None:
        self._client = client
        self._store = wallet_store
        self._intel = intel
        self._limiter = limiter
        self._cfg = cfg
        self._now = now_fn

    def run(self) -> int:
        now = self._now()
        total = 0
        for window in self._cfg.leaderboard_windows:
            for metric in ("pnl", "volume"):
                self._limiter.acquire()
                entries = self._client.leaderboard(window, metric, self._cfg.leaderboard_limit)
                rows = [
                    LeaderboardRow(rank=i + 1, wallet=e.wallet, amount=e.amount)
                    for i, e in enumerate(entries)
                ]
                self._intel.insert_leaderboard_rows(window, metric, rows, now)
                for r in rows:
                    self._store.upsert_wallet(r.wallet, None, now)
                    self._store.upsert_candidate(r.wallet, "leaderboard", float(r.amount), now)
                total += len(rows)
        self._store.set_cursor(STREAM_LEADERBOARD, merge_watermark(None, now))
        self._store.commit()
        return total


# ── the loop ──────────────────────────────────────────────────────


class LiveMonitor:
    def __init__(
        self,
        client: DataApiClient,
        positions_client: PositionsClient,
        wallet_store: WalletStore,
        intel: IntelStore,
        archive: Archive,
        limiter: RateLimiter,
        cfg: MonitorConfig,
        *,
        now_fn: NowFn = _utcnow,
    ) -> None:
        self._store = wallet_store
        self._intel = intel
        self._cfg = cfg
        self._now = now_fn
        self._sync = WalletSync(
            client,
            wallet_store,
            archive,
            limiter,
            overlap_s=cfg.sync_overlap_s,
            max_pages=cfg.sync_max_pages,
            now_fn=now_fn,
        )
        self._positions = PositionsRefresh(
            positions_client, wallet_store, intel, archive, limiter, now_fn=now_fn
        )
        self._leaderboard = LeaderboardSweep(
            client, wallet_store, intel, limiter, cfg, now_fn=now_fn
        )

    def tick(self) -> TickResult:
        run_id = self._store.start_run("live-monitor", None)
        errors: list[str] = []

        wallets = self._intel.watchlist(statuses=("watch", "copy"))
        synced = 0
        sync_trades = 0
        positions_refreshed = 0
        for entry in wallets:
            res = self._safe(
                partial(self._sync.run, run_id, entry.wallet), errors, f"sync:{entry.wallet}"
            )
            if res is not None:
                synced += 1
                sync_trades += res.trades_written
            if self._positions_due(entry.wallet):
                got = self._safe(
                    partial(self._positions.run, run_id, entry.wallet),
                    errors,
                    f"positions:{entry.wallet}",
                )
                if got is not None:
                    positions_refreshed += 1

        swept = False
        if self._leaderboard_due():
            swept = self._safe(self._leaderboard.run, errors, "leaderboard") is not None

        self._intel.heartbeat(
            self._cfg.heartbeat_process,
            {
                "at": self._now().isoformat(),
                "watchlist": len(wallets),
                "sync_trades": sync_trades,
                "positions_refreshed": positions_refreshed,
                "errors": len(errors),
            },
        )
        self._store.commit()
        self._store.finish_run(
            run_id,
            status="completed" if not errors else "failed",
            rows_read=0,
            rows_written=sync_trades,
            cursor_after=None,
            error="; ".join(errors[:10]) if errors else None,
        )
        return TickResult(
            run_id=run_id,
            wallets_synced=synced,
            sync_trades=sync_trades,
            positions_refreshed=positions_refreshed,
            leaderboard_swept=swept,
            errors=errors,
        )

    def _safe(self, fn: Callable[[], _T], errors: list[str], label: str) -> _T | None:
        """Run one phase; a failure rolls back its partial page, is
        recorded, and never kills the tick (other wallets still sync)."""

        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — isolation is the point
            self._store.rollback()
            errors.append(f"{label}: {exc}")
            log.warning("monitor phase failed", phase=label, error=str(exc))
            return None

    def _positions_due(self, wallet: str) -> bool:
        last = read_watermark(self._store.get_cursor(positions_stream_key(wallet)))
        if last is None:
            return True
        return (self._now() - last).total_seconds() >= self._cfg.positions_refresh_s

    def _leaderboard_due(self) -> bool:
        last = read_watermark(self._store.get_cursor(STREAM_LEADERBOARD))
        if last is None:
            return True
        return (self._now() - last).total_seconds() >= self._cfg.leaderboard_refresh_s
