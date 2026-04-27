"use client";

import { useRealtime } from "@/hooks/use-realtime";

interface RegimeRow {
  id: number;
  ts: string;
  symbol: string;
  p_bull: number;
  p_range: number;
  p_bear: number;
  dominant_state: "bull" | "range" | "bear";
  realized_vol: number | null;
}

const REGIME_COLOR: Record<RegimeRow["dominant_state"], string> = {
  bull: "bg-emerald-500",
  range: "bg-slate-400",
  bear: "bg-rose-500",
};
const REGIME_GLOW: Record<RegimeRow["dominant_state"], string> = {
  bull: "shadow-[0_0_20px_rgba(16,185,129,0.6)]",
  range: "shadow-[0_0_20px_rgba(148,163,184,0.6)]",
  bear: "shadow-[0_0_20px_rgba(244,63,94,0.6)]",
};

export function RegimeGauge() {
  const { rows } = useRealtime<RegimeRow>({
    table: "regime_posteriors",
    initialFetch: { order: { column: "ts" }, limit: 1 },
  });
  const latest = rows[0];

  if (!latest) {
    return (
      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
          HMM Regime Posterior
        </div>
        <div className="h-12 rounded-lg bg-slate-100 flex items-center justify-center text-[11px] font-mono text-slate-400">
          waiting for first candle close...
        </div>
      </div>
    );
  }

  const probs = [
    { id: "bull" as const,  pct: Number(latest.p_bull) * 100,  color: "bg-emerald-500", label: "BULL" },
    { id: "range" as const, pct: Number(latest.p_range) * 100, color: "bg-slate-400",  label: "RANGE" },
    { id: "bear" as const,  pct: Number(latest.p_bear) * 100,  color: "bg-rose-500",   label: "BEAR" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
          HMM Regime Posterior
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${REGIME_COLOR[latest.dominant_state]} ${REGIME_GLOW[latest.dominant_state]}`}
          />
          <span className="text-[11px] font-mono uppercase tracking-widest text-slate-700">
            {latest.dominant_state}
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {probs.map((p) => (
          <div key={p.id} className="flex items-center gap-3">
            <span className="w-12 text-[10px] font-mono uppercase tracking-widest text-slate-500">
              {p.label}
            </span>
            <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
              <div
                className={`h-full ${p.color} transition-all duration-700 ease-out`}
                style={{ width: `${p.pct.toFixed(1)}%` }}
              />
            </div>
            <span className="w-12 text-right text-[11px] font-mono tabular-nums text-slate-700">
              {p.pct.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      {latest.realized_vol != null && (
        <div className="flex justify-between text-[10px] font-mono text-slate-500 pt-1 border-t border-slate-100">
          <span>realized σ</span>
          <span className="tabular-nums">{(Number(latest.realized_vol) * 100).toFixed(1)}% ann</span>
        </div>
      )}
    </div>
  );
}
