import { supabase } from "../client";
import type { RiskMetrics } from "@/types/risk";
import { STRATEGY } from "@/lib/constants";

export async function getRiskMetrics(): Promise<RiskMetrics | null> {
  if (!supabase) return null;

  const [portfolioRes, positionsRes] = await Promise.all([
    supabase
      .from("portfolio_state")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single(),
    supabase.from("positions").select("*").eq("status", "active"),
  ]);

  const portfolio = portfolioRes.data;
  const positions = positionsRes.data ?? [];

  if (!portfolio) return null;

  const totalValue = Number(portfolio.total_value);

  return {
    dailyPnlPercent: Number(portfolio.day_pnl_percent),
    killSwitchThreshold: STRATEGY.DAILY_LOSS_KILL_SWITCH_PCT,
    killSwitchTriggered: portfolio.kill_switch_active,
    totalExposurePercent: totalValue > 0
      ? positions.reduce((sum, p) => sum + Number(p.shares) * Number(p.current_price), 0) / totalValue * 100
      : 0,
    maxDrawdownPercent: Number(portfolio.day_pnl_percent), // simplified for Phase 1
    positionCount: positions.length,
    maxPositions: STRATEGY.MAX_POSITIONS_PHASE1,
    positions: positions.map((p) => {
      const currentPrice = Number(p.current_price);
      const stopLoss = Number(p.stop_loss);
      const positionValue = Number(p.shares) * currentPrice;
      return {
        ticker: p.ticker,
        exposurePercent: totalValue > 0 ? (positionValue / totalValue) * 100 : 0,
        maxExposure: STRATEGY.MAX_POSITION_SIZE_PCT,
        distanceToStopPercent: currentPrice > 0 ? ((currentPrice - stopLoss) / currentPrice) * 100 : 0,
        stopLossPercent: Number(p.entry_price) > 0
          ? ((Number(p.entry_price) - stopLoss) / Number(p.entry_price)) * 100
          : 6,
      };
    }),
  };
}
