import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";
import {
  computeFlows,
  type PositionRow,
  type WatchWeight,
} from "@/lib/smart-money";

/**
 * Conviction Board data: per-market consensus of watchlisted wallets.
 * Server-side (service-role) because wallet_positions / venue_trades /
 * wallet_watchlist are deny-anon raw intel — the browser never touches
 * them directly.
 *
 * Populated by `theta-live-monitor` (positions + trades) after
 * `theta-wallet-backfill discover --promote-top N` seeds the watchlist.
 */

interface DbPositionRow {
  wallet: string;
  condition_id: string;
  outcome_token_id: string;
  outcome_name: string | null;
  outcome_index: number | null;
  size: number | string;
  avg_price: number | string | null;
  cur_price: number | string | null;
  initial_value: number | string | null;
  current_value: number | string | null;
  cash_pnl: number | string | null;
  redeemable: boolean;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  end_date: string | null;
  captured_at: string;
}

interface DbTradeStamp {
  wallet: string;
  condition_id: string;
  occurred_at: string;
}

interface DbIdentity {
  address: string;
  pseudonym: string | null;
  display_name: string | null;
}

const TRADE_LOOKBACK_DAYS = 14;
const TRADE_FETCH_LIMIT = 4000;

export async function GET(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json([]);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 40), 200);
  const minUsd = Math.max(Number(searchParams.get("minUsd") ?? 0), 0);

  const { data: watch, error: watchErr } = await sb
    .from("wallet_watchlist")
    .select("wallet, status, weight")
    .in("status", ["watch", "copy"]);
  if (watchErr) {
    return NextResponse.json({ ok: false, reason: watchErr.message }, { status: 500 });
  }
  const weights = new Map<string, WatchWeight>(
    (watch ?? []).map((w) => [
      String(w.wallet),
      { weight: Number(w.weight), status: w.status as WatchWeight["status"] },
    ]),
  );
  if (weights.size === 0) return NextResponse.json([]);
  const wallets = [...weights.keys()];

  const [positionsRes, tradesRes, identitiesRes] = await Promise.all([
    sb
      .from("wallet_positions")
      .select(
        "wallet, condition_id, outcome_token_id, outcome_name, outcome_index, size, " +
          "avg_price, cur_price, initial_value, current_value, cash_pnl, redeemable, " +
          "title, slug, event_slug, end_date, captured_at",
      )
      .in("wallet", wallets)
      .returns<DbPositionRow[]>(),
    sb
      .from("venue_trades")
      .select("wallet, condition_id, occurred_at")
      .in("wallet", wallets)
      .gte(
        "occurred_at",
        new Date(Date.now() - TRADE_LOOKBACK_DAYS * 86_400_000).toISOString(),
      )
      .order("occurred_at", { ascending: false })
      .limit(TRADE_FETCH_LIMIT)
      .returns<DbTradeStamp[]>(),
    sb
      .from("wallets")
      .select("address, pseudonym, display_name")
      .in("address", wallets)
      .returns<DbIdentity[]>(),
  ]);
  if (positionsRes.error) {
    return NextResponse.json({ ok: false, reason: positionsRes.error.message }, { status: 500 });
  }

  const lastTradeAt = new Map<string, number>();
  for (const t of tradesRes.data ?? []) {
    const key = `${t.wallet}|${t.condition_id}`;
    const ms = Date.parse(String(t.occurred_at));
    if (!lastTradeAt.has(key)) lastTradeAt.set(key, ms); // rows are newest-first
  }
  const pseudonyms = new Map<string, string | null>(
    (identitiesRes.data ?? []).map((w) => [String(w.address), w.pseudonym ?? w.display_name]),
  );

  const rows = computeFlows(
    (positionsRes.data ?? []).map((p) => ({
      ...p,
      wallet: String(p.wallet),
      size: Number(p.size),
      avg_price: p.avg_price == null ? null : Number(p.avg_price),
      cur_price: p.cur_price == null ? null : Number(p.cur_price),
      initial_value: p.initial_value == null ? null : Number(p.initial_value),
      current_value: p.current_value == null ? null : Number(p.current_value),
      cash_pnl: p.cash_pnl == null ? null : Number(p.cash_pnl),
    })) as PositionRow[],
    weights,
    lastTradeAt,
    pseudonyms,
    { nowMs: Date.now(), minTotalUsd: minUsd },
  );

  return NextResponse.json(rows.slice(0, limit));
}
