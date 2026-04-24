"use client";

import { Zap } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";

interface StrategySignal {
  id: string;
  ts: string;
  strategy_id: string;
  side: string;
  score: number;
  confidence: number;
  features: Record<string, number> | null;
}

export function SignalEngineTab() {
  const { rows: signals, connected } = useRealtime<StrategySignal>({
    table: "strategy_signals",
    initialFetch: { order: { column: "ts" }, limit: 50 },
  });

  const byStrategy = signals.reduce<Record<string, StrategySignal[]>>((acc, s) => {
    (acc[s.strategy_id] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6 h-full">
      <GlassPanel
        title="Neural Engine Core"
        className="flex-1 relative overflow-hidden bg-[#050505] border-slate-800 min-h-[360px]"
        withCorners
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[120%] h-[120%] bg-[radial-gradient(ellipse_at_center,_#0284c7_0%,_#3730a3_35%,_#86198f_65%,_#000000_100%)] opacity-90 blur-2xl" />
          <div className="absolute w-[60%] h-[80%] bg-[radial-gradient(ellipse_at_center,_#38bdf8_0%,_transparent_60%)] opacity-50 blur-xl mix-blend-screen" />
        </div>
        <div className="absolute top-0 left-0 w-full h-1/4 bg-gradient-to-b from-transparent via-blue-400/20 to-transparent animate-scan pointer-events-none" />

        <div className="relative z-10 h-full flex flex-col items-center justify-center">
          <div className="relative w-64 h-96 rounded-[3rem] border border-white/10 bg-black/40 backdrop-blur-md flex flex-col items-center justify-center overflow-hidden shadow-[0_0_100px_rgba(56,189,248,0.2)]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(56,189,248,0.2)_0%,_transparent_70%)]" />
            <Zap className="text-blue-400 mb-6 drop-shadow-[0_0_15px_rgba(56,189,248,0.8)] animate-pulse" size={48} />
            <div className="text-white font-light text-5xl tracking-tighter">
              {signals.length ? (signals[0].confidence * 100).toFixed(1) : "—"}
              <span className="text-2xl text-blue-400/80">%</span>
            </div>
            <div className="font-mono text-[10px] text-blue-300 tracking-[0.4em] uppercase mt-4">Signal Clarity</div>
            <div className="absolute bottom-10 flex gap-2">
              {Object.keys(byStrategy).slice(0, 5).map((id, i) => (
                <div key={id} className="w-1 h-8 bg-blue-500/30 rounded-full overflow-hidden">
                  <div
                    className="w-full bg-blue-400 animate-pulse"
                    style={{
                      height: `${Math.min(100, byStrategy[id].length * 10)}%`,
                      animationDelay: `${i * 0.2}s`,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="absolute bottom-6 left-6 font-mono text-[10px] text-blue-400/60 uppercase tracking-widest space-y-1">
          <div>NODE: ΔCORE-1</div>
          <div>SYNC: {connected ? "TRUE" : "FALSE"}</div>
        </div>
        <div className="absolute bottom-6 right-6 font-mono text-[10px] text-blue-400/60 uppercase tracking-widest text-right space-y-1">
          <div>STRATEGIES: {Object.keys(byStrategy).length}</div>
          <div>TICKS/MIN: {signals.length}</div>
        </div>
      </GlassPanel>

      <GlassPanel title="Per-Strategy Stream" className="bg-white/40">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.entries(byStrategy).map(([id, list]) => (
            <div key={id} className="p-4 rounded-2xl bg-white/50 border border-white/60">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-bold text-slate-800">{id}</span>
                <span className="text-[10px] font-mono text-slate-500">{list.length} signals</span>
              </div>
              <div className="flex gap-1 h-8">
                {list.slice(0, 30).reverse().map((s) => (
                  <div
                    key={s.id}
                    className={`flex-1 rounded ${
                      s.side === "long" ? "bg-emerald-400" : s.side === "short" ? "bg-rose-400" : "bg-slate-300"
                    }`}
                    style={{ opacity: 0.3 + 0.7 * s.confidence }}
                    title={`${s.side} conf ${(s.confidence * 100).toFixed(0)}%`}
                  />
                ))}
              </div>
            </div>
          ))}
          {Object.keys(byStrategy).length === 0 && (
            <div className="col-span-full text-sm text-slate-500 font-mono text-center py-6">No strategy signals yet.</div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
