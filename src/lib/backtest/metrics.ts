/**
 * Backtest performance metrics.
 *
 * Bar returns are arithmetic: (equity[i] - equity[i-1]) / equity[i-1].
 * Annualization assumes 24/7 crypto markets: 525 600 minutes / year
 * (365 * 1440). `barMinutes` scales the multiplier appropriately.
 */

export interface TradeRecord {
  entryTs: number;
  exitTs: number;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  reason: "signal" | "stop" | "target" | "eod";
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface Metrics {
  totalReturnPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  hitRate: number;
  trades: number;
  avgTradePnl: number;
  turnover: number;
  finalEquity: number;
  startEquity: number;
}

const MIN_PER_YEAR = 365 * 24 * 60; // 525 600

export function computeMetrics(
  equity: EquityPoint[],
  trades: TradeRecord[],
  startEquity: number,
  barMinutes = 1,
): Metrics {
  if (equity.length < 2) {
    return {
      totalReturnPct: 0,
      sharpe: 0,
      sortino: 0,
      maxDrawdownPct: 0,
      hitRate: 0,
      trades: 0,
      avgTradePnl: 0,
      turnover: 0,
      finalEquity: startEquity,
      startEquity,
    };
  }

  const finalEquity = equity[equity.length - 1].equity;
  const totalReturnPct = ((finalEquity - startEquity) / startEquity) * 100;

  // Bar-level returns
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity;
    const cur = equity[i].equity;
    if (prev > 0) returns.push((cur - prev) / prev);
  }
  const meanR = mean(returns);
  const sdR = stddev(returns, meanR);
  const downside = Math.sqrt(
    returns.reduce((s, r) => s + (r < 0 ? r * r : 0), 0) / Math.max(returns.length, 1),
  );
  const annualizer = Math.sqrt(MIN_PER_YEAR / barMinutes);
  const sharpe = sdR === 0 ? 0 : (meanR / sdR) * annualizer;
  const sortino = downside === 0 ? 0 : (meanR / downside) * annualizer;

  // Max drawdown
  let peak = equity[0].equity;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const hitRate = trades.length ? wins / trades.length : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgTradePnl = trades.length ? totalPnl / trades.length : 0;
  const turnover =
    trades.reduce((s, t) => s + Math.abs(t.qty * t.entryPrice), 0) / Math.max(startEquity, 1);

  return {
    totalReturnPct,
    sharpe,
    sortino,
    maxDrawdownPct: maxDd * 100,
    hitRate,
    trades: trades.length,
    avgTradePnl,
    turnover,
    finalEquity,
    startEquity,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stddev(xs: number[], m: number): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / xs.length);
}
