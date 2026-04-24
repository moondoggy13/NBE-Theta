"use client";

import { GlassPanel } from "../GlassPanel";
import { useRealtime } from "@/hooks/use-realtime";
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
}

export function PositionsTab() {
  const { rows: positions } = useRealtime<Position>({
    table: "positions",
    initialFetch: { order: { column: "updated_at" }, limit: 10 },
  });
  const { rows: orders } = useRealtime<Order>({
    table: "orders",
    initialFetch: { order: { column: "submitted_at" }, limit: 20 },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
      <GlassPanel title="Open Positions" className="lg:col-span-2 flex flex-col gap-4">
        {positions.length === 0 ? (
          <div className="text-sm text-slate-500 font-mono py-10 text-center">No open positions.</div>
        ) : (
          positions.map((p) => (
            <div
              key={p.symbol}
              className="relative overflow-hidden rounded-2xl p-5 border border-white/50 shadow-[0_10px_30px_rgba(0,0,0,0.05)] group bg-white/20 backdrop-blur-md"
            >
              <div className="absolute top-0 left-0 right-0 h-1/2 bg-gradient-to-b from-white/40 to-transparent pointer-events-none rounded-t-2xl" />
              <div className="relative z-10 flex justify-between items-center">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-200 to-fuchsia-200 border border-white flex items-center justify-center shadow-inner">
                    <span className="font-mono text-indigo-700 font-bold text-xs">{p.symbol.split("-")[0]}</span>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">{p.symbol}</h3>
                    <p className="text-xs font-mono text-slate-500">
                      qty {p.qty.toFixed(6)} · entry {formatCurrency(p.avg_entry)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-mono font-bold text-lg ${p.unrealized_pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {p.unrealized_pnl >= 0 ? "+" : ""}{formatCurrency(p.unrealized_pnl)}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    realized {formatCurrency(p.realized_pnl)}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </GlassPanel>

      <GlassPanel title="Recent Orders" className="bg-white/30 overflow-hidden" withCorners>
        <div className="space-y-2 max-h-[480px] overflow-y-auto custom-scrollbar">
          {orders.length === 0 ? (
            <div className="text-sm text-slate-500 font-mono py-6 text-center">No orders yet.</div>
          ) : (
            orders.map((o) => (
              <div key={o.id} className="flex justify-between items-center px-3 py-2 rounded-lg bg-white/40 border border-white/60">
                <div>
                  <div className="text-xs font-bold text-slate-700">
                    {o.side.toUpperCase()} {o.qty.toFixed(6)} {o.symbol}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono">
                    {o.type} · {o.mode} · {new Date(o.submitted_at).toLocaleTimeString()}
                  </div>
                </div>
                <div
                  className={`text-[10px] font-mono px-2 py-1 rounded-full ${
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
