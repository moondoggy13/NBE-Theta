"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Operator console.
 *
 * **Auth is a shared bearer secret held in sessionStorage**, sent on
 * every request. That is the same `CONTROL_API_TOKEN` model the control
 * routes already use, and it is a deliberate placeholder: ADR-0002's
 * rollout requires real SSO with per-operator roles before live mode.
 * What it buys today is that the browser holds no alpha data until
 * someone supplies the secret, and the server refuses every request
 * without it.
 *
 * sessionStorage rather than localStorage so the token dies with the
 * tab. An internal tool left logged in on a shared machine is a
 * different kind of exposure from the one we just closed, and not one
 * worth trading for convenience.
 *
 * The panels deliberately lead with what is *wrong* or *missing* —
 * rejection histograms, exclusion reasons, stale quotes — rather than
 * with a portfolio value. Early on, the reasons nothing happened are the
 * information; a green number is the least informative thing on screen.
 */

const TOKEN_KEY = "nbe.operator.token";

/**
 * The token lives in sessionStorage, which is an external store, so it
 * is read through `useSyncExternalStore` rather than an effect. That
 * gives a correct server snapshot (always null — the server has no
 * session) and avoids the cascading render an effect-plus-setState
 * would cause on every mount.
 *
 * The `storage` event does not fire in the tab that made the change, so
 * this keeps its own listener set and notifies on write.
 */
const tokenListeners = new Set<() => void>();
let tokenCache: string | null = null;
let tokenHydrated = false;

function tokenSnapshot(): string | null {
  if (!tokenHydrated) {
    try {
      tokenCache = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      // Private mode or storage disabled: the console still works, the
      // operator just re-enters the token on each load.
      tokenCache = null;
    }
    tokenHydrated = true;
  }
  return tokenCache;
}

function tokenServerSnapshot(): string | null {
  return null;
}

function subscribeToken(cb: () => void): () => void {
  tokenListeners.add(cb);
  return () => {
    tokenListeners.delete(cb);
  };
}

function writeToken(value: string | null): void {
  tokenCache = value;
  tokenHydrated = true;
  try {
    if (value === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Keep it in memory for this page; nothing else to do.
  }
  for (const cb of tokenListeners) cb();
}

type Mode = "paused" | "shadow" | "live";

interface ModeState {
  ok: boolean;
  state?: {
    mode: Mode;
    mode_changed_at: string | null;
    mode_changed_by: string | null;
    kill_switch_active: boolean;
  };
  envGate?: {
    executionProvider: string;
    polymarketLive: boolean;
    confirmLive: boolean;
    allOfThree: boolean;
  };
  reason?: string;
}

interface SignalsState {
  ok: boolean;
  headline?: {
    ordersAttempted: number;
    ordersFilled: number;
    fillRate: number | null;
    meanSlippageVsSource: number | null;
  };
  rejectHistogram?: { reason: string; count: number }[];
  feed?: Record<string, unknown>[];
}

interface CohortState {
  ok: boolean;
  asOf?: string | null;
  policyVersion?: string | null;
  note?: string;
  counts?: { feeder: number; cohort: number; excluded: number };
  feeder?: Record<string, unknown>[];
  exclusions?: { reason: string; count: number }[];
}

interface HealthState {
  ok: boolean;
  quotes?: {
    tracked: number;
    stale: number;
    staleAfterSeconds: number;
    streamDisconnected: number;
  };
  heartbeats?: { processes: number; stale: number };
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function OperatorConsole() {
  const token = useSyncExternalStore(subscribeToken, tokenSnapshot, tokenServerSnapshot);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ModeState | null>(null);
  const [signals, setSignals] = useState<SignalsState | null>(null);
  const [cohort, setCohort] = useState<CohortState | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"signals" | "cohort" | "health">("signals");

  // Nothing here writes state before the first await: a synchronous
  // setState inside an effect body triggers a cascading render, and
  // clearing the error up-front would also flash the panel between a
  // failure and its replacement.
  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!token) return;
    const headers = { authorization: `Bearer ${token}` };
    try {
      const [m, s, c, h] = await Promise.all([
        fetch("/api/console/mode", { headers }),
        fetch("/api/console/signals?limit=50", { headers }),
        fetch("/api/console/cohort", { headers }),
        fetch("/api/console/health", { headers }),
      ]);
      if (isCancelled()) return;
      if (m.status === 401) {
        setError("Token rejected.");
        return;
      }
      const [mj, sj, cj, hj] = await Promise.all([m.json(), s.json(), c.json(), h.json()]);
      if (isCancelled()) return;
      setMode(mj);
      setSignals(sj);
      setCohort(cj);
      setHealth(hj);
      setError(null);
    } catch (e) {
      if (isCancelled()) return;
      setError(e instanceof Error ? e.message : "request failed");
    }
  }, [token]);

  useEffect(() => {
    // State is written from a promise continuation, never synchronously
    // in this body — the "subscribe to an external system, setState in a
    // callback" shape the rule's own guidance endorses. The lint cannot
    // see through the async boundary, so it is suppressed with that
    // reasoning rather than the code being contorted to satisfy it.
    //
    // `cancelled` is not decoration: without it a slow response landing
    // after the operator hits Lock would repopulate the panels with data
    // they just dismissed.
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!token) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-lg font-semibold">NBE-Theta operator console</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Internal. Enter the operator token to continue.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft) return;
            writeToken(draft);
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="operator token"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            autoComplete="off"
          />
          <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white">
            Enter
          </button>
        </form>
      </main>
    );
  }

  const m = mode?.state;
  const gate = mode?.envGate;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">NBE-Theta operator console</h1>
          <p className="text-xs text-neutral-500">
            {cohort?.policyVersion ? `policy ${cohort.policyVersion}` : "no cohort run yet"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ModeBadge mode={m?.mode} killSwitch={m?.kill_switch_active} />
          <button
            onClick={() => void load()}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            Refresh
          </button>
          <button
            onClick={() => {
              writeToken(null);
            }}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            Lock
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {gate && !gate.allOfThree && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Live execution is not armed.</strong> The executor env gate is unsatisfied:{" "}
          <code>EXECUTION_PROVIDER={gate.executionProvider}</code>,{" "}
          <code>POLYMARKET_LIVE={String(gate.polymarketLive)}</code>,{" "}
          <code>CONFIRM_LIVE={String(gate.confirmLive)}</code>. Setting mode to live is refused
          while any of the three is unmet — and all three plus a documented compliance approval
          are required before live trading.
        </div>
      )}

      <nav className="flex gap-1 border-b border-neutral-200 text-sm">
        {(["signals", "cohort", "health"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 ${
              tab === t ? "border-b-2 border-neutral-900 font-medium" : "text-neutral-500"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === "signals" && <SignalsPanel data={signals} />}
      {tab === "cohort" && <CohortPanel data={cohort} />}
      {tab === "health" && <HealthPanel data={health} />}
    </main>
  );
}

function ModeBadge({ mode, killSwitch }: { mode?: Mode; killSwitch?: boolean }) {
  if (killSwitch) {
    return (
      <span className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white">
        KILL SWITCH ACTIVE
      </span>
    );
  }
  const colors: Record<Mode, string> = {
    paused: "bg-neutral-500",
    shadow: "bg-blue-600",
    live: "bg-red-600",
  };
  const label = mode ?? "unknown";
  return (
    <span
      className={`rounded px-2 py-1 text-xs font-semibold text-white ${
        mode ? colors[mode] : "bg-neutral-400"
      }`}
    >
      {label.toUpperCase()}
    </span>
  );
}

function SignalsPanel({ data }: { data: SignalsState | null }) {
  if (!data?.ok) return <Empty note={data?.ok === false ? "unavailable" : "loading"} />;
  const h = data.headline;
  const hist = data.rejectHistogram ?? [];

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Orders attempted" value={h ? String(h.ordersAttempted) : "—"} />
        <Stat label="Orders filled" value={h ? String(h.ordersFilled) : "—"} />
        <Stat label="Fill rate" value={pct(h?.fillRate)} />
        <Stat
          label="Mean slippage"
          value={
            h?.meanSlippageVsSource !== null && h?.meanSlippageVsSource !== undefined
              ? h.meanSlippageVsSource.toFixed(4)
              : "—"
          }
        />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">Why signals did not trade</h2>
        {hist.length === 0 ? (
          <p className="text-sm text-neutral-500">No rejections recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {hist.map((r) => (
              <li key={r.reason} className="flex justify-between border-b border-neutral-100 py-1">
                <span className="font-mono text-xs">{r.reason}</span>
                <span>{r.count}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          A histogram dominated by <code>price_cap</code> or <code>freshness</code> means we are
          losing the latency race; <code>depth</code> means our sources trade markets too thin to
          mirror at our size.
        </p>
      </div>
    </section>
  );
}

function CohortPanel({ data }: { data: CohortState | null }) {
  if (!data?.ok) return <Empty note={data?.ok === false ? "unavailable" : "loading"} />;
  if (data.note) return <Empty note={data.note} />;
  const c = data.counts;

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Feeder set" value={c ? String(c.feeder) : "—"} />
        <Stat label="Cohort" value={c ? String(c.cohort) : "—"} />
        <Stat label="Excluded" value={c ? String(c.excluded) : "—"} />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium">Exclusions by first failing gate</h2>
        <ul className="space-y-1 text-sm">
          {(data.exclusions ?? []).map((r) => (
            <li key={r.reason} className="flex justify-between border-b border-neutral-100 py-1">
              <span className="font-mono text-xs">{r.reason}</span>
              <span>{r.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function HealthPanel({ data }: { data: HealthState | null }) {
  if (!data?.ok) return <Empty note={data?.ok === false ? "unavailable" : "loading"} />;
  const q = data.quotes;
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tokens tracked" value={q ? String(q.tracked) : "—"} />
        <Stat label="Stale quotes" value={q ? String(q.stale) : "—"} />
        <Stat label="Stream disconnected" value={q ? String(q.streamDisconnected) : "—"} />
        <Stat label="Stale heartbeats" value={data.heartbeats ? String(data.heartbeats.stale) : "—"} />
      </div>
      <p className="text-xs text-neutral-500">
        A quiet market and a broken collector look identical in a price chart. Stale quotes and
        disconnected streams are the only way to tell them apart.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-200 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Empty({ note }: { note: string }) {
  return <p className="text-sm text-neutral-500">{note}</p>;
}
