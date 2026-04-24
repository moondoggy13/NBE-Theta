"use client";

import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";

interface RiskStateRow {
  id: number;
  kill_switch_active: boolean;
  autonomous_execution: boolean;
  preset: string;
}

const PRESETS = ["Conservative", "Moderate", "Aggressive"] as const;

export function SettingsTab() {
  const { rows: risk } = useRealtime<RiskStateRow>({
    table: "risk_state",
    initialFetch: { order: { column: "updated_at" }, limit: 1 },
  });
  const r = risk[0];

  async function setPreset(preset: string) {
    await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset }),
    });
  }
  async function toggleAutonomous(next: boolean) {
    await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autonomous_execution: next }),
    });
  }

  const liveEnv = process.env.NEXT_PUBLIC_COINBASE_LIVE === "true";

  return (
    <GlassPanel title="System Configuration" className="h-full bg-white/40" withCorners>
      <div className="max-w-2xl mx-auto mt-8 space-y-6">
        <Toggle
          title="Autonomous Execution"
          subtitle="Allow Δ Core to place orders without manual confirmation."
          on={!!r?.autonomous_execution}
          onChange={toggleAutonomous}
        />

        <div className="p-5 border border-white/60 rounded-2xl bg-white/50 shadow-sm">
          <div className="font-bold text-slate-800 mb-3">Risk Preset</div>
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={`flex-1 px-3 py-2 rounded-full text-xs font-mono border transition ${
                  r?.preset === p
                    ? "bg-fuchsia-500 text-white border-fuchsia-400"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-3">
            Aggressive default: $25k start, 2% per trade, 10% daily kill switch.
          </div>
        </div>

        <div className="p-5 border border-white/60 rounded-2xl bg-white/50 shadow-sm opacity-90">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-bold text-slate-800">Live Coinbase Orders</div>
              <div className="text-xs text-slate-500 font-mono mt-1">
                Controlled by env:{" "}
                <code className="px-1 rounded bg-slate-100">COINBASE_LIVE=true &amp; CONFIRM_LIVE=YES</code>
              </div>
            </div>
            <div
              className={`px-3 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-widest ${
                liveEnv ? "bg-rose-100 text-rose-700 border border-rose-300" : "bg-emerald-100 text-emerald-700 border border-emerald-300"
              }`}
            >
              {liveEnv ? "LIVE CONFIGURED" : "PAPER"}
            </div>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}

function Toggle({
  title,
  subtitle,
  on,
  onChange,
}: {
  title: string;
  subtitle: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-5 border border-white/60 rounded-2xl bg-white/50 shadow-sm hover:shadow-md transition-shadow">
      <div>
        <div className="font-bold text-slate-800">{title}</div>
        <div className="text-xs text-slate-500 font-mono mt-1">{subtitle}</div>
      </div>
      <button
        onClick={() => onChange(!on)}
        className={`w-12 h-6 rounded-full relative cursor-pointer transition ${
          on ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)_inset]" : "bg-slate-300 shadow-inner"
        }`}
      >
        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${on ? "right-1" : "left-1"}`} />
      </button>
    </div>
  );
}
