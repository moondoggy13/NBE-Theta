/**
 * Smart-money aggregation: turn tracked-wallet positions + trades into
 * the Conviction Board — per-market consensus of the wallets we follow.
 *
 * Pure functions over plain rows so the math is unit-testable without a
 * database. The /api/smart-money/* routes assemble inputs (service-role
 * reads) and call these.
 *
 * Conviction model (deliberately simple and inspectable, not learned):
 *   contribution(wallet, position) =
 *     watchlistWeight × log10(1 + $initial) × 0.5^(ageHours / halfLife)
 *
 *   - watchlistWeight: operator-set trust multiplier (0..10, default 1).
 *   - log10($): a $100k position matters more than a $1k one, but not
 *     100× more — sub-linear so one whale can't own the board.
 *   - recency half-life (72h default): conviction decays as entries age;
 *     a stale pile of positions ranks below fresh accumulation.
 *
 *   A market's conviction = dominant-side score − opposing score, so
 *   genuine disagreement between tracked wallets cancels toward zero
 *   instead of reading as a strong signal.
 */

export interface WatchWeight {
  weight: number;
  status: "watch" | "copy" | "mute";
}

export interface PositionRow {
  wallet: string;
  condition_id: string;
  outcome_token_id: string;
  outcome_name: string | null;
  outcome_index: number | null;
  size: number;
  avg_price: number | null;
  cur_price: number | null;
  initial_value: number | null;
  current_value: number | null;
  cash_pnl: number | null;
  redeemable: boolean;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  end_date: string | null;
  captured_at: string;
}

export interface WalletStake {
  wallet: string;
  pseudonym: string | null;
  outcome: string;
  entryPrice: number | null;
  usd: number;
  cashPnl: number;
  lastActiveMs: number | null;
  weight: number;
}

export interface SideAggregate {
  outcome: string;
  wallets: number;
  usd: number;
  score: number;
  avgEntry: number | null;
  curPrice: number | null;
  stakes: WalletStake[];
}

export interface FlowRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  endDate: string | null;
  conviction: number;
  dominant: SideAggregate;
  opposing: SideAggregate | null;
  freshestMs: number;
  totalUsd: number;
}

export interface ComputeFlowsOptions {
  nowMs: number;
  halfLifeHours?: number;
  /** Drop markets whose smart-money total is below this (dust). */
  minTotalUsd?: number;
}

const DEFAULT_HALF_LIFE_HOURS = 72;

function decay(ageMs: number, halfLifeHours: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / (halfLifeHours * 3_600_000));
}

function sideKey(p: PositionRow): string {
  if (p.outcome_name && p.outcome_name.trim()) return p.outcome_name.trim();
  return p.outcome_index === 0 ? "Yes" : "No";
}

/**
 * lastTradeAt: freshest venue_trades timestamp per `${wallet}|${conditionId}`
 * (ms epoch). Position rows lacking one fall back to their snapshot time.
 */
export function computeFlows(
  positions: PositionRow[],
  weights: Map<string, WatchWeight>,
  lastTradeAt: Map<string, number>,
  pseudonyms: Map<string, string | null>,
  opts: ComputeFlowsOptions,
): FlowRow[] {
  const halfLife = opts.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  const minTotal = opts.minTotalUsd ?? 0;

  interface SideAccum {
    outcome: string;
    usd: number;
    score: number;
    entryNumer: number;
    entryDenom: number;
    curPrice: number | null;
    curPriceAt: number;
    stakes: WalletStake[];
  }
  interface MarketAccum {
    meta: PositionRow;
    sides: Map<string, SideAccum>;
    freshestMs: number;
  }

  const markets = new Map<string, MarketAccum>();

  for (const p of positions) {
    const w = weights.get(p.wallet);
    if (!w || w.status === "mute" || w.weight <= 0) continue;
    if (p.redeemable) continue; // market is over; nothing to copy
    if (!(p.size > 0)) continue;

    const usd = p.current_value ?? (p.cur_price != null ? p.size * p.cur_price : 0);
    const initial = p.initial_value ?? usd;
    const lastMs =
      lastTradeAt.get(`${p.wallet}|${p.condition_id}`) ?? Date.parse(p.captured_at) ?? opts.nowMs;
    const contribution =
      w.weight * Math.log10(1 + Math.max(0, initial)) * decay(opts.nowMs - lastMs, halfLife);

    let m = markets.get(p.condition_id);
    if (!m) {
      m = { meta: p, sides: new Map(), freshestMs: 0 };
      markets.set(p.condition_id, m);
    }
    if (!m.meta.title && p.title) m.meta = p;
    m.freshestMs = Math.max(m.freshestMs, lastMs);

    const key = sideKey(p);
    let side = m.sides.get(key);
    if (!side) {
      side = {
        outcome: key,
        usd: 0,
        score: 0,
        entryNumer: 0,
        entryDenom: 0,
        curPrice: null,
        curPriceAt: 0,
        stakes: [],
      };
      m.sides.set(key, side);
    }
    side.usd += usd;
    side.score += contribution;
    if (p.avg_price != null && initial > 0) {
      side.entryNumer += p.avg_price * initial;
      side.entryDenom += initial;
    }
    const capturedMs = Date.parse(p.captured_at) || 0;
    if (p.cur_price != null && capturedMs >= side.curPriceAt) {
      side.curPrice = p.cur_price;
      side.curPriceAt = capturedMs;
    }
    side.stakes.push({
      wallet: p.wallet,
      pseudonym: pseudonyms.get(p.wallet) ?? null,
      outcome: key,
      entryPrice: p.avg_price,
      usd,
      cashPnl: p.cash_pnl ?? 0,
      lastActiveMs: lastTradeAt.get(`${p.wallet}|${p.condition_id}`) ?? null,
      weight: w.weight,
    });
  }

  const rows: FlowRow[] = [];
  for (const [conditionId, m] of markets) {
    const sides = [...m.sides.values()].sort((a, b) => b.score - a.score);
    if (sides.length === 0) continue;
    const toAggregate = (s: SideAccum): SideAggregate => ({
      outcome: s.outcome,
      wallets: new Set(s.stakes.map((st) => st.wallet)).size,
      usd: s.usd,
      score: s.score,
      avgEntry: s.entryDenom > 0 ? s.entryNumer / s.entryDenom : null,
      curPrice: s.curPrice,
      stakes: [...s.stakes].sort((a, b) => b.usd - a.usd),
    });
    const dominant = toAggregate(sides[0]);
    const opposing = sides.length > 1 ? toAggregate(sides[1]) : null;
    const totalUsd = sides.reduce((sum, s) => sum + s.usd, 0);
    if (totalUsd < minTotal) continue;
    const conviction = Math.max(0, dominant.score - (opposing?.score ?? 0));
    rows.push({
      conditionId,
      title: m.meta.title,
      slug: m.meta.slug,
      eventSlug: m.meta.event_slug,
      endDate: m.meta.end_date,
      conviction: Math.round(conviction * 100) / 100,
      dominant,
      opposing,
      freshestMs: m.freshestMs,
      totalUsd,
    });
  }

  rows.sort((a, b) => b.conviction - a.conviction);
  return rows;
}

/** Tier the roster by a quality score (leaderboard PnL today; the real
 * scored ranking replaces this input once `theta-score-wallets` lands).
 * Top 20% → S, next 30% → A, rest → B. Stable on ties by wallet. */
export function assignTiers(
  ranked: Array<{ wallet: string; quality: number }>,
): Map<string, "S" | "A" | "B"> {
  const sorted = [...ranked].sort(
    (a, b) => b.quality - a.quality || a.wallet.localeCompare(b.wallet),
  );
  const tiers = new Map<string, "S" | "A" | "B">();
  const n = sorted.length;
  sorted.forEach((r, i) => {
    const pct = n <= 1 ? 0 : i / n;
    tiers.set(r.wallet, pct < 0.2 ? "S" : pct < 0.5 ? "A" : "B");
  });
  return tiers;
}
