"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";

export interface SparklinePoint {
  ts: number;
  score: number;
}

export function ScoreSparkline({
  data,
  positive = "#10b981",
  negative = "#f43f5e",
  neutral = "#94a3b8",
  height = 36,
}: {
  data: SparklinePoint[];
  positive?: string;
  negative?: string;
  neutral?: string;
  height?: number;
}) {
  if (!data.length) return null;
  const lastScore = data[data.length - 1].score;
  const stroke = lastScore > 0.05 ? positive : lastScore < -0.05 ? negative : neutral;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <Tooltip
            contentStyle={{ background: "rgba(255,255,255,0.95)", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 10, padding: "4px 6px" }}
            formatter={(v: number) => [v.toFixed(3), "score"]}
            labelFormatter={(_: unknown, payload) => {
              const ts = payload?.[0]?.payload?.ts;
              return ts ? new Date(ts).toLocaleTimeString() : "";
            }}
          />
          <Line type="monotone" dataKey="score" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
