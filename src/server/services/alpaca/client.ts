/**
 * Alpaca Paper Trading Client
 * Handles order placement, position management, and account queries
 * against the Alpaca Paper Trading API (https://paper-api.alpaca.markets).
 */

const BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets/v2";
const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets/v2";

function headers(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
    "Content-Type": "application/json",
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
  t: string;  // timestamp
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
}

export interface AlpacaSnapshot {
  latestTrade: { p: number; t: string };
  latestQuote: { bp: number; ap: number };
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

// ── API Helpers ────────────────────────────────────────────────────────

async function alpacaFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...headers(), ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Account ────────────────────────────────────────────────────────────

export async function getAccount(): Promise<AlpacaAccount> {
  return alpacaFetch<AlpacaAccount>(`${BASE_URL}/account`);
}

// ── Positions ──────────────────────────────────────────────────────────

export async function getPositions(): Promise<AlpacaPosition[]> {
  return alpacaFetch<AlpacaPosition[]>(`${BASE_URL}/positions`);
}

export async function getPosition(symbol: string): Promise<AlpacaPosition | null> {
  try {
    return await alpacaFetch<AlpacaPosition>(`${BASE_URL}/positions/${symbol}`);
  } catch {
    return null; // No position
  }
}

export async function closePosition(symbol: string): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(`${BASE_URL}/positions/${symbol}`, {
    method: "DELETE",
  });
}

export async function closeAllPositions(): Promise<AlpacaOrder[]> {
  return alpacaFetch<AlpacaOrder[]>(`${BASE_URL}/positions`, {
    method: "DELETE",
  });
}

// ── Orders ─────────────────────────────────────────────────────────────

export async function submitOrder(params: {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type?: "market" | "limit" | "stop" | "stop_limit";
  time_in_force?: "day" | "gtc" | "ioc" | "fok";
  limit_price?: number;
  stop_price?: number;
}): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(`${BASE_URL}/orders`, {
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
  });
}

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(`${BASE_URL}/orders/${orderId}`);
}

export async function getOrders(status?: "open" | "closed" | "all"): Promise<AlpacaOrder[]> {
  const qs = status ? `?status=${status}` : "";
  return alpacaFetch<AlpacaOrder[]>(`${BASE_URL}/orders${qs}`);
}

export async function cancelAllOrders(): Promise<void> {
  await alpacaFetch<unknown>(`${BASE_URL}/orders`, { method: "DELETE" });
}

// ── Market Data ────────────────────────────────────────────────────────

export async function getLatestPrice(symbol: string): Promise<number> {
  const data = await alpacaFetch<{ trade: { p: number } }>(
    `${DATA_URL}/stocks/${symbol}/trades/latest`,
  );
  return data.trade.p;
}

export async function getSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  const qs = symbols.map((s) => `symbols=${s}`).join("&");
  return alpacaFetch<Record<string, AlpacaSnapshot>>(
    `${DATA_URL}/stocks/snapshots?${qs}`,
  );
}

// ── Utility ────────────────────────────────────────────────────────────

export function isAvailable(): boolean {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}
