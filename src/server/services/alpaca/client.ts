/**
 * Alpaca Trading Client — supports both paper and live accounts.
 *
 * Env vars (paper):
 *   ALPACA_PAPER_API_KEY, ALPACA_PAPER_SECRET_KEY
 *   ALPACA_PAPER_BASE_URL  (default https://paper-api.alpaca.markets/v2)
 *   Falls back to ALPACA_API_KEY / ALPACA_SECRET_KEY / ALPACA_BASE_URL
 *
 * Env vars (live):
 *   ALPACA_LIVE_API_KEY, ALPACA_LIVE_SECRET_KEY
 *   ALPACA_LIVE_BASE_URL   (default https://api.alpaca.markets/v2)
 *   ALPACA_LIVE_TRADING_ENABLED=true required to actually submit live orders.
 *   Connection check still pings live regardless of this flag.
 *
 * Market data (shared):
 *   ALPACA_DATA_URL        (default https://data.alpaca.markets/v2)
 */

export type AlpacaMode = "paper" | "live";

const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets/v2";

interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

function configFor(mode: AlpacaMode): ClientConfig {
  if (mode === "live") {
    return {
      baseUrl: process.env.ALPACA_LIVE_BASE_URL || "https://api.alpaca.markets/v2",
      apiKey: process.env.ALPACA_LIVE_API_KEY || "",
      secretKey: process.env.ALPACA_LIVE_SECRET_KEY || "",
    };
  }
  return {
    baseUrl:
      process.env.ALPACA_PAPER_BASE_URL ||
      process.env.ALPACA_BASE_URL ||
      "https://paper-api.alpaca.markets/v2",
    apiKey: process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_API_KEY || "",
    secretKey: process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET_KEY || "",
  };
}

// ── Types ──────────────────────────────────────────────────────────────

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  side: "buy" | "sell";
  type: string;
  time_in_force: string;
  status: string;
  submitted_at: string;
  filled_at: string | null;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaSnapshot {
  latestTrade: { p: number; t: string };
  latestQuote: { bp: number; ap: number };
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

export interface SubmitOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type?: "market" | "limit" | "stop" | "stop_limit";
  time_in_force?: "day" | "gtc" | "ioc" | "fok";
  limit_price?: number;
  stop_price?: number;
}

// ── Client factory ─────────────────────────────────────────────────────

export interface AlpacaClient {
  mode: AlpacaMode;
  available: boolean;
  getAccount: () => Promise<AlpacaAccount>;
  getPositions: () => Promise<AlpacaPosition[]>;
  getPosition: (symbol: string) => Promise<AlpacaPosition | null>;
  closePosition: (symbol: string) => Promise<AlpacaOrder>;
  closeAllPositions: () => Promise<AlpacaOrder[]>;
  submitOrder: (params: SubmitOrderParams) => Promise<AlpacaOrder>;
  getOrder: (orderId: string) => Promise<AlpacaOrder>;
  getOrders: (status?: "open" | "closed" | "all") => Promise<AlpacaOrder[]>;
  cancelAllOrders: () => Promise<void>;
}

export function createAlpacaClient(mode: AlpacaMode): AlpacaClient {
  const cfg = configFor(mode);
  const available = !!(cfg.apiKey && cfg.secretKey);

  const headers = (): Record<string, string> => ({
    "APCA-API-KEY-ID": cfg.apiKey,
    "APCA-API-SECRET-KEY": cfg.secretKey,
    "Content-Type": "application/json",
  });

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { ...headers(), ...init?.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Alpaca ${mode} ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    mode,
    available,
    getAccount: () => call<AlpacaAccount>(`/account`),
    getPositions: () => call<AlpacaPosition[]>(`/positions`),
    async getPosition(symbol) {
      try {
        return await call<AlpacaPosition>(`/positions/${symbol}`);
      } catch {
        return null;
      }
    },
    closePosition: (symbol) => call<AlpacaOrder>(`/positions/${symbol}`, { method: "DELETE" }),
    closeAllPositions: () => call<AlpacaOrder[]>(`/positions`, { method: "DELETE" }),
    submitOrder: (params) =>
      call<AlpacaOrder>(`/orders`, {
        method: "POST",
        body: JSON.stringify({
          symbol: params.symbol,
          qty: String(params.qty),
          side: params.side,
          type: params.type || "market",
          time_in_force: params.time_in_force || "day",
          ...(params.limit_price != null && { limit_price: String(params.limit_price) }),
          ...(params.stop_price != null && { stop_price: String(params.stop_price) }),
        }),
      }),
    getOrder: (orderId) => call<AlpacaOrder>(`/orders/${orderId}`),
    getOrders: (status) =>
      call<AlpacaOrder[]>(`/orders${status ? `?status=${status}` : ""}`),
    cancelAllOrders: async () => {
      await call<unknown>(`/orders`, { method: "DELETE" });
    },
  };
}

// ── Pre-built clients ──────────────────────────────────────────────────

export const paperClient = createAlpacaClient("paper");
export const liveClient = createAlpacaClient("live");

export function paperAvailable(): boolean {
  return paperClient.available;
}

export function liveAvailable(): boolean {
  return liveClient.available;
}

/** True when env explicitly opts into submitting orders to the live account. */
export function liveTradingEnabled(): boolean {
  return liveClient.available && process.env.ALPACA_LIVE_TRADING_ENABLED === "true";
}

/** Returns clients that should receive trade orders this run. */
export function executionClients(): AlpacaClient[] {
  const out: AlpacaClient[] = [];
  if (paperClient.available) out.push(paperClient);
  if (liveTradingEnabled()) out.push(liveClient);
  return out;
}

/** Back-compat: true if at least the paper account is wired up. */
export function isAvailable(): boolean {
  return paperAvailable();
}

// ── Market data (shared across modes) ──────────────────────────────────

function dataHeaders(): Record<string, string> {
  // Market data uses whichever credential set is available; paper keys work for IEX feed.
  const cfg = paperClient.available ? configFor("paper") : configFor("live");
  return {
    "APCA-API-KEY-ID": cfg.apiKey,
    "APCA-API-SECRET-KEY": cfg.secretKey,
  };
}

async function dataFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_URL}${path}`, {
    headers: dataHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca data ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function getLatestPrice(symbol: string): Promise<number> {
  const data = await dataFetch<{ trade: { p: number } }>(
    `/stocks/${symbol}/trades/latest`,
  );
  return data.trade.p;
}

export async function getSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  const qs = symbols.map((s) => `symbols=${s}`).join("&");
  return dataFetch<Record<string, AlpacaSnapshot>>(`/stocks/snapshots?${qs}`);
}

// ── Back-compat wrappers (delegate to paper) ───────────────────────────
// Existing scheduler stages import these by name. New code should prefer
// `paperClient` / `liveClient` / `executionClients()` directly.

export const getAccount = () => paperClient.getAccount();
export const getPositions = () => paperClient.getPositions();
export const getPosition = (symbol: string) => paperClient.getPosition(symbol);
export const closePosition = (symbol: string) => paperClient.closePosition(symbol);
export const closeAllPositions = () => paperClient.closeAllPositions();
export const submitOrder = (params: SubmitOrderParams) => paperClient.submitOrder(params);
export const getOrder = (orderId: string) => paperClient.getOrder(orderId);
export const getOrders = (status?: "open" | "closed" | "all") => paperClient.getOrders(status);
export const cancelAllOrders = () => paperClient.cancelAllOrders();
