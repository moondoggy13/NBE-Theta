"""Wallet-ingest persistence (source = 'data-api').

Separate from the registry ``Store`` because the registry store's
run/cursor helpers are hardcoded to ``source='gamma'``; the wallet
ingestor's runs and cursors live under ``source='data-api'``. The
generic run/cursor/raw/commit methods are re-declared here with that
source rather than shared, to keep PR 3's store untouched.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

import psycopg

from nbe_theta.ingest.dataapi import CHAIN_ID, VENUE, ParsedTrade

SOURCE = "data-api"


class WalletStore(ABC):
    @abstractmethod
    def commit(self) -> None: ...

    @abstractmethod
    def rollback(self) -> None: ...

    @abstractmethod
    def start_run(self, job_type: str, cursor_before: str | None) -> uuid.UUID: ...

    @abstractmethod
    def finish_run(
        self,
        run_id: uuid.UUID,
        *,
        status: str,
        rows_read: int,
        rows_written: int,
        cursor_after: str | None,
        error: str | None,
    ) -> None: ...

    @abstractmethod
    def get_cursor(self, stream_key: str) -> str | None: ...

    @abstractmethod
    def set_cursor(self, stream_key: str, cursor: str) -> None: ...

    @abstractmethod
    def record_raw_object(
        self, *, uri: str, sha256: str, parser_version: str, row_count: int, captured_at: datetime
    ) -> uuid.UUID: ...

    @abstractmethod
    def upsert_candidate(
        self, address: str, source: str, priority_score: float, first_seen: datetime
    ) -> None: ...

    @abstractmethod
    def list_promotable(self, limit: int) -> list[str]: ...

    @abstractmethod
    def promote_candidate(self, address: str, promoted_at: datetime) -> None: ...

    @abstractmethod
    def upsert_wallet(
        self, address: str, first_seen: datetime | None, last_seen: datetime | None
    ) -> None: ...

    @abstractmethod
    def upsert_trade(self, trade: ParsedTrade, raw_object_id: uuid.UUID) -> bool:
        """Insert a trade; return True if newly inserted, False if it was a
        duplicate (unique on venue+source_trade_id)."""


# ── in-memory ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class _CandidateRow:
    priority_score: float
    first_seen: datetime


@dataclass(frozen=True)
class _WalletRow:
    first_seen: datetime | None
    last_seen: datetime | None


@dataclass
class InMemoryWalletStore(WalletStore):
    candidates: dict[tuple[int, str, str], _CandidateRow] = field(default_factory=dict)
    promoted: dict[str, datetime] = field(default_factory=dict)
    wallets: dict[tuple[int, str], _WalletRow] = field(default_factory=dict)
    trades: dict[tuple[str, str], ParsedTrade] = field(default_factory=dict)
    cursors: dict[str, str] = field(default_factory=dict)
    runs: dict[uuid.UUID, dict[str, object]] = field(default_factory=dict)
    raw_objects: list[dict[str, object]] = field(default_factory=list)
    _seq: int = 0

    def _uuid(self) -> uuid.UUID:
        self._seq += 1
        return uuid.UUID(int=self._seq)

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def start_run(self, job_type: str, cursor_before: str | None) -> uuid.UUID:
        rid = self._uuid()
        self.runs[rid] = {"status": "running", "job_type": job_type}
        return rid

    def finish_run(
        self,
        run_id: uuid.UUID,
        *,
        status: str,
        rows_read: int,
        rows_written: int,
        cursor_after: str | None,
        error: str | None,
    ) -> None:
        self.runs[run_id].update(status=status, rows_written=rows_written, error=error)

    def get_cursor(self, stream_key: str) -> str | None:
        return self.cursors.get(stream_key)

    def set_cursor(self, stream_key: str, cursor: str) -> None:
        self.cursors[stream_key] = cursor

    def record_raw_object(
        self, *, uri: str, sha256: str, parser_version: str, row_count: int, captured_at: datetime
    ) -> uuid.UUID:
        rid = self._uuid()
        self.raw_objects.append({"id": rid, "uri": uri, "sha256": sha256})
        return rid

    def upsert_candidate(
        self, address: str, source: str, priority_score: float, first_seen: datetime
    ) -> None:
        key = (CHAIN_ID, address, source)
        existing = self.candidates.get(key)
        # Keep the highest priority seen for this (address, source).
        if existing is None or priority_score > existing.priority_score:
            self.candidates[key] = _CandidateRow(
                priority_score=priority_score, first_seen=first_seen
            )

    def list_promotable(self, limit: int) -> list[str]:
        best: dict[str, float] = {}
        for (_chain, addr, _src), row in self.candidates.items():
            if addr in self.promoted:
                continue
            best[addr] = max(best.get(addr, float("-inf")), row.priority_score)
        return [a for a, _ in sorted(best.items(), key=lambda kv: kv[1], reverse=True)][:limit]

    def promote_candidate(self, address: str, promoted_at: datetime) -> None:
        self.promoted[address] = promoted_at

    def upsert_wallet(
        self, address: str, first_seen: datetime | None, last_seen: datetime | None
    ) -> None:
        key = (CHAIN_ID, address)
        cur = self.wallets.get(key)
        fs = cur.first_seen if cur else None
        ls = cur.last_seen if cur else None
        # Widen the [first_seen, last_seen] window (mirrors the SQL
        # least()/greatest() upsert).
        if first_seen and (fs is None or first_seen < fs):
            fs = first_seen
        if last_seen and (ls is None or last_seen > ls):
            ls = last_seen
        self.wallets[key] = _WalletRow(first_seen=fs, last_seen=ls)

    def upsert_trade(self, trade: ParsedTrade, raw_object_id: uuid.UUID) -> bool:
        key = (VENUE, trade.source_trade_id)
        if key in self.trades:
            return False
        self.trades[key] = trade
        return True


# ── postgres ──────────────────────────────────────────────────────


class PostgresWalletStore(WalletStore):
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def start_run(self, job_type: str, cursor_before: str | None) -> uuid.UUID:
        with self._cur() as cur:
            cur.execute(
                "insert into ingest_runs (source, job_type, status, cursor_before) "
                "values (%s, %s, 'running', %s) returning id",
                (SOURCE, job_type, cursor_before),
            )
            row = cur.fetchone()
            assert row is not None
            self._conn.commit()
            return uuid.UUID(str(row[0]))

    def finish_run(
        self,
        run_id: uuid.UUID,
        *,
        status: str,
        rows_read: int,
        rows_written: int,
        cursor_after: str | None,
        error: str | None,
    ) -> None:
        with self._cur() as cur:
            cur.execute(
                "update ingest_runs set status=%s, completed_at=now(), rows_read=%s, "
                "rows_written=%s, cursor_after=%s, error=%s where id=%s",
                (status, rows_read, rows_written, cursor_after, error, str(run_id)),
            )
            self._conn.commit()

    def get_cursor(self, stream_key: str) -> str | None:
        with self._cur() as cur:
            cur.execute(
                "select cursor from ingest_cursors where source=%s and stream_key=%s",
                (SOURCE, stream_key),
            )
            row = cur.fetchone()
            return None if row is None else str(row[0])

    def set_cursor(self, stream_key: str, cursor: str) -> None:
        with self._cur() as cur:
            cur.execute(
                "insert into ingest_cursors (source, stream_key, cursor, updated_at) "
                "values (%s, %s, %s, now()) on conflict (source, stream_key) do update set "
                "cursor=excluded.cursor, updated_at=now()",
                (SOURCE, stream_key, cursor),
            )

    def record_raw_object(
        self, *, uri: str, sha256: str, parser_version: str, row_count: int, captured_at: datetime
    ) -> uuid.UUID:
        with self._cur() as cur:
            cur.execute(
                "insert into raw_objects (source, object_uri, sha256, parser_version, row_count, "
                "captured_at) values (%s, %s, %s, %s, %s, %s) "
                "on conflict (sha256) do update set object_uri=excluded.object_uri returning id",
                (SOURCE, uri, sha256, parser_version, row_count, captured_at),
            )
            row = cur.fetchone()
            assert row is not None
            return uuid.UUID(str(row[0]))

    def upsert_candidate(
        self, address: str, source: str, priority_score: float, first_seen: datetime
    ) -> None:
        with self._cur() as cur:
            # Keep the highest priority for a (chain, address, source).
            cur.execute(
                "insert into wallet_candidates (chain_id, address, source, priority_score, "
                "first_seen) values (%s, %s, %s, %s, %s) "
                "on conflict (chain_id, address, source) do update set "
                "priority_score=greatest("
                "  wallet_candidates.priority_score, excluded.priority_score)",
                (CHAIN_ID, address, source, priority_score, first_seen),
            )

    def list_promotable(self, limit: int) -> list[str]:
        with self._cur() as cur:
            cur.execute(
                "select address, max(priority_score) as p from wallet_candidates "
                "where chain_id=%s and promoted_at is null "
                "group by address order by p desc limit %s",
                (CHAIN_ID, limit),
            )
            return [str(r[0]) for r in cur.fetchall()]

    def promote_candidate(self, address: str, promoted_at: datetime) -> None:
        with self._cur() as cur:
            cur.execute(
                "update wallet_candidates set promoted_at=%s "
                "where chain_id=%s and address=%s and promoted_at is null",
                (promoted_at, CHAIN_ID, address),
            )

    def upsert_wallet(
        self, address: str, first_seen: datetime | None, last_seen: datetime | None
    ) -> None:
        with self._cur() as cur:
            # least/greatest keep the widest [first_seen, last_seen] window.
            cur.execute(
                "insert into wallets (chain_id, address, first_seen, last_seen) "
                "values (%s, %s, %s, %s) on conflict (chain_id, address) do update set "
                "first_seen=least(wallets.first_seen, excluded.first_seen), "
                "last_seen=greatest(wallets.last_seen, excluded.last_seen)",
                (CHAIN_ID, address, first_seen, last_seen),
            )

    def upsert_trade(self, trade: ParsedTrade, raw_object_id: uuid.UUID) -> bool:
        with self._cur() as cur:
            cur.execute(
                "insert into venue_trades (source_trade_id, venue, wallet, condition_id, "
                "outcome_token_id, side, price, quantity, notional, occurred_at, tx_hash, "
                "maker_taker, raw_object_id) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (venue, source_trade_id) do nothing",
                (
                    trade.source_trade_id,
                    VENUE,
                    trade.wallet,
                    trade.condition_id,
                    trade.outcome_token_id,
                    trade.side,
                    trade.price,
                    trade.quantity,
                    trade.notional,
                    trade.occurred_at,
                    trade.tx_hash,
                    trade.maker_taker,
                    str(raw_object_id),
                ),
            )
            return cur.rowcount == 1
