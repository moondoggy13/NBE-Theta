"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * Operator console.
 *
 * **Two ways in, and the console prefers the good one.** Where Supabase
 * is configured it signs in with email and password and sends the
 * session JWT, which gives the server a verified identity and a role
 * (PR 12 / ADR-0004). Where it is not — local dev, and any deployment
 * still mid-transition — it falls back to the shared
 * `CONTROL_API_TOKEN` field. The header says which is in use, because a
 * shared credential should look like the transitional thing it is
 * rather than like normal operation.
 *
 * Either credential lives in sessionStorage rather than localStorage, so
 * it dies with the tab. An internal tool left logged in on a shared
 * machine is a different kind of exposure from the one PR 9 closed, and
 * not one worth trading for convenience.
 *
 * **What this file hides is not a security control.** Buttons are
 * disabled by role so an operator is not offered an action that will
 * refuse them, but every route enforces its own role server-side. A
 * caller who ignores the UI and posts directly is refused there.
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
  shadowGate?: { passed: boolean; run: { id: string; evaluated_at: string } | null };
  reason?: string;
}

/** One criterion inside a recorded packet. */
interface CriterionRow {
  status: "pass" | "fail" | "insufficient_evidence";
  value?: number;
  threshold?: number;
  reason?: string;
}

interface GateRun {
  id: string;
  evaluated_at: string;
  window_start: string;
  window_end: string;
  verdict: "pass" | "fail" | "insufficient_evidence";
  criteria: Record<string, CriterionRow>;
  headline: Record<string, unknown>;
  policy_versions: string[];
  note: string | null;
}

interface Identity {
  userId: string | null;
  email: string | null;
  role: "viewer" | "operator" | "admin";
  method: "supabase" | "shared_token";
  label: string;
  sharedCredential: boolean;
}

interface GateState {
  ok: boolean;
  latest?: GateRun | null;
  latestPass?: GateRun | null;
  authorisesLive?: boolean;
  runs?: GateRun[];
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
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<ModeState | null>(null);
  const [signals, setSignals] = useState<SignalsState | null>(null);
  const [cohort, setCohort] = useState<CohortState | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [gateRuns, setGateRuns] = useState<GateState | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"signals" | "cohort" | "health" | "gate">("signals");

  // Nothing here writes state before the first await: a synchronous
  // setState inside an effect body triggers a cascading render, and
  // clearing the error up-front would also flash the panel between a
  // failure and its replacement.
  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!token) return;
    const headers = { authorization: `Bearer ${token}` };
    try {
      const [m, s, c, h, g, w] = await Promise.all([
        fetch("/api/console/mode", { headers }),
        fetch("/api/console/signals?limit=50", { headers }),
        fetch("/api/console/cohort", { headers }),
        fetch("/api/console/health", { headers }),
        fetch("/api/console/gate", { headers }),
        fetch("/api/console/whoami", { headers }),
      ]);
      if (isCancelled()) return;
      if (m.status === 401) {
        // Clear the credential rather than leaving a dead one in place.
        // A Supabase access token expires after about an hour, and a
        // console that keeps retrying with it just shows an error
        // forever instead of offering the sign-in form again.
        writeToken(null);
        setError("Session rejected or expired. Sign in again.");
        return;
      }
      const [mj, sj, cj, hj, gj, wj] = await Promise.all([
        m.json(),
        s.json(),
        c.json(),
        h.json(),
        g.json(),
        w.json(),
      ]);
      if (isCancelled()) return;
      setMode(mj);
      setSignals(sj);
      setCohort(cj);
      setHealth(hj);
      setGateRuns(gj);
      setIdentity((wj as { identity?: Identity }).identity ?? null);
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
    const sb = browserClient();
    // Supabase configured decides which sign-in to offer. Not a
    // preference toggle: where real identity is available it is the only
    // thing shown, so nobody reaches for the shared secret out of habit.
    if (sb) {
      return (
        <main className="mx-auto max-w-md p-8">
          <h1 className="text-lg font-semibold">NBE-Theta operator console</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Internal. Sign in with your operator account.
          </p>
          <form
            className="mt-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSigningIn(true);
              setError(null);
              void sb.auth
                .signInWithPassword({ email, password: draft })
                .then(({ data, error: signInError }) => {
                  setSigningIn(false);
                  if (signInError || !data.session) {
                    setError(signInError?.message ?? "sign-in failed");
                    return;
                  }
                  setDraft("");
                  writeToken(data.session.access_token);
                });
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              autoComplete="username"
            />
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="password"
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              autoComplete="current-password"
            />
            <button
              type="submit"
              disabled={signingIn}
              className="w-full rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
          <p className="mt-4 text-xs text-neutral-500">
            Signing in is not by itself access: an operator account with a role must exist for
            your identity. Ask an admin if you are refused after a successful sign-in.
          </p>
        </main>
      );
    }

    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-lg font-semibold">NBE-Theta operator console</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Internal. Enter the shared operator token to continue.
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
        <p className="mt-4 text-xs text-neutral-500">
          Supabase is not configured here, so this deployment is still on the shared token. See
          docs/adr/0004-operator-identity.md.
        </p>
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
          {identity && <IdentityBadge identity={identity} />}
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

      {mode?.ok && mode.shadowGate?.passed === false && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>The shadow gate has not passed.</strong> No <code>shadow_gate_runs</code> row
          with verdict <code>pass</code> is recorded, so promotion to live is refused regardless of
          the env flags. See the <em>gate</em> tab for which criteria are outstanding, and run{" "}
          <code>theta-signals gate --record</code> to record a fresh packet.
        </div>
      )}

      <nav className="flex gap-1 border-b border-neutral-200 text-sm">
        {(["signals", "cohort", "health", "gate"] as const).map((t) => (
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
      {tab === "gate" && <GatePanel data={gateRuns} />}
    </main>
  );
}

/**
 * Who you are and what you can do, always on screen.
 *
 * The shared-credential case is called out rather than rendered like a
 * normal login, because it is the state this PR exists to move away
 * from: nobody should have to check an env file to discover that the
 * audit trail will record "shared-token" instead of their name.
 */
function IdentityBadge({ identity }: { identity: Identity }) {
  if (identity.sharedCredential) {
    return (
      <span
        className="rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white"
        title="Actions are recorded as 'shared-token', not as you. See ADR-0004."
      >
        SHARED TOKEN · {identity.role.toUpperCase()}
      </span>
    );
  }
  return (
    <span
      className="rounded border border-neutral-300 px-2 py-1 text-xs"
      title={identity.userId ?? undefined}
    >
      {identity.label} · <strong>{identity.role}</strong>
    </span>
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

/**
 * The promotion decision packet.
 *
 * Three states per criterion, not two, and the panel shows them as three
 * — an unmeasurable criterion renders as its own thing rather than as a
 * failure or (much worse) a tick. An operator looking at this needs to
 * tell "we tried and it did not work" apart from "we have not measured
 * this yet"; those call for opposite responses, and a two-colour
 * checklist collapses them.
 */
function GatePanel({ data }: { data: GateState | null }) {
  if (!data?.ok) return <Empty note={data?.ok === false ? "unavailable" : "loading"} />;
  const latest = data.latest ?? null;

  if (!latest) {
    return (
      <section className="space-y-3">
        <p className="text-sm text-neutral-500">
          No shadow-gate packet has been recorded. Run{" "}
          <code className="font-mono text-xs">theta-signals gate --record</code> in the Python
          worker; until a packet with verdict <code>pass</code> exists, promotion to live is
          refused.
        </p>
      </section>
    );
  }

  const criteria = Object.entries(latest.criteria ?? {});
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <VerdictBadge verdict={latest.verdict} />
        <span className="text-xs text-neutral-500">
          window {latest.window_start?.slice(0, 10)} → {latest.window_end?.slice(0, 10)}, evaluated{" "}
          {latest.evaluated_at?.slice(0, 19).replace("T", " ")}
        </span>
      </div>

      {!data.authorisesLive && (
        <p className="text-sm text-neutral-600">
          No passing packet on record — live trading is not authorised.
        </p>
      )}
      {data.authorisesLive && latest.verdict !== "pass" && (
        // Worth saying out loud: the newest run and the newest *passing*
        // run are different questions, and the rule enforced by
        // /api/console/mode is the second one.
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          The most recent packet is <strong>{latest.verdict}</strong>, but an earlier passing
          packet still authorises promotion. Re-record before going live.
        </p>
      )}

      <div>
        <h2 className="mb-2 text-sm font-medium">Criteria</h2>
        <ul className="space-y-1 text-sm">
          {criteria.map(([name, c]) => (
            <li
              key={name}
              className="flex items-baseline justify-between gap-3 border-b border-neutral-100 py-1"
            >
              <span className="flex items-baseline gap-2">
                <CriterionMark status={c.status} />
                <span className="font-mono text-xs">{name}</span>
              </span>
              <span className="text-right text-xs text-neutral-600">
                {c.value !== undefined ? c.value.toLocaleString() : "not measured"}
                {c.threshold !== undefined && (
                  <span className="text-neutral-400"> / bar {c.threshold.toLocaleString()}</span>
                )}
                {c.reason && <div className="text-neutral-400">{c.reason}</div>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {(latest.policy_versions ?? []).length > 1 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          This packet spans {latest.policy_versions.length} policy versions (
          {latest.policy_versions.join(", ")}) — it averages more than one system.
        </p>
      )}

      {(data.runs ?? []).length > 1 && (
        <div>
          <h2 className="mb-2 text-sm font-medium">History</h2>
          <ul className="space-y-1 text-sm">
            {(data.runs ?? []).slice(1).map((r) => (
              <li key={r.id} className="flex justify-between border-b border-neutral-100 py-1">
                <span className="text-xs text-neutral-500">
                  {r.evaluated_at?.slice(0, 10)} {r.note ?? ""}
                </span>
                <VerdictBadge verdict={r.verdict} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function VerdictBadge({ verdict }: { verdict: GateRun["verdict"] }) {
  const colors: Record<GateRun["verdict"], string> = {
    pass: "bg-green-700",
    fail: "bg-red-600",
    insufficient_evidence: "bg-neutral-500",
  };
  return (
    <span className={`rounded px-2 py-1 text-xs font-semibold text-white ${colors[verdict]}`}>
      {verdict.replace("_", " ").toUpperCase()}
    </span>
  );
}

function CriterionMark({ status }: { status: CriterionRow["status"] }) {
  const marks: Record<CriterionRow["status"], [string, string]> = {
    pass: ["✓", "text-green-700"],
    fail: ["✗", "text-red-600"],
    // Not a tick and not a cross. "We have not measured this" is its own
    // answer and blocks promotion just as a failure does.
    insufficient_evidence: ["–", "text-neutral-400"],
  };
  const [glyph, cls] = marks[status];
  return (
    <span className={`font-mono text-xs ${cls}`} title={status}>
      {glyph}
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
