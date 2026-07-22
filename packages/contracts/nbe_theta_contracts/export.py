"""Contract export CLI.

Writes one JSON Schema file per top-level Pydantic model into a target
directory. Each schema is stamped with a stable ``$id`` derived from the
model name so both Ajv (TS) and Pydantic (Python) can look it up in a
consistent registry.

Usage:

    python -m nbe_theta_contracts.export schemas <out_dir>

The TS types are generated in a separate step by
``packages/contracts/scripts/generate-ts.mjs``; that script reads the
files this CLI writes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer
from pydantic import BaseModel

from nbe_theta_contracts._version import SCHEMA_VERSION
from nbe_theta_contracts import (
    Event,
    Evidence,
    ExecutionIntentRow,
    ExecutionReport,
    Market,
    MarketRuleVersion,
    OrderIntent,
    Outcome,
    OutcomeInstrument,
    SignalEnvelope,
    VenueAccountState,
    VenueFill,
    VenueOrder,
    VenueOrderEvent,
    VenuePosition,
)

app = typer.Typer(add_completion=False, help="Contract export CLI.")

EXPORTED_MODELS: list[type[BaseModel]] = [
    # markets
    Event,
    Market,
    Outcome,
    MarketRuleVersion,
    OutcomeInstrument,
    # orders + execution
    OrderIntent,
    ExecutionReport,
    VenueOrder,
    VenueOrderEvent,
    VenueFill,
    # positions
    VenuePosition,
    VenueAccountState,
    # signals
    Evidence,
    SignalEnvelope,
    # outbox
    ExecutionIntentRow,
]

SCHEMA_ID_BASE = "https://nbe-theta.local/schemas"


def _kebab(name: str) -> str:
    """PascalCase → kebab-case."""

    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0 and not name[i - 1].isupper():
            out.append("-")
        out.append(ch.lower())
    return "".join(out)


def _sort_keys_deep(obj: Any) -> Any:
    """Recursively sort dict keys so the on-disk output is deterministic.

    Pydantic's ``model_json_schema()`` orders keys by insertion; without
    a sort pass, a Python version change can produce spurious diffs.
    """

    if isinstance(obj, dict):
        return {k: _sort_keys_deep(obj[k]) for k in sorted(obj.keys())}
    if isinstance(obj, list):
        return [_sort_keys_deep(x) for x in obj]
    return obj


def _model_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema(mode="validation")
    # Stable $id per model. Consumers (Ajv, Python registry) key on this.
    slug = _kebab(model.__name__)
    schema["$id"] = f"{SCHEMA_ID_BASE}/{slug}.schema.json"
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    return _sort_keys_deep(schema)


@app.command()
def schemas(
    out_dir: Path = typer.Argument(..., help="Output directory (created if missing)."),
) -> None:
    """Emit one <model>.schema.json per exported model."""

    out_dir.mkdir(parents=True, exist_ok=True)

    written: list[str] = []
    for model in EXPORTED_MODELS:
        slug = _kebab(model.__name__)
        target = out_dir / f"{slug}.schema.json"
        payload = _model_schema(model)
        target.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
        written.append(target.name)

    # An index file mapping model name → $id + filename. Also carries
    # the canonical schema_version — the TS package re-exports it from
    # here, so the constant can never silently diverge across languages.
    index = {
        "generated_by": "nbe_theta_contracts.export",
        "schema_version": SCHEMA_VERSION,
        "schemas": [
            {
                "name": model.__name__,
                "slug": _kebab(model.__name__),
                "id": f"{SCHEMA_ID_BASE}/{_kebab(model.__name__)}.schema.json",
                "file": f"{_kebab(model.__name__)}.schema.json",
            }
            for model in EXPORTED_MODELS
        ],
    }
    (out_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    written.append("index.json")

    # Prune zombies: a model renamed or dropped from EXPORTED_MODELS
    # must not leave its old schema behind (generate-ts.mjs would keep
    # generating TS for it forever). Mirrors the rm -rf the TS side does.
    for stale in out_dir.glob("*.schema.json"):
        if stale.name not in written:
            stale.unlink()
            typer.echo(f"Pruned stale {stale.name}")

    typer.echo(f"Wrote {len(written)} files to {out_dir}")


@app.command()
def list_models() -> None:
    """List every model the CLI exports."""

    for model in EXPORTED_MODELS:
        typer.echo(f"- {model.__name__} ({_kebab(model.__name__)})")


if __name__ == "__main__":
    app()
