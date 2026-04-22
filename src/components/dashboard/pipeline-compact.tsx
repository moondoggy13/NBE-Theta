"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PIPELINE_SCHEDULE } from "@/lib/constants";
import { usePipelineStage } from "@/hooks/use-pipeline-stage";
import { cn } from "@/lib/utils";

export function PipelineCompact() {
  const currentStage = usePipelineStage();

  const stageIds = PIPELINE_SCHEDULE.map((s) => s.id);
  const currentIdx = currentStage ? stageIds.indexOf(currentStage) : -1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1">
          {PIPELINE_SCHEDULE.map((stage, i) => {
            const isCompleted = i < currentIdx;
            const isActive = i === currentIdx;
            const isPending = i > currentIdx;

            return (
              <div key={stage.id} className="flex items-center flex-1">
                <div className="relative flex flex-col items-center flex-1">
                  <div
                    className={cn(
                      "size-2.5 rounded-full transition-all",
                      isCompleted && "bg-accent-green",
                      isActive && "bg-primary ring-2 ring-primary/30",
                      isPending && "bg-muted"
                    )}
                  />
                  <span className={cn(
                    "text-[8px] mt-1 text-center leading-tight",
                    isActive ? "text-primary font-medium" : "text-muted-foreground"
                  )}>
                    {stage.time}
                  </span>
                </div>
                {i < PIPELINE_SCHEDULE.length - 1 && (
                  <div
                    className={cn(
                      "h-px flex-1 -mx-0.5",
                      isCompleted ? "bg-accent-green" : "bg-muted"
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
