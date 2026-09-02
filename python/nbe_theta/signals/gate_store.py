"""Collect the evidence the shadow gate judges, and persist the packet.

All the I/O lives here so that `gate.evaluate` stays pure and the
decision logic can be tested — including its awkward vacuous-pass cases
— without a database.

On the duplicate queries below: two of the four shapes a duplicate could
take are already impossible while their unique constraints stand
(`source_actions.dedupe_key`, and `signal_evaluations` unique on
(source_action_id, policy_version)). Those are not re-checked here. An
assertion that cannot fail is worse than no assertion, because it
advertises a protection that is not doing anything — the same reason
`shadow.simulate` documents the VWAP-versus-limit check it deliberately
omits. What is checked is what nothing else enforces:

* one source action producing more than one **accepted** evaluation.
  Reachable today: bump the policy version mid-run and a re-detected
  action is evaluated again under the new version, past the unique
  constraint, and can open a second lot for one decision.
* more than one strategy lot, or more than one fill, hung off a single
  evaluation. Neither table constrains this.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg

from nbe_theta.signals.gate import (
    DecisionPacket,
    DuplicateFinding,
    GateEvidence,
    GatePolicy,
    SettledLot,
    evaluate,
)

ZERO = Decimal("0")


def _num(value: Any) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


def collect(
    conn: psycopg.Connection,
    *,
    window_start: datetime,
    window_end: datetime,
    mode: str = "shadow",
) -> GateEvidence:
    """Read one window's worth of evidence out of Postgres."""

    ev = GateEvidence(window_start=window_start, window_end=window_end)
    bounds = (window_start, window_end)

    with conn.cursor() as cur:
        # ── Evaluations: qualified count + rejection histogram ─────────
        cur.execute(
            "select count(*) filter (where accepted) from signal_evaluations "
            " where evaluated_at >= %s and evaluated_at < %s",
            bounds,
        )
        row = cur.fetchone() or (0,)
        ev.qualified_signals = int(row[0] or 0)

        cur.execute(
            "select reject_reason, count(*) from signal_evaluations "
            " where evaluated_at >= %s and evaluated_at < %s "
            "   and accepted is false and reject_reason is not null "
            " group by reject_reason order by count(*) desc",
            bounds,
        )
        ev.reject_reasons = {str(r[0]): int(r[1]) for r in cur.fetchall()}

        cur.execute(
            "select policy_version from signal_evaluations "
            " where evaluated_at >= %s and evaluated_at < %s "
            " group by policy_version order by policy_version",
            bounds,
        )
        ev.policy_versions = [str(r[0]) for r in cur.fetchall()]

        # ── Fills among qualified signals ──────────────────────────────
        cur.execute(
            "select f.fill_reason, count(*), "
            "       count(*) filter (where f.filled) "
            "  from shadow_fills f "
            " where f.attempted_at >= %s and f.attempted_at < %s "
            " group by f.fill_reason",
            bounds,
        )
        filled = 0
        for reason, n, n_filled in cur.fetchall():
            ev.fill_reasons[str(reason)] = int(n)
            filled += int(n_filled or 0)
        ev.filled_orders = filled

        cur.execute(
            "select slippage_vs_source from shadow_fills "
            " where attempted_at >= %s and attempted_at < %s "
            "   and filled and slippage_vs_source is not null",
            bounds,
        )
        ev.slippages = [float(r[0]) for r in cur.fetchall()]

        # ── Detection freshness ────────────────────────────────────────
        # The venue's clock (last_fill_at) versus ours (detected_at).
        # Rows where the difference is negative are dropped rather than
        # clamped to zero: a negative latency means the two clocks
        # disagree, and averaging a clock-skew artefact into a freshness
        # measurement would quietly flatter the p95.
        cur.execute(
            "select extract(epoch from (detected_at - last_fill_at)) "
            "  from source_actions "
            " where detected_at >= %s and detected_at < %s",
            bounds,
        )
        ev.detection_latencies = [
            float(r[0]) for r in cur.fetchall() if r[0] is not None and r[0] >= 0
        ]

        # ── Lots: settled results, and what is still open ──────────────
        #
        # `event_key` comes from the market's event, so the bootstrap
        # resamples whole events. Lots in markets we no longer have a
        # registry row for fall back to their own id, which makes them
        # singleton blocks — the conservative direction, since it widens
        # the interval rather than narrowing it.
        cur.execute(
            "select l.id, l.realized_pnl, l.fees_paid, m.venue_event_id "
            "  from strategy_lots l "
            "  left join markets m on m.condition_id = l.condition_id "
            " where l.mode = %s and l.opened_at >= %s and l.opened_at < %s "
            "   and l.status in ('closed', 'settled')",
            (mode, window_start, window_end),
        )
        ev.settled_lots = [
            SettledLot(
                lot_id=str(r[0]),
                realized_pnl=_num(r[1]),
                fees_paid=_num(r[2]),
                event_key=str(r[3]) if r[3] is not None else None,
            )
            for r in cur.fetchall()
        ]

        cur.execute(
            "select count(*), "
            "       count(*) filter (where status = 'open'), "
            "       coalesce(sum(entry_price * quantity_open) "
            "                filter (where status = 'open'), 0) "
            "  from strategy_lots "
            " where mode = %s and opened_at >= %s and opened_at < %s",
            (mode, window_start, window_end),
        )
        lrow = cur.fetchone() or (0, 0, 0)
        ev.lots_opened = int(lrow[0] or 0)
        ev.lots_open = int(lrow[1] or 0)
        ev.open_cost_basis = _num(lrow[2])

        # ── Duplicates ─────────────────────────────────────────────────
        cur.execute(
            "select source_action_id, count(*) from signal_evaluations "
            " where evaluated_at >= %s and evaluated_at < %s "
            "   and accepted and source_action_id is not null "
            " group by source_action_id having count(*) > 1",
            bounds,
        )
        for action_id, n in cur.fetchall():
            ev.duplicates.append(
                DuplicateFinding("multiple_accepted_evaluations", str(action_id), int(n))
            )

        cur.execute(
            "select l.signal_evaluation_id, count(*) from strategy_lots l "
            " where l.mode = %s and l.opened_at >= %s and l.opened_at < %s "
            "   and l.signal_evaluation_id is not null "
            " group by l.signal_evaluation_id having count(*) > 1",
            (mode, window_start, window_end),
        )
        for eval_id, n in cur.fetchall():
            ev.duplicates.append(
                DuplicateFinding("multiple_lots_per_evaluation", str(eval_id), int(n))
            )

        cur.execute(
            "select signal_evaluation_id, count(*) from shadow_fills "
            " where attempted_at >= %s and attempted_at < %s "
            "   and filled and signal_evaluation_id is not null "
            " group by signal_evaluation_id having count(*) > 1",
            bounds,
        )
        for eval_id, n in cur.fetchall():
            ev.duplicates.append(
                DuplicateFinding("multiple_fills_per_evaluation", str(eval_id), int(n))
            )

        # ── Unresolved critical incidents ──────────────────────────────
        #
        # Deliberately NOT windowed. A reconciliation break opened before
        # the shadow period and never closed still means local state and
        # venue truth disagree *now*, and that blocks promotion today
        # regardless of when it started.
        cur.execute(
            "select id, detected_at, scope, description from reconciliation_breaks "
            " where resolved_at is null order by detected_at desc limit 50"
        )
        ev.unresolved_incidents = [
            {
                "id": str(r[0]),
                "detected_at": r[1].isoformat() if r[1] is not None else None,
                "scope": str(r[2]),
                "description": str(r[3]),
            }
            for r in cur.fetchall()
        ]

    return ev


def run_gate(
    conn: psycopg.Connection,
    *,
    window_days: int | None = None,
    now: datetime | None = None,
    policy: GatePolicy | None = None,
    mode: str = "shadow",
) -> DecisionPacket:
    """Collect evidence for the trailing window and judge it."""

    pol = policy or GatePolicy()
    end = now or datetime.now(UTC)
    start = end - timedelta(days=window_days or pol.min_window_days)
    evidence = collect(conn, window_start=start, window_end=end, mode=mode)
    return evaluate(evidence, pol)


def record(
    conn: psycopg.Connection,
    packet: DecisionPacket,
    *,
    note: str | None = None,
    created_by: str = "theta-signals",
) -> str:
    """Persist a packet. Insert-only — packets are never updated."""

    with conn.cursor() as cur:
        cur.execute(
            "insert into shadow_gate_runs (window_start, window_end, verdict, criteria, "
            "headline, policy_versions, note, created_by) "
            "values (%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s) returning id",
            (
                packet.window_start,
                packet.window_end,
                packet.verdict,
                json.dumps(packet.criteria_dict()),
                json.dumps(packet.headline),
                packet.policy_versions,
                note,
                created_by,
            ),
        )
        row = cur.fetchone()
    return str(row[0]) if row else ""


def latest_passing(conn: psycopg.Connection) -> dict[str, Any] | None:
    """The most recent passing packet, or None.

    This is what authorises promotion to live. Kept here so the Python
    worker and the console route ask the same question of the same
    table rather than each inventing its own notion of "the gate
    passed".
    """

    with conn.cursor() as cur:
        cur.execute(
            "select id, evaluated_at, window_start, window_end "
            "  from shadow_gate_runs where verdict = 'pass' "
            " order by evaluated_at desc limit 1"
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "evaluated_at": row[1].isoformat(),
        "window_start": row[2].isoformat(),
        "window_end": row[3].isoformat(),
    }
