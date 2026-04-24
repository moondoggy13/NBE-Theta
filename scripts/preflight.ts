#!/usr/bin/env tsx
/**
 * Preflight checks: Supabase + Redis + Coinbase auth + schema presence.
 * Exits 0 if everything is reachable; prints clear remediation otherwise.
 *
 *   pnpm tsx scripts/preflight.ts
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"], override: true });

import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";
import { CoinbaseAdvancedClient } from "../src/lib/broker/coinbase-advanced";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function ok(msg: string)    { console.log(`${GREEN}  ok${RESET}   ${msg}`); }
function warn(msg: string)  { console.log(`${YELLOW} warn${RESET}   ${msg}`); }
function fail(msg: string)  { console.log(`${RED} fail${RESET}   ${msg}`); }
function hint(msg: string)  { console.log(`${DIM}        ${msg}${RESET}`); }

async function checkSupabase(): Promise<"ok" | "schema-missing" | "fail"> {
  console.log("\n── Supabase");
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail(`missing ${!url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY"}`);
    return "fail";
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  try {
    const { error } = await sb.from("risk_state").select("id").limit(1);
    if (error) {
      if (/relation .* does not exist/i.test(error.message) || /schema cache/i.test(error.message)) {
        warn("connected, but schema not applied");
        hint("open the Supabase SQL Editor and run supabase/migrations/003_crypto_schema.sql");
        return "schema-missing";
      }
      fail(`query error: ${error.message}`);
      return "fail";
    }
    ok(`connected (${url})`);
    return "ok";
  } catch (err) {
    fail(`connection failed: ${(err as Error).message}`);
    return "fail";
  }
}

async function checkRedis(): Promise<boolean> {
  console.log("\n── Redis");
  const url = process.env.REDIS_URL;
  if (!url) {
    warn("REDIS_URL not set — skipping");
    return false;
  }
  const client = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 10_000, lazyConnect: true });
  try {
    await client.connect();
    const pong = await client.ping();
    ok(`PING → ${pong}`);
    await client.set("nbe:preflight", Date.now().toString(), "EX", 60);
    const round = await client.get("nbe:preflight");
    ok(`SET/GET round-trip: ${round ? "working" : "failed"}`);
    await client.quit();
    return true;
  } catch (err) {
    fail((err as Error).message);
    try { await client.quit(); } catch {}
    return false;
  }
}

async function checkCoinbase(): Promise<boolean> {
  console.log("\n── Coinbase Advanced Trade");
  const name = process.env.COINBASE_API_KEY_NAME;
  const priv = process.env.COINBASE_API_PRIVATE_KEY;
  if (!name || !priv) {
    warn("COINBASE_API_KEY_NAME or COINBASE_API_PRIVATE_KEY not set — skipping auth test");
    return false;
  }
  try {
    const client = new CoinbaseAdvancedClient({
      apiKeyName: name,
      apiPrivateKey: priv,
      symbol: "BTC-USD",
      liveEnabled: true, // only used locally for signing test; doesn't place orders
    });
    const acct = await client.getAccount();
    ok(`authenticated (buyingPower=$${acct.buyingPower.toFixed(2)} equity≈${acct.equity.toFixed(6)})`);
    return true;
  } catch (err) {
    fail((err as Error).message);
    const msg = (err as Error).message;
    if (/401|unauthorized/i.test(msg)) {
      hint("401 usually means: wrong key name/ID used as JWT `kid`, expired key, or wrong key family.");
      hint("Coinbase expects `kid` = the key UUID from the CDP key download.");
    } else if (/403/.test(msg)) {
      hint("403 usually means IP restriction or permission set missing (Trade/View).");
    }
    return false;
  }
}

async function main() {
  const mode = process.env.COINBASE_MODE ?? "paper";
  const live = process.env.COINBASE_LIVE ?? "false";
  const confirm = process.env.CONFIRM_LIVE ?? "NO";

  console.log(`Mode: ${mode} · LIVE flag: ${live} · CONFIRM: ${confirm}`);
  if (mode === "paper" && live === "true" && confirm === "YES") {
    warn("LIVE gates are set but COINBASE_MODE=paper — no real orders will be placed.");
    hint("Flip COINBASE_MODE=live in .env.local to actually route to Coinbase.");
  }

  const sb = await checkSupabase();
  const rd = await checkRedis();
  const cb = await checkCoinbase();

  console.log("\n── Summary");
  console.log(`  Supabase: ${sb}`);
  console.log(`  Redis:    ${rd ? "ok" : "fail/skip"}`);
  console.log(`  Coinbase: ${cb ? "ok" : "fail/skip"}`);

  const ready = sb === "ok" && rd && cb;
  if (!ready) {
    console.log(`\n${YELLOW}Not ready for paper trading yet.${RESET} Resolve the items above.`);
    process.exit(1);
  }
  console.log(`\n${GREEN}All systems green.${RESET} pnpm dev:worker to start the tick loop.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
