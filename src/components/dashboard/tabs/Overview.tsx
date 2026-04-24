"use client";

import { TrendingUp, Zap } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";
import { formatCurrency, formatPercent } from "@/lib/formatters";

interface PnlSnapshot { id: number; ts: string; equity: number; drawdown_pct: number; unrealized: number; realized: number }
interface Position { symbol: string; qty: number; avg_entry: number; unrealized_pnl: number; updated_at: string }
interface StrategySignal { id: string; ts: string; strategy_id: string; side: string; score: number; confidence: number }

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
    initialFetch: { order: { column: "ts" }, limit: 8 },
  });

  const latest = pnl[0];
  const btc = positions.find((p) => p.symbol === "BTC-USD");
  const dayPnl = latest ? latest.equity - latest.equity / (1 + (-latest.drawdown_pct / 100 || 0.0001)) : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
      {/* Left column: stats + active vector */}
      <div className="lg:col-span-3 flex flex-col gap-6">
        <GlassPanel title="Net P&L" className="bg-white/50">
          <div className="text-4xl font-light tracking-tighter text-emerald-600 mt-2">
            {latest ? formatCurrency(latest.equity) : "— "}
          </div>
          {latest ? (
            <div className="flex items-center gap-2 mt-4 text-xs font-medium text-emerald-500 bg-emerald-50 w-fit px-2 py-1 rounded-full border border-emerald-100">
              <TrendingUp size={12} /> {formatPercent(dayPnl / latest.equity * 100)} 24h
            </div>
          ) : (
            <div className="text-xs text-slate-400 mt-4 font-mono">No P&L snapshot yet — worker idle.</div>
          )}
        </GlassPanel>

        <GlassPanel title="Active Vectors" className="flex-1 relative overflow-hidden" withCorners>
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(90deg, transparent 0%, transparent 40%, rgba(255,255,255,0.8) 50%, transparent 60%, transparent 100%)",
              backgroundSize: "40px 100%",
            }}
          />
          <div className="space-y-4 mt-2 relative z-10">
            {btc ? (
              <VectorBar pair="BTC/USD" val={btc.qty > 0 ? "Long" : btc.qty < 0 ? "Short" : "Flat"} power={85} color="bg-cyan-400" />
            ) : (
              <div className="text-xs text-slate-500 font-mono py-6 text-center">No open position on BTC-USD.</div>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* Center column: core gauge */}
      <GlassPanel
        className="lg:col-span-6 relative flex flex-col items-center justify-center bg-slate-900/5 border-slate-800/10 min-h-[480px]"
        withCorners
      >
        <CornerTicks />
        <div className="absolute top-6 text-[10px] font-mono text-slate-400 uppercase tracking-[0.3em]">
          Algorithmic Resonance
        </div>
        <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center mt-8">
          <div className="absolute inset-0 rounded-full border-[8px] border-slate-800/80 shadow-2xl" />
          <div className="absolute inset-2 rounded-full bg-gradient-to-br from-fuchsia-500 via-rose-500 to-pink-600 blur-sm opacity-90 animate-pulse" />
          <div className="absolute inset-4 rounded-full bg-gradient-to-tr from-pink-400 to-yellow-300 mix-blend-overlay blur-md animate-spin-slow" style={{ animationDuration: "20s" }} />
          <div className="relative z-10 w-32 h-48 bg-white/20 backdrop-blur-md rounded-[2rem] border border-white/50 flex flex-col items-center justify-center shadow-inner">
            <span className="text-3xl font-light text-white drop-shadow-md">
              {signals.length ? (signals[0].confidence * 100).toFixed(1) : "—"}
              <span className="text-lg text-white/60">%</span>
            </span>
            <span className="text-[9px] font-mono tracking-widest text-white/80 uppercase mt-2">Confidence</span>
          </div>
        </div>
        <div className="absolute bottom-8 flex gap-8">
          <Stat label="Strategies" value={new Set(signals.map((s) => s.strategy_id)).size.toString()} />
          <div className="w-[1px] h-8 bg-slate-300" />
          <Stat label="Signals / min" value={signals.length.toString()} />
        </div>
      </GlassPanel>

      {/* Right column: status + recent signals */}
      <div className="lg:col-span-3 flex flex-col gap-6">
        <GlassPanel title="System Status" className="bg-white/60">
          <div className="space-y-4">
            <div className="w-full h-8 hud-barcode opacity-70 rounded-sm mb-6" />
            <Status label="BTC Feed" value={positions.length >= 0 ? "ONLINE" : "OFFLINE"} state={positions.length >= 0 ? "ok" : "err"} />
            <Status label="Strategies" value={signals.length ? `${new Set(signals.map((s) => s.strategy_id)).size} active` : "idle"} state="ok" />
            <Status label="Risk Limiter" value="ARMED" state="warn" />
          </div>
        </GlassPanel>

        <GlassPanel title="Recent Signals" className="flex-1 overflow-hidden" withCorners>
          <div className="space-y-3 mt-2 max-h-[320px] overflow-y-auto custom-scrollbar">
            {signals.length === 0 ? (
              <div className="text-xs text-slate-500 font-mono py-6 text-center">Waiting for signals…</div>
            ) : (
              signals.map((sig) => (
                <div
                  key={sig.id}
                  className="p-3 rounded-xl bg-white/40 border border-white hover:bg-white/60 transition-colors cursor-pointer flex items-start gap-3"
                >
                  <div className="w-6 h-6 rounded bg-fuchsia-100 flex items-center justify-center text-fuchsia-600 flex-shrink-0 mt-0.5">
                    <Zap size={12} />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-700">
                      {sig.strategy_id} · {sig.side.toUpperCase()}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-1">
                      score {sig.score.toFixed(2)} · conf {(sig.confidence * 100).toFixed(0)}%
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}

function VectorBar({ pair, val, power, color }: { pair: string; val: string; power: number; color: string }) {
  return (
    <div className="group">
      <div className="flex justify-between text-xs font-mono mb-1">
        <span className="text-slate-700 font-bold">{pair}</span>
        <span className="text-slate-500">{val}</span>
      </div>
      <div className="h-8 w-full bg-white/40 rounded-full overflow-hidden border border-white/80 p-0.5 shadow-inner">
        <div
          className={`h-full rounded-full ${color} shadow-[0_0_15px_rgba(255,255,255,0.5)_inset] transition-all duration-1000 ease-out`}
          style={{ width: `${power}%` }}
        />
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
      <div className="font-mono text-sm text-slate-700">{value}</div>
    </div>
  );
}

function Status({ label, value, state }: { label: string; value: string; state: "ok" | "warn" | "err" }) {
  const color = state === "ok" ? "text-emerald-600" : state === "warn" ? "text-amber-600" : "text-rose-600";
  const dot = state === "ok" ? "bg-emerald-500" : state === "warn" ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex justify-between items-end border-b border-slate-200 pb-2">
      <span className="text-[10px] font-mono text-slate-500">{label.toUpperCase()}</span>
      <span className={`text-xs font-mono ${color} font-bold flex items-center gap-2`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot} animate-pulse`} /> {value}
      </span>
    </div>
  );
}
