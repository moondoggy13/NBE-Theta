"use client";

import { useMemo, useState } from "react";
import { GlassPanel } from "../GlassPanel";
import { usePollJson } from "@/hooks/use-poll-json";
import { useNow } from "@/hooks/use-now";
import { formatCompactCurrency } from "@/lib/formatters";

/**
 * Smart Money cockpit — the copy-trading decision surface.
 *
 * Layout mirrors the operator's workflow, left to right:
 *   WHO   (Leader Roster)    — the wallets we follow, tiered by quality.
 *   WHAT  (Conviction Board) — markets ranked by weighted smart-money
 *          consensus; each card's price rail shows every tracked entry
 *          against the current price, so "who's in, which side, at what
 *          price, and how late am I" is one glance.
 *   NOW   (Live Tape)        — observed fills streaming in.
 *
 * All data flows through service-role /api/smart-money/* routes; the
 * browser never reads the raw-intel tables.
 */

// ── API shapes (mirror the route payloads) ────────────────────────

interface LeaderRow {
  wallet: string;
  status: "watch" | "copy" | "mute";
  weight: number;
  pseudonym: string | null;
  displayName: string | null;
  tier: "S" | "A" | "B";
  leaderboardPnl: number | null;
  openMarkets: number;
  openUsd: number;
  openCashPnl: number;
  trades30d: number;
  volume30d: number;
  lastActiveMs: number | null;
}

interface CandidateRow {
  wallet: string;
  source: string;
  priority: number;
}

interface LeadersPayload {
  leaders: LeaderRow[];
  candidates: CandidateRow[];
}

interface WalletStake {
  wallet: string;
  pseudonym: string | null;
  entryPrice: number | null;
  usd: number;
  cashPnl: number;
}

interface SideAggregate {
  outcome: string;
  wallets: number;
  usd: number;
  score: number;
  avgEntry: number | null;
  curPrice: number | null;
  stakes: WalletStake[];
}

interface FlowRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  endDate: string | null;
  conviction: number;
  dominant: SideAggregate;
  opposing: SideAggregate | null;
  freshestMs: number;
  totalUsd: number;
}

interface TapeRow {
  id: string;
  wallet: string;
  pseudonym: string | null;
  watchStatus: string | null;
  side: string;
  outcome: string | null;
  price: number;
  notional: number;
  occurredAt: string;
  question: string | null;
}

// ── helpers ───────────────────────────────────────────────────────

function timeAgo(ms: number | null, now: number): string {
  if (!ms) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function durationIn(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function isYes(outcome: string): boolean {
  return outcome.trim().toLowerCase() === "yes";
}

const TIER_STYLE: Record<"S" | "A" | "B", string> = {
  S: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300",
  A: "bg-sky-100 text-sky-700 border-sky-300",
  B: "bg-slate-100 text-slate-500 border-slate-200",
};

const NEXT_STATUS: Record<string, "watch" | "copy" | "mute"> = {
  watch: "copy",
  copy: "mute",
  mute: "watch",
};

const STATUS_STYLE: Record<string, string> = {
  watch: "bg-sky-50 text-sky-600 border-sky-200",
  copy: "bg-emerald-50 text-emerald-600 border-emerald-300",
  mute: "bg-slate-50 text-slate-400 border-slate-200",
};

async function postWatchlist(body: Record<string, unknown>): Promise<void> {
  await fetch("/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── main tab ──────────────────────────────────────────────────────

export function SmartMoneyTab() {
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [watchlistOnly, setWatchlistOnly] = useState(true);

  const { data: leadersData } = usePollJson<LeadersPayload>("/api/smart-money/leaders", 30_000);
  const { data: flowsData } = usePollJson<FlowRow[]>("/api/smart-money/flows?limit=40", 15_000);
  const tapeUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: "80" });
    if (selectedWallet) params.set("wallet", selectedWallet);
    if (watchlistOnly && !selectedWallet) params.set("watchlistOnly", "true");
    return `/api/smart-money/tape?${params}`;
  }, [selectedWallet, watchlistOnly]);
  const { data: tapeData } = usePollJson<TapeRow[]>(tapeUrl, 5_000);

  const leaders = leadersData?.leaders ?? [];
  const candidates = leadersData?.candidates ?? [];
  const flows = Array.isArray(flowsData) ? flowsData : [];
  const tape = Array.isArray(tapeData) ? tapeData : [];

  const empty = leaders.length === 0 && flows.length === 0;

  return (
    <div className="h-full flex gap-4">
      {/* WHO — Leader roster */}
      <GlassPanel title="Leaders" className="w-[19rem] shrink-0 h-full bg-white/40 flex flex-col">
        <div className="overflow-y-auto custom-scrollbar -mr-3 pr-3 space-y-2 h-full">
          {leaders.length === 0 && (
            <EmptyHint
              lines={[
                "No wallets tracked yet.",
                "theta-wallet-backfill discover --promote-top 25",
              ]}
            />
          )}
          {leaders.map((l) => (
            <LeaderCard
              key={l.wallet}
              leader={l}
              selected={selectedWallet === l.wallet}
              onSelect={() =>
                setSelectedWallet(selectedWallet === l.wallet ? null : l.wallet)
              }
            />
          ))}
          {candidates.length > 0 && (
            <>
              <div className="pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-slate-400">
                Discovery queue
              </div>
              {candidates.slice(0, 8).map((c) => (
                <div
                  key={c.wallet}
                  className="flex items-center justify-between rounded-xl border border-dashed border-slate-200 bg-white/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] font-mono text-slate-600 truncate">
                      {shortAddr(c.wallet)}
                    </div>
                    <div className="text-[9px] font-mono text-slate-400">
                      {c.source} · {formatCompactCurrency(c.priority)}
                    </div>
                  </div>
                  <button
                    onClick={() => void postWatchlist({ wallet: c.wallet, status: "watch" })}
                    className="text-[10px] font-mono px-2 py-1 rounded-full border border-sky-200 text-sky-600 bg-sky-50 hover:bg-sky-100 shrink-0"
                  >
                    + watch
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </GlassPanel>

      {/* WHAT — Conviction board */}
      <GlassPanel
        title="Conviction Board — smart-money consensus"
        className="flex-1 h-full bg-white/40 flex flex-col min-w-0"
        withCorners
      >
        <div className="overflow-y-auto custom-scrollbar -mr-3 pr-3 space-y-3 h-full">
          {empty && (
            <EmptyHint
              lines={[
                "The board fills as tracked-wallet data lands:",
                "1. theta-wallet-backfill discover --promote-top 25",
                "2. theta-wallet-backfill run",
                "3. theta-live-monitor run",
              ]}
            />
          )}
          {!empty && flows.length === 0 && (
            <div className="text-center text-xs font-mono text-slate-400 py-16">
              No open smart-money positions yet — the monitor refreshes positions every few
              minutes.
            </div>
          )}
          {flows.map((f) => (
            <ConvictionCard key={f.conditionId} flow={f} />
          ))}
        </div>
      </GlassPanel>

      {/* NOW — Live tape */}
      <GlassPanel title="Live Tape" className="w-[21rem] shrink-0 h-full bg-white/40 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-mono text-slate-500 truncate">
            {selectedWallet ? `filter: ${shortAddr(selectedWallet)}` : `${tape.length} fills`}
          </div>
          {selectedWallet ? (
            <button
              onClick={() => setSelectedWallet(null)}
              className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            >
              clear
            </button>
          ) : (
            <button
              onClick={() => setWatchlistOnly((v) => !v)}
              className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            >
              {watchlistOnly ? "watchlist" : "all wallets"}
            </button>
          )}
        </div>
        <div className="overflow-y-auto custom-scrollbar -mr-3 pr-3 space-y-1.5 h-full">
          {tape.length === 0 && (
            <EmptyHint lines={["Tape is empty.", "theta-live-monitor run"]} />
          )}
          {tape.map((t) => (
            <TapeLine key={t.id} row={t} onWallet={() => setSelectedWallet(t.wallet)} />
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}

// ── leader card ───────────────────────────────────────────────────

function LeaderCard({
  leader,
  selected,
  onSelect,
}: {
  leader: LeaderRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useNow();
  const name = leader.pseudonym ?? leader.displayName ?? shortAddr(leader.wallet);
  return (
    <div
      className={`rounded-2xl border px-3 py-2.5 cursor-pointer transition-all ${
        selected
          ? "border-fuchsia-300 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
          : "border-white/70 bg-white/50 hover:bg-white/80"
      } ${leader.status === "mute" ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span
          className={`px-1.5 rounded-md border text-[10px] font-mono font-semibold ${TIER_STYLE[leader.tier]}`}
        >
          {leader.tier}
        </span>
        <span className="text-xs font-medium text-slate-800 truncate flex-1" title={leader.wallet}>
          {name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void postWatchlist({
              wallet: leader.wallet,
              status: NEXT_STATUS[leader.status],
            });
          }}
          className={`text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_STYLE[leader.status]}`}
          title="cycle watch → copy → mute"
        >
          {leader.status}
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1 text-[9px] font-mono text-slate-500">
        <div>
          <div className="text-slate-400">LB PNL</div>
          <div className="text-slate-700">
            {leader.leaderboardPnl != null ? formatCompactCurrency(leader.leaderboardPnl) : "—"}
          </div>
        </div>
        <div>
          <div className="text-slate-400">OPEN</div>
          <div className="text-slate-700">
            {formatCompactCurrency(leader.openUsd)}
            <span className="text-slate-400"> ·{leader.openMarkets}</span>
          </div>
        </div>
        <div>
          <div className="text-slate-400">30D</div>
          <div className="text-slate-700">
            {leader.trades30d}
            <span className="text-slate-400"> · {timeAgo(leader.lastActiveMs, now)}</span>
          </div>
        </div>
      </div>
      <div
        className={`mt-1 text-[9px] font-mono ${
          leader.openCashPnl >= 0 ? "text-emerald-600" : "text-rose-500"
        }`}
      >
        open P&L {leader.openCashPnl >= 0 ? "+" : ""}
        {formatCompactCurrency(leader.openCashPnl)}
      </div>
    </div>
  );
}

// ── conviction card + price rail ──────────────────────────────────

function ConvictionCard({ flow }: { flow: FlowRow }) {
  const now = useNow();
  const d = flow.dominant;
  const yes = isYes(d.outcome);
  const sideColor = yes ? "text-emerald-600" : "text-rose-500";
  const drift =
    d.curPrice != null && d.avgEntry != null ? d.curPrice - d.avgEntry : null;
  const closesIn = flow.endDate ? Date.parse(flow.endDate) - now : null;

  return (
    <div className="rounded-2xl border border-white/70 bg-white/60 px-4 py-3 hover:bg-white/85 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-slate-800 font-medium truncate" title={flow.title ?? ""}>
            {flow.title ?? flow.conditionId.slice(0, 18)}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-500">
            <span className={`font-semibold ${sideColor}`}>{d.outcome.toUpperCase()}</span>
            {" · "}
            {d.wallets} wallet{d.wallets === 1 ? "" : "s"} · {formatCompactCurrency(d.usd)}
            {flow.opposing && flow.opposing.usd > 0 && (
              <span className="text-slate-400">
                {" "}
                vs {flow.opposing.outcome} {formatCompactCurrency(flow.opposing.usd)}
              </span>
            )}
            {" · "}
            <span className="text-slate-400">fresh {timeAgo(flow.freshestMs, now)}</span>
            {closesIn != null && closesIn > 0 && (
              <span className="text-slate-400"> · closes in {durationIn(closesIn)}</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] font-mono uppercase tracking-widest text-slate-400">
            conviction
          </div>
          <div className="text-xl font-semibold tabular-nums text-slate-800">
            {flow.conviction.toFixed(1)}
          </div>
        </div>
      </div>

      <PriceRail side={d} yes={yes} />

      <div className="mt-1 flex items-center justify-between text-[10px] font-mono">
        <div className="text-slate-500">
          avg entry{" "}
          <span className="text-slate-700">{d.avgEntry != null ? d.avgEntry.toFixed(2) : "—"}</span>
          {" → now "}
          <span className="text-slate-700">{d.curPrice != null ? d.curPrice.toFixed(2) : "—"}</span>
          {drift != null && (
            <span className={drift * (yes ? 1 : -1) >= 0 ? "text-emerald-600" : "text-amber-600"}>
              {" "}
              ({drift >= 0 ? "+" : ""}
              {(drift * 100).toFixed(0)}¢)
            </span>
          )}
        </div>
        <div className="text-slate-400 truncate max-w-[45%]">
          {d.stakes
            .slice(0, 3)
            .map((s) => s.pseudonym ?? shortAddr(s.wallet))
            .join(" · ")}
          {d.stakes.length > 3 ? ` +${d.stakes.length - 3}` : ""}
        </div>
      </div>
    </div>
  );
}

/**
 * The signature viz: a 0→1 probability rail. Dots are tracked wallets'
 * average entries (area ∝ dollars); the vertical bar is the current
 * price; the band between weighted-avg entry and current price shades
 * green when the market has moved the smart money's way, amber when
 * against — i.e. "how much of their edge already played out".
 */
function PriceRail({ side, yes }: { side: SideAggregate; yes: boolean }) {
  const W = 100; // viewBox units; renders full-width
  const H = 12;
  const x = (p: number) => Math.min(1, Math.max(0, p)) * W;
  const maxUsd = Math.max(1, ...side.stakes.map((s) => s.usd));
  const dotColor = yes ? "fill-emerald-500" : "fill-rose-400";
  const favorable =
    side.curPrice != null && side.avgEntry != null
      ? (side.curPrice - side.avgEntry) * (yes ? 1 : -1) >= 0
      : true;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-7 mt-2"
      aria-label="price rail"
    >
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="stroke-slate-200" strokeWidth={0.6} />
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1={x(t)}
          y1={H / 2 - 1.6}
          x2={x(t)}
          y2={H / 2 + 1.6}
          className="stroke-slate-300"
          strokeWidth={0.4}
        />
      ))}
      {side.avgEntry != null && side.curPrice != null && (
        <rect
          x={Math.min(x(side.avgEntry), x(side.curPrice))}
          y={H / 2 - 1.2}
          width={Math.max(0.5, Math.abs(x(side.curPrice) - x(side.avgEntry)))}
          height={2.4}
          className={favorable ? "fill-emerald-200/80" : "fill-amber-200/80"}
        />
      )}
      {side.stakes.map(
        (s, i) =>
          s.entryPrice != null && (
            <circle
              key={`${s.wallet}-${i}`}
              cx={x(s.entryPrice)}
              cy={H / 2}
              r={1.2 + 2.6 * Math.sqrt(s.usd / maxUsd)}
              className={`${dotColor} opacity-60`}
            >
              <title>
                {(s.pseudonym ?? shortAddr(s.wallet)) +
                  ` · ${s.entryPrice.toFixed(2)} · ` +
                  formatCompactCurrency(s.usd)}
              </title>
            </circle>
          ),
      )}
      {side.curPrice != null && (
        <rect
          x={x(side.curPrice) - 0.35}
          y={0.5}
          width={0.7}
          height={H - 1}
          rx={0.3}
          className="fill-slate-700"
        />
      )}
    </svg>
  );
}

// ── tape line ─────────────────────────────────────────────────────

function TapeLine({ row, onWallet }: { row: TapeRow; onWallet: () => void }) {
  const now = useNow();
  const yes = row.outcome ? isYes(row.outcome) : row.side === "BUY";
  const big = row.notional >= 5000;
  return (
    <div
      className={`rounded-xl px-2.5 py-1.5 border text-[10px] font-mono flex items-center gap-2 ${
        big ? "border-fuchsia-200 bg-fuchsia-50/60" : "border-white/60 bg-white/40"
      }`}
    >
      <span className="text-slate-400 w-7 shrink-0">
        {timeAgo(Date.parse(row.occurredAt), now)}
      </span>
      <button
        onClick={onWallet}
        className="text-slate-700 hover:text-fuchsia-600 truncate w-20 text-left shrink-0"
        title={row.wallet}
      >
        {row.pseudonym ?? shortAddr(row.wallet)}
      </button>
      <span
        className={`px-1.5 rounded-md border text-[9px] shrink-0 ${
          row.side === "BUY"
            ? yes
              ? "bg-emerald-50 text-emerald-600 border-emerald-200"
              : "bg-rose-50 text-rose-500 border-rose-200"
            : "bg-slate-50 text-slate-500 border-slate-200"
        }`}
      >
        {row.side} {row.outcome?.toUpperCase() ?? ""}
      </span>
      <span className="text-slate-500 shrink-0">{row.price.toFixed(2)}</span>
      <span className={`shrink-0 ${big ? "text-fuchsia-700 font-semibold" : "text-slate-700"}`}>
        {formatCompactCurrency(row.notional)}
      </span>
      <span className="text-slate-400 truncate" title={row.question ?? ""}>
        {row.question ?? ""}
      </span>
    </div>
  );
}

// ── empty state ───────────────────────────────────────────────────

function EmptyHint({ lines }: { lines: string[] }) {
  return (
    <div className="text-center text-[11px] font-mono text-slate-400 py-10 space-y-1.5">
      {lines.map((l, i) =>
        l.startsWith("theta-") || /^\d\./.test(l) ? (
          <div key={i}>
            <code className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{l}</code>
          </div>
        ) : (
          <div key={i}>{l}</div>
        ),
      )}
    </div>
  );
}
