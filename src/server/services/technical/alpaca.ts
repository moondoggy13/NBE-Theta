import type { ITechnicalProvider, ProviderInput, LayerResult } from "../types";

export class AlpacaTechnicalProvider implements ITechnicalProvider {
  private apiKey: string;
  private secretKey: string;
  private dataUrl: string;

  constructor() {
    this.apiKey = process.env.ALPACA_API_KEY || "";
    this.secretKey = process.env.ALPACA_SECRET_KEY || "";
    this.dataUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets/v2";
  }

  private async fetchBars(ticker: string, timeframe: string, limit: number) {
    const res = await fetch(
      `${this.dataUrl}/stocks/${ticker}/bars?timeframe=${timeframe}&limit=${limit}`,
      {
        headers: {
          "APCA-API-KEY-ID": this.apiKey,
          "APCA-API-SECRET-KEY": this.secretKey,
        },
      }
    );
    if (!res.ok) throw new Error(`Alpaca bars error: ${res.status}`);
    return res.json();
  }

  async getLayer(input: ProviderInput): Promise<LayerResult> {
    try {
      const barsData = await this.fetchBars(input.ticker, "1Day", 50);
      const bars = barsData.bars || [];

      if (bars.length < 20) {
        return { score: 12, signals: ["Insufficient data for technical analysis"], dataSource: "Alpaca Market Data", updatedAt: new Date().toISOString() };
      }

      const closes = bars.map((b: { c: number }) => b.c);
      const volumes = bars.map((b: { v: number }) => b.v);
      const latest = closes[closes.length - 1];

      // Simple EMA calculations
      const ema20 = this.ema(closes, 20);
      const ema50 = this.ema(closes, 50);
      const avgVol = volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
      const latestVol = volumes[volumes.length - 1];

      const signals: string[] = [];
      let score = 12; // baseline

      // Price vs EMAs
      if (latest > ema20) { score += 3; signals.push(`Above 20 EMA ($${ema20.toFixed(2)})`); }
      if (latest > ema50) { score += 3; signals.push(`Above 50 EMA ($${ema50.toFixed(2)})`); }
      if (ema20 > ema50) { score += 2; signals.push("Bullish EMA alignment (20 > 50)"); }

      // Volume confirmation
      if (latestVol > avgVol * 1.5) { score += 3; signals.push(`Volume surge: ${(latestVol / avgVol).toFixed(1)}x avg`); }
      else if (latestVol > avgVol) { score += 1; signals.push("Above-average volume"); }

      // Momentum (5-day change)
      const fiveDayChange = (latest - closes[closes.length - 6]) / closes[closes.length - 6] * 100;
      if (fiveDayChange > 3) { score += 2; signals.push(`Strong 5-day momentum: +${fiveDayChange.toFixed(1)}%`); }

      return {
        score: Math.min(25, score),
        signals: signals.slice(0, 4),
        dataSource: "Alpaca Market Data",
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        score: 12,
        signals: [`Technical analysis error: ${err instanceof Error ? err.message : "unknown"}`],
        dataSource: "Alpaca Market Data",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private ema(data: number[], period: number): number {
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }
}
