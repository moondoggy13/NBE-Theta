"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMarketClock } from "@/hooks/use-market-clock";

export function MarketStatusIndicator() {
  const { phase, nextEvent, minutesToNextEvent } = useMarketClock();

  const phaseConfig = {
    "pre-market": { label: "Pre-Market", color: "bg-accent-yellow", textColor: "text-accent-yellow" },
    open: { label: "Market Open", color: "bg-accent-green", textColor: "text-accent-green" },
    "after-hours": { label: "After Hours", color: "bg-accent-yellow", textColor: "text-accent-yellow" },
    closed: { label: "Closed", color: "bg-accent-red", textColor: "text-accent-red" },
  };

  const config = phaseConfig[phase];
  const hours = Math.floor(minutesToNextEvent / 60);
  const mins = minutesToNextEvent % 60;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Market Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <div className="relative flex size-3">
            {phase === "open" && (
              <span className={`absolute inline-flex size-full animate-ping rounded-full ${config.color} opacity-75`} />
            )}
            <span className={`relative inline-flex size-3 rounded-full ${config.color}`} />
          </div>
          <span className={`text-lg font-semibold ${config.textColor}`}>
            {config.label}
          </span>
        </div>
        {phase !== "closed" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {nextEvent} in {hours > 0 ? `${hours}h ` : ""}{mins}m
          </p>
        )}
      </CardContent>
    </Card>
  );
}
