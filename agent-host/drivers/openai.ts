/**
 * OpenAI computer-use driver — stub.
 *
 * Same shape as `claude.ts`: skills exposed as tools, host enforces
 * preflight + dry-run + human confirm. The model differs (uses the
 * Responses API with the `computer-use-preview` model), but the
 * orchestration is identical.
 *
 * Not wired up by default; flip COMPUTER_USE_DRIVER=openai in the host
 * env to use it once the implementation is filled in.
 */
import type { CUADriver, DriverContext, FillReport } from "./types";
import type { SubmitOrderBody } from "../protocol";
import type { SkillRunner } from "../webull/skills";

export interface OpenAIDriverOptions {
  apiKey: string;
  model?: string;
  runner: SkillRunner;
}

export function createOpenAIDriver(_opts: OpenAIDriverOptions): CUADriver {
  return {
    name: "openai",
    async runOrder(_order: SubmitOrderBody, _ctx: DriverContext): Promise<FillReport> {
      return {
        filled: false,
        ts: Date.now(),
        reason: "openai driver not implemented; use COMPUTER_USE_DRIVER=claude",
        actions: [],
      };
    },
  };
}
