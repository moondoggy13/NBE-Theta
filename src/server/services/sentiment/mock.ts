import type { ISentimentProvider, ProviderInput, LayerResult } from "../types";

const MOCK_SENTIMENT: Record<string, { score: number; signals: string[] }> = {
  NVDA: { score: 22, signals: ["Analyst upgrades from MS and GS", "Social sentiment trending up (not peak)", "Institutional commentary constructive"] },
  AMZN: { score: 19, signals: ["Positive news sentiment trend", "Institutional commentary shifting bullish"] },
  META: { score: 18, signals: ["Sentiment improving but cautious on capex spending"] },
  TSLA: { score: 11, signals: ["Polarized sentiment", "Social hype fading"] },
  AAPL: { score: 15, signals: ["Neutral to slightly positive sentiment"] },
  MSFT: { score: 20, signals: ["Consistently positive analyst sentiment", "Copilot narrative strong"] },
  GOOGL: { score: 17, signals: ["Improving sentiment on AI integration", "Regulatory overhang fading"] },
  AMD: { score: 18, signals: ["Positive momentum in sentiment", "Competition narrative favorable"] },
};

export class MockSentimentProvider implements ISentimentProvider {
  async getLayer(input: ProviderInput): Promise<LayerResult> {
    const data = MOCK_SENTIMENT[input.ticker] ?? { score: 12, signals: ["Neutral sentiment"] };
    return {
      score: data.score,
      signals: data.signals,
      dataSource: "Supabase pgvector / News (Mock)",
      updatedAt: new Date().toISOString(),
    };
  }
}
