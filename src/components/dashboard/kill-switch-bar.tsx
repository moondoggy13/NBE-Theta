"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RiskMetrics } from "@/types/risk";

export function KillSwitchBar({ metrics }: { metrics: RiskMetrics }) {
  const pnlPct = metrics.dailyPnlPercent;
  const threshold = metrics.killSwitchThreshold;
  const range = Math.abs(threshold);
  const position = ((pnlPct - threshold) / (range * 2)) * 100;
  const clampedPosition = Math.max(0, Math.min(100, position));
  const isNearThreshold = pnlPct <= threshold + 1;

  return (
    <Card className={isNearThreshold ? "border-accent-red/50" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="flex justify-between text-sm">
          <span className="text-muted-foreground font-medium">Daily P&L Kill Switch</span>
          {metrics.killSwitchTriggered && (
            <span className="text-accent-red font-bold animate-pulse">TRIGGERED</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="text-accent-red">{threshold}%</span>
            <span>0%</span>
            <span className="text-accent-green">+{range}%</span>
          </div>
          <div className="relative h-4 w-full rounded-full bg-gradient-to-r from-accent-red/30 via-muted to-accent-green/30 overflow-hidden">
            <div
              className="absolute top-0 h-full w-1 bg-accent-yellow"
              style={{ left: "50%" }}
            />
            <div
              className={`absolute top-0.5 size-3 rounded-full ${
                pnlPct >= 0 ? "bg-accent-green" : pnlPct > threshold + 1 ? "bg-accent-yellow" : "bg-accent-red"
              } shadow-lg transition-all duration-500`}
              style={{ left: `calc(${clampedPosition}% - 6px)` }}
            />
          </div>
          <div className="flex justify-between items-center">
            <span className={`text-lg font-bold font-mono tabular-nums ${
              pnlPct >= 0 ? "text-accent-green" : "text-accent-red"
            }`}>
              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
            </span>
            <span className="text-xs text-muted-foreground">
              {Math.abs(pnlPct - threshold).toFixed(2)}% from kill switch
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
