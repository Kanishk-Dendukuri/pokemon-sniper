/**
 * What a card is worth, from its recent sales, and whether those sales are
 * enough to say.
 *
 * Both halves of the business read this: the snipers price a lot before
 * bidding on it (scripts/sniper-core.ts), and the app's scripts/verify-prices.ts
 * checks a vault card's stored price against the same evidence. The sales rule
 * — how many, how recent — is one standard in both copies. The bid basis is
 * not, since 2026-09-17: this copy takes the second-lowest of the five sales
 * (marketPrice below), the app's still takes the lowest as its floor. Change
 * one deliberately, not by copying the other over it.
 *
 * The sales themselves come from Card Uploader's per-cert lookup, which is
 * free and answers for any cert.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What counts as enough sales history to trust a price: at least this many
 * recent sales, every one of them inside the window. The window was a month
 * until 2026-09-12; two months lets the cards that sell a few times a month
 * through, which at Alt — where every lot is a candidate — is most of them.
 */
export const MIN_SALES = 5;
export const SALES_WINDOW_DAYS = 60;

export type Sale = { price: number; date: string; platform?: string; url?: string };

/**
 * The sales a lot is judged on: the newest MIN_SALES of them with a real
 * price, newest first. Card Uploader sometimes hands back more, and only these
 * count — for the window as well as for the price.
 */
export function recentSales(sales: Sale[], count = MIN_SALES): Sale[] {
  return [...sales]
    .filter((s) => s.price > 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, count);
}

/**
 * The bid basis, from a list of sale prices: the second-lowest of them. With
 * one price, that price; with none, null. Sold-report and the sniper price
 * off the same rule through this.
 */
export function bidBasis(prices: number[]): number | null {
  const sorted = prices.filter((p) => p > 0).sort((a, b) => a - b);
  return sorted.length >= 2 ? sorted[1] : sorted.length === 1 ? sorted[0] : null;
}

/**
 * What a card is worth, for the bid: the second-lowest of those five sales.
 *
 * Not the average, because a bid at the average is a bid that only breaks
 * even. Not the lowest either, since 2026-09-17: one wrong comp on the low
 * side — a damaged copy, a mislabelled grade, a sale Card Ladder filed under
 * the wrong card — sank the bid to nothing on a card the other four sales
 * agreed about, and lost the lot for no reason. The second-lowest throws
 * that one out and is still a cautious figure: the two highest of the five
 * never touch it, so the odd comp that is far too high (a $635 Base Set
 * Charizard once turned up among five sales of a $90 Psyduck) costs nothing
 * either.
 */
export function marketPrice(sales: Sale[], count = MIN_SALES): { price: number | null; used: Sale[] } {
  const used = recentSales(sales, count);
  return { price: bidBasis(used.map((s) => s.price)), used };
}

/**
 * The card's market value: the median of the same five sales.
 *
 * The bid is worked out from the second-lowest of them, on purpose; the median is what
 * the card actually goes for, and it is what a won lot's price is measured
 * against — paid all-in, as a share of this — in the CSV.
 */
export function salesMedian(sales: Sale[], count = MIN_SALES): number | null {
  const prices = recentSales(sales, count).map((s) => s.price).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 1 ? prices[mid] : round2((prices[mid - 1] + prices[mid]) / 2);
}

/**
 * Whether a card's sales are enough to price it from: MIN_SALES of them, every
 * one inside SALES_WINDOW_DAYS. It judges the same five the price comes from,
 * so an older sixth sale sitting behind them is neither used nor held against
 * the lot.
 */
export function salesGate(sales: Sale[], now = new Date()): { ok: boolean; reason?: string; oldestDays: number | null } {
  const recent = recentSales(sales);
  if (recent.length === 0) return { ok: false, reason: "no sales history", oldestDays: null };

  const ages = recent.map((s) => (now.getTime() - new Date(s.date).getTime()) / 86_400_000);
  const oldestDays = Math.round(Math.max(...ages));

  if (recent.length < MIN_SALES) {
    return { ok: false, reason: `only ${recent.length} recent sale(s), need ${MIN_SALES}`, oldestDays };
  }
  if (oldestDays > SALES_WINDOW_DAYS) {
    return { ok: false, reason: `oldest of the last ${MIN_SALES} sales is ${oldestDays}d old, window is ${SALES_WINDOW_DAYS}d`, oldestDays };
  }
  return { ok: true, oldestDays };
}
