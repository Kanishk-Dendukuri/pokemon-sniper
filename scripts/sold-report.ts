/**
 * Sold report — what every sold lot went for, and what the tier table should
 * therefore be.
 *
 * The snipers (scripts/sniper-core.ts) bid a share of a card's second-lowest
 * recent sale, band by band, grader by grader, and this works those shares out. It
 * walks the closed auctions at both houses, keeps the lots the sniper would
 * have priced — the same candidates, block list, graders, grades and
 * sales-history rule — prices each one through Card Uploader exactly as the
 * sniper does, and then, for every band of a FIXED price grid and every
 * share from 50% to 100%, asks what that share would have won, what it would
 * have cost, what those lots would fetch on resale, and therefore what it
 * would have made. The share that made the most is the recommendation, the
 * neighbouring bands that agree are merged, and the answer comes out as a
 * tier line ready to paste into a sniper's box.
 *
 * The price grid is fixed on purpose (PRICE_GRID). The bands used to come
 * from the table being judged, which meant the report could never tell you a
 * boundary was in the wrong place — it could only ever answer inside the
 * bands it was handed. Nothing about the axis depends on the table now.
 *
 * The table is still an input, and does one thing: every band also gets an
 * "as configured" row, worked out per lot from that table, so current and
 * best sit side by side and the sheet says what changing would have gained.
 * It gates nothing: the curve is drawn over every lot that passed the sales
 * rule, whatever the table would have done with it.
 *
 * Three numbers per lot, and the differences matter:
 *   - the bid basis (sniper_market_price): the second-lowest of the card's
 *     five most recent sales, the lot's own sale left out. This is what a
 *     share multiplies, so it is the axis the curve is cut on.
 *   - market value: the same five sales, highest and lowest dropped, the
 *     other three averaged — what the card is worth, and what a price paid
 *     is measured against.
 *   - the resale rate (--resale-psa / --resale-cgc): the share of market
 *     value the card actually sells for, by grader and by what it is worth.
 *     This is what turns a win rate into a profit, and it is the one number
 *     the report cannot work out for itself.
 *
 * Where the numbers come from:
 *   - Fanatics Collect: the same Algolia index the sniper scans keeps every
 *     sold lot with its hammer, the price paid with the premium and the bid
 *     count (scripts/fanatics-sold.ts). Only chase-list lots, as the sniper.
 *   - Alt: a second Typesense collection of sold listings, keyed by the
 *     search config the sniper already fetches; the price there includes the
 *     20% buyer's premium, so the hammer is derived (scripts/alt-sold.ts).
 *     Every PSA/CGC lot, as the Alt sniper.
 *   - Card Uploader: /backend/card-price/cert, free, no credits — the same
 *     call the sniper makes. It answers with a card's five most recent sales
 *     as of today, not as of the auction. For an auction a week or two old
 *     that is close to what the sniper saw; for one months old it is not,
 *     and the report says so in its notes. Neither house needs an account.
 *
 * Nothing is bid, nothing is bought, no credits are spent, nothing is
 * written back anywhere. The one output is a folder per run under
 * sold-report-runs/: sold-report.xlsx (every sheet), the same sheets as CSVs,
 * and summary.md for the Actions run page.
 *
 * Usage:
 *   npm run sold-report                            the last 4 auctions at each house
 *   npm run sold-report -- --fanatics=8 --alt=6    more (fewer are taken when fewer exist)
 *   npm run sold-report -- --alt=0                 one house only
 *   npm run sold-report -- --tiers-psa="$7.50-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%"
 *                                                  the table to compare against (and --tiers-cgc);
 *                                                  the TIERS_PSA / TIERS_CGC environment variables do the same
 *   npm run sold-report -- --resale-psa="$0-100: 90%, $100-500: 85%, $500+: 85%"
 *                                                  what a card of that grade and value resells for, net
 *                                                  (and --resale-cgc, RESALE_PSA, RESALE_CGC)
 *   npm run sold-report -- --min-margin=10         a band has to clear this much profit on its spend to be
 *                                                  bid in at all; it is what sets the floor and the ceiling
 *   npm run sold-report -- --min-wins=5            wins a band needs before it sets its own rule rather than
 *                                                  borrowing its neighbour's
 *   npm run sold-report -- --budget=2000           cut the recommended table to what one run at one house can
 *                                                  pay for, all-in (0: the best table whatever it costs)
 *   npm run sold-report -- --max-cards=50          a quick look: 50 candidates per auction
 *   npm run sold-report -- --concurrency=32        gentler on Card Uploader
 *   npm run sold-report -- --headed                watch it work
 *
 * Required environment (read from .env.local or the real environment):
 *   CARDUPLOADER_EMAIL, CARDUPLOADER_PASSWORD
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { alt } from "./alt-sniper";
import { scanAltSold } from "./alt-sold";
import { loadEnvLocal } from "./carduploader-batch";
import { fanatics } from "./fanatics-sniper";
import { scanFanaticsSold } from "./fanatics-sold";
import type { BidSteps } from "./sniper-book";
import {
  BUYERS_PREMIUM,
  GRADERS,
  DEFAULT_MAX_COPIES_PER_CARD,
  MIN_SALES,
  SALES_WINDOW_DAYS,
  applyRule,
  fmtLocal,
  formatTiers,
  maxBid,
  openCardUploader,
  opt,
  priceByCert,
  recentSales,
  refreshCuToken,
  ruleText,
  salesGate,
  selectCandidates,
  setTierTable,
  tierCeiling,
  tierFloor,
  tierTable,
  tiersFromArgs,
  type BidRule,
  type Candidate,
  type GraderTiers,
  type CuPrice,
  type CuSession,
  type Grader,
  type Sale,
  type ScannedLot,
  type SelectionCounts,
  type TierBand,
  type TierTable,
  type Venue,
  bidBasis,
} from "./sniper-core";
import { writeXlsx, type Cell, type Sheet } from "./xlsx";

// ── Configuration ─────────────────────────────────────────────────────────────

export type VenueKey = "fanatics" | "alt";

/** One sold lot, as a house's closed scan reports it: the live scan's shape, plus what it went for. */
export type SoldLot = ScannedLot & {
  /** Dollars, before the buyer's premium. */
  hammer: number;
  /** Dollars, premium included: what the winner paid. */
  allIn: number;
  closedAtUnixS: number;
  /** The house's own guide value, where it publishes one. Not reported; kept for the record. */
  houseValue: number | null;
  /** False where the house does not publish a bid count. */
  bidCountKnown?: boolean;
};

export type SoldAuction = {
  venue: VenueKey;
  id: string;
  name: string;
  closedAtUnixS: number;
  /** Every sold PSA/CGC 7–10 Pokémon lot. */
  lots: SoldLot[];
};

/** The snipers' own venues: their names, clocks, bid ladders and whether they chase a list. */
const VENUES: Record<VenueKey, Venue> = { fanatics, alt };
const venueKeys: VenueKey[] = ["fanatics", "alt"];

/** Closed auctions looked at per house when the run is not told otherwise. */
const DEFAULT_AUCTIONS = 4;
/** Cert price lookups in flight at once — the sniper's measured setting. */
const PRICE_CONCURRENCY = 96;
/** Certs per pricing pass; Card Uploader's token is renewed between passes. */
const PRICE_CHUNK = 1_000;
/** 0 = every candidate. */
const DEFAULT_MAX_CARDS = 0;

/** The buckets asked for: 50% to 100% in steps of 5, with a floor and a ceiling bucket either side. The share curve tries the same shares. */
export const BUCKET_FROM = 50;
export const BUCKET_TO = 100;
export const BUCKET_STEP = 5;

/**
 * The price axis the curve is cut on, in dollars of the bid basis — fixed,
 * and nothing to do with the table being judged.
 *
 * These are the boundaries a recommended table may be built out of, so the
 * grid has to be finer than any table worth writing: fine enough that a real
 * change of behaviour falls inside one band rather than being averaged
 * across two, coarse enough that a band still holds enough lots to mean
 * something. Adjacent bands that want the same rule are merged afterwards,
 * so a grid that is too fine costs nothing but rows.
 */
export const PRICE_GRID = [6, 8, 10, 15, 25, 40, 60, 90, 150, 250, 400, 600];

/** Bands at or under this are cheap enough that a flat bid or an offset can beat a share, so those are tried there too. */
const CHEAP_BAND_TOP = 10;

/**
 * The shares the recommendation searches, in percent.
 *
 * Wider than the buckets, and deliberately past 100%: a share multiplies the
 * bid basis — the second-lowest of five comps, which sits under market value
 * (the lowest ran about 89% of it) — and the winner pays the runner-up's bid
 * rather than their own max — so 100% of the basis is nothing like paying
 * market value, and the best share in a band is often above it. Searching only to 100% pinned band after band against the
 * ceiling and called it the answer.
 */
export const SHARE_SEARCH_FROM = 50;
export const SHARE_SEARCH_TO = 150;

export function shareSearch(): number[] {
  const out: number[] = [];
  for (let x = SHARE_SEARCH_FROM; x <= SHARE_SEARCH_TO; x += BUCKET_STEP) out.push(x);
  return out;
}

/**
 * Wins a band's own best rule needs before it is believed.
 *
 * A band that won one lot has a rule fitted to one lot: the run over the four
 * auctions to 2026-09-11 recommended "$250-400: 50%" off a single Fanatics
 * CGC lot at a 123% margin, which is not a rule, it is that lot. A band under
 * the bar takes the nearest believed band's rule instead, and the sheet says
 * so.
 */
const DEFAULT_MIN_WINS = 5;

/** The flat bids tried in a cheap band, and the offsets. */
const FLAT_CANDIDATES = [1, 2, 3, 4, 5, 6, 7];
const OFFSET_CANDIDATES = [1, 2, 3, 4, 5];

/**
 * What a card resells for, net, as a share of its market value: by grader,
 * by what the card is worth. The user's own figures, 2026-09-11 — PSA at or
 * under $100 sells for about 90% of market value, PSA $100–500 for 85%, CGC
 * under $100 for 82% and CGC $100–500 for 75% — with the last band carried
 * on above $500, which nothing was said about.
 *
 * This is the one number the report cannot derive. Everything it recommends
 * follows from it, so a run with the wrong rates here recommends the wrong
 * table with total confidence: --resale-psa / --resale-cgc, or RESALE_PSA /
 * RESALE_CGC, override it per grader.
 */
export type ResaleBand = { upTo: number; rate: number };
export type ResaleTable = Record<Grader, ResaleBand[]>;

export const DEFAULT_RESALE: ResaleTable = {
  PSA: [{ upTo: 100, rate: 0.90 }, { upTo: 500, rate: 0.85 }, { upTo: Infinity, rate: 0.85 }],
  CGC: [{ upTo: 100, rate: 0.82 }, { upTo: 500, rate: 0.75 }, { upTo: Infinity, rate: 0.75 }],
};

/**
 * The profit a band has to make on what it spends before it is worth bidding
 * in at all, in percent. It is what sets the recommended floor and ceiling:
 * the bands at either end that cannot clear it are where the table stops.
 */
const DEFAULT_MIN_MARGIN = 10;

/**
 * A sale in Card Ladder's record that is this very lot: dated within this
 * many days of the close and priced within this share of what it went for.
 * Both houses' sales reach Card Ladder with the premium in, so the all-in
 * price is what is matched, with the hammer as a second look.
 */
const OWN_SALE_DAYS = 3;
const OWN_SALE_TOLERANCE = 0.03;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Maths ─────────────────────────────────────────────────────────────────────

/**
 * Market value as the report defines it: drop the highest and the lowest of
 * the sales, average the rest. Five sales in, the middle three averaged.
 */
export function trimmedMean(prices: number[]): number | null {
  if (prices.length < 3) return null;
  const middle = [...prices].sort((a, b) => a - b).slice(1, -1);
  return round2(middle.reduce((a, b) => a + b, 0) / middle.length);
}

/** Percent of `whole` that `part` is, to one decimal. */
export function pctOf(part: number, whole: number | null | undefined): number | "" {
  return whole && whole > 0 ? round1((part / whole) * 100) : "";
}

/**
 * A grader's resale rates from one line: "$0-100: 90%, $100-500: 85%,
 * $500+: 85%". Bands are in dollars of market value, have to touch, and the
 * last one may be open at the top; without one the last rate carries on.
 */
export function parseResale(text: string): ResaleBand[] {
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`a resale table needs at least one band, got "${text}"`);
  const bands: ResaleBand[] = [];
  for (const part of parts) {
    const m = /^\$?\s*([\d.]+)\s*(?:[-–]\s*\$?\s*([\d.]+)|\+)\s*:\s*([\d.]+)\s*%$/.exec(part);
    if (!m) throw new Error(`cannot read the band "${part}": want "<from>-<to>: <rate>%", e.g. "$0-100: 90%", or "$500+: 85%" for the last`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? Infinity : Number(m[2]);
    const rate = Number(m[3]) / 100;
    if (!(to > from)) throw new Error(`the band "${part}" does not run upward`);
    if (!(rate > 0 && rate <= 2)) throw new Error(`"${part}": a resale rate has to be between 0% and 200%`);
    const previous = bands.length > 0 ? bands[bands.length - 1].upTo : 0;
    if (previous !== from) throw new Error(`the band "${part}" starts at $${from} but the one before it ends at $${previous} — bands have to touch`);
    bands.push({ upTo: to, rate });
  }
  if (bands[bands.length - 1].upTo !== Infinity) bands.push({ upTo: Infinity, rate: bands[bands.length - 1].rate });
  return bands;
}

/** A grader's resale rates as one line, the way parseResale() reads them back. */
export function formatResale(bands: ResaleBand[]): string {
  let from = 0;
  return bands.map((b) => {
    const text = `$${from}${b.upTo === Infinity ? "+" : `-${b.upTo}`}: ${Math.round(b.rate * 1000) / 10}%`;
    from = b.upTo;
    return text;
  }).join(", ");
}

/** The rates a run was given: the flag, else the environment variable, else the default. */
export function resaleFromArgs(env: Record<string, string | undefined> = process.env): ResaleTable {
  const table = { ...DEFAULT_RESALE };
  for (const grader of GRADERS) {
    const text = opt(`resale-${grader.toLowerCase()}`, env[`RESALE_${grader}`] ?? "").trim();
    if (!text) continue;
    try {
      table[grader] = parseResale(text);
    } catch (err) {
      throw new Error(`the ${grader} resale rates could not be read: ${err instanceof Error ? err.message : err}`);
    }
  }
  return table;
}

let activeResale: ResaleTable = DEFAULT_RESALE;
export function resaleTable(): ResaleTable { return activeResale; }
export function setResaleTable(table: ResaleTable): void { activeResale = table; }

/** What a card of this grade, worth this much, resells for as a share of that value. */
export function resaleRate(grader: Grader, marketValue: number, table: ResaleTable = resaleTable()): number {
  return (table[grader].find((b) => marketValue < b.upTo) ?? table[grader][table[grader].length - 1]).rate;
}

/** Every bucket label, in order: "<50%", "50-55%" … "95-100%", "100%+". */
export function bucketLabels(): string[] {
  const labels = [`<${BUCKET_FROM}%`];
  for (let lo = BUCKET_FROM; lo < BUCKET_TO; lo += BUCKET_STEP) labels.push(`${lo}-${lo + BUCKET_STEP}%`);
  labels.push(`${BUCKET_TO}%+`);
  return labels;
}

/** Which bucket a percentage falls in: [lo, lo + step), the ends open. */
export function bucketOf(pct: number): string {
  if (pct < BUCKET_FROM) return `<${BUCKET_FROM}%`;
  if (pct >= BUCKET_TO) return `${BUCKET_TO}%+`;
  const lo = Math.floor(pct / BUCKET_STEP) * BUCKET_STEP;
  return `${lo}-${lo + BUCKET_STEP}%`;
}

/** Every share the curve is drawn at, in percent: 50, 55 … 100. */
export function shareGrid(): number[] {
  const out: number[] = [];
  for (let x = BUCKET_FROM; x <= BUCKET_TO; x += BUCKET_STEP) out.push(x);
  return out;
}

/**
 * The most the sniper would send on a lot with a max hammer of this many
 * dollars — Fanatics wants a rung of its ladder, Alt a whole dollar — and
 * whether that beats what the lot went for. Optimistic: the hammer is where
 * the bidding stopped, and the winner's own max may have been higher.
 */
export function couldWin(steps: BidSteps, maxHammerDollars: number, hammerDollars: number): boolean {
  const ours = steps.below(Math.round(maxHammerDollars * 100));
  return ours > 0 && ours > Math.round(hammerDollars * 100);
}

/**
 * Whether the lot's own sale is among the comps. Card Ladder records both
 * houses' sales, so a lot closed last week is often one of its card's five
 * most recent — which the trimmed mean mostly shrugs off (a cheap sale is the
 * low that gets dropped) but is worth knowing about.
 */
export function ownSaleIndex(sales: Sale[], lot: Pick<SoldLot, "hammer" | "allIn" | "closedAtUnixS">): number {
  if (!lot.closedAtUnixS) return -1;
  const near = (a: number, b: number) => b > 0 && Math.abs(a - b) <= b * OWN_SALE_TOLERANCE;
  return sales.findIndex((s) => {
    const days = Math.abs(new Date(s.date).getTime() / 1000 - lot.closedAtUnixS) / 86_400;
    return days <= OWN_SALE_DAYS && (near(s.price, lot.allIn) || near(s.price, lot.hammer));
  });
}

export function ownSaleInComps(sales: Sale[], lot: Pick<SoldLot, "hammer" | "allIn" | "closedAtUnixS">): boolean {
  return ownSaleIndex(sales, lot) >= 0;
}

/** What a run has to own up to when its pricing stopped early. */
export type Partial_ = { reason: string; priced: number; total: number };

export type Stats = { n: number; mean: number; median: number; p10: number; p25: number; p75: number; p90: number; min: number; max: number; stdev: number };

/** Linear interpolation between the two nearest ranks. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return round1(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

export function describe(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  return {
    n: sorted.length, mean: round1(mean), median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1), p25: percentile(sorted, 0.25), p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.9),
    min: sorted[0], max: sorted[sorted.length - 1], stdev: round1(Math.sqrt(variance)),
  };
}

/** The dollars in the middle of a group, or blank when there are none. */
function medianOf(values: number[]): number | "" {
  return describe(values.filter((v) => v > 0))?.median ?? "";
}

// ── The table's bands ─────────────────────────────────────────────────────────

/** One band of the price grid the curve is drawn over, in dollars of the bid basis. */
export type Band = {
  label: string;
  from: number;
  /** Infinity on the top band. `from` is exclusive there, inclusive elsewhere; the top of a band is always exclusive. */
  to: number;
};

/** The fixed price grid, as bands: "<$6", "$6-8" … "$400-600", "$600+". */
export function gridBands(grid: number[] = PRICE_GRID): Band[] {
  const out: Band[] = [{ label: `<$${grid[0]}`, from: 0, to: grid[0] }];
  for (let i = 1; i < grid.length; i++) out.push({ label: `$${grid[i - 1]}-${grid[i]}`, from: grid[i - 1], to: grid[i] });
  out.push({ label: `$${grid[grid.length - 1]}+`, from: grid[grid.length - 1], to: Infinity });
  return out;
}

export function inBand(band: Band, price: number): boolean {
  const aboveFrom = band.to === Infinity ? price > band.from : price >= band.from;
  return aboveFrom && price < band.to;
}

/** The label of the grid band a bid basis falls in. */
export function gridBandLabel(price: number, grid: number[] = PRICE_GRID): string {
  return gridBands(grid).find((b) => inBand(b, price))?.label ?? "";
}

/** The label of the band of a tier table a bid basis falls in — what the sniper branched on, for the record. */
export function tierBandLabel(grader: Grader, price: number, table: TierTable = tierTable()): string {
  const { floor, bands } = table[grader];
  if (price < floor) return `<$${floor}`;
  let from = floor;
  for (const [i, band] of bands.entries()) {
    const last = i === bands.length - 1;
    if (last ? price <= band.upTo : price < band.upTo) return `$${from}-${band.upTo}`;
    from = band.upTo;
  }
  return `$${from}+`;
}

function ruleValue(rule: BidRule): number {
  return rule.kind === "flat" ? rule.hammer : rule.kind === "offset" ? rule.less : rule.share;
}

/** Two rules that bid the same thing, so two bands carrying them can be merged into one. */
export function sameRule(a: BidRule, b: BidRule): boolean {
  return a.kind === b.kind && Math.abs(ruleValue(a) - ruleValue(b)) < 1e-9;
}

/**
 * The rules tried in a band: every share on the grid, plus flat $1–7 and
 * market − $1–5 in a band cheap enough for those to beat a share (on a $7
 * card a flat $5 hammer is 86% all-in, which no share on the grid lands on).
 */
export function candidateRules(band: Band): BidRule[] {
  const rules: BidRule[] = shareSearch().map((pct) => ({ kind: "share", share: pct / 100 }));
  if (band.to <= CHEAP_BAND_TOP) {
    rules.push(...FLAT_CANDIDATES.map((hammer): BidRule => ({ kind: "flat", hammer })));
    rules.push(...OFFSET_CANDIDATES.map((less): BidRule => ({ kind: "offset", less })));
  }
  return rules;
}

// ── Playwright's TLS crash ────────────────────────────────────────────────────

/**
 * Whether this is the Playwright bug that killed a run of 66,000 certs at
 * 20,000 on 2026-09-10.
 *
 * Its HTTP client reads the peer certificate off a reused keep-alive socket
 * without checking that there is one:
 *
 *     const peerCertificate = socket.getPeerCertificate();
 *     subjectName: commonName(peerCertificate.subject?.CN),
 *
 * The optional chaining is on the field, not on the certificate, so a socket
 * that answers null throws a TypeError — inside a "socket" event handler,
 * where no await can catch it, so Node takes the whole process down. It is
 * still unguarded in 1.63, so there is no version to upgrade to. Nothing but
 * the timing of a socket being reused decides when it happens, which is to
 * say: the more certs a run prices, the likelier it is.
 *
 * Losing the request is harmless here — the pricing loop already retries what
 * does not answer — so the run swallows this one error and carries on.
 */
export function isPlaywrightTlsCrash(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const at = err.stack ?? "";
  if (!/captureSecurityDetails/.test(at) && !/playwright-core/.test(at)) return false;
  return /Cannot read propert(?:y|ies) of null/.test(err.message)
    && /'(?:subject|issuer|valid_from|valid_to)'/.test(err.message);
}

/**
 * Keeps that one crash from ending the run, and counts what it swallowed.
 * Anything else is rethrown, which ends the process exactly as it would have.
 */
export function guardPlaywrightTlsCrash(): { swallowed: () => number; release: () => void } {
  let swallowed = 0;
  const onUncaught = (err: unknown) => {
    if (!isPlaywrightTlsCrash(err)) throw err;
    swallowed++;
    if (swallowed === 1) {
      console.warn(`    ⚠️  Playwright threw on a reused socket with no peer certificate — a known bug in its HTTP client, still there in 1.63. The request is lost and retried; the run carries on.`);
    }
  };
  process.on("uncaughtException", onUncaught);
  return {
    swallowed: () => swallowed,
    release: () => { process.off("uncaughtException", onUncaught); },
  };
}

// ── One lot, evaluated ────────────────────────────────────────────────────────

export type LotRow = {
  venue: string;
  auction: string;
  closed: string;
  lot: string;
  title: string;
  grader: string;
  grade: string;
  language: string;
  cert: string;
  keywords: string;
  hammer: number;
  all_in: number;
  bid_count: number | "";
  /** The raw lowest of the five comps, the lot's own sale included when it is there. */
  market_low: number | "";
  /** The report's market value: the five most recent sales, highest and lowest dropped, the rest averaged. */
  market_value: number | "";
  market_high: number | "";
  sales_used: number;
  oldest_sale_days: number | "";
  own_sale_in_comps: string;
  hammer_pct: number | "";
  /** Paid all-in as a share of market value: the figure the buckets count. */
  all_in_pct: number | "";
  bucket: string;
  /** What the sniper's bid is worked from: the second-lowest comp, the lot's own sale left out. */
  sniper_market_price: number | "";
  /** The bid basis as a share of market value: how far under the middle the table's base sits. */
  low_pct_of_value: number | "";
  /** The band of the fixed price grid the bid basis falls in — the axis the curve is cut on. */
  grid_band: string;
  /** The band of the table this run was given that the bid basis falls in — what the sniper branched on. */
  tier_band: string;
  tier_rule: string;
  sniper_max_hammer: number | "";
  sniper_max_all_in: number | "";
  /** The sniper's max, as a share of market value. */
  sniper_max_pct: number | "";
  sniper_could_win: string;
  /** What a card of this grade and value resells for, as a share of that value — the rate the run was given. */
  resale_rate_pct: number | "";
  /** What it would fetch: market value × that rate. */
  resells_for: number | "";
  /** What the winner made on it, had they paid what was paid: resells_for − all_in. */
  winner_profit: number | "";
  url: string;
  status: string;

  /** Not written: what the sheets read. */
  /** Passed the sales rule with both prices known — the set the share curve is drawn over, the table's own bands or not. */
  priceable: boolean;
  /** Priceable and inside the table: the sniper would have bid. */
  eligible: boolean;
  venueKey: VenueKey;
  auctionId: string;
  priority: number;
};

export const LOT_COLUMNS: (keyof LotRow)[] = [
  "venue", "auction", "closed", "lot", "title", "grader", "grade", "language", "cert", "keywords",
  "hammer", "all_in", "bid_count",
  "market_low", "market_value", "market_high", "sales_used", "oldest_sale_days", "own_sale_in_comps",
  "hammer_pct", "all_in_pct", "bucket",
  "sniper_market_price", "low_pct_of_value", "grid_band", "tier_band", "tier_rule", "sniper_max_hammer", "sniper_max_all_in", "sniper_max_pct", "sniper_could_win",
  "resale_rate_pct", "resells_for", "winner_profit",
  "url", "status",
];

/** Reasons with their numbers taken out, so the funnel can count them. */
export function generalise(reason: string): string {
  return reason
    .replace(/\$[\d.,]+/g, "$…")
    .replace(/\b\d+d\b/g, "Nd")
    .replace(/only \d+/g, "only N")
    .replace(/last \d+/g, "last N")
    .replace(/HTTP \d{3}.*$/, "HTTP error")
    .replace(/Timeout.*$/i, "timed out");
}

export function evaluateSold(auction: SoldAuction, lot: SoldLot, candidate: Candidate, price: CuPrice | undefined, now: Date): LotRow {
  const venue = VENUES[auction.venue];
  const row: LotRow = {
    venue: venue.name,
    auction: auction.name,
    closed: auction.closedAtUnixS ? fmtLocal(auction.closedAtUnixS, venue.timeZone, venue.zoneLabel) : "",
    lot: lot.lot,
    title: lot.title,
    grader: candidate.grader,
    grade: lot.grade !== undefined ? `${lot.grade}${lot.pristine ? " Pristine" : ""}` : "",
    language: lot.language,
    cert: candidate.cert,
    keywords: candidate.keywords.join(", "),
    hammer: lot.hammer,
    all_in: lot.allIn,
    bid_count: lot.bidCountKnown === false ? "" : lot.bidCount,
    market_low: "", market_value: "", market_high: "",
    sales_used: 0, oldest_sale_days: "", own_sale_in_comps: "",
    hammer_pct: "", all_in_pct: "", bucket: "",
    sniper_market_price: "", low_pct_of_value: "", grid_band: "", tier_band: "", tier_rule: "",
    sniper_max_hammer: "", sniper_max_all_in: "", sniper_max_pct: "", sniper_could_win: "",
    resale_rate_pct: "", resells_for: "", winner_profit: "",
    url: lot.url,
    status: "",
    priceable: false,
    eligible: false,
    venueKey: auction.venue,
    auctionId: auction.id,
    priority: 0,
  };

  if (!price) { row.status = "not priced"; return row; }
  if (price.error) { row.status = `never answered: ${price.error}`; return row; }
  if (!price.card && !price.info) { row.status = "cert did not resolve"; return row; }

  // The comps, written down whether or not the lot passes, so a near miss
  // can be read off the sheet.
  const used = recentSales(price.sales);
  row.sales_used = used.length;
  if (used.length > 0) {
    const prices = used.map((s) => s.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const value = used.length >= MIN_SALES ? trimmedMean(prices) : null;
    row.market_low = low;
    row.market_high = high;
    row.oldest_sale_days = Math.round(Math.max(...used.map((s) => (now.getTime() - new Date(s.date).getTime()) / 86_400_000)));
    const own = ownSaleIndex(used, lot);
    row.own_sale_in_comps = own >= 0 ? "yes" : "no";
    // The sniper never saw this lot's own sale — it was pricing hours before
    // the close — so its bid is worked from the comps without it. A cheap
    // sale of this very lot would otherwise sit among the lowest of the five,
    // and the tier table would be measured against the lot's own price.
    const others = prices.filter((_, i) => i !== own);
    row.sniper_market_price = bidBasis(others) ?? "";
    if (value !== null) {
      row.market_value = value;
      row.hammer_pct = pctOf(lot.hammer, value);
      row.all_in_pct = pctOf(lot.allIn, value);
      row.bucket = row.all_in_pct === "" ? "" : bucketOf(row.all_in_pct);
      if (row.sniper_market_price !== "") row.low_pct_of_value = pctOf(row.sniper_market_price, value);
      const rate = resaleRate(candidate.grader, value);
      row.resale_rate_pct = round1(rate * 100);
      row.resells_for = round2(value * rate);
      row.winner_profit = round2(value * rate - lot.allIn);
    }
  }

  const gate = salesGate(price.sales, now);
  if (!gate.ok) { row.status = gate.reason ?? "sales gate"; return row; }
  if (row.sniper_market_price === "" || row.market_value === "") { row.status = "no priced sales"; return row; }
  row.priceable = true;
  row.grid_band = gridBandLabel(row.sniper_market_price);
  row.tier_band = tierBandLabel(candidate.grader, row.sniper_market_price);

  // The sniper's own bid on this lot, from the tier table off the bid basis.
  const bid = maxBid(candidate.grader, row.sniper_market_price);
  if (!bid) {
    row.status = row.sniper_market_price < tierFloor(candidate.grader)
      ? `market price $${row.sniper_market_price} is under the $${tierFloor(candidate.grader)} ${candidate.grader} floor`
      : `market price $${row.sniper_market_price} is above the $${tierCeiling(candidate.grader)} ${candidate.grader} tier ceiling`;
    return row;
  }
  row.tier_rule = bid.rule;
  row.sniper_max_hammer = bid.hammer;
  row.sniper_max_all_in = bid.allIn;
  row.sniper_max_pct = pctOf(bid.allIn, row.market_value);
  row.sniper_could_win = couldWin(venue.steps, bid.hammer, lot.hammer) ? "yes" : "no";
  row.status = "eligible";
  row.eligible = true;
  return row;
}

/** Whether this rule, on this lot's bid basis, would have sent a bid that beat the hammer — at the lot's own house's ladder. */
export function wonBy(row: LotRow, rule: BidRule): boolean {
  if (row.sniper_market_price === "") return false;
  const bid = applyRule(rule, Number(row.sniper_market_price));
  return bid !== null && couldWin(VENUES[row.venueKey].steps, bid.hammer, row.hammer);
}

// ── The sheets ────────────────────────────────────────────────────────────────

function pcts(rows: LotRow[]): number[] {
  return rows.map((r) => r.all_in_pct).filter((p): p is number => typeof p === "number");
}

export type Group = { label: string; rows: LotRow[] };

/**
 * The columns every headline table is cut into: everything, then each grader,
 * then each house.
 *
 * The grader split is the one that sets the tier table, which has a band of
 * its own for PSA and for CGC — a CGC 9 and a PSA 9 are not the same card to
 * the room bidding on them, and one number over both hides it. The houses are
 * split for the same reason, and because each sniper is given its own table.
 */
export function headlineGroups(eligible: LotRow[]): Group[] {
  return [
    { label: "all", rows: eligible },
    ...GRADERS.map((g) => ({ label: String(g), rows: eligible.filter((r) => r.grader === g) })),
    ...venueKeys.map((v) => ({ label: String(v), rows: eligible.filter((r) => r.venueKey === v) })),
  ];
}

/** One set of lots cut by grader, the whole set first. */
export function graderCuts(rows: LotRow[]): Group[] {
  return [
    { label: "all", rows },
    ...GRADERS.map((g) => ({ label: String(g), rows: rows.filter((r) => r.grader === g) })),
  ];
}

/**
 * The same cut, as rows rather than columns: a grader with nothing in this
 * set is left out, and a set with only one grader in it gets the "all" row
 * alone — the grader rows would be copies of it.
 */
export function graderRows(rows: LotRow[]): Group[] {
  const cuts = graderCuts(rows).filter((c) => c.label === "all" || c.rows.length > 0);
  return cuts.length > 2 ? cuts : [cuts[0]];
}

/** The indices of the named columns of `header`, for a narrower rendering. */
export function columnsNamed(header: Cell[], names: string[]): number[] {
  return names.map((name) => {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`no column called "${name}"`);
    return at;
  });
}

/**
 * Which columns of a headline table a narrower rendering keeps: the label,
 * then `wanted` — offsets inside one group's block — for every group. The
 * workbook gets every column; the run summary is a page someone reads.
 */
export function groupColumns(groups: number, width: number, wanted: number[]): number[] {
  const columns = [0];
  for (let i = 0; i < groups; i++) for (const w of wanted) columns.push(1 + i * width + w);
  return columns;
}

/**
 * What one rule did to one band: what it won, what that cost, and — given
 * the resale rates — what it made.
 *
 * Profit is the whole point. A win rate on its own says nothing: 100% of
 * market value wins almost everything and loses money on all of it, and 50%
 * wins a handful at a fat margin. What decides a share is how many dollars
 * come out the other side, which needs the price paid and the price the card
 * resells at, and the second of those is the one figure the report has to be
 * told (DEFAULT_RESALE).
 *
 * `margin` is on the spend, not on the value: profit ÷ what was paid, which
 * is the return on the money the band ties up and so the number to compare
 * across bands of different sizes.
 */
export type Outcome = {
  won: number;
  winRate: number;
  paid: number;
  value: number;
  resale: number;
  profit: number;
  margin: number | "";
  profitPerLot: number | "";
};

export function outcomeOf(rows: LotRow[], won: LotRow[], resale: ResaleTable = resaleTable()): Outcome {
  const paid = won.reduce((a, r) => a + r.all_in, 0);
  const value = won.reduce((a, r) => a + Number(r.market_value || 0), 0);
  const gross = won.reduce((a, r) => a + Number(r.market_value || 0) * resaleRate(r.grader as Grader, Number(r.market_value || 0), resale), 0);
  return {
    won: won.length,
    winRate: rows.length ? round1((won.length / rows.length) * 100) : 0,
    paid: round2(paid),
    value: round2(value),
    resale: round2(gross),
    profit: round2(gross - paid),
    margin: paid > 0 ? round1(((gross - paid) / paid) * 100) : "",
    profitPerLot: won.length > 0 ? round2((gross - paid) / won.length) : "",
  };
}

/** Every lot in a band whose bid, under this rule, would have beaten the hammer. */
function winners(rows: LotRow[], rule: BidRule): LotRow[] {
  return rows.filter((r) => wonBy(r, rule));
}

/** The lots the table as configured would have taken — each lot's own verdict, whatever band it fell in. */
function configuredWinners(rows: LotRow[]): LotRow[] {
  return rows.filter((r) => r.sniper_could_win === "yes");
}

/**
 * One band's answer: every rule tried, and which of them made the most.
 *
 * The best is by profit outright rather than by margin. Margin picks the
 * stingiest rule that ever wins anything — one lot at 50% shows a huge
 * return on a tiny spend — and a table built that way bids on nothing. The
 * margin bar is applied at the ends instead, where it decides the floor and
 * the ceiling; see recommendTable.
 */
export type BandAnswer = {
  band: Band;
  rows: LotRow[];
  tried: { rule: BidRule; outcome: Outcome }[];
  best: { rule: BidRule; outcome: Outcome } | null;
  configured: Outcome;
};

export function answerFor(band: Band, rows: LotRow[], resale: ResaleTable = resaleTable()): BandAnswer {
  const tried = candidateRules(band).map((rule) => ({ rule, outcome: outcomeOf(rows, winners(rows, rule), resale) }));
  const profitable = tried.filter((t) => t.outcome.won > 0);
  // Ties go to the cheaper rule: the same profit for less money down is the
  // same profit with the budget freed sooner, which is the whole game for a
  // run that recycles its budget all evening.
  const best = profitable.length > 0
    ? profitable.reduce((a, b) => (b.outcome.profit > a.outcome.profit || (b.outcome.profit === a.outcome.profit && b.outcome.paid < a.outcome.paid) ? b : a))
    : null;
  return { band, rows, tried, best, configured: outcomeOf(rows, configuredWinners(rows), resale) };
}

/** Every band of the grid for one grader at one house, in price order, the empty ones left out. */
export function answersFor(rows: LotRow[], grader: Grader, resale: ResaleTable = resaleTable()): BandAnswer[] {
  const ofGrader = rows.filter((r) => r.grader === grader);
  return gridBands()
    .map((band) => ({ band, rows: ofGrader.filter((r) => inBand(band, Number(r.sniper_market_price))) }))
    .filter((b) => b.rows.length > 0)
    .map((b) => answerFor(b.band, b.rows, resale));
}

export const CURVE_COLUMNS: string[] = [
  "venue", "grader", "band", "lots", "median bid basis $", "median market value $", "resale rate %",
  "rule", "could win", "win rate %", "paid all-in $", "market value won $", "resells for $", "profit $", "margin % of spend", "profit per lot $", "best",
];

export function shareCurveSheet(priceable: LotRow[], resale: ResaleTable = resaleTable()): Cell[][] {
  const out: Cell[][] = [CURVE_COLUMNS];
  const present = venueKeys.filter((v) => priceable.some((r) => r.venueKey === v));
  const cuts: Group[] = [
    ...(present.length > 1 ? [{ label: "both houses", rows: priceable }] : []),
    ...present.map((v) => ({ label: VENUES[v].name, rows: priceable.filter((r) => r.venueKey === v) })),
  ];
  for (const cut of cuts) {
    for (const grader of GRADERS) {
      for (const answer of answersFor(cut.rows, grader, resale)) {
        const values = answer.rows.map((r) => Number(r.market_value || 0));
        const head: Cell[] = [
          cut.label, grader, answer.band.label, answer.rows.length,
          medianOf(answer.rows.map((r) => Number(r.sniper_market_price))),
          medianOf(values),
          round1(resaleRate(grader, Number(medianOf(values)) || 0, resale) * 100),
        ];
        const line = (label: string, o: Outcome, best: boolean): Cell[] =>
          [...head, label, o.won, o.winRate, o.paid, o.value, o.resale, o.profit, o.margin, o.profitPerLot, best ? "yes" : ""];
        out.push(line("as configured", answer.configured, false));
        for (const t of answer.tried) out.push(line(ruleText(t.rule), t.outcome, t === answer.best));
      }
    }
  }
  return out;
}

// ── The recommendation ────────────────────────────────────────────────────────

/**
 * The table the numbers point to, for one house and one grader.
 *
 * Every band of the grid picks the rule that made it the most money. Then
 * the ends are trimmed: a band that could not clear `minMargin` on its spend
 * is not worth the capital, so the floor rises past the cheap bands that
 * fail and the ceiling drops below the dear ones that do — which is how the
 * two boundaries the table needs and no share can express get set. Interior
 * bands keep their best rule whatever their margin: a table's bands have to
 * touch, and a hole in the middle cannot be written down.
 *
 * Neighbours that want the same rule are then merged, so the line that comes
 * out is as short as the data allows rather than one band per grid step.
 */
export type Recommendation = {
  venue: VenueKey;
  grader: Grader;
  /** Null when no band anywhere cleared the bar — nothing here is worth bidding on. */
  tiers: GraderTiers | null;
  /** The bands the line is made of, in order, with what each is expected to do. */
  parts: { label: string; rule: BidRule; lots: number; outcome: Outcome; borrowed: string | null }[];
  /** Bands dropped off the ends, and why. */
  trimmed: { label: string; why: string }[];
  /** What the whole line would have done, against what the configured table would have. */
  total: { best: Outcome; configured: Outcome };
};

export type RecommendOpts = {
  minMargin?: number;
  minWins?: number;
  resale?: ResaleTable;
  /**
   * What one run may commit at this house, all-in. Without it every band
   * takes the rule that made the most money, which is the right answer to
   * "what is the best table" and the wrong one to "what is the best table I
   * can afford": the unconstrained answer over the four auctions to
   * 2026-09-11 spends $32,000 an auction at Fanatics.
   */
  budget?: number;
  /** Auctions the lots came from, so a total spend can be read as a spend per auction. */
  auctions?: number;
};

export function recommendTable(priceable: LotRow[], venue: VenueKey, grader: Grader, opts: RecommendOpts = {}): Recommendation {
  const minMargin = opts.minMargin ?? DEFAULT_MIN_MARGIN;
  const minWins = opts.minWins ?? DEFAULT_MIN_WINS;
  const resale = opts.resale ?? resaleTable();
  const rows = priceable.filter((r) => r.venueKey === venue);
  const ofGrader = rows.filter((r) => r.grader === grader);
  const answers = answersFor(rows, grader, resale);
  const total = {
    best: outcomeOf([], [], resale),
    configured: outcomeOf(ofGrader, configuredWinners(ofGrader), resale),
  };

  // A band whose best rule rests on a handful of wins is a rule fitted to a
  // handful of lots. Only the believed ones may end the table or set a rule;
  // the rest take the nearest believed band's, which is the assumption a
  // person would make anyway.
  const believed = (a: BandAnswer) => a.best !== null && a.best.outcome.won >= minWins;
  const clears = (a: BandAnswer) => believed(a) && a.best!.outcome.margin !== "" && Number(a.best!.outcome.margin) >= minMargin;
  const why = (a: BandAnswer) =>
    a.best === null ? "nothing here could be won at any share"
      : a.best.outcome.won < minWins ? `only ${a.best.outcome.won} win(s), fewer than the ${minWins} a band needs to set its own rule`
        : `best margin ${a.best.outcome.margin}% is under ${minMargin}%`;

  // Trim the ends, not the middle: a table's bands have to touch, so a hole
  // in the middle cannot be written down, but the two ends are exactly the
  // floor and the ceiling.
  let lo = 0;
  let hi = answers.length - 1;
  const head: { label: string; why: string }[] = [];
  const tail: { label: string; why: string }[] = [];
  while (lo <= hi && !clears(answers[lo])) {
    head.push({ label: answers[lo].band.label, why: why(answers[lo]) });
    lo++;
  }
  while (hi > lo && !clears(answers[hi])) {
    tail.unshift({ label: answers[hi].band.label, why: why(answers[hi]) });
    hi--;
  }
  const trimmed = [...head, ...tail];
  const kept = answers.slice(lo, hi + 1);
  if (kept.length === 0) return { venue, grader, tiers: null, parts: [], trimmed, total };

  // Every kept band's rule: its own where it is believed, else the nearest
  // believed band's — below for preference, since a dearer band bidding a
  // cheaper band's share errs toward paying less.
  const trustedAt = kept.map(believed);
  const ruleAt = kept.map((a, i) => {
    if (trustedAt[i]) return { rule: a.best!.rule, borrowed: null as string | null };
    for (let d = 1; d < kept.length; d++) {
      if (i - d >= 0 && trustedAt[i - d]) return { rule: kept[i - d].best!.rule, borrowed: kept[i - d].band.label };
      if (i + d < kept.length && trustedAt[i + d]) return { rule: kept[i + d].best!.rule, borrowed: kept[i + d].band.label };
    }
    return { rule: a.best!.rule, borrowed: null };
  });

  const parts = kept.map((a, i) => ({
    label: a.band.label, rule: ruleAt[i].rule, lots: a.rows.length,
    outcome: outcomeOf(a.rows, winners(a.rows, ruleAt[i].rule), resale),
    borrowed: ruleAt[i].borrowed,
  }));
  total.best = outcomeOf(kept.flatMap((a) => a.rows), kept.flatMap((a, i) => winners(a.rows, ruleAt[i].rule)), resale);

  // Merge the neighbours that agree, then write it as a table.
  const bands: TierBand[] = [];
  for (const [i, a] of kept.entries()) {
    const previous = bands[bands.length - 1];
    if (previous && sameRule(previous.rule, ruleAt[i].rule)) previous.upTo = a.band.to;
    else bands.push({ upTo: a.band.to, rule: ruleAt[i].rule });
  }
  // The top band is open on the grid; a table has to stop somewhere, so it
  // stops at the dearest lot the band actually held.
  const last = bands[bands.length - 1];
  if (!Number.isFinite(last.upTo)) {
    last.upTo = Math.ceil(Math.max(...kept[kept.length - 1].rows.map((r) => Number(r.sniper_market_price))));
  }
  return { venue, grader, tiers: { floor: kept[0].band.from, bands }, parts, trimmed, total };
}

/**
 * The same bands, but only as much of them as a budget can pay for.
 *
 * A run holds one budget across both graders, so the choice is not "the best
 * rule for this band" but "the best rule for every band at this house, given
 * that together they have to fit". That is a multiple-choice knapsack: one
 * rule picked per band, spend summed, profit maximised. Solved exactly by
 * the obvious table over whole dollars of budget, which at a few thousand
 * dollars and a couple of dozen bands is a moment's work.
 *
 * Spend and profit are divided by the number of auctions first, so the
 * budget compared against is what one evening commits rather than what four
 * of them did. What it does NOT model is the budget coming back: 97% of bids
 * are outbid and hand their share straight back, so one evening turns a
 * budget over many times and the real ceiling is higher than this. Read it
 * as the cautious end.
 */
function allocate(
  items: { choices: { spend: number; profit: number }[] }[],
  budget: number,
): number[] {
  const B = Math.max(0, Math.round(budget));
  const NONE = -1;
  let dp = new Float64Array(B + 1).fill(-Infinity);
  dp[0] = 0;
  const taken: Int16Array[] = [];

  for (const item of items) {
    const next = new Float64Array(B + 1).fill(-Infinity);
    const pick = new Int16Array(B + 1).fill(NONE);
    for (let j = 0; j <= B; j++) {
      if (dp[j] === -Infinity) continue;
      for (const [c, choice] of item.choices.entries()) {
        const cost = Math.ceil(choice.spend);
        const at = j + cost;
        if (at > B) continue;
        const value = dp[j] + choice.profit;
        if (value > next[at]) { next[at] = value; pick[at] = c; }
      }
    }
    taken.push(pick);
    dp = next;
  }

  let end = 0;
  for (let j = 1; j <= B; j++) if (dp[j] > dp[end]) end = j;
  const out: number[] = new Array(items.length).fill(0);
  for (let i = items.length - 1; i >= 0; i--) {
    const c = taken[i][end];
    if (c === NONE) break;
    out[i] = c;
    end -= Math.ceil(items[i].choices[c].spend);
  }
  return out;
}

/**
 * One house's tables, both graders, under one budget.
 *
 * The bands are the unconstrained ones — same grid, same margin bar at the
 * ends, same rule about a band with too few wins — and then the budget
 * chooses among the rules each band offers. A band the budget would rather
 * not spend on takes the cheapest share searched, which wins next to nothing:
 * a table's bands have to touch, so "skip this band" has to be spelt as a
 * share that does not win rather than left out.
 */
export function recommendUnderBudget(priceable: LotRow[], venue: VenueKey, opts: RecommendOpts): Recommendation[] {
  const budget = opts.budget ?? Infinity;
  const auctions = Math.max(1, opts.auctions ?? 1);
  const resale = opts.resale ?? resaleTable();
  const graders = GRADERS.filter((g) => priceable.some((r) => r.venueKey === venue && r.grader === g));
  // The unconstrained answer first: it fixes the floor, the ceiling and which
  // bands are believed, none of which the budget has any business moving.
  const free = graders.map((grader) => recommendTable(priceable, venue, grader, opts));

  const rows = priceable.filter((r) => r.venueKey === venue);
  const items: { grader: Grader; at: number; band: Band; rows: LotRow[]; rules: { rule: BidRule; outcome: Outcome }[] }[] = [];
  for (const [g, grader] of graders.entries()) {
    const answers = answersFor(rows, grader, resale);
    for (const [i, part] of free[g].parts.entries()) {
      const answer = answers.find((a) => a.band.label === part.label)!;
      // Only the rules at or under the unconstrained choice: the budget is a
      // reason to bid less, never a reason to bid more than the band's best.
      const ceiling = ruleValue(part.rule);
      const rules = answer.tried.filter((t) => t.rule.kind === part.rule.kind && ruleValue(t.rule) <= ceiling + 1e-9);
      items.push({ grader, at: i, band: answer.band, rows: answer.rows, rules: rules.length > 0 ? rules : [{ rule: part.rule, outcome: part.outcome }] });
    }
  }

  const choices = items.map((it) => ({ choices: it.rules.map((r) => ({ spend: r.outcome.paid / auctions, profit: r.outcome.profit / auctions })) }));
  // What the unconstrained table would spend in an auction. A budget at or
  // above it binds on nothing, and the table above it cannot be spent, so
  // that is where the search stops however much money is offered.
  const wanted = Math.ceil(choices.reduce((a, it) => a + Math.max(...it.choices.map((c) => c.spend)), 0));
  if (!(budget < wanted)) return free;
  const chosen = allocate(choices, budget);

  return graders.map((grader, g) => {
    const mine = items.map((it, i) => ({ it, rule: it.rules[chosen[i]] })).filter((x) => x.it.grader === grader);
    const parts = mine.map((x) => ({
      label: x.it.band.label, rule: x.rule.rule, lots: x.it.rows.length,
      outcome: x.rule.outcome, borrowed: free[g].parts[x.it.at].borrowed,
    }));
    const bands: TierBand[] = [];
    for (const x of mine) {
      const previous = bands[bands.length - 1];
      if (previous && sameRule(previous.rule, x.rule.rule)) previous.upTo = x.it.band.to;
      else bands.push({ upTo: x.it.band.to, rule: x.rule.rule });
    }
    const last = bands[bands.length - 1];
    if (last && !Number.isFinite(last.upTo)) {
      last.upTo = Math.ceil(Math.max(...mine[mine.length - 1].it.rows.map((r) => Number(r.sniper_market_price))));
    }
    return {
      ...free[g],
      tiers: bands.length > 0 ? { floor: mine[0].it.band.from, bands } : null,
      parts,
      total: {
        best: outcomeOf(mine.flatMap((x) => x.it.rows), mine.flatMap((x) => winners(x.it.rows, x.rule.rule)), resale),
        configured: free[g].total.configured,
      },
    };
  });
}

export function recommendations(priceable: LotRow[], opts: RecommendOpts = {}): Recommendation[] {
  return venueKeys
    .filter((v) => priceable.some((r) => r.venueKey === v))
    .flatMap((venue) => (opts.budget === undefined
      ? GRADERS
        .filter((grader) => priceable.some((r) => r.venueKey === venue && r.grader === grader))
        .map((grader) => recommendTable(priceable, venue, grader, opts))
      : recommendUnderBudget(priceable, venue, opts)));
}

export const RECOMMENDED_COLUMNS: string[] = [
  "venue", "grader", "band", "rule", "lots in band", "could win", "win rate %", "paid all-in $", "resells for $", "profit $", "margin % of spend", "note",
];

/** A row per band of every recommended line, then the line itself, then what it beats. */
export function recommendedSheet(recs: Recommendation[]): Cell[][] {
  const out: Cell[][] = [RECOMMENDED_COLUMNS];
  for (const rec of recs) {
    for (const p of rec.parts) {
      out.push([VENUES[rec.venue].name, rec.grader, p.label, ruleText(p.rule), p.lots, p.outcome.won, p.outcome.winRate, p.outcome.paid, p.outcome.resale, p.outcome.profit, p.outcome.margin,
        p.borrowed ? `too few wins of its own — takes ${p.borrowed}'s rule` : ""]);
    }
    for (const t of rec.trimmed) out.push([VENUES[rec.venue].name, rec.grader, t.label, "not bid", "", "", "", "", "", "", "", t.why]);
    const line = rec.tiers ? formatTiers(rec.tiers) : "nothing here clears the bar";
    out.push([VENUES[rec.venue].name, rec.grader, "→ the line to paste", line, "", rec.total.best.won, "", rec.total.best.paid, rec.total.best.resale, rec.total.best.profit, rec.total.best.margin, ""]);
    out.push([VENUES[rec.venue].name, rec.grader, "   against the table this run was given", formatTiers(tierTable()[rec.grader]), "", rec.total.configured.won, "", rec.total.configured.paid, rec.total.configured.resale, rec.total.configured.profit, rec.total.configured.margin, ""]);
  }
  return out;
}

export function bucketSheet(eligible: LotRow[]): Cell[][] {
  const header: Cell[] = ["bucket (all-in % of market value)"];
  const groups = headlineGroups(eligible);
  for (const g of groups) header.push(`${g.label} lots`, `${g.label} share %`, `${g.label} at or under %`);

  const out: Cell[][] = [header];
  const running = groups.map(() => 0);
  for (const label of bucketLabels()) {
    const line: Cell[] = [label];
    groups.forEach((g, i) => {
      const n = g.rows.filter((r) => r.bucket === label).length;
      running[i] += n;
      line.push(n, g.rows.length ? round1((n / g.rows.length) * 100) : "", g.rows.length ? round1((running[i] / g.rows.length) * 100) : "");
    });
    out.push(line);
  }
  const total: Cell[] = ["total"];
  for (const g of groups) total.push(g.rows.length, g.rows.length ? 100 : "", "");
  out.push(total);
  return out;
}

export type AuctionFunnel = {
  auction: SoldAuction;
  scanned: number;
  counts: SelectionCounts;
  candidates: number;
  beyondMaxCards: number;
  rows: LotRow[];
};

/**
 * One row per auction, and inside it one per grader.
 *
 * A run over several auctions is partly the question of whether the answer is
 * drifting — a percentage that held in July and does not hold now — and that
 * only shows up auction by auction. The counts that belong to the whole
 * auction rather than to one grader are left blank on the grader rows.
 */
export function auctionSheet(funnels: AuctionFunnel[]): Cell[][] {
  const out: Cell[][] = [[
    "venue", "auction", "closed", "grader", "sold PSA/CGC 7-10 lots", "candidates", "priced", "eligible", "eligible % of candidates",
    "median %", "p25 %", "p75 %", "as configured could win", "win rate %", "paid all-in $ (won)", "market value $ (won)", "paid % of value (won)",
  ]];
  for (const f of funnels) {
    const venue = VENUES[f.auction.venue];
    const closed = f.auction.closedAtUnixS ? fmtLocal(f.auction.closedAtUnixS, venue.timeZone, venue.zoneLabel) : "";
    const eligible = f.rows.filter((r) => r.eligible);
    const priced = f.rows.filter((r) => r.market_low !== "").length;
    for (const cut of graderRows(eligible)) {
      const whole = cut.label === "all";
      const s = describe(pcts(cut.rows));
      const won = cut.rows.filter((r) => r.sniper_could_win === "yes");
      const paid = round2(won.reduce((a, r) => a + r.all_in, 0));
      const value = round2(won.reduce((a, r) => a + Number(r.market_value || 0), 0));
      out.push([
        venue.name, f.auction.name, closed, cut.label,
        whole ? f.scanned : "", whole ? f.candidates : "", whole ? priced : "",
        cut.rows.length, whole && f.candidates ? round1((cut.rows.length / f.candidates) * 100) : "",
        s?.median ?? "", s?.p25 ?? "", s?.p75 ?? "",
        won.length, cut.rows.length ? round1((won.length / cut.rows.length) * 100) : "",
        paid, value, pctOf(paid, value),
      ]);
    }
  }
  return out;
}

/** The columns of the auctions sheet worth putting on a page. */
export const AUCTION_SUMMARY_COLUMNS = [0, 1, 2, 3, 7, 9, 12, 13, 16];

export function funnelSheet(funnels: AuctionFunnel[]): Cell[][] {
  const by = (venue: VenueKey | null) => funnels.filter((f) => venue === null || f.auction.venue === venue);
  const sum = (venue: VenueKey | null, f: (x: AuctionFunnel) => number) => by(venue).reduce((a, x) => a + f(x), 0);
  const reasons = new Map<string, Record<string, number>>();
  for (const f of funnels) {
    for (const r of f.rows) {
      if (r.eligible) continue;
      const key = generalise(r.status);
      const tally = reasons.get(key) ?? { fanatics: 0, alt: 0 };
      tally[f.auction.venue]++;
      reasons.set(key, tally);
    }
  }
  const line = (stage: string, f: (x: AuctionFunnel) => number): Cell[] => [stage, sum(null, f), sum("fanatics", f), sum("alt", f)];
  const out: Cell[][] = [
    ["stage", "all", "fanatics", "alt"],
    line("auctions", () => 1),
    line("sold PSA/CGC 7-10 Pokémon lots", (x) => x.scanned),
    line("  off the chase list (Fanatics chases a list; Alt takes every lot)", (x) => -x.counts.offChaseList),
    line("  no cert number", (x) => -x.counts.noCert),
    line("  block list", (x) => -x.counts.blockList),
    line("  Master Ball below grade / duplicate cert", (x) => -x.counts.masterBallOrDuplicate),
    line("  beyond --max-cards", (x) => -x.beyondMaxCards),
    line("candidates, priced", (x) => x.rows.length),
  ];
  for (const [reason, tally] of [...reasons].sort((a, b) => b[1].fanatics + b[1].alt - a[1].fanatics - a[1].alt)) {
    out.push([`  ${reason}`, -(tally.fanatics + tally.alt), -tally.fanatics, -tally.alt]);
  }
  out.push(line("eligible — the sniper would have bid", (x) => x.rows.filter((r) => r.eligible).length));
  out.push(line("  of which the lot's own sale is among its comps", (x) => x.rows.filter((r) => r.eligible && r.own_sale_in_comps === "yes").length));
  return out;
}

export function notesSheet(now: Date, asked: Record<VenueKey, number>, funnels: AuctionFunnel[], partial?: Partial_, minMargin = DEFAULT_MIN_MARGIN, minWins = DEFAULT_MIN_WINS): Cell[][] {
  const got = (v: VenueKey) => funnels.filter((f) => f.auction.venue === v).length;
  return [
    ["note", "detail"],
    ["run", now.toISOString()],
    ...(partial ? [["PARTIAL RUN", `Pricing stopped early: ${partial.reason}. ${partial.priced} of ${partial.total} cert(s) were priced, and every lot the run never reached is in the funnel as "not priced". The percentages below are drawn from the lots that were priced, which is not a random sample of the rest — read them as a first look, not as the answer.`] as Cell[]] : []),
    ["auctions", `Fanatics Collect: ${got("fanatics")} of ${asked.fanatics} asked for; Alt: ${got("alt")} of ${asked.alt} asked for. Fewer means fewer exist.`],
    ["tier table", `The table this run compares against — its --tiers-psa / --tiers-cgc, else the snipers' defaults. ${GRADERS.map((g) => `${g}: ${formatTiers(tierTable()[g])}`).join("; ")}. Each band is "<from>-<to>: <rule>" in dollars of the lowest comp; the first band's start is the floor, under which nothing is bid. It gates nothing here: the curve is drawn over every lot that passed the sales rule, and the table only supplies the "as configured" row each band is measured against.`],
    ["resale rates", `What a card resells for, net, as a share of its market value, by grader and by what it is worth: ${GRADERS.map((g) => `${g}: ${formatResale(resaleTable()[g])}`).join("; ")}. Given with --resale-psa / --resale-cgc or RESALE_PSA / RESALE_CGC. This is the one number the report cannot work out for itself, and every profit and every recommendation follows from it — wrong rates here mean a wrong table recommended with complete confidence.`],
    ["the price grid", `The curve is cut on a fixed grid of the bid basis — ${gridBands().map((b) => b.label).join(", ")} — not on the bands of any table. A grid that came from the table being judged could never say a boundary was in the wrong place. Adjacent bands that want the same rule are merged when the recommendation is written, so the line that comes out is as short as the data allows.`],
    ["the recommendation", `Per house and grader: the rule that made the most money in each band, neighbours merged, with the ends trimmed where a band could not clear ${minMargin}% profit on its spend — which is what sets the floor and the ceiling. Best is by profit, not by margin: margin alone picks the stingiest rule that ever wins (one lot at 50% shows a huge return on a tiny spend) and builds a table that bids on nothing. Interior bands keep their rule whatever the margin, because a table's bands have to touch.`],
    ["shares searched", `${SHARE_SEARCH_FROM}% to ${SHARE_SEARCH_TO}% in steps of ${BUCKET_STEP}, which goes past 100% on purpose. A share multiplies the LOWEST of the five comps — about 89% of market value — and the winner pays the runner-up's bid rather than their own max, so 100% of the lowest comp is nothing like paying market value and the best share in a band is often above it. The buckets are a different question and still stop at 100%.`],
    ["too few wins", `A band whose best rule rests on fewer than ${minWins} wins is a rule fitted to those lots rather than a rule. It takes the nearest believed band's rule instead — below for preference, since bidding a cheaper band's share errs toward paying less — and the Recommended sheet says which band it borrowed from. Such a band also cannot be the floor or the ceiling.`],
    ["the budget", "Without --budget every band takes the rule that made the most money, which answers \"what is the best table\" and not \"what is the best table I can afford\". With one, the rules are chosen together — one per band, across both graders, spend summed against the budget and profit maximised — and spend is read per auction rather than over the whole run. The budget may only push a band's rule DOWN from its unconstrained best, never up."],
    ["what the profit still ignores", "That the budget comes back. Some 97% of bids are outbid and hand their share straight back, so one evening turns a budget over many times and the real ceiling is well above what a single fill of it buys — the budgeted table is the cautious end. It also ignores the per-card cap, the credits identify costs, and the time between buying and selling. Treat all of it as the ranking between shares, which is what it is good for, rather than as a forecast of the week."],
    ["which lots", `Sold PSA/CGC 7–10 Pokémon lots that pass the sniper's own filters: at Fanatics the chase list, at Alt every lot; the block list; a cert; and the sales rule — ${MIN_SALES} sales, every one inside the last ${SALES_WINDOW_DAYS} days, applied to the sales as of the run rather than as of the auction. Card Uploader answers with the five most recent only, so an older auction is judged on comps that post-date it.`],
    ["bid basis", "sniper_market_price: the second-lowest of the five sales with the lot's own sale left out — what the sniper, pricing hours before the close, would have worked from, and the price the table's shares multiply. The share curve is drawn on it. (The lowest until 2026-09-17; market_low still shows it.)"],
    ["market value", `The same ${MIN_SALES} sales, highest and lowest dropped, the other ${MIN_SALES - 2} averaged. What a price paid is measured against: all_in_pct = paid all-in ÷ market value, and paid % of value (won) = what a rule's wins would have cost ÷ what they were worth, which is the resale rate that band would have to clear.`],
    ["own sale", "Both houses' sales reach Card Ladder, so a lot closed recently is often one of its own card's five comps. own_sale_in_comps says so per lot. The trimmed mean drops a cheap sale as the low and a dear one as the high, so only lots that sold near their market value are pulled toward 100%."],
    ["all-in", `Hammer plus the ${Math.round(BUYERS_PREMIUM * 100)}% buyer's premium: what the winner paid. Fanatics publishes it; Alt's sold prices include it, so the hammer there is derived.`],
    ["could win", "A rule 'could win' a lot when its hammer sits under the bid the rule would have sent (Fanatics: the ladder rung at or below the max; Alt: the whole dollar). Optimistic — the hammer is where the bidding stopped, not the winner's max."],
    ["share curve", "A row per house, grader, band of the grid and rule tried: the lots in the band, what the rule would have won, what those cost, what they resell for and the profit and margin that leaves. The row marked best is the one the recommendation took; the \"as configured\" row is what the given table did in that band, worked out per lot. Fanatics and Alt are separate because each sniper takes its own table."],
    ["buckets", `all_in_pct in buckets from ${BUCKET_FROM}% to ${BUCKET_TO}% in steps of ${BUCKET_STEP}, with a bucket below and one above, cut by grader and by house — over the lots the table would have bid on.`],
    ["per auction", "Auctions is a row per auction and, where both graders turn up in it, one per grader inside it: there to show whether an answer is drifting rather than to be averaged."],
    ["per card", `The snipers hold a few lots of one card at most per auction — ${DEFAULT_MAX_COPIES_PER_CARD} unless the run is told otherwise, whatever the grade or grader. The report does not apply that cap: it counts every lot a rule would have won.`],
    ["credits", "None spent. Pricing is the free per-cert lookup; nothing is identified, bid on, or written anywhere."],
  ];
}

function toCsv(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

function table(rows: Cell[][], columns: number[] = rows[0].map((_, i) => i)): string {
  const line = (r: Cell[]) => `| ${columns.map((i) => (r[i] === undefined || r[i] === null || r[i] === "" ? "—" : String(r[i]))).join(" | ")} |`;
  return [line(rows[0]), `|${columns.map(() => "---").join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}

export function summaryMarkdown(now: Date, asked: Record<VenueKey, number>, funnels: AuctionFunnel[], priceable: LotRow[], partial?: Partial_, minMargin = DEFAULT_MIN_MARGIN, minWins = DEFAULT_MIN_WINS, budget = 0): string {
  const eligible = priceable.filter((r) => r.eligible);
  const s = describe(pcts(eligible));
  const wins = eligible.filter((r) => r.sniper_could_win === "yes").length;
  const groups = headlineGroups(eligible);
  const byGrader = graderCuts(eligible).slice(1).filter((g) => g.rows.length > 0);
  const lines: (string | null)[] = [
    `## Sold report — what the sniper's lots went for`,
    ``,
    partial
      ? `> **Partial run.** Pricing stopped early: ${partial.reason}. ${partial.priced} of ${partial.total} cert(s) were priced. What follows is drawn from those alone.`
      : null,
    partial ? `` : null,
    `- ${funnels.length} closed auction(s): ${venueKeys.map((v) => `${VENUES[v].name} ${funnels.filter((f) => f.auction.venue === v).length} of ${asked[v]} asked for`).join(", ")}`,
    `- ${funnels.reduce((a, f) => a + f.scanned, 0)} sold PSA/CGC 7–10 Pokémon lots, ${funnels.reduce((a, f) => a + f.candidates, 0)} candidates, ${priceable.length} with ${MIN_SALES} sales inside ${SALES_WINDOW_DAYS} days, **${eligible.length} the table would have bid on**`,
    `- the table this run was given, to compare against: ${GRADERS.map((g) => `**${g}** ${formatTiers(tierTable()[g])}`).join(" · ")}`,
    `- resale rates, which every profit below follows from: ${GRADERS.map((g) => `**${g}** ${formatResale(resaleTable()[g])}`).join(" · ")}`,
    s ? `- paid all-in as a share of market value, over those: median **${s.median}%**, middle half ${s.p25}–${s.p75}%, one in ten under ${s.p10}%` : `- nothing eligible, so no percentages`,
    byGrader.length > 0
      ? `- by grader: ${byGrader.map((g) => { const gs = describe(pcts(g.rows)); return `**${g.label}** ${g.rows.length} lot(s), median ${gs ? `${gs.median}%` : "—"}${gs ? `, middle half ${gs.p25}–${gs.p75}%` : ""}`; }).join(" · ")}`
      : null,
    eligible.length ? `- the table as given could have won **${wins}** of them (${round1((wins / eligible.length) * 100)}%) — optimistic, see the notes` : null,
    `- comps are Card Uploader's five most recent sales as of ${now.toISOString().slice(0, 10)}, not as of each auction; ${eligible.filter((r) => r.own_sale_in_comps === "yes").length} lot(s) have their own sale among them`,
    ``,
  ];

  // The answer, first: the lines to paste, and what each is made of.
  const auctionsOf = (v: VenueKey) => funnels.filter((f) => f.auction.venue === v).length;
  const recs = venueKeys
    .filter((v) => priceable.some((r) => r.venueKey === v))
    .flatMap((venue) => recommendations(priceable.filter((r) => r.venueKey === venue),
      { minMargin, minWins, budget: budget > 0 ? budget : undefined, auctions: auctionsOf(venue) }));
  if (recs.length > 0) {
    lines.push(
      `### The tables to run next week`,
      ``,
      budget > 0
        ? `The rules that together make the most money a $${budget} budget can pay for, band by band, neighbours merged. Paste these into the sniper's PSA and CGC boxes. Spend and profit below are per auction; a band the budget would rather not spend on is given the cheapest share searched, which wins next to nothing.`
        : `The share that made the most money in each band of the price grid, neighbours merged. Paste these into the sniper's PSA and CGC boxes.`,
      ``,
    );
    for (const rec of recs) {
      lines.push(`**${VENUES[rec.venue].name} · ${rec.grader}**`, ``,
        "```", rec.tiers ? formatTiers(rec.tiers) : "nothing here clears the bar — do not bid", "```", ``,
        `Would have won ${rec.total.best.won} lot(s) for $${rec.total.best.paid} all-in, resells for $${rec.total.best.resale}: **$${rec.total.best.profit} profit, ${rec.total.best.margin}% on the spend**. The table this run was given wins ${rec.total.configured.won} for $${rec.total.configured.paid} and makes $${rec.total.configured.profit}${rec.total.configured.margin === "" ? "" : ` at ${rec.total.configured.margin}%`}.`,
        ``);
      if (rec.trimmed.length > 0) {
        lines.push(`Left out: ${rec.trimmed.map((t) => `${t.label} (${t.why})`).join(", ")}.`, ``);
      }
    }
    lines.push(
      `Band by band:`,
      ``,
      table(recommendedSheet(recs)),
      ``,
      `The workbook's Share curve sheet has every share from 50% to 100% in every band, the flat and offset rules in the cheap bands, and the "as configured" row beside them.`,
      ``,
    );
  }

  lines.push(
    `### By bucket (all-in % of market value)`,
    ``,
    `Lots the table would have bid on, in each bucket, and the share of that column's lots at or under its top.`,
    ``,
    table(bucketSheet(eligible), groupColumns(groups.length, 3, [0, 2])),
    ``,
    `### Auctions`,
    ``,
    table(auctionSheet(funnels), AUCTION_SUMMARY_COLUMNS),
    ``,
    `### Funnel`,
    ``,
    table(funnelSheet(funnels)),
    ``,
    `The workbook has the share curve in full, the buckets with every column, the auctions, the funnel, and every lot.`,
  );
  return lines.filter((l): l is string => l !== null).join("\n") + "\n";
}

// ── The run ───────────────────────────────────────────────────────────────────

function runStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}_${p(now.getUTCHours())}${p(now.getUTCMinutes())}Z`;
}

function count(name: string, fallback: number): number {
  const n = Number(opt(name, String(fallback)));
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number, got "${opt(name, "")}"`);
  return n;
}

export async function runSoldReport(): Promise<void> {
  loadEnvLocal();
  const headed = process.argv.includes("--headed");
  const asked: Record<VenueKey, number> = { fanatics: count("fanatics", DEFAULT_AUCTIONS), alt: count("alt", DEFAULT_AUCTIONS) };
  const maxCards = count("max-cards", DEFAULT_MAX_CARDS);
  const concurrency = count("concurrency", PRICE_CONCURRENCY);
  if (concurrency < 1) throw new Error("--concurrency must be at least 1");
  if (asked.fanatics + asked.alt === 0) throw new Error("Nothing to look at: --fanatics and --alt are both 0.");
  const minMargin = Number(opt("min-margin", String(DEFAULT_MIN_MARGIN)));
  if (!(minMargin >= 0)) throw new Error(`--min-margin must be a percentage, got "${opt("min-margin", "")}"`);
  const minWins = count("min-wins", DEFAULT_MIN_WINS);
  // 0 = no budget: recommend the table that makes the most money, whatever
  // it would cost.
  const budgetDollars = Number(opt("budget", "0"));
  if (!(budgetDollars >= 0)) throw new Error(`--budget must be a number of dollars, got "${opt("budget", "")}"`);
  // The tables the run reads from. Read first: one that cannot be read is a
  // run that should not start.
  setTierTable(tiersFromArgs());
  setResaleTable(resaleFromArgs());

  const now = new Date();
  const startedMs = Date.now();
  const outDir = join(opt("out", "sold-report-runs"), runStamp(now));
  mkdirSync(outDir, { recursive: true });

  console.log(`📒  Sold report — what the sniper's lots went for at ${venueKeys.filter((v) => asked[v] > 0).map((v) => VENUES[v].name).join(" and ")}\n`);
  console.log(`    output       ${outDir}`);
  console.log(`    auctions     ${venueKeys.map((v) => `${VENUES[v].name} ${asked[v]}`).join(", ")} (fewer when fewer exist)`);
  console.log(`    max cards    ${maxCards > 0 ? `${maxCards} per auction` : "every candidate"}`);
  for (const grader of GRADERS) console.log(`    tiers ${grader}    ${formatTiers(tierTable()[grader])}   (to compare against; it gates nothing)`);
  for (const grader of GRADERS) console.log(`    resale ${grader}   ${formatResale(resaleTable()[grader])}`);
  console.log(`    min margin   ${minMargin}% profit on the spend for a band to be worth bidding in`);
  console.log(`    min wins     ${minWins} win(s) before a band sets its own rule rather than borrowing its neighbour's`);
  console.log(`    budget       ${budgetDollars > 0 ? `$${budgetDollars} all-in per run per house — the table is cut to fit it` : "none; the table that makes the most money, whatever it costs"}`);
  console.log(`    sales rule   ${MIN_SALES} sales, every one inside the last ${SALES_WINDOW_DAYS} days`);
  console.log(`    pricing      ${concurrency} cert lookups at a time, no credits\n`);

  // 1. The houses' closed auctions.
  const auctions: SoldAuction[] = [];
  if (asked.fanatics > 0) {
    console.log(`  ── scanning ${VENUES.fanatics.name}'s closed auctions`);
    auctions.push(...await scanFanaticsSold({ count: asked.fanatics, headed }));
    console.log();
  }
  if (asked.alt > 0) {
    console.log(`  ── scanning ${VENUES.alt.name}'s closed auctions`);
    auctions.push(...await scanAltSold({ count: asked.alt }));
    console.log();
  }

  // 2. The candidates, per auction — the sniper's own selection: the chase
  //    list at Fanatics, every lot at Alt.
  const funnels: AuctionFunnel[] = [];
  const entries: { auction: SoldAuction; lot: SoldLot; candidate: Candidate }[] = [];
  for (const auction of auctions) {
    const venue = VENUES[auction.venue];
    console.log(`  ── ${venue.name} · ${auction.name}: ${auction.lots.length} lot(s)`);
    const selected = selectCandidates(auction.lots, (line) => console.log(line), { chaseList: venue.chaseList });
    let candidates = selected.candidates;
    let beyondMaxCards = 0;
    if (maxCards > 0 && candidates.length > maxCards) {
      beyondMaxCards = candidates.length - maxCards;
      candidates = candidates.slice(0, maxCards);
    }
    const byId = new Map(auction.lots.map((l) => [l.listingId, l]));
    for (const candidate of candidates) {
      const lot = byId.get(candidate.listingId);
      if (lot) entries.push({ auction, lot, candidate });
    }
    console.log(`    ${candidates.length} candidate(s)${beyondMaxCards ? `, ${beyondMaxCards} beyond --max-cards` : ""}`);
    funnels.push({ auction, scanned: auction.lots.length, counts: selected.counts, candidates: selected.candidates.length, beyondMaxCards, rows: [] });
  }
  console.log();

  // 3. Card Uploader, once per cert: a slab relisted, or sold at both houses,
  //    is priced one time.
  const prices = new Map<string, CuPrice>();
  const unique = new Map<string, Candidate>();
  for (const e of entries) unique.set(`${e.candidate.grader}:${e.candidate.cert}`, e.candidate);
  const toPrice = [...unique.values()];

  let cu: CuSession | null = null;
  const guard = guardPlaywrightTlsCrash();
  // Pricing is the hours-long part, and a run that dies in it has spent them
  // for nothing unless the report is written from what it got. So a failure
  // here is recorded and carried, not thrown: the lots that were priced are
  // judged, the workbook is written and uploaded, and the run goes red at the
  // end with the reason. Every unpriced lot says "not priced" in the funnel.
  let pricingError: string | null = null;
  try {
    if (toPrice.length > 0) {
      console.log(`  ── signing in to Card Uploader`);
      cu = await openCardUploader({ headed, batchPrefix: "SoldReport" });
      console.log(`\n  ── pricing ${toPrice.length} cert(s) across ${entries.length} lot(s)`);
      for (let i = 0; i < toPrice.length; i += PRICE_CHUNK) {
        const chunk = toPrice.slice(i, i + PRICE_CHUNK);
        console.log(`    certs ${i + 1}–${i + chunk.length} of ${toPrice.length}`);
        await refreshCuToken(cu);
        await priceByCert(cu, chunk, { prices, concurrency, sweep: false });
      }
      // The patient pass over whatever never answered.
      const unanswered = toPrice.filter((c) => prices.get(`${c.grader}:${c.cert}`)?.error).length;
      if (unanswered > 0) {
        console.log(`    sweeping ${unanswered} cert(s) that never answered`);
        await refreshCuToken(cu);
        await priceByCert(cu, toPrice, { prices, concurrency, sweep: true });
      }
      console.log();
    }
  } catch (err) {
    pricingError = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`\n  ✖  pricing stopped: ${pricingError}`);
    console.error(`     ${prices.size} of ${toPrice.length} cert(s) were priced; the report is written from those and the run ends red.\n`);
  } finally {
    guard.release();
    await cu?.close();
  }
  if (guard.swallowed() > 0) {
    console.log(`    ${guard.swallowed()} request(s) were lost to Playwright's socket bug and retried\n`);
  }
  const priced = toPrice.filter((c) => {
    const p = prices.get(`${c.grader}:${c.cert}`);
    return p !== undefined && !p.error;
  }).length;

  // 4. Every lot, judged.
  for (const e of entries) {
    const row = evaluateSold(e.auction, e.lot, e.candidate, prices.get(`${e.candidate.grader}:${e.candidate.cert}`), now);
    funnels.find((f) => f.auction === e.auction)!.rows.push(row);
  }
  const rows = funnels.flatMap((f) => f.rows);
  const priceable = rows.filter((r) => r.priceable);
  const eligible = rows.filter((r) => r.eligible);
  rows.sort((a, b) =>
    (a.eligible === b.eligible ? 0 : a.eligible ? -1 : 1) ||
    a.venue.localeCompare(b.venue) ||
    b.closed.localeCompare(a.closed) ||
    Number(a.all_in_pct || Infinity) - Number(b.all_in_pct || Infinity));

  // 5. The spreadsheet, the CSVs, the page.
  const partial: Partial_ | undefined = pricingError
    ? { reason: pricingError, priced, total: toPrice.length }
    : undefined;
  const auctionsPer = (v: VenueKey) => funnels.filter((f) => f.auction.venue === v).length;
  const recs = venueKeys
    .filter((v) => priceable.some((r) => r.venueKey === v))
    .flatMap((venue) => recommendations(priceable.filter((r) => r.venueKey === venue),
      { minMargin, minWins, budget: budgetDollars > 0 ? budgetDollars : undefined, auctions: auctionsPer(venue) }));
  const sheets: Sheet[] = [
    { name: "Notes", rows: notesSheet(now, asked, funnels, partial, minMargin, minWins) },
    { name: "Recommended", rows: recommendedSheet(recs) },
    { name: "Share curve", rows: shareCurveSheet(priceable) },
    { name: "Buckets", rows: bucketSheet(eligible) },
    { name: "Auctions", rows: auctionSheet(funnels) },
    { name: "Funnel", rows: funnelSheet(funnels) },
    { name: "Lots", rows: [LOT_COLUMNS, ...rows.map((r) => LOT_COLUMNS.map((c) => r[c] as Cell))] },
  ];
  writeXlsx(join(outDir, "sold-report.xlsx"), sheets);
  for (const sheet of sheets) writeFileSync(join(outDir, `${sheet.name.toLowerCase().replace(/ /g, "-")}.csv`), toCsv(sheet.rows));
  writeFileSync(join(outDir, "summary.md"), summaryMarkdown(now, asked, funnels, priceable, partial, minMargin, minWins, budgetDollars));

  // 6. Said out loud.
  const s = describe(pcts(eligible));
  const wins = eligible.filter((r) => r.sniper_could_win === "yes").length;
  console.log(`  ── ${funnels.length} auction(s), ${rows.length} candidate lot(s), ${priceable.length} past the sales rule, ${eligible.length} the table would have bid on  ·  ${Math.round((Date.now() - startedMs) / 1000)}s`);
  if (s) {
    console.log(`     paid all-in as a share of market value: median ${s.median}%, mean ${s.mean}%, middle half ${s.p25}–${s.p75}%`);
    console.log(`     the table as given could have won ${wins} (${round1((wins / eligible.length) * 100)}%)`);
  }
  console.log();
  for (const rec of recs) {
    console.log(`  ── ${VENUES[rec.venue].name} · ${rec.grader}`);
    console.log(`     ${rec.tiers ? formatTiers(rec.tiers) : "nothing here clears the bar — do not bid"}`);
    console.log(`     ${rec.total.best.won} lot(s), $${rec.total.best.paid} all-in, resells for $${rec.total.best.resale} — $${rec.total.best.profit} profit at ${rec.total.best.margin}%`);
    console.log(`     the table given: ${rec.total.configured.won} lot(s), $${rec.total.configured.paid} all-in, $${rec.total.configured.profit} profit`);
  }
  console.log();
  for (const line of funnelSheet(funnels).slice(1)) console.log(`    ${String(line[1]).padStart(7)}  ${line[0]}`);
  console.log(`\n    ${join(outDir, "sold-report.xlsx")}`);

  // Written first, then the failure: the workbook is on disk and uploaded
  // even though the run goes red.
  if (pricingError) {
    throw new Error(`pricing stopped after ${priced} of ${toPrice.length} cert(s): ${pricingError}. The report in ${outDir} covers what was priced.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSoldReport().catch((err) => {
    console.error("\nSold report failed:", err.message ?? err);
    process.exit(1);
  });
}
