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
export { CLAIM_SQL, RELEASE_SQL, TERMINAL_SQL, backoffSeconds, isRedispatchable } from "./outbox.js";
export type { ClaimedIntent } from "./outbox.js";
export { ClobSimulator } from "./venues/simulator.js";
export { PolymarketClobVenue } from "./venues/polymarket.js";
export type { ClobSigningClient } from "./venues/polymarket.js";
