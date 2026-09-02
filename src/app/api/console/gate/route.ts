import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Recorded shadow-gate decision packets.
 *
 * Read-only, and deliberately so. The packet is produced by
 * `theta-signals gate --record`, in the Python worker that owns the
 * statistics — this route only shows what was recorded. Letting the
 * console *compute* a verdict would put a second implementation of the
 * promotion criteria in the codebase, and two implementations of a
 * safety condition means one of them is wrong and nobody knows which.
 *
 * `latestPass` is what `/api/console/mode` enforces against. It is
 * returned separately from `runs[0]` because they are different
 * questions: the newest run tells an operator where the shadow period
 * currently stands, and the newest *passing* run is the thing that
 * authorises live trading. A gate that passed last month and fails
 * today still authorises promotion under the rule as written — see
 * ADR-0003 for why that is intentional and what bounds it.
 *
 * `shadow_gate_runs` is on the RLS deny-list; the operator gate above is
 * the only thing between it and the internet (see src/lib/auth.ts).
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const COLUMNS =
  "id, evaluated_at, window_start, window_end, verdict, criteria, headline, " +
  "policy_versions, note, created_by";

export async function GET(req: Request) {
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT),
  );

  const [history, passing] = await Promise.all([
    sb
      .from("shadow_gate_runs")
      .select(COLUMNS)
      .order("evaluated_at", { ascending: false })
      .limit(limit),
    sb
      .from("shadow_gate_runs")
      .select(COLUMNS)
      .eq("verdict", "pass")
      .order("evaluated_at", { ascending: false })
      .limit(1),
  ]);

  if (history.error) {
    return NextResponse.json({ ok: false, reason: history.error.message }, { status: 500 });
  }

  const runs = (history.data ?? []) as unknown as Record<string, unknown>[];
  // Fail closed on the second query too: an error is not a "no passing
  // run", it is "we could not tell", and both must read as unauthorised
  // rather than one of them reading as authorised.
  const passRows = passing.error ? [] : ((passing.data ?? []) as unknown as Record<string, unknown>[]);

  return NextResponse.json({
    ok: true,
    latest: runs[0] ?? null,
    latestPass: passRows[0] ?? null,
    authorisesLive: passRows.length > 0,
    runs,
  });
}
