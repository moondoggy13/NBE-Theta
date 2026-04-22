import type { PipelineStage } from "@/types/pipeline";

export function getMockPipelineStages(): PipelineStage[] {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;

  const stages: PipelineStage[] = [
    {
      id: "premarket_pull",
      label: "Pre-Market Data Pull",
      scheduledTime: "06:00",
      status: "pending",
      logs: ["Querying Perplexity Finance API for top catalyst stocks", "Ingesting raw data to PostgreSQL"],
    },
    {
      id: "claude_analysis",
      label: "Claude Analysis (Async)",
      scheduledTime: "06:15",
      status: "pending",
      logs: ["Scoring catalyst strength per stock (0-25)", "Writing results to ChromaDB + Redis"],
    },
    {
      id: "signal_crossref",
      label: "Signal Cross-Reference",
      scheduledTime: "06:30",
      status: "pending",
      logs: ["Technical layer scoring via Alpaca data", "Options flow analysis via Unusual Whales", "Sentiment layer from ChromaDB embeddings"],
    },
    {
      id: "universe_finalization",
      label: "Universe Finalization",
      scheduledTime: "06:45",
      status: "pending",
      logs: ["Computing conviction totals", "Selecting top 5 stocks by score", "Writing trade parameters to Redis"],
    },
    {
      id: "execution",
      label: "Market Open \u2014 Execution",
      scheduledTime: "09:30",
      status: "pending",
      logs: ["Rule-based execution from Redis params", "WebSocket data via Alpaca", "Claude NOT in execution loop"],
    },
    {
      id: "regime_check",
      label: "Mid-Day Regime Check",
      scheduledTime: "12:00",
      status: "pending",
      logs: ["Monitoring for regime shift signals", "Claude re-query only if shift detected"],
    },
    {
      id: "eod_review",
      label: "End-of-Day Review",
      scheduledTime: "16:00",
      status: "pending",
      logs: ["Reviewing trade log", "Updating strategy notes", "Refining signal weights to ChromaDB"],
    },
  ];

  const times = [360, 375, 390, 405, 570, 720, 960];
  for (let i = 0; i < stages.length; i++) {
    if (t >= times[i]) {
      if (i < stages.length - 1 && t >= times[i + 1]) {
        stages[i].status = "completed";
        stages[i].startedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(times[i] / 60), times[i] % 60).toISOString();
        stages[i].completedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(times[i + 1] / 60), times[i + 1] % 60).toISOString();
      } else {
        stages[i].status = "active";
        stages[i].startedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(times[i] / 60), times[i] % 60).toISOString();
      }
    }
  }

  return stages;
}
