import { createClient } from "@supabase/supabase-js";
import type { APIConnection } from "@/types/settings";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
      })
    : null;

export async function checkConnections(): Promise<APIConnection[]> {
  const now = new Date().toISOString();
  const results: APIConnection[] = [];

  // Supabase (PostgreSQL + pgvector)
  if (supabase) {
    try {
      await supabase.from("pipeline_runs").select("id").limit(1);
      results.push({
        name: "Supabase (DB + Vectors)",
        provider: "supabase",
        status: "connected",
        lastPing: now,
      });
    } catch {
      results.push({
        name: "Supabase (DB + Vectors)",
        provider: "supabase",
        status: "error",
        lastPing: now,
      });
    }
  } else {
    results.push({
      name: "Supabase (DB + Vectors)",
      provider: "supabase",
      status: "disconnected",
    });
  }

  // Redis
  if (process.env.REDIS_URL) {
    try {
      const { getRedis } = await import("./redis");
      const redis = getRedis();
      await redis.ping();
      results.push({
        name: "Redis Cloud",
        provider: "redis",
        status: "connected",
        lastPing: now,
      });
    } catch {
      results.push({
        name: "Redis Cloud",
        provider: "redis",
        status: "error",
        lastPing: now,
      });
    }
  } else {
    results.push({
      name: "Redis Cloud",
      provider: "redis",
      status: "disconnected",
    });
  }

  // Alpaca
  if (process.env.ALPACA_API_KEY) {
    try {
      const res = await fetch(
        `${process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets/v2"}/account`,
        {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
          },
        }
      );
      results.push({
        name: "Alpaca Markets",
        provider: "alpaca",
        status: res.ok ? "connected" : "error",
        lastPing: now,
      });
    } catch {
      results.push({
        name: "Alpaca Markets",
        provider: "alpaca",
        status: "error",
        lastPing: now,
      });
    }
  } else {
    results.push({
      name: "Alpaca Markets",
      provider: "alpaca",
      status: "disconnected",
    });
  }

  // Perplexity
  results.push({
    name: "Perplexity Finance",
    provider: "perplexity",
    status: process.env.PERPLEXITY_API_KEY ? "connected" : "disconnected",
    lastPing: process.env.PERPLEXITY_API_KEY ? now : undefined,
  });

  // Unusual Whales (no key yet)
  results.push({
    name: "Unusual Whales",
    provider: "unusual_whales",
    status: "disconnected",
  });

  // Economic Calendar
  results.push({
    name: "Economic Calendar",
    provider: "economic_calendar",
    status: process.env.ECONOMIC_CALENDAR_ENABLED ? "connected" : "disconnected",
    lastPing: process.env.ECONOMIC_CALENDAR_ENABLED ? now : undefined,
  });

  // FRED API (Macro Data)
  if (process.env.FRED_API_KEY) {
    try {
      const res = await fetch(
        `https://api.stlouisfed.org/fred/series?series_id=VIXCLS&api_key=${process.env.FRED_API_KEY}&file_type=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      results.push({
        name: "FRED API (Macro)",
        provider: "fred",
        status: res.ok ? "connected" : "error",
        lastPing: now,
      });
    } catch {
      results.push({
        name: "FRED API (Macro)",
        provider: "fred",
        status: "error",
        lastPing: now,
      });
    }
  } else {
    results.push({
      name: "FRED API (Macro)",
      provider: "fred",
      status: "disconnected",
    });
  }

  // Anthropic (Claude Max)
  results.push({
    name: "Claude Intelligence",
    provider: "anthropic",
    status: process.env.ANTHROPIC_API_KEY ? "connected" : "disconnected",
    lastPing: process.env.ANTHROPIC_API_KEY ? now : undefined,
  });

  return results;
}
