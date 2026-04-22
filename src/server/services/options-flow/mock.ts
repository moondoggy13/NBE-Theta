import type { IOptionsFlowProvider, ProviderInput, LayerResult } from "../types";

const MOCK_OPTIONS: Record<string, { score: number; signals: string[] }> = {
  NVDA: { score: 21, signals: ["Heavy $150 call buying — June expiry", "Put/call ratio 0.4 vs sector 0.7", "IV rank 62"] },
  AMZN: { score: 19, signals: ["Call sweep at $205 strike", "IV expanding pre-move"] },
  META: { score: 18, signals: ["Moderate call buying at $600 strike"] },
  TSLA: { score: 12, signals: ["Mixed flow — puts and calls balanced"] },
  AAPL: { score: 15, signals: ["Moderate call activity at $235"] },
  MSFT: { score: 20, signals: ["Aggressive call sweeps at $450 strike", "Low put/call ratio 0.3"] },
  GOOGL: { score: 17, signals: ["Steady call accumulation", "IV rank 55"] },
  AMD: { score: 19, signals: ["Heavy call buying at $180 strike", "Unusual sweep volume"] },
};

export class MockOptionsFlowProvider implements IOptionsFlowProvider {
  async getLayer(input: ProviderInput): Promise<LayerResult> {
    const data = MOCK_OPTIONS[input.ticker] ?? { score: 12, signals: ["No notable options activity"] };
    return {
      score: data.score,
      signals: data.signals,
      dataSource: "Unusual Whales (Mock)",
      updatedAt: new Date().toISOString(),
    };
  }
}
