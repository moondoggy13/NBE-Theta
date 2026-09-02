import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";
import { assignTiers } from "@/lib/smart-money";

/**
 * Leader roster: every watchlisted wallet with identity, quality prior
 * (best recent leaderboard PnL), open-book aggregates from
 * wallet_positions, and recent-activity stats from venue_trades — plus
 * the top unwatched discovery candidates so promoting a new wallet is
 * one click. Service-role only (deny-anon source tables).
 */

const LB_LOOKBACK_DAYS = 8;
const ACTIVITY_LOOKBACK_DAYS = 30;
const ACTIVITY_FETCH_LIMIT = 8000;

interface LeaderRow {
  wallet: string;
  status: "watch" | "copy" | "mute";
  weight: number;
  note: string | null;
  pseudonym: string | null;
  displayName: string | null;
  profileImage: string | null;
  tier: "S" | "A" | "B";
  leaderboardPnl: number | null;
  leaderboardVol: number | null;
  openMarkets: number;
  openUsd: number;
  openCashPnl: number;
  trades30d: number;
  volume30d: number;
  lastActiveMs: number | null;
}

export async function GET(req: Request) {
  // Every source table below is on the RLS deny-list. serverClient()
  // bypasses RLS, so without this check the deny-list protects nothing.
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;
  const sb = serverClient();
  if (!sb) return NextResponse.json({ leaders: [], candidates: [] });

  const { data: watch, error: watchErr } = await sb
    .from("wallet_watchlist")
    .select("wallet, status, weight, note")
    .order("added_at", { ascending: true });
  if (watchErr) {
    return NextResponse.json({ ok: false, reason: watchErr.message }, { status: 500 });
  }
  const entries = watch ?? [];
  const wallets = entries.map((w) => String(w.wallet));

  const lbSince = new Date(Date.now() - LB_LOOKBACK_DAYS * 86_400_000).toISOString();
  const actSince = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * 86_400_000).toISOString();

  const [identities, lb, positions, trades, candidates] = await Promise.all([
    wallets.length
      ? sb
          .from("wallets")
          .select("address, pseudonym, display_name, profile_image")
          .in("address", wallets)
      : Promise.resolve({ data: [], error: null }),
    sb
      .from("leaderboard_snapshots")
      .select("wallet, rank_type, amount, captured_at")
      .gte("captured_at", lbSince),
    wallets.length
      ? sb
          .from("wallet_positions")
          .select("wallet, condition_id, current_value, cash_pnl, redeemable, size")
          .in("wallet", wallets)
      : Promise.resolve({ data: [], error: null }),
    wallets.length
      ? sb
          .from("venue_trades")
          .select("wallet, notional, occurred_at")
          .in("wallet", wallets)
          .gte("occurred_at", actSince)
          .order("occurred_at", { ascending: false })
          .limit(ACTIVITY_FETCH_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    sb
      .from("wallet_candidates")
      .select("address, source, priority_score, first_seen")
      .order("priority_score", { ascending: false })
      .limit(200),
  ]);

  const identity = new Map(
    (identities.data ?? []).map((w) => [String(w.address), w] as const),
  );

  // Best (max) recent leaderboard amount per wallet per rank type.
  const lbPnl = new Map<string, number>();
  const lbVol = new Map<string, number>();
  for (const row of lb.data ?? []) {
    const target = row.rank_type === "pnl" ? lbPnl : lbVol;
    const amount = Number(row.amount);
    const prev = target.get(String(row.wallet));
    if (prev == null || amount > prev) target.set(String(row.wallet), amount);
  }

  const openMarkets = new Map<string, Set<string>>();
  const openUsd = new Map<string, number>();
  const openPnl = new Map<string, number>();
  for (const p of positions.data ?? []) {
    const w = String(p.wallet);
    if (p.redeemable || !(Number(p.size) > 0)) continue;
    if (!openMarkets.has(w)) openMarkets.set(w, new Set());
    openMarkets.get(w)!.add(String(p.condition_id));
    openUsd.set(w, (openUsd.get(w) ?? 0) + Number(p.current_value ?? 0));
    openPnl.set(w, (openPnl.get(w) ?? 0) + Number(p.cash_pnl ?? 0));
  }

  const tradeCount = new Map<string, number>();
  const tradeVolume = new Map<string, number>();
  const lastActive = new Map<string, number>();
  for (const t of trades.data ?? []) {
    const w = String(t.wallet);
    tradeCount.set(w, (tradeCount.get(w) ?? 0) + 1);
    tradeVolume.set(w, (tradeVolume.get(w) ?? 0) + Number(t.notional ?? 0));
    if (!lastActive.has(w)) lastActive.set(w, Date.parse(String(t.occurred_at)));
  }

  const tiers = assignTiers(
    entries.map((e) => ({
      wallet: String(e.wallet),
      quality: lbPnl.get(String(e.wallet)) ?? 0,
    })),
  );

  const leaders: LeaderRow[] = entries.map((e) => {
    const w = String(e.wallet);
    const id = identity.get(w);
    return {
      wallet: w,
      status: e.status as LeaderRow["status"],
      weight: Number(e.weight),
      note: (e.note as string | null) ?? null,
      pseudonym: (id?.pseudonym as string | null) ?? null,
      displayName: (id?.display_name as string | null) ?? null,
      profileImage: (id?.profile_image as string | null) ?? null,
      tier: tiers.get(w) ?? "B",
      leaderboardPnl: lbPnl.get(w) ?? null,
      leaderboardVol: lbVol.get(w) ?? null,
      openMarkets: openMarkets.get(w)?.size ?? 0,
      openUsd: openUsd.get(w) ?? 0,
      openCashPnl: openPnl.get(w) ?? 0,
      trades30d: tradeCount.get(w) ?? 0,
      volume30d: tradeVolume.get(w) ?? 0,
      lastActiveMs: lastActive.get(w) ?? null,
    };
  });

  const watched = new Set(wallets);
  const topCandidates = (candidates.data ?? [])
    .filter((c) => !watched.has(String(c.address)))
    .slice(0, 15)
    .map((c) => ({
      wallet: String(c.address),
      source: String(c.source),
      priority: Number(c.priority_score),
      firstSeen: c.first_seen,
    }));

  return NextResponse.json({ leaders, candidates: topCandidates });
}
