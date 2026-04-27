"use client";

import { TrendingUp, Zap } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { EquityChart } from "../EquityChart";
import { useRealtime } from "@/hooks/use-realtime";
import { usePollJson } from "@/hooks/use-poll-json";
import { formatCurrency, formatPercent } from "@/lib/formatters";

interface PnlSnapshot {
  id: number;
  ts: string;
  equity: number;
  drawdown_pct: number;
  unrealized: number;
  realized: number;
}
interface Position {
  symbol: string;
  qty: number;
  avg_entry: number;
  unrealized_pnl: number;
  updated_at: string;
}
interface StrategySignal {
  id: string;
  ts: string;
  strategy_id: string;
  side: "long" | "short" | "flat";
  score: number;
  confidence: number;
}
interface PriceResp {
  price: number | null;
  tickRate: number | null;
  stats: { changePct: number } | null;
}

export function OverviewTab() {
  const { rows: pnl } = useRealtime<PnlSnapshot>({
    table: "pnl_snapshots",
    initialFetch: { order: { column: "ts" }, limit: 1 },
  });
  const { rows: positions } = useRealtime<Position>({
    table: "positions",
    initialFetch: { order: { column: "updated_at" }, limit: 5 },
  });
  const { rows: signals } = useRealtime<StrategySignal>({
    table: "strategy_signals",
    initialFetch: { order: { column: "ts" }, limit: 30 },
  });
  const { data: priceResp } = usePollJson<PriceResp>("/api/price", 2000);

  const latest = pnl[0];
  const btc = positions.find((p) => p.symbol === "BTC-USD");
  const ensembleLatest = signals.find((s) => s.strategy_id === "ensemble");
  const strategyIds = Array.from(new Set(signals.map((s) => s.strategy_id))).filter(
    (id) => id !== "ensemble",
  );
  const signalsLastMin = signals.filter(
    (s) => Date.now() - new Date(s.ts).getTime() < 60_000,
  ).length;

  // P&L since launch: anchor at the lifetime baseline ($25k). Avoids the
  // misleading "+113% since the wipe pivot" effect that would happen if we
  // anchored at the first snapshot in our rolling window.
  const LAUNCH_EQUITY = 25_000;
  const equityNow = latest?.equity ?? LAUNCH_EQUITY;
  const sinceLaunchPnl = equityNow - LAUNCH_EQUITY;
  const sinceLaunchPct = LAUNCH_EQUITY > 0 ? (sinceLaunchPnl / LAUNCH_EQUITY) * 100 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
      {/* Left column: stats + active vector */}
      <div className="lg:col-span-3 flex flex-col gap-6">
        <GlassPanel title="Equity" className="bg-white/50">
          <div
            className={`text-4xl font-light tracking-tighter mt-2 ${
              sinceLaunchPnl >= 0 ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            {formatCurrency(equityNow)}
          </div>
          <div className="flex items-center gap-2 mt-4 text-xs font-medium flex-wrap">
            <span
              className={`flex items-center gap-1 px-2 py-1 rounded-full border ${
                sinceLaunchPnl >= 0
                  ? "text-emerald-500 bg-emerald-50 border-emerald-100"
                  : "text-rose-500 bg-rose-50 border-rose-100"
              }`}
            >
              <TrendingUp size={12} />
              {sinceLaunchPnl >= 0 ? "+" : ""}{formatCurrency(sinceLaunchPnl)} since launch
            </span>
            <span className="text-slate-500 font-mono text-[10px]">
              {sinceLaunchPct >= 0 ? "+" : ""}{sinceLaunchPct.toFixed(2)}% from {formatCurrency(LAUNCH_EQUITY)}
            </span>
          </div>
        </GlassPanel>

        <GlassPanel title="Active Vector — BTC/USD" className="flex-1 relative overflow-hidden" withCorners>
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(90deg, transparent 0%, transparent 40%, rgba(255,255,255,0.8) 50%, transparent 60%, transparent 100%)",
              backgroundSize: "40px 100%",
            }}
          />
          <div className="space-y-4 mt-2 relative z-10">
            <div className="flex justify-between items-baseline">
              <div>
                <div className="text-2xl font-semibold text-slate-800 tabular-nums">
                  {priceResp?.price != null ? formatCurrency(priceResp.price) : "—"}
                </div>
                {priceResp?.stats && (
                  <div
                    className={`text-xs font-mono ${
                      priceResp.stats.changePct >= 0 ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {priceResp.stats.changePct >= 0 ? "+" : ""}
                    {priceResp.stats.changePct.toFixed(2)}% 24h
                  </div>
                )}
              </div>
              <div
                className={`text-[10px] font-mono uppercase tracking-widest ${
                  btc && btc.qty !== 0
                    ? btc.qty > 0 ? "text-emerald-600" : "text-rose-600"
                    : ensembleLatest?.side === "long"  ? "text-emerald-500" :
                      ensembleLatest?.side === "short" ? "text-rose-500"    :
                      "text-slate-500"
                }`}
              >
                {btc && btc.qty !== 0
                  ? `${btc.qty > 0 ? "LONG" : "SHORT"} ${Math.abs(btc.qty).toFixed(6)}`
                  : ensembleLatest
                    ? `WATCH · ${ensembleLatest.side.toUpperCase()}`
                    : "WATCH · IDLE"}
              </div>
            </div>

            {ensembleLatest && (
              <div>
                <div className="flex justify-between text-[10px] font-mono mb-1 text-slate-500 uppercase">
                  <span>Ensemble bias</span>
                  <span>conf {(ensembleLatest.confidence * 100).toFixed(0)}%</span>
                </div>
                <div className="h-3 w-full bg-white/40 rounded-full overflow-hidden border border-white/80 p-0.5 shadow-inner relative">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-300" />
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      ensembleLatest.score >= 0 ? "bg-emerald-400" : "bg-rose-400"
                    }`}
                    style={{
                      width: `${Math.min(50, Math.abs(ensembleLatest.score) * 50)}%`,
                      marginLeft: ensembleLatest.score >= 0 ? "50%" : `${50 - Math.min(50, Math.abs(ensembleLatest.score) * 50)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* Center column: equity chart */}
      <GlassPanel
        className="lg:col-span-6 relative flex flex-col bg-slate-900/5 border-slate-800/10 min-h-[600px]"
        withCorners
      >
        <CornerTicks />
        <div className="absolute top-6 left-1/2 -translate-x-1/2 text-[10px] font-mono text-slate-400 uppercase tracking-[0.3em]">
          Equity Curve
        </div>
        <div className="flex-1 mt-12 mb-4 px-4">
          <EquityChart height={420} referenceEquity={LAUNCH_EQUITY} />
        </div>
        <div className="absolute bottom-6 left-0 right-0 flex justify-around">
          <Stat label="confidence" value={ensembleLatest ? `${(ensembleLatest.confidence * 100).toFixed(0)}%` : "—"} />
          <Sep />
          <Stat label="strategies" value={String(strategyIds.length)} />
          <Sep />
          <Stat label="signals/min" value={String(signalsLastMin)} />
          <Sep />
          <Stat label="ticks/min" value={priceResp?.tickRate?.toString() ?? "—"} />
        </div>
      </GlassPanel>

      {/* Right column: status + recent signals */}
      <div className="lg:col-span-3 flex flex-col gap-6">
        <GlassPanel title="System Status" className="bg-white/60">
          <div className="space-y-4">
            <div className="w-full h-8 hud-barcode opacity-70 rounded-sm mb-6" />
            <Status
              label="BTC Feed"
              value={priceResp?.tickRate != null && priceResp.tickRate > 0 ? `${priceResp.tickRate}/min` : "idle"}
              state={priceResp?.tickRate != null && priceResp.tickRate > 0 ? "ok" : "warn"}
            />
            <Status
              label="Strategies"
              value={strategyIds.length ? `${strategyIds.length} firing` : "idle"}
              state={strategyIds.length ? "ok" : "warn"}
            />
            <Status
              label="Risk Limiter"
              value={latest?.drawdown_pct ? `DD ${latest.drawdown_pct.toFixed(2)}%` : "ARMED"}
              state={(latest?.drawdown_pct ?? 0) > 5 ? "err" : "warn"}
            />
          </div>
        </GlassPanel>

        <GlassPanel title="Recent Signals" className="flex-1 overflow-hidden" withCorners>
          <div className="space-y-2 mt-2 max-h-[380px] overflow-y-auto custom-scrollbar pr-1">
            {signals.length === 0 ? (
              <EmptySignals />
            ) : (
              signals.slice(0, 30).map((sig) => <SignalRow key={sig.id} sig={sig} />)
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}

function SignalRow({ sig }: { sig: StrategySignal }) {
  const sideColor = sig.side === "long"
    ? "text-emerald-600 bg-emerald-50"
    : sig.side === "short" ? "text-rose-600 bg-rose-50"
    : "text-slate-600 bg-slate-100";
  return (
    <div className="p-2.5 rounded-xl bg-white/40 border border-white hover:bg-white/60 transition-colors flex items-start gap-3">
      <div className="w-6 h-6 rounded bg-fuchsia-100 flex items-center justify-center text-fuchsia-600 flex-shrink-0 mt-0.5">
        <Zap size={12} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline">
          <span className="text-xs font-bold text-slate-700 truncate">{sig.strategy_id}</span>
          <span className={`text-[9px] font-mono uppercase px-1.5 rounded ${sideColor}`}>{sig.side}</span>
        </div>
        <div className="text-[10px] text-slate-500 font-mono mt-0.5 flex justify-between">
          <span>score {sig.score.toFixed(3)}</span>
          <span>conf {(sig.confidence * 100).toFixed(0)}%</span>
          <span>{new Date(sig.ts).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}

function EmptySignals() {
  return (
    <div className="text-center py-8 space-y-2">
      <div className="text-xs font-mono text-slate-500">Signal stream warming up…</div>
      <div className="text-[10px] text-slate-400 font-mono">
        Strategies need ~25 1-min candles before emitting their first decision.
      </div>
    </div>
  );
}

function CornerTicks() {
  return (
    <>
      <div className="absolute top-6 left-6 w-8 h-8 border-t border-l border-slate-300" />
      <div className="absolute top-6 right-6 w-8 h-8 border-t border-r border-slate-300" />
      <div className="absolute bottom-6 left-6 w-8 h-8 border-b border-l border-slate-300" />
      <div className="absolute bottom-6 right-6 w-8 h-8 border-b border-r border-slate-300" />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] font-mono text-slate-500 mb-1 uppercase tracking-widest">{label}</div>
      <div className="font-mono text-sm text-slate-700 tabular-nums">{value}</div>
    </div>
  );
}

function Sep() {
  return <div className="w-[1px] h-8 bg-slate-300" />;
}

function Status({ label, value, state }: { label: string; value: string; state: "ok" | "warn" | "err" }) {
  const color = state === "ok" ? "text-emerald-600" : state === "warn" ? "text-amber-600" : "text-rose-600";
  const dot   = state === "ok" ? "bg-emerald-500"   : state === "warn" ? "bg-amber-500"   : "bg-rose-500";
  return (
    <div className="flex justify-between items-end border-b border-slate-200 pb-2">
      <span className="text-[10px] font-mono text-slate-500">{label.toUpperCase()}</span>
      <span className={`text-xs font-mono ${color} font-bold flex items-center gap-2`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot} animate-pulse`} /> {value}
      </span>
    </div>
  );
}

// expose for OverviewTab consumers — kept here intentionally; no other file
// needs to know about our internal helpers
export { formatCurrency, formatPercent };
