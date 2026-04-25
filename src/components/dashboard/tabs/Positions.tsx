"use client";

import { CircleDot, Clock } from "lucide-react";
import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";
import { usePollJson } from "@/hooks/use-poll-json";
import { formatCurrency } from "@/lib/formatters";

interface Position {
  symbol: string;
  qty: number;
  avg_entry: number;
  unrealized_pnl: number;
  realized_pnl: number;
  opened_at: string | null;
  updated_at: string;
}

interface Order {
  id: string;
  mode: string;
  symbol: string;
  side: string;
  type: string;
  qty: number;
  price: number | null;
  status: string;
  submitted_at: string;
  filled_price: number | null;
  filled_qty: number;
  fees: number;
  strategy_id: string | null;
}

interface StrategySignal {
  id: string;
  ts: string;
  strategy_id: string;
  side: "long" | "short" | "flat";
  score: number;
  confidence: number;
  entry_hint: { price: number; stop: number; target: number } | null;
}

interface PriceResp { price: number | null }

export function PositionsTab() {
  const { rows: positions } = useRealtime<Position>({
    table: "positions",
    initialFetch: { order: { column: "updated_at" }, limit: 10 },
  });
  const { rows: orders } = useRealtime<Order>({
    table: "orders",
    initialFetch: { order: { column: "submitted_at" }, limit: 30 },
  });
  const { rows: signals } = useRealtime<StrategySignal>({
    table: "strategy_signals",
    initialFetch: { order: { column: "ts" }, limit: 20 },
  });
  const { data: priceResp } = usePollJson<PriceResp>("/api/price", 2000);
  const livePrice = priceResp?.price ?? null;

  const ensembleLatest = signals.find((s) => s.strategy_id === "ensemble");
  const lastEntryHint = signals.find((s) => s.entry_hint && s.side !== "flat");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
      <GlassPanel title="Open Positions" className="lg:col-span-2 flex flex-col gap-4">
        {positions.length === 0 ? (
          <PositionEmptyState
            ensembleLatest={ensembleLatest}
            lastEntryHint={lastEntryHint}
            livePrice={livePrice}
          />
        ) : (
          positions.map((p) => <PositionCard key={p.symbol} position={p} livePrice={livePrice} />)
        )}
      </GlassPanel>

      <GlassPanel title="Recent Orders" className="bg-white/30 overflow-hidden" withCorners>
        <div className="space-y-2 max-h-[480px] overflow-y-auto custom-scrollbar">
          {orders.length === 0 ? (
            <div className="text-center py-8 space-y-1">
              <Clock size={20} className="mx-auto text-slate-400" />
              <div className="text-sm text-slate-500 font-mono">No orders yet.</div>
              <div className="text-[10px] text-slate-400 font-mono">
                Orders fire when ensemble crosses ±0.25 with confidence &gt; 0.
              </div>
            </div>
          ) : (
            orders.map((o) => (
              <div key={o.id} className="flex justify-between items-center px-3 py-2 rounded-lg bg-white/40 border border-white/60">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-700">
                    {o.side.toUpperCase()} {o.qty.toFixed(6)} {o.symbol}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono truncate">
                    {o.type} · {o.mode} · {new Date(o.submitted_at).toLocaleTimeString()}
                    {o.filled_price ? ` · @${formatCurrency(Number(o.filled_price))}` : ""}
                  </div>
                </div>
                <div
                  className={`text-[10px] font-mono px-2 py-1 rounded-full ml-2 shrink-0 ${
                    o.status === "filled"
                      ? "bg-emerald-100 text-emerald-700"
                      : o.status === "rejected" || o.status === "canceled"
                      ? "bg-rose-100 text-rose-700"
                      : "bg-slate-200 text-slate-700"
                  }`}
                >
                  {o.status}
                </div>
              </div>
            ))
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

function PositionEmptyState({
  ensembleLatest,
  lastEntryHint,
  livePrice,
}: {
  ensembleLatest?: StrategySignal;
  lastEntryHint?: StrategySignal;
  livePrice: number | null;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/20 p-8 flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <CircleDot size={20} className="text-slate-400" />
        <div>
          <div className="text-sm font-semibold text-slate-700">No open BTC position</div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            Ensemble is currently {ensembleLatest?.side ?? "—"} ·
            score {ensembleLatest?.score.toFixed(3) ?? "—"} ·
            conf {ensembleLatest ? `${(ensembleLatest.confidence * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Mini label="BTC live" value={livePrice != null ? formatCurrency(livePrice) : "—"} />
        <Mini
          label="Entry threshold"
          value="±0.25"
          subtitle="ensemble score"
        />
        {lastEntryHint?.entry_hint ? (
          <>
            <Mini
              label="Last hint price"
              value={formatCurrency(lastEntryHint.entry_hint.price)}
              subtitle={lastEntryHint.strategy_id}
            />
            <Mini
              label="Last hint stop"
              value={formatCurrency(lastEntryHint.entry_hint.stop)}
              subtitle={`tgt ${formatCurrency(lastEntryHint.entry_hint.target)}`}
            />
          </>
        ) : (
          <>
            <Mini label="Last hint" value="—" subtitle="no setup yet" />
            <Mini label="—" value="—" />
          </>
        )}
      </div>

      <div className="text-[10px] text-slate-400 font-mono leading-relaxed">
        BTC is held in a flat position while strategies wait for confluence. The first ensemble
        decision crossing the threshold opens a paper position; check the Recent Orders panel.
      </div>
    </div>
  );
}

function PositionCard({ position: p, livePrice }: { position: Position; livePrice: number | null }) {
  const dir = p.qty > 0 ? "LONG" : p.qty < 0 ? "SHORT" : "FLAT";
  const pnlPct =
    livePrice && p.avg_entry
      ? ((livePrice - p.avg_entry) / p.avg_entry) * 100 * Math.sign(p.qty || 1)
      : null;
  return (
    <div className="relative overflow-hidden rounded-2xl p-5 border border-white/50 shadow-[0_10px_30px_rgba(0,0,0,0.05)] group bg-white/20 backdrop-blur-md">
      <div className="absolute top-0 left-0 right-0 h-1/2 bg-gradient-to-b from-white/40 to-transparent pointer-events-none rounded-t-2xl" />
      <div className="relative z-10 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-200 to-fuchsia-200 border border-white flex items-center justify-center shadow-inner">
            <span className="font-mono text-indigo-700 font-bold text-xs">{p.symbol.split("-")[0]}</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">
              {p.symbol} <span className="ml-2 text-xs font-mono text-slate-500">{dir}</span>
            </h3>
            <p className="text-xs font-mono text-slate-500">
              qty {p.qty.toFixed(6)} · entry {formatCurrency(p.avg_entry)}
              {livePrice ? ` · mark ${formatCurrency(livePrice)}` : ""}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className={`font-mono font-bold text-lg ${p.unrealized_pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {p.unrealized_pnl >= 0 ? "+" : ""}{formatCurrency(p.unrealized_pnl)}
          </div>
          <div className="text-xs text-slate-500 font-mono">
            {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% · ` : ""}
            realized {formatCurrency(p.realized_pnl)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded-xl bg-white/40 border border-white/60 px-3 py-2">
      <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-800 tabular-nums">{value}</div>
      {subtitle && <div className="text-[9px] font-mono text-slate-400 mt-0.5">{subtitle}</div>}
    </div>
  );
}
