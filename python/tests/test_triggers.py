"""Anomaly triggers.

The behavioural assertions matter less than the boundary one: these
produce alerts, and every row says so. A future reader who finds
`wallet_anomaly_events` and wires it to an order router should hit a
test that says no.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.ingest.triggers import (
    KIND_LARGE_TRADE,
    KIND_RAPID_MOVE,
    RapidMoveDetector,
    TriggerConfig,
    detect_large_trade,
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
TOKEN = "tok-1"


def _trade(notional: str, at: datetime = T0):  # type: ignore[no-untyped-def]
    return detect_large_trade(
        wallet="0xw",
        condition_id="0xc",
        outcome_token_id=TOKEN,
        notional=Decimal(notional),
        price=Decimal("0.42"),
        occurred_at=at,
    )


def test_below_threshold_is_not_an_event() -> None:
    assert _trade("1000") is None
    assert _trade("24999.99") is None


def test_severity_ranks_the_attention_queue() -> None:
    small = _trade("25000")
    big = _trade("200000")
    huge = _trade("5000000")
    assert small is not None and big is not None and huge is not None
    assert small.severity == 0.0
    assert 0.0 < big.severity < 1.0
    # Saturates rather than growing without bound — an attention queue
    # only needs an ordering, not an unbounded scale.
    assert huge.severity == 1.0


def test_every_event_states_that_it_is_not_a_signal() -> None:
    ev = _trade("50000")
    assert ev is not None
    assert ev.kind == KIND_LARGE_TRADE
    assert "not a signal" in ev.evidence["interpretation"]


def test_rapid_move_measures_across_the_window_not_between_ticks() -> None:
    """Ten small steps that add up to a big move must fire.

    Comparing consecutive observations would miss this entirely — and
    working an order in small increments is exactly what a participant
    who does not want to move the price does.
    """

    det = RapidMoveDetector()
    fired = None
    for i in range(11):
        fired = det.observe(
            TOKEN, Decimal("0.40") + Decimal("0.011") * i, T0 + timedelta(seconds=i * 10)
        )
    assert fired is not None
    assert fired.kind == KIND_RAPID_MOVE
    assert Decimal(fired.evidence["delta"]) > Decimal("0.10")


def test_slow_drift_outside_the_window_does_not_fire() -> None:
    det = RapidMoveDetector(config=TriggerConfig(rapid_move_window=timedelta(minutes=5)))
    # Same total move, spread over hours.
    fired = None
    for i in range(11):
        fired = det.observe(TOKEN, Decimal("0.40") + Decimal("0.011") * i, T0 + timedelta(hours=i))
    assert fired is None


def test_price_move_is_not_attributed_to_a_wallet() -> None:
    """A book move has no author. Naming one would be the exact
    inference the project's core principle forbids."""

    det = RapidMoveDetector()
    det.observe(TOKEN, Decimal("0.40"), T0)
    ev = det.observe(TOKEN, Decimal("0.60"), T0 + timedelta(seconds=30))
    assert ev is not None
    assert ev.wallet == ""
    assert "not attributable" in ev.evidence["interpretation"]


def test_detectors_keep_separate_trails_per_token() -> None:
    det = RapidMoveDetector()
    det.observe("tok-a", Decimal("0.40"), T0)
    # A different token's move must not be measured against tok-a.
    assert det.observe("tok-b", Decimal("0.90"), T0 + timedelta(seconds=5)) is None
