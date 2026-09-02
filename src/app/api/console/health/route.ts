import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Data-quality panel: is what we are looking at current?
 *
 * The distinction this exists to make visible: **a quiet market and a
 * broken collector look identical in a price chart.** Both show a flat
 * line. Only the freshness and heartbeat columns tell them apart, and an
 * operator making a trading decision off stale prices has no way to know
 * without them.
 *
 * `staleQuotes` counts tokens whose last quote is older than the
 * threshold. `stream_connected` false on a recent quote is the sharper
 * signal — it means the collector fell back to REST polling, so the
 * prices are real but lagging.
 */

const STALE_AFTER_S = 120;
const HEARTBEAT_STALE_AFTER_S = 300;

export async function GET(req: Request) {
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const now = Date.now();
  const staleCutoff = new Date(now - STALE_AFTER_S * 1000).toISOString();

  const [quotes, stale, disconnected, heartbeats, runs, lastAction] = await Promise.all([
    sb.from("market_quote_latest").select("outcome_token_id", { count: "exact", head: true }),
    sb
      .from("market_quote_latest")
      .select("outcome_token_id", { count: "exact", head: true })
      .lt("observed_at", staleCutoff),
    sb
      .from("market_quote_latest")
      .select("outcome_token_id", { count: "exact", head: true })
      .eq("stream_connected", false),
    sb
      .from("process_heartbeats")
      .select("*")
      .order("last_beat", { ascending: false })
      .limit(20),
    sb
      .from("ingest_runs")
      .select("source, job_type, status, started_at, completed_at, rows_written, error")
      .order("started_at", { ascending: false })
      .limit(20),
    sb
      .from("operator_actions")
      .select("actor, actor_email, auth_method, action, detail, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(20),
  ]);

  // Both of these queries named columns that do not exist until PR 12
  // fixed them: `process_heartbeats.updated_at` (the column is
  // `last_beat`) and `operator_actions.created_at` (it is `occurred_at`).
  // PostgREST returned an error, `.data` was null, and both panels
  // rendered as "0 processes, 0 stale, no audit trail" — which reads as
  // a healthy idle system.
  //
  // That is precisely the confusion this route exists to prevent: its
  // own docstring says a quiet market and a broken collector look
  // identical, and it had the bug in itself. So the errors are surfaced
  // now rather than swallowed. An empty panel and a failed query must
  // never look the same.
  const errors = Object.entries({
    quotes: quotes.error,
    stale: stale.error,
    disconnected: disconnected.error,
    heartbeats: heartbeats.error,
    ingestRuns: runs.error,
    auditTrail: lastAction.error,
  })
    .filter(([, e]) => e)
    .map(([name, e]) => ({ query: name, message: (e as { message: string }).message }));

  type Heartbeat = { process?: string; last_beat?: string };
  const beats = (heartbeats.data ?? []) as Heartbeat[];
  const staleBeats = beats.filter((b) => {
    if (!b.last_beat) return true;
    return now - Date.parse(b.last_beat) > HEARTBEAT_STALE_AFTER_S * 1000;
  });

  return NextResponse.json({
    ok: true,
    // Non-empty means a panel below is empty because its query failed,
    // not because there is nothing to report.
    queryErrors: errors,
    quotes: {
      tracked: quotes.count ?? 0,
      stale: stale.count ?? 0,
      staleAfterSeconds: STALE_AFTER_S,
      // Fresh rows but no live stream: prices are real and lagging,
      // which is a different problem from no prices at all.
      streamDisconnected: disconnected.count ?? 0,
    },
    heartbeats: {
      processes: beats.length,
      stale: staleBeats.length,
      staleAfterSeconds: HEARTBEAT_STALE_AFTER_S,
      recent: beats,
    },
    ingestRuns: runs.data ?? [],
    auditTrail: lastAction.data ?? [],
  });
}
