"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { usePolling } from "@/hooks/use-polling";

const mockChartData = [
  { time: "09:30", pnl: 0 },
  { time: "10:00", pnl: 15 },
  { time: "10:30", pnl: -8 },
  { time: "11:00", pnl: 22 },
  { time: "11:30", pnl: 35 },
  { time: "12:00", pnl: 28 },
  { time: "12:30", pnl: 42 },
  { time: "13:00", pnl: 55 },
  { time: "13:30", pnl: 48 },
  { time: "14:00", pnl: 62 },
  { time: "14:30", pnl: 58 },
  { time: "15:00", pnl: 68 },
  { time: "15:30", pnl: 72 },
];

const chartConfig = {
  pnl: {
    label: "P&L",
    color: "var(--accent-green)",
  },
} satisfies ChartConfig;

export function PnlChart() {
  const { data: pnlData } = usePolling<{ time: string; pnl: number }[]>(
    async () => {
      const res = await fetch("/api/pnl-series");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    30_000
  );

  const chartData = pnlData ?? mockChartData;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Intraday P&L
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--accent-green)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--accent-green)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickFormatter={(v) => `$${v}`}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke="var(--accent-green)"
              fill="url(#pnlGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
