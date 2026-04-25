"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useRealtime } from "@/hooks/use-realtime";
import { formatCurrency } from "@/lib/formatters";

interface PnlSnap {
  id: number;
  ts: string;
  equity: number;
  drawdown_pct: number;
}

export function EquityChart({ height = 220 }: { height?: number }) {
  const { rows } = useRealtime<PnlSnap>({
    table: "pnl_snapshots",
    initialFetch: { order: { column: "ts", ascending: false }, limit: 240 },
  });

  // Reverse so chart reads left → right oldest → newest.
  const data = [...rows]
    .reverse()
    .map((r) => ({ ts: new Date(r.ts).getTime(), equity: Number(r.equity) }));

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-slate-400 text-xs font-mono"
        style={{ height }}
      >
        Equity curve builds as the worker streams P&L snapshots…
      </div>
    );
  }

  const start = data[0].equity;
  const last = data[data.length - 1].equity;
  const up = last >= start;
  const stroke = up ? "#10b981" : "#f43f5e";
  const fillFrom = up ? "#10b98120" : "#f43f5e20";

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eq-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={fillFrom} stopOpacity={0.9} />
              <stop offset="100%" stopColor={fillFrom} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="ts" hide />
          <YAxis
            hide
            domain={[
              (m: number) => Math.min(m, start) * 0.999,
              (m: number) => Math.max(m, start) * 1.001,
            ]}
          />
          <Tooltip
            contentStyle={{ background: "rgba(255,255,255,0.92)", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 11 }}
            formatter={(v: number) => [formatCurrency(v), "equity"]}
            labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()}
          />
          <Area type="monotone" dataKey="equity" stroke={stroke} strokeWidth={1.5} fill="url(#eq-gradient)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
