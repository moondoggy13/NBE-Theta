import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Portfolio: lots with source attribution, concentration, realised P&L.
 *
 * Attribution is the column that matters. "We hold 4,000 units of this
 * outcome" is not actionable; "we hold it because these three sources
 * bought it, and this is what we'd sell if the first one cuts" is. It is
 * also what makes the exit rule auditable — a lot that cannot name the
 * source that opened it cannot be mirrored correctly.
 *
 * `mode` separates shadow from live so the two portfolios never mix. A
 * shadow lot must never be counted toward live exposure.
 */

export async function GET(req: Request) {
  const auth = requireOperator(req);
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "live" ? "live" : "shadow";

  const lots = await sb
    .from("strategy_lots")
    .select(
      "id, mode, source_wallet, source_cluster_key, condition_id, outcome_token_id, " +
        "side, opened_at, entry_price, quantity_opened, quantity_open, fees_paid, " +
        "realized_pnl, status, closed_at, settled_at, settlement_price",
    )
    .eq("mode", mode)
    .order("opened_at", { ascending: false })
    .limit(2000);

  if (lots.error) {
    return NextResponse.json({ ok: false, reason: lots.error.message }, { status: 500 });
  }

  type Lot = {
    condition_id: string;
    source_wallet: string;
    source_cluster_key: string | null;
    entry_price: number;
    quantity_open: number;
    realized_pnl: number;
    fees_paid: number;
    status: string;
  };
  const rows = (lots.data ?? []) as unknown as Lot[];
  const open = rows.filter((l) => l.status === "open");

  const byMarket = new Map<string, number>();
  const byCluster = new Map<string, number>();
  for (const l of open) {
    const cost = Number(l.entry_price) * Number(l.quantity_open);
    byMarket.set(l.condition_id, (byMarket.get(l.condition_id) ?? 0) + cost);
    const key = l.source_cluster_key ?? l.source_wallet;
    byCluster.set(key, (byCluster.get(key) ?? 0) + cost);
  }

  const openCost = [...byMarket.values()].reduce((a, b) => a + b, 0);
  const realized = rows.reduce((a, l) => a + Number(l.realized_pnl), 0);
  const fees = rows.reduce((a, l) => a + Number(l.fees_paid), 0);

  return NextResponse.json({
    ok: true,
    mode,
    totals: {
      lots: rows.length,
      openLots: open.length,
      openCost,
      realizedPnl: realized,
      feesPaid: fees,
    },
    concentration: {
      byMarket: [...byMarket.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([conditionId, cost]) => ({
          conditionId,
          cost,
          share: openCost > 0 ? cost / openCost : null,
        })),
      // Cluster, not wallet: five wallets from one desk are one
      // concentration, and reporting them separately would understate it
      // by a factor of five.
      byCluster: [...byCluster.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([clusterKey, cost]) => ({
          clusterKey,
          cost,
          share: openCost > 0 ? cost / openCost : null,
        })),
    },
    lots: rows,
  });
}
