import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";
import { serverClient } from "@/lib/supabase/client";

/**
 * Watchlist control route — the operator's curation surface for which
 * wallets the platform follows (and, later, copies).
 *
 * GET returns the list. POST upserts one entry:
 *   { wallet, status?: 'watch'|'copy'|'mute', weight?: 0..10, note? }
 *
 * **Both verbs are gated.** GET used to be open on the reasoning that
 * reads are harmless, which is wrong here: `wallet_watchlist` is on the
 * RLS deny-list because the set of wallets we follow *is* the thesis,
 * and this route reads it with the service-role key that bypasses RLS.
 * See `src/lib/auth.ts`.
 *
 * Every accepted mutation writes an operator_actions audit row.
 */

interface Body {
  wallet?: string;
  status?: "watch" | "copy" | "mute";
  weight?: number;
  note?: string | null;
}

const STATUSES = new Set(["watch", "copy", "mute"]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const auth = requireOperator(req);
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) return NextResponse.json([]);
  const { data, error } = await sb
    .from("wallet_watchlist")
    .select("wallet, status, weight, note, added_by, added_at, updated_at")
    .order("added_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  const auth = requireOperator(req);
  if (!auth.ok) return auth.response;

  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }

  const body = (await req.json()) as Body;
  const wallet = (body.wallet ?? "").toLowerCase();
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ ok: false, reason: "invalid wallet address" }, { status: 400 });
  }
  if (body.status !== undefined && !STATUSES.has(body.status)) {
    return NextResponse.json({ ok: false, reason: "invalid status" }, { status: 400 });
  }
  if (
    body.weight !== undefined &&
    !(Number.isFinite(body.weight) && body.weight >= 0 && body.weight <= 10)
  ) {
    return NextResponse.json({ ok: false, reason: "weight must be 0..10" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {
    wallet,
    updated_at: new Date().toISOString(),
  };
  if (body.status !== undefined) patch.status = body.status;
  if (body.weight !== undefined) patch.weight = body.weight;
  if (body.note !== undefined) patch.note = body.note;
  if (patch.status === undefined) patch.status = "watch"; // insert default
  patch.added_by = "operator";

  const { data, error } = await sb
    .from("wallet_watchlist")
    .upsert(patch, { onConflict: "wallet" })
    .select()
    .single();
  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });

  await sb.from("operator_actions").insert({
    actor: "dashboard",
    action: "watchlist_upsert",
    detail: { wallet, status: patch.status, weight: body.weight, note: body.note },
  });

  return NextResponse.json({ ok: true, entry: data });
}

