import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

/**
 * Agent-host config feed.
 *
 * The host polls this every few seconds and applies the result. Using a
 * pull model means the host can live on a laptop with no inbound network,
 * and the database is the single source of truth for what the user picked
 * in the dashboard.
 *
 * Auth: shared bearer (COMPUTER_USE_HOST_TOKEN) — the same token the
 * worker uses to talk to the host. We also stamp `cu_host_last_seen` on
 * each poll so the dashboard can show host liveness.
 */
export async function GET(req: Request) {
  const expected = process.env.COMPUTER_USE_HOST_TOKEN;
  if (!expected) {
    return NextResponse.json({ enabled: false, reason: "host token not configured" });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ enabled: false, reason: "supabase not configured" });
  }
  const { data, error } = await sb
    .from("risk_state")
    .select(
      "execution_provider, kill_switch_active, cu_dry_run, cu_require_confirm, cu_max_notional_usd, cu_driver",
    )
    .eq("id", 1)
    .single();
  if (error || !data) {
    return NextResponse.json({ enabled: false, reason: error?.message ?? "no row" });
  }

  await sb
    .from("risk_state")
    .update({ cu_host_last_seen: new Date().toISOString() })
    .eq("id", 1);

  return NextResponse.json({
    enabled: data.execution_provider === "computer-use" && !data.kill_switch_active,
    killSwitch: !!data.kill_switch_active,
    dryRun: data.cu_dry_run ?? true,
    requireConfirm: data.cu_require_confirm ?? true,
    maxNotionalUsd: Number(data.cu_max_notional_usd ?? 50),
    driver: data.cu_driver ?? "claude",
  });
}
