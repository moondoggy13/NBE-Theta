import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

export async function GET() {
  const sb = serverClient();
  if (!sb) return NextResponse.json([]);
  const { data } = await sb.from("backtest_runs").select("*").order("started_at", { ascending: false }).limit(50);
  return NextResponse.json(data ?? []);
}
