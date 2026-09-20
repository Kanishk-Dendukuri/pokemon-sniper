/**
 * Price confidence — whether the comps behind an automated price agree with it.
 *
 * An Alt Value is one number, and the import cannot tell a well-supported one
 * from a guess. The batch that produced it can: Card Uploader returns the
 * cert's recent sales, Card Ladder's own estimate and the last sale alongside
 * every price it fills in, and those either back the number up or they do
 * not. One CGC 10 Zekrom came back at $726.25 off sales of $77, $276, $417,
 * $830 and $938, with Card Ladder saying $305 — a price nobody should have
 * put a buyback behind without looking.
 *
 * The rules are deliberately few and each one names itself in the reason it
 * produces, so the review page can say why a card is waiting rather than only
 * that it is:
 *
 *   - too few recent sales to check the price against at all
 *   - the recent sales disagree with each other (a wide range)
 *   - the ask sits far from what the card has actually sold for
 *   - the ask sits far from Card Ladder's estimate for the same cert
 *
 * A failed check is a hold, never a refusal. The price still lands and the
 * slab waits for a human — the same manual pricing flow a steep move goes
 * through (lib/valuation-change.ts), so staff see one queue.
 *
 * Every dollar-ratio rule carries a dollar floor. A $3 card that sold for $2
 * and $6 has a 3× spread and a $4 problem, and pulling it out of the draw
 * costs more reviewer time than a wrong price ever could.
 *
 * The bars were set against a real night — 508 priced certs from
 * 2026-09-09. Graded Pokémon sells with a 2–3× spread across five sales as a
 * matter of course (auctions, best offers, a Heritage lot among eBay ones),
 * so a 2× spread bar held 42% of the night and said nothing useful; at 3× it
 * is the odd comp and the genuinely chaotic market. Half a year without a
 * sale is normal for a slow card, a year is not. The defaults below held
 * about a quarter of that night, most of it for having under two sales in a
 * year — the rule this was asked for — and each is a knob on
 * `ConfidenceRules` for when the queue says otherwise.
 *
 * The sales also price the card outright when they are fresh enough to
 * (`priceFromRecentSales`, owner rule 2026-09-17): five sales all inside the
 * last 60 days is a market with an opinion, and the average of the middle
 * three — the highest and the lowest dropped — is a better number than an ask
 * somebody filled in. Anything short of that and the Alt Value stands.
 *
 * Pure on purpose — no database, no server-only import — so the import script
 * and the admin page decide with the same function.
 */

export type Sale = {
  price: number;
  /** ISO timestamp of the sale. */
  date: string;
  platform?: string;
  listingType?: string;
  url?: string;
  title?: string;
};

/**
 * What Card Uploader knows about one cert beyond the price it filled in.
 * Written by scripts/carduploader-comps.ts off the batch's own data and read
 * back by the valuation import, keyed "GRADER|cert".
 */
export type CertComps = {
  cert: string;
  grader: string;
  /** The Alt Value the batch filled in, as Card Uploader reported it. */
  altValue: number | null;
  /** Card Ladder's own estimate for the cert, when it had one. */
  cardLadderValue: number | null;
  lastSale: { price: number; date: string } | null;
  /** Newest first, as returned. Card Uploader hands back up to five. */
  sales: Sale[];
  /** When the comps were pulled — the "now" the sales window is measured from. */
  fetchedAt: string;
};

/** Sales older than this are history, not evidence for today's price. */
export const CONFIDENCE_SALES_WINDOW_DAYS = 365;

/** Fewer recent sales than this and the price has nothing to be checked against. */
export const MIN_CONFIDENT_SALES = 2;

/** At most this many of the newest sales are judged; Card Uploader returns five. */
export const MAX_SALES_CONSIDERED = 5;

/**
 * How far apart the highest and lowest recent sale may sit, as a multiple.
 * 3 means the top sale is at most triple the bottom one. Past that no single
 * number describes the market, whichever one the ask landed on.
 */
export const MAX_SALES_SPREAD_RATIO = 3;

/**
 * How far the ask may sit from a reference price — the sales median, or Card
 * Ladder's estimate — as a multiple either way. Looser than the 30% change
 * hold on purpose: an Alt Value is an ask and the sales are realised, so the
 * two disagree a little even when both are right.
 */
export const REFERENCE_TOLERANCE = 1.5;

/**
 * A disagreement smaller than this in dollars is not worth a human's time,
 * whatever the ratio says. Also the price under which "too few sales" is not
 * raised: a card worth less than this has nothing much riding on its price.
 */
export const MIN_DISAGREEMENT_DOLLARS = 15;

/**
 * The bars above, gathered so a caller can tune them — the CLI's --confidence-*
 * flags, a calibration script over a night's comps — without every rule
 * reading a different global.
 */
export type ConfidenceRules = {
  windowDays: number;
  minSales: number;
  maxSpreadRatio: number;
  tolerance: number;
  minDollars: number;
};

export const DEFAULT_CONFIDENCE_RULES: ConfidenceRules = {
  windowDays: CONFIDENCE_SALES_WINDOW_DAYS,
  minSales: MIN_CONFIDENT_SALES,
  maxSpreadRatio: MAX_SALES_SPREAD_RATIO,
  tolerance: REFERENCE_TOLERANCE,
  minDollars: MIN_DISAGREEMENT_DOLLARS,
};

export type ConfidenceDirection = "drop" | "rise" | "none";

export type ConfidenceVerdict = {
  /** True when at least one rule fired and the slab should wait for a human. */
  flagged: boolean;
  /** One line per rule that fired, in the order above. Empty when confident. */
  reasons: string[];
  /**
   * Which side of the market the ask sits on: `rise` when it is above the
   * sales, `drop` when below, `none` when there was nothing to compare against
   * or the rules that fired say nothing about direction.
   */
  direction: ConfidenceDirection;
  stats: ConfidenceStats;
};

export type ConfidenceStats = {
  /** Sales inside the window that the verdict was drawn from. */
  salesCounted: number;
  salesMin: number | null;
  salesMax: number | null;
  salesMedian: number | null;
  /** ISO date of the newest sale on record, inside the window or not. */
  newestSale: string | null;
  cardLadderValue: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio1 = (n: number) => Math.round(n * 10) / 10;
const money = (n: number) => `$${n.toFixed(2)}`;

/** The newest sales with a real price inside the window, newest first. */
export function usableSales(sales: Sale[], now: Date, windowDays = CONFIDENCE_SALES_WINDOW_DAYS): Sale[] {
  const cutoff = now.getTime() - windowDays * 86_400_000;
  return [...sales]
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .filter((s) => {
      const at = new Date(s.date).getTime();
      return Number.isFinite(at) && at >= cutoff && at <= now.getTime() + 86_400_000;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, MAX_SALES_CONSIDERED);
}

export function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * How fresh the newest five sales all have to be before they price the card
 * themselves rather than merely check the Alt Value.
 */
export const SALES_PRICE_WINDOW_DAYS = 60;

/** How many sales inside that window it takes. Card Uploader returns five at most. */
export const SALES_PRICE_MIN_SALES = 5;

export type SalesPriceRules = {
  windowDays: number;
  minSales: number;
};

export const DEFAULT_SALES_PRICE_RULES: SalesPriceRules = {
  windowDays: SALES_PRICE_WINDOW_DAYS,
  minSales: SALES_PRICE_MIN_SALES,
};

/** A price drawn from the sales themselves, and the arithmetic behind it. */
export type SalesPrice = {
  /** The average of the sales that were kept, to the cent. */
  price: number;
  /** The sales that were averaged, lowest first. */
  averaged: number[];
  /** The highest and the lowest sale, which were set aside. */
  dropped: { low: number; high: number };
  /** ISO dates of the oldest and newest sale that qualified. */
  oldestSale: string;
  newestSale: string;
  windowDays: number;
};

/**
 * The price the recent sales put on the card, or null when they cannot.
 *
 * Only the newest `minSales` sales are looked at, and every one of them has to
 * fall inside `windowDays` of `now` — one older sale among five means the
 * market has not spoken five times lately, and the Alt Value stands. When they
 * qualify, the highest and the lowest are set aside (the odd auction, the
 * lucky best offer) and the rest are averaged.
 *
 * `now` is when the comps were pulled, for the same reason the confidence
 * check measures from it: a replayed export is judged in its own window.
 */
export function priceFromRecentSales(
  comps: CertComps | null | undefined,
  now: Date = comps ? new Date(comps.fetchedAt) : new Date(),
  rules: SalesPriceRules = DEFAULT_SALES_PRICE_RULES,
): SalesPrice | null {
  if (!comps || rules.minSales < 3) return null;
  if (Number.isNaN(now.getTime())) now = new Date();

  // usableSales caps at MAX_SALES_CONSIDERED; a bar above that can never be met.
  const recent = usableSales(comps.sales, now, rules.windowDays).slice(0, rules.minSales);
  if (recent.length < rules.minSales) return null;

  const prices = recent.map((s) => s.price).sort((a, b) => a - b);
  const averaged = prices.slice(1, -1);
  const price = round2(averaged.reduce((sum, p) => sum + p, 0) / averaged.length);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    averaged,
    dropped: { low: prices[0], high: prices[prices.length - 1] },
    oldestSale: recent[recent.length - 1].date,
    newestSale: recent[0].date,
    windowDays: rules.windowDays,
  };
}

/** Whether `price` sits outside the tolerance of `reference`, by enough dollars to matter. */
function disagrees(price: number, reference: number, rules: ConfidenceRules): boolean {
  const ratio = price / reference;
  const outside = ratio > rules.tolerance || ratio < 1 / rules.tolerance;
  return outside && Math.abs(price - reference) >= rules.minDollars;
}

/**
 * Whether an automated price is believable against the comps that came with it.
 *
 * No comps means no opinion: the Drive intake and a hand-run import carry no
 * comps file, and a rule that cannot see the sales has nothing to say. That is
 * `flagged: false`, not confidence — the 30% change hold still applies either
 * way.
 *
 * `now` is when the comps were pulled, not the wall clock, so replaying an old
 * export judges its sales against the window they were pulled in.
 */
export function assessPriceConfidence(
  price: number,
  comps: CertComps | null | undefined,
  now: Date = comps ? new Date(comps.fetchedAt) : new Date(),
  rules: ConfidenceRules = DEFAULT_CONFIDENCE_RULES,
): ConfidenceVerdict {
  const empty: ConfidenceStats = {
    salesCounted: 0, salesMin: null, salesMax: null, salesMedian: null,
    newestSale: null, cardLadderValue: null,
  };
  if (!comps || !Number.isFinite(price) || price <= 0) {
    return { flagged: false, reasons: [], direction: "none", stats: empty };
  }
  if (Number.isNaN(now.getTime())) now = new Date();

  const recent = usableSales(comps.sales, now, rules.windowDays);
  const prices = recent.map((s) => s.price);
  const newest = [...comps.sales]
    .map((s) => s.date)
    .filter((d) => Number.isFinite(new Date(d).getTime()))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  const cardLadder = comps.cardLadderValue !== null && comps.cardLadderValue > 0 ? comps.cardLadderValue : null;
  const stats: ConfidenceStats = {
    salesCounted: recent.length,
    salesMin: prices.length > 0 ? Math.min(...prices) : null,
    salesMax: prices.length > 0 ? Math.max(...prices) : null,
    salesMedian: median(prices),
    newestSale: newest,
    cardLadderValue: cardLadder,
  };

  const reasons: string[] = [];
  let direction: ConfidenceDirection = "none";

  // 1. Nothing to check against. Only raised on a card worth checking.
  if (recent.length < rules.minSales && price >= rules.minDollars) {
    const window = `${rules.windowDays} days`;
    reasons.push(recent.length === 0
      ? `no sales in the last ${window}` + (newest ? ` (newest ${newest.slice(0, 10)})` : "")
      : `only ${recent.length} sale in the last ${window}`);
  }

  // 2. The sales disagree with each other.
  if (stats.salesMin !== null && stats.salesMax !== null && recent.length >= 2) {
    const spread = stats.salesMax / stats.salesMin;
    if (spread > rules.maxSpreadRatio && stats.salesMax - stats.salesMin >= rules.minDollars) {
      reasons.push(`${recent.length} sales range ${money(stats.salesMin)}–${money(stats.salesMax)} (${ratio1(spread)}×)`);
    }
  }

  // 3. The ask sits far from what the card actually sells for.
  if (stats.salesMedian !== null && recent.length >= 2 && disagrees(price, stats.salesMedian, rules)) {
    reasons.push(`ask ${money(price)} is ${ratio1(price / stats.salesMedian)}× the ${money(stats.salesMedian)} median of ${recent.length} sales`);
    direction = price > stats.salesMedian ? "rise" : "drop";
  }

  // 4. Card Ladder read the same cert and came to a different number.
  if (cardLadder !== null && disagrees(price, cardLadder, rules)) {
    reasons.push(`Card Ladder estimates ${money(cardLadder)} (ask is ${ratio1(price / cardLadder)}×)`);
    if (direction === "none") direction = price > cardLadder ? "rise" : "drop";
  }

  return { flagged: reasons.length > 0, reasons, direction, stats };
}
