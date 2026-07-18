"""Cross-language fixture round-trip tests.

The same JSON fixture files under ``../../fixtures/`` are consumed here
(Python) and by ``../ts/roundtrip.test.ts`` (TypeScript). This test
asserts:

1. Every ``.valid.json`` fixture instantiates its Pydantic model, and
   the re-serialized output matches the input semantically (equal
   after JSON normalization).
2. Every ``.invalid.*.json`` fixture raises a ``ValidationError``
   pointing at the field the fixture name calls out.
3. ``SCHEMA_VERSION`` is present on every model instance.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from nbe_theta_contracts import (
    SCHEMA_VERSION,
    ExecutionIntentRow,
    Market,
    OrderIntent,
    SignalEnvelope,
)

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"

VALID_CASES: list[tuple[str, type[BaseModel]]] = [
    ("order_intent.valid.json", OrderIntent),
    ("signal_envelope.valid.json", SignalEnvelope),
    ("market.valid.json", Market),
    ("execution_intent_row.valid.json", ExecutionIntentRow),
]

INVALID_CASES: list[tuple[str, type[BaseModel], str]] = [
    # (filename, model, substring that must appear in the raised error)
    ("order_intent.invalid.missing_side.json", OrderIntent, "side"),
    ("order_intent.invalid.price_out_of_range.json", OrderIntent, "limit_price"),
    ("order_intent.invalid.extra_field.json", OrderIntent, "rogue_field"),
    (
        "signal_envelope.invalid.confidence_out_of_range.json",
        SignalEnvelope,
        "confidence",
    ),
]


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


def _normalize(x: Any) -> Any:
    """Compare after normalizing dict key order + list order-insensitive.

    We compare dicts / lists at the same nesting; primitive equality
    handles strings, ints, bools, and JSON nulls.
    """

    if isinstance(x, dict):
        return {k: _normalize(x[k]) for k in sorted(x.keys())}
    if isinstance(x, list):
        return [_normalize(y) for y in x]
    return x


@pytest.mark.parametrize(("name", "model"), VALID_CASES)
def test_valid_fixture_roundtrips(name: str, model: type[BaseModel]) -> None:
    """Fixture → model → JSON → model, with equality at each hop."""

    raw = _load(name)
    instance = model.model_validate(raw)

    # schema_version present and matches the package version.
    assert getattr(instance, "schema_version") == SCHEMA_VERSION

    # Round-trip: dumped JSON reloads to an equal model.
    dumped = json.loads(instance.model_dump_json(by_alias=True))
    reloaded = model.model_validate(dumped)
    assert instance == reloaded

    # And the on-wire output is semantically equal to the input.
    assert _normalize(dumped) == _normalize(raw)


@pytest.mark.parametrize(("name", "model", "expected"), INVALID_CASES)
def test_invalid_fixture_rejected(name: str, model: type[BaseModel], expected: str) -> None:
    """Fixture → model raises, and the error mentions the target field."""

    raw = _load(name)
    with pytest.raises(ValidationError) as excinfo:
        model.model_validate(raw)
    assert expected in str(excinfo.value)
