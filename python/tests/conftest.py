"""Test fixtures: a fixture-backed Gamma fetcher (no live API).

The fetcher replays recorded ``/events`` pages by offset, exactly as the
real API would paginate. Tests inject it so no unit test hits the venue
(AGENTS.md ingest rule).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = json.loads((FIXTURES / name).read_text())
    return data


class RecordedFetcher:
    """Serves recorded pages keyed by offset, honoring the ``limit`` the
    client asks for so pagination edges (short final page) are exercised.

    ``fail_after`` (in page count) raises to simulate a mid-run crash for
    the cursor-restart test.
    """

    def __init__(self, pages: list[list[dict[str, Any]]], fail_after: int | None = None) -> None:
        # Flatten recorded pages into one ordered corpus, then re-slice by
        # the client's requested limit/offset — this way the same corpus
        # works at any page size.
        self.corpus: list[dict[str, Any]] = [row for page in pages for row in page]
        self.fail_after = fail_after
        self.calls = 0

    def get_page(self, path: str, params: dict[str, Any]) -> tuple[Any, bytes]:
        assert path == "/events"
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise RuntimeError("simulated crash mid-sweep")
        limit = int(params["limit"])
        offset = int(params["offset"])
        window = self.corpus[offset : offset + limit]
        raw = json.dumps(window).encode("utf-8")
        return window, raw


@pytest.fixture
def page1() -> list[dict[str, Any]]:
    return load_fixture("gamma_events_page1.json")


@pytest.fixture
def page2() -> list[dict[str, Any]]:
    return load_fixture("gamma_events_page2.json")


class RecordedDataApiFetcher:
    """Routes recorded Data API responses by path.

    ``/trades`` is offset-paginated over a flattened corpus (so any page
    size works); ``/leaderboard`` and ``/holders`` return fixed pages.
    ``fail_after`` raises after N /trades calls to simulate a crash.
    """

    def __init__(
        self,
        trade_pages: list[list[dict[str, Any]]] | None = None,
        leaderboard: list[dict[str, Any]] | None = None,
        holders: list[dict[str, Any]] | None = None,
        positions: list[dict[str, Any]] | None = None,
        fail_after: int | None = None,
        fail_paths: set[str] | None = None,
    ) -> None:
        self.corpus: list[dict[str, Any]] = [r for p in (trade_pages or []) for r in p]
        self.leaderboard = leaderboard or []
        self.holders = holders or []
        self.positions = positions or []
        self.fail_after = fail_after
        # Paths that always raise — used to prove one failing phase
        # never aborts the monitor tick.
        self.fail_paths = fail_paths or set()
        self.trade_calls = 0
        self.calls: list[str] = []

    def get_page(self, path: str, params: dict[str, Any]) -> tuple[Any, bytes]:
        self.calls.append(path)
        if path in self.fail_paths:
            raise RuntimeError(f"boom: venue 500 on {path}")
        if path == "/positions":
            limit = int(params["limit"])
            offset = int(params["offset"])
            window = self.positions[offset : offset + limit]
            return window, json.dumps(window).encode("utf-8")
        if path == "/trades":
            self.trade_calls += 1
            if self.fail_after is not None and self.trade_calls > self.fail_after:
                raise RuntimeError("simulated crash mid-backfill")
            limit = int(params["limit"])
            offset = int(params["offset"])
            window = self.corpus[offset : offset + limit]
            return window, json.dumps(window).encode("utf-8")
        if path == "/leaderboard":
            return self.leaderboard, json.dumps(self.leaderboard).encode("utf-8")
        if path == "/holders":
            return self.holders, json.dumps(self.holders).encode("utf-8")
        raise AssertionError(f"unexpected path {path}")


@pytest.fixture
def trades_pages() -> list[list[dict[str, Any]]]:
    return [
        load_fixture("dataapi_trades_page1.json"),
        load_fixture("dataapi_trades_page2.json"),
    ]


@pytest.fixture
def leaderboard_rows() -> list[dict[str, Any]]:
    return load_fixture("dataapi_leaderboard.json")


@pytest.fixture
def holder_rows() -> list[dict[str, Any]]:
    return load_fixture("dataapi_holders.json")


@pytest.fixture
def position_rows() -> list[dict[str, Any]]:
    return load_fixture("dataapi_positions.json")


def load_json(name: str) -> Any:
    """Load a fixture of any JSON shape (the list-typed `load_fixture`
    above predates the CLOB fixtures, which are objects)."""

    return json.loads((FIXTURES / name).read_text())


class RecordedClobFetcher:
    """Serves recorded CLOB REST responses by path.

    ``books`` maps token id → a ``/book`` payload. A token absent from
    the map raises, which is how the resync tests exercise "one token's
    repair fails and must not abort the others".
    """

    def __init__(
        self,
        books: dict[str, Any] | None = None,
        history: Any = None,
        midpoint: Any = None,
        fail_tokens: set[str] | None = None,
    ) -> None:
        self.books = books or {}
        self.history = history
        self.midpoint = midpoint
        self.fail_tokens = fail_tokens or set()
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get_page(self, path: str, params: dict[str, Any]) -> tuple[Any, bytes]:
        self.calls.append((path, dict(params)))
        if path == "/book":
            token = str(params["token_id"])
            if token in self.fail_tokens:
                raise RuntimeError(f"boom: venue 500 on /book {token}")
            payload = self.books.get(token)
            if payload is None:
                raise AssertionError(f"no recorded book for {token}")
            return payload, json.dumps(payload).encode("utf-8")
        if path == "/prices-history":
            return self.history, json.dumps(self.history).encode("utf-8")
        if path == "/midpoint":
            return self.midpoint, json.dumps(self.midpoint).encode("utf-8")
        raise AssertionError(f"unexpected path {path}")


@pytest.fixture
def clob_book() -> Any:
    return load_json("clob_book_t1.json")


@pytest.fixture
def clob_history() -> Any:
    return load_json("clob_prices_history.json")


@pytest.fixture
def market_stream_path() -> Path:
    return FIXTURES / "clob_market_stream.jsonl"
