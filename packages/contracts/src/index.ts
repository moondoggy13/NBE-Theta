// Public surface of @nbe-theta/contracts.
//
// Compile-time types (re-exported from generated/ts) + runtime
// validators. Consumers should import types AND call validate() at any
// serialization boundary.

export * from "../generated/ts/index.js";

export {
  getValidator,
  validate,
  type SchemaName,
  type ValidationFailure,
  type ValidationResult,
  type ValidationSuccess,
} from "./validators.js";

import schemaIndex from "../schemas/index.json" with { type: "json" };

/**
 * Package-wide schema version. Consumers reject on mismatch.
 *
 * Sourced from the generated schemas/index.json (written by the Python
 * export CLI from _version.py) — NOT hand-duplicated — so the constant
 * cannot silently diverge between languages. The registry test pins
 * this against every schema's schema_version pattern.
 */
export const SCHEMA_VERSION: string = schemaIndex.schema_version;
