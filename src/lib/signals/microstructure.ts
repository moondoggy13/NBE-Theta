import type { L2Book, Tick } from "./types";

/**
 * Microprice (Stoikov): size-weighted mid.
 *   microPrice = (ask_size * bid_price + bid_size * ask_price) / (bid_size + ask_size)
 * This is biased toward whichever side has more depth — often a better short-horizon
 * predictor than the plain mid.
 */
export function microPrice(book: L2Book): number {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask) return NaN;
  const [bp, bs] = bid;
  const [ap, as] = ask;
  const total = bs + as;
  if (total <= 0) return NaN;
  return (as * bp + bs * ap) / total;
}

export function midPrice(book: L2Book): number {
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  if (bid == null || ask == null) return NaN;
  return (bid + ask) / 2;
}

/**
 * Order-book imbalance over the top N levels.
 * Returns (bidVol - askVol) / (bidVol + askVol), range [-1, +1].
 * Positive = more bid depth (expected upward drift).
 */
export function imbalance(book: L2Book, levels = 5): number {
  let b = 0;
  let a = 0;
  for (let i = 0; i < levels; i++) {
    if (book.bids[i]) b += book.bids[i][1];
    if (book.asks[i]) a += book.asks[i][1];
  }
  const total = b + a;
  return total === 0 ? 0 : (b - a) / total;
}

/**
 * Rough VPIN: fraction of buy-initiated volume in the last N ticks, centered at 0.
 * Returns signed imbalance in [-1, +1].
 */
export function vpin(ticks: readonly Tick[]): number {
  if (ticks.length === 0) return 0;
  let buy = 0;
  let sell = 0;
  for (const t of ticks) {
    if (t.side === "buy") buy += t.size;
    else sell += t.size;
  }
  const total = buy + sell;
  return total === 0 ? 0 : (buy - sell) / total;
}
