/**
 * The wire call: `@polymarket/clob-client` adapted to
 * `ClobSigningClient`.
 *
 * `venues/polymarket.ts` explains why the signing client is injected
 * rather than imported there, and says the concrete wiring "belongs
 * with the live capability gate". This is that wiring. The division of
 * labour is unchanged: everything with logic in it — races,
 * idempotency, reconciliation, buying power — stays in the coordinator
 * and the simulator, where it is tested. This file only translates.
 *
 * ## The venue's client is loaded lazily, on purpose
 *
 * `@polymarket/clob-client` pulls in viem and an HTTP stack. A static
 * import would put that graph into every module that transitively
 * imports the executor's index — including the Next.js build, which must
 * never contain signing code (AGENTS.md: `apps/web` never holds a
 * private key). The dynamic import in `createClobSigningClient` means
 * the signing graph is only resolved by a process that has actually
 * asked to connect.
 *
 * ## What this file does NOT do
 *
 * - **It does not re-check the live gate.** `PolymarketClobVenue`'s
 *   constructor is the gate (`config.ts`), and `preflight.ts`
 *   deliberately uses this client *without* the gate so an operator can
 *   verify their credentials before arming live trading. Read-only
 *   access to your own balance is not an order.
 * - **It does not translate errors.** Every throw propagates to
 *   `PolymarketClobVenue.submitIntent`, which maps it to `unknown` and
 *   forces reconciliation. That is coarse — some of these throws happen
 *   before any request is built and therefore *cannot* have reached the
 *   venue — but narrowing the `unknown` set is a change to a
 *   safety-critical mapping that CLAUDE.md earned the hard way, and it
 *   needs its own ADR rather than a quiet refinement here. A
 *   reconciliation pass over an order that was never sent is wasted
 *   work; the reverse is a duplicate position.
 *
 * ## Two things the CLOB REST API does not provide
 *
 * - **Positions.** The CLOB knows orders and trades, not inventory.
 *   Holdings come from the Data API `/positions` surface, keyed by the
 *   *funder* address, which is the wallet that actually holds the
 *   tokens. The Python ingestor reads the same endpoint
 *   (`python/nbe_theta/ingest/positions.py`), so the field names here
 *   match what was observed there rather than what seems likely.
 * - **A user event stream.** The authenticated WebSocket user channel is
 *   a separate endpoint this REST client does not wrap.
 *   `subscribeUser` therefore throws instead of returning an inert
 *   subscription: a subscription that silently delivers nothing would
 *   look like a quiet market, and the coordinator would believe it had
 *   level-1 truth (AGENTS.md's hierarchy) while actually having none.
 *   The coordinator does not call it — it reconciles over REST, which is
 *   level 2 — so this costs latency, not correctness.
 */

import type {
  CancelFilter,
  FillPage,
  TimeInForce,
  VenueFill,
  VenueOrder,
  VenuePosition,
} from "@nbe-theta/execution-domain";
import {
  type ResolvedCredentials,
  isProxiedScheme,
  normalizeHex,
  POLYGON_CHAIN_ID,
} from "./credentials.js";
import type { ClobSigningClient } from "./polymarket.js";

/**
 * Raised when a request could not be *constructed*. Distinct from a
 * venue rejection so a reader of a log can tell "we refused to send
 * this" from "the venue refused it".
 */
export class OrderNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderNotSentError";
  }
}

export class UnsupportedByVenueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedByVenueError";
  }
}

/**
 * Decimal places the venue accepts.
 *
 * Price is bounded by the coarsest tick the CLOB quotes (0.0001). Size
 * is bounded by the conditional token's 6 decimals. These are *upper*
 * bounds used to reject nonsense before signing — the per-market tick
 * size is stricter and is enforced by the venue client, which fetches
 * it per token (see `createOrder` below).
 */
const PRICE_SCALE = 4;
const SIZE_SCALE = 6;

/**
 * The venue's "no more pages" cursor, base64 of `-1`.
 *
 * `@polymarket/clob-client` defines this as `END_CURSOR` in its
 * `constants` module but does not re-export it from the package index,
 * and reaching into `dist/` would couple us to its build layout. It is
 * restated here because the alternative — not checking for it — makes a
 * paginating caller request the final page forever.
 */
const END_CURSOR = "LTE=";

/**
 * Converts a decimal string to the `number` the venue's `UserOrder`
 * wants, refusing anything that would not survive the trip.
 *
 * The domain carries prices and quantities as strings precisely so that
 * no rounding happens in transit (`packages/execution-domain/types.ts`).
 * The venue client's interface takes `number`, so the conversion is
 * unavoidable — but it can be made total: parse to a scaled integer,
 * divide, then confirm the double multiplies back to the same integer.
 * Anything that fails that is rejected rather than silently rounded,
 * because a size that rounds up is an order for shares nobody asked for
 * and a price that rounds down is a worse fill than the signal
 * authorised.
 */
export function toVenueNumber(label: string, raw: string, maxScale: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) {
    throw new OrderNotSentError(
      `${label}=${raw} is not a non-negative decimal; refusing to sign an order from it`,
    );
  }
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  if (frac.length > maxScale) {
    throw new OrderNotSentError(
      `${label}=${raw} carries ${frac.length} decimal places; the venue accepts at most ${maxScale}. ` +
        "Rounding here would change the order, so it is refused instead.",
    );
  }
  const factor = 10 ** maxScale;
  const scaled = BigInt(whole + frac.padEnd(maxScale, "0"));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OrderNotSentError(`${label}=${raw} exceeds the exactly-representable range`);
  }
  const value = Number(scaled) / factor;
  if (BigInt(Math.round(value * factor)) !== scaled) {
    // Unreachable for scales this small; kept because the day it is
    // reachable, silently proceeding would sign the wrong number.
    throw new OrderNotSentError(`${label}=${raw} does not round-trip as a double`);
  }
  return value;
}

/** Shape of a Data API `/positions` row. Only the fields we use. */
interface DataApiPositionRow {
  conditionId?: unknown;
  asset?: unknown;
  size?: unknown;
  avgPrice?: unknown;
}

/**
 * Narrows the venue's API-credential response.
 *
 * Exported so the shape check is testable without a venue: this guard
 * is the difference between a diagnosable connection failure and a
 * `TypeError` thrown four calls later.
 */
export function isApiCredentials(
  v: unknown,
): v is { key: string; secret: string; passphrase: string } {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.key === "string" &&
    c.key !== "" &&
    typeof c.secret === "string" &&
    c.secret !== "" &&
    typeof c.passphrase === "string" &&
    c.passphrase !== ""
  );
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export interface ClobSigningClientHandle {
  client: ClobSigningClient;
  /** The EOA that signs. Derived from the key, never from config. */
  signerAddress: string;
  /**
   * The wallet holding collateral and positions, and the `account_id`
   * every durable row is keyed by. For a proxied scheme this is the
   * configured funder; for `eoa` it is the signer.
   */
  accountId: string;
  /** Whether L2 credentials were derived rather than supplied. */
  apiCredentialsDerived: boolean;
  /**
   * Collateral balance **and** the exchange's allowance over it.
   *
   * `ClobSigningClient.balance()` deliberately exposes only the
   * spendable figure, because that is all the coordinator's buying-power
   * check should reason about. The allowance is an onboarding concern:
   * an account can hold USDC and still be unable to trade because the
   * exchange contracts were never approved to move it, and that failure
   * presents as orders rejected for insufficient balance. Preflight
   * needs to tell those apart, so it reads both from here rather than
   * widening the venue interface.
   */
  collateral(): Promise<{ balance: string; allowance: string }>;
}

/**
 * Builds a signing client for the configured account.
 *
 * Performs the L1 → L2 handshake when API credentials were not
 * supplied: the signer proves control of the address with an EIP-712
 * signature, and the venue returns HMAC credentials for subsequent
 * calls. `createOrDeriveApiKey` is idempotent — an account that already
 * has credentials gets the same ones back, so this is safe to run on
 * every boot.
 */
export async function createClobSigningClient(
  credentials: ResolvedCredentials,
): Promise<ClobSigningClientHandle> {
  const [{ ClobClient, AssetType, OrderType, Side }, viem, viemAccounts] =
    await Promise.all([
      import("@polymarket/clob-client"),
      import("viem"),
      import("viem/accounts"),
    ]);

  const account = viemAccounts.privateKeyToAccount(
    credentials.privateKey.reveal() as `0x${string}`,
  );
  const signerAddress = normalizeHex(account.address);

  // The wallet client is a signer only: no transport RPC calls are made
  // by the order path, which signs locally and POSTs to the CLOB. A
  // chain object is still required to pin the EIP-712 domain, and that
  // must match the chain the credentials were issued for.
  const chain =
    credentials.chainId === POLYGON_CHAIN_ID
      ? (await import("viem/chains")).polygon
      : (await import("viem/chains")).polygonAmoy;

  const walletClient = viem.createWalletClient({
    account,
    chain,
    transport: viem.http(),
  });

  const accountId = credentials.funderAddress ?? signerAddress;

  // For a proxied scheme the funder must differ from the signer. Equal
  // addresses mean the operator pasted the EOA where the proxy belongs,
  // which signs valid orders against an account that holds nothing.
  if (isProxiedScheme(credentials.signatureType) && accountId === signerAddress) {
    throw new OrderNotSentError(
      `signature type '${credentials.signatureType}' expects collateral at a proxy, but ` +
        "POLYMARKET_FUNDER_ADDRESS equals the signer's own address. " +
        "Use the deposit address from your Polymarket account page.",
    );
  }

  const supplied = credentials.apiCredentials;

  /**
   * The venue client's constructor is positional and thirteen arguments
   * long. Wrapping it keeps the two call sites below readable and — the
   * actual reason — makes `throwOnError` impossible to forget.
   *
   * `throwOnError` defaults to FALSE in the client, which means a
   * venue-reported error is *returned as data* rather than thrown. For
   * the order path that is unacceptable: a `postOrder` that returns an
   * error object would read as a successful submit.
   */
  const buildClient = (creds?: { key: string; secret: string; passphrase: string }) =>
    new ClobClient(
      credentials.clobBaseUrl,
      credentials.chainId,
      walletClient,
      creds,
      credentials.signatureTypeValue,
      credentials.funderAddress ?? undefined,
      undefined, // geoBlockToken
      undefined, // useServerTime
      undefined, // builderConfig
      undefined, // getSigner
      undefined, // retryOnError
      undefined, // tickSizeTtlMs
      true, // throwOnError — see above
    );

  let clob = buildClient(
    supplied
      ? {
          key: supplied.key,
          secret: supplied.secret.reveal(),
          passphrase: supplied.passphrase.reveal(),
        }
      : undefined,
  );

  if (!supplied) {
    const derived: unknown = await clob.createOrDeriveApiKey();

    // `throwOnError` only covers a response the venue shaped as an
    // error object. A transport failure — DNS, a blocked egress, a
    // geo-block answering with a redirect — resolves this call with
    // `undefined` instead, and the client then stores those absent
    // credentials happily. The failure surfaces several calls later as
    // `Cannot read properties of undefined (reading 'replace')` from
    // inside HMAC header construction, which says nothing about the
    // actual cause. So the shape is checked here, where the cause is
    // still known.
    if (!isApiCredentials(derived)) {
      throw new Error(
        `the venue did not return usable API credentials from ${credentials.clobBaseUrl}. ` +
          "The L1 handshake reached no endpoint that answered with a key/secret/passphrase — " +
          "check that the host is reachable from this network and is not geo-blocked. " +
          "Supply POLYMARKET_API_KEY/_SECRET/_PASSPHRASE explicitly to skip this step.",
      );
    }
    clob = buildClient(derived);
  }

  const tifToOrderType: Record<TimeInForce, (typeof OrderType)[keyof typeof OrderType]> = {
    GTC: OrderType.GTC,
    GTD: OrderType.GTD,
    FOK: OrderType.FOK,
    FAK: OrderType.FAK,
  };

  const client: ClobSigningClient = {
    async postOrder(args) {
      const price = toVenueNumber("price", args.price, PRICE_SCALE);
      const size = toVenueNumber("size", args.size, SIZE_SCALE);
      const orderType = tifToOrderType[args.timeInForce as TimeInForce];
      if (orderType === undefined) {
        throw new OrderNotSentError(`unsupported time in force '${args.timeInForce}'`);
      }

      // A GTD without an expiry is not a GTD. Defaulting one would
      // invent a lifetime the signal never authorised, so it is refused.
      let expiration: number | undefined;
      if (orderType === OrderType.GTD) {
        if (!args.expiresAt) {
          throw new OrderNotSentError("GTD order has no expiresAt; refusing to invent one");
        }
        const at = Date.parse(args.expiresAt);
        if (Number.isNaN(at)) {
          throw new OrderNotSentError(`expiresAt=${args.expiresAt} is not a parseable timestamp`);
        }
        expiration = Math.floor(at / 1000);
      }

      // `createOrder` resolves the per-token tick size and whether the
      // market is neg-risk, then signs against the matching exchange
      // contract. Those are NOT cosmetic: a neg-risk market settles
      // through a different contract, and signing against the wrong one
      // produces a signature the exchange cannot verify. Letting the
      // venue client resolve them is the whole reason ADR-0002 chose a
      // supported client over hand-rolled EIP-712.
      const signed = await clob.createOrder({
        tokenID: args.tokenId,
        price,
        size,
        side: args.side === "BUY" ? Side.BUY : Side.SELL,
        ...(expiration === undefined ? {} : { expiration }),
      });

      const res = (await clob.postOrder(signed, orderType)) as {
        orderID?: string;
        orderId?: string;
        status?: string;
        success?: boolean;
        errorMsg?: string;
        makingAmount?: string;
        takingAmount?: string;
      };

      // `success: false` with a 200 is a real response shape here. It is
      // a definite rejection, but reporting it as such is the adapter's
      // decision to make, and the adapter maps every throw to `unknown`.
      // Throwing with the venue's own message keeps the reason visible
      // in the reconciliation record.
      if (res.success === false) {
        throw new Error(`venue rejected order: ${res.errorMsg ?? "no reason given"}`);
      }

      const orderId = res.orderID ?? res.orderId;
      if (!orderId) {
        throw new Error(
          `venue accepted order but returned no order id (status=${res.status ?? "none"})`,
        );
      }
      return {
        orderId,
        status: res.status ?? "unknown",
        // Fill detail is not reliably present on the submit response;
        // the reconciliation pass reads it from trades, which is the
        // higher-authority source anyway.
        ...(res.makingAmount === undefined ? {} : { filledSize: res.makingAmount }),
      };
    },

    async cancelOrder(orderId) {
      await clob.cancelOrder({ orderID: orderId });
    },

    async cancelAll(filter?: CancelFilter) {
      // A scoped cancel must not fall back to cancelling everything: an
      // operator asking to clear one market would flatten the book.
      if (filter?.outcomeTokenId) {
        const res = (await clob.cancelMarketOrders({ asset_id: filter.outcomeTokenId })) as {
          canceled?: string[];
        };
        return { canceled: res.canceled ?? [] };
      }
      if (filter?.conditionId) {
        const res = (await clob.cancelMarketOrders({ market: filter.conditionId })) as {
          canceled?: string[];
        };
        return { canceled: res.canceled ?? [] };
      }
      const res = (await clob.cancelAll()) as { canceled?: string[] };
      return { canceled: res.canceled ?? [] };
    },

    async openOrders(): Promise<VenueOrder[]> {
      const rows = await clob.getOpenOrders();
      return rows.map((o) => ({
        venueOrderId: o.id,
        // The venue echoes our client order id in no field of this
        // response, so reconciliation matches on venueOrderId. Reporting
        // a fabricated clientIntentId would be worse than an empty one.
        clientIntentId: "",
        instrument: {
          venue: "polymarket",
          conditionId: o.market,
          outcomeTokenId: o.asset_id,
        },
        side: o.side === "SELL" ? "SELL" : "BUY",
        quantity: o.original_size,
        limitPrice: o.price,
        timeInForce: normalizeTif(o.order_type),
        status: normalizeOrderStatus(o.status),
        filledQuantity: o.size_matched,
      }));
    },

    async positions(): Promise<VenuePosition[]> {
      const url = new URL(`${credentials.dataApiBaseUrl}/positions`);
      url.searchParams.set("user", accountId);
      url.searchParams.set("limit", "500");
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`data-api /positions returned ${res.status}`);
      }
      const body: unknown = await res.json();
      const rows: DataApiPositionRow[] = Array.isArray(body) ? body : [];
      const out: VenuePosition[] = [];
      for (const row of rows) {
        const conditionId = asString(row.conditionId);
        const tokenId = asString(row.asset);
        const size = asString(row.size);
        if (!conditionId || !tokenId || size === null) continue;
        out.push({
          instrument: { venue: "polymarket", conditionId, outcomeTokenId: tokenId },
          quantity: size,
          avgPrice: asString(row.avgPrice),
        });
      }
      return out;
    },

    async fills(cursor?: string): Promise<FillPage> {
      const page = await clob.getTradesPaginated(undefined, cursor);
      const fills: VenueFill[] = page.trades.map((t) => ({
        venueOrderId: t.taker_order_id,
        instrument: {
          venue: "polymarket",
          conditionId: t.market,
          outcomeTokenId: t.asset_id,
        },
        side: t.side === "SELL" ? "SELL" : "BUY",
        quantity: t.size,
        price: t.price,
        // `fee_rate_bps` is a rate, not an amount, and the venue does
        // not return the charged fee on this surface. Deriving one would
        // put a guess into the lot book that every P&L number then
        // trusts, so it is reported as zero and the real figure comes
        // from settlement.
        fee: "0",
        occurredAt: toIso(t.match_time),
      }));
      return {
        fills,
        // END_CURSOR is the venue's "no more pages" sentinel. Returning
        // it verbatim would make the caller request the last page again
        // forever.
        cursor: page.next_cursor && page.next_cursor !== END_CURSOR ? page.next_cursor : null,
      };
    },

    async book(tokenId) {
      const summary = await clob.getOrderBook(tokenId);
      return {
        bids: (summary.bids ?? []).map((l) => ({ price: l.price, size: l.size })),
        asks: (summary.asks ?? []).map((l) => ({ price: l.price, size: l.size })),
      };
    },

    async balance() {
      const res = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      // The CLOB reports free collateral; cash committed to resting
      // orders is not broken out on this surface. Reporting a guessed
      // reservation would feed the coordinator's buying-power check a
      // number nobody measured, so reserved is zero and the
      // coordinator's own open-order accounting is the authority.
      return { available: res.balance, reserved: "0" };
    },

    subscribeUser() {
      return Promise.reject(
        new UnsupportedByVenueError(
          "the authenticated CLOB user stream is not wired; reconcile over REST instead " +
            "(see the module docstring in venues/clob-client.ts)",
        ),
      );
    },
  };

  return {
    client,
    signerAddress,
    accountId,
    apiCredentialsDerived: supplied === null,
    async collateral() {
      const res = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      return { balance: res.balance, allowance: res.allowance };
    },
  };
}

function normalizeTif(raw: string): TimeInForce {
  const t = raw.trim().toUpperCase();
  return t === "GTD" || t === "FOK" || t === "FAK" ? t : "GTC";
}

function normalizeOrderStatus(raw: string): VenueOrder["status"] {
  switch (raw.trim().toLowerCase()) {
    case "live":
    case "open":
      return "live";
    case "matched":
    case "filled":
      return "filled";
    case "partial":
    case "partially_filled":
      return "partially_filled";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    default:
      // Same reasoning as `mapStatus` in polymarket.ts: an
      // unrecognised status is not a success.
      return "unknown";
  }
}

/**
 * The venue reports `match_time` as unix seconds in a string on this
 * surface. Anything else is passed to `Date` and, if that fails, the
 * timestamp is reported as the epoch rather than `Invalid Date` — a
 * fill with a bad timestamp is still a fill, and dropping it would
 * understate exposure.
 */
function toIso(raw: string): string {
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return new Date(asSeconds * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return new Date(Number.isNaN(parsed) ? 0 : parsed).toISOString();
}
