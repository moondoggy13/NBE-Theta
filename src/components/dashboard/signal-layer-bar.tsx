"use client";

import { SIGNAL_LAYERS, STRATEGY } from "@/lib/constants";
import type { SignalLayer } from "@/types/signals";


export function SignalLayerBar({ layers }: { layers: SignalLayer[] }) {
  return (
    <div className="space-y-3">
      {SIGNAL_LAYERS.map((config) => {
        const layer = layers.find((l) => l.name === config.name);
        const score = layer?.score ?? 0;
        const pct = (score / STRATEGY.LAYER_MAX_SCORE) * 100;

        return (
          <div key={config.name} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span style={{ color: config.color }} className="font-medium">
                {config.label}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {score} / {STRATEGY.LAYER_MAX_SCORE}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden" title={layer?.signals.join(" | ")}>
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: `${pct}%`,
                  backgroundColor: config.color,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
