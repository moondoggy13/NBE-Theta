"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { usePollJson } from "@/hooks/use-poll-json";
import { formatCurrency } from "@/lib/formatters";

interface PriceResponse {
  price: number | null;
  priceTs: number | null;
  tickRate: number | null;
  stats: {
    open: number;
    high: number;
    low: number;
    last: number;
    volume: number;
    changePct: number;
    fetchedAt: number;
  } | null;
}

export function PriceTicker() {
  const { data } = usePollJson<PriceResponse>("/api/price", 1500);
  const price = data?.price ?? null;
  const change = data?.stats?.changePct ?? null;
  const tickRate = data?.tickRate ?? null;
  const isUp = (change ?? 0) >= 0;

  return (
    <div className="hidden md:flex items-center gap-4 text-xs font-mono">
      <div className="flex items-center gap-2">
        <span className="text-slate-500 uppercase tracking-widest text-[10px]">BTC-USD</span>
        <span className="text-base font-semibold text-slate-800 tabular-nums">
          {price != null ? formatCurrency(price) : "—"}
        </span>
      </div>

      {change != null && (
        <div
          className={`flex items-center gap-1 px-2 py-1 rounded-full border ${
            isUp
              ? "text-emerald-600 bg-emerald-50 border-emerald-100"
              : "text-rose-600 bg-rose-50 border-rose-100"
          }`}
        >
          {isUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
          <span className="font-semibold tabular-nums">{change.toFixed(2)}%</span>
          <span className="text-[10px] opacity-70">24h</span>
        </div>
      )}

      {data?.stats && (
        <div className="hidden xl:flex items-center gap-3 text-slate-500 text-[10px] uppercase tracking-widest">
          <span>H {formatCurrency(data.stats.high)}</span>
          <span>L {formatCurrency(data.stats.low)}</span>
          <span>VOL {Math.round(data.stats.volume).toLocaleString()}</span>
        </div>
      )}

      {tickRate != null && (
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full ${tickRate > 0 ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
          <span className="tabular-nums">{tickRate}/m</span>
        </div>
      )}
    </div>
  );
}
