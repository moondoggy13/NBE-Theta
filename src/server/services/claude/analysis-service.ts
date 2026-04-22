import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Centralized Claude API service for all analysis stages.
 * Handles API calls, response parsing, and analysis persistence.
 */
export class ClaudeAnalysisService {
  private apiKey: string;
  private db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    this.db = db;
  }

  get isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Send a prompt to Claude and return the parsed JSON response.
   * Stores the response in claude_analyses for learning history.
   */
  async analyze<T>(options: {
    prompt: string;
    stage: "premarket" | "synthesis" | "regime" | "eod";
    ticker?: string;
    runDate: string;
    maxTokens?: number;
  }): Promise<{ data: T | null; raw: string }> {
    if (!this.isAvailable) {
      return { data: null, raw: "" };
    }

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: options.maxTokens ?? 1024,
          messages: [{ role: "user", content: options.prompt }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
        return { data: null, raw: "" };
      }

      const body: ClaudeResponse = await res.json();
      const raw = body.content?.[0]?.text ?? "";
      const tokensUsed =
        (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);

      // Persist to claude_analyses
      const promptHash = createHash("sha256")
        .update(options.prompt)
        .digest("hex")
        .slice(0, 16);

      let parsed: T | null = null;
      try {
        // Extract JSON from response (handle markdown code blocks)
        const jsonStr = raw.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
        parsed = JSON.parse(jsonStr) as T;
      } catch {
        // Response wasn't valid JSON — store raw but return null data
      }

      await this.db.from("claude_analyses").insert({
        run_date: options.runDate,
        stage: options.stage,
        ticker: options.ticker ?? null,
        prompt_hash: promptHash,
        response: parsed ?? { raw },
        model: MODEL,
        tokens_used: tokensUsed,
      });

      return { data: parsed, raw };
    } catch (err) {
      console.warn("Claude analysis error:", err);
      return { data: null, raw: "" };
    }
  }
}
