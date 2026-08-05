"""Small CLI parsing helpers."""

from __future__ import annotations

from datetime import UTC, datetime


def parse_utc(s: str) -> datetime:
    """Parse an ISO-8601 instant into an aware UTC datetime.

    Naive input is rejected rather than assumed-UTC: an as_of that is
    silently off by a timezone would shift the no-look-ahead boundary,
    which is exactly the kind of error walk-forward validation cannot
    detect after the fact.
    """

    raw = s.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        raise ValueError(
            f"as_of must include a timezone offset (got {s!r}); "
            "an ambiguous instant would shift the no-look-ahead cutoff"
        )
    return dt.astimezone(UTC)
