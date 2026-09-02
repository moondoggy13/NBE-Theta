"""Persistence for the signal layer (migration 016).

Every evaluation is written, accepted or not. That is the point: the
rejection histogram is the evidence the shadow gate consumes, and a
store that only kept the accepted ones could not produce it.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal

import psycopg

from nbe_theta.signals.actions import SourceAction
from nbe_theta.signals.lots import StrategyLot
from nbe_theta.signals.pipeline import Evaluation

ZERO = Decimal("0")


class SignalStore(ABC):
    @abstractmethod
    def record_action(self, action: SourceAction) -> str | None:
        """Insert an action; return its id, or None if already present."""

    @abstractmethod
    def record_evaluation(self, ev: Evaluation, action_id: str | None) -> str | None: ...

    @abstractmethod
    def record_lot(self, lot: StrategyLot, evaluation_id: str | None) -> str: ...

    @abstractmethod
    def open_lots(self, *, mode: str) -> list[StrategyLot]: ...


@dataclass
class InMemorySignalStore(SignalStore):
    actions: dict[str, SourceAction] = field(default_factory=dict)
    evaluations: list[Evaluation] = field(default_factory=list)
    lots: dict[str, StrategyLot] = field(default_factory=dict)

    def record_action(self, action: SourceAction) -> str | None:
        key = action.dedupe_key()
        if key in self.actions:
            return None
        self.actions[key] = action
        return key

    def record_evaluation(self, ev: Evaluation, action_id: str | None) -> str | None:
        self.evaluations.append(ev)
        return str(len(self.evaluations))

    def record_lot(self, lot: StrategyLot, evaluation_id: str | None) -> str:
        self.lots[lot.id] = lot
        return lot.id

    def open_lots(self, *, mode: str) -> list[StrategyLot]:
        return [lot for lot in self.lots.values() if lot.mode == mode and lot.status == "open"]


class PostgresSignalStore(SignalStore):
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def record_action(self, action: SourceAction) -> str | None:
        """Insert, or return None when this decision is already known.

        `on conflict do nothing` plus the unique dedupe key is what makes
        an overlapping re-poll safe: the second sighting of one decision
        inserts nothing, so it cannot produce a second evaluation and
        therefore cannot produce a second order.
        """

        with self._cur() as cur:
            cur.execute(
                "insert into source_actions (wallet, condition_id, outcome_token_id, side, "
                "dedupe_key, n_fills, quantity, notional, vwap, position_before, "
                "position_after, first_fill_at, last_fill_at, detected_at) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (dedupe_key) do nothing returning id",
                (
                    action.wallet,
                    action.condition_id,
                    action.outcome_token_id,
                    action.side,
                    action.dedupe_key(),
                    action.n_fills,
                    action.quantity,
                    action.notional,
                    action.vwap,
                    action.position_before,
                    action.position_after,
                    action.first_fill_at,
                    action.last_fill_at,
                    action.detected_at,
                ),
            )
            row = cur.fetchone()
        return str(row[0]) if row else None

    def record_evaluation(self, ev: Evaluation, action_id: str | None) -> str | None:
        size = ev.size
        with self._cur() as cur:
            cur.execute(
                "insert into signal_evaluations (source_action_id, wallet, cluster_key, "
                "condition_id, outcome_token_id, side, policy_version, accepted, "
                "reject_reason, gates, intended_quantity, intended_notional, limit_price, "
                "size_factors, detection_latency_s) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb,%s) "
                "on conflict (source_action_id, policy_version) do nothing returning id",
                (
                    action_id,
                    ev.action.wallet,
                    ev.cluster_key,
                    ev.action.condition_id,
                    ev.action.outcome_token_id,
                    ev.action.side,
                    ev.policy_version,
                    ev.accepted,
                    ev.reject_reason,
                    json.dumps(ev.qualification.as_dict()),
                    size.quantity if size else None,
                    size.notional if size else None,
                    ev.qualification.limit_price,
                    json.dumps({"factors": size.factors, "caps": size.caps} if size else {}),
                    ev.action.detection_latency_s,
                ),
            )
            row = cur.fetchone()
            evaluation_id = str(row[0]) if row else None

            if ev.fill is not None and evaluation_id is not None:
                f = ev.fill
                cur.execute(
                    "insert into shadow_fills (signal_evaluation_id, condition_id, "
                    "outcome_token_id, side, filled, fill_reason, requested_quantity, "
                    "filled_quantity, limit_price, vwap, fees, slippage_vs_source, "
                    "book_snapshot) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                    (
                        evaluation_id,
                        ev.action.condition_id,
                        ev.action.outcome_token_id,
                        ev.action.side,
                        f.filled,
                        f.reason,
                        f.requested_quantity,
                        f.filled_quantity,
                        f.limit_price,
                        f.vwap,
                        f.fees,
                        f.slippage_vs_source,
                        json.dumps(f.book_snapshot),
                    ),
                )
        return evaluation_id

    def record_lot(self, lot: StrategyLot, evaluation_id: str | None) -> str:
        with self._cur() as cur:
            cur.execute(
                "insert into strategy_lots (id, mode, source_wallet, source_cluster_key, "
                "signal_evaluation_id, condition_id, outcome_token_id, side, opened_at, "
                "entry_price, quantity_opened, quantity_open, fees_paid, realized_pnl, "
                "status) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (id) do update set "
                "quantity_open=excluded.quantity_open, "
                "realized_pnl=excluded.realized_pnl, fees_paid=excluded.fees_paid, "
                "status=excluded.status",
                (
                    lot.id,
                    lot.mode,
                    lot.source_wallet,
                    lot.source_cluster_key,
                    evaluation_id,
                    lot.condition_id,
                    lot.outcome_token_id,
                    lot.side,
                    lot.opened_at,
                    lot.entry_price,
                    lot.quantity_opened,
                    lot.quantity_open,
                    lot.fees_paid,
                    lot.realized_pnl,
                    lot.status,
                ),
            )
        return lot.id

    def open_lots(self, *, mode: str) -> list[StrategyLot]:
        with self._cur() as cur:
            cur.execute(
                "select id, mode, source_wallet, source_cluster_key, condition_id, "
                "outcome_token_id, side, opened_at, entry_price, quantity_opened, "
                "quantity_open, fees_paid, realized_pnl, status "
                "from strategy_lots where mode=%s and status='open'",
                (mode,),
            )
            return [
                StrategyLot(
                    id=str(r[0]),
                    mode=r[1],
                    source_wallet=r[2],
                    source_cluster_key=r[3],
                    condition_id=r[4],
                    outcome_token_id=r[5],
                    side=r[6],
                    opened_at=r[7],
                    entry_price=Decimal(str(r[8])),
                    quantity_opened=Decimal(str(r[9])),
                    quantity_open=Decimal(str(r[10])),
                    fees_paid=Decimal(str(r[11])),
                    realized_pnl=Decimal(str(r[12])),
                    status=r[13],
                )
                for r in cur.fetchall()
            ]

    def shadow_summary(self) -> dict[str, object]:
        """Fill rate and rejection histogram — the shadow-gate headline."""

        with self._cur() as cur:
            cur.execute(
                "select count(*) filter (where accepted), count(*), "
                "count(*) filter (where accepted is false) from signal_evaluations"
            )
            row = cur.fetchone()
            accepted, total, rejected = row or (0, 0, 0)

            cur.execute(
                "select reject_reason, count(*) from signal_evaluations "
                "where accepted is false and reject_reason is not null "
                "group by reject_reason order by count(*) desc"
            )
            reasons = {r[0]: r[1] for r in cur.fetchall()}

            cur.execute(
                "select count(*) filter (where filled), count(*), avg(slippage_vs_source) "
                "from shadow_fills"
            )
            frow = cur.fetchone() or (0, 0, None)

        return {
            "evaluations": total,
            "accepted": accepted,
            "rejected": rejected,
            "reject_reasons": reasons,
            "orders_attempted": frow[1],
            "orders_filled": frow[0],
            "fill_rate": (frow[0] / frow[1]) if frow[1] else None,
            "mean_slippage_vs_source": float(frow[2]) if frow[2] is not None else None,
        }
