/**
 * The live-execution gate.
 *
 * Three environment flags, ALL required, checked at construction time:
 *
 *   EXECUTION_PROVIDER=polymarket-clob
 *   POLYMARKET_LIVE=true
 *   CONFIRM_LIVE=YES
 *
 * Checked at construction rather than at submit on purpose. A venue
 * adapter that exists but refuses individual orders is a loaded gun with
 * the safety on; one that cannot be built at all is an unloaded gun. If
 * the process starts, it is because someone deliberately set all three,
 * and CI never sets any of them (AGENTS.md).
 *
 * The gate is necessary and not sufficient: ADR-0002 also requires the
 * console's operating mode set to `live` with two-step confirmation, a
 * passed shadow gate, and documented compliance approval for the
 * operating jurisdiction.
 */

export interface LiveGate {
  executionProvider: string;
  polymarketLive: boolean;
  confirmLive: boolean;
  satisfied: boolean;
  missing: string[];
}

/**
 * Only three keys are read, so the parameter is a plain string map
 * rather than `NodeJS.ProcessEnv`. That keeps callers (and tests) from
 * having to construct a whole environment to ask one question.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export function readLiveGate(env: EnvLike = process.env): LiveGate {
  const provider = env.EXECUTION_PROVIDER ?? "mock";
  const live = env.POLYMARKET_LIVE === "true";
  const confirmed = env.CONFIRM_LIVE === "YES";

  const missing: string[] = [];
  if (provider !== "polymarket-clob") missing.push("EXECUTION_PROVIDER=polymarket-clob");
  if (!live) missing.push("POLYMARKET_LIVE=true");
  if (!confirmed) missing.push("CONFIRM_LIVE=YES");

  return {
    executionProvider: provider,
    polymarketLive: live,
    confirmLive: confirmed,
    satisfied: missing.length === 0,
    missing,
  };
}

export class LiveGateError extends Error {
  constructor(public readonly gate: LiveGate) {
    super(
      `live execution refused; missing: ${gate.missing.join(", ")}. ` +
        "This is a deliberate construction-time gate, not a transient error.",
    );
    this.name = "LiveGateError";
  }
}

/** Throws unless all three flags are set. */
export function assertLiveAllowed(env: EnvLike = process.env): LiveGate {
  const gate = readLiveGate(env);
  if (!gate.satisfied) throw new LiveGateError(gate);
  return gate;
}
