import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_SQL,
  LEASE_SECONDS,
  RECLAIM_SQL,
  RELEASE_SQL,
  TERMINAL_SQL,
  assertLeaseExceedsWork,
} from "../outbox.js";

/**
 * The outbox, against a real database.
 *
 * Until PR 14 not one of these SQL strings had ever been executed. Every
 * executor test mocked the venue and none touched Postgres, so the
 * queries were verified by reading them — which is exactly how two
 * non-existent columns (`process_heartbeats.updated_at`,
 * `operator_actions.created_at`) survived review and shipped in PR 9,
 * silently returning empty panels that read as a healthy system.
 *
 * **The SQL is imported, never copied.** A test that pasted the queries
 * would pass while the executor's actual SQL was broken, which is the
 * failure mode that matters here.
 *
 * Two properties carry the architecture:
 *
 * 1. **`FOR UPDATE SKIP LOCKED` hands disjoint sets to concurrent
 *    claimers.** This is why ADR-0002 rejected Redis — "each row goes to
 *    exactly one worker, with no coordinator". It had only ever been
 *    asserted in a comment.
 * 2. **A lease expires, but never under a live worker.** The reaper
 *    fixes stranded intents; a reaper that is too eager causes the same
 *    intent to be dispatched twice, which is the v2 failure class and
 *    strictly worse than the problem it solves. Both directions are
 *    tested, and the second is the one to read carefully.
 *
 * Named `risk-gate-*` per AGENTS.md: this changes execution-path
 * behaviour, so it needs an ADR (`docs/adr/0006-intent-leases.md`), this
 * regression test, and review by someone other than the author.
 */

const DATABASE_URL = process.env.DATABASE_URL;

// Self-skips without a database, matching the Python integration tests.
// CI runs this in the `database` job, which has the Postgres service and
// has already applied the migrations — a skip there would be a silently
// green integration test, which is worse than not having one.
const describeDb = DATABASE_URL ? describe : describe.skip;

let db: Client;

const PREFIX = "pr14-";

async function seed(
  n: number,
  opts: { status?: string; expiresInSeconds?: number; availableInSeconds?: number } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { rows } = await db.query(
      `insert into execution_intents
         (strategy_type, dedupe_key, payload, status, available_at, expires_at)
       values ('copy', $1, '{}'::jsonb, $2,
               now() + ($3 || ' seconds')::interval,
               now() + ($4 || ' seconds')::interval)
       returning id`,
      [
        `${PREFIX}${crypto.randomUUID()}`,
        opts.status ?? "ready",
        String(opts.availableInSeconds ?? 0),
        String(opts.expiresInSeconds ?? 3600),
      ],
    );
    ids.push(rows[0].id as string);
  }
  return ids;
}

async function claim(worker: string, limit: number, lease = LEASE_SECONDS) {
  const { rows } = await db.query(CLAIM_SQL, [worker, limit, String(lease)]);
  return rows as { id: string; attempt_count: number }[];
}

/**
 * A lease that is unambiguously in the past.
 *
 * Zero would set `lease_expires_at` to the claiming transaction's
 * `now()`, leaving the reaper's `lease_expires_at < now()` to depend on
 * the next transaction's clock being strictly later. That holds in
 * practice but it is a timing assumption inside a test whose job is to
 * prove a safety property, so it is removed rather than relied on.
 */
const ALREADY_EXPIRED = -5;

async function statusOf(id: string): Promise<string> {
  const { rows } = await db.query("select status from execution_intents where id = $1", [id]);
  return rows[0].status as string;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  if (db) await db.end();
});

beforeEach(async () => {
  if (!DATABASE_URL) return;
  await db.query("delete from execution_intents where dedupe_key like $1", [`${PREFIX}%`]);
});

describeDb("the outbox SQL runs against the real schema", () => {
  it("CLAIM_SQL executes and returns the columns the executor reads", async () => {
    await seed(1);
    const claimed = await claim("w1", 10);
    expect(claimed).toHaveLength(1);
    // Every field ClaimedIntent declares must actually come back.
    for (const k of ["id", "strategy_type", "dedupe_key", "payload", "attempt_count", "expires_at"])
      expect(claimed[0]).toHaveProperty(k);
  });

  it("RELEASE_SQL returns a claim to ready with a backoff", async () => {
    const [id] = await seed(1);
    await claim("w1", 10);
    await db.query(RELEASE_SQL, [id, "30", "transient venue error"]);
    const { rows } = await db.query(
      "select status, claimed_by, available_at > now() as deferred from execution_intents where id = $1",
      [id],
    );
    expect(rows[0].status).toBe("ready");
    expect(rows[0].claimed_by).toBeNull();
    expect(rows[0].deferred).toBe(true);
  });

  it("TERMINAL_SQL moves an intent to a terminal status", async () => {
    const [id] = await seed(1);
    await claim("w1", 10);
    await db.query(TERMINAL_SQL, [id, "filled", null]);
    expect(await statusOf(id)).toBe("filled");
  });

  it("claims increment attempt_count, so backoff actually escalates", async () => {
    const [id] = await seed(1);
    await claim("w1", 10);
    await db.query(RELEASE_SQL, [id, "0", "retry"]);
    const second = await claim("w2", 10);
    expect(second[0].attempt_count).toBe(2);
  });
});

describeDb("FOR UPDATE SKIP LOCKED gives each row to exactly one worker", () => {
  it("two concurrent claimers get disjoint sets and lose nothing", async () => {
    // The property ADR-0002 rejected Redis for. Both claims run inside
    // open transactions so their row locks genuinely overlap in time —
    // sequential claims would pass even if SKIP LOCKED were absent.
    await seed(20);

    const a = new Client({ connectionString: DATABASE_URL });
    const b = new Client({ connectionString: DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const [ra, rb] = await Promise.all([
        a.query(CLAIM_SQL, ["worker-a", 10, String(LEASE_SECONDS)]),
        b.query(CLAIM_SQL, ["worker-b", 10, String(LEASE_SECONDS)]),
      ]);
      await a.query("commit");
      await b.query("commit");

      const idsA = new Set(ra.rows.map((r) => r.id as string));
      const idsB = new Set(rb.rows.map((r) => r.id as string));
      const overlap = [...idsA].filter((id) => idsB.has(id));

      expect(overlap).toEqual([]);
      // And nothing was skipped into oblivion: 20 rows, 20 claims.
      expect(idsA.size + idsB.size).toBe(20);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("never claims an intent that has already expired", async () => {
    await seed(1, { expiresInSeconds: -1 });
    expect(await claim("w1", 10)).toHaveLength(0);
  });

  it("never claims an intent whose backoff has not elapsed", async () => {
    await seed(1, { availableInSeconds: 60 });
    expect(await claim("w1", 10)).toHaveLength(0);
  });

  it("the dedupe key stops the same decision being enqueued twice", async () => {
    const key = `${PREFIX}same-decision`;
    const insert = () =>
      db.query(
        `insert into execution_intents (strategy_type, dedupe_key, payload, expires_at)
         values ('copy', $1, '{}'::jsonb, now() + interval '1 hour')`,
        [key],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
  });
});

describeDb("the reaper recovers stranded claims", () => {
  it("reclaims a claim whose lease has expired", async () => {
    // The bug this PR exists for: worker claims, worker dies, row sits in
    // `claimed` where CLAIM_SQL (which selects only `ready`) will never
    // look at it again.
    const [id] = await seed(1);
    await claim("doomed-worker", 10, ALREADY_EXPIRED);
    expect(await statusOf(id)).toBe("claimed");

    const { rows } = await db.query(RECLAIM_SQL, ["0"]);
    expect(rows.map((r) => r.id)).toContain(id);
    expect(await statusOf(id)).toBe("ready");

    // And it is genuinely claimable again, not merely relabelled.
    expect(await claim("w2", 10)).toHaveLength(1);
  });

  it("records why an intent was reclaimed, naming the worker that lost it", async () => {
    const [id] = await seed(1);
    await claim("doomed-worker", 10, ALREADY_EXPIRED);
    await db.query(RECLAIM_SQL, ["0"]);
    const { rows } = await db.query("select last_error from execution_intents where id = $1", [id]);
    expect(rows[0].last_error).toMatch(/doomed-worker/);
  });

  it("treats a pre-migration claim (NULL lease) as already stranded", async () => {
    const [id] = await seed(1);
    await claim("w1", 10);
    await db.query("update execution_intents set lease_expires_at = null where id = $1", [id]);
    await db.query(RECLAIM_SQL, ["0"]);
    expect(await statusOf(id)).toBe("ready");
  });

  it("applies a backoff rather than re-offering immediately", async () => {
    // Without this, an intent that crashes its worker crashes the next
    // one too and the reaper turns one poison message into a hot loop.
    const [id] = await seed(1);
    await claim("w1", 10, ALREADY_EXPIRED);
    await db.query(RECLAIM_SQL, ["60"]);
    const { rows } = await db.query(
      "select available_at > now() as deferred from execution_intents where id = $1",
      [id],
    );
    expect(rows[0].deferred).toBe(true);
  });
});

describeDb("the reaper never steals live work", () => {
  it("leaves a claim whose lease is still running", async () => {
    // THE dangerous direction. Reclaiming under a live worker dispatches
    // the same intent twice — the v2 failure class, and strictly worse
    // than the stranding the reaper exists to fix.
    const [id] = await seed(1);
    await claim("healthy-worker", 10, LEASE_SECONDS);

    const { rows } = await db.query(RECLAIM_SQL, ["0"]);
    expect(rows.map((r) => r.id)).not.toContain(id);
    expect(await statusOf(id)).toBe("claimed");
  });

  it("never reclaims a reconciliation_break", async () => {
    // We submitted and do not know the outcome. Re-dispatching is
    // precisely how the same order gets placed twice.
    const [id] = await seed(1, { status: "reconciliation_break" });
    await db.query(RECLAIM_SQL, ["0"]);
    expect(await statusOf(id)).toBe("reconciliation_break");
  });

  it("never reclaims a terminal intent", async () => {
    for (const status of ["filled", "canceled", "rejected", "expired", "settled"]) {
      const [id] = await seed(1, { status });
      await db.query(RECLAIM_SQL, ["0"]);
      expect(await statusOf(id)).toBe(status);
    }
  });
});

describe("the lease invariant is enforced, not just documented", () => {
  it("accepts a work budget comfortably inside the lease", () => {
    expect(() => assertLeaseExceedsWork(30)).not.toThrow();
  });

  it("refuses a work budget that could outlive the lease", () => {
    // If someone raises a venue timeout past the lease, this throws at
    // startup rather than silently enabling duplicate dispatch.
    expect(() => assertLeaseExceedsWork(LEASE_SECONDS)).toThrow(/duplicate dispatch/);
    expect(() => assertLeaseExceedsWork(LEASE_SECONDS + 1)).toThrow();
  });
});
