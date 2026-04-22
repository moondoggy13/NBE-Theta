import type { ICatalystProvider, ProviderInput, LayerResult } from "../types";

export class PerplexityCatalystProvider implements ICatalystProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.PERPLEXITY_API_KEY || "";
  }

  async getLayer(input: ProviderInput): Promise<LayerResult> {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are a financial analyst. Score the catalyst strength for the given stock on a 0-25 scale. Return ONLY valid JSON with keys: score (number 0-25), signals (array of 2-4 short strings describing the catalysts).",
          },
          {
            role: "user",
            content: `Analyze the current catalysts for ${input.ticker} (${input.name}, ${input.sector} sector). What are the key near-term catalysts? Score 0-25 where 25 = extremely strong catalysts.`,
          },
        ],
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      throw new Error(`Perplexity API error: ${res.status}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";

    try {
      const parsed = JSON.parse(content);
      return {
        score: Math.min(25, Math.max(0, Number(parsed.score) || 0)),
        signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 4) : ["Catalyst data retrieved"],
        dataSource: "Perplexity Finance",
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return {
        score: 12,
        signals: ["Catalyst analysis completed — parsing error, using baseline"],
        dataSource: "Perplexity Finance",
        updatedAt: new Date().toISOString(),
      };
    }
  }
}
