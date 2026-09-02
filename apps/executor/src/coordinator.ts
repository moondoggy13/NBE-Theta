/**
 * Execution coordinator.
 *
 * The rules here are not style preferences. Each is the scar from a
 * specific incident recorded in CLAUDE.md, and the v2 one cost $29k.
 *
 * 1. **Lock synchronously, before any await.** `withInstrumentLock`
 *    takes the key in the same run-to-completion block it checks it in.
 *    A loser is told so immediately and drops the signal — it does not
 *    queue, because a copy signal that waits for a lock is stale by the
 *    time it gets one.
 *
 * 2. **Never blind-retry an ambiguous submit.** A timeout means an order
 *    may be resting on the venue. Retrying doubles exposure; the only
 *    safe response is to ask the venue what happened.
 *
 * 3. **Venue truth beats local belief.** Local intent state is the
 *    *least* authoritative source in AGENTS.md's hierarchy. After any
 *    uncertainty the coordinator reconciles rather than assuming.
 *
 * 4. **The kill switch stops dispatch; it does not liquidate.** Flatten
 *    is an explicit operator action, never an automatic reaction to a
 *    drawdown — forced selling into a falling thin book realises the
 *    worst available price.
 */

import {
  type ExecutionReport,
  InstrumentLocks,
  type OrderIntent,
  type PredictionMarketVenue,
  withInstrumentLock,
} from "@nbe-theta/execution-domain";

export type DispatchOutcome =
  | { kind: "executed"; report: ExecutionReport }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "reconciled"; report: ExecutionReport; recovered: boolean };

export type SkipReason =
  | "instrument_busy"
  | "halted"
  | "entries_paused"
  | "duplicate_intent";

export type RunState =
  | "running"
  | "pause_new_entries"
  | "cancel_open_orders"
  | "reduce_only"
  | "halted";

export interface CoordinatorOptions {
  accountId: string;
  venue: PredictionMarketVenue;
  locks?: InstrumentLocks;
  /** Intents already dispatched, for cross-restart idempotency. */
  seenIntents?: Set<string>;
  onAudit?: (event: { intent: OrderIntent; outcome: DispatchOutcome }) => void;
}

export class ExecutionCoordinator {
  private readonly accountId: string;
  private readonly venue: PredictionMarketVenue;
  private readonly locks: InstrumentLocks;
  private readonly seen: Set<string>;
  private readonly onAudit?: (e: { intent: OrderIntent; outcome: DispatchOutcome }) => void;
  private state: RunState = "running";

  constructor(opts: CoordinatorOptions) {
    this.accountId = opts.accountId;
    this.venue = opts.venue;
    this.locks = opts.locks ?? new InstrumentLocks();
    this.seen = opts.seenIntents ?? new Set();
    this.onAudit = opts.onAudit;
  }

  get runState(): RunState {
    return this.state;
  }

  /**
   * Advance the emergency state machine.
   *
   * Deliberately does NOT flatten. `halted` stops dispatch and nothing
   * more; closing positions is a separate, explicit operator action
   * (`flatten()`), because a stop that liquidates converts a paper loss
   * into a realised one at the worst price available.
   */
  setRunState(next: RunState): void {
    this.state = next;
  }

  /**
   * Dispatch one intent.
   *
   * Returns rather than throws for every expected outcome: a skipped
   * signal is normal operation, and forcing the caller into try/catch
   * for the common path is how skips end up silently swallowed.
   */
  async dispatch(intent: OrderIntent): Promise<DispatchOutcome> {
    const outcome = await this.dispatchInner(intent);
    this.onAudit?.({ intent, outcome });
    return outcome;
  }

  private async dispatchInner(intent: OrderIntent): Promise<DispatchOutcome> {
    if (this.state === "halted") return { kind: "skipped", reason: "halted" };
    if (
      (this.state === "pause_new_entries" ||
        this.state === "cancel_open_orders" ||
        this.state === "reduce_only") &&
      intent.side === "BUY"
    ) {
      return { kind: "skipped", reason: "entries_paused" };
    }

    // Idempotency check, synchronous, before the lock. A replayed intent
    // is not a race — it is the same decision arriving twice, and the
    // answer is to do nothing rather than to serialise it.
    if (this.seen.has(intent.clientIntentId)) {
      return { kind: "skipped", reason: "duplicate_intent" };
    }

    const result = await withInstrumentLock(
      this.locks,
      this.accountId,
      intent.instrument,
      async () => {
        // Re-check inside the lock. Between the check above and here
        // another dispatch may have won the lock and completed; without
        // this the same intent could be submitted twice.
        if (this.seen.has(intent.clientIntentId)) {
          return { kind: "skipped", reason: "duplicate_intent" } as DispatchOutcome;
        }
        // Mark BEFORE the await. If the submit outcome is ambiguous we
        // must not treat the intent as never-attempted — that is the
        // path that resubmits and doubles exposure.
        this.seen.add(intent.clientIntentId);

        const report = await this.venue.submitIntent(intent);

        if (report.status === "unknown") {
          const recovered = await this.reconcile(intent);
          return {
            kind: "reconciled",
            report: recovered ?? report,
            recovered: recovered !== null,
          } as DispatchOutcome;
        }
        return { kind: "executed", report } as DispatchOutcome;
      },
    );

    // null means the lock was held: another trigger is already acting on
    // this instrument. Drop it.
    return result ?? { kind: "skipped", reason: "instrument_busy" };
  }

  /**
   * Ask the venue what actually happened.
   *
   * The truth hierarchy, applied: open orders and recent fills are the
   * venue's own record and outrank anything we believe locally. If the
   * order is there, we adopt it; if it genuinely is not, the intent was
   * never placed and a later retry is safe — but that decision belongs
   * to the caller, not to a reflex inside the submit path.
   */
  private async reconcile(intent: OrderIntent): Promise<ExecutionReport | null> {
    const [open, fills] = await Promise.all([
      this.venue.listOpenOrders(),
      this.venue.listRecentFills(),
    ]);

    const resting = open.find((o) => o.clientIntentId === intent.clientIntentId);
    if (resting) {
      return {
        clientIntentId: intent.clientIntentId,
        venueOrderId: resting.venueOrderId,
        status: resting.status,
        filledQuantity: resting.filledQuantity,
        avgPrice: null,
        feesPaid: "0",
        reason: "recovered from open orders",
        observedAt: new Date().toISOString(),
      };
    }

    const matching = fills.fills.filter(
      (f) =>
        f.instrument.conditionId === intent.instrument.conditionId &&
        f.instrument.outcomeTokenId === intent.instrument.outcomeTokenId &&
        f.side === intent.side,
    );
    if (matching.length > 0) {
      const qty = matching.reduce((a, f) => a + Number(f.quantity), 0);
      const notional = matching.reduce((a, f) => a + Number(f.quantity) * Number(f.price), 0);
      const fees = matching.reduce((a, f) => a + Number(f.fee), 0);
      return {
        clientIntentId: intent.clientIntentId,
        venueOrderId: matching[0]?.venueOrderId ?? null,
        status: "filled",
        filledQuantity: String(qty),
        avgPrice: qty > 0 ? String(notional / qty) : null,
        feesPaid: String(fees),
        reason: "recovered from fills",
        observedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  /**
   * Cancel resting orders. Part of the kill sequence, and safe on its
   * own — a cancelled order costs nothing, unlike a forced exit.
   */
  async cancelOpenOrders(): Promise<string[]> {
    const result = await this.venue.cancelAll();
    return result.canceled;
  }

  /**
   * Explicitly close positions. Never called automatically.
   *
   * Separate from `setRunState` so that no drawdown, kill switch, or
   * error path can reach it by accident: flattening is an operator
   * decision with a real cost, and the only way to invoke it is to mean
   * it.
   */
  async flatten(): Promise<OrderIntent[]> {
    const positions = await this.venue.listPositions();
    const intents: OrderIntent[] = [];
    for (const p of positions) {
      const qty = Number(p.quantity);
      if (qty <= 0) continue;
      intents.push({
        clientIntentId: `flatten-${p.instrument.outcomeTokenId}-${Date.now()}`,
        instrument: p.instrument,
        side: "SELL",
        quantity: String(qty),
        // Flatten still takes a bound. "Get me out at any price" in a
        // thin book is how a 3c exit becomes a 0.1c exit.
        limitPrice: "0.01",
        timeInForce: "FAK",
      });
    }
    return intents;
  }
}
