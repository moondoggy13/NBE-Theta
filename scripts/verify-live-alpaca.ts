/**
 * Verifies the live Alpaca account is wired up and ready to trade.
 *
 * Usage from the project root:
 *   pnpm tsx scripts/verify-live-alpaca.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: [".env.local", ".env", ".env.live"], override: true });

const KEY = process.env.ALPACA_LIVE_API_KEY;
const SECRET = process.env.ALPACA_LIVE_SECRET_KEY;
const BASE = process.env.ALPACA_LIVE_BASE_URL || "https://api.alpaca.markets/v2";
const ENABLED = process.env.ALPACA_LIVE_TRADING_ENABLED;

function flag(label: string, ok: boolean, note: string) {
  console.log(`  ${ok ? "OK " : "X  "} ${label.padEnd(32)} ${note}`);
}

async function main() {
  console.log("Live Alpaca readiness check");
  console.log("---------------------------");

  flag("ALPACA_LIVE_API_KEY", !!KEY, KEY ? `set (${KEY.slice(0, 4)}...)` : "MISSING");
  flag("ALPACA_LIVE_SECRET_KEY", !!SECRET, SECRET ? "set" : "MISSING");
  flag("ALPACA_LIVE_BASE_URL", true, BASE);
  flag(
    "ALPACA_LIVE_TRADING_ENABLED",
    ENABLED === "true",
    ENABLED === "true"
      ? "true (orders WILL be submitted)"
      : `${ENABLED ?? "unset"} (orders will NOT be submitted)`,
  );

  if (!KEY || !SECRET) {
    console.log("\nFix the missing vars above, then re-run.");
    process.exit(1);
  }

  console.log(`\nPinging ${BASE}/account ...`);
  try {
    const res = await fetch(`${BASE}/account`, {
      headers: {
        "APCA-API-KEY-ID": KEY,
        "APCA-API-SECRET-KEY": SECRET,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`  X  HTTP ${res.status}: ${body.slice(0, 200)}`);
      process.exit(1);
    }

    const acct = (await res.json()) as {
      id: string;
      status: string;
      currency: string;
      portfolio_value: string;
      buying_power: string;
      cash: string;
    };

    console.log(`  OK  Account ${acct.id}`);
    console.log(`      status:          ${acct.status}`);
    console.log(`      portfolio_value: ${acct.currency} ${acct.portfolio_value}`);
    console.log(`      buying_power:    ${acct.currency} ${acct.buying_power}`);
    console.log(`      cash:            ${acct.currency} ${acct.cash}`);

    if (acct.status !== "ACTIVE") {
      console.log(`\nAccount status is ${acct.status}, not ACTIVE — Alpaca will reject orders.`);
      process.exit(1);
    }

    if (ENABLED !== "true") {
      console.log(
        "\nLive API works, but ALPACA_LIVE_TRADING_ENABLED is not 'true' so the scheduler will not submit live orders.",
      );
      process.exit(2);
    }

    console.log("\nLive account is connected and trading is enabled.");
  } catch (err) {
    console.log(`  X  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
