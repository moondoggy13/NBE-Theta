import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Signal feed + the shadow-gate headline.
 *
 * Two numbers decide whether copy trading is viable, and this route is
 * where an operator reads them:
 *
 *   fill rate among QUALIFIED signals — having decided we want a trade,
 *     how often do we actually get it at an acceptable price;
 *   the rejection histogram — and when we don't, what stopped us.
 *
 * A histogram dominated by `price_cap` or `freshness` says we are losing
 * the latency race against the wallets we follow, and better wallet
 * selection will not fix it. One dominated by `depth` says our sources
 * trade markets too thin to mirror at our size. Both are product
 * answers, which is why they are the first thing this returns rather
 * than a footnote under a list of accepted trades.
 *
 * Every source table here is on the RLS deny-list; the gate above is the
 * only thing between them and the internet (see src/lib/auth.ts).
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(req: Request) {
  const auth = requireOperator(req);
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
  const acceptedOnly = url.searchParams.get("accepted") === "true";

  let feedQuery = sb
    .from("signal_evaluations")
    .select(
      "id, wallet, cluster_key, condition_id, outcome_token_id, side, evaluated_at, " +
        "policy_version, accepted, reject_reason, intended_quantity, intended_notional, " +
        "limit_price, detection_latency_s, gates",
    )
    .order("evaluated_at", { ascending: false })
    .limit(limit);
  if (acceptedOnly) feedQuery = feedQuery.eq("accepted", true);

  const [feed, reasons, fills] = await Promise.all([
    feedQuery,
    sb
      .from("signal_evaluations")
      .select("reject_reason")
      .eq("accepted", false)
      .not("reject_reason", "is", null)
      .limit(20000),
    sb.from("shadow_fills").select("filled, slippage_vs_source").limit(20000),
  ]);

  if (feed.error) {
    return NextResponse.json({ ok: false, reason: feed.error.message }, { status: 500 });
  }

  // Histogram in the route rather than SQL: the row count is bounded by
  // the shadow window and this keeps the query surface small. If it ever
  // outgrows that, it becomes a materialised view, not a bigger fetch.
  const histogram = new Map<string, number>();
  for (const row of reasons.data ?? []) {
    const key = (row as { reject_reason: string }).reject_reason;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  const fillRows = (fills.data ?? []) as {
    filled: boolean;
    slippage_vs_source: number | null;
  }[];
  const attempted = fillRows.length;
  const filled = fillRows.filter((r) => r.filled).length;
  const slippages = fillRows
    .filter((r) => r.filled && r.slippage_vs_source !== null)
    .map((r) => Number(r.slippage_vs_source));

  return NextResponse.json({
    ok: true,
    headline: {
      ordersAttempted: attempted,
      ordersFilled: filled,
      // null, not 0: no attempts is "unmeasured", and a 0% fill rate is
      // a very different claim from having placed nothing yet.
      fillRate: attempted > 0 ? filled / attempted : null,
      meanSlippageVsSource:
        slippages.length > 0
          ? slippages.reduce((a, b) => a + b, 0) / slippages.length
          : null,
    },
    rejectHistogram: [...histogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
    feed: feed.data ?? [],
  });
}
