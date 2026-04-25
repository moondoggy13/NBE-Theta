"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useRealtime } from "@/hooks/use-realtime";
import { formatCurrency } from "@/lib/formatters";

interface PnlSnap {
  id: number;
  ts: string;
  equity: number;
  drawdown_pct: number;
}

export interface EquityChartProps {
  height?: number;
  /** Reference line drawn at this equity (e.g. starting equity for a session). */
  referenceEquity?: number;
}

export function EquityChart({ height = 220, referenceEquity }: EquityChartProps) {
  const { rows } = useRealtime<PnlSnap>({
    table: "pnl_snapshots",
    initialFetch: { order: { column: "ts", ascending: false }, limit: 500 },
  });

  const data = [...rows]
    .reverse()
    .map((r) => ({ ts: new Date(r.ts).getTime(), equity: Number(r.equity) }));

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-slate-400 text-xs font-mono gap-2" style={{ height }}>
        <span>Equity curve builds as the worker streams P&L snapshots…</span>
      </div>
    );
  }

  const equities = data.map((d) => d.equity);
  const minVal = Math.min(...equities);
  const maxVal = Math.max(...equities);
  const start = data[0].equity;
  const last = data[data.length - 1].equity;
  const change = last - start;
  const changePct = start > 0 ? (change / start) * 100 : 0;
  const up = last >= start;
  const stroke = up ? "#10b981" : "#f43f5e";
  const fillId = up ? "eq-fill-up" : "eq-fill-dn";

  // Pad domain by max(0.5% of midpoint, $1) so a flat line still shows
  // surrounded by space and a reference line is visible.
  const mid = (minVal + maxVal) / 2 || 1;
  const padding = Math.max(mid * 0.005, 1);
  const yMin = Math.min(minVal, referenceEquity ?? minVal) - padding;
  const yMax = Math.max(maxVal, referenceEquity ?? maxVal) + padding;

  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      {/* Stats strip */}
      <div className="flex justify-between text-[10px] font-mono uppercase tracking-widest text-slate-500 px-2">
        <span>{data.length} pts</span>
        <span>min {formatCurrency(minVal)}</span>
        <span>max {formatCurrency(maxVal)}</span>
        <span className={up ? "text-emerald-600" : "text-rose-600"}>
          {change >= 0 ? "+" : ""}{formatCurrency(change)} · {changePct.toFixed(2)}%
        </span>
      </div>

      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#cbd5e1" strokeOpacity={0.25} vertical={false} />
            <XAxis dataKey="ts" hide type="number" domain={["dataMin", "dataMax"]} />
            <YAxis
              hide
              type="number"
              domain={[yMin, yMax]}
              allowDataOverflow={false}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(255,255,255,0.95)",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                fontSize: 11,
                padding: "6px 10px",
              }}
              formatter={(v: number) => [formatCurrency(v), "equity"]}
              labelFormatter={(ts: number) => new Date(ts).toLocaleString()}
            />
            {referenceEquity != null && (
              <ReferenceLine
                y={referenceEquity}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: `start ${formatCurrency(referenceEquity)}`,
                  position: "right",
                  fill: "#64748b",
                  fontSize: 10,
                  fontFamily: "ui-monospace, monospace",
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="equity"
              stroke={stroke}
              strokeWidth={2}
              fill={`url(#${fillId})`}
              isAnimationActive={false}
              dot={data.length < 30 ? { r: 2, stroke, fill: "#fff", strokeWidth: 1 } : false}
              activeDot={{ r: 4, stroke, fill: "#fff", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
