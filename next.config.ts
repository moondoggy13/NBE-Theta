import type { NextConfig } from "next";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Next.js loads .env.local / .env automatically. We also support .env.live so
// live-account credentials can live in a separate file; it takes precedence
// because live keys should override any defaults from other files.
const liveEnvPath = resolve(process.cwd(), ".env.live");
if (existsSync(liveEnvPath)) {
  loadDotenv({ path: liveEnvPath, override: true });
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
