import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

export async function GET() {
  const sb = serverClient();
  const deps: Record<string, string> = {};

  if (sb) {
    try {
      await sb.from("risk_state").select("id").limit(1);
      deps.supabase = "ok";
    } catch (e) {
      deps.supabase = `error: ${(e as Error).message}`;
    }
  } else {
    deps.supabase = "not_configured";
  }

  // Execution posture. The three-flag live gate is Polymarket-specific;
  // all three must be set for the CLOB adapter to instantiate at all
  // (see AGENTS.md). Absent any of them the system is paper-only.
  deps.execution_provider = process.env.EXECUTION_PROVIDER ?? "mock";
  deps.live_gated =
    process.env.EXECUTION_PROVIDER === "polymarket-clob" &&
    process.env.POLYMARKET_LIVE === "true" &&
    process.env.CONFIRM_LIVE === "YES"
      ? "true"
      : "false";

  return NextResponse.json({
    ok: true,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
    deps,
  });
}
