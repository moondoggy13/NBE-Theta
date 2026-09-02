"""``theta-signals`` command — the copy pipeline.

  theta-signals summary     shadow-gate headline: fill rate + reject histogram
  theta-signals gate        the 30-day / 100-signal decision packet
  theta-signals policy      print the active qualification and risk policy

The headline `summary` is the point of shadow mode. Two numbers decide
whether copy trading is viable at all:

  * **fill rate among qualified signals** — how often, having decided we
    want a trade, we actually get it at an acceptable price;
  * **the rejection histogram** — and when we don't, what stopped us.

If most rejections are `price_cap` or `freshness`, we are losing the
latency race and no amount of better wallet selection fixes it. If they
are `depth`, the sources trade markets too thin to mirror at our size.
Both are product answers, and both arrive as numbers here rather than as
a surprise later.
"""

from __future__ import annotations

import json

import typer

from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.logging import configure_logging
from nbe_theta.signals.gate import FAIL, INSUFFICIENT, PASS
from nbe_theta.signals.gate_store import record, run_gate
from nbe_theta.signals.gates import SignalPolicy
from nbe_theta.signals.sizing import RiskPolicy
from nbe_theta.signals.store import PostgresSignalStore

app = typer.Typer(add_completion=False, help="Polymarket copy-signal pipeline.")


@app.command()
def summary() -> None:
    """Shadow-gate headline: fill rate and why signals died."""

    settings = get_settings()
    configure_logging(settings.log_level)
    with connect(settings.database_url) as conn:
        stats = PostgresSignalStore(conn).shadow_summary()

    typer.echo(f"evaluations       {stats['evaluations']}")
    typer.echo(f"  accepted        {stats['accepted']}")
    typer.echo(f"  rejected        {stats['rejected']}")
    typer.echo(f"orders attempted  {stats['orders_attempted']}")
    typer.echo(f"orders filled     {stats['orders_filled']}")
    rate = stats["fill_rate"]
    typer.echo(f"fill rate         {f'{rate:.1%}' if rate is not None else 'n/a'}")
    slip = stats["mean_slippage_vs_source"]
    typer.echo(f"mean slippage     {f'{slip:+.4f}' if slip is not None else 'n/a'}")

    reasons = stats["reject_reasons"]
    if isinstance(reasons, dict) and reasons:
        typer.echo("")
        typer.echo("rejections by first failing gate:")
        for reason, n in reasons.items():
            typer.echo(f"  {reason:<26} {n}")


MARK = {PASS: "PASS", FAIL: "FAIL", INSUFFICIENT: "----"}


@app.command()
def gate(
    window_days: int = typer.Option(30, help="Trailing window to judge, in days."),
    record_run: bool = typer.Option(
        False, "--record", help="Persist the packet to shadow_gate_runs."
    ),
    note: str = typer.Option("", help="Operator note stored with a recorded packet."),
    as_json: bool = typer.Option(False, "--json", help="Emit the packet as JSON."),
) -> None:
    """The promotion decision packet (ADR-0002 step 6, ADR-0003).

    Every criterion prints its own outcome and the number that decided
    it. `----` is neither pass nor fail: it means the criterion could
    not be measured yet, and it blocks promotion exactly as a failure
    does. Only an all-PASS packet authorises live trading, and only a
    `--record`ed one can be seen by `/api/console/mode`.
    """

    settings = get_settings()
    configure_logging(settings.log_level)
    with connect(settings.database_url) as conn:
        packet = run_gate(conn, window_days=window_days)
        recorded = record(conn, packet, note=note or None) if record_run else None
        if record_run:
            conn.commit()

    if as_json:
        payload = packet.as_dict()
        if recorded:
            payload["recorded_id"] = recorded
        typer.echo(json.dumps(payload, indent=2, default=str))
        raise typer.Exit(0 if packet.passed else 1)

    typer.echo(f"shadow gate      {packet.policy.version}")
    typer.echo(f"window           {packet.window_start:%Y-%m-%d} → {packet.window_end:%Y-%m-%d}")
    typer.echo(f"verdict          {packet.verdict.upper()}")
    typer.echo("")
    for c in packet.criteria:
        value = "n/a" if c.value is None else f"{c.value:,.4g}"
        bar = "" if c.threshold is None else f"  (bar {c.threshold:,.4g})"
        typer.echo(f"  [{MARK[c.status]}] {c.name:<28} {value}{bar}")
        reason = c.detail.get("reason")
        if reason:
            typer.echo(f"         {reason}")

    h = packet.headline
    typer.echo("")
    typer.echo("headline (ADR-0002 §G — reported, not a criterion):")
    rate = h["fill_rate"]
    typer.echo(f"  qualified signals   {h['qualified_signals']}")
    typer.echo(f"  filled              {h['filled_orders']}")
    typer.echo(f"  fill rate           {f'{rate:.1%}' if rate is not None else 'n/a'}")
    slip = h["mean_slippage_vs_source"]
    typer.echo(f"  mean slippage       {f'{slip:+.4f}' if slip is not None else 'n/a'}")

    reasons = h["reject_reasons"]
    if isinstance(reasons, dict) and reasons:
        typer.echo("")
        typer.echo("  rejections by first failing gate:")
        for name, n in reasons.items():
            typer.echo(f"    {name:<26} {n}")

    versions = packet.policy_versions
    if len(versions) > 1:
        typer.echo("")
        typer.echo(
            f"  WARNING: {len(versions)} policy versions in window ({', '.join(versions)}). "
            "This packet averages two different systems."
        )

    if recorded:
        typer.echo("")
        typer.echo(f"recorded as {recorded}")

    if not packet.passed:
        typer.echo("")
        typer.echo("Live trading is NOT authorised. Blocking:")
        for c in packet.blocking:
            typer.echo(f"  {c.name} ({c.status})")
        raise typer.Exit(1)


@app.command()
def policy() -> None:
    """Print the active qualification and risk thresholds."""

    sp = SignalPolicy()
    rp = RiskPolicy()
    typer.echo(f"signal policy: {sp.version}")
    typer.echo(
        json.dumps(
            {
                "min_notional_usd": str(sp.min_notional_usd),
                "min_position_delta_ratio": str(sp.min_position_delta_ratio),
                "max_detection_latency_s": sp.max_detection_latency_s,
                "min_seconds_to_close": sp.min_seconds_to_close,
                "max_spread": str(sp.max_spread),
                "min_depth_multiple": str(sp.min_depth_multiple),
                "exclude_neg_risk": sp.exclude_neg_risk,
                "solo_rank_score": sp.solo_rank_score,
                "required_clusters": sp.required_clusters,
            },
            indent=2,
        )
    )
    typer.echo(f"risk policy: {rp.version}")
    typer.echo(
        json.dumps(
            {
                "max_per_entry": str(rp.max_per_entry),
                "max_per_market": str(rp.max_per_market),
                "max_correlated": str(rp.max_correlated),
                "daily_drawdown_halt": str(rp.daily_drawdown_halt),
                "max_book_participation": str(rp.max_book_participation),
            },
            indent=2,
        )
    )
    typer.echo("")
    typer.echo("Live execution is NOT enabled by this policy. Shadow mode only.")
