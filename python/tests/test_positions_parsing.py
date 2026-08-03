"""Data API /positions parser tests: defensive coercion, unit-interval
marks, and pagination. Pure functions + the Fetcher seam — no network."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from nbe_theta.ingest.positions import PositionsClient, parse_position, parse_positions_page
from tests.conftest import RecordedDataApiFetcher

W1 = "0xaaa1000000000000000000000000000000000001"


def test_parse_positions_page_drops_unusable_rows(position_rows: list[dict[str, Any]]) -> None:
    parsed = parse_positions_page(position_rows, wallet_hint=W1)
    # 4 raw rows: the last has no conditionId/asset → dropped.
    assert len(parsed) == 3
    assert [p.outcome_token_id for p in parsed] == ["11110001", "22220002", "33330003"]


def test_wallet_address_is_lowercased(position_rows: list[dict[str, Any]]) -> None:
    p = parse_position(position_rows[0])
    assert p is not None and p.wallet == W1  # fixture stores checksum case


def test_live_position_fields(position_rows: list[dict[str, Any]]) -> None:
    p = parse_position(position_rows[0])
    assert p is not None
    assert p.size == Decimal("3150.5")
    assert p.avg_price == Decimal("0.405")
    assert p.cur_price == Decimal("0.45")
    assert p.current_value == Decimal("1417.72")
    assert p.cash_pnl == Decimal("141.77")
    assert p.redeemable is False
    assert p.neg_risk is False
    assert p.outcome_name == "Yes"
    assert p.outcome_index == 0
    assert p.end_date is not None and p.end_date.tzinfo is not None


def test_resolved_losing_position_marks_at_exactly_zero(
    position_rows: list[dict[str, Any]],
) -> None:
    """The reason marks use a CLOSED [0,1] bound rather than (0,1]."""

    p = parse_position(position_rows[1])
    assert p is not None
    assert p.cur_price == Decimal("0")
    assert p.current_value == Decimal("0")
    assert p.cash_pnl == Decimal("-434.00")
    assert p.redeemable is True
    assert p.neg_risk is True


def test_out_of_range_mark_is_dropped_not_persisted(
    position_rows: list[dict[str, Any]],
) -> None:
    """A 1.4 avgPrice is impossible; keep the row, drop the bad field."""

    p = parse_position(position_rows[2])
    assert p is not None
    assert p.avg_price is None
    assert p.cur_price == Decimal("0.5")


def test_missing_identity_fields_drop_the_row() -> None:
    assert parse_position({"proxyWallet": W1, "size": "10"}) is None
    assert parse_position({"conditionId": "0xc", "asset": "1", "size": "10"}) is None
    # Negative size is nonsense for a share balance.
    assert (
        parse_position({"proxyWallet": W1, "conditionId": "0xc", "asset": "1", "size": "-5"})
        is None
    )


def test_client_paginates_and_stops_on_short_page(
    position_rows: list[dict[str, Any]],
) -> None:
    fetcher = RecordedDataApiFetcher(positions=position_rows)
    client = PositionsClient(fetcher, page_limit=2)
    pages = list(client.iter_positions(W1))
    # 4 raw rows at page size 2 → offsets 0, 2, then a short/empty page.
    assert [offset for offset, _, _, _ in pages] == [0, 2, 4]
    assert [count for _, _, _, count in pages] == [2, 2, 0]
    assert sum(len(parsed) for _, parsed, _, _ in pages) == 3


def test_client_respects_max_pages(position_rows: list[dict[str, Any]]) -> None:
    fetcher = RecordedDataApiFetcher(positions=position_rows)
    client = PositionsClient(fetcher, page_limit=2)
    pages = list(client.iter_positions(W1, max_pages=1))
    assert len(pages) == 1
