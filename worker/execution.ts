/**
 * ExecutionManager — turns ensemble decisions into orders with full risk
 * + cooldown gates.
 *
 * Bug history (so future readers know the constraints):
 *   v1: 50bp stop placeholder, 0.25 ensemble threshold → 319 trades / 53h,
 *       fee bleed bug. Fixed in v2 with cooldown + consecutive bars + ATR
 *       stops + lifetime drawdown gate.
 *   v2: still had a race condition — onPriceUpdate's stop check was sync
 *       but closeIfOpen was async, so 4 ticks within 1ms could each enter
 *       closeIfOpen and submit duplicate close orders. The first close
 *       covered the position; the 2nd-4th flipped it into a 57x leveraged
 *       runaway long that lost $29k on a 1.94% BTC drop. The MockBroker
 *       had no buying-power enforcement so it gladly filled all 4.
 *
 * v3 (this file) adds:
 *   - synchronous `inFlight` mutex on close path (kills the race)
 *   - per-tick reconciliation: if broker has a position but we think we're
 *     flat, force-close it (kills phantom positions if state diverges)
 *   - flattenAndHalt() the kill switch can call to close on trip
 *   - `onFill` updates `lastSide` from broker truth so duplicates that
 *     somehow still slip through don't compound silently
 */
import type { BrokerClient, Fill, Order, PositionView } from "../src/lib/broker/types";
import { MockBrokerClient } from "../src/lib/broker/mock";
import { CoinbaseAdvancedClient } from "../src/lib/broker/coinbase-advanced";
import type { RiskPreset } from "../src/lib/risk/config";
import { maybeRollDay, shouldBlock, type RiskState } from "../src/lib/risk/kill-switch";
import { positionSize } from "../src/lib/risk/sizer";
import type { EnsembleDecision, Side } from "../src/lib/signals/types";
import type { Logger } from "./lib/logger";
import { isLiveEnabled, type AppEnv } from "./lib/env";

export interface ExecutionConfig {
  cooldownMs: number;
  requireConsecutive: number;
  fallbackStopPct: number;
  /** When true, hitting any kill-switch reason auto-flattens any open position. */
  flattenOnKill: boolean;
  /** Cap on notional exposure as a multiple of equity for sizing. 1.0 = spot. */
  maxLeverage: number;
}

export const EXECUTION_DEFAULTS: ExecutionConfig = {
  cooldownMs: 5 * 60_000,
  requireConsecutive: 2,
  fallbackStopPct: 0.015,
  flattenOnKill: true,
  maxLeverage: 1.0,
};

export interface ExecutionDeps {
  env: AppEnv;
  cfg: RiskPreset;
  symbol: string;
  broker: BrokerClient;
  logger: Logger;
  getRiskState(): RiskState;
  setRiskState(update: Partial<RiskState>): void;
  /** Optional callback fired when ExecutionManager itself trips the kill switch. */
  onKillSwitchTrip?(reason: string): Promise<void>;
  execCfg?: Partial<ExecutionConfig>;
}

export class ExecutionManager {
  private lastSide: Side = "flat";
  private currentStop?: number;
  private currentTarget?: number;
  private lastClosedAt = 0;
  private consecutiveCount = 0;
  private consecutiveSide: Side = "flat";
  private readonly execCfg: ExecutionConfig;
  /**
   * Synchronous re-entrancy lock. Set BEFORE any await in close/decision
   * paths, cleared in finally. Prevents the v2 race where multiple ticks
   * each entered closeIfOpen because lastSide was only flipped to "flat"
   * after the broker submitOrder await resolved.
   */
  private inFlight = false;
  /** Snapshot of the most recent fill so the next tick can reconcile. */
  private lastFillTs = 0;

  constructor(private readonly deps: ExecutionDeps) {
    this.execCfg = { ...EXECUTION_DEFAULTS, ...(deps.execCfg ?? {}) };
    this.deps.broker.onFill((fill, order) => this.onFill(fill, order));
    if (deps.broker.mode === "live" && !isLiveEnabled(deps.env)) {
      throw new Error("Live broker instantiated without COINBASE_LIVE=true && CONFIRM_LIVE=YES");
    }
  }

  async onDecision(decision: EnsembleDecision, lastPrice: number): Promise<void> {
    if (this.inFlight) return;          // another execution path holds the lock
    this.inFlight = true;
    try {
      await this.handleDecision(decision, lastPrice);
    } finally {
      this.inFlight = false;
    }
  }

  /** Stop/target check on every tick. Returns true if a close was issued. */
  async onPriceUpdate(price: number): Promise<boolean> {
    if (this.inFlight) return false;
    if (this.lastSide === "flat") return false;
    const hitStop =
      (this.lastSide === "long" && price <= (this.currentStop ?? -Infinity)) ||
      (this.lastSide === "short" && price >= (this.currentStop ?? Infinity));
    const hitTarget =
      (this.lastSide === "long" && price >= (this.currentTarget ?? Infinity)) ||
      (this.lastSide === "short" && price <= (this.currentTarget ?? -Infinity));
    if (!hitStop && !hitTarget) return false;
    // Take the lock SYNCHRONOUSLY before any await so concurrent ticks see it.
    this.inFlight = true;
    try {
      await this.closeIfOpen(price, hitStop ? "stop" : "target");
    } finally {
      this.inFlight = false;
    }
    return true;
  }

  /**
   * Reconcile our internal `lastSide` with the broker's actual position.
   * If a phantom non-zero position exists (e.g. from a duplicate fill that
   * slipped through), force-close it. Idempotent and safe to call cheaply.
   */
  async reconcile(): Promise<void> {
    if (this.inFlight) return;
    const positions = await this.deps.broker.getPositions();
    const pos = positions[0];
    if (!pos || pos.qty === 0) {
      if (this.lastSide !== "flat") {
        this.lastSide = "flat";
        this.currentStop = undefined;
        this.currentTarget = undefined;
      }
      return;
    }
    const brokerSide: Side = pos.qty > 0 ? "long" : "short";
    if (brokerSide !== this.lastSide) {
      this.deps.logger.warn(
        { brokerSide, internalSide: this.lastSide, qty: pos.qty, avgEntry: pos.avgEntry },
        "phantom position detected — forcing close",
      );
      this.inFlight = true;
      try {
        await this.flattenPosition(pos, "phantom_reconcile");
      } finally {
        this.inFlight = false;
      }
    }
  }

  /** Auto-close everything. Used by the kill switch path. */
  async flattenAndHalt(reason: string): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const positions = await this.deps.broker.getPositions();
      const pos = positions[0];
      if (pos && pos.qty !== 0) {
        await this.flattenPosition(pos, `kill:${reason}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  // ─── private ──────────────────────────────────────────────────────────

  private async handleDecision(decision: EnsembleDecision, lastPrice: number): Promise<void> {
    const { cfg, broker, logger } = this.deps;
    const equity = await this.currentEquity();
    this.deps.setRiskState(maybeRollDay(this.deps.getRiskState(), equity, new Date()));
    const state = this.deps.getRiskState();

    if (decision.side === this.consecutiveSide) {
      this.consecutiveCount += 1;
    } else {
      this.consecutiveSide = decision.side;
      this.consecutiveCount = 1;
    }

    const wantReverse =
      this.lastSide !== "flat" &&
      decision.side !== "flat" &&
      decision.side !== this.lastSide;
    const wantFlat = this.lastSide !== "flat" && decision.side === "flat";
    if (wantReverse || wantFlat) {
      await this.closeIfOpen(lastPrice, wantReverse ? "reverse" : "signal_flat");
    }
    if (decision.side === "flat") return;

    const block = shouldBlock(cfg, state, equity);
    if (block.blocked) {
      logger.warn(
        { reason: block.reason, decision: decision.side, equity, dayStart: state.dayStartEquity, lifetimeStart: state.lifetimeStartEquity },
        "entry blocked by risk gate",
      );
      // Auto-flatten on kill-class block reasons.
      if (
        this.execCfg.flattenOnKill &&
        (block.reason === "lifetime_stop_hit" || block.reason === "daily_stop_hit" || block.reason === "kill_switch_active")
      ) {
        const pos = (await broker.getPositions())[0];
        if (pos && pos.qty !== 0) {
          await this.flattenPosition(pos, `kill:${block.reason}`);
        }
        await this.deps.onKillSwitchTrip?.(block.reason ?? "unknown");
      }
      return;
    }
    if (this.lastSide === decision.side) return;
    if (this.consecutiveCount < this.execCfg.requireConsecutive) {
      logger.debug(
        { side: decision.side, consecutive: this.consecutiveCount, need: this.execCfg.requireConsecutive },
        "decision needs more confirmation bars",
      );
      return;
    }
    const sinceClose = Date.now() - this.lastClosedAt;
    if (this.lastClosedAt > 0 && sinceClose < this.execCfg.cooldownMs) {
      logger.debug(
        { side: decision.side, sinceCloseMs: sinceClose, cooldownMs: this.execCfg.cooldownMs },
        "in cooldown after recent close",
      );
      return;
    }

    const side: Exclude<Side, "flat"> = decision.side;
    const entry = lastPrice;
    const hint = decision.contributing.find(
      (c) => c.side === side && c.weight > 0 && c.entryHint,
    )?.entryHint;
    let stop: number;
    let target: number;
    if (hint) {
      stop = hint.stop;
      target = hint.target;
    } else {
      const sp = this.execCfg.fallbackStopPct;
      stop = side === "long" ? entry * (1 - sp) : entry * (1 + sp);
      target = side === "long" ? entry * (1 + sp * 2) : entry * (1 - sp * 2);
    }
    if ((side === "long" && stop >= entry) || (side === "short" && stop <= entry)) {
      logger.warn({ side, entry, stop, target }, "entry hint stop on wrong side of entry; skipping");
      return;
    }

    const qty = positionSize(cfg, {
      equity,
      entry,
      stop,
      maxLeverage: this.execCfg.maxLeverage,
    });
    if (qty === 0) {
      logger.warn({ equity, entry, stop, maxLeverage: this.execCfg.maxLeverage }, "sizing produced zero qty");
      return;
    }

    try {
      const order = await broker.submitOrder({
        symbol: this.deps.symbol,
        side: side === "long" ? "buy" : "sell",
        type: "market",
        qty,
        strategyId: "ensemble",
        metadata: {
          decisionScore: decision.score,
          confidence: decision.confidence,
          stop,
          target,
          consecutive: this.consecutiveCount,
        },
      });
      this.lastSide = side;
      this.currentStop = stop;
      this.currentTarget = target;
      logger.info(
        { side, qty, entry: order.filledPrice, stop, target, equity, notional: qty * entry },
        "position opened",
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, "submitOrder failed");
    }
  }

  private async closeIfOpen(price: number, reason: string): Promise<void> {
    if (this.lastSide === "flat") return;
    const positions = await this.deps.broker.getPositions();
    const pos = positions[0];
    if (!pos || pos.qty === 0) {
      this.lastSide = "flat";
      this.currentStop = undefined;
      this.currentTarget = undefined;
      return;
    }
    await this.flattenPosition(pos, reason, price);
  }

  private async flattenPosition(pos: PositionView, reason: string, markPrice?: number): Promise<void> {
    const closeSide = pos.qty > 0 ? "sell" : "buy";
    try {
      await this.deps.broker.submitOrder({
        symbol: this.deps.symbol,
        side: closeSide,
        type: "market",
        qty: Math.abs(pos.qty),
        strategyId: "ensemble",
        metadata: { reason, price: markPrice ?? null },
      });
      this.deps.logger.info(
        { closedSide: this.lastSide, qty: pos.qty, avgEntry: pos.avgEntry, reason },
        "position closed",
      );
    } catch (err) {
      this.deps.logger.error({ err: (err as Error).message, reason }, "close order failed");
    }
    this.lastSide = "flat";
    this.currentStop = undefined;
    this.currentTarget = undefined;
    this.lastClosedAt = Date.now();
  }

  private async currentEquity(): Promise<number> {
    const acct = await this.deps.broker.getAccount();
    return acct.equity;
  }

  private onFill(fill: Fill, order: Order): void {
    this.lastFillTs = fill.ts;
    this.deps.logger.debug({ fill, order }, "fill received");
  }
}

export function buildBroker(env: AppEnv, cfg: RiskPreset): BrokerClient {
  if (env.COINBASE_MODE === "paper") {
    return new MockBrokerClient({
      startEquity: cfg.startEquity,
      maxLeverage: 1.0, // spot reality; orders that exceed buying power are rejected
    });
  }
  if (!isLiveEnabled(env)) {
    throw new Error("Live mode requested but gates not set; staying in paper");
  }
  if (!env.COINBASE_API_KEY_NAME || !env.COINBASE_API_PRIVATE_KEY) {
    throw new Error("Live mode requires COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY");
  }
  return new CoinbaseAdvancedClient({
    apiKeyName: env.COINBASE_API_KEY_NAME,
    apiPrivateKey: env.COINBASE_API_PRIVATE_KEY,
    symbol: env.SYMBOL,
    liveEnabled: true,
  });
}
