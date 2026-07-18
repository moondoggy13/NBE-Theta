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
  { file: "order_intent.invalid.price_out_of_range.json", schema: "order-intent", expectSubstring: "limit_price" },
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
