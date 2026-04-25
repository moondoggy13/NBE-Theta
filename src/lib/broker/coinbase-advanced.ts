/**
 * Coinbase Advanced Trade (v3) broker client.
 *
 * Auth: JWT signed per-request with a CDP API key. The client accepts
 * two private-key formats and auto-detects:
 *   - PEM-encoded EC (ES256) — classic CDP ECDSA key
 *   - Base64-encoded 64-byte Ed25519 secret — newer CDP Ed25519 key
 *
 * This client is ONLY constructible when the two-flag live gate passes
 * (COINBASE_LIVE=true AND CONFIRM_LIVE=YES) AND the runtime mode is
 * `live`. Any attempt to instantiate without both flags throws — defense
 * in depth against accidental live order placement.
 */
import { createPrivateKey, randomBytes } from "node:crypto";
import { SignJWT, type KeyLike } from "jose";
import type {
  Account,
  BrokerClient,
  Fill,
  Order,
  OrderRequest,
  OrderStatus,
  PositionView,
} from "./types";

const BASE = "https://api.coinbase.com";
const REQUEST_HOST = "api.coinbase.com";

export interface CoinbaseAdvancedOptions {
  apiKeyName: string;
  apiPrivateKey: string;
  symbol: string;
  /** External flag confirming both live gates are set. Enforced in constructor. */
  liveEnabled: boolean;
}

type KeyKind = "es256" | "ed25519";

export class CoinbaseAdvancedClient implements BrokerClient {
  readonly mode = "live" as const;
  readonly name = "coinbase-advanced";
  private fillHandler?: (fill: Fill, order: Order) => void;
  private readonly symbol: string;
  private keyPromise?: Promise<{ key: KeyLike; kind: KeyKind }>;

  constructor(private readonly opts: CoinbaseAdvancedOptions) {
    if (!opts.liveEnabled) {
      throw new Error("Refusing to construct live Coinbase client: gates not set");
    }
    if (!opts.apiKeyName || !opts.apiPrivateKey) {
      throw new Error("Coinbase API credentials missing");
    }
    this.symbol = opts.symbol;
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    const clientOrderId = req.clientOrderId ?? randomBytes(12).toString("hex");
    const body = buildOrderPayload(req, clientOrderId);
    const path = "/api/v3/brokerage/orders";

    const res = await this.request<{
      success: boolean;
      order_id?: string;
      failure_reason?: string;
      error_response?: { message: string };
    }>("POST", path, body);

    if (!res.success || !res.order_id) {
      const msg = res.failure_reason ?? res.error_response?.message ?? "order rejected";
      throw new Error(`Coinbase order rejected: ${msg}`);
    }
    const status = "submitted" as OrderStatus;
    const order: Order = {
      id: clientOrderId,
      brokerOrderId: res.order_id,
      mode: "live",
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      price: req.price,
      status,
      submittedAt: Date.now(),
      filledQty: 0,
      fees: 0,
      strategyId: req.strategyId,
      metadata: req.metadata,
    };
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("POST", "/api/v3/brokerage/orders/batch_cancel", {
      order_ids: [orderId],
    });
  }

  async getAccount(): Promise<Account> {
    const res = await this.request<{ accounts: CoinbaseAccount[] }>(
      "GET",
      "/api/v3/brokerage/accounts?limit=50",
    );
    let equity = 0;
    let buying = 0;
    for (const a of res.accounts) {
      const val = Number(a.available_balance?.value ?? 0);
      if (a.currency === "USD" || a.currency === "USDC") buying += val;
      equity += val;
    }
    return { equity, buyingPower: buying, currency: "USD" };
  }

  async getPositions(): Promise<PositionView[]> {
    const res = await this.request<{ accounts: CoinbaseAccount[] }>(
      "GET",
      "/api/v3/brokerage/accounts?limit=50",
    );
    const base = this.symbol.split("-")[0];
    const acct = res.accounts.find((a) => a.currency === base);
    if (!acct) return [];
    const qty = Number(acct.available_balance?.value ?? 0);
    if (qty === 0) return [];
    return [
      {
        symbol: this.symbol,
        qty,
        avgEntry: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
      },
    ];
  }

  onFill(handler: (fill: Fill, order: Order) => void): void {
    this.fillHandler = handler;
  }

  /** Verify auth works by calling the accounts endpoint. Throws on failure. */
  async verifyAuth(): Promise<void> {
    await this.request("GET", "/api/v3/brokerage/accounts?limit=1");
  }

  // ─── private ────────────────────────────────────────────────────────────

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await this.signJwt(method, path);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "nbe-theta/0.1",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coinbase ${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async loadKey(): Promise<{ key: KeyLike; kind: KeyKind }> {
    if (!this.keyPromise) {
      const raw = this.opts.apiPrivateKey.trim();
      if (raw.includes("BEGIN")) {
        // PEM — accept both PKCS#8 (`BEGIN PRIVATE KEY`) and SEC1
        // (`BEGIN EC PRIVATE KEY`); Node's createPrivateKey handles both.
        const pem = raw.replace(/\\n/g, "\n");
        const key = createPrivateKey({ key: pem, format: "pem" }) as unknown as KeyLike;
        this.keyPromise = Promise.resolve({ key, kind: "es256" as const });
      } else {
        // Base64 Ed25519 — 64 bytes (32 seed + 32 public) is the common CDP export shape.
        const bytes = Buffer.from(raw, "base64");
        if (bytes.length !== 64 && bytes.length !== 32) {
          throw new Error(
            `Unexpected Coinbase private-key length ${bytes.length}. ` +
              "Expected PEM (ECDSA) or 32/64-byte base64 (Ed25519).",
          );
        }
        const seed = bytes.length === 32 ? bytes : bytes.subarray(0, 32);
        // Wrap the 32-byte seed in a minimal PKCS8 DER for Ed25519.
        const pkcs8 = Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          seed,
        ]);
        const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }) as unknown as KeyLike;
        this.keyPromise = Promise.resolve({ key, kind: "ed25519" as const });
      }
    }
    return this.keyPromise;
  }

  private async signJwt(method: string, pathWithQuery: string): Promise<string> {
    const path = pathWithQuery.split("?")[0];
    const uri = `${method} ${REQUEST_HOST}${path}`;
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("hex");
    const { key, kind } = await this.loadKey();
    const alg = kind === "es256" ? "ES256" : "EdDSA";
    // Coinbase Advanced Trade expects these exact claims (no `aud`):
    //   header: { alg, kid, nonce, typ }
    //   payload: { sub, iss: "cdp", nbf, exp, uri }
    return new SignJWT({ uri })
      .setProtectedHeader({ alg, kid: this.opts.apiKeyName, nonce, typ: "JWT" })
      .setSubject(this.opts.apiKeyName)
      .setIssuer("cdp")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(key);
  }
}

interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance?: { value: string; currency: string };
  hold?: { value: string; currency: string };
}

function buildOrderPayload(req: OrderRequest, clientOrderId: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    client_order_id: clientOrderId,
    product_id: req.symbol,
    side: req.side.toUpperCase(),
  };
  if (req.type === "market") {
    base.order_configuration = {
      market_market_ioc: req.side === "buy"
        ? { quote_size: String(req.qty * (req.price ?? 1)) }
        : { base_size: String(req.qty) },
    };
  } else if (req.type === "limit") {
    if (!req.price) throw new Error("limit order requires price");
    base.order_configuration = {
      limit_limit_gtc: {
        base_size: String(req.qty),
        limit_price: String(req.price),
        post_only: false,
      },
    };
  } else if (req.type === "stop" || req.type === "stop_limit") {
    if (!req.stopPrice) throw new Error("stop/stop_limit order requires stopPrice");
    base.order_configuration = {
      stop_limit_stop_limit_gtc: {
        base_size: String(req.qty),
        limit_price: String(req.price ?? req.stopPrice),
        stop_price: String(req.stopPrice),
        stop_direction: req.side === "buy" ? "STOP_DIRECTION_STOP_UP" : "STOP_DIRECTION_STOP_DOWN",
      },
    };
  }
  return base;
}
