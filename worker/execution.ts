/**
 * ExecutionManager — turns ensemble decisions into orders with full risk
 * + cooldown gates. Bug history note: an earlier version pasted in a flat
 * 50bp stop and used a 0.25 ensemble threshold, which caused thrashing on
 * minute bars (319 trades / 53h, ~$16k in fees, equity bled to 38% of start).
 * This version:
 *   - uses the strategy's ATR-based entryHint when present
 *   - enforces a configurable cooldown after every close
 *   - requires N consecutive same-side decisions before opening
 *   - blocks new entries on lifetime + daily drawdown via shouldBlock
 *   - persists daily_loss + day_anchor + peak via the supplied setRiskState
 */
import type { BrokerClient, Fill, Order } from "../src/lib/broker/types";
import { MockBrokerClient } from "../src/lib/broker/mock";
import { CoinbaseAdvancedClient } from "../src/lib/broker/coinbase-advanced";
import type { RiskPreset } from "../src/lib/risk/config";
import { maybeRollDay, shouldBlock, type RiskState } from "../src/lib/risk/kill-switch";
import { positionSize } from "../src/lib/risk/sizer";
import type { EnsembleDecision, Side } from "../src/lib/signals/types";
import type { Logger } from "./lib/logger";
import { isLiveEnabled, type AppEnv } from "./lib/env";

export interface ExecutionConfig {
  /** Minimum ms between closing a position and opening a new one. */
  cooldownMs: number;
  /** Number of consecutive same-side ensemble decisions before entering. */
  requireConsecutive: number;
  /** Fallback stop in fraction of price when strategy supplies no entryHint. */
  fallbackStopPct: number;
}

export const EXECUTION_DEFAULTS: ExecutionConfig = {
  cooldownMs: 5 * 60_000,    // 5 minutes
  requireConsecutive: 2,     // need two bars in a row
  fallbackStopPct: 0.015,    // 150 bps, generous default if no ATR hint
};

export interface ExecutionDeps {
  env: AppEnv;
  cfg: RiskPreset;
  symbol: string;
  broker: BrokerClient;
  logger: Logger;
  getRiskState(): RiskState;
  setRiskState(update: Partial<RiskState>): void;
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

  constructor(private readonly deps: ExecutionDeps) {
    this.execCfg = { ...EXECUTION_DEFAULTS, ...(deps.execCfg ?? {}) };
    this.deps.broker.onFill((fill, order) => this.onFill(fill, order));
    if (deps.broker.mode === "live" && !isLiveEnabled(deps.env)) {
      throw new Error("Live broker instantiated without COINBASE_LIVE=true && CONFIRM_LIVE=YES");
    }
  }

  async onDecision(decision: EnsembleDecision, lastPrice: number): Promise<void> {
    const { cfg, broker, logger } = this.deps;

    // 1. Mark-to-market and roll the UTC day if needed.
    const equity = await this.currentEquity();
    this.deps.setRiskState(maybeRollDay(this.deps.getRiskState(), equity, new Date()));
    const state = this.deps.getRiskState();

    // 2. Update consecutive-decision tracker.
    if (decision.side === this.consecutiveSide) {
      this.consecutiveCount += 1;
    } else {
      this.consecutiveSide = decision.side;
      this.consecutiveCount = 1;
    }

    // 3. Always honor reversal/flat: close any open position regardless of gates.
    const wantReverse =
      this.lastSide !== "flat" &&
      decision.side !== "flat" &&
      decision.side !== this.lastSide;
    const wantFlat = this.lastSide !== "flat" && decision.side === "flat";

    if (wantReverse || wantFlat) {
      await this.closeIfOpen(lastPrice, wantReverse ? "reverse" : "signal_flat");
    }
    if (decision.side === "flat") return;

    // 4. Pre-entry gates.
    const block = shouldBlock(cfg, state, equity);
    if (block.blocked) {
      logger.warn(
        { reason: block.reason, decision: decision.side, equity, dayStart: state.dayStartEquity, lifetimeStart: state.lifetimeStartEquity },
        "entry blocked by risk gate",
      );
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

    // 5. Resolve stop/target. Prefer the strategy's ATR-based entryHint.
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

    // Sanity: if hint stop is on wrong side of entry (data bug), refuse.
    if ((side === "long" && stop >= entry) || (side === "short" && stop <= entry)) {
      logger.warn({ side, entry, stop, target }, "entry hint stop on wrong side of entry; skipping");
      return;
    }

    const qty = positionSize(cfg, { equity, entry, stop });
    if (qty === 0) {
      logger.warn({ equity, entry, stop }, "sizing produced zero qty");
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
        { side, qty, entry: order.filledPrice, stop, target, equity },
        "position opened",
      );
    } catch (err) {
      logger.error({ err }, "submitOrder failed");
    }
  }

  /** Stop/target check on every tick. Returns true if a close was issued. */
  async onPriceUpdate(price: number): Promise<boolean> {
    if (this.lastSide === "flat") return false;
    const hitStop =
      (this.lastSide === "long" && price <= (this.currentStop ?? -Infinity)) ||
      (this.lastSide === "short" && price >= (this.currentStop ?? Infinity));
    const hitTarget =
      (this.lastSide === "long" && price >= (this.currentTarget ?? Infinity)) ||
      (this.lastSide === "short" && price <= (this.currentTarget ?? -Infinity));
    if (hitStop || hitTarget) {
      await this.closeIfOpen(price, hitStop ? "stop" : "target");
      return true;
    }
    return false;
  }

  private async closeIfOpen(price: number, reason: string): Promise<void> {
    if (this.lastSide === "flat") return;
    const positions = await this.deps.broker.getPositions();
    const pos = positions[0];
    if (!pos || pos.qty === 0) {
      this.lastSide = "flat";
      return;
    }
    const closeSide = pos.qty > 0 ? "sell" : "buy";
    try {
      await this.deps.broker.submitOrder({
        symbol: this.deps.symbol,
        side: closeSide,
        type: "market",
        qty: Math.abs(pos.qty),
        strategyId: "ensemble",
        metadata: { reason, price },
      });
      this.deps.logger.info({ side: this.lastSide, closedAt: price, reason }, "position closed");
    } catch (err) {
      this.deps.logger.error({ err }, "close order failed");
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
    this.deps.logger.debug({ fill, order }, "fill received");
  }
}

export function buildBroker(env: AppEnv, cfg: RiskPreset): BrokerClient {
  if (env.COINBASE_MODE === "paper") {
    return new MockBrokerClient({ startEquity: cfg.startEquity });
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
