/**
 * eBay — the sniper that runs all day.
 *
 * The other two snipers work one auction a week: scan it, price it, hold,
 * fire, watch. eBay is a stream — the chosen sellers list new auctions every
 * day and each one ends on its own clock, at a fixed moment, with no
 * extension. So this one is a daemon. Every few minutes it asks eBay for
 * every live auction those sellers have under Authenticity Guarantee, reads
 * the new ones, prices them the way the other snipers do (Card Uploader,
 * the tier tables, the sales rule, the value basis), and puts the ones worth
 * a bid on a schedule. Each scheduled lot is bid on once, at its max, a few
 * seconds before its end — proxy bidding means the max is the ceiling and
 * eBay bids up to it on the account's behalf — and what became of it is read
 * back after the close. When the budget has been spent on lots actually won,
 * the process ends.
 *
 * Only PSA and CGC slabs, only the grades asked for (PSA 1–10 and CGC 7–10
 * unless told otherwise), only the sellers named, only under Authenticity
 * Guarantee — and never a card from a set released in the last six months
 * (scripts/set-dates.ts): a new set's comps are hype prices.
 *
 * The cert number, which everything is priced from, is not published by any
 * of these sellers — not in the title, not in the item specifics, not in the
 * description. It is read off the slab in the listing's own photograph
 * (scripts/ebay-ocr.ts), and then checked back against the listing: a cert
 * whose grader, grade, year or card number disagrees with what the listing
 * claims is dropped rather than bid on, because a misread digit prices a
 * different card.
 *
 * Nothing is bid without --live, and --live is refused until the bid flow in
 * scripts/ebay-bidder.ts has been walked on a real listing (--rehearse).
 * Without --live the daemon does everything but confirm: it prices, it
 * schedules, and at each lot's fire time it writes down what it would have
 * bid and, after the close, whether that would have won.
 *
 * Reading the run: everything goes to the console, and two files are kept
 * current under ebay-sniper-runs/ — state.json, which is what a restart
 * picks up (the schedule, the bids on, the wins), and ebay-bids.csv, every
 * listing seen and what became of it.
 *
 * Flags:
 *   --budget=10000        the money to spend, all-in, on lots won; when the
 *                         wins reach it, the daemon stops. Bids in flight are
 *                         counted against it too, so it never bids past it
 *   --fire-before=5       seconds before a lot's end to confirm the bid
 *   --arm-before=60       seconds before the end to open the page and walk
 *                         to Confirm, ready for the fire
 *   --scan-every=10       minutes between looks at eBay for new auctions
 *   --max-wins=0          lots to win before the run is over; 0 is as many as
 *                         the budget stretches to. Lots bid on and not yet
 *                         settled count against it
 *   --sellers=a,b,c       eBay usernames bought from whether or not the lot
 *                         is under Authenticity Guarantee, because the seller
 *                         is known by name (default: DEFAULT_SELLERS)
 *   --sellers-only        buy from those and nobody else, leaving the wider
 *                         Authenticity Guarantee pool alone
 *   --psa-grades=1-10     the PSA grades to consider; --cgc-grades=7-10 likewise
 *   --new-set-months=6    refuse any set released inside this many months
 *   --ocr-before=120      minutes before a lot's end to read its slab label.
 *                         Reading takes a few seconds per listing, so it waits
 *                         until the lot is nearly closing and every free
 *                         filter has already passed it
 *   --ocr-per-day=1500    labels to read in a day at most; 0 for no limit
 *   --no-ocr              do not read labels at all. Nothing these sellers
 *                         list can be priced without one, so this schedules
 *                         nothing — it is for watching what the free filters do
 *   --zip=<postcode>      where the cards would ship to, so eBay quotes the
 *                         postage it works out from the buyer's address
 *   --shipping-unknown=15 dollars of postage to assume on a lot eBay quotes
 *                         none for. Postage comes off the bid either way, so
 *                         hammer plus postage stays under the lot's max
 *   --tiers-psa, --tiers-cgc, --value-basis, --sales-rule, --max-copies-per-card
 *                         as at the other snipers (see scripts/sniper-core.ts)
 *   --live                confirm the bids; refused until BID_FLOW_VERIFIED
 *   --once                one scan and one plan, then exit
 *   --login               sign in to eBay by hand, once, and save the session
 *   --export-session      print this machine's eBay session as one line, to
 *                         paste into a run elsewhere. It is a way in to the
 *                         account — treat it as the password it stands for
 *   --account=Name        the name eBay greets the account by; another
 *                         account's session is refused
 *   --check-sellers       how many live auctions each seller has, and exit
 *   --rehearse=<item>     walk the bid flow on one listing to the Confirm
 *                         button, screenshot every step, and stop
 *     --max=<dollars>     the max to type during the rehearsal (default $1)
 *   --headless            run the eBay browser without a window (not advised)
 *   --headed              show the Card Uploader browser
 *   --out=ebay-sniper-runs  where the state, CSV and screenshots go
 *
 * Environment (.env.local):
 *   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET    the developer.ebay.com keys
 *   EBAY_ACCOUNT                          as --account
 *   EBAY_ZIP                              as --zip
 *   EBAY_SESSION_STATE                    a session from --export-session,
 *                                         used only where there is no
 *                                         .ebay-session profile already
 *   SHIPPING_UNKNOWN                      as --shipping-unknown
 *   MAX_WINS                              as --max-wins
 *   SELLERS_ONLY                          as --sellers-only
 *   OCR_BEFORE_MIN, OCR_PER_DAY           as --ocr-before / --ocr-per-day
 *   TESSERACT_PATH                        the Tesseract binary, if not on PATH
 *   CARDUPLOADER_EMAIL, CARDUPLOADER_PASSWORD
 *   SELLERS, PSA_GRADES, CGC_GRADES, NEW_SET_MONTHS, and the shared
 *   TIERS_PSA / TIERS_CGC / VALUE_BASIS / SALES_RULE / MAX_COPIES_PER_CARD
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { loadEnvLocal } from "./carduploader-batch";
import { EBAY_STEPS, exportSession, openEbay, type EbaySession, type PreparedBid } from "./ebay-bidder";
import {
  DAILY_CALL_ALLOWANCE,
  EbayApp,
  authenticityGuaranteed,
  centsOf,
  itemUrl,
  legacyId,
  parseEndDate,
  readAspects,
  gradeOf,
  graderOf,
  imageUrls,
  searchAuctions,
  searchFilter,
  shippingCents,
  toLot,
  type Item,
  type ItemSummary,
} from "./ebay-search";
import { CertReader, OcrBudget, type CertReading } from "./ebay-ocr";
import { DEFAULT_NEW_SET_MONTHS, cutoffDate, loadSetReleases, setAgeVerdict, type SetLanguage, type SetRelease } from "./set-dates";
import { DEFAULT_BUDGET_DOLLARS, allInCents, bidAmount, dollars, hammerForAllIn, setBuyersPremium, type Biddable, type Quote } from "./sniper-book";
import {
  GRADERS,
  basisFromArgs,
  evaluate,
  finalCut,
  formatBasis,
  formatSalesRule,
  formatTiers,
  identifyViaBatch,
  nothingToBidOn,
  requireSomethingToBidOn,
  marketPct,
  maxCopiesFromArgs,
  maxCopiesPerCard,
  openCardUploader,
  opt,
  priceByCert,
  refreshCuToken,
  salesRuleFromArgs,
  selectCandidates,
  setBasis,
  setMaxCopiesPerCard,
  setSalesRule,
  setTierTable,
  sleep,
  snapshotFailure,
  tierTable,
  gradeRanges,
  tiersFromArgs,
  toBiddable,
  type Candidate,
  type CuCard,
  type CuPrice,
  type CuSession,
  type Grader,
  type Row,
  type ScannedLot,
  formatGradeRange,
  gradeAllowed,
  gradeRangesFrom,
  parseGradeRange,
  type GradeRange,
} from "./sniper-core";

// The grade grammar is shared with the auction-house snipers; eBay's callers
// have always read it from here, so it still comes out of here.
export { formatGradeRange, gradeAllowed, parseGradeRange, type GradeRange };

// ── Configuration ─────────────────────────────────────────────────────────────

/** The sellers to buy from, by eBay username, unless --sellers says otherwise. */
export const DEFAULT_SELLERS = ["zandgemporium", "ryans_cardhouse", "probstein123", "psa"];
export const DEFAULT_FIRE_BEFORE_S = 5;
export const DEFAULT_ARM_BEFORE_S = 60;
export const DEFAULT_SCAN_EVERY_MIN = 10;
/**
 * What postage to assume on a lot eBay would not quote — a calculated rate
 * with no postcode to work it out from, or a listing naming no option at all.
 * Taken off the hammer like a real quote, so an unquoted lot is bid a little
 * lower rather than bid over the ceiling. Graded slabs from these sellers post
 * for a few dollars; this leaves room over that without cutting into the bid
 * enough to matter. --shipping-unknown changes it.
 */
export const DEFAULT_UNKNOWN_SHIPPING_DOLLARS = 15;
/**
 * How close to its end a listing must be before its label is read.
 *
 * Reading takes a few seconds and the sellers hold tens of thousands of
 * auctions at once, most of which will be outbid past our price long before
 * they close. Waiting until the end is near spends that time only on lots
 * that are still worth a bid, and prices them off fresher sales besides.
 */
export const DEFAULT_OCR_BEFORE_MIN = 120;
/** Labels read in a day before the run stops reading and waits for tomorrow. */
export const DEFAULT_OCR_PER_DAY = 1_500;
/** Photographs tried on one listing before its label is given up on. */
const OCR_IMAGES_PER_LOT = 2;
/** Scans a listing's label is attempted across before it is passed over. */
const OCR_ATTEMPTS = 2;
/** Prepared bids open at once — one browser page each. */
export const DEFAULT_ARM_CONCURRENCY = 6;
/**
 * New listings read in detail per scan. Each is one API call against a
 * 5,000-a-day allowance; a first scan of a big seller can find thousands,
 * and they are taken soonest-ending first, the rest on the next scan.
 */
export const DEFAULT_DETAILS_PER_SCAN = 150;
/** Calls kept in hand each day so the fires and the outcomes are never refused. */
const CALLS_RESERVE = 400;
/** The least a fire may be before the end, and the least an arm may be before a fire. */
export const MIN_FIRE_BEFORE_S = 2;
export const MIN_ARM_LEAD_S = 15;
/**
 * A lot that ends sooner than this after it is first read cannot be priced
 * and identified in time, and is left alone.
 */
const MIN_LEAD_TO_PRICE_S = 180;
/** After a lot's end, when to read how it went, and how patiently. */
const OUTCOME_DELAY_S = 20;
const OUTCOME_RETRY_S = 45;
const OUTCOME_ATTEMPTS = 6;
/** Below this much free budget, with nothing in flight, the run is over. */
const MIN_USEFUL_FREE_CENTS = 500;
const HEARTBEAT_MS = 5 * 60_000;
const TICK_MS = 1_000;
/** Certs priced at once at Card Uploader; the volume here is small. */
const PRICE_CONCURRENCY = 16;
/** Scans a cert that never answered is retried on before it is given up. */
const PRICE_SCANS = 3;
/** Resolved listings are kept in the state this long, for the CSV. */
const KEEP_RESOLVED_DAYS = 30;

export const OUT_DIR = "ebay-sniper-runs";
export const STATE_FILE = "state.json";
export const CSV_FILE = "ebay-bids.csv";
export const SETS_FILE = "sets.json";
export const BATCH_PREFIX = "EbaySniper";

// ── Grades ────────────────────────────────────────────────────────────────────

/**
 * PSA 1–10, CGC 7–10: what was asked for on 2026-09-17. eBay keeps a floor
 * under CGC where the auction houses no longer do — it is an open market, and
 * a CGC 4 on eBay is as often a trimmed card as a cheap one.
 *
 * The grammar and the check live in ./sniper-core, which the other two
 * snipers read them from as well.
 */
export const DEFAULT_GRADE_RANGES: Record<Grader, GradeRange> = {
  PSA: { min: 1, max: 10 },
  CGC: { min: 7, max: 10 },
};

export function gradeRangesFromArgs(env: Record<string, string | undefined> = process.env): Record<Grader, GradeRange> {
  return gradeRangesFrom(DEFAULT_GRADE_RANGES, env);
}

export function sellersFromArgs(env: Record<string, string | undefined> = process.env): string[] {
  const text = opt("sellers", env.SELLERS ?? DEFAULT_SELLERS.join(","));
  const sellers = [...new Set(text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
  if (sellers.length === 0) throw new Error("--sellers needs at least one eBay username");
  return sellers;
}

/**
 * Whether the run buys only from the sellers it was given.
 *
 * Off by default, which means two pools rather than one: every live Pokémon
 * auction eBay runs under Authenticity Guarantee, whoever is selling — the
 * programme is eBay's own promise that the slab is what it says, so the
 * seller's name matters less — and everything the named sellers list, under
 * the programme or not, because those four are known by name. A lot that is
 * neither is passed over.
 *
 * On, the wider pool is dropped and only the named sellers are bought from.
 */
export function sellersOnlyFromArgs(env: Record<string, string | undefined> = process.env): boolean {
  return process.argv.includes("--sellers-only") || /^(1|true|yes)$/i.test(env.SELLERS_ONLY ?? "");
}

// ── The cert against the listing ──────────────────────────────────────────────

/**
 * What a year in a title looks like. Pokémon cards start in 1996, so anything
 * outside that span is a card number or a set code that happens to be four
 * digits, not a year.
 */
export function yearFromText(text: string): number | undefined {
  for (const m of text.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)) {
    const year = Number(m[1]);
    if (year >= 1996) return year;
  }
  return undefined;
}

/**
 * The card's own number, as a title writes it: "#64", "16/111", "064/191".
 * Leading zeroes are dropped so "#066" and "66" are the same number.
 */
export function cardNumberFromText(text: string): string | undefined {
  const hash = /#\s*(\d{1,3})(?:\/\d+)?\b/.exec(text);
  if (hash) return String(Number(hash[1]));
  const slash = /\b(\d{1,3})\/\d{1,3}\b/.exec(text);
  if (slash) return String(Number(slash[1]));
  return undefined;
}

/** What the eBay listing claims the slab is. */
export type ListingClaim = { title: string; grader: string; grade?: number };
/** What the label was read as, and what Card Uploader says that cert is. */
export type CertClaim = { grader: string; grade: number | null };
export type CertFact = { gradingCompany: string; condition: string; description: string };

/**
 * Everything that has to agree before a bid is priced off a cert, and what
 * disagrees when it does not.
 *
 * Three accounts of one slab: what the listing says in its title, what the
 * label was read as, and what Card Uploader says that cert number is. A
 * reading is only as good as its worst digit, and a misread cert prices some
 * other card entirely — usually a cheaper one, sometimes a far dearer one —
 * so a cert that does not answer to the listing is dropped rather than
 * bid on. It catches the honest mistakes too: a slab listed as a 10 whose
 * cert is a 9.
 *
 * Only what both sides state is compared; a title that names no year is not
 * held against the cert.
 */
export function certMismatches(listing: ListingClaim, reading: CertClaim, fact: CertFact): string[] {
  const problems: string[] = [];

  const certGrader = graderOf(fact.gradingCompany || fact.condition);
  const readGrader = reading.grader ? graderOf(reading.grader) : "";
  const listedGrader = listing.grader ? graderOf(listing.grader) : "";
  if (readGrader && certGrader && readGrader !== certGrader) {
    problems.push(`the label reads ${readGrader} and the cert belongs to ${certGrader} — the number was misread`);
  }
  if (listedGrader && certGrader && listedGrader !== certGrader) {
    problems.push(`the listing says ${listedGrader} and the cert is ${certGrader}`);
  }

  const certGrade = gradeOf(fact.condition);
  if (certGrade !== undefined) {
    if (reading.grade !== null && reading.grade !== certGrade) {
      problems.push(`the label reads ${reading.grade} and the cert is graded ${certGrade} — the number was misread`);
    }
    if (listing.grade !== undefined && listing.grade !== certGrade) {
      problems.push(`the listing says ${listing.grade} and the cert is graded ${certGrade}`);
    }
  }

  const listedYear = yearFromText(listing.title);
  const certYear = yearFromText(fact.description);
  if (listedYear && certYear && listedYear !== certYear) {
    problems.push(`the listing says ${listedYear} and the cert is a ${certYear} card`);
  }

  const listedNumber = cardNumberFromText(listing.title);
  const certNumber = cardNumberFromText(fact.description);
  if (listedNumber && certNumber && listedNumber !== certNumber) {
    problems.push(`the listing says card #${listedNumber} and the cert is #${certNumber}`);
  }

  return problems;
}

export function setGuard(opts: {
  name: string;
  language: SetLanguage | "";
  year: string;
  sets: SetRelease[];
  now: Date;
  months: number;
}): string | null {
  const name = opts.name.trim();
  if (!name) return null;
  const verdict = setAgeVerdict(name, opts.sets, { now: opts.now, months: opts.months, language: opts.language || undefined });
  if (verdict.blocked) return verdict.blocked;
  if (verdict.match) return null;
  const cutoffYear = Number(cutoffDate(opts.now, opts.months).slice(0, 4));
  const year = Number(opts.year);
  if (Number.isFinite(year) && year >= cutoffYear) {
    return `set "${name}" is not in the release list and the card is from ${year}, so it cannot be shown to be older than ${opts.months} months`;
  }
  return null;
}

// ── Timing ────────────────────────────────────────────────────────────────────

export function armAtMs(endsAtMs: number, armBeforeS: number): number {
  return endsAtMs - armBeforeS * 1_000;
}

export function fireAtMs(endsAtMs: number, fireBeforeS: number): number {
  return endsAtMs - fireBeforeS * 1_000;
}

// ── The state ─────────────────────────────────────────────────────────────────

export type ItemStatus =
  | "seen"        // found by a scan, not yet read in detail or not yet priced
  | "rejected"    // read, and not a lot this run bids on
  | "scheduled"   // priced, worth a bid, waiting for its arm time
  | "armed"       // the page is open on Confirm, waiting for the fire
  | "planned"     // no --live: what would have been bid, and later whether it would have won
  | "bid"         // confirmed; waiting for the close
  | "won" | "lost" | "unknown"
  | "skipped";    // scheduled, then passed over at the arm: priced out, over the ceiling, ended

export type ItemRecord = {
  itemId: string;
  legacyId: string;
  url: string;
  title: string;
  seller: string;
  endsAtMs: number;
  firstSeenAt: string;
  status: ItemStatus;
  reason?: string;
  grader?: string;
  grade?: number;
  cert?: string;
  set?: string;
  language?: string;
  cardKey?: string;
  marketPrice?: number;
  salesMedian?: number;
  tierRule?: string;
  maxHammerCents?: number;
  maxAllInCents?: number;
  /**
   * What this listing charges to post, taken off the hammer so the all-in
   * holds. `shippingQuoted` is false when eBay named no price and the figure
   * is the --shipping-unknown assumption instead.
   */
  shippingCents?: number;
  shippingQuoted?: boolean;
  /**
   * Where the cert came from: "listing" if eBay published one, "label" if it
   * was read off the slab photograph. `certGrade` is the grade read at the
   * same time, which Card Uploader's answer is checked against.
   */
  certFrom?: "listing" | "label";
  certGrade?: number;
  /** Labels read for this lot without an answer; it is not read for ever. */
  ocrTries?: number;
  /** Scans this has been priced on without an answer. */
  priceTries?: number;
  bidCents?: number;
  bidAt?: string;
  bidAnswer?: string;
  finalCents?: number;
  paidAllInCents?: number;
  resolveAtMs?: number;
  resolveTries?: number;
  resolvedAt?: string;
};

export type State = { version: 1; startedAt: string; items: Record<string, ItemRecord> };

export function emptyState(now: Date = new Date()): State {
  return { version: 1, startedAt: now.toISOString(), items: {} };
}

export function loadState(path: string): State {
  if (!existsSync(path)) return emptyState();
  const state = JSON.parse(readFileSync(path, "utf-8")) as State;
  if (state.version !== 1 || typeof state.items !== "object") throw new Error(`${path} is not a state file this version reads`);
  return state;
}

export function saveState(path: string, state: State): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Money is held by a lot from the arm until its outcome is known. */
const HOLDING: ItemStatus[] = ["armed", "bid"];
/** Money is spent on a lot won — and on one whose outcome never came, which is counted as won. */
const SPENT: ItemStatus[] = ["won", "unknown"];

/**
 * The budget, read off the state. What has been won is spent; what is armed
 * or bid is held at its max all-in until the close says otherwise; the rest
 * is free. The per-card cap counts the same lots.
 */
export class Ledger {
  constructor(
    private readonly state: State,
    readonly budgetCents: number,
    private readonly perCard: number,
    /** Lots to win before the run is over; 0 is as many as the budget allows. */
    readonly maxWins = 0,
  ) {}

  private items(): ItemRecord[] { return Object.values(this.state.items); }

  spent(): number {
    return this.items().filter((i) => SPENT.includes(i.status)).reduce((sum, i) => sum + (i.paidAllInCents ?? i.maxAllInCents ?? 0), 0);
  }
  held(): number {
    return this.items().filter((i) => HOLDING.includes(i.status)).reduce((sum, i) => sum + (i.maxAllInCents ?? 0), 0);
  }
  free(): number { return this.budgetCents - this.spent() - this.held(); }
  fits(allInCents: number): boolean { return allInCents <= this.free(); }
  wonCount(): number { return this.items().filter((i) => i.status === "won").length; }
  /** Lots bought, counting one whose outcome never came — the same lots the budget is spent on. */
  bought(): number { return this.items().filter((i) => SPENT.includes(i.status)).length; }
  /** Lots bid on and not yet settled; each could still become a win. */
  inFlight(): number { return this.items().filter((i) => HOLDING.includes(i.status)).length; }

  /**
   * Whether the win limit leaves room for another lot. What is in flight
   * counts against it: two bids standing with one win to go could both land,
   * and the limit is a limit rather than a target.
   */
  roomToWin(): boolean { return this.maxWins <= 0 || this.bought() + this.inFlight() < this.maxWins; }

  copies(cardKey: string): number {
    return this.items().filter((i) => i.cardKey === cardKey && (HOLDING.includes(i.status) || SPENT.includes(i.status))).length;
  }
  capped(cardKey: string | undefined): boolean {
    return !!cardKey && this.copies(cardKey) >= this.perCard;
  }

  /** Why the run is over, or null while there is budget to spend. */
  stopReason(): string | null {
    const spent = this.spent();
    if (this.maxWins > 0 && this.bought() >= this.maxWins) {
      return `the win limit is reached: ${this.bought()} lot(s) won of ${this.maxWins}, ${dollars(spent)} spent`;
    }
    if (spent >= this.budgetCents) return `the budget is spent: ${dollars(spent)} won against ${dollars(this.budgetCents)}`;
    if (this.free() < MIN_USEFUL_FREE_CENTS && this.held() === 0) {
      return `bought up to the budget: ${dollars(spent)} won, ${dollars(this.free())} left is under any bid`;
    }
    return null;
  }

  standing(): string {
    const counts = (s: ItemStatus) => this.items().filter((i) => i.status === s).length;
    return `spent ${dollars(this.spent())} on ${this.wonCount()} won${this.maxWins > 0 ? ` of ${this.maxWins}` : ""}, holding ${dollars(this.held())} on ${counts("armed") + counts("bid")} in flight, ${dollars(this.free())} free of ${dollars(this.budgetCents)}` +
      ` — ${counts("scheduled")} scheduled, ${counts("lost")} lost${counts("unknown") ? `, ${counts("unknown")} unknown (counted as won)` : ""}`;
  }
}

// ── The CSV ───────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  "url", "title", "seller", "ends_at", "grader", "grade", "cert", "set", "language",
  "cert_from", "market_price", "sales_median", "tier_rule", "shipping", "max_bid_hammer", "max_bid_all_in",
  "status", "bid_placed", "final_price", "paid_all_in", "market_pct", "reason",
] as const;

const STATUS_ORDER: ItemStatus[] = ["armed", "bid", "scheduled", "won", "unknown", "planned", "lost", "skipped", "seen", "rejected"];

const money = (cents: number | undefined) => (cents === undefined ? "" : String(cents / 100));

export function csvRow(i: ItemRecord): Record<(typeof CSV_COLUMNS)[number], string | number> {
  const paid = i.paidAllInCents;
  return {
    url: i.url, title: i.title, seller: i.seller, ends_at: new Date(i.endsAtMs).toISOString(),
    grader: i.grader ?? "", grade: i.grade ?? "", cert: i.cert ?? "", set: i.set ?? "", language: i.language ?? "",
    cert_from: i.certFrom ?? "", market_price: i.marketPrice ?? "", sales_median: i.salesMedian ?? "", tier_rule: i.tierRule ?? "",
    shipping: i.shippingCents === undefined ? "" : `${money(i.shippingCents)}${i.shippingQuoted === false ? " (assumed)" : ""}`,
    max_bid_hammer: money(i.maxHammerCents), max_bid_all_in: money(i.maxAllInCents),
    status: i.status, bid_placed: money(i.bidCents), final_price: money(i.finalCents), paid_all_in: money(paid),
    market_pct: paid !== undefined && i.salesMedian ? marketPct(paid / 100, i.salesMedian) : "",
    reason: i.reason ?? "",
  };
}

export function toCsv(items: ItemRecord[]): string {
  const sorted = [...items].sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.endsAtMs - b.endsAtMs);
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const i of sorted) {
    const row = csvRow(i);
    lines.push(CSV_COLUMNS.map((c) => cell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

// ── The run ───────────────────────────────────────────────────────────────────

const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });

function say(line: string) {
  console.log(`    ${line}`);
}

export async function runEbaySniper(): Promise<void> {
  loadEnvLocal();
  // eBay charges the buyer nothing on top of the hammer: a share of market
  // is a share of the hammer here, and the all-in figure is the bid itself.
  setBuyersPremium(0);

  const live = process.argv.includes("--live");
  const once = process.argv.includes("--once");
  const login = process.argv.includes("--login");
  const checkSellers = process.argv.includes("--check-sellers");
  const exportSess = process.argv.includes("--export-session");
  const rehearse = opt("rehearse", "");
  const headless = process.argv.includes("--headless");
  const headed = process.argv.includes("--headed");

  const outDir = opt("out", OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  const account = opt("account", process.env.EBAY_ACCOUNT ?? "");
  // A session exported from the signed-in machine, for a runner with no
  // profile of its own. Only read when there is no profile here already.
  const sessionState = (process.env.EBAY_SESSION_STATE ?? "").trim();
  // Where the cards would ship to. Anything that searches needs it — eBay
  // refuses the Authenticity Guarantee filter without somewhere to deliver
  // to — and it is what calculated postage is quoted to as well. The errands
  // that only open a browser do not, so it is asked for where it is used.
  const zip = opt("zip", process.env.EBAY_ZIP ?? "").trim();
  if (zip && !/^\d{5}$/.test(zip)) throw new Error(`--zip is a five-digit US postcode, got "${zip}"`);
  const openApp = () => {
    if (!zip) {
      throw new Error("--zip=<postcode> is needed: eBay will not filter on Authenticity Guarantee without a delivery postcode, and postage is quoted to it. Set EBAY_ZIP in .env.local to have it every run.");
    }
    return EbayApp.fromEnv({ ...process.env, EBAY_ZIP: zip });
  };

  // ── Errands ────────────────────────────────────────────────────────────────
  if (exportSess) {
    const token = await exportSession(outDir);
    console.log(`\n${token}\n`);
    say(`that one line is this machine's eBay session — paste it into the workflow's session box, or keep it as the EBAY_SESSION_STATE secret.`);
    say(`it is a way in to the account: do not paste it anywhere else, and export a fresh one if it stops working.`);
    return;
  }

  if (login) {
    const session = await openEbay({ login: true, outDir, account });
    await session.close();
    say(`session saved under ${join(process.cwd(), ".ebay-session")}/`);
    return;
  }

  const sellers = sellersFromArgs();

  if (checkSellers) {
    const app = openApp();
    console.log(`\n    live Pokémon auctions per seller (CCG Individual Cards):\n`);
    for (const seller of sellers) {
      const all = await app.search({ q: "pokemon", category_ids: "183454", filter: searchFilter({ sellers: [seller], authenticityGuarantee: false }), limit: "1" });
      const ag = await app.search({ q: "pokemon", category_ids: "183454", filter: searchFilter({ sellers: [seller], zip }), limit: "1" });
      // Given a username nobody has, eBay does not answer with nothing — it
      // drops the filter and answers with everybody. The one listing read
      // back says which happened.
      const sample = all.itemSummaries?.[0]?.seller?.username ?? "";
      const bogus = (all.total ?? 0) > 0 && sample.toLowerCase() !== seller.toLowerCase();
      const note = (all.total ?? 0) === 0 ? "   ← no listings: is the username right?"
        : bogus ? `   ← NOT A SELLER: eBay ignored the filter and answered with everyone's listings (first one is ${sample}'s)`
        : (ag.total ?? 0) === 0 ? "   ← real seller, but nothing of theirs is under Authenticity Guarantee"
        : "";
      say(`${seller.padEnd(20)} ${String(all.total ?? 0).padStart(6)} auctions, ${String(ag.total ?? 0).padStart(6)} under Authenticity Guarantee${note}`);
    }
    console.log();
    return;
  }

  if (rehearse) {
    const max = Number(opt("max", "1"));
    if (!(max > 0)) throw new Error(`--max must be a positive number of dollars, got "${opt("max", "")}"`);
    const session = await openEbay({ outDir, account, headless, sessionState });
    try {
      const row: Biddable = {
        listingId: rehearse, title: `item ${rehearse}`, lot: rehearse,
        maxHammerCents: Math.round(max * 100), maxAllInCents: allInCents(Math.round(max * 100)), currentBidCents: 0, bidCount: 0,
      };
      const cents = EBAY_STEPS.below(row.maxHammerCents);
      console.log(`\n    rehearsing the bid flow on ${itemUrl(rehearse)} with a ${dollars(cents)} max — nothing is confirmed\n`);
      const prepared = await session.prepareBid(row, cents, "rehearsal");
      say(`reached the Confirm button. Screenshots are under ${outDir}/prepare-rehearsal-*.png.`);
      say(`Confirm is NOT clicked. Read scripts/ebay-bidder.ts against what the screenshots show, then set BID_FLOW_VERIFIED.`);
      await session.abandon(prepared);
    } finally {
      await session.close();
    }
    return;
  }

  // ── The run's settings ─────────────────────────────────────────────────────
  const budgetDollars = Number(opt("budget", String(DEFAULT_BUDGET_DOLLARS)));
  if (!(budgetDollars > 0)) throw new Error(`--budget must be a positive number of dollars, got "${opt("budget", "")}"`);
  const budgetCents = Math.round(budgetDollars * 100);
  const unknownShippingDollars = Number(opt("shipping-unknown", process.env.SHIPPING_UNKNOWN || String(DEFAULT_UNKNOWN_SHIPPING_DOLLARS)));
  if (!(unknownShippingDollars >= 0)) throw new Error(`--shipping-unknown must be a number of dollars, got "${opt("shipping-unknown", "")}"`);
  const unknownShippingCents = Math.round(unknownShippingDollars * 100);
  // How many lots to win before the run is over. 0 is as many as the budget
  // stretches to; the budget is the ceiling either way.
  const maxWins = Number(opt("max-wins", process.env.MAX_WINS || "0"));
  if (!Number.isInteger(maxWins) || maxWins < 0) throw new Error(`--max-wins must be a whole number of lots, 0 for no limit, got "${opt("max-wins", "")}"`);
  const sellersOnly = sellersOnlyFromArgs();
  // Reading the slab label: Tesseract, in this process, free and offline.
  const ocrOff = process.argv.includes("--no-ocr");
  const certReader = new CertReader();
  const ocrBeforeMin = Number(opt("ocr-before", process.env.OCR_BEFORE_MIN || String(DEFAULT_OCR_BEFORE_MIN)));
  if (!(ocrBeforeMin > 0)) throw new Error(`--ocr-before must be a positive number of minutes, got "${opt("ocr-before", "")}"`);
  const ocrPerDay = Number(opt("ocr-per-day", process.env.OCR_PER_DAY || String(DEFAULT_OCR_PER_DAY)));
  if (!(ocrPerDay >= 0)) throw new Error(`--ocr-per-day must be a whole number of readings, 0 for no limit, got "${opt("ocr-per-day", "")}"`);
  const ocrBudget = new OcrBudget(ocrPerDay);
  const fireBeforeS = Number(opt("fire-before", process.env.FIRE_BEFORE_S ?? String(DEFAULT_FIRE_BEFORE_S)));
  if (!(fireBeforeS >= MIN_FIRE_BEFORE_S)) throw new Error(`--fire-before must be at least ${MIN_FIRE_BEFORE_S} seconds, got "${opt("fire-before", "")}"`);
  const armBeforeS = Number(opt("arm-before", process.env.ARM_BEFORE_S ?? String(DEFAULT_ARM_BEFORE_S)));
  if (!(armBeforeS >= fireBeforeS + MIN_ARM_LEAD_S)) throw new Error(`--arm-before must be at least ${MIN_ARM_LEAD_S} seconds more than --fire-before, got "${opt("arm-before", "")}"`);
  const scanEveryMin = Number(opt("scan-every", process.env.SCAN_EVERY_MIN ?? String(DEFAULT_SCAN_EVERY_MIN)));
  if (!(scanEveryMin >= 1)) throw new Error(`--scan-every must be at least 1 minute, got "${opt("scan-every", "")}"`);
  const newSetMonths = Number(opt("new-set-months", process.env.NEW_SET_MONTHS ?? String(DEFAULT_NEW_SET_MONTHS)));
  if (!(newSetMonths >= 0)) throw new Error(`--new-set-months must be zero or more, got "${opt("new-set-months", "")}"`);
  const armConcurrency = Number(opt("arm-concurrency", String(DEFAULT_ARM_CONCURRENCY)));
  if (!Number.isInteger(armConcurrency) || armConcurrency < 1) throw new Error(`--arm-concurrency must be a positive whole number`);
  const detailsPerScan = Number(opt("details-per-scan", String(DEFAULT_DETAILS_PER_SCAN)));
  // The tier boxes may carry "grades 7-10" at the head of a line, so the
  // tables are read first and the ranges come out of them.
  setTierTable(tiersFromArgs(process.env, DEFAULT_GRADE_RANGES));
  requireSomethingToBidOn(live);
  const grades = gradeRanges();
  setMaxCopiesPerCard(maxCopiesFromArgs());
  setSalesRule(salesRuleFromArgs());
  setBasis(basisFromArgs());

  const statePath = join(outDir, STATE_FILE);
  const state = loadState(statePath);
  const ledger = new Ledger(state, budgetCents, maxCopiesPerCard(), maxWins);
  const resumed = Object.keys(state.items).length;

  console.log(live
    ? `💸  eBay sniper — LIVE BIDDING, real money\n`
    : `🎯  eBay sniper — planning: prices, schedules and says what it would bid, confirms nothing\n`);
  say(`output       ${outDir}  (state.json, ${CSV_FILE}, screenshots)`);
  say(`budget       ${dollars(budgetCents)} all-in on lots won; bids in flight are held against it; the run ends when it is spent`);
  say(`win limit    ${maxWins > 0 ? `${maxWins} lot(s), in flight counted against it; the run ends there` : "none — as many lots as the budget stretches to"}`);
  say(`fire         ${fireBeforeS}s before each lot's end, armed ${armBeforeS}s before, on eBay's clock`);
  say(`scan         every ${scanEveryMin} min; ${detailsPerScan} new listing(s) read in detail per scan`);
  say(`sellers      ${sellers.join(", ")}`);
  say(`filter       live auctions · PSA ${formatGradeRange(grades.PSA)} · CGC ${formatGradeRange(grades.CGC)} · Pokémon`);
  say(`cert         none of these sellers publish one, so it is read off the slab photograph with Tesseract` +
    `${ocrOff ? " — OFF (--no-ocr): nothing can be priced" : `, within ${ocrBeforeMin} min of a lot's end, ${ocrPerDay > 0 ? `${ocrPerDay} a day at most` : "no daily limit"}`}`);
  say(`cross-check  a cert whose grader, grade, year or card number disagrees with the listing is dropped, not bid on`);
  say(`pools        ${sellersOnly
    ? "the named sellers only (--sellers-only); the wider Authenticity Guarantee pool is left alone"
    : "every Pokémon auction under Authenticity Guarantee, whoever sells it — plus everything the named sellers list, guaranteed or not"}`);
  say(`new sets     nothing from a set released on or after ${cutoffDate(new Date(), newSetMonths)} (${newSetMonths} months)`);
  for (const grader of GRADERS) say(`tiers ${grader}    ${formatTiers(tierTable()[grader])}`);
  const noTable = nothingToBidOn();
  if (noTable) say(`⚠️  ${noTable}`);
  say(`per card     at most ${maxCopiesPerCard()} lot(s) of one card in flight or won`);
  say(`sales rule   ${formatSalesRule()}`);
  say(`value basis  the ${formatBasis()} of them — no buyer's premium here, so the share is of the hammer`);
  say(`shipping     the listing's own postage comes off the bid, so hammer + postage stays under the max` +
    `${zip ? ` (quoted to ${zip})` : ""}; ${dollars(unknownShippingCents)} assumed where eBay quotes none` +
    `${zip ? "" : " — pass --zip=<postcode> to have calculated rates quoted"}`);
  if (account) say(`account      ${account}`);
  if (resumed > 0) say(`resumed      ${resumed} listing(s) from ${statePath}; ${ledger.standing()}`);
  console.log();

  // ── What the run needs ─────────────────────────────────────────────────────
  // Tesseract, before anything is scanned: without it no cert can be read,
  // and without a cert nothing these sellers list can be priced.
  if (!ocrOff) {
    console.log(`  ── the label reader`);
    say(await certReader.version());
  }

  console.log(`  ── set release dates`);
  const releases = await loadSetReleases({ cachePath: join(outDir, SETS_FILE), log: (l) => console.log(l) });
  say(`${releases.sets.length} sets, list from ${releases.fetchedAt}${releases.fromCache ? " (on disk)" : ""}`);
  let sets = releases.sets;
  let setsFetchedAt = releases.fetchedAt;

  const app = openApp();
  let session: EbaySession | null = null;
  // Opened by the first scan that has something to price, and closed at the
  // end; held in a box because the scan is a closure and the type checker
  // cannot see it assign a plain variable.
  const cuBox: { current: CuSession | null } = { current: null };
  const prices = new Map<string, CuPrice>();
  const arming = new Set<string>();
  const resolving = new Set<string>();
  let stopping = false;
  let dirty = false;
  let callsAtDayStart = 0;
  let dayStarted = new Date().toISOString().slice(0, 10);

  const now = () => app.nowMs();
  const touch = () => { dirty = true; };
  /**
   * What a lot costs to post: eBay's quote where there is one, the assumption
   * where there is not. Never zero by default — an unpriced option is eBay
   * declining to say, not the seller posting it free.
   */
  const postage = (item: Pick<ItemSummary, "shippingOptions">) => {
    const quoted = shippingCents(item);
    return { cents: quoted ?? unknownShippingCents, quoted: quoted !== null };
  };
  const writeOutputs = () => {
    saveState(statePath, state);
    writeFileSync(join(outDir, CSV_FILE), toCsv(Object.values(state.items)));
    dirty = false;
  };
  const callsToday = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dayStarted) { dayStarted = today; callsAtDayStart = app.calls; }
    return app.calls - callsAtDayStart;
  };
  const record = (id: string) => state.items[id];
  const reject = (r: ItemRecord, reason: string) => { r.status = "rejected"; r.reason = reason; touch(); };
  const skip = (r: ItemRecord, reason: string) => {
    r.status = "skipped"; r.reason = reason; touch();
    say(`–  ${r.legacyId}: ${reason}\n       ${r.url}`);
  };

  // ── The scan ───────────────────────────────────────────────────────────────
  /**
   * New auctions from the sellers, read in detail, sifted, priced and put on
   * the schedule. Runs every --scan-every minutes; the arm ticker below keeps
   * running through it, since a scan can take minutes at Card Uploader.
   */
  const scan = async () => {
    const started = Date.now();
    const scanNow = new Date();
    console.log(`  ── ${stamp()}  ·  scanning eBay  ·  ${ledger.standing()}`);

    if (callsToday() > DAILY_CALL_ALLOWANCE - CALLS_RESERVE) {
      say(`⚠️  ${callsToday()} API calls today, near the ${DAILY_CALL_ALLOWANCE} allowance — this scan is skipped, the fires keep their calls`);
      return;
    }

    // Two searches for two pools: everything the named sellers list, and —
    // unless the run was told otherwise — every auction under Authenticity
    // Guarantee, whoever sells it. A lot in both is read once.
    const pools: { sellers: string[]; ag: boolean }[] = [{ sellers, ag: false }];
    if (!sellersOnly) pools.push({ sellers: [], ag: true });
    let summaries: ItemSummary[];
    // What each pool turned up, and how much of it the other had already,
    // so the line below can say where the lots came from.
    const fromPool = { sellers: 0, guarantee: 0, both: 0 };
    try {
      const found = new Map<string, ItemSummary>();
      for (const { sellers: list, ag } of pools) {
        const hits = await searchAuctions(app, {
          sellers: list, authenticityGuarantee: ag, zip,
          // Far enough past the reading window that nothing slips through
          // between one scan and the next.
          endsBeforeMs: now() + (ocrBeforeMin + scanEveryMin * 2) * 60_000,
          log: (l) => console.log(l),
        });
        for (const hit of hits) {
          if (found.has(hit.itemId)) fromPool.both++;
          else if (ag) fromPool.guarantee++;
          else fromPool.sellers++;
          found.set(hit.itemId, hit);
        }
      }
      summaries = [...found.values()];
    } catch (err) {
      say(`⚠️  the search failed (${err instanceof Error ? err.message : err}); next scan`);
      return;
    }
    const fresh: ItemRecord[] = [];
    for (const s of summaries) {
      const endsAtMs = parseEndDate(s.itemEndDate);
      if (endsAtMs === null) continue;
      const existing = record(s.itemId);
      if (existing) {
        // The search's view of the bidding is cheap and current; the arm
        // re-reads the item itself before anything is typed.
        if (existing.status === "seen") fresh.push(existing);
        continue;
      }
      const r: ItemRecord = {
        itemId: s.itemId, legacyId: legacyId(s.itemId), url: s.itemWebUrl ?? itemUrl(s.itemId), title: s.title,
        seller: s.seller?.username ?? "", endsAtMs, firstSeenAt: scanNow.toISOString(), status: "seen",
      };
      state.items[s.itemId] = r;
      fresh.push(r);
      touch();
    }
    fresh.sort((a, b) => a.endsAtMs - b.endsAtMs);
    say(`${summaries.length} live auction(s) closing inside the window` +
      `: ${fromPool.sellers} from the named sellers, ${fromPool.guarantee} under Authenticity Guarantee elsewhere` +
      `${fromPool.both > 0 ? `, ${fromPool.both} both` : ""}` +
      ` — ${fresh.length} not yet read`);

    // Listings found by an earlier scan that have since vanished from the
    // search — ended early, or taken down — before they were ever read.
    const inSearch = new Set(summaries.map((s) => s.itemId));
    for (const r of Object.values(state.items)) {
      if ((r.status === "seen" || r.status === "scheduled") && !inSearch.has(r.itemId) && r.endsAtMs < now()) {
        r.status = "skipped"; r.reason = "ended before it was bid on"; touch();
      }
    }

    // 1. The listing itself: item specifics, and the sift no pricing is spent
    //    on. Only lots near their end are read, because reading the label
    //    costs money and a lot three days out is not worth paying for yet.
    const ripe = fresh.filter((r) => r.endsAtMs - now() <= ocrBeforeMin * 60_000);
    const waiting = fresh.length - ripe.length;
    const toRead = ripe.slice(0, detailsPerScan);
    const lots: ScannedLot[] = [];
    const byId = new Map<string, ItemRecord>();
    const readings = new Map<string, CertReading>();
    const counts = { otherSeller: 0, notAg: 0, ungraded: 0, grader: 0, grade: 0, game: 0, noCert: 0, newSet: 0, tooSoon: 0, unread: 0, unreadable: 0, mismatched: 0 };
    const allowed = new Set(sellers.map((s) => s.toLowerCase()));
    for (const r of toRead) {
      if (r.priceTries !== undefined && r.priceTries >= PRICE_SCANS) { reject(r, "Card Uploader never answered for the cert"); continue; }
      let item: Item;
      try {
        item = await app.item(r.itemId);
      } catch (err) {
        counts.unread++;
        r.reason = `could not read the listing: ${err instanceof Error ? err.message : err}`;
        continue;
      }
      const aspects = readAspects(item);
      const endsAtMs = parseEndDate(item.itemEndDate) ?? r.endsAtMs;
      r.endsAtMs = endsAtMs;
      r.title = item.title;
      r.seller = item.seller?.username ?? r.seller;
      r.grader = aspects.grader; r.grade = aspects.grade; r.cert = aspects.cert; r.set = aspects.set; r.language = aspects.language;
      const post = postage(item);
      r.shippingCents = post.cents; r.shippingQuoted = post.quoted;
      touch();

      // A lot earns its place one of two ways: a seller the run was given by
      // name, or eBay's own Authenticity Guarantee. Checked here rather than
      // taken from the search, because eBay's sellers filter, given a
      // username that does not exist, answers with everybody's listings
      // rather than nobody's.
      const named = allowed.has((item.seller?.username ?? "").toLowerCase());
      const guaranteed = authenticityGuaranteed(item);
      if (!named && !guaranteed) {
        if (sellersOnly) {
          counts.otherSeller++;
          reject(r, `sold by ${item.seller?.username || "a seller the listing does not name"}, not one of ours`);
        } else {
          counts.notAg++;
          reject(r, `sold by ${item.seller?.username || "someone the listing does not name"}, who is not one of ours, and not under Authenticity Guarantee`);
        }
        continue;
      }
      if (!GRADERS.includes(aspects.grader as Grader)) {
        // A raw card is not a rival grader's slab, and the guarantee pool is
        // full of them — eBay authenticates ungraded cards too.
        if (aspects.grader) { counts.grader++; reject(r, `graded by ${aspects.grader}`); }
        else { counts.ungraded++; reject(r, "no grader named — a raw card, or a listing that does not say"); }
        continue;
      }
      if (!gradeAllowed(aspects.grader, aspects.grade, grades)) { counts.grade++; reject(r, `${aspects.grader} ${aspects.grade ?? "?"} is outside ${formatGradeRange(grades[aspects.grader as Grader])}`); continue; }
      if (aspects.game && !/pok[eé]mon/i.test(aspects.game)) { counts.game++; reject(r, `game: ${aspects.game}`); continue; }
      const guard = setGuard({ name: aspects.set, language: aspects.language, year: aspects.year, sets, now: scanNow, months: newSetMonths });
      if (guard) { counts.newSet++; reject(r, guard); continue; }
      if (endsAtMs - now() < (armBeforeS + MIN_LEAD_TO_PRICE_S) * 1_000) { counts.tooSoon++; reject(r, "ends too soon to price and identify"); continue; }

      // The cert number. None of these sellers publish one, so it is read off
      // the slab in the photograph — the last free filter has already run, so
      // only lots worth pricing are paid for.
      let cert = aspects.cert;
      if (cert) {
        r.certFrom = "listing";
      } else if (r.cert && r.certFrom === "label") {
        cert = r.cert; // read on an earlier scan; a label does not change
      } else if (ocrOff) {
        counts.noCert++;
        reject(r, "no cert number in the listing and --no-ocr was given");
        continue;
      } else if (ocrBudget.left() <= 0) {
        // Not a rejection: the lot keeps its place and is read tomorrow, or
        // after the next lot to end frees nothing at all.
        r.reason = `the day's ${ocrPerDay} label readings are spent`;
        touch();
        continue;
      } else {
        const images = imageUrls(item).slice(0, OCR_IMAGES_PER_LOT);
        let reading: CertReading | null = null;
        for (const url of images) {
          if (ocrBudget.left() <= 0) break;
          try {
            ocrBudget.spend();
            reading = await certReader.read(url, aspects.grader);
          } catch (err) {
            r.reason = `reading the label failed: ${err instanceof Error ? err.message : err}`;
            reading = null;
            break;
          }
          if (!reading.unreadable) break;
        }
        r.ocrTries = (r.ocrTries ?? 0) + 1;
        touch();
        if (reading === null || reading.unreadable || !reading.cert) {
          if (r.ocrTries >= OCR_ATTEMPTS) {
            counts.unreadable++;
            reject(r, `the cert number could not be read off the slab: ${reading?.unreadable ?? r.reason ?? "no answer"}`);
          }
          continue;
        }
        cert = reading.cert;
        r.certFrom = "label";
        r.certGrade = reading.grade ?? undefined;
        readings.set(r.itemId, reading);
      }
      r.cert = cert;
      touch();

      const lot = toLot(item, { ...aspects, cert });
      lots.push(lot);
      byId.set(lot.listingId, r);
    }
    if (toRead.length > 0) {
      say(`read ${toRead.length}: ${lots.length} PSA/CGC Pokémon slab(s) in range with a cert` +
        ` — dropped ${counts.otherSeller} other seller, ${counts.notAg} not AG, ${counts.ungraded} ungraded, ${counts.grader} other grader, ${counts.grade} out of grade range, ${counts.game} other game, ${counts.noCert} no cert, ${counts.newSet} new set, ${counts.tooSoon} ending too soon, ${counts.unreadable} label unreadable` +
        (counts.unread ? `, ${counts.unread} unreadable (next scan)` : ""));
      say(`${ocrBudget.spentToday()} label(s) read today${ocrPerDay > 0 ? ` of ${ocrPerDay}` : ""}`);
    }
    if (ripe.length > toRead.length) say(`${ripe.length - toRead.length} more ripe for the next scan`);
    if (waiting > 0) say(`${waiting} found but ending more than ${ocrBeforeMin} min out — left until they ripen`);

    // 2. The shared sift: block list, Master Ball rule, one row per cert.
    const selected = selectCandidates(lots, (line) => console.log(line), { chaseList: false });
    for (const { candidate, reason } of selected.rejected) {
      const r = byId.get(candidate.listingId);
      if (r) reject(r, reason);
    }
    // A cert already on the schedule, or bid on, in another listing is the
    // same slab relisted; the earlier listing keeps it.
    const certsInPlay = new Set(Object.values(state.items)
      .filter((i) => i.cert && (i.status === "scheduled" || HOLDING.includes(i.status)))
      .map((i) => `${i.grader}:${i.cert}`));
    const candidates: Candidate[] = [];
    for (const c of selected.candidates) {
      const r = byId.get(c.listingId)!;
      if (certsInPlay.has(`${c.grader}:${c.cert}`)) { reject(r, "same cert already scheduled in an earlier listing"); continue; }
      candidates.push(c);
    }
    if (candidates.length === 0) {
      say(`nothing new to price  ·  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      console.log();
      return;
    }

    // 3. Pricing, identity, the maths — exactly as at the other snipers.
    if (!cuBox.current) {
      console.log(`  ── signing in to Card Uploader`);
      cuBox.current = await openCardUploader({ headed, batchPrefix: BATCH_PREFIX });
    }
    const cu = cuBox.current;
    await refreshCuToken(cu);
    say(`pricing ${candidates.length} candidate(s)`);
    await priceByCert(cu, candidates, { prices, concurrency: PRICE_CONCURRENCY, sweep: false });

    let passed: Row[] = [];
    let survivors: Candidate[] = [];
    for (const c of candidates) {
      const price = prices.get(`${c.grader}:${c.cert}`);
      const r = byId.get(c.listingId)!;
      if (price?.error) {
        // Not an answer: the cert stays "seen" and is priced again next scan.
        r.priceTries = (r.priceTries ?? 0) + 1;
        r.reason = price.error;
        prices.delete(`${c.grader}:${c.cert}`);
        touch();
        continue;
      }
      // The cert against the listing. Card Uploader has now said what this
      // number really is; if that is not the card the listing describes, the
      // number was misread or the listing is wrong, and either way the price
      // belongs to some other card. Dropped, with what disagreed written down.
      if (price?.info) {
        const reading = readings.get(r.itemId);
        const problems = certMismatches(
          { title: r.title, grader: r.grader ?? "", grade: r.grade },
          { grader: reading?.grader ?? r.grader ?? "", grade: reading?.grade ?? r.certGrade ?? null },
          { gradingCompany: price.info.gradingCompany, condition: price.info.condition, description: price.info.description },
        );
        if (problems.length > 0) {
          counts.mismatched++;
          reject(r, `cert ${c.cert} does not answer to the listing — ${problems.join("; ")}`);
          continue;
        }
      }
      const { row, worthy } = evaluate(c, price, scanNow);
      r.marketPrice = row.market_price === "" ? undefined : row.market_price;
      r.salesMedian = row.sales_median === "" ? undefined : row.sales_median;
      if (!worthy) { reject(r, row.reason); continue; }
      passed.push(row);
      survivors.push(c);
    }
    if (counts.mismatched > 0) say(`⚠️  ${counts.mismatched} dropped: the cert did not answer to the listing`);
    say(`${survivors.length} of ${candidates.length} worth identifying`);

    if (survivors.length > 0) {
      let cards = new Map<string, CuCard>();
      try {
        cards = await identifyViaBatch(cu, survivors, BATCH_PREFIX);
      } catch (err) {
        await snapshotFailure(cu.page, outDir);
        say(`✖  identification failed: ${err instanceof Error ? err.message : err} — these lots are not scheduled`);
      }
      for (const [key, card] of cards) {
        const price = prices.get(key);
        if (price) price.card = card;
      }
      passed = survivors.map((c) => evaluate(c, prices.get(`${c.grader}:${c.cert}`), scanNow).row);
    }

    const cut = finalCut(passed);
    for (const row of cut.dropped) {
      const r = byId.get(row.listing_id);
      if (r) reject(r, row.reason);
    }
    let scheduled = 0;
    for (const row of cut.worthy) {
      const r = byId.get(row.listing_id)!;
      if (!ledger.roomToWin()) { reject(r, `the win limit of ${ledger.maxWins} is taken up by what is won or in flight`); continue; }
      const c = survivors.find((s) => s.listingId === row.listing_id)!;
      const card = prices.get(`${c.grader}:${c.cert}`)?.card;
      // The cert's own set, now it is known: the authoritative guardrail.
      if (card) {
        r.set = card.setName || r.set;
        const guard = setGuard({ name: card.setName, language: (card.language as SetLanguage) || (c.language as SetLanguage) || "", year: card.year, sets, now: scanNow, months: newSetMonths });
        if (guard) { counts.newSet++; reject(r, guard); continue; }
      }
      const biddable = toBiddable(row);
      if (!biddable) { reject(r, "not biddable: see flags"); continue; }
      // The tier's all-in is what this card is worth paying in total, postage
      // included, so the postage comes off the hammer rather than being added
      // on top of it.
      const ship = r.shippingCents ?? 0;
      const maxHammer = Math.min(biddable.maxHammerCents, hammerForAllIn(biddable.maxAllInCents, ship));
      if (maxHammer < 1) {
        reject(r, `postage of ${dollars(ship)} leaves nothing under the ${dollars(biddable.maxAllInCents)} max`);
        continue;
      }
      r.status = "scheduled";
      r.reason = undefined;
      r.cardKey = row.card_key || undefined;
      r.tierRule = row.tier_rule;
      r.marketPrice = row.market_price === "" ? undefined : row.market_price;
      r.salesMedian = row.sales_median === "" ? undefined : row.sales_median;
      r.maxHammerCents = maxHammer;
      r.maxAllInCents = biddable.maxAllInCents;
      touch();
      scheduled++;
      const postageNote = ship > 0 ? `, ${dollars(ship)}${r.shippingQuoted === false ? " assumed" : ""} postage off it` : "";
      say(`○  scheduled ${dollars(maxHammer)} max on ${r.legacyId} — ends ${new Date(r.endsAtMs).toLocaleString()} — ${r.grader} ${r.grade} ${row.market_price !== "" ? `basis $${row.market_price}` : ""}${postageNote} — ${r.title}\n       ${r.url}`);
    }
    say(`${scheduled} scheduled this scan  ·  ${((Date.now() - started) / 1000).toFixed(0)}s  ·  ${ledger.standing()}`);
    console.log();
    writeOutputs();
  };

  // ── The arm and the fire ───────────────────────────────────────────────────
  /**
   * One lot, from its arm time to its bid: the listing read once more, the
   * amount worked out against what eBay will take next, the ceiling and the
   * cap checked, the page walked to Confirm, and the click at the fire.
   */
  const arm = async (r: ItemRecord) => {
    arming.add(r.itemId);
    r.status = "armed";
    touch();
    let prepared: PreparedBid | null = null;
    try {
      let item: Item;
      try {
        item = await app.item(r.itemId);
      } catch (err) {
        skip(r, `could not read the listing at the arm: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const endsAtMs = parseEndDate(item.itemEndDate) ?? r.endsAtMs;
      r.endsAtMs = endsAtMs;
      if (endsAtMs <= now()) { skip(r, "ended before it could be bid on"); return; }
      // Postage as the listing says it now — a calculated rate can read
      // differently at the arm than it did at the scan.
      const post = postage(item);
      r.shippingCents = post.cents;
      r.shippingQuoted = post.quoted;
      const maxHammer = Math.min(r.maxHammerCents!, hammerForAllIn(r.maxAllInCents!, post.cents));
      if (maxHammer < 1) { skip(r, `postage of ${dollars(post.cents)} leaves nothing under the ${dollars(r.maxAllInCents!)} max`); return; }
      r.maxHammerCents = maxHammer;
      const quote: Quote = {
        currentBidCents: centsOf(item.currentBidPrice ?? item.price),
        startingPriceCents: 0,
        bidCount: item.bidCount ?? 0,
        minimumNextBidCents: centsOf(item.minimumPriceToBid) || undefined,
      };
      const row: Biddable = {
        listingId: r.itemId, title: r.title, lot: r.legacyId,
        maxHammerCents: maxHammer, maxAllInCents: r.maxAllInCents!,
        currentBidCents: quote.currentBidCents, bidCount: quote.bidCount, cardKey: r.cardKey,
        shippingCents: post.cents,
      };
      const amount = bidAmount(row, quote, EBAY_STEPS);
      if ("skip" in amount) { skip(r, `priced out — ${amount.skip} (${quote.bidCount} bid(s))`); return; }
      const cents = amount.cents;
      const allIn = allInCents(cents, post.cents);
      // Held at the max all-in from here; the ledger already counts this lot
      // as armed, so the check is against what is free besides it.
      if (allIn > ledger.free() + (r.maxAllInCents ?? 0)) { skip(r, `beyond the ceiling — ${dollars(allIn)} all-in with ${dollars(ledger.free() + (r.maxAllInCents ?? 0))} free`); return; }
      // The lot is counted as in flight from the moment it was armed, so the
      // room it takes up is its own: the check is against everything else.
      if (ledger.maxWins > 0 && ledger.bought() + ledger.inFlight() > ledger.maxWins) {
        skip(r, `the win limit of ${ledger.maxWins} is taken up by what is won or already bid on`);
        return;
      }
      if (r.cardKey && ledger.copies(r.cardKey) > maxCopiesPerCard()) { skip(r, `per-card cap: ${maxCopiesPerCard()} of this card already in flight or won`); return; }
      const fireAt = fireAtMs(endsAtMs, fireBeforeS);

      if (!live) {
        r.status = "planned";
        r.bidCents = cents;
        r.bidAt = new Date().toISOString();
        r.resolveAtMs = endsAtMs + OUTCOME_DELAY_S * 1_000;
        r.reason = undefined;
        touch();
        say(`○  would bid ${dollars(cents)} on ${r.legacyId} at ${new Date(fireAt).toLocaleTimeString()} — current ${dollars(quote.currentBidCents)}, ${quote.bidCount} bid(s), next ${dollars(quote.minimumNextBidCents ?? EBAY_STEPS.minimum(quote))} — ${r.title}\n       ${r.url}`);
        return;
      }

      prepared = await session!.prepareBid(row, cents);
      say(`◔  armed ${dollars(cents)} on ${r.legacyId}, firing in ${Math.round((fireAt - now()) / 1000)}s — current ${dollars(quote.currentBidCents)}, ${quote.bidCount} bid(s) — ${r.title}`);
      // The wait, on eBay's clock, in shrinking steps so the click lands on
      // the second asked for rather than up to a second late.
      for (;;) {
        const left = fireAt - now();
        if (left <= 0) break;
        await sleep(Math.min(left, left > 5_000 ? 1_000 : left > 500 ? 200 : 50));
      }
      if (stopping) { skip(r, "the run was stopped before the fire"); await session!.abandon(prepared); prepared = null; return; }
      const result = await session!.confirm(prepared);
      prepared = null;
      r.bidAt = new Date().toISOString();
      r.resolveAtMs = endsAtMs + OUTCOME_DELAY_S * 1_000;
      if (!result.ok) {
        skip(r, `eBay refused the bid: ${result.error}`);
        return;
      }
      r.status = "bid";
      r.bidCents = cents;
      r.bidAnswer = result.answer;
      r.reason = undefined;
      touch();
      say(`●  bid ${dollars(cents)} on ${r.legacyId} ${Math.round((endsAtMs - now()) / 1000)}s before the end — eBay says: ${result.answer} — ${r.title}\n       ${r.url}`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (prepared) { await session?.abandon(prepared).catch(() => {}); }
      if (r.status === "armed") {
        // Whether Confirm was clicked is not known from here: hold the money
        // and let the outcome read say.
        r.status = "bid";
        r.bidCents = r.bidCents ?? EBAY_STEPS.below(r.maxHammerCents ?? 0);
        r.bidAnswer = "unknown";
        r.reason = `the bid may or may not have gone on: ${why}`;
        r.resolveAtMs = r.endsAtMs + OUTCOME_DELAY_S * 1_000;
        touch();
        say(`⚠️  ${r.legacyId}: ${why} — held as bid until the close says\n       ${r.url}`);
      }
    } finally {
      arming.delete(r.itemId);
      touch();
    }
  };

  // ── The outcome ────────────────────────────────────────────────────────────
  /** After the close: won, lost, or asked about again a little later. */
  const resolve = async (r: ItemRecord) => {
    resolving.add(r.itemId);
    try {
      r.resolveTries = (r.resolveTries ?? 0) + 1;
      let finalCents: number | undefined;
      try {
        const item = await app.item(r.itemId);
        finalCents = centsOf(item.currentBidPrice ?? item.price) || undefined;
      } catch { /* the page may still say */ }
      let verdict: "won" | "lost" | "unknown" = "unknown";
      if (session && r.status === "bid") {
        const o = await session.outcome(r.itemId).catch(() => null);
        if (o) {
          if (o.verdict === "won" || o.verdict === "lost") verdict = o.verdict;
          finalCents ??= o.finalCents;
        }
      }
      if (finalCents !== undefined) r.finalCents = finalCents;

      if (r.status === "planned") {
        if (finalCents === undefined) {
          if (r.resolveTries < OUTCOME_ATTEMPTS) { r.resolveAtMs = now() + OUTCOME_RETRY_S * 1_000; return; }
          r.reason = "would have bid; the closing price could not be read";
        } else {
          r.reason = finalCents < (r.bidCents ?? 0)
            ? `would have won at about ${dollars(finalCents)} against a ${dollars(r.bidCents ?? 0)} max`
            : `would have lost: it went for ${dollars(finalCents)}, over the ${dollars(r.bidCents ?? 0)} max`;
        }
        r.resolvedAt = new Date().toISOString();
        r.resolveAtMs = undefined;
        touch();
        say(`${finalCents !== undefined && finalCents < (r.bidCents ?? 0) ? "🏁" : "–"}  ${r.legacyId}: ${r.reason}\n       ${r.url}`);
        return;
      }

      if (verdict === "unknown" && finalCents !== undefined && r.bidCents !== undefined && finalCents > r.bidCents) verdict = "lost";
      if (verdict === "unknown") {
        if (r.resolveTries < OUTCOME_ATTEMPTS) { r.resolveAtMs = now() + OUTCOME_RETRY_S * 1_000; return; }
        r.status = "unknown";
        r.paidAllInCents = allInCents(r.finalCents ?? r.bidCents ?? r.maxHammerCents ?? 0, r.shippingCents ?? 0);
        r.reason = "the close could not be read; counted as won at the bid";
        r.resolvedAt = new Date().toISOString();
        r.resolveAtMs = undefined;
        touch();
        say(`⚠️  ${r.legacyId}: ${r.reason} — check it on eBay\n       ${r.url}`);
        return;
      }
      r.status = verdict;
      r.resolvedAt = new Date().toISOString();
      r.resolveAtMs = undefined;
      if (verdict === "won") {
        r.paidAllInCents = allInCents(finalCents ?? r.bidCents ?? 0, r.shippingCents ?? 0);
        r.reason = undefined;
        say(`🏆 won ${r.legacyId} at ${dollars(finalCents ?? r.bidCents ?? 0)}${r.salesMedian ? ` (${marketPct((r.paidAllInCents) / 100, r.salesMedian)}% of market)` : ""} — ${r.title}\n       ${r.url}`);
      } else {
        r.reason = finalCents !== undefined ? `went for ${dollars(finalCents)} against a ${dollars(r.bidCents ?? 0)} max` : "lost";
        say(`–  lost ${r.legacyId}: ${r.reason}\n       ${r.url}`);
      }
      touch();
      say(ledger.standing());
    } finally {
      resolving.delete(r.itemId);
    }
  };

  // ── The ticker ─────────────────────────────────────────────────────────────
  /** Once a second: what is due to arm, what is due to resolve. Never awaits a scan. */
  const tick = () => {
    const t = now();
    for (const r of Object.values(state.items)) {
      if (r.status === "scheduled" && !arming.has(r.itemId) && t >= armAtMs(r.endsAtMs, armBeforeS)) {
        if (arming.size >= armConcurrency) {
          if (t >= fireAtMs(r.endsAtMs, fireBeforeS) - 10_000) skip(r, `no free browser page in time (${arming.size} armed at once)`);
          continue;
        }
        if (stopping) { skip(r, "the run is stopping"); continue; }
        void arm(r);
      } else if ((r.status === "bid" || r.status === "planned") && r.resolveAtMs !== undefined && !resolving.has(r.itemId) && t >= r.resolveAtMs) {
        void resolve(r);
      }
    }
  };

  const prune = () => {
    const cutoff = now() - KEEP_RESOLVED_DAYS * 86_400_000;
    for (const [id, r] of Object.entries(state.items)) {
      if (r.endsAtMs < cutoff && !HOLDING.includes(r.status) && r.status !== "scheduled") { delete state.items[id]; touch(); }
    }
  };

  // ── Main ───────────────────────────────────────────────────────────────────
  const stopSignal = () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n    stopping — armed bids are let go, bids already on stay on; state is written`);
  };
  process.on("SIGINT", stopSignal);
  process.on("SIGTERM", stopSignal);

  try {
    if (live) {
      console.log(`  ── signing in to eBay`);
      session = await openEbay({ live: true, account, outDir, headless, sessionState });
      console.log();
    }

    await scan();
    if (once) {
      writeOutputs();
      say(`--once: one scan done; ${ledger.standing()}`);
      return;
    }

    const ticker = setInterval(tick, TICK_MS);
    let nextScanAt = Date.now() + scanEveryMin * 60_000;
    let lastHeartbeat = Date.now();
    let lastPrune = Date.now();
    try {
      for (;;) {
        const stop = ledger.stopReason();
        if (stop && arming.size === 0 && resolving.size === 0) {
          console.log(`\n  ── ${stamp()}  ·  ${stop}`);
          break;
        }
        if (stopping && arming.size === 0 && resolving.size === 0) break;

        if (!stopping && !stop && Date.now() >= nextScanAt) {
          // The set list is refreshed on the same cadence as its cache.
          const refreshed = await loadSetReleases({ cachePath: join(outDir, SETS_FILE), log: (l) => console.log(l) }).catch(() => null);
          if (refreshed && refreshed.fetchedAt !== setsFetchedAt) { sets = refreshed.sets; setsFetchedAt = refreshed.fetchedAt; }
          await scan();
          nextScanAt = Date.now() + scanEveryMin * 60_000;
        }
        if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
          const next = Object.values(state.items).filter((i) => i.status === "scheduled").sort((a, b) => a.endsAtMs - b.endsAtMs)[0];
          console.log(`  ── ${stamp()}  ·  ${ledger.standing()}  ·  next fire ${next ? `${new Date(fireAtMs(next.endsAtMs, fireBeforeS)).toLocaleTimeString()} on ${next.legacyId}` : "none scheduled"}  ·  ${callsToday()} API calls today  ·  eBay clock ${app.clockOffsetMs === null ? "unread" : `${app.clockOffsetMs >= 0 ? "+" : ""}${(app.clockOffsetMs / 1000).toFixed(1)}s`}`);
          lastHeartbeat = Date.now();
        }
        if (Date.now() - lastPrune >= 3_600_000) { prune(); lastPrune = Date.now(); }
        if (dirty) writeOutputs();
        await sleep(TICK_MS);
      }
    } finally {
      clearInterval(ticker);
    }

    writeOutputs();
    const items = Object.values(state.items);
    const won = items.filter((i) => i.status === "won");
    console.log(`\n  ── result`);
    for (const w of won) say(`🏆 ${dollars(w.paidAllInCents ?? 0)}  ${w.legacyId}  ${w.title}\n       ${w.url}`);
    say(ledger.standing());
  } catch (err) {
    if (cuBox.current) await snapshotFailure(cuBox.current.page, outDir).catch(() => {});
    if (session) await session.snapshot(join(outDir, "bidder-failure.png")).catch(() => {});
    writeOutputs();
    throw err;
  } finally {
    await certReader.close().catch(() => {});
    await cuBox.current?.close().catch(() => {});
    await session?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEbaySniper().catch((err) => {
    console.error("\neBay sniper failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
