"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";

interface RiskStateRow {
  id: number;
  kill_switch_active: boolean;
  autonomous_execution: boolean;
  preset: string;
  execution_provider?: ExecutionProvider;
}

type ExecutionProvider = "coinbase" | "computer-use" | "mock";

const PRESETS = ["Conservative", "Moderate", "Aggressive"] as const;
const PROVIDERS: { value: ExecutionProvider; label: string; subtitle: string }[] = [
  { value: "coinbase", label: "Coinbase API", subtitle: "Direct REST. Crypto only." },
  { value: "computer-use", label: "Computer-Use (Webull)", subtitle: "Local agent drives Webull desktop. Stocks + crypto." },
  { value: "mock", label: "Mock / paper", subtitle: "In-process fills. No real money." },
];

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
  async function setProvider(provider: ExecutionProvider) {
    await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_provider: provider }),
    });
  }

  const liveEnv = process.env.NEXT_PUBLIC_COINBASE_LIVE === "true";
  const provider: ExecutionProvider = r?.execution_provider ?? "coinbase";
  const hostHealth = useAgentHostHealth(provider === "computer-use");

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

        <div className="p-5 border border-white/60 rounded-2xl bg-white/50 shadow-sm">
          <div className="font-bold text-slate-800 mb-3">Execution Venue</div>
          <div className="grid grid-cols-1 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.value}
                onClick={() => setProvider(p.value)}
                className={`text-left px-4 py-3 rounded-xl border transition ${
                  provider === p.value
                    ? "bg-fuchsia-500 text-white border-fuchsia-400"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
              >
                <div className="text-sm font-mono font-bold">{p.label}</div>
                <div className={`text-xs font-mono mt-1 ${provider === p.value ? "text-white/80" : "text-slate-500"}`}>
                  {p.subtitle}
                </div>
              </button>
            ))}
          </div>
          {provider === "computer-use" && (
            <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs font-mono text-amber-900">
              <div className="font-bold uppercase tracking-widest text-[10px] mb-1">Heads up</div>
              The agent will move your mouse and click on the Webull desktop window.
              Keep the trading PC unattended only if dry-run is off, the notional
              cap is set, and you trust the kill switch.
              <div className="mt-2">
                Agent-host:{" "}
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] uppercase ${
                    hostHealth.ok ? "bg-emerald-100 text-emerald-700 border border-emerald-300" : "bg-rose-100 text-rose-700 border border-rose-300"
                  }`}
                >
                  {hostHealth.ok ? `online · ${hostHealth.driver ?? "?"} · ${hostHealth.dryRun ? "dry-run" : "LIVE"}` : "offline"}
                </span>
              </div>
            </div>
          )}
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

interface HostHealth {
  ok: boolean;
  driver?: string;
  dryRun?: boolean;
}

function useAgentHostHealth(enabled: boolean): HostHealth {
  const [health, setHealth] = useState<HostHealth>({ ok: false });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch("/api/agent-host/health", { cache: "no-store" });
        const j = (await r.json()) as HostHealth;
        if (!cancelled) setHealth(j);
      } catch {
        if (!cancelled) setHealth({ ok: false });
      }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      setHealth({ ok: false });
    };
  }, [enabled]);
  return health;
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
