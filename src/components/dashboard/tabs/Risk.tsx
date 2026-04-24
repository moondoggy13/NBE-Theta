"use client";

import { ShieldAlert } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";
import { formatCurrency, formatPercent } from "@/lib/formatters";

interface RiskStateRow {
  id: number;
  kill_switch_active: boolean;
  autonomous_execution: boolean;
  preset: string;
  daily_loss_dollars: number;
  daily_start_equity: number;
  day_anchor_utc: string;
  updated_at: string;
}

interface PnlSnap {
  equity: number;
  drawdown_pct: number;
  ts: string;
}

export function RiskTab() {
  const { rows: risk } = useRealtime<RiskStateRow>({
    table: "risk_state",
    initialFetch: { order: { column: "updated_at" }, limit: 1 },
  });
  const { rows: pnl } = useRealtime<PnlSnap>({
    table: "pnl_snapshots",
    initialFetch: { order: { column: "ts" }, limit: 1 },
  });

  const r = risk[0];
  const p = pnl[0];
  const level = r?.kill_switch_active
    ? "HALT"
    : p && r && p.equity < r.daily_start_equity * 0.95
    ? "LVL 4"
    : "LVL 2";

  async function toggleKillSwitch(next: boolean) {
    await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: next }),
    });
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
      <GlassPanel
        title="Global Risk Matrix"
        className="col-span-full md:col-span-1 relative overflow-hidden bg-[#0a0505] border-slate-800 min-h-[400px]"
        withCorners
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[150%] h-[150%] bg-[radial-gradient(ellipse_at_center,_#1e1b4b_0%,_#701a75_35%,_#be123c_65%,_#ea580c_100%)] opacity-80 blur-2xl" />
        </div>
        <div className="relative z-10 h-full flex flex-col items-center justify-center py-10">
          <div className="w-48 h-48 rounded-full border border-orange-500/30 flex items-center justify-center bg-black/40 backdrop-blur-md relative">
            <div className="absolute inset-0 rounded-full border-t-2 border-orange-400 animate-spin-slow" />
            <div className="text-center">
              <ShieldAlert
                size={36}
                className="text-orange-400 mx-auto mb-2 drop-shadow-[0_0_15px_rgba(234,88,12,0.8)]"
              />
              <div className="text-3xl font-light text-white tracking-tighter">{level}</div>
            </div>
          </div>

          <button
            onClick={() => toggleKillSwitch(!r?.kill_switch_active)}
            className={`mt-8 px-5 py-3 rounded-full text-xs font-mono font-bold uppercase tracking-widest border shadow-lg transition ${
              r?.kill_switch_active
                ? "bg-rose-600 text-white border-rose-400"
                : "bg-orange-950/50 text-orange-200 border-orange-500/40 hover:bg-orange-900"
            }`}
          >
            {r?.kill_switch_active ? "Kill switch ACTIVE · tap to release" : "Engage kill switch"}
          </button>
        </div>
      </GlassPanel>

      <GlassPanel title="Exposure & Daily Budget" className="col-span-full md:col-span-1 bg-white/40" withCorners>
        <div className="space-y-6 mt-4">
          <Bar
            label="Daily loss used"
            pct={r ? Math.max(0, Math.min(100, (r.daily_loss_dollars / (r.daily_start_equity * 0.10 || 1)) * 100)) : 0}
            subtitle={r ? `${formatCurrency(r.daily_loss_dollars)} of ${formatCurrency(r.daily_start_equity * 0.10)} cap` : "—"}
            color="bg-rose-500"
          />
          <Bar
            label="Drawdown"
            pct={p ? Math.min(100, p.drawdown_pct) : 0}
            subtitle={p ? formatPercent(p.drawdown_pct) : "—"}
            color="bg-orange-500"
          />
          <Bar label="Preset" pct={100} subtitle={r?.preset ?? "—"} color="bg-fuchsia-500" />
          <Bar
            label="Autonomous execution"
            pct={r?.autonomous_execution ? 100 : 0}
            subtitle={r?.autonomous_execution ? "ARMED" : "SAFE"}
            color="bg-emerald-500"
          />
        </div>
      </GlassPanel>
    </div>
  );
}

function Bar({ label, pct, subtitle, color }: { label: string; pct: number; subtitle: string; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs font-mono mb-2 text-slate-700 font-bold">
        <span>{label}</span>
        <span className="text-slate-500">{subtitle}</span>
      </div>
      <div className="h-3 w-full bg-slate-200/50 rounded-full overflow-hidden shadow-inner border border-white/50">
        <div
          className={`h-full rounded-full ${color} shadow-[0_0_10px_rgba(255,255,255,0.4)_inset] relative transition-all duration-1000 ease-out`}
          style={{ width: `${pct}%` }}
        >
          <div className="absolute top-0 left-0 right-0 h-1/2 bg-white/30 rounded-t-full pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
