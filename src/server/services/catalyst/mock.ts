import type { ICatalystProvider, ProviderInput, LayerResult } from "../types";

const MOCK_CATALYSTS: Record<string, { score: number; signals: string[] }> = {
  NVDA: { score: 23, signals: ["Earnings beat by 12%", "Raised FY guidance", "New hyperscaler contracts announced"] },
  AMZN: { score: 21, signals: ["AWS revenue growth 19% YoY", "Operating margin expansion to 11%"] },
  META: { score: 20, signals: ["Ad revenue up 22%", "Reels monetization inflection"] },
  TSLA: { score: 15, signals: ["Robotaxi timeline unclear", "Delivery miss last quarter"] },
  AAPL: { score: 18, signals: ["iPhone 17 upgrade cycle expected strong", "Apple Intelligence driving services"] },
  MSFT: { score: 22, signals: ["Azure growth reacceleration", "Copilot enterprise adoption surging"] },
  GOOGL: { score: 19, signals: ["Search revenue growth steady", "Cloud margins improving"] },
  AMD: { score: 20, signals: ["MI300X demand strong", "Data center GPU market share gains"] },
};

export class MockCatalystProvider implements ICatalystProvider {
  async getLayer(input: ProviderInput): Promise<LayerResult> {
    const data = MOCK_CATALYSTS[input.ticker] ?? { score: 12, signals: ["No significant catalysts detected"] };
    return {
      score: data.score,
      signals: data.signals,
      dataSource: "Perplexity Finance (Mock)",
      updatedAt: new Date().toISOString(),
    };
  }
}
