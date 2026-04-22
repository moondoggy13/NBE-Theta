"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PipelineTimeline } from "@/components/dashboard/pipeline-timeline";
import { getMockPipelineStages } from "@/data/mock-pipeline";
import { usePolling } from "@/hooks/use-polling";
import { usePipelineStage } from "@/hooks/use-pipeline-stage";
import { PIPELINE_SCHEDULE } from "@/lib/constants";
import type { PipelineStage } from "@/types/pipeline";

export default function PipelinePage() {
  const { data: pipelineData } = usePolling<PipelineStage[]>(
    async () => {
      const res = await fetch("/api/pipeline");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    10_000
  );

  const stages = pipelineData ?? getMockPipelineStages();
  const currentStageId = usePipelineStage();
  const currentStage = PIPELINE_SCHEDULE.find((s) => s.id === currentStageId);
  const completedCount = stages.filter((s) => s.status === "completed").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline Status</h1>
          <p className="text-sm text-muted-foreground">
            Daily execution pipeline from pre-market through end-of-day
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-primary/30 text-primary">
            {currentStage?.label ?? "Idle"}
          </Badge>
          <Badge variant="outline" className="text-muted-foreground">
            {completedCount} / {stages.length} stages
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <Card>
          <CardContent className="p-6">
            <PipelineTimeline stages={stages} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">Architecture Note</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  <span className="text-accent-green font-medium">Hot Path:</span> Alpaca WebSocket {"\u2192"} Redis Pub/Sub {"\u2192"} Signal Engine {"\u2192"} Orders
                </p>
                <p>
                  <span className="text-primary font-medium">Strategy Layer:</span> Claude / MCP reads PostgreSQL + Redis state {"\u2192"} async decisions
                </p>
                <p className="text-accent-red font-medium">
                  Claude is NEVER in the tick-by-tick execution loop
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">Data Sources</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-signal-catalyst">Catalyst</span>
                  <span className="text-muted-foreground">Perplexity Finance</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-signal-technical">Technical</span>
                  <span className="text-muted-foreground">Alpaca Market Data</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-signal-options">Options Flow</span>
                  <span className="text-muted-foreground">Unusual Whales</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-signal-sentiment">Sentiment</span>
                  <span className="text-muted-foreground">Supabase pgvector / News</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-signal-economic">Economic</span>
                  <span className="text-muted-foreground">Economic Calendar</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-accent-yellow">Macro</span>
                  <span className="text-muted-foreground">FRED API</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-primary">Intelligence</span>
                  <span className="text-muted-foreground">Claude Max (Anthropic)</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
