import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Operating mode: paused | shadow | live.
 *
 * **This column can never by itself turn on live trading.** Going live
 * requires all of:
 *
 *   1. this mode set to 'live' with two-step operator confirmation,
 *   2. the executor's three-flag env gate
 *      (EXECUTION_PROVIDER=polymarket-clob && POLYMARKET_LIVE=true
 *      && CONFIRM_LIVE=YES),
 *   3. the shadow gate passed — a recorded `shadow_gate_runs` row with
 *      verdict 'pass' (PR 11 / ADR-0003),
 *   4. a documented legal/compliance approval for the operating
 *      jurisdiction.
 *
 * The route now enforces (1), (2) and (3). Until PR 11 it enforced only
 * (1) and (2) and *documented* (3), which is the weaker arrangement:
 * the shadow gate is the condition most likely to be skipped, because
 * skipping it looks like impatience rather than like disabling a safety
 * check. A comment cannot refuse.
 *
 * (4) is still a human judgement and is deliberately not modelled as a
 * boolean here. A checkbox labelled "compliance approved" is worse than
 * an honest gap: it would let one click stand in for a legal opinion
 * about a specific jurisdiction, and it would look identical whether or
 * not anyone had read one.
 *
 * The two-step confirmation is a genuine second decision, not a
 * checkbox: the caller must send `confirm: "ENABLE-LIVE"` alongside the
 * mode. A single mistyped request cannot arm live trading.
 */

type Mode = "paused" | "shadow" | "live";
const MODES = new Set<Mode>(["paused", "shadow", "live"]);
const LIVE_CONFIRMATION = "ENABLE-LIVE";

interface Body {
  mode?: Mode;
  confirm?: string;
  actor?: string;
}

function envGate() {
  const provider = process.env.EXECUTION_PROVIDER ?? "mock";
  const live = process.env.POLYMARKET_LIVE === "true";
  const confirmed = process.env.CONFIRM_LIVE === "YES";
  return {
    executionProvider: provider,
    polymarketLive: live,
    confirmLive: confirmed,
    allOfThree: provider === "polymarket-clob" && live && confirmed,
  };
}

interface GateRow {
  id: string;
  evaluated_at: string;
  window_start: string;
  window_end: string;
}

/**
 * The most recent passing shadow-gate packet, or null.
 *
 * Fails CLOSED on a query error. A database that cannot answer "has the
 * gate passed?" has not answered "yes", and treating an error as
 * permission would make an outage the easiest way past the check.
 */
async function passingGate(
  sb: NonNullable<ReturnType<typeof serverClient>>,
): Promise<GateRow | null> {
  const { data, error } = await sb
    .from("shadow_gate_runs")
    .select("id, evaluated_at, window_start, window_end")
    .eq("verdict", "pass")
    .order("evaluated_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const rows = (data ?? []) as unknown as GateRow[];
  return rows[0] ?? null;
}

export async function GET(req: Request) {
  const auth = requireOperator(req);
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const { data, error } = await sb
    .from("risk_state")
    .select("mode, mode_changed_at, mode_changed_by, kill_switch_active, autonomous_execution")
    .eq("id", 1)
    .single();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  const gate = await passingGate(sb);
  return NextResponse.json({
    ok: true,
    state: data,
    envGate: envGate(),
    shadowGate: { passed: gate !== null, run: gate },
  });
}

export async function POST(req: Request) {
  const auth = requireOperator(req);
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const body = (await req.json()) as Body;
  const mode = body.mode;
  // Carried out of the live branch so the audit row can name the exact
  // packet that authorised the promotion. "The gate passed" is not an
  // auditable claim; "gate run <id>, window <start>–<end>" is.
  let authorisingGate: GateRow | null = null;
  if (!mode || !MODES.has(mode)) {
    return NextResponse.json(
      { ok: false, reason: "mode must be paused | shadow | live" },
      { status: 400 },
    );
  }

  if (mode === "live") {
    if (body.confirm !== LIVE_CONFIRMATION) {
      return NextResponse.json(
        {
          ok: false,
          reason: `live requires confirm: "${LIVE_CONFIRMATION}"`,
          step: "confirmation-required",
        },
        { status: 400 },
      );
    }
    const gate = envGate();
    if (!gate.allOfThree) {
      // Refuse rather than record an aspiration. A stored mode of 'live'
      // that the executor will not act on is worse than an error: the
      // console would show armed while nothing is.
      return NextResponse.json(
        {
          ok: false,
          reason: "executor env gate is not satisfied; live refused",
          envGate: gate,
        },
        { status: 409 },
      );
    }

    // The shadow gate. Checked LAST of the machine-checkable conditions
    // because it is the expensive query, and checked at all because
    // ADR-0002's whole promotion argument rests on it: thirty days, a
    // hundred qualified signals, net-positive after modelled costs, p95
    // detection under ninety seconds, zero duplicates, zero unresolved
    // incidents. `theta-signals gate --record` writes the packet.
    //
    // Note what is required: a packet whose verdict is 'pass'. A packet
    // whose verdict is 'insufficient_evidence' does not count, which is
    // the entire reason that third state exists — see
    // python/nbe_theta/signals/gate.py.
    authorisingGate = await passingGate(sb);
    if (authorisingGate === null) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            "no passing shadow-gate run recorded; live refused. " +
            "Run `theta-signals gate --record` and promote only on a 'pass' verdict.",
          shadowGate: { passed: false, run: null },
        },
        { status: 409 },
      );
    }
  }

  const now = new Date().toISOString();
  const actor = typeof body.actor === "string" && body.actor ? body.actor : "operator";

  const { data, error } = await sb
    .from("risk_state")
    .update({
      mode,
      mode_changed_at: now,
      mode_changed_by: actor,
      updated_at: now,
    })
    .eq("id", 1)
    .select()
    .single();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  // Immutable audit. A mode change is the single most consequential
  // action available here, so it is recorded even though risk_state
  // already carries who and when.
  await sb.from("operator_actions").insert({
    actor,
    action: "mode_change",
    detail: { mode, envGate: envGate(), shadowGateRun: authorisingGate },
  });

  return NextResponse.json({
    ok: true,
    state: data,
    envGate: envGate(),
    shadowGate: { passed: authorisingGate !== null, run: authorisingGate },
  });
}
