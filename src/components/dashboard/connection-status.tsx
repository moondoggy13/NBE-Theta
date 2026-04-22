"use client";

import type { APIConnection } from "@/types/settings";
import { usePolling } from "@/hooks/use-polling";

const fallbackConnections: APIConnection[] = [
  { name: "Alpaca Markets", provider: "alpaca", status: "disconnected" },
  { name: "Perplexity Finance", provider: "perplexity", status: "disconnected" },
  { name: "Unusual Whales", provider: "unusual_whales", status: "disconnected" },
  { name: "Supabase (DB + Vectors)", provider: "supabase", status: "disconnected" },
  { name: "Redis Cloud", provider: "redis", status: "disconnected" },
  { name: "Economic Calendar", provider: "economic_calendar", status: "disconnected" },
];

export function ConnectionStatus() {
  const { data: connections } = usePolling<APIConnection[]>(
    async () => {
      const res = await fetch("/api/connections");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    30_000
  );

  const conns = connections ?? fallbackConnections;

  return (
    <div className="space-y-3">
      {conns.map((conn) => (
        <div
          key={conn.provider}
          className="flex items-center justify-between rounded-md border border-border p-3"
        >
          <div className="flex items-center gap-3">
            <div
              className={`size-2.5 rounded-full ${
                conn.status === "connected"
                  ? "bg-accent-green"
                  : conn.status === "error"
                  ? "bg-accent-red"
                  : "bg-muted-foreground/40"
              }`}
            />
            <div>
              <p className="text-sm font-medium">{conn.name}</p>
              <p className="text-xs text-muted-foreground">{conn.provider}</p>
            </div>
          </div>
          <span
            className={`text-xs ${
              conn.status === "connected"
                ? "text-accent-green"
                : conn.status === "error"
                ? "text-accent-red"
                : "text-muted-foreground"
            }`}
          >
            {conn.status}
          </span>
        </div>
      ))}
    </div>
  );
}
