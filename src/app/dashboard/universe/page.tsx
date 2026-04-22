"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UniverseTable } from "@/components/dashboard/universe-table";
import { usePolling } from "@/hooks/use-polling";
import { mockPositions } from "@/data/mock-portfolio";
import { STRATEGY } from "@/lib/constants";
import type { Position } from "@/types/portfolio";

export default function UniversePage() {
  const { data: positionsData } = usePolling<{ summary: unknown; positions: Position[] }>(
    async () => {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    10_000
  );

  const positions = positionsData?.positions ?? mockPositions;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Active Universe</h1>
          <p className="text-sm text-muted-foreground">
            Stocks with conviction score {"\u2265"} {STRATEGY.MIN_CONVICTION_SCORE} currently in the trading universe
          </p>
        </div>
        <Badge variant="outline" className="border-primary/30 text-primary">
          {positions.length} / {STRATEGY.MAX_POSITIONS_PHASE1} positions
        </Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          <UniverseTable positions={positions} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Max Position Size</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{STRATEGY.MAX_POSITION_SIZE_PCT}%</p>
            <p className="text-xs text-muted-foreground">of total capital per trade</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Stop Loss Range</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold text-accent-red">
              {STRATEGY.STOP_LOSS_MIN_PCT}% - {STRATEGY.STOP_LOSS_MAX_PCT}%
            </p>
            <p className="text-xs text-muted-foreground">below entry, hardcoded</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Kill Switch</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold text-accent-orange">
              {STRATEGY.DAILY_LOSS_KILL_SWITCH_PCT}%
            </p>
            <p className="text-xs text-muted-foreground">daily loss halts all activity</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
