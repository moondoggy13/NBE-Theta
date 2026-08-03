"""Registry persistence.

``Store`` is the DB seam the ingestor writes through. ``PostgresStore``
is production (psycopg + ON CONFLICT upserts). ``InMemoryStore`` backs
the replay/dedupe/cursor-restart unit tests with real key-collision
semantics, so those tests never need a live database (AGENTS.md ingest
rule) yet still prove "restart produces zero duplicate rows".
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

import psycopg

from nbe_theta.ingest.gamma import VENUE, ParsedEvent, ParsedMarket, ParsedOutcome


@dataclass
class RawObjectRef:
    id: uuid.UUID
    uri: str
    sha256: str


class Store(ABC):
    """Everything the registry ingestor persists."""

    @abstractmethod
    def start_run(self, cursor_before: str | None) -> uuid.UUID: ...

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
    def commit(self) -> None:
        """Persist all writes since the last commit. Called per page so a
        crash mid-sweep loses at most the in-flight page (rolled back),
        never a committed one."""

    @abstractmethod
    def rollback(self) -> None:
        """Discard the in-flight (uncommitted) page after a failure."""

    @abstractmethod
    def get_cursor(self, stream_key: str) -> str | None: ...

    @abstractmethod
    def set_cursor(self, stream_key: str, cursor: str) -> None: ...

    @abstractmethod
    def record_raw_object(
        self,
        *,
        uri: str,
        sha256: str,
        parser_version: str,
        row_count: int,
        captured_at: datetime,
    ) -> uuid.UUID: ...

    @abstractmethod
    def upsert_event(self, event: ParsedEvent, raw_object_id: uuid.UUID) -> None: ...

    @abstractmethod
    def upsert_market(self, market: ParsedMarket) -> None: ...

    @abstractmethod
    def replace_outcomes(self, venue_market_id: str, outcomes: list[ParsedOutcome]) -> None: ...

    @abstractmethod
    def current_rule_hash(self, venue_market_id: str) -> str | None: ...

    @abstractmethod
    def insert_rule_version(
        self,
        market: ParsedMarket,
        rule_hash: str,
        observed_at: datetime,
        raw_object_id: uuid.UUID,
    ) -> uuid.UUID: ...

    @abstractmethod
    def set_market_rule_pointer(self, venue_market_id: str, rule_version_id: uuid.UUID) -> None: ...


# ── in-memory (tests) ─────────────────────────────────────────────


@dataclass
class InMemoryStore(Store):
    """Dict-backed store with the same key-collision semantics as the
    Postgres upserts: writing the same primary key twice overwrites, it
    does not duplicate."""

    events: dict[tuple[str, str], dict[str, object]] = field(default_factory=dict)
    markets: dict[tuple[str, str], dict[str, object]] = field(default_factory=dict)
    outcomes: dict[tuple[str, str], list[ParsedOutcome]] = field(default_factory=dict)
    rule_versions: dict[uuid.UUID, dict[str, object]] = field(default_factory=dict)
    rule_pointer: dict[str, uuid.UUID] = field(default_factory=dict)
    cursors: dict[str, str] = field(default_factory=dict)
    raw_objects: list[dict[str, object]] = field(default_factory=list)
    runs: dict[uuid.UUID, dict[str, object]] = field(default_factory=dict)
    # deterministic uuids for assertions
    _uuid_seq: int = 0

    def _next_uuid(self) -> uuid.UUID:
        self._uuid_seq += 1
        return uuid.UUID(int=self._uuid_seq)

    def start_run(self, cursor_before: str | None) -> uuid.UUID:
        rid = self._next_uuid()
        self.runs[rid] = {"status": "running", "cursor_before": cursor_before}
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
        self.runs[run_id].update(
            status=status,
            rows_read=rows_read,
            rows_written=rows_written,
            cursor_after=cursor_after,
            error=error,
        )

    def commit(self) -> None:
        # In-memory mutations are immediate; the replay tests inject
        # crashes at page boundaries, so there is no partial-page state
        # to flush or discard.
        pass

    def rollback(self) -> None:
        pass

    def get_cursor(self, stream_key: str) -> str | None:
        return self.cursors.get(stream_key)

    def set_cursor(self, stream_key: str, cursor: str) -> None:
        self.cursors[stream_key] = cursor

    def record_raw_object(
        self,
        *,
        uri: str,
        sha256: str,
        parser_version: str,
        row_count: int,
        captured_at: datetime,
    ) -> uuid.UUID:
        rid = self._next_uuid()
        self.raw_objects.append({"id": rid, "uri": uri, "sha256": sha256, "row_count": row_count})
        return rid

    def upsert_event(self, event: ParsedEvent, raw_object_id: uuid.UUID) -> None:
        self.events[(VENUE, event.venue_event_id)] = {
            "title": event.title,
            "category": event.category,
            "status": event.status,
            "raw_object_id": raw_object_id,
        }

    def upsert_market(self, market: ParsedMarket) -> None:
        self.markets[(VENUE, market.venue_market_id)] = {
            "condition_id": market.condition_id,
            "question": market.question,
            "active": market.active,
            "closed": market.closed,
            "resolved": market.resolved,
        }

    def replace_outcomes(self, venue_market_id: str, outcomes: list[ParsedOutcome]) -> None:
        self.outcomes[(VENUE, venue_market_id)] = list(outcomes)

    def current_rule_hash(self, venue_market_id: str) -> str | None:
        rv_id = self.rule_pointer.get(venue_market_id)
        if rv_id is None:
            return None
        return str(self.rule_versions[rv_id]["rule_hash"])

    def insert_rule_version(
        self,
        market: ParsedMarket,
        rule_hash: str,
        observed_at: datetime,
        raw_object_id: uuid.UUID,
    ) -> uuid.UUID:
        rid = self._next_uuid()
        self.rule_versions[rid] = {
            "venue_market_id": market.venue_market_id,
            "rule_hash": rule_hash,
            "observed_at": observed_at,
        }
        return rid

    def set_market_rule_pointer(self, venue_market_id: str, rule_version_id: uuid.UUID) -> None:
        self.rule_pointer[venue_market_id] = rule_version_id


# ── postgres (production) ─────────────────────────────────────────


class PostgresStore(Store):
    """psycopg-backed store. Each public method is a single statement or
    a tight group; the ingestor wraps a whole page in one transaction so
    a page commits atomically (the property that makes the cursor
    restart-safe)."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def start_run(self, cursor_before: str | None) -> uuid.UUID:
        with self._cur() as cur:
            cur.execute(
                "insert into ingest_runs (source, job_type, status, cursor_before) "
                "values ('gamma', 'registry', 'running', %s) returning id",
                (cursor_before,),
            )
            row = cur.fetchone()
            assert row is not None
            # Commit immediately so the 'running' row is durable — a crash
            # mid-sweep leaves a visible record that finish_run flips to
            # 'failed'.
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
                "select cursor from ingest_cursors where source='gamma' and stream_key=%s",
                (stream_key,),
            )
            row = cur.fetchone()
            return None if row is None else str(row[0])

    def set_cursor(self, stream_key: str, cursor: str) -> None:
        with self._cur() as cur:
            cur.execute(
                "insert into ingest_cursors (source, stream_key, cursor, updated_at) "
                "values ('gamma', %s, %s, now()) "
                "on conflict (source, stream_key) do update set cursor=excluded.cursor, "
                "updated_at=now()",
                (stream_key, cursor),
            )

    def record_raw_object(
        self,
        *,
        uri: str,
        sha256: str,
        parser_version: str,
        row_count: int,
        captured_at: datetime,
    ) -> uuid.UUID:
        with self._cur() as cur:
            # sha256 is uniquely indexed: identical bytes reuse the row
            # (deterministic replay), so a re-fetched page doesn't bloat
            # the manifest.
            cur.execute(
                "insert into raw_objects (source, object_uri, sha256, parser_version, "
                "row_count, captured_at) values ('gamma', %s, %s, %s, %s, %s) "
                "on conflict (sha256) do update set object_uri=excluded.object_uri "
                "returning id",
                (uri, sha256, parser_version, row_count, captured_at),
            )
            row = cur.fetchone()
            assert row is not None
            return uuid.UUID(str(row[0]))

    def upsert_event(self, event: ParsedEvent, raw_object_id: uuid.UUID) -> None:
        with self._cur() as cur:
            cur.execute(
                "insert into events (venue, venue_event_id, title, category, opened_at, "
                "closes_at, status, raw_object_id) values (%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (venue, venue_event_id) do update set title=excluded.title, "
                "category=excluded.category, opened_at=excluded.opened_at, "
                "closes_at=excluded.closes_at, status=excluded.status, "
                "raw_object_id=excluded.raw_object_id",
                (
                    VENUE,
                    event.venue_event_id,
                    event.title,
                    event.category,
                    event.opened_at,
                    event.closes_at,
                    event.status,
                    str(raw_object_id),
                ),
            )

    def upsert_market(self, market: ParsedMarket) -> None:
        with self._cur() as cur:
            cur.execute(
                "insert into markets (venue, venue_market_id, venue_event_id, condition_id, "
                "question, neg_risk, active, closed, resolved, opened_at, closes_at, "
                "resolved_at, resolution_source) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (venue, venue_market_id) do update set "
                "venue_event_id=excluded.venue_event_id, condition_id=excluded.condition_id, "
                "question=excluded.question, neg_risk=excluded.neg_risk, "
                "active=excluded.active, closed=excluded.closed, resolved=excluded.resolved, "
                "opened_at=excluded.opened_at, closes_at=excluded.closes_at, "
                "resolved_at=excluded.resolved_at, resolution_source=excluded.resolution_source",
                (
                    VENUE,
                    market.venue_market_id,
                    market.venue_event_id,
                    market.condition_id,
                    market.question,
                    market.neg_risk,
                    market.active,
                    market.closed,
                    market.resolved,
                    market.opened_at,
                    market.closes_at,
                    market.resolved_at,
                    market.resolution_source,
                ),
            )

    def replace_outcomes(self, venue_market_id: str, outcomes: list[ParsedOutcome]) -> None:
        with self._cur() as cur:
            for o in outcomes:
                cur.execute(
                    "insert into outcomes (venue, venue_market_id, outcome_index, "
                    "outcome_name, outcome_token_id) values (%s,%s,%s,%s,%s) "
                    "on conflict (venue, venue_market_id, outcome_index) do update set "
                    "outcome_name=excluded.outcome_name, "
                    "outcome_token_id=excluded.outcome_token_id",
                    (VENUE, venue_market_id, o.outcome_index, o.outcome_name, o.outcome_token_id),
                )

    def current_rule_hash(self, venue_market_id: str) -> str | None:
        with self._cur() as cur:
            cur.execute(
                "select rv.rule_hash from markets m "
                "join market_rule_versions rv on rv.id = m.current_rule_version_id "
                "where m.venue=%s and m.venue_market_id=%s",
                (VENUE, venue_market_id),
            )
            row = cur.fetchone()
            return None if row is None else str(row[0])

    def insert_rule_version(
        self,
        market: ParsedMarket,
        rule_hash: str,
        observed_at: datetime,
        raw_object_id: uuid.UUID,
    ) -> uuid.UUID:
        with self._cur() as cur:
            cur.execute(
                "insert into market_rule_versions (venue, venue_market_id, observed_at, "
                "rule_hash, title, description, resolution_source, close_time, raw_object_id) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (venue, venue_market_id, rule_hash) do update set "
                "observed_at=market_rule_versions.observed_at returning id",
                (
                    VENUE,
                    market.venue_market_id,
                    observed_at,
                    rule_hash,
                    market.question,
                    market.description,
                    market.resolution_source,
                    market.closes_at,
                    str(raw_object_id),
                ),
            )
            row = cur.fetchone()
            assert row is not None
            return uuid.UUID(str(row[0]))

    def set_market_rule_pointer(self, venue_market_id: str, rule_version_id: uuid.UUID) -> None:
        with self._cur() as cur:
            cur.execute(
                "update markets set current_rule_version_id=%s "
                "where venue=%s and venue_market_id=%s",
                (str(rule_version_id), VENUE, venue_market_id),
            )
