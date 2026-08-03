"""Registry ingestor replay tests against the in-memory store.

Covers the AGENTS.md ingest requirements: recorded-fixture replay,
pagination edges, dedupe, and cursor-restart with zero duplicate rows.
No live API, no database.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from nbe_theta.ingest.archive import InMemoryArchive
from nbe_theta.ingest.gamma import VENUE, GammaClient
from nbe_theta.ingest.registry import RegistryIngestor, rule_hash
from nbe_theta.ingest.store import InMemoryStore
from tests.conftest import RecordedFetcher


def _ingestor(
    store: InMemoryStore,
    pages: list[list[dict[str, Any]]],
    *,
    page_limit: int,
    fail_after: int | None = None,
    max_pages: int = 0,
) -> RegistryIngestor:
    fetcher = RecordedFetcher(pages, fail_after=fail_after)
    client = GammaClient(fetcher, page_limit=page_limit)
    return RegistryIngestor(
        client, store, InMemoryArchive(), page_limit=page_limit, max_pages=max_pages
    )


# The two fixture pages hold 5 events total (one malformed, one with an
# unusable market): valid events = 100,101,102,104; valid markets =
# 1001,1002,1010,1020 (1040 dropped: no conditionId).
VALID_MARKET_IDS = {"1001", "1002", "1010", "1020"}
VALID_EVENT_IDS = {"100", "101", "102", "104"}


def test_full_sweep_writes_expected_rows(page1: Any, page2: Any) -> None:
    store = InMemoryStore()
    _ingestor(store, [page1, page2], page_limit=100).run()

    assert {k[1] for k in store.markets} == VALID_MARKET_IDS
    assert {k[1] for k in store.events} == VALID_EVENT_IDS
    # outcomes present for each valid market (2 legs each)
    assert all(len(store.outcomes[(VENUE, mid)]) == 2 for mid in VALID_MARKET_IDS)
    # one rule version per market on first sight
    assert len(store.rule_versions) == len(VALID_MARKET_IDS)


def test_pagination_small_page_size_covers_all(page1: Any, page2: Any) -> None:
    # page_limit=2 forces multiple pages incl. a short final page.
    store = InMemoryStore()
    result = _ingestor(store, [page1, page2], page_limit=2).run()
    assert result.pages >= 3
    assert {k[1] for k in store.markets} == VALID_MARKET_IDS


def test_re_sweep_is_idempotent_no_duplicates(page1: Any, page2: Any) -> None:
    store = InMemoryStore()
    _ingestor(store, [page1, page2], page_limit=2).run()
    markets_after_first = dict(store.markets)
    rule_versions_after_first = len(store.rule_versions)

    # Cursor was reset to 0 on completion; a second run re-sweeps.
    _ingestor(store, [page1, page2], page_limit=2).run()

    assert store.markets == markets_after_first  # no new keys, no dupes
    # Unchanged rules → no new versions on the second sweep.
    assert len(store.rule_versions) == rule_versions_after_first


def test_cursor_restart_after_crash_has_zero_duplicates(page1: Any, page2: Any) -> None:
    store = InMemoryStore()
    # Crash after the first page commits (page_limit=2 → page 1 = 2 events).
    with pytest.raises(RuntimeError, match="simulated crash"):
        _ingestor(store, [page1, page2], page_limit=2, fail_after=1).run()

    # Cursor advanced past the committed page; some rows already present.
    partial_markets = set(store.markets)
    assert 0 < len(partial_markets) < len(VALID_MARKET_IDS)
    assert store.get_cursor("events") == '{"offset": 2}'

    # Restart from the persisted cursor: completes the sweep, no dupes.
    _ingestor(store, [page1, page2], page_limit=2).run()
    assert {k[1] for k in store.markets} == VALID_MARKET_IDS
    assert len(store.rule_versions) == len(VALID_MARKET_IDS)


def test_rule_change_creates_new_version(page1: Any) -> None:
    store = InMemoryStore()
    _ingestor(store, [page1], page_limit=100).run()
    baseline_versions = len(store.rule_versions)

    # Mutate one market's resolution source → rule hash changes.
    changed = copy.deepcopy(page1)
    changed[0]["markets"][0]["resolutionSource"] = "Reuters"
    _ingestor(store, [changed], page_limit=100).run()

    assert len(store.rule_versions) == baseline_versions + 1


def test_rule_hash_stable_for_same_inputs(page1: Any) -> None:
    from nbe_theta.ingest.gamma import parse_event

    ev = parse_event(page1[0])
    assert ev is not None
    m = ev.markets[0]
    assert rule_hash(m) == rule_hash(m)


def test_max_pages_bounds_a_run(page1: Any, page2: Any) -> None:
    store = InMemoryStore()
    result = _ingestor(store, [page1, page2], page_limit=2, max_pages=1).run()
    assert result.pages == 1
    # Bounded run does not complete the sweep → cursor advanced, not reset.
    assert store.get_cursor("events") == '{"offset": 2}'
    assert result.completed is False


def test_run_records_ingest_run_row(page1: Any) -> None:
    store = InMemoryStore()
    result = _ingestor(store, [page1], page_limit=100).run()
    assert store.runs[result.run_id]["status"] == "completed"
