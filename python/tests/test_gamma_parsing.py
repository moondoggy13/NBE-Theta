"""Parser unit tests: encoding edges + defensive drops."""

from __future__ import annotations

from typing import Any

from nbe_theta.ingest.gamma import (
    parse_event,
    parse_market,
    parse_outcomes,
    parse_page,
)


def _market(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "1",
        "question": "Q?",
        "conditionId": "0xc",
        "startDate": "2027-01-01T00:00:00Z",
        "endDate": "2027-02-01T00:00:00Z",
        "outcomes": '["Yes", "No"]',
        "clobTokenIds": '["t1", "t2"]',
        "active": True,
        "closed": False,
    }
    base.update(over)
    return base


def test_outcomes_decode_json_string_arrays() -> None:
    out = parse_outcomes(_market())
    assert [(o.outcome_index, o.outcome_name, o.outcome_token_id) for o in out] == [
        (0, "Yes", "t1"),
        (1, "No", "t2"),
    ]


def test_outcomes_accept_already_decoded_lists() -> None:
    out = parse_outcomes(_market(outcomes=["Yes", "No"], clobTokenIds=["a", "b"]))
    assert [o.outcome_token_id for o in out] == ["a", "b"]


def test_outcomes_mismatched_lengths_keep_clean_pairs_only() -> None:
    # 3 names but 2 token ids → only the 2 that pair up survive.
    out = parse_outcomes(_market(outcomes='["A","B","C"]', clobTokenIds='["t1","t2"]'))
    assert [o.outcome_name for o in out] == ["A", "B"]


def test_outcomes_missing_token_ids_yield_nothing() -> None:
    assert parse_outcomes(_market(clobTokenIds="")) == []


def test_market_without_condition_id_is_dropped() -> None:
    assert parse_market(_market(conditionId=None), "evt") is None


def test_market_resolved_from_uma_status() -> None:
    m = parse_market(_market(umaResolutionStatus="resolved", updatedAt="2027-03-01T00:00:00Z"), "e")
    assert m is not None
    assert m.resolved is True
    assert m.resolved_at is not None


def test_naive_and_z_suffixed_dates_normalize_to_utc() -> None:
    m = parse_market(_market(startDate="2027-01-01T00:00:00"), "e")
    assert m is not None
    assert m.opened_at.tzinfo is not None
    assert m.opened_at.isoformat() == "2027-01-01T00:00:00+00:00"


def test_event_status_and_category_from_tags() -> None:
    ev = parse_event(
        {
            "id": "9",
            "title": "T",
            "startDate": "2027-01-01T00:00:00Z",
            "closed": False,
            "tags": [{"label": "Politics"}],
            "markets": [],
        }
    )
    assert ev is not None
    assert ev.status == "active"
    assert ev.category == "Politics"


def test_event_missing_title_is_skipped_in_page() -> None:
    events = parse_page([{"id": "1", "startDate": "2027-01-01T00:00:00Z", "markets": []}])
    assert events == []
