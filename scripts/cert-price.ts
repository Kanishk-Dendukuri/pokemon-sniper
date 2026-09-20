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

/**
 * How many sales a price is worked from, how old the oldest of them may be,
 * and how few of them will still do.
 */
export type SalesRule = {
  /** How many of the newest sales are looked at. */
  count: number;
  /** How old the oldest of them may be, in days. */
  windowDays: number;
  /**
   * The fewest of them that have to be there. Absent means `count` — every
   * sale the rule looks at. A smaller number prices a thinner card: "5 sales
   * in 60 days, at least 3" works from whatever three, four or five of them
   * the window holds, and only gives up under three.
   */
  need?: number;
};

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

/** The fewest sales that will still price a card under this rule. */
export function needSales(rule: SalesRule = activeSalesRule): number {
  return rule.need ?? rule.count;
}

const DAYS_IN: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/**
 * A length of time in days: "60", "60 days", "8 weeks", "3 months", "1 year".
 * A month is thirty days here and a year three hundred and sixty-five — near
 * enough for a sales window, and it keeps "2 months" and "60 days" the same
 * thing, which is how the tier tables are written. Null when the words are
 * not a length of time at all.
 */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(d|days?|w|wks?|weeks?|m|mo|mos|mons?|months?|y|yrs?|years?)?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  // Zero days is read rather than refused, so "5 sales in 0 days" is turned
  // down by the rule that knows what a window is for, naming the number.
  if (!(n >= 0)) return null;
  return Math.round(n * DAYS_IN[(m[2] ?? "d")[0]]);
}

/**
 * How many sales to look at and how far back, from the words for it — either
 * half on its own, or both: "5 sales in 60 days", "5 sales/60d", "5 in 60",
 * "the last 3 months", "2 months", "5 sales".
 *
 * A half that is not named comes back null, and the caller fills it in from
 * the run's own rule: a tier band that says "in 3 months" keeps the run's
 * count, one that says "5 sales" keeps the run's window. Null altogether when
 * the words are neither.
 */
export function parseSalesWindow(text: string): { count: number | null; windowDays: number | null } | null {
  const t = text.trim().toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ")
    .replace(/^(?:the\s+)?(?:last\s+|past\s+|recent\s+)/, "");
  if (!t) return null;
  let m: RegExpExecArray | null;
  // "5 sales in 60 days", "5 in 60", "5 sales/60d" — both halves.
  if ((m = /^(\d+)\s*(?:recent\s*)?(?:sales?)?\s*(?:\/|,)?\s*(?:in|within|inside|over|of|across)?\s*(?:the\s+)?(?:last\s+|past\s+)?(.+)$/.exec(t))) {
    const windowDays = parseDuration(m[2]);
    if (windowDays !== null) return { count: Number(m[1]), windowDays };
  }
  // "3 months", "60 days", "in 2 months" — a window and nothing else.
  const only = parseDuration(t.replace(/^(?:in|within|inside|over)\s+/, ""));
  if (only !== null) return { count: null, windowDays: only };
  // "5 sales" — a count and nothing else.
  if ((m = /^(\d+)\s*(?:recent\s*)?sales?$/.exec(t))) return { count: Number(m[1]), windowDays: null };
  return null;
}

/**
 * The fewest sales a rule will settle for, from the words for it: "min 3",
 * "at least 3", "must have at least 3 sales", "needs 5 sales". Null when the
 * words are not that.
 */
export function parseNeed(text: string): number | null {
  const m = /^(?:min(?:imum)?|at least|needs?|requires?|must have(?: at least)?)\s*(\d+)\s*(?:recent\s*)?(?:sales?)?(?:\s+recorded)?$/i
    .exec(text.trim().replace(/\s+/g, " "));
  return m ? Number(m[1]) : null;
}

/**
 * A sales rule from one line: "5 sales in 60 days", or "5 sales in 60 days,
 * at least 3" when fewer will do. The words are optional either side of the
 * numbers — "5 in 60", "5 sales within the last 60 days", "5 sales/2 months"
 * all read the same — but both numbers have to be there, so a half-typed box
 * is an error rather than a guess.
 */
export function parseSalesRule(text: string): SalesRule {
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  const window = parseSalesWindow(parts.shift() ?? "");
  if (!window || window.count === null || window.windowDays === null) {
    throw new Error(`cannot read the sales rule "${text}": want "<how many> sales in <how long>", e.g. "5 sales in 60 days"`);
  }
  const rule: SalesRule = { count: window.count, windowDays: window.windowDays };
  for (const part of parts) {
    const need = parseNeed(part);
    if (need === null) throw new Error(`cannot read "${part}" in the sales rule "${text}": want "at least 3"`);
    rule.need = need;
  }
  if (!Number.isInteger(rule.count) || rule.count < 1) throw new Error(`"${text}": a sales rule needs at least 1 sale`);
  if (!Number.isInteger(rule.windowDays) || rule.windowDays < 1) throw new Error(`"${text}": a sales rule needs a window of at least 1 day`);
  if (rule.need !== undefined && (rule.need < 1 || rule.need > rule.count)) {
    throw new Error(`"${text}": it cannot need ${rule.need} sales when it only looks at ${rule.count}`);
  }
  return rule;
}

/** A sales rule as one line, the way parseSalesRule() reads it back. */
export function formatSalesRule(rule: SalesRule = activeSalesRule): string {
  const base = `${rule.count} sales in ${rule.windowDays} days`;
  return rule.need !== undefined && rule.need !== rule.count ? `${base}, at least ${rule.need}` : base;
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

// ── The recipe ────────────────────────────────────────────────────────────────

/**
 * A sales rule and a basis rule together — everything it takes to turn a
 * card's sales history into the one price a percentage multiplies.
 *
 * Every field is optional and every one that is left out is the run's own:
 * this is what a tier band overrides, not a whole new set of settings. A band
 * that says nothing prices exactly the way the run does, which is why a table
 * written before any of this existed still means what it always meant.
 *
 * `altValue` is the one thing that is not a sale at all: Card Uploader's own
 * estimate for the cert, which is there whether the card has sold lately or
 * not. A band priced off it ignores the sales and the window with them.
 */
export type PriceRecipe = {
  basis?: BasisRule;
  count?: number;
  windowDays?: number;
  need?: number;
  altValue?: boolean;
};

/** A recipe with the run's own settings filled in where it named none. */
export function resolveRecipe(recipe: PriceRecipe = {}, run: SalesRule = activeSalesRule, runBasis: BasisRule = activeBasis): {
  basis: BasisRule;
  rule: SalesRule & { need: number };
} {
  const count = recipe.count ?? run.count;
  const windowDays = recipe.windowDays ?? run.windowDays;
  // A band that names its own count and no minimum wants all of them; one
  // that names neither keeps whatever the run settles for.
  const asked = recipe.need ?? (recipe.count !== undefined ? count : needSales(run));
  return { basis: recipe.basis ?? runBasis, rule: { count, windowDays, need: Math.min(asked, count) } };
}

/** A recipe as the words a tier band is written with, or "" when it is the run's own. */
export function formatRecipe(recipe: PriceRecipe = {}): string {
  if (recipe.altValue) return " of alt value";
  const parts: string[] = [];
  if (recipe.basis) parts.push(` of ${formatBasis(recipe.basis)}`);
  if (recipe.count !== undefined && recipe.windowDays !== undefined) parts.push(` in ${recipe.count} sales/${recipe.windowDays}d`);
  else if (recipe.windowDays !== undefined) parts.push(` in ${recipe.windowDays} days`);
  else if (recipe.count !== undefined) parts.push(` in ${recipe.count} sales`);
  return parts.join("");
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
 * The sales a rule actually prices from: priced, inside its window, newest
 * first, at most as many as it looks at.
 *
 * Where recentSales() takes the newest few whatever their age and leaves the
 * window to the gate, this throws the old ones out first. The two agree
 * whenever the gate passes — a rule that needs all of its sales inside the
 * window has the same few either way — and differ only for a rule that will
 * settle for fewer, which is the point of it.
 */
export function salesIn(sales: Sale[], rule: SalesRule = activeSalesRule, now = new Date()): Sale[] {
  const cutoff = now.getTime() - rule.windowDays * 86_400_000;
  return [...sales]
    .filter((s) => s.price > 0 && new Date(s.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, rule.count);
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
export function salesGate(sales: Sale[], now = new Date(), rule: SalesRule = activeSalesRule): { ok: boolean; reason?: string; oldestDays: number | null } {
  const want = needSales(rule);
  const newest = recentSales(sales, rule.count);
  if (newest.length === 0) return { ok: false, reason: "no sales history", oldestDays: null };

  const age = (s: Sale) => (now.getTime() - new Date(s.date).getTime()) / 86_400_000;
  const oldestDays = Math.round(Math.max(...newest.map(age)));
  const inWindow = salesIn(sales, rule, now);

  if (inWindow.length < want) {
    if (newest.length < want) return { ok: false, reason: `only ${newest.length} recent sale(s), need ${want}`, oldestDays };
    // A rule that wants all of its sales says so the short way, naming the
    // one that is too old; a rule that would settle for fewer has to say how
    // many it actually found.
    return want === rule.count
      ? { ok: false, reason: `oldest of the last ${want} sales is ${oldestDays}d old, window is ${rule.windowDays}d`, oldestDays }
      : { ok: false, reason: `only ${inWindow.length} of the last ${rule.count} sales are inside ${rule.windowDays}d, need ${want}`, oldestDays };
  }
  return { ok: true, oldestDays: Math.round(Math.max(...inWindow.map(age))) };
}
