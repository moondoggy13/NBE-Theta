"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { ScoreSparkline } from "./ScoreSparkline";

interface StrategySignal {
  id: string;
  ts: string;
  strategy_id: string;
  side: string;
  score: number;
  confidence: number;
  features: Record<string, number> | null;
  entry_hint: { price: number; stop: number; target: number } | null;
}

export function StrategyDetailModal({
  strategyId,
  signals,
  onClose,
}: {
  strategyId: string;
  signals: StrategySignal[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = signals.filter((s) => s.strategy_id === strategyId);
  const latest = filtered[0];
  const sparkData = [...filtered].reverse().map((s) => ({
    ts: new Date(s.ts).getTime(),
    score: s.score,
  }));

  const sideCount: Record<string, number> = {};
  for (const s of filtered) sideCount[s.side] = (sideCount[s.side] ?? 0) + 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl border border-white/60 bg-white/90 backdrop-blur-2xl shadow-2xl custom-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-slate-100 text-slate-500"
          aria-label="close"
        >
          <X size={16} />
        </button>

        <div className="p-6 border-b border-slate-200">
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Strategy</div>
          <h2 className="text-2xl font-semibold text-slate-800 mt-1">{strategyId}</h2>
          <div className="text-xs text-slate-500 mt-1">
            {filtered.length} recent signals · {Object.entries(sideCount).map(([k, v]) => `${k} ${v}`).join(" · ")}
          </div>
        </div>

        <div className="p-6 space-y-6">
          <section>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Score timeline</div>
            <div className="h-24 rounded-xl bg-slate-50 px-2 py-2 border border-slate-200">
              <ScoreSparkline data={sparkData} height={80} />
            </div>
          </section>

          {latest && (
            <section>
              <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">
                Latest signal · {new Date(latest.ts).toLocaleTimeString()}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Stat label="side" value={latest.side.toUpperCase()} accent={
                  latest.side === "long" ? "text-emerald-600" : latest.side === "short" ? "text-rose-600" : "text-slate-500"
                } />
                <Stat label="score" value={latest.score.toFixed(3)} />
                <Stat label="conf" value={`${(latest.confidence * 100).toFixed(0)}%`} />
              </div>
              {latest.entry_hint && (
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <Stat label="entry" value={`$${latest.entry_hint.price.toFixed(2)}`} />
                  <Stat label="stop"  value={`$${latest.entry_hint.stop.toFixed(2)}`} />
                  <Stat label="target" value={`$${latest.entry_hint.target.toFixed(2)}`} />
                </div>
              )}
              {latest.features && Object.keys(latest.features).length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1">Features</div>
                  <div className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(latest.features).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-slate-500">{k}</span>
                        <span className="text-slate-800 tabular-nums">
                          {typeof v === "number" ? v.toFixed(4) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          <section>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Recent decisions</div>
            <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-1">
              {filtered.slice(0, 30).map((s) => (
                <div key={s.id} className="flex justify-between items-center text-[11px] font-mono px-3 py-1.5 rounded bg-slate-50 border border-slate-100">
                  <span className="text-slate-500">{new Date(s.ts).toLocaleTimeString()}</span>
                  <span className={
                    s.side === "long"  ? "text-emerald-600" :
                    s.side === "short" ? "text-rose-600" :
                    "text-slate-500"
                  }>{s.side}</span>
                  <span className="text-slate-700 tabular-nums">score {s.score.toFixed(3)}</span>
                  <span className="text-slate-500 tabular-nums">conf {(s.confidence * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent = "text-slate-800" }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${accent}`}>{value}</div>
    </div>
  );
}
