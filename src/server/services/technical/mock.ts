import type { ITechnicalProvider, ProviderInput, LayerResult } from "../types";

const MOCK_TECHNICALS: Record<string, { score: number; signals: string[] }> = {
  NVDA: { score: 22, signals: ["Breakout above $138 resistance on 2x volume", "Above 50 & 200 EMA", "RS vs QQQ positive"] },
  AMZN: { score: 20, signals: ["Consolidation breakout on volume", "Above all key EMAs"] },
  META: { score: 18, signals: ["Trading above 50 EMA", "Relative strength positive vs XLC"] },
  TSLA: { score: 14, signals: ["Below 200 EMA", "High overhead resistance at $290"] },
  AAPL: { score: 17, signals: ["Near 50 EMA — needs breakout", "Low volume recently"] },
  MSFT: { score: 19, signals: ["Holding above 200 EMA", "Volume expanding on up days"] },
  GOOGL: { score: 18, signals: ["Testing resistance at $180", "RSI approaching overbought"] },
  AMD: { score: 21, signals: ["Breakout from base pattern", "Volume surge above average"] },
};

export class MockTechnicalProvider implements ITechnicalProvider {
  async getLayer(input: ProviderInput): Promise<LayerResult> {
    const data = MOCK_TECHNICALS[input.ticker] ?? { score: 12, signals: ["Neutral technical setup"] };
    return {
      score: data.score,
      signals: data.signals,
      dataSource: "Alpaca Market Data (Mock)",
      updatedAt: new Date().toISOString(),
    };
  }
}
