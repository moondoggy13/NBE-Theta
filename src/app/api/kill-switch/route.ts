import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

interface Patch {
  active?: boolean;
  autonomous_execution?: boolean;
  preset?: "Conservative" | "Moderate" | "Aggressive" | "Custom";
  execution_provider?: "coinbase" | "computer-use" | "mock";
  cu_dry_run?: boolean;
  cu_require_confirm?: boolean;
  cu_max_notional_usd?: number;
  cu_driver?: "claude" | "openai";
}

export async function GET() {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  const { data } = await sb.from("risk_state").select("*").eq("id", 1).single();
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  const body = (await req.json()) as Patch;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.active === "boolean") patch.kill_switch_active = body.active;
  if (typeof body.autonomous_execution === "boolean") patch.autonomous_execution = body.autonomous_execution;
  if (body.preset) patch.preset = body.preset;
  if (body.execution_provider) patch.execution_provider = body.execution_provider;
  if (typeof body.cu_dry_run === "boolean") patch.cu_dry_run = body.cu_dry_run;
  if (typeof body.cu_require_confirm === "boolean") patch.cu_require_confirm = body.cu_require_confirm;
  if (typeof body.cu_max_notional_usd === "number" && body.cu_max_notional_usd >= 0) {
    patch.cu_max_notional_usd = body.cu_max_notional_usd;
  }
  if (body.cu_driver) patch.cu_driver = body.cu_driver;

  const { data, error } = await sb.from("risk_state").update(patch).eq("id", 1).select().single();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, state: data });
}
