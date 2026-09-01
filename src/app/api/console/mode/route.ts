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
 *   3. a documented legal/compliance approval for the operating
 *      jurisdiction,
 *   4. the shadow gate passed.
 *
 * The route enforces (1) and refuses to pretend about the rest: it
 * returns the flags it can observe so the console can show an operator
 * exactly which conditions are unmet, rather than flipping a switch that
 * appears to work and silently does nothing.
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

  return NextResponse.json({ ok: true, state: data, envGate: envGate() });
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
    detail: { mode, envGate: envGate() },
  });

  return NextResponse.json({ ok: true, state: data, envGate: envGate() });
}
