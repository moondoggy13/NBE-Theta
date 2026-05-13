"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Power, ShieldAlert } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";

interface RiskStateRow {
  id: number;
  kill_switch_active: boolean;
  execution_provider?: "coinbase" | "computer-use" | "mock";
  cu_dry_run?: boolean;
  cu_require_confirm?: boolean;
  cu_max_notional_usd?: number;
  cu_driver?: "claude" | "openai";
  cu_host_last_seen?: string | null;
}

interface AgentActionRow {
  id: number;
  ts: string;
  task_id: string | null;
  client_order_id: string | null;
  skill: string;
  args: unknown;
  reasoning: string | null;
  screenshot_url: string | null;
  result: unknown;
}

interface HostHealth {
  ok: boolean;
  driver?: string;
  dryRun?: boolean;
  platform?: string;
  reason?: string;
}

export function ComputerUseTab() {
  const { rows: riskRows } = useRealtime<RiskStateRow>({
    table: "risk_state",
    initialFetch: { order: { column: "updated_at" }, limit: 1 },
  });
  const { rows: actions, connected: actionsConnected } = useRealtime<AgentActionRow>({
    table: "agent_actions",
    initialFetch: { order: { column: "ts" }, limit: 50 },
  });
  const r = riskRows[0];

  const enabled = r?.execution_provider === "computer-use";
  const hostHealth = useHostHealth(enabled);
  const lastSeen = useLastSeen(r?.cu_host_last_seen);

  async function patch(body: Partial<RiskStateRow> & { active?: boolean }) {
    await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return (
    <div className="space-y-4">
      <GlassPanel title="Computer-Use Execution" className="bg-white/40" withCorners>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <BigToggle
            label="Computer-Use"
            on={enabled}
            disabled={r?.kill_switch_active}
            onChange={(next) =>
              patch({ execution_provider: next ? "computer-use" : "coinbase" })
            }
            subtitle={
              enabled
                ? r?.kill_switch_active
                  ? "kill-switch active — agent will not trade"
                  : "active execution venue"
                : "currently routing to: " + (r?.execution_provider ?? "—")
            }
          />
          <StatusCard
            label="Agent Host"
            ok={hostHealth.ok}
            ok_label={
              hostHealth.driver
                ? `online · ${hostHealth.driver} · ${hostHealth.dryRun ? "dry-run" : "LIVE"}`
                : "online"
            }
            bad_label={hostHealth.reason ?? "offline"}
            footer={lastSeen ? `last poll: ${lastSeen}` : "no poll yet"}
          />
          <KillCard
            killed={!!r?.kill_switch_active}
            onKill={() => patch({ active: true })}
            onArm={() => patch({ active: false })}
          />
        </div>
      </GlassPanel>

      <GlassPanel title="Agent Configuration" className="bg-white/40">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <Toggle
            title="Dry Run"
            subtitle="Fills the ticket but never clicks Submit. Required for first week."
            on={r?.cu_dry_run ?? true}
            onChange={(next) => patch({ cu_dry_run: next })}
          />
          <Toggle
            title="Require Manual Confirm"
            subtitle="Stdin prompt on the trading PC before every Submit click."
            on={r?.cu_require_confirm ?? true}
            onChange={(next) => patch({ cu_require_confirm: next })}
          />
          <NumberField
            title="Max Notional / Order (USD)"
            value={Number(r?.cu_max_notional_usd ?? 50)}
            onChange={(v) => patch({ cu_max_notional_usd: v })}
            subtitle="Local cap. Preflight blocks any ticket that exceeds this."
          />
          <DriverPicker
            value={r?.cu_driver ?? "claude"}
            onChange={(d) => patch({ cu_driver: d })}
          />
        </div>
      </GlassPanel>

      <GlassPanel title="Live Action Feed" className="bg-white/40">
        <div className="flex items-center gap-3 mt-2 text-xs font-mono">
          <span
            className={`px-2 py-0.5 rounded-full ${actionsConnected ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
          >
            {actionsConnected ? "● live" : "○ not connected"}
          </span>
          <span className="text-slate-500">{actions.length} actions (latest first)</span>
        </div>
        <div className="mt-3 max-h-[420px] overflow-auto rounded-xl border border-white/60 bg-white/40">
          {actions.length === 0 && (
            <div className="p-6 text-center text-xs font-mono text-slate-500">
              No agent activity yet. Actions will stream here as the host runs.
            </div>
          )}
          {actions.map((a) => (
            <ActionRow key={a.id} a={a} />
          ))}
        </div>
      </GlassPanel>

      <GlassPanel title="Trading-PC Setup" className="bg-white/40">
        <SetupHelper />
      </GlassPanel>
    </div>
  );
}

function ActionRow({ a }: { a: AgentActionRow }) {
  const ts = useMemo(() => new Date(a.ts).toLocaleTimeString(), [a.ts]);
  const danger = a.skill === "review_and_submit" || a.skill === "raw_input";
  const result = a.result as { error?: string } | null;
  const errored = !!result?.error;
  return (
    <div
      className={`px-4 py-2 border-b border-white/60 last:border-b-0 ${
        errored ? "bg-rose-50" : danger ? "bg-amber-50" : ""
      }`}
    >
      <div className="flex items-baseline gap-3 text-xs font-mono">
        <span className="text-slate-400">{ts}</span>
        <span className="font-bold text-slate-800">{a.skill}</span>
        {a.client_order_id && (
          <span className="text-slate-500">order={a.client_order_id.slice(0, 8)}</span>
        )}
        {errored && <span className="text-rose-600">error</span>}
      </div>
      {a.args !== null && a.args !== undefined && (
        <pre className="text-[10px] font-mono text-slate-600 mt-1 overflow-x-auto">
          args: {safeJson(a.args)}
        </pre>
      )}
      {a.reasoning && (
        <div className="text-[10px] font-mono text-slate-500 mt-1 italic">
          “{a.reasoning.slice(0, 280)}”
        </div>
      )}
      {a.screenshot_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={a.screenshot_url}
          alt="agent screenshot"
          className="mt-2 max-h-40 rounded border border-white/60"
        />
      )}
    </div>
  );
}

function BigToggle({
  label,
  on,
  disabled,
  onChange,
  subtitle,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  subtitle: string;
}) {
  return (
    <div className="p-5 rounded-2xl border border-white/60 bg-white/50 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-slate-500 font-mono">
            {label}
          </div>
          <div className="text-2xl font-mono font-bold text-slate-800 mt-1">
            {on ? "ON" : "OFF"}
          </div>
        </div>
        <button
          disabled={disabled}
          onClick={() => onChange(!on)}
          className={`w-14 h-8 rounded-full relative cursor-pointer transition ${
            on
              ? "bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.5)_inset]"
              : "bg-slate-300 shadow-inner"
          } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
        >
          <div
            className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all ${
              on ? "right-1" : "left-1"
            }`}
          />
        </button>
      </div>
      <div className="text-[11px] font-mono text-slate-500 mt-2">{subtitle}</div>
    </div>
  );
}

function StatusCard({
  label,
  ok,
  ok_label,
  bad_label,
  footer,
}: {
  label: string;
  ok: boolean;
  ok_label: string;
  bad_label: string;
  footer?: string;
}) {
  return (
    <div className="p-5 rounded-2xl border border-white/60 bg-white/50 shadow-sm">
      <div className="text-xs uppercase tracking-widest text-slate-500 font-mono">
        {label}
      </div>
      <div className="flex items-center gap-2 mt-2">
        {ok ? (
          <Eye size={20} className="text-emerald-600" />
        ) : (
          <EyeOff size={20} className="text-rose-500" />
        )}
        <div
          className={`text-sm font-mono font-bold ${ok ? "text-emerald-700" : "text-rose-600"}`}
        >
          {ok ? ok_label : bad_label}
        </div>
      </div>
      {footer && <div className="text-[10px] font-mono text-slate-500 mt-2">{footer}</div>}
    </div>
  );
}

function KillCard({
  killed,
  onKill,
  onArm,
}: {
  killed: boolean;
  onKill: () => void;
  onArm: () => void;
}) {
  return (
    <div className="p-5 rounded-2xl border border-white/60 bg-white/50 shadow-sm">
      <div className="text-xs uppercase tracking-widest text-slate-500 font-mono flex items-center gap-2">
        <ShieldAlert size={14} /> Kill Switch
      </div>
      {killed ? (
        <button
          onClick={onArm}
          className="mt-3 w-full px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-800 text-white text-sm font-mono font-bold"
        >
          Disarm (re-enable trading)
        </button>
      ) : (
        <button
          onClick={onKill}
          className="mt-3 w-full px-4 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-mono font-bold"
        >
          <Power size={14} className="inline -mt-1 mr-2" />
          STOP — flatten + halt
        </button>
      )}
      <div className="text-[10px] font-mono text-slate-500 mt-2">
        Sets risk_state.kill_switch_active. Host & worker both honor it.
      </div>
    </div>
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
    <div className="flex items-center justify-between p-4 border border-white/60 rounded-xl bg-white/50">
      <div>
        <div className="font-bold text-slate-800 text-sm">{title}</div>
        <div className="text-[11px] text-slate-500 font-mono mt-1">{subtitle}</div>
      </div>
      <button
        onClick={() => onChange(!on)}
        className={`w-12 h-6 rounded-full relative cursor-pointer transition ${
          on ? "bg-emerald-400" : "bg-slate-300"
        }`}
      >
        <div
          className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${
            on ? "right-1" : "left-1"
          }`}
        />
      </button>
    </div>
  );
}

function NumberField({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState(value.toString());
  const [syncedTo, setSyncedTo] = useState(value);
  if (syncedTo !== value) {
    setSyncedTo(value);
    setLocal(value.toString());
  }
  return (
    <div className="p-4 border border-white/60 rounded-xl bg-white/50">
      <div className="font-bold text-slate-800 text-sm">{title}</div>
      <input
        type="number"
        min={0}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
        className="mt-2 w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-sm bg-white"
      />
      <div className="text-[11px] text-slate-500 font-mono mt-1">{subtitle}</div>
    </div>
  );
}

function DriverPicker({
  value,
  onChange,
}: {
  value: "claude" | "openai";
  onChange: (v: "claude" | "openai") => void;
}) {
  return (
    <div className="p-4 border border-white/60 rounded-xl bg-white/50">
      <div className="font-bold text-slate-800 text-sm">Driver</div>
      <div className="flex gap-2 mt-2">
        {(["claude", "openai"] as const).map((d) => (
          <button
            key={d}
            onClick={() => onChange(d)}
            className={`flex-1 px-3 py-2 rounded-full text-xs font-mono border transition ${
              value === d
                ? "bg-fuchsia-500 text-white border-fuchsia-400"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {d === "claude" ? "Claude" : "OpenAI"}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-slate-500 font-mono mt-2">
        Host re-reads driver on next poll. Restart not required.
      </div>
    </div>
  );
}

function SetupHelper() {
  const dashboardOrigin =
    typeof window !== "undefined" ? window.location.origin : "https://your-dashboard";
  const cmd = `pnpm install && DASHBOARD_URL=${dashboardOrigin} HOST_TOKEN=<token> ANTHROPIC_API_KEY=<key> pnpm dev`;
  return (
    <div className="mt-3 space-y-3">
      <div className="text-xs font-mono text-slate-600">
        Run this on the machine that has Webull desktop signed in. The host
        will poll {dashboardOrigin}/api/agent-host/control for config and stream
        actions back via /api/agent-host/ingest.
      </div>
      <pre className="p-3 rounded-xl bg-slate-900 text-emerald-300 text-[11px] font-mono overflow-x-auto">
        {`cd agent-host\n${cmd}`}
      </pre>
      <div className="flex items-start gap-2 text-[11px] font-mono text-amber-900 bg-amber-50 p-3 rounded-xl border border-amber-200">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>
          The agent moves your mouse and clicks. Don&apos;t leave it unattended
          until you&apos;ve watched ≥ 1 week of dry-run output here.
        </span>
      </div>
    </div>
  );
}

function useHostHealth(enabled: boolean): HostHealth {
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

function useLastSeen(iso?: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    function fmt() {
      const dt = new Date(iso!);
      const secs = Math.round((Date.now() - dt.getTime()) / 1000);
      if (secs < 60) setLabel(`${secs}s ago`);
      else if (secs < 3600) setLabel(`${Math.round(secs / 60)}m ago`);
      else setLabel(`${Math.round(secs / 3600)}h ago`);
    }
    fmt();
    const id = setInterval(fmt, 1_000);
    return () => {
      clearInterval(id);
      setLabel(null);
    };
  }, [iso]);
  return iso ? label : null;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
