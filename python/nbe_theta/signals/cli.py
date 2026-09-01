"""``theta-signals`` command — the copy pipeline.

  theta-signals summary     shadow-gate headline: fill rate + reject histogram
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
