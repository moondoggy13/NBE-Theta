import type { MacroSnapshot } from "../macro/types";

/** Format macro regime context for Claude prompts */
export function formatMacroContext(macro: MacroSnapshot | null): string {
  if (!macro || macro.indicators.length === 0) {
    return "Macro data: unavailable for today.";
  }

  const lines = macro.indicators.map((i) => {
    const change = i.changePct != null ? ` (${i.changePct > 0 ? "+" : ""}${i.changePct.toFixed(1)}%)` : "";
    return `  ${i.label}: ${i.value}${change}`;
  });

  return [
    `Macro Regime: ${macro.regime.toUpperCase()} (modifier: ${macro.economicModifier > 0 ? "+" : ""}${macro.economicModifier})`,
    `Summary: ${macro.summary}`,
    "Key Indicators:",
    ...lines,
  ].join("\n");
}

/** Pre-market batch analysis prompt */
export function premarketPrompt(
  stocks: Array<{
    ticker: string;
    name: string;
    sector: string;
    catalystScore: number;
    catalystSignals: string[];
  }>,
  macroContext: string
): string {
  const stockList = stocks
    .map(
      (s) =>
        `- ${s.ticker} (${s.name}, ${s.sector}): catalyst ${s.catalystScore}/25 — ${s.catalystSignals.join("; ")}`
    )
    .join("\n");

  return `You are an equity research analyst for a systematic trading system. Analyze today's pre-market catalyst data and macro environment to produce refined assessments.

${macroContext}

Stocks under review:
${stockList}

For each stock, provide:
1. A refined catalyst score (0-25) considering macro context and cross-stock dynamics
2. A one-sentence trade thesis
3. Key risk to the thesis

Also provide:
- Cross-stock correlation risks (are multiple stocks exposed to the same catalyst?)
- Sector-level macro headwinds or tailwinds

Return JSON only — no markdown. Format:
{
  "stocks": [
    { "ticker": "...", "score": <0-25>, "thesis": "...", "risk": "..." }
  ],
  "correlationRisks": "...",
  "sectorNotes": "..."
}`;
}

/** Signal synthesis prompt — called per ticker after all 5 layers score */
export function synthesisPrompt(
  ticker: string,
  name: string,
  layers: {
    catalyst: { score: number; signals: string[] };
    technical: { score: number; signals: string[] };
    options: { score: number; signals: string[] };
    sentiment: { score: number; signals: string[] };
    economic: { score: number; signals: string[] };
  },
  convictionScore: number,
  macroContext: string
): string {
  return `You are a signal validation analyst. Review the multi-layer scoring for ${ticker} (${name}) and determine if the signals are confirming or conflicting.

${macroContext}

Current scores (each 0-25):
  Catalyst:  ${layers.catalyst.score} — ${layers.catalyst.signals.join("; ")}
  Technical: ${layers.technical.score} — ${layers.technical.signals.join("; ")}
  Options:   ${layers.options.score} — ${layers.options.signals.join("; ")}
  Sentiment: ${layers.sentiment.score} — ${layers.sentiment.signals.join("; ")}
  Economic:  ${layers.economic.score} — ${layers.economic.signals.join("; ")}

Normalized conviction score: ${convictionScore}/100

Assess:
1. Are the signals confirming (all pointing same direction) or conflicting?
2. What is the single biggest risk that could invalidate this setup?
3. Should the conviction score be adjusted? Provide a modifier from -5 to +5.

Return JSON only:
{
  "confirming": true/false,
  "confidence": "high" | "medium" | "low",
  "modifier": <-5 to +5>,
  "risk": "...",
  "thesis": "..."
}`;
}

/** Mid-day regime assessment prompt */
export function regimePrompt(
  positions: Array<{
    ticker: string;
    entryPrice: number;
    currentPrice: number;
    pnlPercent: number;
    stopLoss: number;
    target: number;
  }>,
  dailyPnlPct: number,
  macroContext: string
): string {
  const posLines = positions
    .map(
      (p) =>
        `  ${p.ticker}: entry $${p.entryPrice} → $${p.currentPrice} (${p.pnlPercent > 0 ? "+" : ""}${p.pnlPercent.toFixed(2)}%) | SL $${p.stopLoss} | TGT $${p.target}`
    )
    .join("\n");

  return `You are a portfolio risk manager for a systematic trading system. Assess the current mid-day regime and provide actionable guidance.

Portfolio daily P&L: ${dailyPnlPct > 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%
Kill switch threshold: -3%

${macroContext}

Active positions:
${posLines}

Assess:
1. Overall market character — is the morning trend continuing or reversing?
2. Per-position recommendation: HOLD, TIGHTEN_STOP, or EXIT_EARLY (with reason)
3. Should we reduce overall exposure given current conditions?

Return JSON only:
{
  "marketCharacter": "trending" | "choppy" | "reversing",
  "overallAction": "hold" | "reduce" | "exit_all",
  "positions": [
    { "ticker": "...", "action": "hold" | "tighten_stop" | "exit_early", "reason": "..." }
  ],
  "summary": "..."
}`;
}

/** End-of-day reflection prompt */
export function eodReflectionPrompt(
  trades: Array<{
    ticker: string;
    pnlDollars: number;
    pnlPercent: number;
    convictionAtEntry: number;
    exitReason: string;
  }>,
  totalDayPnl: number,
  macroContext: string
): string {
  const tradeLines = trades
    .map(
      (t) =>
        `  ${t.ticker}: ${t.pnlDollars > 0 ? "+" : ""}$${t.pnlDollars.toFixed(2)} (${t.pnlPercent > 0 ? "+" : ""}${t.pnlPercent.toFixed(2)}%) | conviction ${t.convictionAtEntry} | exit: ${t.exitReason}`
    )
    .join("\n");

  return `You are a trading performance analyst. Review today's completed trades and provide learning insights.

${macroContext}

Total day P&L: ${totalDayPnl > 0 ? "+" : ""}$${totalDayPnl.toFixed(2)}

Trades:
${tradeLines}

Analyze:
1. Which signal layers were most predictive today? Which were misleading?
2. Did high-conviction entries (>= 80) outperform lower-conviction ones?
3. What patterns should we reinforce or avoid tomorrow?
4. Were stop losses and targets well-calibrated?

Return JSON only:
{
  "winRate": <0-100>,
  "bestSignalLayer": "catalyst" | "technical" | "options" | "sentiment" | "economic",
  "worstSignalLayer": "catalyst" | "technical" | "options" | "sentiment" | "economic",
  "highConvictionAccuracy": <0-100>,
  "learnings": ["...", "..."],
  "tomorrowAdjustments": "..."
}`;
}
