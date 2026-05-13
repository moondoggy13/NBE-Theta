import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

dotenvConfig({ path: [".env.local", ".env"], override: true });

// Fallback SUPABASE_URL → NEXT_PUBLIC_SUPABASE_URL so setups that only
// set the public var still work for server-side code.
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}
// Accept legacy name COINBASE_API_SECRET_KEY as alias for COINBASE_API_PRIVATE_KEY.
if (!process.env.COINBASE_API_PRIVATE_KEY && process.env.COINBASE_API_SECRET_KEY) {
  process.env.COINBASE_API_PRIVATE_KEY = process.env.COINBASE_API_SECRET_KEY;
}
// CDP v2 keys carry a project_id + bare key UUID. The Coinbase Advanced Trade
// JWT `kid` for these keys is `projects/{PROJECT_ID}/apiKeys/{KID}`. If the
// user supplied PROJECT_ID + KID and the key name is unset or just a bare
// UUID, build the full path. Leave names that already include a slash alone.
{
  const projectId = process.env.COINBASE_PROJECT_ID ?? process.env.PROJECT_ID;
  const kid = process.env.KID ?? process.env.COINBASE_API_KEY_NAME;
  const current = process.env.COINBASE_API_KEY_NAME ?? "";
  if (projectId && kid && !current.includes("/")) {
    process.env.COINBASE_API_KEY_NAME = `projects/${projectId}/apiKeys/${kid}`;
  }
}

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  REDIS_URL: z.string().url().optional(),

  COINBASE_MODE: z.enum(["paper", "live"]).default("paper"),
  COINBASE_LIVE: z.enum(["true", "false"]).default("false"),
  CONFIRM_LIVE: z.enum(["YES", "NO"]).default("NO"),
  COINBASE_API_KEY_NAME: z.string().optional(),
  COINBASE_API_PRIVATE_KEY: z.string().optional(),
  FLATTEN_ON_EXIT: z.enum(["true", "false"]).default("false"),

  // Execution provider routing. "coinbase" preserves the original Coinbase
  // Advanced Trade path (gated by COINBASE_MODE/COINBASE_LIVE/CONFIRM_LIVE).
  // "computer-use" routes orders to a local agent-host that drives the
  // Webull desktop app via Claude or OpenAI computer-use.
  // "mock" forces the in-process mock broker regardless of other flags.
  EXECUTION_PROVIDER: z.enum(["coinbase", "computer-use", "mock"]).default("coinbase"),

  // Computer-use provider config. The host runs on the trading workstation
  // and is the ONLY process with OS-level input access. The worker speaks
  // to it over HTTP+WS; credentials never live in this repo.
  COMPUTER_USE_HOST_URL: z.string().url().optional(),
  COMPUTER_USE_HOST_TOKEN: z.string().optional(),
  COMPUTER_USE_DRIVER: z.enum(["claude", "openai"]).default("claude"),
  COMPUTER_USE_LIVE: z.enum(["true", "false"]).default("false"),
  COMPUTER_USE_REQUIRE_CONFIRM: z.enum(["true", "false"]).default("true"),
  COMPUTER_USE_DRY_RUN: z.enum(["true", "false"]).default("true"),
  COMPUTER_USE_MAX_NOTIONAL_USD: z.coerce.number().default(50),
  WEBULL_ACCOUNT_LABEL: z.string().optional(),

  RISK_PRESET: z.enum(["Conservative", "Moderate", "Aggressive", "Custom"]).default("Aggressive"),
  RISK_START_EQUITY: z.coerce.number().optional(),
  RISK_PER_TRADE_PCT: z.coerce.number().optional(),
  RISK_DAILY_STOP_PCT: z.coerce.number().optional(),

  SYMBOL: z.string().default("BTC-USD"),
}).passthrough();

export type AppEnv = z.infer<typeof Env>;

let cached: AppEnv | null = null;
export function loadEnv(): AppEnv {
  if (cached) return cached;
  cached = Env.parse(process.env);
  return cached;
}

/** Both gates must agree for live orders to be allowed. */
export function isLiveEnabled(env: AppEnv = loadEnv()): boolean {
  return env.COINBASE_MODE === "live" && env.COINBASE_LIVE === "true" && env.CONFIRM_LIVE === "YES";
}

/**
 * Three gates for computer-use live trading. Defense in depth matching the
 * Coinbase two-gate pattern — computer-use adds a third gate because the
 * failure modes (window-not-focused, OCR misread, model hallucinating a
 * click) are stranger and less reversible than an API error.
 */
export function isComputerUseLiveEnabled(env: AppEnv = loadEnv()): boolean {
  return (
    env.EXECUTION_PROVIDER === "computer-use" &&
    env.COMPUTER_USE_LIVE === "true" &&
    env.CONFIRM_LIVE === "YES"
  );
}
