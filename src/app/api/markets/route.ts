import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

/**
 * Market registry read for the Markets tab. Server-side (service-role)
 * so the browser never reads the DB directly. Returns the most recently
 * opened markets, active first, joined to their outcome legs.
 *
 * Populated by the Python `theta-registry` ingestor (PR 3).
 */
export async function GET(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json([]);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
  const activeOnly = searchParams.get("active") === "true";

  let query = sb
    .from("markets")
    .select(
      "venue, venue_market_id, venue_event_id, condition_id, question, active, " +
        "closed, resolved, opened_at, closes_at, resolution_source, " +
        "outcomes(outcome_index, outcome_name, outcome_token_id)",
    )
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (activeOnly) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
