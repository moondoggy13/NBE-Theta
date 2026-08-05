"""Decision episodes: many fills → one trade decision.

A wallet that scales into a position with eight fills over an hour made
ONE forecast, not eight. Counting fills as independent observations is
the single easiest way to fabricate statistical significance, so every
downstream metric is computed per-episode, and effective sample size is
counted in event clusters (see analytics.statistics).

Boundaries. An episode ends when any of these occur:
  * exposure returns to zero (fully closed),
  * exposure reverses sign (a new, opposite decision),
  * an inactivity gap longer than `inactivity_gap` elapses,
  * the market resolves.

The gap is a PARAMETER of a named, versioned algorithm — not a constant
baked into the code. Different trader classes decide on different
timescales (a fast-information trader's 5-minute gap is a market
maker's noise), so several algorithms are meant to coexist and be
compared for stability. `episode_algorithm_version` is persisted on
every row so snapshots stay reproducible after the default changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

from nbe_theta.ledger.entries import ENTRY_BUY, LedgerEntry

ZERO = Decimal("0")


@dataclass(frozen=True)
class EpisodeAlgorithm:
    """A named episode-grouping policy."""

    version: str
    inactivity_gap: timedelta

    @staticmethod
    def default() -> EpisodeAlgorithm:
        # 6h is a deliberately loose default: it groups a day-trader's
        # scaling-in without merging genuinely separate decisions days
        # apart. Compare against the alternatives below before trusting
        # any tier assignment.
        return EpisodeAlgorithm(version="gap-6h-v1", inactivity_gap=timedelta(hours=6))

    @staticmethod
    def alternatives() -> list[EpisodeAlgorithm]:
        return [
            EpisodeAlgorithm(version="gap-30m-v1", inactivity_gap=timedelta(minutes=30)),
            EpisodeAlgorithm.default(),
            EpisodeAlgorithm(version="gap-24h-v1", inactivity_gap=timedelta(hours=24)),
        ]


@dataclass
class Episode:
    wallet: str
    condition_id: str
    outcome_token_id: str
    direction: str  # BUY | SELL — the direction of the OPENING exposure
    opened_at: datetime
    closed_at: datetime | None
    entry_vwap: Decimal | None
    exit_vwap: Decimal | None
    maximum_shares: Decimal
    maximum_cost: Decimal
    realized_pnl: Decimal
    resolution_pnl: Decimal | None
    status: str  # open | closed | resolved
    episode_algorithm_version: str
    event_cluster_id: str | None = None
    entries: list[LedgerEntry] = field(default_factory=list)

    @property
    def n_fills(self) -> int:
        return len(self.entries)


@dataclass
class _Accumulator:
    """Running state while folding entries into one episode."""

    wallet: str
    condition_id: str
    outcome_token_id: str
    algorithm: EpisodeAlgorithm
    direction: str
    opened_at: datetime
    entries: list[LedgerEntry] = field(default_factory=list)
    shares: Decimal = ZERO
    max_abs_shares: Decimal = ZERO
    max_cost: Decimal = ZERO
    # VWAP accumulators, tracked separately for the opening and closing
    # side so entry/exit prices are not blended.
    open_shares: Decimal = ZERO
    open_cash: Decimal = ZERO
    close_shares: Decimal = ZERO
    close_cash: Decimal = ZERO
    realized: Decimal = ZERO
    fees: Decimal = ZERO
    last_ts: datetime | None = None

    def add(self, e: LedgerEntry) -> None:
        self.entries.append(e)
        opening = (e.share_delta > ZERO) == (self.direction == "BUY")
        if opening:
            self.open_shares += abs(e.share_delta)
            self.open_cash += abs(e.cash_delta)
        else:
            self.close_shares += abs(e.share_delta)
            self.close_cash += abs(e.cash_delta)
        self.shares += e.share_delta
        self.realized += e.cash_delta
        self.fees += e.fee_delta
        if abs(self.shares) > self.max_abs_shares:
            self.max_abs_shares = abs(self.shares)
            # Cost at peak exposure — the capital actually at risk.
            self.max_cost = self.open_cash
        self.last_ts = e.occurred_at

    def is_flat(self) -> bool:
        return self.shares == ZERO

    def finish(self, status: str, resolution_pnl: Decimal | None) -> Episode:
        entry_vwap = (self.open_cash / self.open_shares) if self.open_shares > ZERO else None
        exit_vwap = (self.close_cash / self.close_shares) if self.close_shares > ZERO else None
        return Episode(
            wallet=self.wallet,
            condition_id=self.condition_id,
            outcome_token_id=self.outcome_token_id,
            direction=self.direction,
            opened_at=self.opened_at,
            closed_at=self.last_ts if status != "open" else None,
            entry_vwap=entry_vwap,
            exit_vwap=exit_vwap,
            maximum_shares=self.max_abs_shares,
            maximum_cost=self.max_cost,
            # realized_pnl is net cash flow minus fees; for a fully closed
            # episode that IS the P&L. For one still holding inventory it
            # is only the cash leg — resolution_pnl carries the rest.
            realized_pnl=self.realized - self.fees,
            resolution_pnl=resolution_pnl,
            status=status,
            episode_algorithm_version=self.algorithm.version,
            entries=list(self.entries),
        )


def build_episodes(
    entries: list[LedgerEntry],
    *,
    algorithm: EpisodeAlgorithm | None = None,
    resolution_price: Decimal | None = None,
    resolved: bool = False,
) -> list[Episode]:
    """Fold one wallet+outcome's ledger entries into episodes.

    ``entries`` must all share (wallet, condition_id, outcome_token_id);
    the caller groups. ``resolution_price`` (0 or 1 for a settled binary
    outcome) prices any inventory still held at the end.
    """

    algo = algorithm or EpisodeAlgorithm.default()
    if not entries:
        return []

    ordered = sorted(entries, key=lambda e: e.occurred_at)
    episodes: list[Episode] = []
    acc: _Accumulator | None = None

    for e in ordered:
        if acc is not None:
            gap_exceeded = (
                acc.last_ts is not None and (e.occurred_at - acc.last_ts) > algo.inactivity_gap
            )
            # A flat book plus any new activity starts a fresh decision;
            # so does a long silence.
            if acc.is_flat() or gap_exceeded:
                episodes.append(_close(acc, resolution_price, resolved))
                acc = None
            else:
                # Reversal: this entry would flip the sign of exposure.
                would_be = acc.shares + e.share_delta
                if (
                    acc.shares != ZERO
                    and would_be != ZERO
                    and (would_be > ZERO) != (acc.shares > ZERO)
                ):
                    episodes.append(_close(acc, resolution_price, resolved))
                    acc = None

        if acc is None:
            acc = _Accumulator(
                wallet=e.wallet,
                condition_id=e.condition_id,
                outcome_token_id=e.outcome_token_id,
                algorithm=algo,
                direction=ENTRY_BUY.upper() if e.share_delta > ZERO else "SELL",
                opened_at=e.occurred_at,
            )
        acc.add(e)

    if acc is not None:
        episodes.append(_close(acc, resolution_price, resolved))
    return episodes


def _close(acc: _Accumulator, resolution_price: Decimal | None, resolved: bool) -> Episode:
    """Finalize an accumulator, pricing leftover inventory at resolution."""

    if acc.is_flat():
        return acc.finish("closed", None)
    if resolved and resolution_price is not None:
        # Inventory still held into settlement: value it at the outcome
        # price. Long shares pay `price`; short shares owe it.
        resolution_pnl = acc.shares * resolution_price
        return acc.finish("resolved", resolution_pnl)
    return acc.finish("open", None)


def group_key(e: LedgerEntry) -> tuple[str, str, str]:
    return (e.wallet, e.condition_id, e.outcome_token_id)


def build_all(
    entries: list[LedgerEntry],
    *,
    algorithm: EpisodeAlgorithm | None = None,
    resolutions: dict[tuple[str, str], Decimal] | None = None,
) -> list[Episode]:
    """Build episodes across many wallets/outcomes.

    ``resolutions`` maps (condition_id, outcome_token_id) → settled price
    (0 or 1). Absent → the market is unresolved and open inventory stays
    ``open`` rather than being priced.
    """

    res = resolutions or {}
    buckets: dict[tuple[str, str, str], list[LedgerEntry]] = {}
    for e in entries:
        buckets.setdefault(group_key(e), []).append(e)

    out: list[Episode] = []
    for (_w, cid, tok), group in buckets.items():
        price = res.get((cid, tok))
        out.extend(
            build_episodes(
                group, algorithm=algorithm, resolution_price=price, resolved=price is not None
            )
        )
    return out
