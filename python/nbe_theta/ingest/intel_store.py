"""Wallet-intel persistence (migration 011).

Extends — never replaces — ``wallet_store.WalletStore``. That store owns
identity, candidates, trades and the run/cursor control plane; this one
owns the tables migration 011 adds:

  wallet_positions       per-wallet snapshot (full-replace per refresh)
  leaderboard_snapshots  append-only ranking captures
  wallet_watchlist       operator curation (watch / copy / mute + weight)
  process_heartbeats     liveness for the dashboard

Two stores rather than one fat interface because the backfill path
(trades only) has no reason to depend on positions or curation. The
monitor composes both against the SAME psycopg connection, so a tick's
writes commit atomically together.

``InMemoryIntelStore`` mirrors the Postgres key-collision semantics so
monitor tests need no live database (AGENTS.md ingest rule).
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

import psycopg

from nbe_theta.ingest.dataapi import CHAIN_ID
from nbe_theta.ingest.positions import ParsedPosition


@dataclass(frozen=True)
class WatchlistEntry:
    wallet: str
    status: str  # 'watch' | 'copy' | 'mute'
    weight: float


@dataclass(frozen=True)
class LeaderboardRow:
    rank: int
    wallet: str
    amount: Decimal


class IntelStore(ABC):
    @abstractmethod
    def replace_wallet_positions(
        self, wallet: str, positions: list[ParsedPosition], captured_at: datetime
    ) -> int:
        """Full-replace one wallet's snapshot. Returns rows written."""

    @abstractmethod
    def insert_leaderboard_rows(
        self, window: str, rank_type: str, rows: list[LeaderboardRow], captured_at: datetime
    ) -> None: ...

    @abstractmethod
    def watchlist(self, statuses: tuple[str, ...] = ("watch", "copy")) -> list[WatchlistEntry]: ...

    @abstractmethod
    def add_watchlist(self, wallet: str, *, status: str, note: str | None, added_by: str) -> bool:
        """Insert if absent; NEVER overwrites an existing row — operator
        curation always wins over automation. True iff inserted."""

    @abstractmethod
    def touch_wallet_identity(
        self,
        wallet: str,
        *,
        display_name: str | None = None,
        pseudonym: str | None = None,
        profile_image: str | None = None,
    ) -> None:
        """Fill the migration-011 display columns. Non-null values only —
        never wipes a known name with an absent one."""

    @abstractmethod
    def heartbeat(self, process: str, detail: dict[str, object]) -> None: ...


# ── in-memory (tests) ─────────────────────────────────────────────


@dataclass
class InMemoryIntelStore(IntelStore):
    positions: dict[str, list[ParsedPosition]] = field(default_factory=dict)
    positions_captured_at: dict[str, datetime] = field(default_factory=dict)
    leaderboard_rows: list[dict[str, object]] = field(default_factory=list)
    watchlist_rows: dict[str, WatchlistEntry] = field(default_factory=dict)
    identities: dict[str, dict[str, str | None]] = field(default_factory=dict)
    heartbeats: dict[str, dict[str, object]] = field(default_factory=dict)

    def replace_wallet_positions(
        self, wallet: str, positions: list[ParsedPosition], captured_at: datetime
    ) -> int:
        self.positions[wallet] = list(positions)
        self.positions_captured_at[wallet] = captured_at
        return len(positions)

    def insert_leaderboard_rows(
        self, window: str, rank_type: str, rows: list[LeaderboardRow], captured_at: datetime
    ) -> None:
        for r in rows:
            self.leaderboard_rows.append(
                {
                    "window_key": window,
                    "rank_type": rank_type,
                    "rank": r.rank,
                    "wallet": r.wallet,
                    "amount": r.amount,
                    "captured_at": captured_at,
                }
            )

    def watchlist(self, statuses: tuple[str, ...] = ("watch", "copy")) -> list[WatchlistEntry]:
        return [w for w in self.watchlist_rows.values() if w.status in statuses]

    def add_watchlist(self, wallet: str, *, status: str, note: str | None, added_by: str) -> bool:
        if wallet in self.watchlist_rows:
            return False
        self.watchlist_rows[wallet] = WatchlistEntry(wallet=wallet, status=status, weight=1.0)
        return True

    def touch_wallet_identity(
        self,
        wallet: str,
        *,
        display_name: str | None = None,
        pseudonym: str | None = None,
        profile_image: str | None = None,
    ) -> None:
        row = self.identities.setdefault(
            wallet, {"display_name": None, "pseudonym": None, "profile_image": None}
        )
        if display_name is not None:
            row["display_name"] = display_name
        if pseudonym is not None:
            row["pseudonym"] = pseudonym
        if profile_image is not None:
            row["profile_image"] = profile_image

    def heartbeat(self, process: str, detail: dict[str, object]) -> None:
        self.heartbeats[process] = detail


# ── postgres (production) ─────────────────────────────────────────


class PostgresIntelStore(IntelStore):
    """Shares the monitor's psycopg connection with ``PostgresWalletStore``
    so one tick's writes commit as a single transaction."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def replace_wallet_positions(
        self, wallet: str, positions: list[ParsedPosition], captured_at: datetime
    ) -> int:
        with self._cur() as cur:
            cur.execute("delete from wallet_positions where wallet=%s", (wallet,))
            for p in positions:
                cur.execute(
                    "insert into wallet_positions (wallet, condition_id, outcome_token_id, "
                    "outcome_name, outcome_index, size, avg_price, cur_price, initial_value, "
                    "current_value, cash_pnl, percent_pnl, realized_pnl, total_bought, "
                    "redeemable, neg_risk, title, slug, event_slug, end_date, captured_at) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "on conflict (wallet, outcome_token_id) do update set "
                    "condition_id=excluded.condition_id, outcome_name=excluded.outcome_name, "
                    "outcome_index=excluded.outcome_index, size=excluded.size, "
                    "avg_price=excluded.avg_price, cur_price=excluded.cur_price, "
                    "initial_value=excluded.initial_value, current_value=excluded.current_value, "
                    "cash_pnl=excluded.cash_pnl, percent_pnl=excluded.percent_pnl, "
                    "realized_pnl=excluded.realized_pnl, total_bought=excluded.total_bought, "
                    "redeemable=excluded.redeemable, neg_risk=excluded.neg_risk, "
                    "title=excluded.title, slug=excluded.slug, event_slug=excluded.event_slug, "
                    "end_date=excluded.end_date, captured_at=excluded.captured_at",
                    (
                        p.wallet,
                        p.condition_id,
                        p.outcome_token_id,
                        p.outcome_name,
                        p.outcome_index,
                        p.size,
                        p.avg_price,
                        p.cur_price,
                        p.initial_value,
                        p.current_value,
                        p.cash_pnl,
                        p.percent_pnl,
                        p.realized_pnl,
                        p.total_bought,
                        p.redeemable,
                        p.neg_risk,
                        p.title,
                        p.slug,
                        p.event_slug,
                        p.end_date,
                        captured_at,
                    ),
                )
        return len(positions)

    def insert_leaderboard_rows(
        self, window: str, rank_type: str, rows: list[LeaderboardRow], captured_at: datetime
    ) -> None:
        with self._cur() as cur:
            for r in rows:
                cur.execute(
                    "insert into leaderboard_snapshots (window_key, rank_type, rank, wallet, "
                    "amount, captured_at) values (%s,%s,%s,%s,%s,%s)",
                    (window, rank_type, r.rank, r.wallet, r.amount, captured_at),
                )

    def watchlist(self, statuses: tuple[str, ...] = ("watch", "copy")) -> list[WatchlistEntry]:
        with self._cur() as cur:
            cur.execute(
                "select wallet, status, weight from wallet_watchlist "
                "where status = any(%s) order by added_at",
                (list(statuses),),
            )
            return [
                WatchlistEntry(wallet=str(r[0]), status=str(r[1]), weight=float(r[2]))
                for r in cur.fetchall()
            ]

    def add_watchlist(self, wallet: str, *, status: str, note: str | None, added_by: str) -> bool:
        with self._cur() as cur:
            cur.execute(
                "insert into wallet_watchlist (wallet, status, note, added_by) "
                "values (%s,%s,%s,%s) on conflict (wallet) do nothing",
                (wallet, status, note, added_by),
            )
            return cur.rowcount > 0

    def touch_wallet_identity(
        self,
        wallet: str,
        *,
        display_name: str | None = None,
        pseudonym: str | None = None,
        profile_image: str | None = None,
    ) -> None:
        if display_name is None and pseudonym is None and profile_image is None:
            return
        with self._cur() as cur:
            cur.execute(
                "insert into wallets (chain_id, address, display_name, pseudonym, profile_image) "
                "values (%s,%s,%s,%s,%s) on conflict (chain_id, address) do update set "
                "display_name=coalesce(excluded.display_name, wallets.display_name), "
                "pseudonym=coalesce(excluded.pseudonym, wallets.pseudonym), "
                "profile_image=coalesce(excluded.profile_image, wallets.profile_image)",
                (CHAIN_ID, wallet, display_name, pseudonym, profile_image),
            )

    def heartbeat(self, process: str, detail: dict[str, object]) -> None:
        with self._cur() as cur:
            cur.execute(
                "insert into process_heartbeats (process, last_beat, detail) "
                "values (%s, now(), %s::jsonb) "
                "on conflict (process) do update set last_beat=now(), detail=excluded.detail",
                (process, json.dumps(detail)),
            )
