#!/usr/bin/env tsx
/**
 * Download historical candles from Coinbase public REST into an
 * NDJSON file (one Candle per line).
 *
 *   pnpm fetch-history -- --symbol BTC-USD --interval 1m \
 *     --from 2024-01-01 --to 2024-12-31 --out data/btc-1m-2024.ndjson
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchCandles } from "../src/lib/feed/coinbase-public";
import type { Interval } from "../src/lib/feed/types";

async function main() {
  const { values } = parseArgs({
    options: {
      symbol:   { type: "string", default: "BTC-USD" },
      interval: { type: "string", default: "1m" },
      from:     { type: "string" },
      to:       { type: "string" },
      out:      { type: "string" },
    },
  });

  if (!values.from || !values.to) {
    console.error("Missing --from or --to (YYYY-MM-DD).");
    process.exit(1);
  }

  const interval = values.interval as Interval;
  const fromSec = Math.floor(new Date(values.from).getTime() / 1000);
  const toSec = Math.floor(new Date(values.to).getTime() / 1000);
  const out = values.out ?? path.join("data", `${values.symbol?.toLowerCase()}-${interval}-${values.from}-${values.to}.ndjson`);

  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`Fetching ${values.symbol} ${interval} from ${values.from} to ${values.to}`);
  const start = Date.now();
  const candles = await fetchCandles(values.symbol!, interval, fromSec, toSec);
  console.log(`Fetched ${candles.length} candles in ${Math.round((Date.now() - start) / 1000)}s`);

  const stream = fs.createWriteStream(out, { encoding: "utf8" });
  for (const c of candles) stream.write(JSON.stringify(c) + "\n");
  await new Promise<void>((resolve, reject) => {
    stream.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
