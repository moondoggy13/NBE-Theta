"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, Circle, Loader2, AlertCircle } from "lucide-react";
import type { PipelineStage } from "@/types/pipeline";
import { cn } from "@/lib/utils";

function StageIcon({ status }: { status: PipelineStage["status"] }) {
  switch (status) {
    case "completed":
      return <Check className="size-4 text-accent-green" />;
    case "active":
      return <Loader2 className="size-4 text-primary animate-spin" />;
    case "error":
      return <AlertCircle className="size-4 text-accent-red" />;
    default:
      return <Circle className="size-4 text-muted-foreground/40" />;
  }
}

export function PipelineTimeline({ stages }: { stages: PipelineStage[] }) {
  return (
    <div className="space-y-0">
      {stages.map((stage, i) => (
        <div key={stage.id} className="flex gap-4">
          {/* Timeline line */}
          <div className="flex flex-col items-center">
            <div
              className={cn(
                "flex size-8 items-center justify-center rounded-full border-2",
                stage.status === "completed" && "border-accent-green bg-accent-green/10",
                stage.status === "active" && "border-primary bg-primary/10",
                stage.status === "error" && "border-accent-red bg-accent-red/10",
                stage.status === "pending" && "border-muted bg-transparent"
              )}
            >
              <StageIcon status={stage.status} />
            </div>
            {i < stages.length - 1 && (
              <div
                className={cn(
                  "w-0.5 flex-1 min-h-[40px]",
                  stage.status === "completed" ? "bg-accent-green" : "bg-muted"
                )}
              />
            )}
          </div>

          {/* Stage content */}
          <div className="flex-1 pb-6">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {stage.scheduledTime}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  stage.status === "active" && "text-primary",
                  stage.status === "completed" && "text-foreground",
                  stage.status === "pending" && "text-muted-foreground"
                )}
              >
                {stage.label}
              </span>
              {stage.status === "active" && (
                <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px]">
                  Running
                </Badge>
              )}
            </div>

            {(stage.status === "active" || stage.status === "completed") && stage.logs.length > 0 && (
              <Card className="mt-2 bg-background">
                <CardContent className="p-3">
                  <ScrollArea className="max-h-[120px]">
                    <div className="font-mono text-xs space-y-1">
                      {stage.logs.map((log, j) => (
                        <div key={j} className="flex gap-2">
                          <span className="text-muted-foreground shrink-0">$</span>
                          <span className={stage.status === "active" ? "text-primary" : "text-muted-foreground"}>
                            {log}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
