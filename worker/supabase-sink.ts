/**
 * Worker → Supabase sink.
 *
 * - Polls risk_state once/sec so dashboard toggles propagate into the
 *   in-memory RiskState the ExecutionManager consults.
 * - Batches strategy_signals, pnl_snapshots writes to reduce round-trips.
 * - Immediate writes for orders + fills (auditable).
 *
 * All operations no-op cleanly when Supabase env is not configured, so
 * the worker runs standalone for local testing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverClient } from "../src/lib/supabase/client";
import type { RiskState } from "../src/lib/risk/kill-switch";
import type { Fill, Order } from "../src/lib/broker/types";
import type { EnsembleDecision, StrategySignal } from "../src/lib/signals/types";
import type { Logger } from "./lib/logger";

export interface SinkDeps {
  logger: Logger;
  applyRiskState: (next: Partial<RiskState>) => void;
}

const BATCH_INTERVAL_MS = 500;
const RISK_POLL_MS = 1_000;

interface PendingBatch {
  signals: Array<Record<string, unknown>>;
  pnl: Array<Record<string, unknown>>;
}

export class SupabaseSink {
  private client: SupabaseClient | null;
  private batch: PendingBatch = { signals: [], pnl: [] };
  private flushTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;

  constructor(private readonly deps: SinkDeps) {
    this.client = serverClient();
    if (!this.client) {
      deps.logger.warn("supabase not configured — sink is a no-op");
      return;
    }
    this.flushTimer = setInterval(() => this.flush(), BATCH_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.pollRiskState(), RISK_POLL_MS);
  }

  close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  recordSignal(symbol: string, s: StrategySignal): void {
    if (!this.client) return;
    this.batch.signals.push({
      symbol,
      strategy_id: s.strategyId,
      ts: new Date(s.ts).toISOString(),
      side: s.side,
      score: s.score,
      confidence: s.confidence,
      features: s.features,
      entry_hint: s.entryHint ?? null,
    });
  }

  recordEnsembleSignal(symbol: string, decision: EnsembleDecision): void {
    if (!this.client) return;
    this.batch.signals.push({
      symbol,
      strategy_id: "ensemble",
      ts: new Date(decision.ts || Date.now()).toISOString(),
      side: decision.side,
      score: decision.score,
      confidence: decision.confidence,
      features: { contributing: decision.contributing },
      entry_hint: null,
    });
  }

  async recordOrder(order: Order): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.from("orders").insert({
      id: order.id,
      coinbase_order_id: order.brokerOrderId ?? null,
      mode: order.mode,
      strategy_id: order.strategyId ?? null,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      qty: order.qty,
      price: order.price ?? null,
      status: order.status,
      submitted_at: new Date(order.submittedAt).toISOString(),
      filled_at: order.filledAt ? new Date(order.filledAt).toISOString() : null,
      filled_qty: order.filledQty,
      filled_price: order.filledPrice ?? null,
      fees: order.fees,
      meta: order.metadata ?? {},
    });
    if (error) this.deps.logger.error({ err: error.message, order: order.id }, "order insert failed");
  }

  async recordFill(fill: Fill): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.from("fills").insert({
      order_id: fill.orderId,
      ts: new Date(fill.ts).toISOString(),
      price: fill.price,
      qty: fill.qty,
      liquidity: fill.liquidity ?? null,
      fee: fill.fee,
    });
    if (error) this.deps.logger.error({ err: error.message }, "fill insert failed");
  }

  recordPnl(equity: number, realized: number, unrealized: number, drawdownPct: number): void {
    if (!this.client) return;
    this.batch.pnl.push({
      ts: new Date().toISOString(),
      equity,
      realized,
      unrealized,
      drawdown_pct: drawdownPct,
    });
  }

  async log(level: string, component: string, message: string, payload?: Record<string, unknown>): Promise<void> {
    if (!this.client) return;
    await this.client.from("system_logs").insert({
      level, component, message, payload: payload ?? null,
    });
  }

  /**
   * Worker → DB risk-state writes. Only fields the worker owns; the dashboard
   * controls kill_switch_active / autonomous_execution / preset and we don't
   * want to overwrite those out from under it.
   */
  async persistDailyRisk(opts: {
    dailyLossDollars: number;
    dailyStartEquity: number;
    dayAnchorUtc: string;
  }): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client
      .from("risk_state")
      .update({
        daily_loss_dollars: opts.dailyLossDollars,
        daily_start_equity: opts.dailyStartEquity,
        day_anchor_utc: opts.dayAnchorUtc,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) this.deps.logger.error({ err: error.message }, "risk_state persist failed");
  }

  /** Worker can engage the kill switch when lifetime/daily limits trip. */
  async engageKillSwitch(reason: string): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client
      .from("risk_state")
      .update({
        kill_switch_active: true,
        autonomous_execution: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (!error) {
      await this.log("error", "risk", `kill switch engaged: ${reason}`);
    } else {
      this.deps.logger.error({ err: error.message }, "kill switch persist failed");
    }
  }

  private async flush(): Promise<void> {
    if (!this.client) return;
    const { signals, pnl } = this.batch;
    this.batch = { signals: [], pnl: [] };
    if (signals.length) {
      const { error } = await this.client.from("strategy_signals").insert(signals);
      if (error) this.deps.logger.error({ err: error.message, n: signals.length }, "batch signals insert failed");
    }
    if (pnl.length) {
      const { error } = await this.client.from("pnl_snapshots").insert(pnl);
      if (error) this.deps.logger.error({ err: error.message, n: pnl.length }, "batch pnl insert failed");
    }
  }

  private async pollRiskState(): Promise<void> {
    if (!this.client) return;
    const { data, error } = await this.client.from("risk_state").select("*").eq("id", 1).single();
    if (error || !data) return;
    this.deps.applyRiskState({
      killSwitchActive: !!data.kill_switch_active,
      autonomousExecution: !!data.autonomous_execution,
      dayStartEquity: Number(data.daily_start_equity),
      dailyLossDollars: Number(data.daily_loss_dollars),
      dayAnchorUtc: data.day_anchor_utc,
    });
  }
}
