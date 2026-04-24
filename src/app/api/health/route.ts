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

  deps.coinbase_mode = process.env.COINBASE_MODE ?? "paper";
  deps.live_gated = process.env.COINBASE_LIVE === "true" && process.env.CONFIRM_LIVE === "YES" ? "true" : "false";

  return NextResponse.json({
    ok: true,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
    deps,
  });
}
