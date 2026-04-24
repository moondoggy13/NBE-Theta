/**
 * ExecutionManager: takes ensemble decisions, applies risk gates, sizes
 * the position, routes orders through the configured broker. Enforces
 * the two-flag live gate at every call site (defense in depth).
 */
import type { BrokerClient, Fill, Order } from "../src/lib/broker/types";
import { MockBrokerClient } from "../src/lib/broker/mock";
import { CoinbaseAdvancedClient } from "../src/lib/broker/coinbase-advanced";
import type { RiskPreset } from "../src/lib/risk/config";
import { maybeRollDay, shouldBlock, type RiskState } from "../src/lib/risk/kill-switch";
import { positionSize } from "../src/lib/risk/sizer";
import type { EnsembleDecision } from "../src/lib/signals/types";
import type { Logger } from "./lib/logger";
import { isLiveEnabled, type AppEnv } from "./lib/env";

export interface ExecutionDeps {
  env: AppEnv;
  cfg: RiskPreset;
  symbol: string;
  broker: BrokerClient;
  logger: Logger;
  getRiskState(): RiskState;
  setRiskState(update: Partial<RiskState>): void;
}

export class ExecutionManager {
  private lastSide: "long" | "short" | "flat" = "flat";
  private currentStop?: number;
  private currentTarget?: number;

  constructor(private readonly deps: ExecutionDeps) {
    this.deps.broker.onFill((fill, order) => this.onFill(fill, order));
    // Defense in depth: if a live broker is in play but gating is disabled,
    // refuse at construction time. Mock broker is always fine.
    if (deps.broker.mode === "live" && !isLiveEnabled(deps.env)) {
      throw new Error("Live broker instantiated without COINBASE_LIVE=true && CONFIRM_LIVE=YES");
    }
  }

  async onDecision(decision: EnsembleDecision, lastPrice: number): Promise<void> {
    const { cfg, broker, logger } = this.deps;

    // Roll UTC day if needed
    this.deps.setRiskState(
      maybeRollDay(this.deps.getRiskState(), await this.currentEquity(), new Date()),
    );

    const state = this.deps.getRiskState();
    const equity = await this.currentEquity();
    const block = shouldBlock(cfg, state, equity);

    // Flat / reversal → close existing position regardless of gates
    if (this.lastSide !== "flat" && decision.side !== this.lastSide) {
      await this.closeIfOpen(lastPrice);
    }

    if (decision.side === "flat") return;

    if (block.blocked) {
      logger.warn({ reason: block.reason, decision: decision.side }, "order blocked");
      return;
    }

    if (this.lastSide === decision.side) return; // already in that side

    // Determine stop/target from contributing strategy hints (first one with entryHint)
    const firstHint = decision.contributing.find((c) => c.side === decision.side && c.weight > 0);
    if (!firstHint) return;

    // Entry price = lastPrice; stop/target from ensemble metadata placeholder
    // NOTE: production paths plumb entryHint through the signal → ensemble;
    // here we fall back to ATR-agnostic percentage defaults.
    const side = decision.side;
    const entry = lastPrice;
    const stopPct = 0.005; // 50 bps default fallback
    const stop = side === "long" ? entry * (1 - stopPct) : entry * (1 + stopPct);
    const target = side === "long" ? entry * (1 + stopPct * 2) : entry * (1 - stopPct * 2);

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
        metadata: { decisionScore: decision.score, confidence: decision.confidence },
      });
      this.lastSide = side;
      this.currentStop = stop;
      this.currentTarget = target;
      logger.info(
        { side, qty, entry: order.filledPrice, stop, target },
        "position opened",
      );
    } catch (err) {
      logger.error({ err }, "submitOrder failed");
    }
  }

  /**
   * Called on every tick/bar update to check stop/target.
   * Returns true if a close was issued (so the caller can recompute).
   */
  async onPriceUpdate(price: number): Promise<boolean> {
    if (this.lastSide === "flat") return false;
    const hitStop =
      (this.lastSide === "long" && price <= (this.currentStop ?? -Infinity)) ||
      (this.lastSide === "short" && price >= (this.currentStop ?? Infinity));
    const hitTarget =
      (this.lastSide === "long" && price >= (this.currentTarget ?? Infinity)) ||
      (this.lastSide === "short" && price <= (this.currentTarget ?? -Infinity));
    if (hitStop || hitTarget) {
      await this.closeIfOpen(price);
      return true;
    }
    return false;
  }

  private async closeIfOpen(price: number): Promise<void> {
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
        metadata: { reason: "close", price },
      });
      this.deps.logger.info({ side: this.lastSide, closedAt: price }, "position closed");
    } catch (err) {
      this.deps.logger.error({ err }, "close order failed");
    }
    this.lastSide = "flat";
    this.currentStop = undefined;
    this.currentTarget = undefined;
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
