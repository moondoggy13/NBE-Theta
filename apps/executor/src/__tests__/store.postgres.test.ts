import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseIntentPayload } from "../boundary.js";
import { ExecutionStore } from "../store.js";
import type { VenueFillRow } from "../store.js";

/**
 * Venue truth, against a real database.
 *
 * `venue_orders`, `venue_order_events` and `venue_fills` have existed
 * since migration 010 and were written by nothing and read by nothing
 * until PR 16. An order could be placed and filled and the database
 * would show no trace of it.
 *
 * The property worth the most here is **idempotent fill accounting**. A
 * redelivered fill — a reconnecting user stream replaying, a REST
 * reconciliation overlapping the socket — must not move the position.
 * `filled_quantity` is therefore a SUM over `venue_fills`, never an
 * increment; the increment version double-counts, and a position that
 * reads larger than it is, is the v2 failure shape and is silent.
 *
 * As in PR 14, the SQL is **imported, never pasted** — a test with its
 * own copy passes while the executor's queries are broken.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

let db: Client;
let store: ExecutionStore;

const ACCOUNT = "0xaccount";
const COND = "store-cond";

function wirePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1",
    intent_id: crypto.randomUUID(),
    account_id: ACCOUNT,
    venue: "polymarket",
    instrument: { venue: "polymarket", condition_id: COND, outcome_token_id: "store-tok" },
    side: "BUY",
    quantity: "100",
    limit_price: "0.40",
    time_in_force: "FOK",
    strategy_type: "wallet_follow",
    signal_id: crypto.randomUUID(),
    expires_at: "2027-06-01T12:02:00Z",
    ...over,
  };
}

function envelope(over: Record<string, unknown> = {}) {
  return parseIntentPayload(wirePayload(over), {
    expectedAccountId: ACCOUNT,
    expectedVenue: "polymarket",
  });
}

function report(over: Record<string, unknown> = {}) {
  return {
    clientIntentId: crypto.randomUUID(),
    venueOrderId: `ord-${crypto.randomUUID()}`,
    status: "live",
    filledQuantity: "0",
    avgPrice: null,
    feesPaid: "0",
    observedAt: new Date().toISOString(),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fill(orderId: string, over: Partial<VenueFillRow> = {}): VenueFillRow {
  return {
    venueFillId: `f-${crypto.randomUUID()}`,
    venueOrderId: orderId,
    occurredAt: new Date().toISOString(),
    price: "0.40",
    quantity: "40",
    fee: "0.10",
    liquidity: "taker",
    ...over,
  };
}

async function orderRow(id: string) {
  const { rows } = await db.query(
    "select status, filled_quantity, fees_paid, account_id from venue_orders " +
      "where venue='polymarket' and venue_order_id=$1",
    [id],
  );
  return rows[0];
}

/**
 * Leave the tables as found — AFTER as well as before.
 *
 * Cleaning only on the way in is not enough: the last test's rows
 * survive the suite. `reconciliation_breaks` in particular is read by
 * the Python shadow gate's `zero_unresolved_incidents`, which is the one
 * criterion deliberately NOT scoped to a window — so a break left behind
 * here fails a gate test in another language against the same database.
 *
 * The break rows are matched on their `detail->>'condition_id'`, not on
 * a substring of the description: this suite must delete what it wrote
 * and nothing else.
 */
async function cleanup(): Promise<void> {
  await db.query("delete from venue_fills where venue_order_id like 'ord-%'");
  await db.query("delete from venue_order_events where venue_order_id like 'ord-%'");
  await db.query("delete from venue_orders where condition_id = $1", [COND]);
  await db.query("delete from reconciliation_breaks where detail->>'condition_id' = $1", [COND]);
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  store = new ExecutionStore(db);
});

afterAll(async () => {
  if (!db) return;
  if (DATABASE_URL) await cleanup();
  await db.end();
});

beforeEach(async () => {
  if (!DATABASE_URL) return;
  await cleanup();
});

describeDb("a submission is recorded as venue truth", () => {
  it("writes the order and an append-only submitted event", async () => {
    const env = envelope();
    const rep = report();
    const id = await store.recordSubmission(env, rep);
    expect(id).toBe(rep.venueOrderId);

    const row = await orderRow(rep.venueOrderId);
    expect(row.status).toBe("live");
    expect(row.account_id).toBe(ACCOUNT);

    const { rows: events } = await db.query(
      "select event_type from venue_order_events where venue_order_id=$1",
      [rep.venueOrderId],
    );
    expect(events.map((e) => e.event_type)).toEqual(["submitted"]);
  });

  it("refuses a status the durable contract does not describe", async () => {
    await expect(store.recordSubmission(envelope(), report({ status: "signed_maybe" }))).rejects.toThrow(
      /unsupported order status/,
    );
  });
});

describeDb("an ambiguous submit never becomes an order row", () => {
  it("opens a reconciliation break instead", async () => {
    // "We submitted and do not know what happened." Writing an order
    // row would assert an order exists, which is exactly what we cannot
    // assert. Migration 021 also makes 'unknown' unrepresentable in
    // venue_orders.status.
    const env = envelope();
    const id = await store.recordSubmission(env, report({ status: "unknown", venueOrderId: null }));
    expect(id).toBeNull();

    const { rows } = await db.query(
      "select scope, description from reconciliation_breaks where detail->>'condition_id' = $1",
      [COND],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].scope).toBe("orders");
    expect(rows[0].description).toMatch(/unknown/);

    const { rows: orders } = await db.query(
      "select count(*)::int as n from venue_orders where condition_id=$1",
      [COND],
    );
    expect(orders[0].n).toBe(0);
  });

  it("also breaks when the venue accepts but returns no order id", async () => {
    const id = await store.recordSubmission(envelope(), report({ venueOrderId: null }));
    expect(id).toBeNull();
  });
});

describeDb("fill accounting is idempotent", () => {
  it("projects filled_quantity by summing fills", async () => {
    const rep = report();
    await store.recordSubmission(envelope(), rep);
    const oid = rep.venueOrderId as string;

    const f1 = fill(oid, { quantity: "40" });
    const f2 = fill(oid, { quantity: "60" });
    expect(await store.recordFills(oid, [f1, f2])).toBe(2);

    const row = await orderRow(oid);
    expect(Number(row.filled_quantity)).toBe(100);
    expect(Number(row.fees_paid)).toBeCloseTo(0.2, 6);
    expect(row.status).toBe("filled"); // 100 of 100
  });

  it("a REDELIVERED fill does not move the position", async () => {
    // The property that matters. An increment would read 80 here and
    // every cap sized against it would be wrong, silently.
    const rep = report();
    await store.recordSubmission(envelope(), rep);
    const oid = rep.venueOrderId as string;

    const f = fill(oid, { quantity: "40" });
    expect(await store.recordFills(oid, [f])).toBe(1);
    expect(await store.recordFills(oid, [f])).toBe(0); // same venue_fill_id

    const row = await orderRow(oid);
    expect(Number(row.filled_quantity)).toBe(40);
    expect(row.status).toBe("partially_filled");
  });

  it("records one event per genuinely new fill, never per redelivery", async () => {
    const rep = report();
    await store.recordSubmission(envelope(), rep);
    const oid = rep.venueOrderId as string;
    const f = fill(oid);

    await store.recordFills(oid, [f]);
    await store.recordFills(oid, [f]);

    const { rows } = await db.query(
      "select count(*)::int as n from venue_order_events where venue_order_id=$1 and event_type='fill'",
      [oid],
    );
    expect(rows[0].n).toBe(1);
  });

  it("re-projects even when nothing new arrived", async () => {
    // A crash between inserting a fill and projecting it would
    // otherwise leave the order permanently understating its position.
    const rep = report();
    await store.recordSubmission(envelope(), rep);
    const oid = rep.venueOrderId as string;

    await db.query(
      "insert into venue_fills (venue, venue_order_id, venue_fill_id, occurred_at, price, " +
        "quantity, fee, liquidity) values ('polymarket',$1,$2,now(),0.4,25,0.05,'taker')",
      [oid, `f-${crypto.randomUUID()}`],
    );
    expect(Number((await orderRow(oid)).filled_quantity)).toBe(0); // not yet projected

    expect(await store.recordFills(oid, [])).toBe(0);
    expect(Number((await orderRow(oid)).filled_quantity)).toBe(25);
  });

  it("an over-fill does not produce an incoherent row", async () => {
    const rep = report();
    await store.recordSubmission(envelope(), rep);
    const oid = rep.venueOrderId as string;

    await store.recordFills(oid, [fill(oid, { quantity: "140" })]);
    const row = await orderRow(oid);
    expect(row.status).toBe("filled");
    expect(Number(row.filled_quantity)).toBe(140);
  });
});

describeDb("the schema refuses what the code refuses", () => {
  it("venue_orders.status rejects 'unknown' at the database level", async () => {
    // Migration 021. The code guard and the constraint are two halves
    // of one control: the guard gives a readable error, the constraint
    // stops a future writer that bypasses the store class entirely.
    await expect(
      db.query(
        "insert into venue_orders (venue,venue_order_id,client_intent_id,account_id," +
          "condition_id,outcome_token_id,side,quantity,limit_price,time_in_force,status," +
          "created_at,updated_at) values ('polymarket','ord-x',gen_random_uuid(),$1,$2," +
          "'t','BUY',1,0.5,'FOK','unknown',now(),now())",
        [ACCOUNT, COND],
      ),
    ).rejects.toThrow(/venue_orders_status_check/);
  });
});
