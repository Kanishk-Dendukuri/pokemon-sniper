/**
 * What a card is worth, from its recent sales, and whether those sales are
 * enough to say.
 *
 * Both halves of the business read this: the snipers price a lot before
 * bidding on it (scripts/sniper-core.ts), and the app's scripts/verify-prices.ts
 * checks a vault card's stored price against the same evidence.
 *
 * Two things are settled here, and both are a run's to choose since
 * 2026-09-17: the sales rule — how many sales, how recent — and the basis
 * rule, which is what those sales are boiled down to before any tier table's
 * percentage multiplies it. The defaults are the five newest sales inside
 * sixty days, taken at their second-lowest. The app's copy is not configurable
 * and still takes the lowest as its floor; change one deliberately, not by
 * copying the other over it.
 *
 * The sales themselves come from Card Uploader's per-cert lookup, which is
 * free and answers for any cert.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export type Sale = { price: number; date: string; platform?: string; url?: string };

// ── The sales rule ────────────────────────────────────────────────────────────

/**
 * What counts as enough sales history to trust a price: at least this many
 * recent sales, every one of them inside the window. The window was a month
 * until 2026-09-12; two months lets the cards that sell a few times a month
 * through, which at Alt — where every lot is a candidate — is most of them.
 *
 * These are the defaults. A run may be given another rule — more sales, a
 * longer window — with --sales-rule or the SALES_RULE environment variable
 * (the workflow box); minSales() and salesWindowDays() are what the run is
 * actually working to.
 */
export const DEFAULT_MIN_SALES = 5;
export const DEFAULT_SALES_WINDOW_DAYS = 60;

/** How many sales a price is worked from, and how old the oldest of them may be. */
export type SalesRule = { count: number; windowDays: number };

export const DEFAULT_SALES_RULE: SalesRule = { count: DEFAULT_MIN_SALES, windowDays: DEFAULT_SALES_WINDOW_DAYS };

let activeSalesRule: SalesRule = DEFAULT_SALES_RULE;

/** The sales rule this run prices by. */
export function salesRule(): SalesRule {
  return activeSalesRule;
}

/** Price by this sales rule from now on — what --sales-rule does. */
export function setSalesRule(rule: SalesRule): void {
  activeSalesRule = rule;
}

/** How many recent sales this run prices from. */
export function minSales(): number {
  return activeSalesRule.count;
}

/** How old the oldest of those sales may be, in days. */
export function salesWindowDays(): number {
  return activeSalesRule.windowDays;
}

/**
 * A sales rule from one line: "5 sales in 60 days". The words are optional
 * either side of the numbers — "5 in 60", "5 sales within the last 60 days"
 * and "5 sales/60d" all read the same — but both numbers have to be there, so
 * a half-typed box is an error rather than a guess.
 */
export function parseSalesRule(text: string): SalesRule {
  const t = text.trim().toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ");
  const m = /^(\d+)\s*(?:sales?)?\s*(?:\/|,)?\s*(?:in|within|inside|over|of|across)?\s*(?:the\s+)?(?:last\s+|past\s+)?(\d+)\s*(?:d|days?)?$/.exec(t);
  if (!m) throw new Error(`cannot read the sales rule "${text}": want "<how many> sales in <how many> days", e.g. "5 sales in 60 days"`);
  const count = Number(m[1]);
  const windowDays = Number(m[2]);
  if (!Number.isInteger(count) || count < 1) throw new Error(`"${text}": a sales rule needs at least 1 sale`);
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error(`"${text}": a sales rule needs a window of at least 1 day`);
  return { count, windowDays };
}

/** A sales rule as one line, the way parseSalesRule() reads it back. */
export function formatSalesRule(rule: SalesRule = activeSalesRule): string {
  return `${rule.count} sales in ${rule.windowDays} days`;
}

// ── The basis rule ────────────────────────────────────────────────────────────

/**
 * How the recent sales become the one number a bid is worked out from — the
 * figure every tier-table percentage multiplies.
 *
 *   nth-lowest      the lowest, the second-lowest, the third-lowest…
 *   nth-highest     the highest, the second-highest…
 *   lowest-average  the N cheapest of them, averaged
 *   median          the middle one
 *   mean            all of them averaged
 *   trimmed-mean    the lowest and the highest thrown out, the rest averaged
 *
 * Fewer sales than the rule asks for never throws: an nth that runs off the
 * end takes the last sale there is, and an average of more than there are
 * averages what there is.
 */
export type BasisRule =
  | { kind: "nth-lowest"; n: number }
  | { kind: "nth-highest"; n: number }
  | { kind: "lowest-average"; n: number }
  | { kind: "median" }
  | { kind: "mean" }
  | { kind: "trimmed-mean" };

/**
 * The second-lowest of the five sales, unless a run says otherwise.
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
export const DEFAULT_BASIS: BasisRule = { kind: "nth-lowest", n: 2 };

let activeBasis: BasisRule = DEFAULT_BASIS;

/** The basis rule this run bids by. */
export function basisRule(): BasisRule {
  return activeBasis;
}

/** Work the bid basis out this way from now on — what --value-basis does. */
export function setBasis(rule: BasisRule): void {
  activeBasis = rule;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/** "2", "2nd", "second" — all of them two. Anything else is not a number here. */
function howMany(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (w in WORD_NUMBERS) return WORD_NUMBERS[w];
  const m = /^(\d+)(?:st|nd|rd|th)?$/.exec(w);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const BASIS_FORMS = '"lowest", "2nd lowest", "average of the 3 lowest", "drop the lowest and the highest, average the rest", "median" or "average"';

/**
 * A basis rule from the words for it: what the workflow's dropdown hands over,
 * and what a person would type. Hyphens, "the" and the ordinal's spelling are
 * all the same to it, so "second-lowest", "2nd lowest" and "the 2nd lowest"
 * read alike. Anything it cannot read is an error naming the forms it knows,
 * not a guess — a basis nobody meant is a whole auction bid at the wrong price.
 */
export function parseBasis(text: string): BasisRule {
  const t = text.trim().toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ").replace(/\.$/, "");
  if (!t) throw new Error(`a value basis cannot be blank: want ${BASIS_FORMS}`);

  if (/^(the )?(median|middle)( sale| comp| of them| of the sales)?$/.test(t)) return { kind: "median" };
  if (/^(the )?(average|mean)( sale| comp| of them| of the sales| of all( of them)?)?$/.test(t)) return { kind: "mean" };
  if (/^(the )?trimmed mean$/.test(t)
    || /^drop (the )?(lowest|highest) and (the )?(highest|lowest),? (then )?average (the rest|what.?s left)$/.test(t)) {
    return { kind: "trimmed-mean" };
  }

  let m: RegExpExecArray | null;
  // "average of the 3 lowest", "average of the lowest 3", "mean of the 2 cheapest"
  if ((m = /^(?:the )?(?:average|mean) of (?:the )?(?:(\S+) (lowest|cheapest)|(?:lowest|cheapest) (\S+))$/.exec(t))) {
    const n = howMany(m[1] ?? m[3]);
    if (n === null) throw new Error(`cannot read how many sales to average in "${text}": want "average of the 3 lowest"`);
    return n === 1 ? { kind: "nth-lowest", n: 1 } : { kind: "lowest-average", n };
  }
  // "lowest", "2nd lowest", "the second cheapest"
  if ((m = /^(?:the )?(?:(\S+) )?(lowest|cheapest)$/.exec(t))) {
    const n = m[1] === undefined ? 1 : howMany(m[1]);
    if (n === null) throw new Error(`cannot read which sale "${text}" means: want "lowest", "2nd lowest", "3rd lowest"`);
    return { kind: "nth-lowest", n };
  }
  // "highest", "2nd highest"
  if ((m = /^(?:the )?(?:(\S+) )?(highest|dearest)$/.exec(t))) {
    const n = m[1] === undefined ? 1 : howMany(m[1]);
    if (n === null) throw new Error(`cannot read which sale "${text}" means: want "highest", "2nd highest"`);
    return { kind: "nth-highest", n };
  }

  throw new Error(`cannot read the value basis "${text}": want ${BASIS_FORMS}`);
}

/** "2nd", "3rd", "11th" — the ordinal a number is written as. */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** A basis rule in the words for it, the way parseBasis() reads it back. */
export function formatBasis(rule: BasisRule = activeBasis): string {
  switch (rule.kind) {
    case "nth-lowest": return rule.n === 1 ? "lowest" : `${ordinal(rule.n)} lowest`;
    case "nth-highest": return rule.n === 1 ? "highest" : `${ordinal(rule.n)} highest`;
    case "lowest-average": return `average of the ${rule.n} lowest`;
    case "median": return "median";
    case "mean": return "average";
    case "trimmed-mean": return "drop the lowest and the highest, average the rest";
  }
}

const mean = (prices: number[]) => round2(prices.reduce((a, b) => a + b, 0) / prices.length);

function middle(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A basis rule worked on a list of sale prices, in dollars. Prices at or below
 * zero are not sales and are dropped first; with nothing left, null.
 */
export function applyBasis(rule: BasisRule, prices: number[]): number | null {
  const sorted = prices.filter((p) => p > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  switch (rule.kind) {
    case "nth-lowest": return sorted[Math.min(rule.n, sorted.length) - 1];
    case "nth-highest": return sorted[sorted.length - Math.min(rule.n, sorted.length)];
    case "lowest-average": return mean(sorted.slice(0, Math.min(rule.n, sorted.length)));
    case "median": return middle(sorted);
    case "mean": return mean(sorted);
    // Under three sales there is nothing to trim: everything left would be
    // thrown away, so the average of what there is stands in.
    case "trimmed-mean": return sorted.length >= 3 ? mean(sorted.slice(1, -1)) : mean(sorted);
  }
}

// ── Pricing ───────────────────────────────────────────────────────────────────

/**
 * The sales a lot is judged on: the newest few of them with a real price,
 * newest first, as many as the sales rule asks for. Card Uploader sometimes
 * hands back more, and only these count — for the window as well as for the
 * price.
 */
export function recentSales(sales: Sale[], count = minSales()): Sale[] {
  return [...sales]
    .filter((s) => s.price > 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, count);
}

/**
 * The bid basis, from a list of sale prices: this run's basis rule worked on
 * them. Sold-report and the sniper price off the same rule through this.
 */
export function bidBasis(prices: number[], rule: BasisRule = activeBasis): number | null {
  return applyBasis(rule, prices);
}

/**
 * What a card is worth, for the bid: the basis rule worked on its recent
 * sales. See DEFAULT_BASIS for why the second-lowest of five is what a run
 * does unless it is told otherwise.
 */
export function marketPrice(sales: Sale[], count = minSales()): { price: number | null; used: Sale[] } {
  const used = recentSales(sales, count);
  return { price: bidBasis(used.map((s) => s.price)), used };
}

/**
 * The card's market value: the median of the same sales.
 *
 * The bid is worked out from the basis rule, on purpose; the median is what
 * the card actually goes for, and it is what a won lot's price is measured
 * against — paid all-in, as a share of this — in the CSV. It stays the median
 * whatever basis a run bids by, so two runs on different bases are still
 * measured against the same yardstick.
 */
export function salesMedian(sales: Sale[], count = minSales()): number | null {
  const prices = recentSales(sales, count).map((s) => s.price).sort((a, b) => a - b);
  return prices.length === 0 ? null : middle(prices);
}

/**
 * Whether a card's sales are enough to price it from: as many as the sales
 * rule asks for, every one inside its window. It judges the same sales the
 * price comes from, so an older one sitting behind them is neither used nor
 * held against the lot.
 */
export function salesGate(sales: Sale[], now = new Date()): { ok: boolean; reason?: string; oldestDays: number | null } {
  const want = minSales();
  const windowDays = salesWindowDays();
  const recent = recentSales(sales, want);
  if (recent.length === 0) return { ok: false, reason: "no sales history", oldestDays: null };

  const ages = recent.map((s) => (now.getTime() - new Date(s.date).getTime()) / 86_400_000);
  const oldestDays = Math.round(Math.max(...ages));

  if (recent.length < want) {
    return { ok: false, reason: `only ${recent.length} recent sale(s), need ${want}`, oldestDays };
  }
  if (oldestDays > windowDays) {
    return { ok: false, reason: `oldest of the last ${want} sales is ${oldestDays}d old, window is ${windowDays}d`, oldestDays };
  }
  return { ok: true, oldestDays };
}
