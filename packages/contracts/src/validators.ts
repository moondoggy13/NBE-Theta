// Runtime validators for durable payloads.
//
// The generated TS types under ../generated/ts give compile-time
// checking; these validators give runtime checking. Every producer /
// consumer boundary uses them — the executor validates every intent
// before submitting, the signal generator validates every envelope
// before inserting, the ingest layer validates every raw fixture
// before persisting.
//
// Ajv is instantiated once, all schemas from ../schemas/*.schema.json
// are loaded eagerly at import time so validate<T>() is a hot-path
// dictionary lookup — no per-call schema compilation.

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Import every schema as JSON via TypeScript's --resolveJsonModule.
// Using explicit relative paths avoids Node ESM's ambiguity around
// "assert { type: 'json' }" across environments.
import eventSchema from "../schemas/event.schema.json" with { type: "json" };
import evidenceSchema from "../schemas/evidence.schema.json" with { type: "json" };
import executionIntentRowSchema from "../schemas/execution-intent-row.schema.json" with { type: "json" };
import executionReportSchema from "../schemas/execution-report.schema.json" with { type: "json" };
import marketSchema from "../schemas/market.schema.json" with { type: "json" };
import marketRuleVersionSchema from "../schemas/market-rule-version.schema.json" with { type: "json" };
import orderIntentSchema from "../schemas/order-intent.schema.json" with { type: "json" };
import outcomeSchema from "../schemas/outcome.schema.json" with { type: "json" };
import outcomeInstrumentSchema from "../schemas/outcome-instrument.schema.json" with { type: "json" };
import signalEnvelopeSchema from "../schemas/signal-envelope.schema.json" with { type: "json" };
import venueAccountStateSchema from "../schemas/venue-account-state.schema.json" with { type: "json" };
import venueFillSchema from "../schemas/venue-fill.schema.json" with { type: "json" };
import venueOrderSchema from "../schemas/venue-order.schema.json" with { type: "json" };
import venueOrderEventSchema from "../schemas/venue-order-event.schema.json" with { type: "json" };
import venuePositionSchema from "../schemas/venue-position.schema.json" with { type: "json" };

// The complete schema list. Ajv keys by $id (set by the Python export
// CLI to `https://nbe-theta.local/schemas/<slug>.schema.json`).
const SCHEMAS: readonly Record<string, unknown>[] = [
  eventSchema as Record<string, unknown>,
  evidenceSchema as Record<string, unknown>,
  executionIntentRowSchema as Record<string, unknown>,
  executionReportSchema as Record<string, unknown>,
  marketSchema as Record<string, unknown>,
  marketRuleVersionSchema as Record<string, unknown>,
  orderIntentSchema as Record<string, unknown>,
  outcomeSchema as Record<string, unknown>,
  outcomeInstrumentSchema as Record<string, unknown>,
  signalEnvelopeSchema as Record<string, unknown>,
  venueAccountStateSchema as Record<string, unknown>,
  venueFillSchema as Record<string, unknown>,
  venueOrderSchema as Record<string, unknown>,
  venueOrderEventSchema as Record<string, unknown>,
  venuePositionSchema as Record<string, unknown>,
];

// Ajv 2020-12. `strict: false` is important — Pydantic emits `title`
// fields on properties that Ajv would otherwise flag; they're
// informational, not restrictive.
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
});
addFormats.default(ajv);

// The `decimal` format is our own convention — a fixed-point string.
// Ajv doesn't know it natively; the schemas already carry the regex
// under `pattern`, so we teach Ajv that `decimal` is any string and
// let the `pattern` do the real work.
ajv.addFormat("decimal", { type: "string", validate: () => true });

for (const schema of SCHEMAS) {
  ajv.addSchema(schema);
}

/** Ajv validator identified by the schema slug. */
export type SchemaName =
  | "event"
  | "evidence"
  | "execution-intent-row"
  | "execution-report"
  | "market"
  | "market-rule-version"
  | "order-intent"
  | "outcome"
  | "outcome-instrument"
  | "signal-envelope"
  | "venue-account-state"
  | "venue-fill"
  | "venue-order"
  | "venue-order-event"
  | "venue-position";

const ID_PREFIX = "https://nbe-theta.local/schemas/";

/** Lookup a compiled validator by slug. Throws if the slug is unknown. */
export function getValidator<T>(name: SchemaName): ValidateFunction<T> {
  const id = `${ID_PREFIX}${name}.schema.json`;
  const validate = ajv.getSchema<T>(id);
  if (!validate) throw new Error(`No compiled schema for ${id}`);
  return validate;
}

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  errors: ErrorObject[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Validate an unknown value against a named schema.
 *
 * Returns a tagged result so callers can branch without try/catch. The
 * value is passed through unchanged on success — this validator does
 * not transform (no Decimal coercion, no date parsing). It's a shape
 * check only.
 */
export function validate<T>(name: SchemaName, value: unknown): ValidationResult<T> {
  const v = getValidator<T>(name);
  if (v(value)) {
    return { ok: true, value: value as T };
  }
  return { ok: false, errors: [...(v.errors ?? [])] };
}
