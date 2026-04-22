"use client";

import { AnimatedCircularProgressBar } from "@/components/magicui/animated-circular-progress-bar";
import { STRATEGY } from "@/lib/constants";

function getScoreColor(score: number): { primary: string; secondary: string } {
  if (score >= STRATEGY.MIN_CONVICTION_SCORE) {
    return { primary: "oklch(0.70 0.17 155)", secondary: "oklch(0.70 0.17 155 / 20%)" };
  }
  if (score >= 40) {
    return { primary: "oklch(0.80 0.16 85)", secondary: "oklch(0.80 0.16 85 / 20%)" };
  }
  return { primary: "oklch(0.65 0.2 25)", secondary: "oklch(0.65 0.2 25 / 20%)" };
}

export function ConvictionScoreRing({
  score,
  size = "default",
}: {
  score: number;
  size?: "default" | "small";
}) {
  const colors = getScoreColor(score);

  return (
    <AnimatedCircularProgressBar
      value={score}
      max={100}
      min={0}
      gaugePrimaryColor={colors.primary}
      gaugeSecondaryColor={colors.secondary}
      className={size === "small" ? "size-12 text-xs" : "size-32 text-2xl"}
    />
  );
}
