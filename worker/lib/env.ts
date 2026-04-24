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
