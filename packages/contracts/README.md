# @nbe-theta/contracts

Durable-payload contracts for NBE-Theta. Pydantic v2 models are the single
source of truth. JSON Schema (draft 2020-12) is emitted to `schemas/` and
TypeScript types are generated into `generated/ts/`. Both files trees are
**checked in** so consumers (Python and TS) never race the generation
step, and CI fails if a change was made without regenerating.

## Layout

```
nbe_theta_contracts/   Python source of truth (Pydantic models)
schemas/               generated JSON Schema files (checked in)
generated/ts/          generated TypeScript types (checked in)
src/                   hand-written TS surface: validators + re-exports
fixtures/              cross-language JSON fixtures
tests/                 Python + TS round-trip tests
scripts/               codegen helpers
```

## Conventions

- Every durable payload includes `schema_version: str`. Consumers reject
  on mismatch.
- `Decimal` fields serialize as JSON strings (Pydantic v2 default) and
  validate on the TS side via a decimal-format regex.
- Datetimes serialize as ISO-8601 UTC (`"2026-07-18T04:12:00Z"`).
- UUIDs serialize as strings; `ajv-formats` covers both formats.
- Enums use `Literal[...]` — cleaner than string-Enum classes for wire
  types.

## Commands

Regenerate the tree:

```
pnpm --filter @nbe-theta/contracts generate
```

Verify the checked-in tree matches the source models (CI runs this):

```
pnpm --filter @nbe-theta/contracts check
```

Run Python round-trip tests:

```
cd packages/contracts
python -m pytest tests/python
```

Run TS round-trip tests:

```
pnpm --filter @nbe-theta/contracts test
```

## Extending

To add a new payload:

1. Add a Pydantic model in an existing module (or a new one) under
   `nbe_theta_contracts/`.
2. Register the model in `nbe_theta_contracts/export.py` under
   `EXPORTED_MODELS`.
3. Run `pnpm --filter @nbe-theta/contracts generate` from the repo root.
4. Add fixtures under `fixtures/` (at least one `.valid.json` and 2–3
   `.invalid.*.json`).
5. Add cases in `tests/python/test_roundtrip.py` and
   `tests/ts/roundtrip.test.ts`.

Never edit `schemas/*.schema.json` or `generated/ts/*.ts` by hand. CI
diff-checks them.
