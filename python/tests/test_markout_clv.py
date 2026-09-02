"""Markouts and closing-line value: the two metrics PR 6 switches on.

Both were structurally inert before this PR — `clv` was hardcoded None
and `markout_*` was fed an empty dict. Turning them on means the bugs in
them become live for the first time, so these tests target the specific
ways each can silently produce a plausible wrong number:

* markout keyed by market instead of by episode (the collision),
* markout or CLV reading a price from after `as_of` (look-ahead),
* a missing price being treated as zero edge rather than as unmeasured.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from nbe_theta.analytics import metrics as M
from nbe_theta.analytics.metrics import MARKOUT_HORIZONS, ScoredEpisode
from nbe_theta.analytics.scorer import score_wallet
from nbe_theta.ingest.quote_store import InMemoryQuoteStore
from nbe_theta.ledger.episodes import Episode

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)
TOKEN = "tok-1"
COND = "0xcond"


def _episode(
    *,
    opened_at: datetime,
    direction: str = "BUY",
    token: str = TOKEN,
    condition_id: str = COND,
) -> Episode:
    return Episode(
        wallet="0xw",
        condition_id=condition_id,
        outcome_token_id=token,
        direction=direction,
        opened_at=opened_at,
        closed_at=opened_at + timedelta(minutes=1),
        entry_vwap=Decimal("0.40"),
        exit_vwap=None,
        maximum_shares=Decimal("100"),
        maximum_cost=Decimal("40"),
        realized_pnl=Decimal("0"),
        resolution_pnl=None,
        status="resolved",
        episode_algorithm_version="gap-6h-v1",
    )


def _scored(
    ep: Episode, *, entry: str = "0.40", payoff: str = "1", settled_at: datetime | None = None
) -> ScoredEpisode:
    return ScoredEpisode(
        episode=ep,
        realized_payoff=Decimal(payoff),
        entry_price=Decimal(entry),
        fee_rate=Decimal("0"),
        event_cluster_id="evt-1",
        settled_at=settled_at or (ep.opened_at + timedelta(days=30)),
    )


def _quotes(points: list[tuple[datetime, str]], token: str = TOKEN) -> InMemoryQuoteStore:
    q = InMemoryQuoteStore()
    for when, mid in points:
        q.add_point(token, when, Decimal(mid))
    return q


# ── the collision regression ──────────────────────────────────────────


def test_two_episodes_on_one_token_get_their_own_markouts() -> None:
    """The bug the old dict key could not avoid.

    One wallet, one token, two separate decisions six hours apart. The
    market moved UP after the first and DOWN after the second. Keyed by
    `condition:token:horizon`, both episodes read whichever forward price
    was written last, so at least one markout was measured from the wrong
    entry time — and the mean silently averaged a real number with a
    wrong one.
    """

    first = _episode(opened_at=T0)
    second = _episode(opened_at=T0 + timedelta(hours=6))
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(minutes=5), "0.50"),  # +0.10 after the first
            (T0 + timedelta(hours=6), "0.40"),
            (T0 + timedelta(hours=6, minutes=5), "0.30"),  # -0.10 after the second
        ]
    )

    only_first = M.markout([_scored(first)], quotes, MARKOUT_HORIZONS["5m"])
    only_second = M.markout([_scored(second)], quotes, MARKOUT_HORIZONS["5m"])
    assert only_first is not None and only_second is not None
    assert only_first > 0
    assert only_second < 0
    # Distinct entry times ⇒ distinct forward prices. Under the old key
    # these two were forced equal.
    assert only_first != only_second

    both = M.markout([_scored(first), _scored(second)], quotes, MARKOUT_HORIZONS["5m"])
    assert both is not None
    assert both == (only_first + only_second) / 2


def test_markout_is_signed_by_direction() -> None:
    """A short profits when the price falls."""

    ep = _episode(opened_at=T0, direction="SELL")
    quotes = _quotes([(T0, "0.40"), (T0 + timedelta(minutes=5), "0.30")])
    value = M.markout([_scored(ep)], quotes, MARKOUT_HORIZONS["5m"])
    assert value is not None
    assert value > 0


def test_markout_uses_the_nearest_preceding_price_not_a_later_one() -> None:
    """At entry+5m the answer is the last price at or before that instant.

    Reaching forward to the next available point would import a move that
    had not happened yet at the horizon.
    """

    ep = _episode(opened_at=T0)
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(minutes=4), "0.45"),
            (T0 + timedelta(minutes=9), "0.90"),  # after the horizon
        ]
    )
    value = M.markout([_scored(ep)], quotes, MARKOUT_HORIZONS["5m"])
    assert value is not None
    # 0.45 − 0.40, not 0.90 − 0.40.
    assert abs(value - 0.05) < 1e-9


def test_missing_forward_price_is_unmeasured_not_zero() -> None:
    covered = _episode(opened_at=T0)
    uncovered = _episode(opened_at=T0 + timedelta(days=5), token="tok-uncovered")
    quotes = _quotes([(T0, "0.40"), (T0 + timedelta(minutes=5), "0.60")])

    value = M.markout([_scored(covered), _scored(uncovered)], quotes, MARKOUT_HORIZONS["5m"])
    assert value is not None
    # Averaged over the ONE episode with coverage. Imputing 0 for the
    # other would halve a real edge and make thin coverage look like
    # mediocrity.
    assert abs(value - 0.20) < 1e-9

    assert M.markout([_scored(uncovered)], quotes, MARKOUT_HORIZONS["5m"]) is None


# ── no-look-ahead ─────────────────────────────────────────────────────


def test_markout_at_as_of_cannot_read_a_later_quote() -> None:
    """Scoring at T must not consult a price observed after T, even for
    an episode whose horizon has long since elapsed in wall time."""

    ep = _episode(opened_at=T0)
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(minutes=2), "0.42"),
            (T0 + timedelta(minutes=5), "0.95"),  # observed after as_of
        ]
    )
    as_of = T0 + timedelta(minutes=3)
    value = M.markout([_scored(ep)], quotes, MARKOUT_HORIZONS["5m"], as_of=as_of)
    assert value is not None
    assert abs(value - 0.02) < 1e-9  # 0.42, not 0.95


def test_clv_skips_markets_that_had_not_closed_yet() -> None:
    ep = _episode(opened_at=T0)
    closes = {COND: T0 + timedelta(days=10)}
    quotes = _quotes([(T0, "0.40"), (T0 + timedelta(days=10), "0.75")])

    # as_of before the close: there is no closing line yet, so no CLV.
    assert M.closing_line_value([_scored(ep)], quotes, closes, as_of=T0 + timedelta(days=1)) is None

    after = M.closing_line_value([_scored(ep)], quotes, closes, as_of=T0 + timedelta(days=11))
    assert after is not None
    assert abs(after - 0.35) < 1e-9


def test_clv_skips_markets_with_no_recorded_close() -> None:
    """No close time means no closing line. Substituting the last price
    we happen to hold would measure something else and call it CLV."""

    ep = _episode(opened_at=T0)
    quotes = _quotes([(T0, "0.40"), (T0 + timedelta(days=10), "0.75")])
    assert M.closing_line_value([_scored(ep)], quotes, {}, as_of=T0 + timedelta(days=30)) is None


# ── scorer wiring ─────────────────────────────────────────────────────


def test_scorer_leaves_clv_and_markouts_null_without_a_price_source() -> None:
    """No quote coverage must produce NULL, not 0.0. They are different
    claims: 'unmeasured' versus 'the market never moved toward it'."""

    ep = _episode(opened_at=T0)
    score = score_wallet("0xw", [_scored(ep)], T0 + timedelta(days=60), prior=(1.0, 1.0))
    assert score.clv is None
    assert score.markout_5m is None
    assert score.markout_1h is None
    assert score.markout_24h is None


def test_scorer_populates_clv_and_markouts_when_quotes_exist() -> None:
    ep = _episode(opened_at=T0)
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(minutes=5), "0.46"),
            (T0 + timedelta(hours=1), "0.52"),
            (T0 + timedelta(hours=24), "0.60"),
            (T0 + timedelta(days=10), "0.80"),
        ]
    )
    score = score_wallet(
        "0xw",
        [_scored(ep)],
        T0 + timedelta(days=60),
        prior=(1.0, 1.0),
        quotes=quotes,
        market_closes={COND: T0 + timedelta(days=10)},
    )
    assert score.markout_5m is not None and abs(score.markout_5m - 0.06) < 1e-9
    assert score.markout_1h is not None and abs(score.markout_1h - 0.12) < 1e-9
    assert score.markout_24h is not None and abs(score.markout_24h - 0.20) < 1e-9
    assert score.clv is not None and abs(score.clv - 0.40) < 1e-9


def test_scorer_clamps_every_price_lookup_to_as_of() -> None:
    """The whole point of threading as_of down: a walk-forward run at T
    must be reproducible from the data that existed at T."""

    ep = _episode(opened_at=T0)
    quotes = _quotes(
        [
            (T0, "0.40"),
            (T0 + timedelta(minutes=1), "0.41"),
            (T0 + timedelta(minutes=5), "0.99"),
        ]
    )
    early = score_wallet(
        "0xw",
        [_scored(ep, settled_at=T0 + timedelta(minutes=2))],
        T0 + timedelta(minutes=2),
        prior=(1.0, 1.0),
        quotes=quotes,
    )
    assert early.markout_5m is not None
    assert abs(early.markout_5m - 0.01) < 1e-9  # 0.41, never 0.99


def test_in_memory_lookup_returns_none_before_the_first_observation() -> None:
    quotes = _quotes([(T0, "0.40")])
    assert quotes.price_at(TOKEN, T0 - timedelta(seconds=1)) is None
    assert quotes.price_at(TOKEN, T0) == Decimal("0.40")
    assert quotes.price_at("unknown-token", T0) is None
