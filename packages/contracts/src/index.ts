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

/** Package-wide schema version. Consumers reject on mismatch. */
export const SCHEMA_VERSION = "1.0.0";
