"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { formatTime } from "@/lib/formatters";
import { MARKET_HOURS, PIPELINE_SCHEDULE } from "@/lib/constants";

type MarketPhase = "pre-market" | "open" | "after-hours" | "closed";

function getMarketPhase(now: Date): MarketPhase {
  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;

  const preOpen = MARKET_HOURS.preMarketOpen.hour * 60 + MARKET_HOURS.preMarketOpen.minute;
  const open = MARKET_HOURS.marketOpen.hour * 60 + MARKET_HOURS.marketOpen.minute;
  const close = MARKET_HOURS.marketClose.hour * 60 + MARKET_HOURS.marketClose.minute;
  const afterClose = MARKET_HOURS.afterHoursClose.hour * 60 + MARKET_HOURS.afterHoursClose.minute;

  const day = now.getDay();
  if (day === 0 || day === 6) return "closed";
  if (t >= open && t < close) return "open";
  if (t >= preOpen && t < open) return "pre-market";
  if (t >= close && t < afterClose) return "after-hours";
  return "closed";
}

function getCurrentPipelineStage(now: Date): string {
  const t = now.getHours() * 60 + now.getMinutes();
  let current = "Idle";
  for (const stage of PIPELINE_SCHEDULE) {
    const stageTime = stage.hour * 60 + stage.minute;
    if (t >= stageTime) current = stage.label;
  }
  return current;
}

const phaseColors: Record<MarketPhase, string> = {
  "pre-market": "bg-accent-yellow/20 text-accent-yellow border-accent-yellow/30",
  open: "bg-accent-green/20 text-accent-green border-accent-green/30",
  "after-hours": "bg-accent-yellow/20 text-accent-yellow border-accent-yellow/30",
  closed: "bg-accent-red/20 text-accent-red border-accent-red/30",
};

export function Header() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const phase = getMarketPhase(now);
  const pipelineStage = getCurrentPipelineStage(now);

  return (
    <header className="flex h-12 items-center gap-3 border-b border-border bg-card px-4">
      <SidebarTrigger className="size-5 text-muted-foreground" />
      <Separator orientation="vertical" className="h-5" />

      <div className="flex items-center gap-2">
        <div className="relative flex size-2">
          {phase === "open" && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-green opacity-75" />
          )}
          <span
            className={`relative inline-flex size-2 rounded-full ${
              phase === "open"
                ? "bg-accent-green"
                : phase === "closed"
                ? "bg-accent-red"
                : "bg-accent-yellow"
            }`}
          />
        </div>
        <Badge variant="outline" className={phaseColors[phase]}>
          {phase === "open" ? "Market Open" : phase === "pre-market" ? "Pre-Market" : phase === "after-hours" ? "After Hours" : "Market Closed"}
        </Badge>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Badge variant="outline" className="border-border text-muted-foreground font-normal">
          {pipelineStage}
        </Badge>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatTime(now)}
        </span>
      </div>
    </header>
  );
}
