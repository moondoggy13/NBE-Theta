import { createClient } from "@supabase/supabase-js";
import type { APIConnection } from "@/types/settings";
import {
  paperClient,
  liveClient,
  liveTradingEnabled,
} from "@/server/services/alpaca/client";

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

  // Alpaca — paper account
  if (paperClient.available) {
    try {
      const account = await paperClient.getAccount();
      results.push({
        name: "Alpaca (Paper)",
        provider: "alpaca_paper",
        status: account.status === "ACTIVE" ? "connected" : "error",
        lastPing: now,
        detail: `${account.status} · $${parseFloat(account.portfolio_value).toLocaleString()}`,
      });
    } catch (err) {
      results.push({
        name: "Alpaca (Paper)",
        provider: "alpaca_paper",
        status: "error",
        lastPing: now,
        detail: err instanceof Error ? err.message : "fetch failed",
      });
    }
  } else {
    results.push({
      name: "Alpaca (Paper)",
      provider: "alpaca_paper",
      status: "disconnected",
    });
  }

  // Alpaca — live account
  if (liveClient.available) {
    try {
      const account = await liveClient.getAccount();
      results.push({
        name: "Alpaca (Live)",
        provider: "alpaca_live",
        status: account.status === "ACTIVE" ? "connected" : "error",
        lastPing: now,
        detail: liveTradingEnabled()
          ? `${account.status} · $${parseFloat(account.portfolio_value).toLocaleString()} · trading enabled`
          : `${account.status} · $${parseFloat(account.portfolio_value).toLocaleString()} · trading disabled`,
      });
    } catch (err) {
      results.push({
        name: "Alpaca (Live)",
        provider: "alpaca_live",
        status: "error",
        lastPing: now,
        detail: err instanceof Error ? err.message : "fetch failed",
      });
    }
  } else {
    results.push({
      name: "Alpaca (Live)",
      provider: "alpaca_live",
      status: "disconnected",
    });
  }

  // OANDA (TradingView-linked forex/CFD account)
  if (process.env.OANDA_API_KEY) {
    const baseUrl = process.env.OANDA_BASE_URL || "https://api-fxtrade.oanda.com/v3";
    try {
      const res = await fetch(`${baseUrl}/accounts`, {
        headers: { Authorization: `Bearer ${process.env.OANDA_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      const env = baseUrl.includes("fxpractice") ? "practice" : "live";
      let detail: string;
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { accounts?: { id: string }[] } | null;
        detail = body?.accounts?.length
          ? `${env} · ${body.accounts.length} account${body.accounts.length === 1 ? "" : "s"}`
          : env;
      } else {
        detail = `${env} · HTTP ${res.status}`;
      }
      results.push({
        name: "OANDA",
        provider: "oanda",
        status: res.ok ? "connected" : "error",
        lastPing: now,
        detail,
      });
    } catch (err) {
      results.push({
        name: "OANDA",
        provider: "oanda",
        status: "error",
        lastPing: now,
        detail: err instanceof Error ? err.message : "fetch failed",
      });
    }
  } else {
    results.push({
      name: "OANDA",
      provider: "oanda",
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
