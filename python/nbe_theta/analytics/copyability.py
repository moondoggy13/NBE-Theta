"""Copyability: could we actually have mirrored this wallet?

The skill scorer answers *is this trader good* — measured at the price
**they** paid. This module answers a different and equally necessary
question: *could we have gotten in near that price, arriving late?*

They come apart constantly, and the gap is where a copy-trading system
loses money without any bug being visible:

* A wallet with a genuine edge in thin markets moves the price with its
  own entry. By the time we see the fill and send an order, the edge is
  in the price. The source made money; a copier would not have.
* A wallet that trades wide spreads has an edge measured against mid but
  pays — and would make us pay — the ask.
* A wallet whose entries are large relative to the book cannot be
  followed at size at all.

None of that is visible to `excess_edge`, because `excess_edge` is
computed at the source's own fill price. So copyability is measured
separately and applied as a **veto**, not as a weighted term averaged in
with skill (ADR-0002 §C): a very skilled, uncopyable wallet must be
rejected, not compensated for.

**The headline number is `copyable_fraction`** — the share of a source's
entries that a copier arriving `delay_seconds` later could have filled
inside the price cap. It answers the operator's actual question ("can we
follow this wallet?") as a number between 0 and 1, and it degrades
gracefully: a wallet with 0.8 is followable with slippage, one with 0.1
is not followable at all no matter how skilled.

Everything here reads price history through `QuoteLookup`, so every
lookup is clamped to `as_of` and a measurement taken at time T is
reproducible from the data that existed at T.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from nbe_theta.analytics.metrics import ScoredEpisode
from nbe_theta.ingest.quote_store import QuoteLookup

MODEL_VERSION = "copyability-1"

# What a realistic mirror costs in latency: detection poll + evaluation +
# order round-trip. Deliberately pessimistic — measuring copyability at a
# delay shorter than we can actually achieve produces a number that
# flatters every wallet and predicts fills we will not get.
DEFAULT_DELAY_SECONDS = 45

ZERO = Decimal("0")
ONE = Decimal("1")


def price_cap(source_price: Decimal) -> Decimal:
    """Maximum acceptable premium over the source's price.

    `min($0.02, max($0.005, 8% × min(p, 1-p)))` from the spec.

    The `min(p, 1-p)` term is the part that matters: it scales tolerance
    by how much room the price has to move. Paying 2c over on a 0.50
    market is a 4% worse entry; paying 2c over on a 0.03 longshot is 67%
    worse and destroys the trade. Tying the cap to distance-from-certainty
    stops a flat cent threshold from being far too permissive at the tails.
    """

    edge_room = min(source_price, ONE - source_price)
    scaled = Decimal("0.08") * edge_room
    return min(Decimal("0.02"), max(Decimal("0.005"), scaled))


@dataclass(frozen=True)
class EntryProbe:
    """One source entry, evaluated as if we had tried to follow it."""

    outcome_token_id: str
    condition_id: str
    entered_at: datetime
    source_price: Decimal
    direction: str
    # Price available to a copier `delay` after the source's entry.
    copier_price: Decimal | None
    cap: Decimal

    @property
    def measured(self) -> bool:
        return self.copier_price is not None

    @property
    def slippage(self) -> Decimal | None:
        """Signed cost to the copier, in probability units.

        Positive = worse for us. A BUY that has to pay more than the
        source, or a SELL that receives less, both come out positive.
        """

        if self.copier_price is None:
            return None
        move = self.copier_price - self.source_price
        return move if self.direction == "BUY" else -move

    @property
    def copyable(self) -> bool:
        """Would the price cap have admitted this fill?

        An unmeasured entry is NOT copyable-by-default. It is excluded
        from the denominator entirely (see `measure`), because counting
        it either way would be an invention.
        """

        s = self.slippage
        return s is not None and s <= self.cap


@dataclass(frozen=True)
class CopyabilityScore:
    wallet: str
    as_of: datetime
    model_version: str
    delay_seconds: int
    n_entries: int
    n_measured: int
    copyable_fraction: float | None
    adverse_drift: float | None
    median_slippage: float | None
    median_spread: float | None
    copyability: float | None
    rationale: dict[str, Any] = field(default_factory=dict)


def probe_entry(
    episode_token: str,
    condition_id: str,
    entered_at: datetime,
    source_price: Decimal,
    direction: str,
    quotes: QuoteLookup,
    *,
    delay: timedelta,
    as_of: datetime | None = None,
) -> EntryProbe:
    """Price a single mirrored entry at `entered_at + delay`."""

    copier_price = quotes.price_at(episode_token, entered_at + delay, as_of=as_of)
    return EntryProbe(
        outcome_token_id=episode_token,
        condition_id=condition_id,
        entered_at=entered_at,
        source_price=source_price,
        direction=direction,
        copier_price=copier_price,
        cap=price_cap(source_price),
    )


def probe_episodes(
    scored: list[ScoredEpisode],
    quotes: QuoteLookup,
    *,
    delay_seconds: int = DEFAULT_DELAY_SECONDS,
    as_of: datetime | None = None,
) -> list[EntryProbe]:
    delay = timedelta(seconds=delay_seconds)
    return [
        probe_entry(
            s.episode.outcome_token_id,
            s.episode.condition_id,
            s.episode.opened_at,
            s.entry_price,
            s.episode.direction,
            quotes,
            delay=delay,
            as_of=as_of,
        )
        for s in scored
    ]


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def compose(
    copyable_fraction: float | None,
    median_slippage: float | None,
    median_spread: float | None,
) -> float | None:
    """Fold the components into one [0,1] score.

    A **product**, not a weighted sum. Weighted sums let a wallet with
    catastrophic slippage average its way to a passing grade on the
    strength of a tight spread; a product means any single bad factor
    drags the whole score down, which is the correct semantics when the
    factors are all necessary conditions rather than substitutes.

    Returns None when the headline fraction is unmeasured — "we have no
    quote coverage for this wallet's markets" and "this wallet is
    uncopyable" are different findings, and only the second should
    disqualify anyone.
    """

    if copyable_fraction is None:
        return None

    score = copyable_fraction

    if median_slippage is not None:
        # 2c of median slippage halves the score; beyond that it decays
        # fast. Slippage BELOW zero (the price moved in our favour) is
        # not a bonus — we do not reward a wallet for the market
        # happening to drift our way, so it is floored at no penalty.
        penalty = max(0.0, median_slippage) / 0.02
        score *= 1.0 / (1.0 + penalty)

    if median_spread is not None:
        # Crossing a wide spread is a cost we pay on entry AND on exit.
        spread_penalty = max(0.0, median_spread) / 0.04
        score *= 1.0 / (1.0 + spread_penalty)

    return max(0.0, min(1.0, score))


def measure(
    wallet: str,
    scored: list[ScoredEpisode],
    quotes: QuoteLookup,
    as_of: datetime,
    *,
    delay_seconds: int = DEFAULT_DELAY_SECONDS,
    spreads: dict[str, Decimal] | None = None,
) -> CopyabilityScore:
    """Measure how followable one wallet's entries were.

    ``spreads`` maps outcome_token_id → representative spread. Optional:
    absent, the spread penalty is simply not applied rather than guessed.
    """

    probes = probe_episodes(scored, quotes, delay_seconds=delay_seconds, as_of=as_of)
    measured = [p for p in probes if p.measured]

    # The denominator is MEASURED entries, not all entries. An entry we
    # could not price is not evidence of anything; putting it in the
    # denominator would make thin quote coverage look identical to
    # genuine uncopyability, and those need opposite responses (collect
    # more data vs. drop the wallet).
    copyable_fraction = (
        (sum(1 for p in measured if p.copyable) / len(measured)) if measured else None
    )

    slippages = [float(p.slippage) for p in measured if p.slippage is not None]
    median_slippage = _median(slippages)
    adverse_drift = (sum(slippages) / len(slippages)) if slippages else None

    spread_values: list[float] = []
    if spreads:
        for p in measured:
            sp = spreads.get(p.outcome_token_id)
            if sp is not None:
                spread_values.append(float(sp))
    median_spread = _median(spread_values)

    composite = compose(copyable_fraction, median_slippage, median_spread)

    rationale: dict[str, Any] = {
        "delay_seconds": delay_seconds,
        "n_entries": len(probes),
        "n_measured": len(measured),
        "coverage": (len(measured) / len(probes)) if probes else None,
        "notes": [
            "copyable_fraction is over MEASURED entries only; unmeasured "
            "entries are excluded rather than assumed either way",
            "copyability is a veto on promotion, never averaged into skill",
        ],
    }
    if measured:
        rationale["cap_range"] = {
            "min": float(min(p.cap for p in measured)),
            "max": float(max(p.cap for p in measured)),
        }

    return CopyabilityScore(
        wallet=wallet,
        as_of=as_of,
        model_version=MODEL_VERSION,
        delay_seconds=delay_seconds,
        n_entries=len(probes),
        n_measured=len(measured),
        copyable_fraction=copyable_fraction,
        adverse_drift=adverse_drift,
        median_slippage=median_slippage,
        median_spread=median_spread,
        copyability=composite,
        rationale=rationale,
    )
