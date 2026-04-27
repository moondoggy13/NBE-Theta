"use client";

import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { formatCurrency } from "@/lib/formatters";
import { TIMEFRAME_MS, TimeframeSelector, type Timeframe } from "./TimeframeSelector";

interface PnlSnap {
  id: number;
  ts: string;
  equity: number;
  drawdown_pct: number;
}

interface OrderRow {
  id: string;
  submitted_at: string;
  side: "buy" | "sell";
  filled_price: number | null;
  qty: number;
  status: string;
  metadata: { reason?: string; stop?: number; target?: number } | null;
  strategy_id: string | null;
}

interface SignalRow {
  id: string;
  ts: string;
  strategy_id: string;
  side: "long" | "short" | "flat";
  score: number;
}

const DOWNTIME_GAP_MS = 90_000;          // gap in snapshots > 90s = downtime
const STRIPE_HEIGHT = 14;                 // per-strategy stripe height (px)

const STRATEGY_COLOR: Record<string, string> = {
  "mean-reversion-bb": "#a855f7",          // purple
  "momentum-ema":      "#06b6d4",          // cyan
  "vol-breakout-atr":  "#f59e0b",          // amber
  "orderbook-micro":   "#10b981",          // emerald
  "ensemble":          "#475569",          // slate
};

export interface EquityChartProps {
  height?: number;
  /** Anchor for the "since launch" change calc. */
  referenceEquity?: number;
}

export function EquityChart({ height = 320, referenceEquity = 25_000 }: EquityChartProps) {
  const [tf, setTf] = useState<Timeframe>("1h");

  const { rows: snaps } = useRealtime<PnlSnap>({
    table: "pnl_snapshots",
    initialFetch: { order: { column: "ts", ascending: false }, limit: 2000 },
  });
  const { rows: orders } = useRealtime<OrderRow>({
    table: "orders",
    initialFetch: { order: { column: "submitted_at", ascending: false }, limit: 200 },
  });
  const { rows: signals } = useRealtime<SignalRow>({
    table: "strategy_signals",
    initialFetch: { order: { column: "ts", ascending: false }, limit: 1000 },
  });

  const { data, downtime, tradeMarkers, strategyBands, stats } = useMemo(() => {
    const cutoff = tf === "All" ? -Infinity : Date.now() - TIMEFRAME_MS[tf];
    const filtered = [...snaps]
      .reverse()
      .map((r) => ({ ts: new Date(r.ts).getTime(), equity: Number(r.equity) }))
      .filter((d) => d.ts >= cutoff);

    // Downtime gaps: any pair of consecutive points further apart than threshold.
    const downtime: Array<{ x1: number; x2: number }> = [];
    for (let i = 1; i < filtered.length; i++) {
      const dt = filtered[i].ts - filtered[i - 1].ts;
      if (dt > DOWNTIME_GAP_MS) {
        downtime.push({ x1: filtered[i - 1].ts, x2: filtered[i].ts });
      }
    }

    // Trade markers from orders that fall in window.
    const tradeMarkers = orders
      .map((o) => ({
        ts: new Date(o.submitted_at).getTime(),
        side: o.side,
        price: o.filled_price != null ? Number(o.filled_price) : null,
        qty: Number(o.qty),
        reason: o.metadata?.reason,
      }))
      .filter((m) => m.ts >= cutoff);

    // Strategy regime stripe: collapse signals into one band per strategy
    // showing long/short/flat color per minute.
    const byStrategy = new Map<string, Array<{ ts: number; side: SignalRow["side"]; score: number }>>();
    for (const s of signals) {
      const t = new Date(s.ts).getTime();
      if (t < cutoff) continue;
      if (!byStrategy.has(s.strategy_id)) byStrategy.set(s.strategy_id, []);
      byStrategy.get(s.strategy_id)!.push({ ts: t, side: s.side, score: s.score });
    }
    // Sort and ensure ascending
    for (const arr of byStrategy.values()) arr.sort((a, b) => a.ts - b.ts);
    const strategyBands = [...byStrategy.entries()].map(([id, points]) => ({ id, points }));

    const equities = filtered.map((d) => d.equity);
    const minVal = equities.length ? Math.min(...equities) : referenceEquity;
    const maxVal = equities.length ? Math.max(...equities) : referenceEquity;
    const last = filtered.at(-1)?.equity ?? referenceEquity;
    const change = last - referenceEquity;
    const changePct = referenceEquity > 0 ? (change / referenceEquity) * 100 : 0;
    const stats = { minVal, maxVal, last, change, changePct, count: filtered.length };

    return { data: filtered, downtime, tradeMarkers, strategyBands, stats };
  }, [snaps, orders, signals, tf, referenceEquity]);

  if (data.length === 0) {
    return (
      <div className="flex flex-col gap-3" style={{ height }}>
        <div className="flex items-center justify-between">
          <TimeframeSelector value={tf} onChange={setTf} />
          <span className="text-[10px] font-mono text-slate-400">no data in {tf}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-slate-400 text-xs font-mono">
          Equity curve builds as the worker streams P&L snapshots…
        </div>
      </div>
    );
  }

  const up = stats.change >= 0;
  const stroke = up ? "#10b981" : "#f43f5e";
  const fillId = up ? "eq-fill-up" : "eq-fill-dn";
  const mid = (stats.minVal + stats.maxVal) / 2 || 1;
  const padding = Math.max(mid * 0.005, 1);
  const yMin = Math.min(stats.minVal, referenceEquity) - padding;
  const yMax = Math.max(stats.maxVal, referenceEquity) + padding;

  return (
    <div className="flex flex-col gap-3" style={{ height }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <TimeframeSelector value={tf} onChange={setTf} />
        <div className="flex gap-3 text-[10px] font-mono uppercase tracking-widest text-slate-500">
          <span>{stats.count} pts</span>
          <span>min {formatCurrency(stats.minVal)}</span>
          <span>max {formatCurrency(stats.maxVal)}</span>
          <span className={up ? "text-emerald-600" : "text-rose-600"}>
            {stats.change >= 0 ? "+" : ""}{formatCurrency(stats.change)} · {stats.changePct.toFixed(2)}% since launch
          </span>
        </div>
      </div>

      {/* Main equity chart */}
      <div className="flex-1 min-h-[160px]">
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
            <YAxis hide type="number" domain={[yMin, yMax]} allowDataOverflow={false} />
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

            {/* Downtime bands */}
            {downtime.map((g, i) => (
              <ReferenceArea
                key={`gap-${i}`}
                x1={g.x1}
                x2={g.x2}
                strokeOpacity={0}
                fill="#94a3b8"
                fillOpacity={0.18}
                ifOverflow="visible"
                label={{ value: "downtime", fill: "#475569", fontSize: 9, fontFamily: "ui-monospace, monospace" }}
              />
            ))}

            {/* Reference line at launch equity */}
            <ReferenceLine
              y={referenceEquity}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{
                value: `launch ${formatCurrency(referenceEquity)}`,
                position: "right",
                fill: "#64748b",
                fontSize: 10,
                fontFamily: "ui-monospace, monospace",
              }}
            />

            {/* Trade markers */}
            {tradeMarkers.map((m) => (
              <ReferenceDot
                key={`trade-${m.ts}-${m.side}`}
                x={m.ts}
                y={m.price ?? referenceEquity}
                r={4}
                fill={m.side === "buy" ? "#10b981" : "#f43f5e"}
                stroke="#fff"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            ))}

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

            {data.length > 80 && (
              <Brush dataKey="ts" height={18} stroke="#cbd5e1" fill="#f8fafc"
                tickFormatter={(t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Strategy regime stripe */}
      {strategyBands.length > 0 && (
        <StrategyStripe
          bands={strategyBands}
          windowStart={data[0]?.ts ?? Date.now()}
          windowEnd={data.at(-1)?.ts ?? Date.now()}
        />
      )}
    </div>
  );
}

function StrategyStripe({
  bands,
  windowStart,
  windowEnd,
}: {
  bands: Array<{ id: string; points: Array<{ ts: number; side: "long" | "short" | "flat"; score: number }> }>;
  windowStart: number;
  windowEnd: number;
}) {
  const span = Math.max(1, windowEnd - windowStart);
  return (
    <div className="border border-slate-200 bg-slate-50/60 rounded-lg p-2 flex flex-col gap-1.5">
      <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500 px-1">
        Strategy regime
      </div>
      {bands.map(({ id, points }) => (
        <div key={id} className="flex items-center gap-3">
          <span
            className="text-[10px] font-mono w-32 truncate"
            style={{ color: STRATEGY_COLOR[id] ?? "#475569" }}
          >
            {id}
          </span>
          <div
            className="relative flex-1 rounded-full bg-white border border-slate-200 overflow-hidden"
            style={{ height: STRIPE_HEIGHT }}
          >
            {points.map((p, i) => {
              const start = ((p.ts - windowStart) / span) * 100;
              const next = points[i + 1]?.ts ?? windowEnd;
              const width = Math.max(0.3, ((next - p.ts) / span) * 100);
              const color =
                p.side === "long"  ? "#10b981" :
                p.side === "short" ? "#f43f5e" :
                "#cbd5e1";
              return (
                <div
                  key={p.ts}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: `${start}%`,
                    width: `${width}%`,
                    background: color,
                    opacity: p.side === "flat" ? 0.4 : 0.55 + 0.45 * Math.min(1, Math.abs(p.score)),
                  }}
                  title={`${id} ${p.side} ${p.score.toFixed(3)} ${new Date(p.ts).toLocaleTimeString()}`}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex justify-between text-[9px] font-mono text-slate-400 px-1 pt-0.5">
        <span>{new Date(windowStart).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        <span className="flex gap-2">
          <span><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 align-middle" /> long</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-rose-500 align-middle" /> short</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-slate-300 align-middle" /> flat</span>
        </span>
        <span>{new Date(windowEnd).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}
