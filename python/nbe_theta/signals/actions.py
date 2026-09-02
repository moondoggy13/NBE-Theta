"""Source actions: many fills, one decision.

A wallet scaling into a position over four minutes produces several
fills and made **one** decision. Copying each fill independently would
multiply our exposure by the number of fills — the same error the
episode model already fixes for scoring, applied here to live detection
where the consequence is real money rather than a wrong number.

Two things this module is careful about:

**Only tradable activity counts.** Deposits, withdrawals, splits,
merges, rewards, rebates, conversions and multi-leg combos all appear in
a wallet's history and none of them is a directional opinion. A reward
credit is not a buy. Anything we cannot map to a single tradable outcome
token is dropped rather than guessed at.

**Identity is deterministic.** The dedupe key is derived from the
grouped fills, so re-polling an overlapping window — which the collector
does on every catch-up — cannot produce a second action for the same
decision, and therefore cannot produce a second order.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

ZERO = Decimal("0")

# How far apart two fills can be and still be one decision. Deliberately
# short: this is live detection, not historical episode grouping, and a
# long window would delay acting on the first fill while we wait to see
# whether more arrive.
DEFAULT_GROUP_WINDOW = timedelta(minutes=3)

# Activity kinds that are NOT directional trades. Matched
# case-insensitively against whatever the venue calls the row.
NON_TRADE_KINDS: frozenset[str] = frozenset(
    {
        "deposit",
        "withdraw",
        "withdrawal",
        "split",
        "merge",
        "reward",
        "rewards",
        "rebate",
        "conversion",
        "convert",
        "redeem",
        "redemption",
        "claim",
        "transfer",
        "combo",
        "multi",
    }
)


@dataclass(frozen=True)
class Fill:
    """One venue trade, already normalised (see ingest.dataapi)."""

    wallet: str
    condition_id: str
    outcome_token_id: str
    side: str
    price: Decimal
    quantity: Decimal
    occurred_at: datetime
    tx_hash: str | None = None
    kind: str | None = None

    @property
    def notional(self) -> Decimal:
        return self.price * self.quantity


@dataclass
class SourceAction:
    wallet: str
    condition_id: str
    outcome_token_id: str
    side: str
    quantity: Decimal
    notional: Decimal
    vwap: Decimal
    first_fill_at: datetime
    last_fill_at: datetime
    n_fills: int
    detected_at: datetime
    position_before: Decimal | None = None
    position_after: Decimal | None = None
    fills: list[Fill] = field(default_factory=list)

    @property
    def detection_latency_s(self) -> float:
        """Seconds between the source's last fill and our seeing it.

        The number that decides whether a copy was ever realistic. Kept
        as a property rather than a stored field so it cannot drift from
        the two timestamps it is derived from.
        """

        return (self.detected_at - self.last_fill_at).total_seconds()

    @property
    def position_delta_ratio(self) -> Decimal | None:
        """How much of its own position the source moved.

        Materiality is relative: a $250 trade means something different
        to a $5k account than to a $5m one. For an exit this is also the
        ratio we mirror onto our own lots.
        """

        if self.position_before is None or self.position_before == ZERO:
            return None
        return self.quantity / abs(self.position_before)

    def dedupe_key(self) -> str:
        """Deterministic identity over the grouped fills.

        Includes every fill's tx hash where present. Two genuinely
        distinct decisions cannot collide (different fills), and one
        decision seen twice cannot diverge (same fills, same key) — which
        is what makes an overlapping re-poll safe.
        """

        basis = json.dumps(
            {
                "w": self.wallet,
                "c": self.condition_id,
                "o": self.outcome_token_id,
                "s": self.side,
                "f": sorted(
                    [
                        f"{f.tx_hash or ''}:{int(f.occurred_at.timestamp())}:"
                        f"{format(f.price, 'f')}:{format(f.quantity, 'f')}"
                        for f in self.fills
                    ]
                ),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def is_tradable(fill: Fill) -> bool:
    """Is this a directional trade we could mirror?

    Fails closed on an unrecognised kind ONLY when a kind is present and
    matches a known non-trade word. A row with no kind at all is treated
    as a trade, because that is what the trades endpoint returns and
    demanding a label we do not always get would drop everything.
    """

    if fill.quantity <= ZERO:
        return False
    if fill.price < ZERO or fill.price > Decimal("1"):
        return False
    if fill.side not in {"BUY", "SELL"}:
        return False
    if not fill.outcome_token_id or not fill.condition_id:
        return False
    if fill.kind:
        k = fill.kind.strip().lower()
        if k in NON_TRADE_KINDS:
            return False
    return True


def group_fills(
    fills: list[Fill],
    *,
    detected_at: datetime,
    window: timedelta = DEFAULT_GROUP_WINDOW,
    positions_before: dict[tuple[str, str], Decimal] | None = None,
) -> list[SourceAction]:
    """Fold fills into actions.

    Grouped by (wallet, token, side) and split whenever consecutive fills
    are more than `window` apart — a wallet that buys at noon and buys
    again at 4pm made two decisions, not one.

    ``positions_before`` maps (wallet, token) → the source's exposure
    before the earliest fill in the batch, used for materiality and exit
    ratios. Absent, those come out None and the materiality gate fails
    closed rather than assuming a denominator.
    """

    tradable = [f for f in fills if is_tradable(f)]
    if not tradable:
        return []

    buckets: dict[tuple[str, str, str], list[Fill]] = {}
    for f in tradable:
        buckets.setdefault((f.wallet, f.outcome_token_id, f.side), []).append(f)

    positions = positions_before or {}
    actions: list[SourceAction] = []

    for (wallet, token, side), group in buckets.items():
        ordered = sorted(group, key=lambda f: f.occurred_at)
        runs: list[list[Fill]] = []
        current: list[Fill] = []
        for f in ordered:
            if current and (f.occurred_at - current[-1].occurred_at) > window:
                runs.append(current)
                current = []
            current.append(f)
        if current:
            runs.append(current)

        # Position is threaded through the runs in time order: each
        # action's `position_before` is the previous action's
        # `position_after`, so a wallet scaling in over three separate
        # decisions has three correct denominators rather than three
        # copies of its starting exposure.
        running_position = positions.get((wallet, token))
        for run in runs:
            action = _build_action(
                wallet=wallet,
                token=token,
                side=side,
                run=run,
                detected_at=detected_at,
                position_before=running_position,
            )
            actions.append(action)
            running_position = action.position_after

    actions.sort(key=lambda a: a.last_fill_at)
    return actions


def _build_action(
    *,
    wallet: str,
    token: str,
    side: str,
    run: list[Fill],
    detected_at: datetime,
    position_before: Decimal | None,
) -> SourceAction:
    """One run of fills → one action.

    Module-level rather than a closure over the grouping loop: closing
    over loop variables is a latent bug even when it happens to work
    (ruff B023), and this is arithmetic that decides order size.
    """

    qty = sum((f.quantity for f in run), ZERO)
    notional = sum((f.notional for f in run), ZERO)
    vwap = (notional / qty) if qty > ZERO else ZERO
    signed = qty if side == "BUY" else -qty
    after = (position_before + signed) if position_before is not None else None
    return SourceAction(
        wallet=wallet,
        condition_id=run[0].condition_id,
        outcome_token_id=token,
        side=side,
        quantity=qty,
        notional=notional,
        vwap=vwap,
        first_fill_at=run[0].occurred_at,
        last_fill_at=run[-1].occurred_at,
        n_fills=len(run),
        detected_at=detected_at,
        position_before=position_before,
        position_after=after,
        fills=list(run),
    )
