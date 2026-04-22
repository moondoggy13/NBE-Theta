"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { KillSwitchBar } from "@/components/dashboard/kill-switch-bar";
import { usePolling } from "@/hooks/use-polling";
import { mockRiskMetrics } from "@/data/mock-risk";
import { STRATEGY } from "@/lib/constants";
import type { RiskMetrics } from "@/types/risk";

export default function RiskPage() {
  const { data: riskData } = usePolling<RiskMetrics>(
    async () => {
      const res = await fetch("/api/risk");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    5_000
  );

  const metrics = riskData ?? mockRiskMetrics;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Risk Monitor</h1>
        <p className="text-sm text-muted-foreground">
          Position sizing, kill switch status, and exposure tracking
        </p>
      </div>

      <KillSwitchBar metrics={metrics} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Total Exposure</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.totalExposurePercent.toFixed(1)}%</p>
            <Progress value={metrics.totalExposurePercent} className="mt-2 h-2" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Max Drawdown</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent-red">{metrics.maxDrawdownPercent}%</p>
            <p className="text-xs text-muted-foreground mt-1">since session start</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {Array.from({ length: STRATEGY.MAX_POSITIONS_PHASE1 }).map((_, i) => (
                <div
                  key={i}
                  className={`size-4 rounded-full ${
                    i < metrics.positionCount ? "bg-primary" : "bg-muted"
                  }`}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {metrics.positionCount} / {metrics.maxPositions} active
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">Position Risk Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {metrics.positions.map((pos) => (
              <div key={pos.ticker} className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">{pos.ticker}</span>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-muted-foreground">
                      Exposure: <span className={pos.exposurePercent > pos.maxExposure ? "text-accent-red font-bold" : ""}>{pos.exposurePercent.toFixed(1)}%</span>
                    </span>
                    <span className="text-muted-foreground">
                      Stop dist: <span className={pos.distanceToStopPercent < 3 ? "text-accent-red font-bold" : pos.distanceToStopPercent < 5 ? "text-accent-yellow" : "text-accent-green"}>{pos.distanceToStopPercent.toFixed(1)}%</span>
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-0.5">Exposure vs {pos.maxExposure}% max</p>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pos.exposurePercent > pos.maxExposure ? "bg-accent-red" : "bg-primary"}`}
                        style={{ width: `${Math.min(100, (pos.exposurePercent / (pos.maxExposure * 5)) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-0.5">Distance to stop</p>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          pos.distanceToStopPercent > 5 ? "bg-accent-green" : pos.distanceToStopPercent > 2 ? "bg-accent-yellow" : "bg-accent-red"
                        }`}
                        style={{ width: `${Math.min(100, (pos.distanceToStopPercent / pos.stopLossPercent) * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
