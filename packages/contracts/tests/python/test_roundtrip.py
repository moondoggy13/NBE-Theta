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
    ("order_intent.invalid.price_not_a_number.json", OrderIntent, "limit_price"),
    ("order_intent.invalid.price_above_one.json", OrderIntent, "limit_price"),
    ("order_intent.invalid.negative_quantity.json", OrderIntent, "quantity"),
    ("order_intent.invalid.wrong_schema_version.json", OrderIntent, "schema_version"),
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


# ── Wire-pattern <-> Python-bound sync guarantees ──────────────────
#
# The bound-encoding regexes in common.py are the ONLY enforcement the
# TS consumer has (JSON Schema can't numerically compare strings), so
# these tests pin: (a) the boundary edges of the unit-price pattern,
# and (b) that everything the Python serializer emits re-matches its
# own schema pattern — i.e. producer output can never fail the consumer.

import re

from nbe_theta_contracts.common import (
    _NON_NEGATIVE_PATTERN,
    _POSITIVE_PATTERN,
    _UNIT_PRICE_PATTERN,
)


@pytest.mark.parametrize("price", ["1", "1.0", "1.000", "0.43", "0.000001", "0.999999"])
def test_unit_price_boundary_accepted(price: str) -> None:
    base = _load("order_intent.valid.json")
    intent = OrderIntent.model_validate({**base, "limit_price": price})
    assert re.fullmatch(_UNIT_PRICE_PATTERN, price)
    # Serialized form still matches the wire pattern.
    dumped = json.loads(intent.model_dump_json(by_alias=True))
    assert re.fullmatch(_UNIT_PRICE_PATTERN, dumped["limit_price"])


@pytest.mark.parametrize("price", ["0", "0.0", "1.5", "1.75", "-0.4", "1.000001", "01", "1."])
def test_unit_price_boundary_rejected(price: str) -> None:
    # The wire pattern must reject each of these, and — for those that
    # are numerically out of range — the Python model must agree.
    assert not re.fullmatch(_UNIT_PRICE_PATTERN, price)


def test_serialized_decimals_rematch_own_patterns() -> None:
    """Producer output always passes the consumer's regex, including the
    negative-zero normalization edge."""

    from decimal import Decimal

    from nbe_theta_contracts.common import _canonical_decimal

    assert _canonical_decimal(Decimal("-0.0")) == "0.0"
    assert _canonical_decimal(Decimal("10")) == "10"
    assert _canonical_decimal(Decimal("0.43")) == "0.43"

    base = _load("order_intent.valid.json")
    dumped = json.loads(OrderIntent.model_validate(base).model_dump_json(by_alias=True))
    assert re.fullmatch(_POSITIVE_PATTERN, dumped["quantity"])
    assert re.fullmatch(_UNIT_PRICE_PATTERN, dumped["limit_price"])
    assert re.fullmatch(_NON_NEGATIVE_PATTERN, "0")
    assert re.fullmatch(_NON_NEGATIVE_PATTERN, "0.0")
    assert not re.fullmatch(_NON_NEGATIVE_PATTERN, "-1")


def test_schema_version_mismatch_rejected_python() -> None:
    """The documented 'consumers reject on mismatch' is enforced, not
    aspirational: Pydantic rejects a foreign version string."""

    base = _load("order_intent.valid.json")
    with pytest.raises(ValidationError) as excinfo:
        OrderIntent.model_validate({**base, "schema_version": "9.9.9"})
    assert "schema_version" in str(excinfo.value)


def test_naive_datetime_rejected() -> None:
    """A naive timestamp would serialize with no offset, which the Ajv
    consumer rejects — so the Python producer must refuse it up front."""

    base = _load("order_intent.valid.json")
    with pytest.raises(ValidationError) as excinfo:
        OrderIntent.model_validate({**base, "expires_at": "2026-07-18T05:30:00"})
    assert "expires_at" in str(excinfo.value)


def test_utc_datetime_roundtrips_with_z_suffix() -> None:
    """Aware datetimes serialize as UTC ISO-8601 with Z — matching the
    fixture wire form byte-for-byte, and offsets are normalized to UTC."""

    base = _load("order_intent.valid.json")
    dumped = json.loads(OrderIntent.model_validate(base).model_dump_json(by_alias=True))
    assert dumped["expires_at"] == base["expires_at"] == "2026-07-18T05:30:00Z"

    # A +02:00 producer timestamp lands on the wire normalized to UTC/Z.
    offset_input = {**base, "expires_at": "2026-07-18T07:30:00+02:00"}
    dumped2 = json.loads(OrderIntent.model_validate(offset_input).model_dump_json(by_alias=True))
    assert dumped2["expires_at"] == "2026-07-18T05:30:00Z"
