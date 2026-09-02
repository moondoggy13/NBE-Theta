import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Live tape: newest observed fills from venue_trades, enriched with the
 * wallet's identity/watchlist status and the market question. Powers
 * the right-hand pane of the Smart Money cockpit. Service-role only.
 *
 * `?wallet=0x…` filters to one wallet; `?watchlistOnly=true` hides
 * un-curated tape noise.
 */

interface TradeRow {
  source_trade_id: string;
  wallet: string;
  condition_id: string;
  outcome_token_id: string;
  side: string;
  price: number | string;
  quantity: number | string;
  notional: number | string;
  occurred_at: string;
  tx_hash: string | null;
}

export async function GET(req: Request) {
  // Every source table below is on the RLS deny-list. serverClient()
  // bypasses RLS, so without this check the deny-list protects nothing.
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;
  const sb = serverClient();
  if (!sb) return NextResponse.json([]);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 80), 250);
  const walletFilter = searchParams.get("wallet");
  const watchlistOnly = searchParams.get("watchlistOnly") === "true";

  let filtered = sb
    .from("venue_trades")
    .select(
      "source_trade_id, wallet, condition_id, outcome_token_id, side, price, quantity, " +
        "notional, occurred_at, tx_hash",
    );
  if (walletFilter) filtered = filtered.eq("wallet", walletFilter.toLowerCase());

  const { data: trades, error } = await filtered
    .order("occurred_at", { ascending: false })
    .limit(limit)
    .returns<TradeRow[]>();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  const rows = trades ?? [];
  if (rows.length === 0) return NextResponse.json([]);

  const wallets = [...new Set(rows.map((t) => String(t.wallet)))];
  const tokenIds = [...new Set(rows.map((t) => String(t.outcome_token_id)))];
  const conditionIds = [...new Set(rows.map((t) => String(t.condition_id)))];

  const [identities, watch, outcomes, markets] = await Promise.all([
    sb.from("wallets").select("address, pseudonym, display_name").in("address", wallets),
    sb.from("wallet_watchlist").select("wallet, status").in("wallet", wallets),
    sb
      .from("outcomes")
      .select("outcome_token_id, outcome_name")
      .in("outcome_token_id", tokenIds),
    sb.from("markets").select("condition_id, question").in("condition_id", conditionIds),
  ]);

  const identity = new Map(
    (identities.data ?? []).map((w) => [String(w.address), w] as const),
  );
  const watchStatus = new Map(
    (watch.data ?? []).map((w) => [String(w.wallet), String(w.status)] as const),
  );
  const outcomeName = new Map(
    (outcomes.data ?? []).map((o) => [String(o.outcome_token_id), String(o.outcome_name)]),
  );
  const question = new Map(
    (markets.data ?? []).map((m) => [String(m.condition_id), String(m.question)]),
  );

  const out = rows
    .filter((t) => !watchlistOnly || watchStatus.has(String(t.wallet)))
    .map((t) => {
      const w = String(t.wallet);
      const id = identity.get(w);
      return {
        id: String(t.source_trade_id),
        wallet: w,
        pseudonym:
          (id?.pseudonym as string | null) ?? (id?.display_name as string | null) ?? null,
        watchStatus: watchStatus.get(w) ?? null,
        side: String(t.side),
        outcome: outcomeName.get(String(t.outcome_token_id)) ?? null,
        price: Number(t.price),
        quantity: Number(t.quantity),
        notional: Number(t.notional),
        occurredAt: t.occurred_at,
        txHash: (t.tx_hash as string | null) ?? null,
        conditionId: String(t.condition_id),
        question: question.get(String(t.condition_id)) ?? null,
      };
    });

  return NextResponse.json(out);
}
