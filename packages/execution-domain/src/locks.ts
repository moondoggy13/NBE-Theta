/**
 * Per-instrument execution locks.
 *
 * ## The bug this exists to prevent
 *
 * From CLAUDE.md's carried-forward bug history, the v2 incident:
 *
 * > async race — 4 close orders in 1 ms flipped a position into a 57×
 * > leveraged runaway long that lost $29k on a 1.94% drop. Root cause:
 * > sync check + async submit + shared mutable state + a mock broker
 * > with no buying-power enforcement.
 *
 * The shape of that bug is worth stating precisely, because it is easy
 * to reintroduce and invisible in review:
 *
 * ```ts
 * if (!this.inFlight) {           // check
 *   const pos = await venue.get() // ← every other trigger runs HERE
 *   this.inFlight = true;         // set, far too late
 *   await venue.submit(...)
 * }
 * ```
 *
 * Between the check and the set there is an `await`. JavaScript is
 * single-threaded but *not* atomic across awaits: at every `await` the
 * event loop is free to run the next trigger, which sees `inFlight`
 * still false and proceeds. Four triggers in the same millisecond all
 * pass the check, all submit, and the position ends up four times the
 * intended size in the opposite direction.
 *
 * ## The fix
 *
 * `tryAcquire` performs its check **and** its set with no `await`
 * between them. Within one synchronous run-to-completion block nothing
 * else can interleave, so exactly one caller can win the key. Every
 * loser is told `false` and must not proceed.
 *
 * This is why the method is deliberately **synchronous and non-blocking**
 * rather than an async `acquire()` that waits its turn. A queue would
 * make the losers execute *later*, which for a copy signal is exactly
 * wrong — by the time the lock frees, the price has moved and the
 * signal is stale. Losing the race means the trade is already being
 * handled; the correct response is to drop it, not to queue behind it.
 *
 * The key is per-instrument (`venue + account + condition + outcome`),
 * not global. A single global mutex — the v1/v2 shape — serialises
 * unrelated markets and is both slower and no safer.
 */

import { instrumentKey, type OutcomeInstrument } from "./types.js";

export interface LockHandle {
  readonly key: string;
  /** Idempotent: releasing twice is a no-op, not a corruption. */
  release(): void;
}

export class InstrumentLocks {
  private readonly held = new Map<string, { since: number }>();

  /**
   * Take the lock for `key`, or return null if someone else holds it.
   *
   * **Do not add an `await` between the `has` and the `set` below.** That
   * single edit reintroduces the v2 race, and no test that runs
   * operations sequentially will catch it.
   */
  tryAcquire(key: string, now: number = Date.now()): LockHandle | null {
    if (this.held.has(key)) return null;
    this.held.set(key, { since: now });

    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(key);
      },
    };
  }

  tryAcquireInstrument(
    account: string,
    instrument: OutcomeInstrument,
    now: number = Date.now(),
  ): LockHandle | null {
    return this.tryAcquire(instrumentKey(account, instrument), now);
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }

  get size(): number {
    return this.held.size;
  }

  /**
   * Keys held longer than `maxAgeMs`.
   *
   * A lock that outlives its operation means something threw between
   * acquire and release without a `finally`, and that instrument is now
   * permanently unreachable. Reporting is deliberate — this returns the
   * stuck keys rather than force-releasing them, because breaking a lock
   * whose holder may still be mid-submit is how you get the duplicate
   * order the lock was preventing. An operator decides.
   */
  stale(maxAgeMs: number, now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const [key, meta] of this.held) {
      if (now - meta.since > maxAgeMs) out.push(key);
    }
    return out;
  }
}

/**
 * Run `fn` under the instrument lock, or return `null` if it is held.
 *
 * The `finally` is the whole point: a throw between acquire and release
 * would otherwise strand the instrument forever.
 */
export async function withInstrumentLock<T>(
  locks: InstrumentLocks,
  account: string,
  instrument: OutcomeInstrument,
  fn: () => Promise<T>,
): Promise<T | null> {
  const handle = locks.tryAcquireInstrument(account, instrument);
  if (handle === null) return null;
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
