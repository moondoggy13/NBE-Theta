"use client";

import { useState, useEffect } from "react";
import type { PipelineStageId } from "@/types/pipeline";
import { PIPELINE_SCHEDULE } from "@/lib/constants";

export function usePipelineStage() {
  const [currentStage, setCurrentStage] = useState<PipelineStageId | null>(null);

  useEffect(() => {
    function update() {
      const now = new Date();
      const t = now.getHours() * 60 + now.getMinutes();
      let active: PipelineStageId | null = null;

      for (const stage of PIPELINE_SCHEDULE) {
        const stageTime = stage.hour * 60 + stage.minute;
        if (t >= stageTime) {
          active = stage.id as PipelineStageId;
        }
      }
      setCurrentStage(active);
    }

    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, []);

  return currentStage;
}
