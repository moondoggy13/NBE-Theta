"use client";

import { PortfolioSummaryCard } from "@/components/dashboard/portfolio-summary-card";
import { MarketStatusIndicator } from "@/components/dashboard/market-status-indicator";
import { PositionCard } from "@/components/dashboard/position-card";
import { PnlChart } from "@/components/dashboard/pnl-chart";
import { SignalFeed } from "@/components/dashboard/signal-feed";
import { PipelineCompact } from "@/components/dashboard/pipeline-compact";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePolling } from "@/hooks/use-polling";
import { mockPortfolioSummary, mockPositions } from "@/data/mock-portfolio";
import { mockSignals } from "@/data/mock-signals";
import type { PortfolioSummary, Position } from "@/types/portfolio";
import type { StockSignal } from "@/types/signals";
import type { MacroSnapshot } from "@/server/services/macro/types";

export default function DashboardPage() {
  const { data: portfolioData } = usePolling<{ summary: PortfolioSummary; positions: Position[] }>(
    async () => {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    5_000
  );

  const { data: signals } = usePolling<StockSignal[]>(
    async () => {
      const res = await fetch("/api/signals");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    30_000
  );

  const { data: macro } = usePolling<MacroSnapshot>(
    async () => {
      const res = await fetch("/api/macro");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    60_000
  );

  const summary = portfolioData?.summary ?? mockPortfolioSummary;
  const positions = portfolioData?.positions ?? mockPositions;
  const signalData = signals ?? mockSignals;
  const topConviction = Math.max(...signalData.map((s) => s.convictionScore));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Portfolio summary and market status
        </p>
      </div>

      {/* Top row: Key metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <PortfolioSummaryCard data={summary} />
        <MarketStatusIndicator />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Positions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {summary.positionCount}{" "}
              <span className="text-lg text-muted-foreground font-normal">
                / {summary.maxPositions}
              </span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Top Conviction
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent-yellow">
              {topConviction}{" "}
              <span className="text-lg text-muted-foreground font-normal">/ 100</span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Macro Regime
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${
              macro?.regime === "risk_on" ? "text-accent-green" :
              macro?.regime === "risk_off" ? "text-accent-red" :
              "text-accent-yellow"
            }`}>
              {macro?.regime === "risk_on" ? "Risk-On" :
               macro?.regime === "risk_off" ? "Risk-Off" :
               "Neutral"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {macro?.summary ?? "Awaiting macro data"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Middle row: Chart + Positions */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PnlChart />
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Active Positions</h2>
          {positions.map((pos) => (
            <PositionCard key={pos.ticker} position={pos} />
          ))}
        </div>
      </div>

      {/* Bottom row: Signal Feed + Pipeline */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SignalFeed />
        <PipelineCompact />
      </div>
    </div>
  );
}
