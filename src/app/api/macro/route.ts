import { NextResponse } from "next/server";
import { getMacroIndicatorsForToday } from "@/server/db/queries/macro";
import { macroProvider } from "@/server/services/registry";
import type { MacroSnapshot } from "@/server/services/macro/types";

export const dynamic = "force-dynamic";

const mockSnapshot: MacroSnapshot = {
  regime: "neutral",
  indicators: [],
  economicModifier: 0,
  summary: "No macro data available — using mock defaults",
  fetchedAt: new Date().toISOString(),
};

export async function GET() {
  try {
    const indicators = await getMacroIndicatorsForToday();

    if (indicators.length > 0) {
      const snapshot = macroProvider.classifyRegime(indicators);
      return NextResponse.json(snapshot);
    }

    // No DB data — try live fetch fallback
    try {
      const liveIndicators = await macroProvider.fetchIndicators();
      if (liveIndicators.length > 0) {
        return NextResponse.json(macroProvider.classifyRegime(liveIndicators));
      }
    } catch {
      // Fall through to mock
    }

    return NextResponse.json(mockSnapshot);
  } catch {
    return NextResponse.json(mockSnapshot);
  }
}
