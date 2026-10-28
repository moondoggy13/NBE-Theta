/**
 * Executor entrypoint surface.
 *
 * There is deliberately no `main()` that starts trading. Wiring the
 * outbox loop to a live venue is the last step before real money moves,
 * and it belongs with the live capability gate — after the shadow gate
 * passes and compliance signs off (ADR-0002). What ships here is the
 * machinery, fully tested against the simulator.
 */
export { ExecutionCoordinator } from "./coordinator.js";
export type { DispatchOutcome, RunState, SkipReason } from "./coordinator.js";
export { assertLiveAllowed, readLiveGate, LiveGateError } from "./config.js";
export type { EnvLike, LiveGate } from "./config.js";
export {
  CLAIM_SQL,
  RECLAIM_SQL,
  RELEASE_SQL,
  TERMINAL_SQL,
  LEASE_SECONDS,
  assertLeaseExceedsWork,
  backoffSeconds,
  isRedispatchable,
} from "./outbox.js";
export type { ClaimedIntent } from "./outbox.js";
export { ClobSimulator } from "./venues/simulator.js";
export { PolymarketClobVenue } from "./venues/polymarket.js";
export type { ClobSigningClient } from "./venues/polymarket.js";
export {
  CredentialError,
  Secret,
  SIGNATURE_TYPES,
  describeCredentials,
  isProxiedScheme,
  loadCredentials,
  normalizeHex,
} from "./venues/credentials.js";
export type {
  ApiCredentials,
  ResolvedCredentials,
  SignatureTypeName,
} from "./venues/credentials.js";
/**
 * The concrete signing client is NOT re-exported here.
 *
 * `venues/clob-client.ts` dynamically imports viem and the venue SDK,
 * and this index is reachable from the Next.js build graph. A static
 * re-export would pull signing code into `apps/web`, which AGENTS.md
 * forbids outright. Import it directly from the executor process that
 * needs it — `bin/preflight.ts` is the example.
 */
export { exitCode, formatReport, runPreflight } from "./preflight.js";
export type {
  Check,
  CheckState,
  Connect,
  PreflightReport,
  PreflightTarget,
  PreflightVerdict,
} from "./preflight.js";
