"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePolling } from "@/hooks/use-polling";
import type { SignalEvent } from "@/types/events";

const mockEvents: SignalEvent[] = [
  { id: "1", ticker: "NVDA", type: "catalyst", message: "Earnings beat by 12%, guidance raised", timestamp: "06:15", occurredAt: "", impact: "bullish" },
  { id: "2", ticker: "NVDA", type: "technical", message: "Breakout above $138 on 2x volume", timestamp: "06:30", occurredAt: "", impact: "bullish" },
  { id: "3", ticker: "AMZN", type: "options_flow", message: "Heavy call sweep at $205 strike", timestamp: "06:32", occurredAt: "", impact: "bullish" },
  { id: "4", ticker: "META", type: "sentiment", message: "Analyst upgrades from 3 firms", timestamp: "06:35", occurredAt: "", impact: "bullish" },
  { id: "5", ticker: "TSLA", type: "technical", message: "Rejected at 200 EMA resistance", timestamp: "06:38", occurredAt: "", impact: "bearish" },
  { id: "6", ticker: "AAPL", type: "catalyst", message: "iPhone 17 supply chain checks positive", timestamp: "06:40", occurredAt: "", impact: "bullish" },
  { id: "7", ticker: "AMZN", type: "catalyst", message: "AWS reacceleration confirmed by checks", timestamp: "06:42", occurredAt: "", impact: "bullish" },
];

const typeColors: Record<string, string> = {
  catalyst: "text-signal-catalyst",
  technical: "text-signal-technical",
  options_flow: "text-signal-options",
  sentiment: "text-signal-sentiment",
  economic: "text-signal-economic",
};

const typeLabels: Record<string, string> = {
  catalyst: "CAT",
  technical: "TECH",
  options_flow: "OPT",
  sentiment: "SENT",
  economic: "ECON",
};

export function SignalFeed() {
  const { data: eventsData } = usePolling<SignalEvent[]>(
    async () => {
      const res = await fetch("/api/events?limit=20");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    15_000
  );

  const events = eventsData ?? mockEvents;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Signal Feed
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[280px] px-4 pb-4">
          <div className="space-y-2">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-3 rounded-md border border-border/50 bg-background p-2.5 text-sm"
              >
                <span className="font-mono text-xs text-muted-foreground mt-0.5 shrink-0">
                  {event.timestamp}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{event.ticker}</span>
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${typeColors[event.type]}`}>
                      {typeLabels[event.type]}
                    </Badge>
                    <span
                      className={`ml-auto text-xs ${
                        event.impact === "bullish" ? "text-accent-green" : event.impact === "bearish" ? "text-accent-red" : "text-muted-foreground"
                      }`}
                    >
                      {event.impact === "bullish" ? "\u25B2" : event.impact === "bearish" ? "\u25BC" : "\u25CF"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{event.message}</p>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
