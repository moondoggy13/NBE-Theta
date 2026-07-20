// TS-side round-trip against the same fixtures the Python test uses.
//
// Valid fixtures: validate<T>() → { ok: true }, and no field went
// missing during ajv's schema check.
// Invalid fixtures: validate<T>() → { ok: false } with the expected
// error path in `errors[]`.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OrderIntent, SignalEnvelope, Market, ExecutionIntentRow } from "../../src/index.js";
import { validate, type SchemaName } from "../../src/validators.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

interface ValidCase {
  file: string;
  schema: SchemaName;
}
interface InvalidCase {
  file: string;
  schema: SchemaName;
  expectSubstring: string;
}

const VALID: ValidCase[] = [
  { file: "order_intent.valid.json", schema: "order-intent" },
  { file: "signal_envelope.valid.json", schema: "signal-envelope" },
  { file: "market.valid.json", schema: "market" },
  { file: "execution_intent_row.valid.json", schema: "execution-intent-row" },
];

const INVALID: InvalidCase[] = [
  { file: "order_intent.invalid.missing_side.json", schema: "order-intent", expectSubstring: "side" },
  { file: "order_intent.invalid.price_not_a_number.json", schema: "order-intent", expectSubstring: "limit_price" },
  { file: "order_intent.invalid.price_above_one.json", schema: "order-intent", expectSubstring: "limit_price" },
  { file: "order_intent.invalid.negative_quantity.json", schema: "order-intent", expectSubstring: "quantity" },
  { file: "order_intent.invalid.wrong_schema_version.json", schema: "order-intent", expectSubstring: "schema_version" },
  { file: "order_intent.invalid.extra_field.json", schema: "order-intent", expectSubstring: "additionalProperties" },
  { file: "signal_envelope.invalid.confidence_out_of_range.json", schema: "signal-envelope", expectSubstring: "confidence" },
];

// Compile-time smoke: after import, exercise each generated root type
// so `pnpm typecheck` fails if it went missing during regeneration.
function _typeSmoke(
  a: OrderIntent,
  b: SignalEnvelope,
  c: Market,
  d: ExecutionIntentRow,
): [OrderIntent, SignalEnvelope, Market, ExecutionIntentRow] {
  return [a, b, c, d];
}
void _typeSmoke;

describe("contracts round-trip (TS)", () => {
  for (const c of VALID) {
    it(`validates ${c.file} against ${c.schema}`, () => {
      const raw = load(c.file);
      const result = validate(c.schema, raw);
      if (!result.ok) console.error(result.errors);
      expect(result.ok).toBe(true);
    });
  }

  for (const c of INVALID) {
    it(`rejects ${c.file} against ${c.schema} (${c.expectSubstring})`, () => {
      const raw = load(c.file);
      const result = validate(c.schema, raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errorText = JSON.stringify(result.errors);
        expect(errorText).toContain(c.expectSubstring);
      }
    });
  }
});

// The unit-price pattern's bounds are the only range enforcement the
// TS consumer has (JSON Schema cannot numerically compare strings).
// Pin the closed upper bound — the regex's trickiest edge — against
// future edits.
describe("unit-price bounds enforced by the ajv validator", () => {
  const base = load("order_intent.valid.json") as Record<string, unknown>;

  for (const price of ["1", "1.0", "1.000", "0.43", "0.000001"]) {
    it(`accepts limit_price "${price}"`, () => {
      expect(validate("order-intent", { ...base, limit_price: price }).ok).toBe(true);
    });
  }

  for (const price of ["0", "0.0", "1.5", "1.75", "-0.4", "1.000001", "01", "1."]) {
    it(`rejects limit_price "${price}"`, () => {
      expect(validate("order-intent", { ...base, limit_price: price }).ok).toBe(false);
    });
  }

  it('rejects quantity "-10" and "0"', () => {
    expect(validate("order-intent", { ...base, quantity: "-10" }).ok).toBe(false);
    expect(validate("order-intent", { ...base, quantity: "0" }).ok).toBe(false);
  });
});

describe("schema_version pin enforced by the ajv validator", () => {
  const base = load("order_intent.valid.json") as Record<string, unknown>;

  it('rejects top-level schema_version "9.9.9"', () => {
    const result = validate("order-intent", { ...base, schema_version: "9.9.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.errors)).toContain("schema_version");
  });

  it("rejects a mismatched version on a NESTED payload", () => {
    const instrument = { ...(base.instrument as Record<string, unknown>), schema_version: "9.9.9" };
    expect(validate("order-intent", { ...base, instrument }).ok).toBe(false);
  });

  it('accepts the pinned version "1.0.0"', () => {
    expect(validate("order-intent", { ...base, schema_version: "1.0.0" }).ok).toBe(true);
  });
});
