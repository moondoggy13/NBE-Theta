"""Registry ingestor: sweep Gamma → validate → upsert → version rules.

Flow per run:
  1. Read the resumable cursor (an offset). A fresh sweep starts at 0.
  2. For each page: archive raw bytes → manifest row; validate each
     event/market against the contracts package; upsert events, markets,
     outcomes; snapshot a new market_rule_versions row iff the rule hash
     changed; advance the cursor ONLY after the page's writes commit.
  3. On clean completion, reset the cursor to 0 so the next run re-sweeps
     (picking up new/closed/resolved state changes) — upserts make the
     re-sweep idempotent.

Restart-safety: because the cursor advances only after a committed page,
a crash mid-page leaves the cursor at the page start; the restart
re-fetches that page and the ON CONFLICT upserts dedupe it. Result:
zero duplicate rows across kill/restart (the PR 4 acceptance property,
proven here at the registry layer).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from nbe_theta_contracts import Event, Market, Outcome
from pydantic import ValidationError

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.archive import Archive
from nbe_theta.ingest.gamma import (
    PARSER_VERSION,
    VENUE,
    GammaClient,
    ParsedEvent,
    ParsedMarket,
)
from nbe_theta.ingest.store import Store

log = get_logger("ingest.registry")

STREAM_KEY = "events"


@dataclass
class RunResult:
    run_id: uuid.UUID
    pages: int
    events_written: int
    markets_written: int
    rule_versions_written: int
    completed: bool


def rule_hash(market: ParsedMarket) -> str:
    """Stable hash of the rule-bearing fields. A change in any of them
    (question, description, resolution source, close time) yields a new
    hash → a new rule-version snapshot."""

    payload = json.dumps(
        {
            "question": market.question,
            "description": market.description,
            "resolution_source": market.resolution_source,
            "close_time": market.closes_at.isoformat() if market.closes_at else None,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(tz=UTC)


class RegistryIngestor:
    def __init__(
        self,
        client: GammaClient,
        store: Store,
        archive: Archive,
        *,
        page_limit: int,
        max_pages: int = 0,
    ) -> None:
        self._client = client
        self._store = store
        self._archive = archive
        self._page_limit = page_limit
        self._max_pages = max_pages

    def run(self) -> RunResult:
        cursor_before = self._store.get_cursor(STREAM_KEY)
        start_offset = _cursor_to_offset(cursor_before)
        run_id = self._store.start_run(cursor_before)
        log.info("registry run start", run_id=str(run_id), start_offset=start_offset)

        pages = 0
        events_written = 0
        markets_written = 0
        rule_versions_written = 0
        rows_read = 0
        last_offset = start_offset
        completed = False
        # Reached end-of-data iff the last page was short. A run that
        # stops only because it hit max_pages has NOT finished the sweep,
        # so its cursor must persist (not reset to 0) for the next run.
        reached_end = True

        try:
            for offset, page in self._client.iter_events(
                start_offset=start_offset, max_pages=self._max_pages
            ):
                rows_read += page.row_count
                reached_end = page.row_count < self._page_limit
                uri, sha = self._archive.persist(run_id, offset, page.raw_bytes)
                raw_id = self._store.record_raw_object(
                    uri=uri,
                    sha256=sha,
                    parser_version=PARSER_VERSION,
                    row_count=page.row_count,
                    captured_at=_now(),
                )
                for ev in page.events:
                    if not self._write_event(ev, raw_id):
                        continue
                    events_written += 1
                    for m in ev.markets:
                        wrote, versioned = self._write_market(m, raw_id)
                        if wrote:
                            markets_written += 1
                        if versioned:
                            rule_versions_written += 1

                # Advance the cursor, then commit the whole page (rows +
                # raw manifest + cursor) atomically. A crash before this
                # commit rolls the page back; the persisted cursor still
                # points at this page's start, so the restart re-does it.
                next_offset = offset + self._page_limit
                self._store.set_cursor(STREAM_KEY, _offset_to_cursor(next_offset))
                self._store.commit()
                last_offset = next_offset
                pages += 1

            if reached_end:
                # Full sweep done → reset for the next re-sweep.
                self._store.set_cursor(STREAM_KEY, _offset_to_cursor(0))
                self._store.commit()
                last_offset = 0
                completed = True
            self._store.finish_run(
                run_id,
                status="completed",
                rows_read=rows_read,
                rows_written=markets_written,
                cursor_after=_offset_to_cursor(last_offset),
                error=None,
            )
            log.info(
                "registry run complete",
                run_id=str(run_id),
                pages=pages,
                markets=markets_written,
                rule_versions=rule_versions_written,
            )
        except Exception as exc:  # noqa: BLE001 — record then re-raise
            # Drop the partial (uncommitted) page, then record the
            # failure on a clean transaction. The cursor persisted by the
            # last successful commit is preserved.
            self._store.rollback()
            self._store.finish_run(
                run_id,
                status="failed",
                rows_read=rows_read,
                rows_written=markets_written,
                cursor_after=_offset_to_cursor(last_offset),
                error=str(exc),
            )
            log.error("registry run failed", run_id=str(run_id), error=str(exc))
            raise

        return RunResult(
            run_id=run_id,
            pages=pages,
            events_written=events_written,
            markets_written=markets_written,
            rule_versions_written=rule_versions_written,
            completed=completed,
        )

    def _write_event(self, ev: ParsedEvent, raw_id: uuid.UUID) -> bool:
        try:
            Event(
                venue=VENUE,
                venue_event_id=ev.venue_event_id,
                title=ev.title,
                category=ev.category,
                opened_at=ev.opened_at,
                closes_at=ev.closes_at,
                status=ev.status,  # type: ignore[arg-type]
                raw_object_id=raw_id,
            )
        except ValidationError as e:
            log.warning(
                "event failed contract validation", event_id=ev.venue_event_id, error=str(e)
            )
            return False
        self._store.upsert_event(ev, raw_id)
        return True

    def _write_market(self, m: ParsedMarket, raw_id: uuid.UUID) -> tuple[bool, bool]:
        try:
            Market(
                venue=VENUE,
                venue_market_id=m.venue_market_id,
                venue_event_id=m.venue_event_id,
                condition_id=m.condition_id,
                question=m.question,
                neg_risk=m.neg_risk,
                active=m.active,
                closed=m.closed,
                resolved=m.resolved,
                opened_at=m.opened_at,
                closes_at=m.closes_at,
                resolved_at=m.resolved_at,
                resolution_source=m.resolution_source,
            )
            for o in m.outcomes:
                Outcome(
                    venue=VENUE,
                    venue_market_id=m.venue_market_id,
                    outcome_index=o.outcome_index,
                    outcome_name=o.outcome_name,
                    outcome_token_id=o.outcome_token_id,
                )
        except ValidationError as e:
            log.warning(
                "market failed contract validation", market_id=m.venue_market_id, error=str(e)
            )
            return (False, False)

        self._store.upsert_market(m)
        self._store.replace_outcomes(m.venue_market_id, m.outcomes)

        # Rule versioning: snapshot iff the hash changed.
        h = rule_hash(m)
        versioned = False
        if self._store.current_rule_hash(m.venue_market_id) != h:
            rv_id = self._store.insert_rule_version(m, h, _now(), raw_id)
            self._store.set_market_rule_pointer(m.venue_market_id, rv_id)
            versioned = True
        return (True, versioned)


# ── cursor encoding ───────────────────────────────────────────────
# The cursor is JSON so it can carry more than an offset later without a
# migration. Today it is just {"offset": N}.


def _offset_to_cursor(offset: int) -> str:
    return json.dumps({"offset": offset})


def _cursor_to_offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        val = json.loads(cursor)
        off = int(val.get("offset", 0))
        return max(0, off)
    except (json.JSONDecodeError, ValueError, TypeError):
        return 0
