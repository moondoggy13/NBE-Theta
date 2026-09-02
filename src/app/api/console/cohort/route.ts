import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Who we follow, and why not.
 *
 * The exclusions are as important as the feeder set. "Why is the feeder
 * set empty?" is the first question an operator asks, and the answer is
 * almost never "no wallets exist" — it is a specific gate rejecting
 * almost everyone. If 900 of 1,000 wallets fail `copyability_measured`,
 * the problem is our quote coverage, not the wallets.
 *
 * So this returns the roster AND the exclusion histogram, from the most
 * recent cohort run under the active policy. `wallet_cohort` and
 * `wallet_copyability_snapshots` are both on the RLS deny-list.
 */

export async function GET(req: Request) {
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const latest = await sb
    .from("wallet_cohort")
    .select("as_of, policy_version")
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest.error) {
    return NextResponse.json({ ok: false, reason: latest.error.message }, { status: 500 });
  }
  if (!latest.data) {
    // No run yet is a legitimate state, not an error — say so plainly
    // rather than returning an empty roster that looks like "everyone
    // was rejected".
    return NextResponse.json({
      ok: true,
      asOf: null,
      policyVersion: null,
      note: "no cohort run recorded yet",
      feeder: [],
      cohort: [],
      exclusions: [],
    });
  }

  const { as_of: asOf, policy_version: policyVersion } = latest.data as {
    as_of: string;
    policy_version: string;
  };

  const rows = await sb
    .from("wallet_cohort")
    .select(
      "wallet, status, cluster_key, skill_score, copyability, rank_score, rank, " +
        "n_active_days, n_closed_markets, traded_notional, reason, checks",
    )
    .eq("as_of", asOf)
    .eq("policy_version", policyVersion)
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(2000);

  if (rows.error) {
    return NextResponse.json({ ok: false, reason: rows.error.message }, { status: 500 });
  }

  type Row = {
    wallet: string;
    status: string;
    reason: string | null;
    rank: number | null;
  };
  const all = (rows.data ?? []) as unknown as Row[];

  const histogram = new Map<string, number>();
  for (const r of all) {
    if (r.status === "excluded" && r.reason) {
      histogram.set(r.reason, (histogram.get(r.reason) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    ok: true,
    asOf,
    policyVersion,
    counts: {
      feeder: all.filter((r) => r.status === "feeder").length,
      cohort: all.filter((r) => r.status === "cohort").length,
      excluded: all.filter((r) => r.status === "excluded").length,
    },
    feeder: all.filter((r) => r.status === "feeder"),
    cohort: all.filter((r) => r.status === "cohort"),
    exclusions: [...histogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
  });
}
