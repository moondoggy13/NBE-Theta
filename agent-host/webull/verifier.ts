/**
 * Post-submit verification.
 *
 * After review_and_submit returns submitted=true, the driver doesn't know
 * the order actually appeared in Webull's Orders panel. This module is
 * responsible for that confirmation: poll the Orders / Positions UI until
 * we see the order with matching symbol + side + qty, then emit a Fill.
 *
 * Implementation lives behind the SkillRunner — the runner provides the
 * raw read; the verifier just owns the polling + match logic + timeout.
 */
import type { SubmitOrderBody, HostFillEvent } from "../protocol";
import type { SkillRunner } from "./skills";

export interface VerifierOptions {
  runner: SkillRunner;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function verifyFill(
  order: SubmitOrderBody,
  hostTaskId: string,
  opts: VerifierOptions,
): Promise<HostFillEvent | { error: string }> {
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const timeout = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const positions = await opts.runner.read_positions().catch(() => []);
    const match = positions.find((p) => p.symbol === order.symbol);
    if (match) {
      return {
        type: "fill",
        clientOrderId: order.clientOrderId,
        hostTaskId,
        ts: Date.now(),
        price: match.avgEntry,
        qty: order.qty,
        liquidity: "taker",
      };
    }
    await sleep(pollInterval);
  }
  return { error: `no fill observed within ${timeout}ms for ${order.clientOrderId}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
