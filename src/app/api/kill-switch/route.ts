import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Kill-switch control route.
 *
 * POST is authenticated with a shared bearer token (CONTROL_API_TOKEN)
 * in any non-development environment. This is placeholder auth until
 * Supabase Auth / Cloudflare Access lands in a later PR. The immediate
 * goal is that anonymous internet cannot flip the kill switch,
 * autonomous-execution toggle, or preset in production.
 *
 * GET stays readable so the dashboard can render current state.
 *
 * Fail-closed in production: if CONTROL_API_TOKEN is unset (or too
 * short) in NODE_ENV=production, every POST is rejected with 503.
 * A misconfigured production deployment must not silently expose an
 * unauthenticated control surface.
 *
 * Local development (NODE_ENV != production) skips the auth check so
 * the dashboard's existing buttons still work.
 */
interface Patch {
  active?: boolean;
  autonomous_execution?: boolean;
  preset?: "Conservative" | "Moderate" | "Aggressive" | "Custom";
}

export async function GET() {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  const { data } = await sb.from("risk_state").select("*").eq("id", 1).single();
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const authResult = requireOperator(req);
  if (!authResult.ok) return authResult.response;

  const sb = serverClient();
  if (!sb) return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  const body = (await req.json()) as Patch;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.active === "boolean") patch.kill_switch_active = body.active;
  if (typeof body.autonomous_execution === "boolean") patch.autonomous_execution = body.autonomous_execution;
  if (body.preset) patch.preset = body.preset;

  const { data, error } = await sb.from("risk_state").update(patch).eq("id", 1).select().single();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, state: data });
}


