/**
 * The sniper — every part of it that does not care which auction house it is
 * bidding at.
 *
 * One pipeline, end to end: find the Pokémon lots worth bidding on in the
 * auction about to close, price every one of them, and put the bids on all
 * at once at the last sensible moment. The house is a Venue
 * (scripts/fanatics-sniper.ts, scripts/alt-sniper.ts): it scans its own
 * catalogue into ScannedLots and, for a run that signs in, opens an Exchange
 * the book bids through (scripts/sniper-book.ts). Everything in between — the
 * chase list, the tier table, the sales-history rule, Card Uploader pricing
 * and identification, the caps, the CSV, the hold and the fire — is here and
 * is the same at both.
 *
 * The lots are walked in card-priority order — PSA 10 down to 7, then CGC —
 * and priced a batch at a time until every lot on the list has a max bid
 * worked out. Nothing is bid while that happens. A bid placed hours early is
 * a bid the other bidder has hours to answer: on 2026-09-13 at Fanatics, 433
 * bids went on from 4 PM, 189 of them were beaten by someone coming back
 * later in the afternoon, and 28 were won. So the run holds. From half an
 * hour before the fire it re-scans the house every few minutes and notes
 * which lots the room has already taken past our max; at the fire it quotes
 * whatever is left and bids on all of it, eight lots at a time, in about the
 * time one bid used to take. Only then does it watch: it polls the bids it
 * holds until the auction closes, the job is stopped from outside (GitHub
 * cuts a job at six hours), or nothing is open any more. An outbid lot is
 * never raised — one bid per lot, at the max, is the whole method — but a
 * copy of a card the per-card cap held back is bid on once a copy under it is
 * outbid, and a bid the house turned down in the rush is quoted again.
 *
 * When the fire is, and why, is the house's own rule (Venue.fireAfterMinutes,
 * the "fire after" box on the workflow): minutes after extended bidding was
 * scheduled to open. At Fanatics that is 27 — lots close one by one there,
 * and any lot nobody bids on between 7:00 and 7:30 PM PT closes at 7:30
 * sharp, so 7:27 puts our max on the quiet lots three minutes before they
 * close and gives the other bidder on a fought-over lot the five-minute
 * window that follows rather than an evening. At Alt it is 100 — the whole
 * auction extends together there and runs three to five hours past 9 PM ET,
 * so 10:40 PM is late in the night with the auction still safely open; and
 * because it can end the moment a window passes with no bid anywhere, a run
 * there also fires early if the auction's clock reads seconds from its end.
 *
 * Nothing is bid without --live. The default is a plan: everything runs except
 * the bid itself, worked out against the bids the scan reported, with no
 * account at the house involved at all. --quote-only signs in and asks the
 * house where each lot really stands, and still sends nothing.
 *
 * Stages:
 *   1. The venue's scan: every live PSA/CGC 7–10 Pokémon lot in the auction
 *      about to close, with its cert number, title, grade and current bid.
 *   2. The chase-list filter on the title, at a house that has one (Fanatics:
 *      a Weekly Auction is twelve thousand Pokémon lots, most of them bulk; at
 *      Alt every PSA/CGC Pokémon lot in the cycle is a candidate), plus a
 *      block list for things that are graded but are not Pokémon TCG cards
 *      (Topps, Carddass, old maid...).
 *   3. Card Uploader, in two stages, over one batch of candidates at a time.
 *      Every candidate in the batch is priced straight off its cert through
 *      /backend/card-price/cert, which answers for any cert and costs no
 *      credits. That answer carries the recent sales, which is everything the
 *      bid maths reads.
 *   3b. Only the lots that survive that maths are then submitted as a Card
 *      Uploader batch, at 2 credits each, for the structured card identity —
 *      name, set, number, language, population — which is what card_key and the
 *      per-card cap are built from. The batch is deleted afterwards;
 *      a left-over from a crashed run is swept up at the start of the next.
 *   4. Bid maths. What the card is worth is the lowest of its five most
 *      recent sales — not the average, which is a bid that only breaks even.
 *      A lot is worth a bid when the cert resolved, those five sales all fall
 *      inside the last SALES_WINDOW_DAYS, neither that price nor the median
 *      of the same sales is a value no pack can award (the sourcing check:
 *      lib/odds-config.ts unawardableRanges — under $7.50, over $16,925, or
 *      in the hole between two tiers), that price sits inside the tier
 *      table, and the max hammer that comes out is above the current bid. No
 *      more than the per-card cap — --max-copies-per-card, 4 by default — of
 *      one card are winning or won in one auction, whatever their grade or
 *      grader; nothing is read from the database. The median of the same five sales is carried along as the
 *      market value a won lot is measured against in the CSV: what was paid
 *      all-in, as a share of it.
 *   5. Anything the cert disagrees with the listing about — grade, year, set,
 *      language — is dropped rather than bid on with a warning, as is anything
 *      that never identified. The price came from the cert and the competition
 *      is bidding off the title; when those are not the same card, the max bid
 *      is the wrong card's.
 *   6. The hold, the fire, and the watch. scripts/sniper-book.ts holds the
 *      money side: the ceiling, the bid ladder, the fire itself, and the one
 *      rule with money behind it — the amount sent is never above the lot's
 *      max hammer.
 *
 * The run ends with a funnel: every stage's cut, named, in one column, and
 * writes one file worth keeping, <venue>-bids.csv: every lot worth a bid,
 * what was bid and how it ended, and for a lot won what was paid all-in and
 * what share of the card's market value that was. summary.md beside it is the
 * same thing as a page, for the Actions run summary.
 *
 * Flags, the same for every venue:
 *   --budget=10000        a ceiling on what this run may hold at once, all-in
 *                         — not a target; the bids go on down the list as far
 *                         as it reaches. Bids already on the account do not
 *                         count against it (default $10,000)
 *   --fire-after=27       minutes after extended bidding opens to put the
 *                         bids on; the FIRE_AFTER_MINUTES environment variable
 *                         does the same, for a workflow input (default: the
 *                         venue's own — Fanatics 27, Alt 100)
 *   --tiers-psa=…         the tier table for PSA, and --tiers-cgc=… for CGC,
 *                         written as "$7.50-8: flat $5, $8-10: market - $3,
 *                         $10-90: 85%, $90-450: 80%" (see TierTable); the
 *                         TIERS_PSA / TIERS_CGC environment variables do the
 *                         same, for a workflow input. Default: DEFAULT_TIERS
 *   --max-copies-per-card=4  the most lots of one card to be winning or have
 *                         won at once, counted across every grade and both
 *                         graders; the MAX_COPIES_PER_CARD environment
 *                         variable does the same, for a workflow input
 *                         (default DEFAULT_MAX_COPIES_PER_CARD)
 *   --count-existing-bids charge the bids already on the account to --budget:
 *                         a $2,000 run finding $600 of open bids on the
 *                         account has $1,400 to spend, not $2,000. Those lots
 *                         are still left alone, and each one outbid gives its
 *                         share back
 *   --quote-only          sign in and quote every lot, still sending nothing
 *   --live                place the bids, poll, rebid what is outbid
 *   --login               sign in to the house by hand, once, and save the session
 *   --export-session      print the token for the GitHub secret
 *   --email=…             the account this run is for; a saved session
 *                         belonging to anyone else is refused rather than bid with
 *   --password=…          sign in as that account, where the house allows it
 *   --batch=500           certs priced per round (default 250)
 *   --poll=30             seconds between polls of the bids held (default 20)
 *   --max-cards=50        consider only the first 50 candidates
 *   --concurrency=8       gentler on Card Uploader, slower
 *   --headed              watch it work
 *
 * Credits are real money: 2 per PSA/CGC cert, and only the identify stage
 * spends them, on the lots that survive the maths rather than the chase list.
 * Every survivor is identified, because every survivor may be bid on before
 * the night is out; the funnel says how many that was.
 *
 * Required environment (read from .env.local or the real environment):
 *   CARDUPLOADER_EMAIL, CARDUPLOADER_PASSWORD
 * plus whatever the venue needs to sign in — see its file.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  BASE as CU_BASE,
  HISTORY_URL as CU_HISTORY_URL,
  MAX_CERTS_PER_BATCH,
  SESSION_DIR,
  batchName,
  createBatch,
  deleteBatch,
  ensureLoggedIn,
  listBatches,
  loadEnvLocal,
  pstDate,
} from "./carduploader-batch";
import {
  BUYERS_PREMIUM,
  BidBook,
  DEFAULT_BUDGET_DOLLARS,
  bidAmount,
  dollars,
  type AuctionState,
  type Biddable,
  type BidSteps,
  type CardCaps,
  type Exchange,
  type Log,
  type PlacedBid,
} from "./sniper-book";
import { unawardableReason } from "@/lib/odds-config";
import {
  MIN_SALES,
  SALES_WINDOW_DAYS,
  marketPrice,
  recentSales,
  salesGate,
  salesMedian,
  type Sale,
} from "./cert-price";

export { BUYERS_PREMIUM };

// The sales rule and the price that comes out of it are shared with
// scripts/verify-prices.ts and live in ./cert-price; every caller of the
// sniper reads them from here, as they always have.
export { MIN_SALES, SALES_WINDOW_DAYS, marketPrice, recentSales, salesGate, salesMedian, type Sale };

// ── Configuration ─────────────────────────────────────────────────────────────

/** Only graders the tier table covers. BGS/SGC lots are skipped, not priced. */
export const GRADERS = ["PSA", "CGC"] as const;
export type Grader = (typeof GRADERS)[number];

/** The grades chased; 7–10 is every half-step from 7 up. */
export const GRADES = [7, 7.5, 8, 8.5, 9, 9.5, 10];

/**
 * The most to pay for a lot, by what its card is worth: the tier table.
 *
 * Two kinds of rule sit in it. A `share` is all-in — hammer plus the 20%
 * buyer's premium — so the number to actually bid is that share divided by
 * 1.2. A `flat` or `offset` rule is the bid itself with the premium on top,
 * because that is how those two were given.
 *
 * Bands run [previous ceiling, upTo), the last one inclusive at the top, and
 * the first one starts at the grader's floor. A card worth less than the
 * floor, or more than the last band's ceiling, is not bid on at all — the
 * floor is what keeps a flat $5 off a card worth $1. The bands were given as
 * "$6–7" and "$8–10"; the flat $5 runs to $8 rather than $7 so there is no
 * hole between them, and it joins smoothly — at $8 the next rule, market −
 * $3, is also $5. The floor rose from $6 to $7.50 with odds v6: the pack
 * ladder (lib/odds-config.ts unawardableRanges) starts at $7.50, so a cheaper
 * card is a slab no pack could ever award. The sourcing check in evaluate()
 * enforces that whatever table a run is given; the default floor simply
 * agrees with it.
 *
 * DEFAULT_TIERS is what a run uses unless told otherwise. A run is told with
 * --tiers-psa / --tiers-cgc, or TIERS_PSA / TIERS_CGC in the environment (the
 * workflow inputs), written the way formatTiers() prints it — a $7.50 floor
 * prints as "$7.5", and either spelling reads back:
 *
 *     $7.50-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%
 *
 * Each band is "<from>-<to>: <rule>"; the bands have to touch; the rule is
 * "flat $N" (bid N), "market - $N" (bid N under what the card is worth) or
 * "N%" (pay N% of what the card is worth, all-in). The first band's "from"
 * is the floor.
 */
export type BidRule =
  /** Pay this share of what the card is worth, all-in. */
  | { kind: "share"; share: number }
  /** Bid exactly this, premium on top. */
  | { kind: "flat"; hammer: number }
  /** Bid what the card is worth less this, premium on top. */
  | { kind: "offset"; less: number };

export type TierBand = { upTo: number; rule: BidRule };
export type GraderTiers = { floor: number; bands: TierBand[] };
export type TierTable = Record<Grader, GraderTiers>;

export const DEFAULT_TIERS: TierTable = {
  CGC: { floor: 7.5, bands: [
    { upTo: 8,   rule: { kind: "flat",   hammer: 5 } },
    { upTo: 10,  rule: { kind: "offset", less: 3 } },
    { upTo: 90,  rule: { kind: "share",  share: 0.77 } },
    { upTo: 450, rule: { kind: "share",  share: 0.70 } },
  ] },
  PSA: { floor: 7.5, bands: [
    { upTo: 8,   rule: { kind: "flat",   hammer: 5 } },
    { upTo: 10,  rule: { kind: "offset", less: 3 } },
    { upTo: 90,  rule: { kind: "share",  share: 0.85 } },
    { upTo: 450, rule: { kind: "share",  share: 0.80 } },
  ] },
};

let activeTiers: TierTable = DEFAULT_TIERS;

/** The tier table this run bids by. */
export function tierTable(): TierTable {
  return activeTiers;
}

/** Bid by this table from now on — what a run does with --tiers-psa / --tiers-cgc. */
export function setTierTable(table: TierTable): void {
  activeTiers = table;
}

/** "flat $5", "market - $3", "85%" — a rule as the table is written. */
export function ruleText(rule: BidRule): string {
  switch (rule.kind) {
    case "flat": return `flat $${rule.hammer}`;
    case "offset": return `market - $${rule.less}`;
    case "share": return `${Math.round(rule.share * 1000) / 10}%`;
  }
}

/** A grader's table as one line, the way parseTiers() reads it back. */
export function formatTiers(tiers: GraderTiers): string {
  let from = tiers.floor;
  return tiers.bands.map((b) => {
    const text = `$${from}-${b.upTo}: ${ruleText(b.rule)}`;
    from = b.upTo;
    return text;
  }).join(", ");
}

function parseRule(text: string, band: string): BidRule {
  let m: RegExpExecArray | null;
  if ((m = /^flat\s*\$?\s*([\d.]+)$/i.exec(text))) {
    const hammer = Number(m[1]);
    if (!(hammer >= 1)) throw new Error(`"${band}": a flat bid has to be at least $1`);
    return { kind: "flat", hammer };
  }
  if ((m = /^market\s*[-−–]\s*\$?\s*([\d.]+)$/i.exec(text))) {
    const less = Number(m[1]);
    if (!(less >= 0)) throw new Error(`"${band}": market - $N needs a number`);
    return { kind: "offset", less };
  }
  if ((m = /^([\d.]+)\s*%$/.exec(text))) {
    const share = Number(m[1]) / 100;
    if (!(share > 0 && share <= 2)) throw new Error(`"${band}": a share has to be between 0% and 200%`);
    return { kind: "share", share };
  }
  throw new Error(`cannot read the rule "${text}" in "${band}": want "flat $5", "market - $3" or "85%"`);
}

/**
 * A grader's table from one line: "$7.50-8: flat $5, $8-10: market - $3,
 * $10-90: 85%, $90-450: 80%". Bands are separated by commas or semicolons,
 * have to run upward and touch, and the first one's start is the floor.
 * Anything it cannot read is an error naming the band, not a guess.
 */
export function parseTiers(text: string): GraderTiers {
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`a tier table needs at least one band, got "${text}"`);
  let floor: number | null = null;
  const bands: TierBand[] = [];
  for (const part of parts) {
    const m = /^\$?\s*([\d.]+)\s*[-–]\s*\$?\s*([\d.]+)\s*:\s*(.+)$/.exec(part);
    if (!m) throw new Error(`cannot read the band "${part}": want "<from>-<to>: <rule>", e.g. "$10-90: 85%"`);
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (!(from >= 0) || !(to > from)) throw new Error(`the band "${part}" does not run upward`);
    const previous = bands.length > 0 ? bands[bands.length - 1].upTo : null;
    if (previous === null) floor = from;
    else if (previous !== from) throw new Error(`the band "${part}" starts at $${from} but the one before it ends at $${previous} — bands have to touch`);
    bands.push({ upTo: to, rule: parseRule(m[3].trim(), part) });
  }
  return { floor: floor as number, bands };
}

/**
 * The table a run was given, grader by grader: the flag, else the environment
 * variable, else the default. A table that cannot be read stops the run here,
 * before anything is scanned, with the grader and the band named.
 */
export function tiersFromArgs(env: Record<string, string | undefined> = process.env): TierTable {
  const table = { ...DEFAULT_TIERS };
  for (const grader of GRADERS) {
    const text = opt(`tiers-${grader.toLowerCase()}`, env[`TIERS_${grader}`] ?? "").trim();
    if (!text) continue;
    try {
      table[grader] = parseTiers(text);
    } catch (err) {
      throw new Error(`the ${grader} tier table could not be read: ${err instanceof Error ? err.message : err}`);
    }
  }
  return table;
}

/**
 * The most lots of one card to be winning or have won in one auction — the
 * card being name, set, number and language, whatever the grade or grader.
 * Counted live by the book: an outbid copy makes room for the next.
 *
 * DEFAULT_MAX_COPIES_PER_CARD is what a run uses unless told otherwise. A run
 * is told with --max-copies-per-card=N, or MAX_COPIES_PER_CARD in the
 * environment (the workflow input). The cap is one number for the card: the
 * copies are counted across every grade and both graders, so four PSA 9s and
 * a CGC 10 of the same card are five copies, not two piles.
 */
export const DEFAULT_MAX_COPIES_PER_CARD = 4;

let activeMaxCopies = DEFAULT_MAX_COPIES_PER_CARD;

/** The per-card cap this run bids under. */
export function maxCopiesPerCard(): number {
  return activeMaxCopies;
}

/** Cap at this many copies of a card from now on — what --max-copies-per-card does. */
export function setMaxCopiesPerCard(copies: number): void {
  activeMaxCopies = copies;
}

/**
 * The cap a run was given: the flag, else the environment variable, else the
 * default. Anything that is not a whole number of at least 1 stops the run
 * here, before anything is scanned, rather than being rounded into a guess.
 */
export function maxCopiesFromArgs(env: Record<string, string | undefined> = process.env): number {
  const text = opt("max-copies-per-card", env.MAX_COPIES_PER_CARD ?? "").trim();
  if (!text) return DEFAULT_MAX_COPIES_PER_CARD;
  const copies = Number(text);
  if (!Number.isInteger(copies) || copies < 1) {
    throw new Error(`--max-copies-per-card must be a whole number of at least 1, got "${text}"`);
  }
  return copies;
}

/**
 * When the bids go on, as this run was told: --fire-after, else the
 * FIRE_AFTER_MINUTES environment variable, else the venue's own default.
 * Minutes after extended bidding was scheduled to open; 0 is the open itself.
 * Anything that is not a number of minutes stops the run before the scan.
 */
export function fireAfterFromArgs(defaultMinutes: number, env: Record<string, string | undefined> = process.env): number {
  const text = opt("fire-after", env.FIRE_AFTER_MINUTES ?? "").trim();
  if (!text) return defaultMinutes;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`--fire-after must be a number of minutes, 0 or more, got "${text}"`);
  }
  return minutes;
}

/** The moment the bids go on: so many minutes after extended bidding was scheduled to open. */
export function fireAtUnixS(scheduledOpenUnixS: number, fireAfterMinutes: number): number {
  return scheduledOpenUnixS + Math.round(fireAfterMinutes * 60);
}

/**
 * Whether the bids should go on now.
 *
 * At the fire time, yes. Before it, only at a house that ends the whole
 * auction together, and only when its own clock — the end that every bid
 * pushes out — reads DEADMAN_S or less from now with extended bidding under
 * way: a window about to pass with no bid anywhere is the auction about to
 * close, and the bids have to be on before that. A house whose lots close one
 * by one has no such moment; its end never moves.
 */
export function timeToFire(opts: { nowUnixS: number; fireAtUnixS: number; closesTogether: boolean; auction: Pick<AuctionState, "status" | "endsAtUnixS"> | null }): { fire: true; why: string } | { fire: false } {
  if (opts.nowUnixS >= opts.fireAtUnixS) return { fire: true, why: "the fire time" };
  const a = opts.auction;
  if (opts.closesTogether && a && a.status === "EXTENDED_BIDDING" && a.endsAtUnixS > 0) {
    const left = a.endsAtUnixS - opts.nowUnixS;
    if (left <= DEADMAN_S) return { fire: true, why: `the auction's clock reads ${Math.max(0, left)}s from the end` };
  }
  return { fire: false };
}

/**
 * Why a lot is not worth quoting at the fire, from a re-scan's snapshot of its
 * bidding: the least the house would take next is already past our max. Null
 * while a bid at or under the max is still possible. The snapshot has no
 * starting price, so a lot with no bids yet is always still possible — which
 * is the fail-open way round.
 */
export function pricedOut(row: Pick<Biddable, "maxHammerCents">, snapshot: { currentBidCents: number; bidCount: number }, steps: BidSteps): string | null {
  const amount = bidAmount(row, { currentBidCents: snapshot.currentBidCents, startingPriceCents: 0, bidCount: snapshot.bidCount }, steps);
  return "skip" in amount ? amount.skip : null;
}

/**
 * Cert price lookups in flight at once. They cost no credits.
 *
 * Measured on 2026-09-07 against the live backend, 240 certs a level, one
 * level after another: 16 in flight priced 1.2/s, 32 priced 2.5/s, 64 priced
 * 2.8/s and 96 priced 5.5/s — with the fewest failures at 96 (3 of 240) and
 * the median answer still under a second there. The endpoint is not slow
 * under load; it is slow on one cert in ten, which takes 35–42 s whatever
 * else is going on, so throughput is simply how many of those can be waited
 * on at once. A 7,000-cert chase list is ~20 minutes at this setting.
 */
const PRICE_CONCURRENCY = 96;
/** The slow tail above sits at 42 s; a minute leaves it room without waiting on a dead one for long. */
const CU_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Tries a cert gets in one run, sweeps included.
 *
 * Card Uploader goes quiet for minutes at a time rather than failing outright,
 * and a lookup costs nothing, so patience is cheap.
 */
const PRICE_ATTEMPTS = 5;
/** Of those, how many are spent in one pass before the cert is left for a sweep. */
const PRICE_ATTEMPTS_PER_PASS = 2;
/**
 * The first retry sweep waits this long before it starts; each sweep after
 * doubles it. The sweeps run once, after the whole list has been priced — a
 * round never waits on its own stragglers, since a cert that has not answered
 * is no reason to hold the next two hundred that would.
 */
const PRICE_RETRY_WAIT_MS = 30_000;
/** The most the sweeps may take, all told. Whatever is still unanswered is left unpriced. */
const PRICE_RETRY_MAX_MS = 10 * 60_000;
/** Batches that may fail back-to-back before the run gives up on the whole queue. */
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
/**
 * How often an identify job is asked whether it is done, and how long it is
 * given. Card Uploader resolved two certs in under a second and thirty-odd in
 * about a minute; the deadline is for a grader API that has stopped answering.
 */
const JOB_POLL_MS = 2_000;
const JOB_TIMEOUT_MS = 10 * 60_000;
/**
 * Certs that never answered are swept once more after the main pass, at a
 * quarter of the concurrency. The failures come in bursts when the backend is
 * loaded, so the certs that time out are mostly fine — they were unlucky in
 * their moment. Retrying them once the sweep is over, gently, recovers most.
 */
const PRICE_RETRY_CONCURRENCY_DIVISOR = 4;

/** Survivors quoted at the house at once, before the credits are spent on them. */
const QUOTE_CONCURRENCY = 4;

/** 0 = every candidate. Pricing is free, so there is no reason to cap it. */
const DEFAULT_MAX_CARDS = 0;

/**
 * Candidates priced per round.
 *
 * A round is a pass of lookups, a Card Uploader job for the survivors, and a
 * bidding pass. Bigger rounds mean fewer jobs and less per-job overhead; a
 * round is also the time between bidding passes, and the bids are watched
 * while the job runs anyway. 400 is a minute or so of lookups at the measured
 * rate, and at the survival rates seen — four in five at the top of the list,
 * fewer further down — its survivors fit one or two jobs under the 200-cert
 * cap. Near the close the round shrinks to EXTENDED_BATCH.
 */
const DEFAULT_BATCH = 400;

/**
 * Inside this long to the close, a round is shortened to EXTENDED_BATCH so the
 * bids are looked at between rounds rather than only at their ends.
 */
const NEAR_CLOSE_S = 1_200;

/**
 * Seconds between polls of the bids being held — the pace when the auction is
 * an hour or so from closing. pollDelayS moves either side of it.
 */
const DEFAULT_POLL_S = 20;
const MIN_POLL_S = 5;

/** More than this far out, nothing is about to close: look a third as often. */
const POLL_FAR_S = 3_600;
const POLL_FAR_MULTIPLIER = 3;
/** Inside this, the close is near enough to be worth double the attention. */
const POLL_NEAR_S = 900;
const POLL_NEAR_DIVISOR = 2;
/**
 * Extended bidding runs in short windows and a lot can be gone at the end of
 * one, so this is the part of the evening the whole run exists for.
 */
const POLL_EXTENDED_DIVISOR = 4;

/**
 * If a batch does have to be priced near the close or during extended bidding,
 * keep it short: pricing means waiting on Card Uploader to resolve a batch of
 * certs, which can take minutes, and those are minutes the bids are not being
 * watched.
 */
const EXTENDED_BATCH = 50;

/**
 * Card Uploader's bearer is renewed by loading its dashboard again. When the
 * token carries an expiry, that happens this close to it; when it does not,
 * every CU_TOKEN_REFRESH_MS regardless.
 */
const CU_TOKEN_MARGIN_S = 180;
const CU_TOKEN_REFRESH_MS = 10 * 60_000;

/**
 * How long the hold goes without saying anything.
 *
 * A run can sit on its bids for six hours. Every poll speaks when something
 * moved; when nothing has, it still says where things stand this often, so the
 * log shows a run that is alive and waiting rather than one that has hung.
 */
const HEARTBEAT_MS = 5 * 60_000;

// ── The fire ──────────────────────────────────────────────────────────────────

/**
 * The re-scans of the house — the same scan as at the start, without the
 * certs — begin this long before the fire and repeat this often. Each one says
 * where every priced lot's bidding stands, so the run knows how much of its
 * list the room has already taken past the max, and the fire has fewer lots to
 * quote.
 */
const RESCAN_FROM_S = 30 * 60;
const RESCAN_EVERY_S = 5 * 60;
/**
 * Lots quoted and bid at once at the fire. One at a time is 0.66 s a lot,
 * measured on 2026-09-13 — ten minutes for a 900-lot list, against a
 * three-minute cliff at Fanatics. Eight at once is well under a minute.
 */
const FIRE_CONCURRENCY = 8;
/**
 * At a house that ends the whole auction together (Alt), the bids go on the
 * moment its clock reads this close to the end, whatever the time: a quiet
 * window there closes every lot at once, and a run still holding would have
 * bid on nothing. Read against a 15-second window, so kept well under it.
 */
const DEADMAN_S = 8;
/** How often that clock is read while holding once extended bidding is on. */
const HOLD_POLL_EXTENDED_S = 3;
/** And otherwise: nothing can end, so once a minute is plenty. */
const HOLD_POLL_S = 60;

// ── Chase list ────────────────────────────────────────────────────────────────

/**
 * Title patterns worth pricing. Short codes (AR, SIR, MHR...) are matched
 * case-sensitively so "Sir" or "ma" in a name never counts; everything else is
 * case-insensitive because titles come in both Title Case and CAPS.
 *
 * "V" is the awkward one: it must catch "Giratina V #186" but not "#V" (an
 * Unown), "V-UNION", "VMAX" or "VSTAR".
 */
export const CHASE_LIST: { name: string; test: (title: string) => boolean }[] = [
  { name: "AR",              test: (t) => /\bAR\b/.test(t) },
  { name: "IR",              test: (t) => /\bIR\b/.test(t) },
  { name: "SIR",             test: (t) => /\bSIR\b/.test(t) },
  { name: "SAR",             test: (t) => /\bSAR\b/.test(t) },
  { name: "Full Art",        test: (t) => /\bfull[\s-]?art\b|\bFA\b/i.test(t) },
  { name: "Promo",           test: (t) => /\bpromos?\b/i.test(t) },
  { name: "GX",              test: (t) => /\bGX\b/i.test(t) },
  { name: "VSTAR",           test: (t) => /\bV-?STAR\b/i.test(t) },
  { name: "V",               test: (t) => /(?<![#\w-])V(?![\w-])/.test(t) },
  { name: "Tag Team",        test: (t) => /\btag[\s-]?team\b/i.test(t) },
  { name: "Rainbow Rare",    test: (t) => /\brainbow\b/i.test(t) },
  { name: "MHR",             test: (t) => /\bMHR\b/.test(t) },
  { name: "CHR",             test: (t) => /\bCHR\b/.test(t) },
  { name: "MUR",             test: (t) => /\bMUR\b/.test(t) },
  { name: "MA",              test: (t) => /\bMA\b/.test(t) },
  { name: "VMAX",            test: (t) => /\bVMAX\b/i.test(t) },
  { name: "Alt Art",         test: (t) => /\balt(?:ernate)?[\s-]?art\b/i.test(t) },
  { name: "Trainer Gallery", test: (t) => /\btrainer[\s-]?gallery\b|\bTG\d{2}\b/i.test(t) },
  { name: "Master Ball",     test: (t) => /\bmaster[\s-]?ball\b/i.test(t) },
  { name: "Celebrations",    test: (t) => /\bcelebrations\b/i.test(t) },
  { name: "1st Edition Holo", test: (t) => /\b1st[\s-]?ed(?:ition)?\b/i.test(t) && /\bholo\b/i.test(t) },
  { name: "XY Evolutions",   test: (t) => /\bevolutions\b/i.test(t) },
  { name: "Jungle",          test: (t) => /\bjungle\b/i.test(t) },
  { name: "Fossil",          test: (t) => /\bfossil\b/i.test(t) },
  { name: "Gym Heroes",      test: (t) => /\bgym[\s-]?heroes\b/i.test(t) },
];

/**
 * Graded, Pokémon, and still not a TCG card. Anything matching is dropped
 * before pricing, so a false positive here costs a lot that would have been
 * worth a look — keep it to things that are unambiguously not cards.
 */
export const BLOCK_LIST: RegExp[] = [
  /\bold[\s-]?maid\b/i,
  /\bplaying[\s-]?cards?\b/i,
  /\bpoker\b/i,
  /\bmenko\b/i,
  /\bcarddass\b/i,
  /\bbandai\b/i,
  /\btopps\b/i,
  /\bamada\b/i,
  /\bmeiji\b/i,
  /\blamincards?\b/i,
  /\bpanini\b/i,
  /\bburger[\s-]?king\b/i,
  /\bstickers?\b/i,
  /\bcoins?\b/i,
  /\bpogs?\b/i,
  /\btazos?\b/i,
  /\bfigures?\b/i,
  /\bplush\b/i,
  /\bkeychain\b/i,
  /\bsealed\b/i,
  /\bbooster\b/i,
  /\bblister\b/i,
  /\blot of\b/i,
];

/** Every chase-list entry the title satisfies, in list order. */
export function matchKeywords(title: string): string[] {
  return CHASE_LIST.filter((k) => k.test(title)).map((k) => k.name);
}

/** The block-list pattern the title trips, if any. */
export function blockedBy(title: string): string | null {
  const hit = BLOCK_LIST.find((re) => re.test(title));
  return hit ? hit.source : null;
}

/** The three things about a lot the ordering and the gates read. */
export type Graded = {
  grade?: number;
  gradingService?: string;
  title: string;
  /** Known outright at a house whose catalogue says so; otherwise read off the title. */
  pristine?: boolean;
};

/** A CGC 10 that is Pristine rather than Gem Mint. */
export function isPristine(lot: Graded): boolean {
  return lot.pristine ?? /\bpristine\b/i.test(lot.title);
}

/**
 * Master Ball reverse holos are chased in one condition only: PSA 10, or a
 * CGC 10 that is Pristine rather than Gem Mint. Everything else on the chase
 * list is taken at any grade in range.
 */
export function masterBallAllowed(lot: Graded): boolean {
  if (lot.grade !== 10) return false;
  if (lot.gradingService === "PSA") return true;
  return isPristine(lot);
}

/**
 * Where a lot sits in the order lots are worked down, lowest first: every PSA
 * slab from 10 down to 7, then CGC Pristine 10, then CGC Gem Mint 10, then CGC
 * 9.5 down to 7. Half-grades take their place in the run.
 *
 * It decides two things — which certs the --max-cards budget is spent on, and
 * the order of the rows in the CSV.
 */
export function priorityRank(lot: Graded): number {
  const grade = lot.grade ?? 0;
  const band =
    lot.gradingService === "PSA" ? 0
      : grade === 10 ? (isPristine(lot) ? 1 : 2)
        : 3;
  // Grades run 7–10 in half steps, so the grade part spans 0–6 and a band
  // never reaches into the next.
  return band * 10 + (10 - grade) * 2;
}

// ── Card identity ─────────────────────────────────────────────────────────────

/**
 * The key two copies of one card share: name, set, number and language. A
 * Japanese print and an English one are different cards; two grades of the
 * same print are not, because the caps were given per card rather than per
 * grade.
 *
 * Both sides of the comparison start at Card Uploader — the card rows in the
 * database are imported from its export — so the strings already agree, and
 * flattening case, spacing and punctuation is belt and braces.
 */
export function cardKey(parts: { cardName: string; setName: string; cardNumber: string; language?: string }): string {
  const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();
  return [parts.cardName, parts.setName, parts.cardNumber, parts.language].map(norm).join("|");
}

// ── Bid maths ─────────────────────────────────────────────────────────────────

/** The rule for a card worth `price` at this grader, or null outside the table. */
export function tierFor(grader: Grader, price: number, table: TierTable = tierTable()): BidRule | null {
  const { floor, bands } = table[grader];
  if (!(price >= floor)) return null;
  for (const [i, band] of bands.entries()) {
    // "$90–450" reads as inclusive at the top; every other boundary is the
    // next band's floor.
    const last = i === bands.length - 1;
    if (last ? price <= band.upTo : price < band.upTo) return band.rule;
  }
  return null;
}

/** The least a card can be worth and still be bid on at this grader. */
export function tierFloor(grader: Grader, table: TierTable = tierTable()): number {
  return table[grader].floor;
}

/** The most a card can be worth and still be bid on at this grader. */
export function tierCeiling(grader: Grader, table: TierTable = tierTable()): number {
  const { bands } = table[grader];
  return bands[bands.length - 1].upTo;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What one rule bids on a card worth `price`: the hammer and what it costs
 * all-in, or null when the rule comes to less than a dollar.
 *
 * The number typed into the house is the hammer price, so both that and what
 * it costs all-in come back. Hammer rounds down to a whole dollar: the houses
 * bid in whole dollars and rounding up would breach the rule.
 */
export function applyRule(
  tier: BidRule,
  price: number,
): { rule: string; share: number | null; allIn: number; hammer: number } | null {
  let share: number | null = null;
  let rule: string;
  let hammer: number;
  let allIn: number;

  switch (tier.kind) {
    case "flat":
      rule = `flat $${tier.hammer}`;
      hammer = tier.hammer;
      allIn = round2(hammer * (1 + BUYERS_PREMIUM));
      break;
    case "offset":
      rule = `market - $${tier.less}`;
      hammer = Math.floor(price - tier.less);
      allIn = round2(hammer * (1 + BUYERS_PREMIUM));
      break;
    case "share":
      share = tier.share;
      rule = `${Math.round(tier.share * 1000) / 10}% all-in`;
      allIn = round2(price * tier.share);
      hammer = Math.floor(allIn / (1 + BUYERS_PREMIUM));
      break;
  }

  if (hammer < 1) return null;
  return { rule, share, allIn, hammer };
}

/** The most to pay for a lot whose card is worth `price`, under the table in force. */
export function maxBid(
  grader: Grader,
  price: number,
  table: TierTable = tierTable(),
): { rule: string; share: number | null; allIn: number; hammer: number } | null {
  const tier = tierFor(grader, price, table);
  return tier ? applyRule(tier, price) : null;
}

/**
 * What a lot cost as a share of the card's market value, in percent to one
 * decimal: $48 paid on a card whose median sale is $100 is 48%.
 */
export function marketPct(paidAllIn: number, median: number): number | "" {
  if (!(median > 0) || !(paidAllIn >= 0)) return "";
  return Math.round((paidAllIn / median) * 1000) / 10;
}

/**
 * The sourcing check: whether a lot's card is one a pack could ever award.
 *
 * The packs award cards by value against the ladder in lib/odds-config.ts, and
 * the ladder has holes — below $7.50, above $16,925, and between Gaia's
 * jackpot ceiling and Infernal's jackpot floor. A slab worth a value in a hole
 * would sit in the vault unawardable, so it is not bought. Two figures are
 * asked about: the sales median, which stands in for the appraisal the card
 * would be given once imported, and the bid basis — the lowest recent sale —
 * which is what the bid is priced from. Either one in a hole fails the lot,
 * whatever tier table the run was given. Dollars are rounded to whole cents
 * before the ladder is asked.
 *
 * Returns why, naming the figure, or null when both are awardable.
 */
export function unawardableLotReason(lot: { medianDollars: number | null; basisDollars: number | null }): string | null {
  const figures: [string, number | null][] = [
    ["sales median", lot.medianDollars],
    ["bid basis (lowest sale)", lot.basisDollars],
  ];
  for (const [figure, value] of figures) {
    if (value === null || !Number.isFinite(value)) continue;
    const reason = unawardableReason(Math.round(value * 100));
    if (reason) return `${figure} $${value}: ${reason}`;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * `fn` over every item, at most `limit` in flight, results in the items' own
 * order. An item that throws fails the whole call, as Promise.all would.
 */
export async function parallel<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A command-line `--name=value`, or the fallback. */
export function opt(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function runStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}_${p(now.getUTCHours())}${p(now.getUTCMinutes())}Z`;
}

/** Unix seconds as "Sun Sep 6, 7:00 PM PT", in the house's own time zone. */
export function fmtLocal(unixS: number, timeZone: string, zoneLabel: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(unixS * 1000)) + ` ${zoneLabel}`;
}

/** Wall clock where the auction is, which is the clock every timestamp here uses. */
function localClock(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
}

function since(startedMs: number): string {
  const s = Math.round((Date.now() - startedMs) / 1_000);
  return s < 90 ? `${s}s` : s < 5_400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

/**
 * How long until the lots close, in words.
 *
 * The time on a lot is when extended bidding opens, not when it ends: from then
 * on every bid pushes the close out again, so past that point the honest answer
 * is that it is open until it is not.
 */
function untilClose(closesAtUnixS: number): string {
  const left = closesAtUnixS - Math.floor(Date.now() / 1_000);
  if (left <= 0) return "extended bidding";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return `${h > 0 ? `${h}h ` : ""}${m}m to extended bidding`;
}

// ── Candidates ────────────────────────────────────────────────────────────────

/** One lot as a venue's scan reports it: everything the pipeline reads, and nothing the house calls it. */
export type ScannedLot = {
  /** The id the house bids by. */
  listingId: string;
  /** The lot's page. */
  url: string;
  title: string;
  /** PSA, CGC, BGS… — only GRADERS are priced. */
  grader: string;
  grade?: number;
  /** See Graded.pristine. */
  pristine?: boolean;
  /** The slab's cert number; a lot without one cannot be priced. */
  cert: string;
  /** Dollars. */
  currentBid: number;
  bidCount: number;
  /** The auction's name and the lot's number, for the CSV. */
  auction: string;
  lot: string;
  language: "English" | "Japanese" | "";
  /** Unix seconds; when extended bidding starts for this lot's auction. */
  closesAtUnixS?: number;
};

export type Candidate = ScannedLot & {
  grader: Grader;
  keywords: string[];
};

/** A block-list regex as the words it matches: `\bplaying[\s-]?cards?\b` → "playing cards". */
export function prettyPattern(source: string): string {
  return source
    .replace(/\\b/g, "")
    .replace(/\[[^\]]*\]\??/g, " ")
    .replace(/[?*+()]/g, "")
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type SelectionCounts = {
  offChaseList: number;
  noCert: number;
  blockList: number;
  blockListDetail: string;
  masterBallOrDuplicate: number;
};

/**
 * Narrows the scan to what is worth spending credits on: a cert to price by, a
 * chase-list match where the venue wants one, nothing on the block list, one
 * row per slab.
 *
 * Lots that matched the chase list but were then dropped — block list, the
 * Master Ball grade gate, a repeated cert — come back as rejections so they
 * show up in the summary with a reason; a block-list pattern that is too broad
 * is only ever caught by someone reading what it removed. The thousands of
 * lots that simply are not on the chase list are counted, not listed.
 *
 * With `chaseList: false` (Alt) every PSA/CGC lot is a candidate whatever its
 * title says; the keywords are still read, for the record, and the Master
 * Ball gate and the block list still apply.
 */
export function selectCandidates(
  lots: ScannedLot[],
  log: (line: string) => void,
  opts: { chaseList?: boolean } = {},
): {
  candidates: Candidate[];
  rejected: { candidate: Candidate; reason: string }[];
  counts: SelectionCounts;
} {
  const chaseList = opts.chaseList ?? true;
  const dropped = { noCert: 0, noMatch: 0 };
  const blocked = new Map<string, number>();
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const rejected: { candidate: Candidate; reason: string }[] = [];

  // The order the --max-cards cut is taken in, so it decides where the credits
  // go: the card priority order first, then soonest auction, then cheapest
  // current bid. Grade leading is also what the sales gate wants — a 10 of a
  // modern card sells five times a month, a CGC 7 of the same card sells twice
  // a year, and a test run that took the cheapest lots first priced five CGC
  // 7s and passed none. Auction order inside that means a duplicate cert (the
  // same slab relisted) keeps its earliest-closing listing.
  const graded = (l: ScannedLot): Graded => ({ grade: l.grade, gradingService: l.grader, title: l.title, pristine: l.pristine });
  const ordered = [...lots].sort((a, b) =>
    priorityRank(graded(a)) - priorityRank(graded(b)) ||
    (a.closesAtUnixS ?? 0) - (b.closesAtUnixS ?? 0) ||
    a.currentBid - b.currentBid);

  for (const lot of ordered) {
    const grader = lot.grader as Grader;
    if (!GRADERS.includes(grader)) continue;

    let keywords = matchKeywords(lot.title);
    if (chaseList && keywords.length === 0) { dropped.noMatch++; continue; }
    // After the chase list, not before: a house that has to be asked for each
    // cert is only asked about the lots worth asking about.
    const cert = lot.cert.trim();
    if (!cert) { dropped.noCert++; continue; }

    const candidate: Candidate = { ...lot, grader, cert, keywords };

    const block = blockedBy(lot.title);
    if (block) {
      blocked.set(block, (blocked.get(block) ?? 0) + 1);
      rejected.push({ candidate, reason: `block list: ${block}` });
      continue;
    }
    if (keywords.includes("Master Ball") && !masterBallAllowed(graded(lot))) {
      keywords = keywords.filter((k) => k !== "Master Ball");
      if (keywords.length === 0) {
        rejected.push({ candidate, reason: "Master Ball is chased at PSA 10 / CGC 10 Pristine only" });
        continue;
      }
      candidate.keywords = keywords;
    }
    const key = `${grader}:${cert}`;
    if (seen.has(key)) {
      rejected.push({ candidate, reason: "same cert already listed in an earlier-closing lot" });
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
  }

  const blockedTotal = [...blocked.values()].reduce((a, b) => a + b, 0);
  const byCount = [...blocked].sort((a, b) => b[1] - a[1]);
  log(chaseList
    ? `    dropped: ${dropped.noMatch} off the chase list, ${dropped.noCert} without a cert`
    : `    dropped: ${dropped.noCert} without a cert (no chase list here: every PSA/CGC lot is a candidate)`);
  log(`    rejected: ${blockedTotal} on the block list` +
    (blockedTotal > 0 ? ` (${byCount.map(([p, n]) => `${n} ${p}`).join(", ")})` : "") +
    `, ${rejected.length - blockedTotal} Master Ball below grade / duplicate cert`);
  // The funnel wants the same thing readable rather than complete: the handful
  // of patterns that did the work, as words rather than regex source.
  const blockListDetail = byCount.slice(0, 5).map(([p]) => prettyPattern(p)).join(", ")
    + (byCount.length > 5 ? "…" : "");
  return {
    candidates,
    rejected,
    counts: {
      offChaseList: dropped.noMatch,
      noCert: dropped.noCert,
      blockList: blockedTotal,
      blockListDetail,
      masterBallOrDuplicate: rejected.length - blockedTotal,
    },
  };
}

// ── Card Uploader pricing ─────────────────────────────────────────────────────

/** What Card Uploader resolved a cert into — from the batch's job data. */
export type CuCard = {
  cardName: string;
  setName: string;
  cardNumber: string;
  year: string;
  gradeNumber: string;
  gradeText: string;
  language: string;
  population: number | null;
  status: string;
};

/**
 * What the cert price lookup says the slab is, without a batch behind it: one
 * description string rather than the batch's separate name/set/number fields.
 * Enough to sanity-check a cert resolved at all; not enough for a card key.
 */
type CuInfo = {
  description: string;
  condition: string;
  gradingCompany: string;
};

/**
 * The pricing panel for one card.
 *
 * `info` and the sales come from the free per-cert lookup, which is all the bid
 * maths needs. `card` is the batch's structured identity and stays null until
 * the lot survives that maths and is worth the credits to identify.
 */
export type CuPrice = {
  card: CuCard | null;
  info: CuInfo | null;
  altValue: number | null;
  salesAverage: number | null;
  sales: Sale[];
  /** Lookups spent on this cert so far this run, so the sweeps know when to stop. */
  attempts?: number;
  error?: string;
};

type JobData = {
  results?: {
    cards?: {
      cardName?: string; setName?: string; cardnumber?: string; year?: string;
      gradeNumber?: string; gradeText?: string; language?: string; population?: number;
      status?: string; certificationNumber?: string;
    }[];
  };
};

type CertPrice = {
  cardInfo?: { cardDescription?: string; condition?: string; gradingCompany?: string };
  estimate?: { value?: number };
  recentSales?: { price: number; date: string; platform?: string; url?: string }[];
  pricing?: { average?: number; count?: number };
  estimateStatus?: string;
};

/**
 * Card Uploader's backend wants a bearer token on every call, which the app
 * keeps in memory rather than a cookie. The batch page makes several backend
 * calls as it loads, so the token is lifted from the first one seen and then
 * reused for the direct reads below.
 */
function captureBearer(page: Page): { current: () => string } {
  let token = "";
  page.on("request", (request) => {
    if (!request.url().startsWith(`${CU_BASE}/backend/`)) return;
    const auth = request.headers()["authorization"];
    if (auth) token = auth;
  });
  return { current: () => token };
}

async function cuGet<T>(page: Page, bearer: { current: () => string }, path: string): Promise<T> {
  const token = bearer.current();
  if (!token) throw new Error("No Card Uploader API token captured — the batch page made no authenticated request.");
  // Playwright's 30s default was timing out roughly one call in twelve at a
  // concurrency of sixteen; the endpoint is just slow under load, not stuck.
  const res = await page.request.get(`${CU_BASE}${path}`, { headers: { authorization: token }, timeout: CU_REQUEST_TIMEOUT_MS });
  if (!res.ok()) throw new Error(`${path}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** A backend call with a body — PUT to rename a job, DELETE to remove one. */
async function cuCall<T>(page: Page, bearer: { current: () => string }, method: "put" | "delete", path: string, data?: unknown): Promise<T> {
  const token = bearer.current();
  if (!token) throw new Error("No Card Uploader API token captured — the batch page made no authenticated request.");
  const res = await page.request[method](`${CU_BASE}${path}`, { headers: { authorization: token }, data, timeout: CU_REQUEST_TIMEOUT_MS });
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/**
 * Deletes every batch this venue's sniper left behind, so a crashed run costs
 * nothing on the next. Off the jobs API, which lists them by name in one
 * call; the site's own history page is the fallback, scrolled and read.
 */
async function sweepOldBatches(session: CuSession, prefix: string) {
  const isOurs = (name: string) => name.startsWith(`${prefix} `);
  try {
    const history = await cuGet<{ id?: string; jobId?: string; jobName?: string }[]>(session.page, session.bearer, "/backend/jobs/history");
    for (const job of history) {
      const id = job.jobId ?? job.id;
      if (!id || !isOurs(job.jobName ?? "")) continue;
      await cuCall(session.page, session.bearer, "delete", `/backend/jobs/${id}/delete`);
      console.log(`    deleted left-over batch  ${job.jobName}`);
    }
  } catch (err) {
    console.warn(`    ⚠️  could not sweep through the API (${err instanceof Error ? err.message : err}) — reading the history page instead`);
    const stale = (await listBatches(session.page)).filter((b) => isOurs(b.name));
    for (const batch of stale) {
      await deleteBatch(session.page, batch.id);
      console.log(`    deleted left-over batch  ${batch.name}`);
    }
  }
}

/**
 * A price already on the books is worth keeping unless the lookup that should
 * have produced it fell over. A cert Card Uploader has no record of will answer
 * the same way on the second ask, so only an outright failure is worth
 * repeating.
 */
export function isRetryable(price: CuPrice): boolean {
  return price.error !== undefined;
}

/**
 * An error that asking again will not change.
 *
 * Card Uploader answering "no such cert" is an answer — it took the question
 * and gave a verdict — so repeating it just spends the run's patience on a cert
 * that will never resolve. A timeout, a 429 or anything from the server's own
 * side of the fence is the opposite: no answer yet, ask later.
 */
export function isFinalAnswer(message: string): boolean {
  const status = Number(/\bHTTP (\d{3})\b/.exec(message)?.[1] ?? 0);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * A signed-in Card Uploader tab, shared by the two stages that need one.
 *
 * Pricing and identifying are separate — one is free and runs over every
 * candidate, the other costs credits and runs over the handful that survive —
 * but they want one browser and one login between them.
 */
export type CuSession = {
  page: Page;
  bearer: { current: () => string };
  /** When the bearer was last minted off a dashboard load. */
  refreshedAtMs: number;
  close: () => Promise<void>;
};

/** Unix seconds, or 0 for a bearer with no expiry to read. */
function bearerExpiresAt(bearer: string): number {
  try {
    const body = bearer.replace(/^Bearer\s+/i, "").split(".")[1];
    const exp = body ? (JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as { exp?: unknown }).exp : undefined;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
}

export async function openCardUploader(opts: { headed: boolean; batchPrefix: string }): Promise<CuSession> {
  const context: BrowserContext = await chromium.launchPersistentContext(
    join(process.cwd(), SESSION_DIR),
    { headless: !opts.headed, viewport: { width: 1600, height: 1000 } },
  );
  const page = context.pages()[0] ?? await context.newPage();
  const bearer = captureBearer(page);

  try {
    await ensureLoggedIn(page);
    // The dashboard's own backend calls are what the bearer is lifted from, so
    // a page that makes them has to load before anything can be read.
    await page.goto(CU_HISTORY_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    for (let i = 0; i < 20 && !bearer.current(); i++) await page.waitForTimeout(500);
    if (!bearer.current()) throw new Error("No Card Uploader API token captured — the dashboard made no authenticated request.");
    // Once per run, not once per batch: identify is called for every round of
    // pricing, and there is nothing left to sweep after the first.
    await sweepOldBatches({ page, bearer, refreshedAtMs: Date.now(), close: () => context.close() }, opts.batchPrefix);
  } catch (err) {
    await context.close();
    throw err;
  }

  return { page, bearer, refreshedAtMs: Date.now(), close: () => context.close() };
}

/** Leaves the page behind for a post-mortem when a stage dies mid-run. */
async function snapshotFailure(page: Page, outDir: string) {
  await page.screenshot({ path: join(outDir, "failure.png"), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => null);
  if (html) writeFileSync(join(outDir, "failure.html"), html);
  console.error(`    URL at failure: ${page.url()}`);
}

/**
 * The bearer is lifted off the dashboard's own requests, and a run that waits
 * out an evening of extended bidding outlives one. A page load mints a fresh
 * one — done when the token is near lapsing, not before every round, since the
 * load is seconds and a run has dozens of rounds.
 */
export async function refreshCuToken(session: CuSession) {
  const exp = bearerExpiresAt(session.bearer.current());
  const stale = exp
    ? exp - Date.now() / 1000 < CU_TOKEN_MARGIN_S
    : Date.now() - session.refreshedAtMs > CU_TOKEN_REFRESH_MS;
  if (!stale) return;
  await session.page.goto(CU_HISTORY_URL, { waitUntil: "domcontentloaded" });
  await session.page.waitForLoadState("networkidle").catch(() => {});
  session.refreshedAtMs = Date.now();
}

/**
 * Prices every candidate straight off the cert.
 *
 * /backend/card-price/cert answers for any cert, not only one sitting in a
 * batch, and answering costs no credits — verified against certs that had never
 * been submitted, with the credit balance unmoved either side. Everything the
 * bid maths reads is in that answer: the recent sales, their dates, and the
 * card's own description.
 *
 * What is missing is the structured identity — name, set, number, language,
 * population — which only a batch returns. That is bought later, for the lots
 * that turn out to be worth it. See identifyViaBatch.
 */
export async function priceByCert(
  session: CuSession,
  candidates: Candidate[],
  opts: { prices: Map<string, CuPrice>; concurrency: number; sweep: boolean },
): Promise<Map<string, CuPrice>> {
  const prices = opts.prices;

  const todo = candidates.filter((c) => {
    const already = prices.get(`${c.grader}:${c.cert}`);
    return !already || isRetryable(already);
  });
  const reused = candidates.length - todo.length;
  if (reused > 0) console.log(`    ${reused} already priced, ${todo.length} left`);
  console.log(`    pricing ${todo.length} cert(s), ${opts.concurrency} at a time — no credits`);

  let done = 0;

  const drain = async (queue: Candidate[], concurrency: number, total: number) => {
    const worker = async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        const key = `${c.grader}:${c.cert}`;
        const spent = prices.get(key)?.attempts ?? 0;
        for (let n = 1; n <= PRICE_ATTEMPTS_PER_PASS && spent + n <= PRICE_ATTEMPTS; n++) {
          const attempt = spent + n;
          try {
            const p = await cuGet<CertPrice>(session.page, session.bearer,
              `/backend/card-price/cert?certNumber=${encodeURIComponent(c.cert)}&grader=${c.grader.toLowerCase()}&currency=USD`);
            prices.set(key, {
              card: null,
              info: p.cardInfo?.cardDescription
                ? { description: p.cardInfo.cardDescription, condition: p.cardInfo.condition ?? "", gradingCompany: p.cardInfo.gradingCompany ?? "" }
                : null,
              altValue: p.estimate?.value ?? null,
              salesAverage: p.pricing?.average ?? null,
              sales: (p.recentSales ?? []).map((s) => ({ price: s.price, date: s.date, platform: s.platform, url: s.url })),
              attempts: attempt,
            });
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
            // A refusal is an answer, so the tries are spent rather than saved:
            // that stops the sweeps from coming back to a cert Card Uploader
            // has already said it cannot resolve.
            if (isFinalAnswer(message)) {
              prices.set(key, {
                card: null, info: null, altValue: null, salesAverage: null, sales: [],
                attempts: PRICE_ATTEMPTS, error: message,
              });
              break;
            }
            // Out of tries for this pass: leave the failure on the record with
            // the count, and let the sweeps below decide whether to come back.
            if (n === PRICE_ATTEMPTS_PER_PASS || attempt === PRICE_ATTEMPTS) {
              prices.set(key, {
                card: null, info: null, altValue: null, salesAverage: null, sales: [],
                attempts: attempt, error: message,
              });
              break;
            }
            // Backing off rather than retrying flat out: the failures come in
            // bursts when the backend is loaded, and piling straight back on
            // makes the burst worse.
            await session.page.waitForTimeout(n * 2_000);
          }
        }

        done++;
        if (done % 500 === 0) console.log(`    priced ${done}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  };

  const started = Date.now();
  await drain([...todo], opts.concurrency, todo.length);

  // Sweeps over whatever never answered, waiting longer each time. A timeout
  // here is almost always Card Uploader gone quiet rather than a cert it cannot
  // serve, and it comes back on its own — so the answer is to wait, then ask
  // again gently at a quarter of the concurrency. Each sweep spends attempts,
  // so PRICE_ATTEMPTS is what ends this rather than a sweep count. Only the
  // last pass over the list sweeps; the rounds before it leave their
  // stragglers for it.
  const retryDeadline = Date.now() + PRICE_RETRY_MAX_MS;
  for (let sweep = 1; opts.sweep; sweep++) {
    const gentle = Math.max(1, Math.floor(opts.concurrency / PRICE_RETRY_CONCURRENCY_DIVISOR));
    const stragglers = candidates.filter((c) => {
      const p = prices.get(`${c.grader}:${c.cert}`);
      return p?.error && (p.attempts ?? 0) < PRICE_ATTEMPTS;
    });
    if (stragglers.length === 0) break;

    const wait = PRICE_RETRY_WAIT_MS * 2 ** (sweep - 1);
    if (Date.now() + wait > retryDeadline) {
      console.log(`    ${stragglers.length} still unanswered and the retry window is up — left unpriced`);
      break;
    }
    console.log(`    ${stragglers.length} never answered — waiting ${Math.round(wait / 1_000)}s, then retrying ${gentle} at a time`);
    await session.page.waitForTimeout(wait);
    done = 0;
    await drain([...stragglers], gentle, stragglers.length);
    const recovered = stragglers.filter((c) => !prices.get(`${c.grader}:${c.cert}`)?.error).length;
    console.log(`    sweep ${sweep}: recovered ${recovered} of ${stragglers.length}`);
  }

  // Three outcomes worth telling apart: priced, answered-but-unknown, and never
  // answered.
  const seen = candidates.map((c) => prices.get(`${c.grader}:${c.cert}`));
  const failed = seen.filter((p) => p?.error).length;
  const unknown = seen.filter((p) => p && !p.error && p.info === null).length;
  const secs = (Date.now() - started) / 1000;
  console.log(`    priced ${seen.length - failed - unknown}, ${unknown} cert(s) Card Uploader does not know` +
    (failed > 0 ? `, ${failed} that never answered` : "") +
    `  ·  ${secs.toFixed(0)}s, ${(todo.length / Math.max(secs, 0.001)).toFixed(1)}/s`);
  return prices;
}

/** A Card Uploader job, as its own API reports it. */
type Job = {
  job_id: string;
  status: string;
  progress_current?: number;
  progress_total?: number;
  new_credit_balance?: string;
};

/**
 * Every field the site's own "Process cards" form posts, as captured on
 * 2026-09-07. All but the first two are the form's defaults; the job type
 * and platform are what the site fills in for a graded batch.
 */
function processCardsForm(grader: Grader, certs: string[]): Record<string, string> {
  return {
    certification_numbers: JSON.stringify(certs),
    grading_company: grader,
    sku_prefix: "",
    sku_increment: "true",
    start_price: "",
    store_category: "",
    store_category2: "",
    auction_duration: "7",
    auction_scheduled_time: "",
    space_out_enabled: "false",
    space_out_interval: "5",
    best_offer: "0",
    fixed_price_scheduled_time: "",
    job_type: "graded",
    platform: "standard",
  };
}

/**
 * Submits a batch of certs for identification and returns the job's id.
 *
 * The API call is the one the site's own form makes, without the form: a
 * page load, three widgets and a scroll saved per batch, and no dependence on
 * what the page happens to be called this week. Should the endpoint turn the
 * request away, the form itself is the fallback — nothing has been spent at
 * that point.
 */
async function submitJob(session: CuSession, grader: Grader, certs: string[]): Promise<string> {
  const token = session.bearer.current();
  if (!token) throw new Error("No Card Uploader API token captured — the batch page made no authenticated request.");
  const res = await session.page.request.post(`${CU_BASE}/backend/process-cards`, {
    headers: { authorization: token }, multipart: processCardsForm(grader, certs), timeout: CU_REQUEST_TIMEOUT_MS,
  });
  if (!res.ok()) {
    console.warn(`    ⚠️  process-cards answered HTTP ${res.status()} ${(await res.text()).slice(0, 120)} — submitting through the page instead`);
    const id = await createBatch(session.page, grader, certs, false, { requireAll: false });
    if (!id) throw new Error("the page did not create a batch");
    return id;
  }
  const job = (await res.json()) as Partial<Job>;
  if (!job.job_id) throw new Error(`process-cards answered without a job id: ${JSON.stringify(job).slice(0, 200)}`);
  console.log(`    job ${job.job_id} ${job.status ?? "submitted"}`);
  return job.job_id;
}

/**
 * Waits for a job to finish, looking at the bids in between.
 *
 * A job is the grader being asked about every cert in turn, which is seconds
 * for a handful and a minute or so for two hundred. Whatever the caller gives
 * as `between` runs after each look — the live run's poll-and-fill — so a
 * batch never means the bids going unwatched.
 */
async function waitForJob(session: CuSession, id: string, expected: number, between?: () => Promise<void>): Promise<Job> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastProgress = -1;
  for (;;) {
    const job = await cuGet<Job>(session.page, session.bearer, `/backend/jobs/${id}`);
    if (job.status === "completed") return job;
    if (/fail|error|cancel/i.test(job.status)) throw new Error(`job ${id} ${job.status}`);
    if (job.progress_current !== undefined && job.progress_current !== lastProgress) {
      lastProgress = job.progress_current;
      if (lastProgress > 0) console.log(`    ${lastProgress}/${job.progress_total || expected} cert(s) resolved`);
    }
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish within ${JOB_TIMEOUT_MS / 60_000} minutes (${job.status})`);
    if (between) await between();
    await sleep(JOB_POLL_MS);
  }
}

/**
 * Buys the structured card identity for the lots that survived the bid maths.
 *
 * This is the only step that spends credits — 2 per cert — and it runs on the
 * lots worth bidding on rather than the whole chase list. The identity is
 * what card_key is built from, which is what holds a run to its few lots of
 * one card, so a lot that cannot be identified cannot be capped.
 *
 * Returns a map keyed "GRADER:cert", covering whatever resolved.
 */
async function identifyViaBatch(
  session: CuSession,
  candidates: Candidate[],
  batchPrefix: string,
  opts: { between?: () => Promise<void> } = {},
): Promise<Map<string, CuCard>> {
  const identified = new Map<string, CuCard>();
  const { page, bearer } = session;

  const byGrader = new Map<Grader, string[]>();
  for (const c of candidates) byGrader.set(c.grader, [...(byGrader.get(c.grader) ?? []), c.cert]);

  const batches: { grader: Grader; certs: string[] }[] = [];
  for (const [grader, certs] of byGrader) {
    for (let i = 0; i < certs.length; i += MAX_CERTS_PER_BATCH) {
      batches.push({ grader, certs: certs.slice(i, i + MAX_CERTS_PER_BATCH) });
    }
  }

  let consecutiveFailures = 0;
  for (const [i, batch] of batches.entries()) {
    console.log(`  ── ${batch.grader} batch ${i + 1}/${batches.length}  (${batch.certs.length} cert(s), ~${batch.certs.length * 2} credits)`);
    let id: string | null = null;
    try {
      id = await submitJob(session, batch.grader, batch.certs);
      const job = await waitForJob(session, id, batch.certs.length, opts.between);

      // A cert the grader has no record of never resolves and is simply
      // missing from the results, so one short costs that card and nothing else.
      const data = await cuGet<JobData>(page, bearer, `/backend/jobs/${id}/data`);
      let found = 0;
      for (const c of data.results?.cards ?? []) {
        if (!c.certificationNumber) continue;
        identified.set(`${batch.grader}:${c.certificationNumber}`, {
          cardName: c.cardName ?? "", setName: c.setName ?? "", cardNumber: c.cardnumber ?? "",
          year: c.year ?? "", gradeNumber: c.gradeNumber ?? "", gradeText: c.gradeText ?? "",
          language: c.language ?? "", population: c.population ?? null, status: c.status ?? "",
        });
        found++;
      }
      console.log(`    ${found} of ${batch.certs.length} cert(s) identified${job.new_credit_balance ? `  ·  ${job.new_credit_balance} credits left` : ""}`);
      consecutiveFailures = 0;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`    ✖  batch ${i + 1}/${batches.length} failed: ${reason}`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        throw new Error(
          `${consecutiveFailures} batches in a row failed, the last with: ${reason}. ` +
          `Stopping rather than spending credits on a run that cannot identify anything.`);
      }
    } finally {
      // Housekeeping is best-effort: the identities are already in hand. The
      // name goes on first, so a batch the delete misses is one the sweep at
      // the start of the next run recognises.
      if (id !== null) {
        const name = batchName({
          prefix: batchPrefix, date: pstDate(new Date()), grader: batch.grader,
          index: i + 1, total: batches.length, cards: batch.certs.length,
        });
        try {
          await cuCall(page, bearer, "put", `/backend/jobs/${id}/results`, { jobName: name });
          await cuCall(page, bearer, "delete", `/backend/jobs/${id}/delete`);
          console.log(`    deleted  ${name}`);
        } catch (err) {
          console.warn(`    ⚠️  could not tidy batch ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
  return identified;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * One lot, as the run knows it. The first block is what <venue>-bids.csv
 * shows, in column order; the rest is what the run works with and keeps to
 * itself — the sort keys, the cap bookkeeping, and why a lot was rejected.
 */
export type Row = {
  url: string;
  title: string;
  auction: string;
  lot: string;
  language: string;
  grader: string;
  grade: string;
  cert: string;
  /** The lowest of the last five sales: what the bid is worked out from. */
  market_price: number | "";
  /** The median of the same five: what the card goes for. */
  sales_median: number | "";
  tier_rule: string;
  max_bid_hammer: number | "";
  max_bid_all_in: number | "";
  /** The max bid this run put on the lot, in hammer dollars. */
  bid_placed: number | "";
  bid_status: string;
  /** Where the bidding stood when the lot was last looked at — what it went for, once closed. */
  final_bid: number | "";
  /** For a lot won or being won: final_bid plus the buyer's premium. */
  final_paid_all_in: number | "";
  /** final_paid_all_in as a percentage of sales_median. */
  market_pct: number | "";
  /**
   * The sourcing check's verdict: why no pack could award this card, when
   * that is so, and empty otherwise. Absent altogether on a row from before
   * the column existed, which reads as not unawardable.
   */
  unawardable?: string;

  listing_id: string;
  priority: number;
  current_bid: number;
  bid_count: number;
  headroom: number | "";
  card_key: string;
  bid_rank: number | "";
  flags: string;
  reason: string;
};

/** The columns of the bid list CSV, in order. */
export const CSV_COLUMNS: (keyof Row)[] = [
  "url", "title", "auction", "lot", "language", "grader", "grade", "cert",
  "market_price", "sales_median", "tier_rule", "max_bid_hammer", "max_bid_all_in",
  "bid_placed", "bid_status", "final_bid", "final_paid_all_in", "market_pct",
  "unawardable",
];

export function baseRow(c: Candidate): Row {
  return {
    url: c.url,
    title: c.title,
    auction: c.auction,
    lot: c.lot,
    language: c.language,
    grader: c.grader,
    grade: c.grade !== undefined ? String(c.grade) : "",
    cert: c.cert,
    market_price: "", sales_median: "", tier_rule: "", max_bid_hammer: "", max_bid_all_in: "",
    bid_placed: "", bid_status: "", final_bid: "", final_paid_all_in: "", market_pct: "", unawardable: "",
    listing_id: c.listingId,
    priority: priorityRank({ grade: c.grade, gradingService: c.grader, title: c.title, pristine: c.pristine }),
    current_bid: c.currentBid,
    bid_count: c.bidCount,
    headroom: "", card_key: "", bid_rank: "", flags: "", reason: "",
  };
}

/**
 * Things the cert lookup disagrees with the listing about.
 *
 * Any one of these drops the lot. The price came from the cert, which is the
 * truth about the slab, but the other bidders are pricing off the title — so a
 * disagreement means the max bid was worked out for a different card than the
 * one the room is competing over. Cheap to skip, expensive to be wrong about.
 */
export function flagsFor(c: Candidate, card: CuCard): string[] {
  const flags: string[] = [];
  const title = c.title;

  if (card.gradeNumber && c.grade !== undefined && Number(card.gradeNumber) !== c.grade) {
    flags.push(`grade: cert says ${card.gradeNumber}, listing says ${c.grade}`);
  }
  const certPristine = /pristine/i.test(card.gradeText);
  const titlePristine = isPristine({ title, pristine: c.pristine });
  if (c.grader === "CGC" && card.gradeNumber === "10" && certPristine !== titlePristine) {
    flags.push(`CGC 10: cert says ${certPristine ? "Pristine" : "Gem Mint"}, listing says ${titlePristine ? "Pristine" : "Gem Mint"}`);
  }
  const titleYear = /\b(19|20)\d{2}\b/.exec(title)?.[0];
  if (card.year && titleYear && Math.abs(Number(card.year) - Number(titleYear)) > 1) {
    flags.push(`year: cert says ${card.year}, listing says ${titleYear} (reprint / Celebrations?)`);
  }
  const certCelebrations = /celebrations/i.test(card.setName);
  const titleCelebrations = /\bcelebrations\b/i.test(title);
  if (certCelebrations !== titleCelebrations) {
    flags.push(`set: cert says ${card.setName || "?"}, listing ${titleCelebrations ? "says" : "does not say"} Celebrations`);
  }
  if (card.language && c.language && card.language !== c.language) {
    flags.push(`language: cert says ${card.language}, listing filed under ${c.language}`);
  }
  return flags;
}

export function evaluate(c: Candidate, price: CuPrice | undefined, now: Date): { row: Row; worthy: boolean } {
  const row = baseRow(c);

  if (!price) { row.reason = "not priced"; return { row, worthy: false }; }

  // The structured identity is bought only for lots that survive this function,
  // so on the first pass card is null and only the free lookup's verdict is
  // there. Re-evaluating after identifyViaBatch fills in the key and the flags.
  if (price.card) {
    row.card_key = cardKey(price.card);
    row.flags = flagsFor(c, price.card).join(" | ");
  }
  if (price.error) { row.reason = price.error; return { row, worthy: false }; }
  if (!price.card && !price.info) { row.reason = "cert did not resolve"; return { row, worthy: false }; }

  const gate = salesGate(price.sales, now);
  if (!gate.ok) { row.reason = gate.reason ?? "sales gate"; return { row, worthy: false }; }

  const market = marketPrice(price.sales);
  if (market.price === null) { row.reason = "no priced sales"; return { row, worthy: false }; }
  row.market_price = market.price;
  row.sales_median = salesMedian(price.sales) ?? "";

  // The sourcing check comes before the table: a card no pack can award is
  // not bought at any price, whatever table this run was given.
  const unawardable = unawardableLotReason({ medianDollars: row.sales_median === "" ? null : row.sales_median, basisDollars: market.price });
  if (unawardable) {
    row.unawardable = unawardable;
    row.reason = `unawardable: ${unawardable}`;
    return { row, worthy: false };
  }

  const bid = maxBid(c.grader, market.price);
  if (!bid) {
    row.reason = market.price < tierFloor(c.grader)
      ? `market price $${market.price} is under the $${tierFloor(c.grader)} ${c.grader} floor`
      : `market price $${market.price} is above the $${tierCeiling(c.grader)} ${c.grader} tier ceiling`;
    return { row, worthy: false };
  }
  row.tier_rule = bid.rule;
  row.max_bid_all_in = bid.allIn;
  row.max_bid_hammer = bid.hammer;
  row.headroom = bid.hammer - c.currentBid;

  if (bid.hammer <= c.currentBid) {
    row.reason = `current bid $${c.currentBid} is already at or above max hammer $${bid.hammer}`;
    return { row, worthy: false };
  }
  return { row, worthy: true };
}

/**
 * What a lot the account is winning would cost, written onto its row: the
 * current bid with the premium on top, and that as a share of the card's
 * market value. Only for a lot this account is the high bidder on — won, or
 * winning at the moment the run ended — since anything else has no price yet.
 */
export function settle(row: Row, bid: Pick<PlacedBid, "status" | "currentBidCents">): void {
  if (bid.status !== "HIGH_BID" || !bid.currentBidCents) return;
  const paid = round2((bid.currentBidCents / 100) * (1 + BUYERS_PREMIUM));
  row.final_paid_all_in = paid;
  row.market_pct = row.sales_median === "" ? "" : marketPct(paid, row.sales_median);
}

// ── Output ────────────────────────────────────────────────────────────────────

export function toCsv(rows: Row[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((col) => cell(r[col] ?? "")).join(","))].join("\n") + "\n";
}

/**
 * The last gate between "the maths says yes" and the bid list.
 *
 * Anything the cert disagrees with the listing about is dropped rather than
 * listed with a warning. The market price behind the bid came from the cert;
 * the other bidders are pricing off the title. When those are not the same
 * card, the max bid is the wrong card's, and a wrong bid costs money.
 *
 * The per-card cap — maxCopiesPerCard() lots of one card winning or won at
 * once — is the book's, counted live: every copy goes onto the list, and the
 * book bids the one past the cap only once a copy under it has been outbid. A
 * run with a low strike rate is outbid on most of what it holds, and a copy
 * that was cut at the list would never have had its turn. A lot that never
 * identified has no card key for that count, so it is dropped here: an
 * unchecked cap is the thing the cap exists to prevent.
 */
export function finalCut(passed: Row[]): { worthy: Row[]; dropped: Row[]; flaggedOut: number } {
  const worthy: Row[] = [];
  const dropped: Row[] = [];
  let flaggedOut = 0;

  for (const row of passed) {
    if (row.flags) {
      dropped.push({ ...row, reason: `flagged, not bid: ${row.flags}` });
      flaggedOut++;
      continue;
    }
    if (!row.card_key) {
      dropped.push({ ...row, reason: `cert did not identify, so the ${maxCopiesPerCard()}-per-card cap could not be checked` });
      flaggedOut++;
      continue;
    }
    worthy.push(row);
  }
  return { worthy, dropped, flaggedOut };
}

export type FunnelLine =
  | { kind: "total"; n: number; label: string }
  | { kind: "cut"; n: number; label: string }
  | { kind: "rule" };

/**
 * The whole run as one column of numbers: what was scanned, what every stage
 * removed and why, and what came out. A run that produced fewer bids than
 * expected says where they went without anyone opening a CSV.
 */
export function funnelText(lines: FunnelLine[]): string {
  const cell = (l: FunnelLine) => (l.kind === "rule" ? "" : `${l.kind === "cut" ? "-" : ""}${l.n}`);
  const width = Math.max(...lines.map((l) => cell(l).length));
  return lines
    .map((l) => (l.kind === "rule" ? `    ${"─".repeat(width)}` : `    ${cell(l).padStart(width)}  ${l.label}`))
    .join("\n");
}

/**
 * The run as a page: what was bid on and how each one ended, then what the next
 * bid would have gone to. Written whether or not anything was bid, because the
 * queue is the answer to "what would it have done with more money".
 */
function summaryMarkdown(
  worthy: Row[],
  rejected: Row[],
  candidates: number,
  scanned: number,
  opts: { venue: string; csv: string; mode: string; standing: string; chaseList: boolean },
): string {
  const lines = [
    `## ${opts.venue} sniper — ${opts.mode}`,
    ``,
    `- ${scanned} live PSA/CGC 7–10 Pokémon lots scanned, ${candidates} ${opts.chaseList ? "on the chase list" : "candidate(s) — every lot is, here"}, ${worthy.length} worth a bid, ${rejected.length} rejected`,
    `- ${opts.standing}`,
    ``,
  ];

  const bid = worthy.filter((r) => r.bid_placed !== "");
  if (bid.length > 0) {
    lines.push(`### Bid on`, ``,
      `| Lot | Our max | All-in | Went for | Paid all-in | % of market | Outcome | Item |`,
      `|---|---|---|---|---|---|---|---|`);
    for (const r of bid) {
      const allIn = (Number(r.bid_placed) * (1 + BUYERS_PREMIUM)).toFixed(2).replace(/\.00$/, "");
      const money = (v: number | "") => (v === "" ? "—" : `$${v}`);
      lines.push(`| ${r.lot} | **$${r.bid_placed}** | $${allIn} | ${money(r.final_bid)} | ${money(r.final_paid_all_in)} | ${r.market_pct === "" ? "—" : `${r.market_pct}%`} | ${r.bid_status} | [${r.title.slice(0, 60)}](${r.url}) |`);
    }
    lines.push(``);
  }

  const queue = worthy.filter((r) => r.bid_rank !== "").sort((a, b) => Number(a.bid_rank) - Number(b.bid_rank));
  if (queue.length > 0) {
    lines.push(`### Next in line`, ``, `The bids the budget would have gone to, in order, had it come free.`, ``,
      `| # | Lot | Max hammer | Current | Grade | Item |`, `|---|---|---|---|---|---|`);
    for (const r of queue.slice(0, 25)) {
      lines.push(`| ${r.bid_rank} | ${r.lot} | **$${r.max_bid_hammer}** | $${r.current_bid} | ${r.grader} ${r.grade} | [${r.title.slice(0, 60)}](${r.url}) |`);
    }
    if (queue.length > 25) lines.push(``, `…and ${queue.length - 25} more in ${opts.csv}.`);
    lines.push(``);
  }

  const passed = worthy.filter((r) => r.bid_status.startsWith("not bid:"));
  if (passed.length > 0) {
    lines.push(`### Worth a bid, but passed over`, ``);
    const why = new Map<string, number>();
    for (const r of passed) why.set(r.bid_status, (why.get(r.bid_status) ?? 0) + 1);
    for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${reason}`);
    lines.push(``);
  }

  const reasons = new Map<string, number>();
  for (const r of rejected) {
    const key = r.reason.replace(/\$[\d.,]+/g, "$…").replace(/\b\d+d\b/g, "Nd").replace(/only \d+/g, "only N").replace(/last \d+/g, "last N");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    lines.push(`### Rejections`, ``);
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${reason}`);
  }
  const unawardable = rejected.filter((r) => r.unawardable);
  if (unawardable.length > 0) {
    lines.push(``,
      `${unawardable.length} of those failed the sourcing check: the card is worth a value no pack can award (lib/odds-config.ts), so the lot is not bought at any price. For example:`, ``);
    for (const r of unawardable.slice(0, 5)) {
      lines.push(`- ${r.lot}: lowest sale $${r.market_price}, median $${r.sales_median} — ${r.unawardable} — [${r.title.slice(0, 60)}](${r.url})`);
    }
    if (unawardable.length > 5) lines.push(`- …and ${unawardable.length - 5} more`);
  }
  return lines.join("\n") + "\n";
}

// ── The bidding half, as the pipeline sees it ─────────────────────────────────

/**
 * A row the bidder can act on, or null for one it must not.
 *
 * A flag means the cert and the listing disagree, or the lot never identified
 * and the per-card cap could not be checked. Those rows stay in the CSV with
 * their warning and are never handed over. Nor is a row the sourcing check
 * marked unawardable — the CSV's unawardable column; a row from before that
 * column existed carries nothing there and is not unawardable for it.
 */
export function toBiddable(row: Row): Biddable | null {
  if (!row.listing_id || row.flags || !row.max_bid_hammer || !row.max_bid_all_in) return null;
  if (row.unawardable) return null;
  return {
    listingId: row.listing_id,
    title: row.title,
    lot: row.lot,
    maxHammerCents: Math.round(Number(row.max_bid_hammer) * 100),
    maxAllInCents: Math.round(Number(row.max_bid_all_in) * 100),
    currentBidCents: Math.round(Number(row.current_bid) * 100),
    bidCount: Number(row.bid_count) || 0,
    cardKey: row.card_key || undefined,
  };
}

/** The per-card cap the book bids under, as this run was told to set it. */
export function cardCaps(): CardCaps {
  return { perCard: maxCopiesPerCard() };
}

/**
 * What became of a bid, in the words a person would use.
 *
 * The houses' own vocabulary is HIGH_BID either side of the close, which is the
 * difference between winning and won, so the closed flag has to be read with
 * it. PLANNED and PENDING are this run's own: one was never sent, the other was
 * sent and not yet seen again.
 */
export function bidOutcome(bid: Pick<PlacedBid, "status" | "closed">): string {
  if (bid.status === "PLANNED") return "would bid";
  if (bid.status === "PENDING") return "bid sent, standing unknown";
  if (bid.closed) return bid.status === "HIGH_BID" ? "won" : "lost";
  if (bid.status === "HIGH_BID") return "winning";
  if (bid.status === "OUTBID") return "outbid";
  return "bid placed";
}

/**
 * Every quote, bid and change of standing goes to the console, which on a
 * runner is the Actions log — the record of what was bid, kept by GitHub for
 * longer than any artifact. The event and its detail are there for a bidder
 * that wants to keep its own; this one only speaks.
 */
const log: Log = (_event, _detail, line) => {
  if (line) console.log(line);
};

/**
 * How long to wait before looking again, given where the auction is.
 *
 * Nothing closes while the auction is merely live, so a slow pace there costs
 * nothing and keeps six hours of polling off the house's door. Extended bidding
 * is the opposite: a lot can close a minute after the last bid on it, so an
 * outbid has to be seen and answered inside that.
 */
export function pollDelayS(basePollS: number, status: string, secondsToClose: number): number {
  const quicker = (by: number) => Math.max(MIN_POLL_S, Math.round(basePollS / by));
  if (status === "EXTENDED_BIDDING") return quicker(POLL_EXTENDED_DIVISOR);
  if (status === "CLOSED") return basePollS;
  if (secondsToClose <= POLL_NEAR_S) return quicker(POLL_NEAR_DIVISOR);
  if (secondsToClose > POLL_FAR_S) return basePollS * POLL_FAR_MULTIPLIER;
  return basePollS;
}

// ── The venue ─────────────────────────────────────────────────────────────────

/** A signed-in session at the house: what the book bids through, and how to let go of it. */
export interface Session extends Exchange {
  /** The token the workflow's secret wants, for --export-session. */
  exportable(): Promise<{ name: string; value: string; expiresAtUnixS: number | null }>;
  /** For the post-mortem when a run dies. */
  snapshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface Venue {
  /** "Fanatics Collect", "Alt" — for the log and the summary. */
  name: string;
  /** "fanatics", "alt" — the CSV's name and the <KEY>_EMAIL variable. */
  key: string;
  /** Where run folders go, one per run. */
  outDir: string;
  /** Leads every Card Uploader batch this venue creates; the sweep at start deletes by it. */
  batchPrefix: string;
  /** The time zone the auction runs on, and its label. */
  timeZone: string;
  zoneLabel: string;
  /** Where the saved sign-in lives, for the --login message. */
  sessionDir: string;
  /** How the site takes a bid. */
  steps: BidSteps;
  /**
   * Whether a lot's title has to match the chase list to be priced. Fanatics:
   * yes — a Weekly Auction is twelve thousand Pokémon lots, most of them
   * bulk. Alt: no — every PSA/CGC Pokémon lot in the cycle is a candidate.
   */
  chaseList: boolean;
  /**
   * Whether the whole auction extends and ends together (Alt: any bid anywhere
   * pushes every lot's close out, and one quiet window closes all of it) or
   * the lots close one by one on a fixed schedule (Fanatics). The former can
   * end before the fire time, so a run there watches the clock for it.
   */
  closesTogether: boolean;
  /**
   * When the bids go on, unless the run is told otherwise: minutes after
   * extended bidding was scheduled to open. The house's own rule for closing
   * decides it — see each venue's file.
   */
  fireAfterMinutes: number;
  /** The lot's page, so a log line can be clicked through to what was bid on. */
  listingUrl(listingId: string): string;
  /**
   * Every live PSA/CGC 7–10 Pokémon lot in the auction about to close, and when
   * that auction's extended bidding is scheduled to start. A `light` scan is
   * the same read for nothing but where each lot's bidding stands — no certs,
   * no chatter — and is taken every few minutes before the fire.
   */
  scan(opts: { headed: boolean; now: Date; light?: boolean }): Promise<{ lots: ScannedLot[]; closesAtUnixS: number }>;
  /**
   * A signed-in session. `login` means sign in afresh with a person at the
   * keyboard; `email` names the account the run is for and is refused if the
   * session is anyone else's; `live` says bids will be sent through it, so a
   * venue that cannot yet be trusted with real money can refuse here.
   */
  open(opts: { headed: boolean; login: boolean; email: string; password: string; live: boolean }): Promise<Session>;
}

// ── The run ───────────────────────────────────────────────────────────────────

export async function runSniper(venue: Venue): Promise<void> {
  loadEnvLocal();

  const live = process.argv.includes("--live");
  const quoteOnly = process.argv.includes("--quote-only");
  const login = process.argv.includes("--login");
  const exportSession = process.argv.includes("--export-session");
  const headed = process.argv.includes("--headed");
  const countExistingBids = process.argv.includes("--count-existing-bids");

  // Which account this run is for. A saved profile and a token both sign in
  // silently, so naming the account is the only way to be sure the bids land
  // on the one meant. --password is read from the command line as a
  // convenience; a password in .env.local keeps it out of shell history and
  // out of `ps`.
  const wantEmail = opt("email", process.env[`${venue.key.toUpperCase()}_EMAIL`] ?? "");
  const wantPassword = opt("password", "");

  // Signing in and reading the session back are their own errands: no scan, no
  // pricing, nothing else running alongside them.
  if (login || exportSession) {
    const session = await venue.open({ headed: headed || login, login, email: wantEmail, password: wantPassword, live: false });
    const token = await session.exportable();
    await session.close();
    if (login) { console.log(`    session saved under ${venue.sessionDir}/`); return; }
    console.log(`\n    ${token.name}, good until ${token.expiresAtUnixS ? new Date(token.expiresAtUnixS * 1000).toISOString() : "an unknown time"}.`);
    console.log(`    It signs in as this account: put it in a GitHub secret, nowhere else.\n`);
    console.log(token.value);
    return;
  }

  if (live && quoteOnly) throw new Error("--quote-only and --live are opposites: one sends bids, the other refuses to.");

  const maxCards = Number(opt("max-cards", String(DEFAULT_MAX_CARDS)));
  if (!Number.isInteger(maxCards) || maxCards < 0) throw new Error(`--max-cards must be a whole number, got "${opt("max-cards", "")}"`);
  const concurrency = Number(opt("concurrency", String(PRICE_CONCURRENCY)));
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive whole number, got "${opt("concurrency", "")}"`);
  const batchSize = Number(opt("batch", String(DEFAULT_BATCH)));
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`--batch must be a positive whole number, got "${opt("batch", "")}"`);
  const pollS = Number(opt("poll", String(DEFAULT_POLL_S)));
  if (!(pollS >= MIN_POLL_S)) throw new Error(`--poll must be at least ${MIN_POLL_S} seconds, got "${opt("poll", "")}"`);
  const budgetDollars = Number(opt("budget", String(DEFAULT_BUDGET_DOLLARS)));
  if (!(budgetDollars > 0)) throw new Error(`--budget must be a positive number of dollars, got "${opt("budget", "")}"`);
  const budgetCents = Math.round(budgetDollars * 100);
  // Read before anything is scanned: a table or a cap that cannot be read is
  // a run that should not start.
  setTierTable(tiersFromArgs());
  setMaxCopiesPerCard(maxCopiesFromArgs());
  const fireAfterMin = fireAfterFromArgs(venue.fireAfterMinutes);

  const now = new Date();
  const startedMs = Date.now();
  const outDir = join(opt("out", venue.outDir), runStamp(now));
  mkdirSync(outDir, { recursive: true });
  const csvName = `${venue.key}-bids.csv`;
  const batchPrefix = venue.batchPrefix;
  const clock = () => localClock(venue.timeZone);

  const mode = live ? "live bidding" : quoteOnly ? "quoted, no bids" : "plan";
  console.log(live
    ? `💸  ${venue.name} sniper — LIVE BIDDING, real money\n`
    : quoteOnly
      ? `🎯  ${venue.name} sniper — quoting every lot at ${venue.name}, sending no bids\n`
      : `🎯  ${venue.name} sniper — planning against the scan's own bid snapshot, sending nothing\n`);

  console.log(`    output       ${outDir}`);
  console.log(`    ceiling      ${dollars(budgetCents)} all-in at once for this run (hammer + ${Math.round(BUYERS_PREMIUM * 100)}% buyer's premium); bids already on the account are left alone${countExistingBids ? " and charged to it" : " and not counted"}`);
  console.log(`    fire         ${fireAfterMin} min after extended bidding opens${venue.closesTogether ? ", or the moment the auction reads seconds from its end" : ""}${live ? "" : " — for a live run; this one sends nothing"}`);
  console.log(`    max cards    ${maxCards > 0 ? maxCards : "every candidate"}`);
  console.log(`    batch        ${batchSize} cert(s) priced per round, ${concurrency} at a time; every candidate is priced`);
  for (const grader of GRADERS) console.log(`    tiers ${grader}    ${formatTiers(tierTable()[grader])}`);
  console.log(`    per card     at most ${maxCopiesPerCard()} lot(s) of one card winning or won, whatever the grade or grader`);
  console.log(`    sales rule   ${MIN_SALES} sales, every one inside the last ${SALES_WINDOW_DAYS} days`);
  if (live) console.log(`    poll         every ${pollS}s once the bids are on, ${Math.max(MIN_POLL_S, Math.round(pollS / POLL_EXTENDED_DIVISOR))}s in extended bidding`);
  if (wantEmail) console.log(`    account      ${wantEmail}`);
  console.log();

  // 1. The house.
  console.log(`  ── scanning ${venue.name}`);
  const scanned = await venue.scan({ headed, now });
  const lots = scanned.lots;
  const closesAt = scanned.closesAtUnixS;
  console.log(`    ${lots.length} live PSA/CGC 7–10 Pokémon lot(s)`);
  if (Number.isFinite(closesAt)) {
    console.log(`    ${untilClose(closesAt)}  (${fmtLocal(closesAt, venue.timeZone, venue.zoneLabel)})`);
    console.log(`    the bids go on at ${fmtLocal(fireAtUnixS(closesAt, fireAfterMin), venue.timeZone, venue.zoneLabel)}${live ? "" : " — in a live run"}`);
  }

  // 2. Chase list, where the house has one.
  const selected = selectCandidates(lots, (line) => console.log(line), { chaseList: venue.chaseList });
  let candidates = selected.candidates;
  const onChaseList = candidates.length;
  const rejected: Row[] = selected.rejected.map(({ candidate, reason }) => ({ ...baseRow(candidate), reason }));

  let beyondMaxCards = 0;
  if (maxCards > 0 && candidates.length > maxCards) {
    for (const c of candidates.slice(maxCards)) {
      const row = baseRow(c); row.reason = `beyond --max-cards=${maxCards}`; rejected.push(row);
    }
    beyondMaxCards = candidates.length - maxCards;
    candidates = candidates.slice(0, maxCards);
  }
  console.log(`    ${candidates.length} candidate(s)${venue.chaseList ? " on the chase list" : ""}`);
  console.log();

  // 3. The sessions the run needs: Card Uploader for pricing and identity, the
  //    house for quoting and bidding. A plan needs neither account.
  let cu: CuSession | null = null;
  let session: Session | null = null;

  const prices = new Map<string, CuPrice>();
  const worthy: Row[] = [];        // everything that came through the caps, for the CSV
  const bidding: Row[] = [];       // the subset the bidder may act on
  let cursor = 0;                  // candidates put through pricing so far
  let survivorCount = 0;
  let identifiedFor = 0;
  let flaggedOut = 0;
  let unawardableCount = 0;
  let notBiddable = 0;
  let auctionClosed = false;

  try {
    if (candidates.length > 0) {
      console.log(`  ── signing in to Card Uploader`);
      cu = await openCardUploader({ headed, batchPrefix });
      console.log();
    }
    if ((live || quoteOnly) && candidates.length > 0) {
      console.log(`  ── signing in to ${venue.name}`);
      session = await venue.open({ headed, login: false, email: wantEmail, password: wantPassword, live });
      console.log();
    }

    const book = new BidBook(session, { budgetCents, live, log, steps: venue.steps, listingUrl: venue.listingUrl, caps: cardCaps(), countInherited: countExistingBids });
    if (session) await book.seed();
    log("start", { mode, budgetCents, countExistingBids, fireAfterMin, chaseList: candidates.length });
    /** Lots a re-scan found already past the max, and why — kept out of the fire and said so in the CSV. */
    const pricedOutBy = new Map<string, string>();
    /** Whether the bids have gone on. Before that a live run holds; after it, it watches. */
    let fired = false;

    /**
     * One round: price a batch of candidates, work out which are worth a bid,
     * buy the identity for those, apply the caps, and put whatever survives in
     * front of the budget. The batch is the next slice of the list, or — on the
     * last pass — the stragglers earlier rounds could not price, swept with
     * patience this time.
     */
    let rounds = 0;
    const pricingStartedMs = Date.now();
    const priceRound = async (batch: Candidate[], sweep = false): Promise<void> => {
      rounds++;
      const roundStarted = Date.now();
      const first = candidates.indexOf(batch[0]) + 1;
      console.log(`  ── ${clock()} ${venue.zoneLabel}  ·  round ${rounds}: ${sweep ? `${batch.length} straggler(s)` : `candidates ${first}–${first + batch.length - 1} of ${candidates.length}`}  ·  ${untilClose(closesAt)}`);

      if (cu) {
        await refreshCuToken(cu);
        await priceByCert(cu, batch, { prices, concurrency, sweep });
      }

      let passed: Row[] = [];
      let survivors: Candidate[] = [];
      const unawardableHere: Row[] = [];
      for (const c of batch) {
        const { row, worthy: ok } = evaluate(c, prices.get(`${c.grader}:${c.cert}`), now);
        if (ok) { passed.push(row); survivors.push(c); continue; }
        rejected.push(row);
        if (row.unawardable) unawardableHere.push(row);
      }
      // The sourcing check's cut, said as it happens: a card no pack could
      // award is not bought, and a round that drops many is worth a look.
      if (unawardableHere.length > 0) {
        unawardableCount += unawardableHere.length;
        const examples = unawardableHere.slice(0, 3).map((r) => `${r.lot} at $${r.market_price}`).join(", ");
        console.log(`    ${unawardableHere.length} unawardable — no pack can award what the card is worth (${examples}${unawardableHere.length > 3 ? ", …" : ""})`);
        log("unawardable", {
          count: unawardableHere.length,
          lots: unawardableHere.slice(0, 10).map((r) => ({ lot: r.lot, listingId: r.listing_id, marketPrice: r.market_price, salesMedian: r.sales_median, reason: r.unawardable })),
        });
      }

      // The bid the maths was measured against is the one the scan saw, which
      // on the afternoon of the close is hours of bidding ago. A lot the room
      // has since taken past our max is not worth two credits to identify, and
      // it would sit at the head of the pool holding a place it can never use.
      // The two arrays are pushed in step above, so an index is the same lot
      // in both. Free, and it fails open: a lot the house will not answer for
      // keeps its place rather than losing it to a bad connection.
      if (session && survivors.length > 0) {
        const quoter = session;
        const quoting = Date.now();
        const quotes = await parallel(passed, QUOTE_CONCURRENCY, (row) => quoter.quote(row.listing_id).catch(() => null));
        console.log(`    quoted ${passed.length} survivor(s) at ${venue.name} in ${((Date.now() - quoting) / 1000).toFixed(1)}s`);
        const stale: Row[] = [];
        const keptRows: Row[] = [];
        const keptCandidates: Candidate[] = [];
        for (const [i, row] of passed.entries()) {
          const lot = quotes[i];
          if (lot) {
            const hammer = Number(row.max_bid_hammer);
            row.current_bid = lot.currentBidCents / 100;
            row.bid_count = lot.bidCount;
            row.headroom = round2(hammer - row.current_bid);
            if (lot.isClosed || lot.currentBidCents >= Math.round(hammer * 100)) {
              row.reason = lot.isClosed
                ? "the lot closed before it could be bid on"
                : `current bid $${row.current_bid} is already at or above max hammer $${hammer}`;
              stale.push(row);
              continue;
            }
          }
          keptRows.push(row);
          keptCandidates.push(survivors[i]);
        }
        passed = keptRows;
        survivors = keptCandidates;
        if (stale.length > 0) {
          rejected.push(...stale);
          console.log(`    ${stale.length} survivor(s) bid past the max since the scan — dropped before identifying, ~${stale.length * 2} credits saved`);
        }
      }
      survivorCount += survivors.length;

      // The one step that spends credits, and only on what survived the maths.
      // card_key comes from it, and card_key is what holds a run to its few
      // lots of one card, so the cap depends on this landing.
      if (cu && survivors.length > 0) {
        console.log(`    identifying ${survivors.length} surviving lot(s)  (~${survivors.length * 2} credits)`);
        identifiedFor += survivors.length;
        const identifying = Date.now();
        try {
          const cards = await identifyViaBatch(cu, survivors, batchPrefix, { between: live ? pollBetween : undefined });
          for (const [key, card] of cards) {
            const price = prices.get(key);
            if (price) price.card = card;
          }
          console.log(`    identified ${cards.size} of ${survivors.length} in ${((Date.now() - identifying) / 1000).toFixed(0)}s`);
          // Re-run the same maths now the identity is in hand: the verdict does
          // not depend on it, but card_key and the flags do. The bidding as
          // quoted above is carried over, since a fresh row only knows the
          // scan's snapshot of it.
          const before = passed;
          passed = survivors.map((c, i) => {
            const fresh = evaluate(c, prices.get(`${c.grader}:${c.cert}`), now).row;
            fresh.current_bid = before[i].current_bid;
            fresh.bid_count = before[i].bid_count;
            fresh.headroom = before[i].headroom;
            return fresh;
          });
        } catch (err) {
          await snapshotFailure(cu.page, outDir);
          console.error(`    ✖  identification failed: ${err instanceof Error ? err.message : err}`);
          console.error(`       these lots stay unidentified, so the ${maxCopiesPerCard()}-per-card cap holds them back`);
        }
      }

      // Card priority order first — PSA 10 down to 7, then CGC Pristine, Gem
      // Mint, 9.5 down to 7 — and the most headroom inside it.
      passed.sort((a, b) => a.priority - b.priority || Number(b.headroom) - Number(a.headroom));
      const cut = finalCut(passed);
      rejected.push(...cut.dropped);
      flaggedOut += cut.flaggedOut;
      worthy.push(...cut.worthy);
      for (const row of cut.worthy) {
        if (toBiddable(row)) bidding.push(row); else notBiddable++;
      }
      console.log(`    ${cut.worthy.length} worth a bid this round, ${worthy.length} so far`);

      // The pool is rebuilt in priority order every round: a later batch can
      // hold a better lot than an earlier one, and the fire should meet the
      // best of what is known rather than the first thing found. A plan bids
      // (on paper) as it goes; a live run holds everything for the fire, and
      // only a round priced after it hands its lots to the watch below.
      bidding.sort((a, b) => a.priority - b.priority || Number(b.headroom) - Number(a.headroom));
      if (!live || fired) {
        const filled = await book.fill(pool());
        if (filled.auctionClosed) auctionClosed = true;
        console.log(`    ${book.standing()}`);
      } else {
        console.log(`    ${pool().length} lot(s) priced and held for the fire`);
      }

      // Where the pricing stands, and when it will be done at this pace: the
      // number to read against the time to the close.
      if (!sweep) {
        const elapsed = (Date.now() - pricingStartedMs) / 1000;
        const rate = cursor / Math.max(elapsed, 1);
        const left = candidates.length - cursor;
        console.log(`    round took ${((Date.now() - roundStarted) / 1000).toFixed(0)}s  ·  ${cursor} of ${candidates.length} priced in ${since(pricingStartedMs)}` +
          (left > 0 ? `, ${left} to go — about ${Math.round(left / rate / 60)} min at this pace` : ""));
      }
      console.log();
    };

    /** What the book may act on: every priced lot a re-scan has not already found past the max. */
    const pool = () => bidding.filter((row) => !pricedOutBy.has(row.listing_id)).map((row) => toBiddable(row)!);

    /** The next slice of the list, shorter when the close is near so the bids are looked at between them. */
    const nextBatch = (): Candidate[] => {
      const size = secondsToClose() <= NEAR_CLOSE_S ? Math.min(batchSize, EXTENDED_BATCH) : batchSize;
      const batch = candidates.slice(cursor, cursor + size);
      cursor += batch.length;
      return batch;
    };

    /** The certs earlier rounds could not price, worth one patient pass once the list is done. */
    const stragglers = () => candidates.filter((c) => {
      const p = prices.get(`${c.grader}:${c.cert}`);
      return p?.error && (p.attempts ?? 0) < PRICE_ATTEMPTS;
    });

    /** Whether there is more list to price: every lot is, until the auction closes. */
    const needMore = () => cursor < candidates.length && !auctionClosed;

    // The auction's own clock, shared by the pricing loop and the hold loop.
    // Until the house has been asked, the scan's end time stands in for it.
    const state: { auction: AuctionState | null } = { auction: null };
    /** Seconds until extended bidding opens (negative once it has): the advertised close, which does not move. */
    const secondsToClose = () => (state.auction?.scheduledEndUnixS || closesAt) - Math.floor(Date.now() / 1_000);
    const phase = () => state.auction?.status ?? (secondsToClose() > 0 ? "LIVE" : "EXTENDED_BIDDING");
    /** When the bids go on, on the house's own clock once it has been read. */
    const fireAt = () => fireAtUnixS(state.auction?.scheduledEndUnixS || closesAt, fireAfterMin);
    const fireDue = () => timeToFire({ nowUnixS: Math.floor(Date.now() / 1_000), fireAtUnixS: fireAt(), closesTogether: venue.closesTogether, auction: state.auction });

    /**
     * Read every bid back, then spend whatever came free.
     *
     * Two requests, which is cheap enough to do between batches as well as in
     * the hold loop — and it has to be. A big budget never fills, so the
     * pricing loop below walks the whole chase list, and that is an hour or
     * more in which bids already on the books would otherwise go unwatched.
     */
    let lastPolledMs = 0;
    const pollAndFill = async (): Promise<{ changes: number; freed: number; placed: number }> => {
      if (!live) return { changes: 0, freed: 0, placed: 0 };
      lastPolledMs = Date.now();
      const polled = await book.poll();
      state.auction = polled.auction ?? state.auction;
      if (polled.auctionClosed) { auctionClosed = true; return { changes: polled.changes, freed: polled.freed, placed: 0 }; }
      // Before the fire there is nothing to spend on: the poll is for the
      // clock and for what the account was already carrying.
      if (!fired) return { changes: polled.changes, freed: polled.freed, placed: 0 };
      const filled = await book.fill(pool());
      if (filled.auctionClosed) auctionClosed = true;
      return { changes: polled.changes, freed: polled.freed, placed: filled.placed };
    };

    /**
     * The look at the bids an identify job takes between its own checks: at
     * the hold loop's pace, not the job's, so a minute-long job is one or two
     * polls rather than thirty.
     */
    const pollBetween = async () => {
      if (Date.now() - lastPolledMs < pollDelayS(pollS, phase(), secondsToClose()) * 1_000) return;
      await pollAndFill();
    };

    let fireCameFirst = false;
    while (needMore()) {
      await priceRound(nextBatch());
      await pollAndFill();
      if (auctionClosed) break;
      // A run started too late to price everything before the fire fires
      // with what it has; the watch below prices the rest between polls and
      // bids on it as it comes.
      if (live && fireDue().fire) {
        fireCameFirst = true;
        console.log(`    the fire time has come with ${candidates.length - cursor} candidate(s) unpriced — the bids go on now, the rest are priced after\n`);
        break;
      }
    }

    // The patient pass over whatever never answered, now that nothing waits on it.
    if (!auctionClosed && !fireCameFirst && stragglers().length > 0) {
      await priceRound(stragglers(), true);
      await pollAndFill();
    }

    if (cursor < candidates.length) {
      console.log(`    ${candidates.length - cursor} candidate(s) left unpriced\n`);
    }

    // 4. Hold. Nothing is bid until the fire: the clock is read, and from
    //    half an hour out the house is re-scanned every few minutes so the run
    //    knows which of its lots the room has already taken past the max.
    /**
     * The same scan as at the start, for where the bidding stands now. A lot
     * the least next bid has passed the max on is out of the fire; one the
     * scan did not return keeps its place — a partial answer from the index is
     * not the lot going anywhere, and the fire quotes it anyway.
     */
    const rescan = async () => {
      const started = Date.now();
      let fresh: { lots: ScannedLot[] };
      try {
        fresh = await venue.scan({ headed, now: new Date(), light: true });
      } catch (err) {
        console.warn(`    ⚠️  re-scan failed (${err instanceof Error ? err.message : err}); the last look stands`);
        return;
      }
      const byId = new Map(fresh.lots.map((l) => [l.listingId, l]));
      let under = 0;
      let out = 0;
      let unseen = 0;
      for (const row of bidding) {
        if (pricedOutBy.has(row.listing_id) || book.settled.has(row.listing_id)) continue;
        const biddable = toBiddable(row);
        if (!biddable) continue;
        const lot = byId.get(row.listing_id);
        if (!lot) { unseen++; under++; continue; }
        row.current_bid = lot.currentBid;
        row.bid_count = lot.bidCount;
        row.headroom = round2(Number(row.max_bid_hammer) - lot.currentBid);
        const why = pricedOut(biddable, { currentBidCents: Math.round(lot.currentBid * 100), bidCount: lot.bidCount }, venue.steps);
        if (why) { pricedOutBy.set(row.listing_id, `passed the max before the bids went on — ${why}`); out++; } else under++;
      }
      console.log(`    ${clock()} ${venue.zoneLabel}  ·  re-scan in ${((Date.now() - started) / 1000).toFixed(0)}s: ${under} lot(s) still under the max, ${out} passed it since the last look${unseen > 0 ? ` (${unseen} not in this scan, kept)` : ""}, ${pricedOutBy.size} out in all`);
      log("rescan", { under, out, unseen, outInAll: pricedOutBy.size });
    };

    if (live && !auctionClosed && !fired) {
      console.log(`  ── holding  ·  the bids go on at ${fmtLocal(fireAt(), venue.timeZone, venue.zoneLabel)}, ${fireAfterMin} min after extended bidding opens${venue.closesTogether ? ", or the moment the auction reads seconds from its end" : ""}`);
      console.log(`     ${pool().length} lot(s) priced and held; the house is re-scanned every ${RESCAN_EVERY_S / 60} min from ${RESCAN_FROM_S / 60} min out`);
      let lastRescanMs = 0;
      let lastSpoke = Date.now();
      for (;;) {
        // The house's own clock, read directly: cheap, and the only thing
        // that can move the fire.
        if (session) {
          const read = await session.readAuction(state.auction?.id ?? "").catch(() => null);
          if (read) state.auction = read;
          if (read?.status === "CLOSED") { auctionClosed = true; break; }
        }
        const due = fireDue();
        if (due.fire) { console.log(`    ${clock()} ${venue.zoneLabel}  ·  ${due.why}`); break; }

        const nowS = Math.floor(Date.now() / 1_000);
        if (fireAt() - nowS <= RESCAN_FROM_S && Date.now() - lastRescanMs >= RESCAN_EVERY_S * 1_000) {
          await rescan();
          lastRescanMs = Date.now();
        }
        if (Date.now() - lastSpoke >= HEARTBEAT_MS) {
          const at = state.auction;
          console.log(`  ── ${clock()} ${venue.zoneLabel}  ·  ${at ? `${at.name} ${at.status.toLowerCase().replace("_", " ")}` : untilClose(closesAt)}  ·  ${Math.max(0, Math.round((fireAt() - nowS) / 60))} min to the fire  ·  ${pool().length} lot(s) held, ${pricedOutBy.size} out`);
          log("holding", { minutesToFire: Math.round((fireAt() - nowS) / 60), held: pool().length, out: pricedOutBy.size, auction: at?.status });
          lastSpoke = Date.now();
        }
        // In extended bidding at a house that ends as one, the clock is the
        // whole game and is read every few seconds; otherwise nothing can end
        // and once a minute is plenty.
        const extended = phase() === "EXTENDED_BIDDING";
        await sleep((venue.closesTogether && extended ? HOLD_POLL_EXTENDED_S : HOLD_POLL_S) * 1_000);
      }
    }

    // 5. Fire. Everything priced and still under the max, all at once.
    if (live && !auctionClosed && !fired) {
      const firing = Date.now();
      console.log(`  ── ${clock()} ${venue.zoneLabel}  ·  the bids go on`);
      const shot = await book.fire(pool(), { concurrency: FIRE_CONCURRENCY });
      fired = true;
      if (shot.auctionClosed) auctionClosed = true;
      console.log(`    ${shot.placed} bid(s) on in ${((Date.now() - firing) / 1000).toFixed(1)}s, of ${shot.picked} picked`);
      console.log(`    ${book.standing()}`);
      log("fired", { picked: shot.picked, placed: shot.placed, exposureCents: shot.exposureCents, seconds: (Date.now() - firing) / 1000 });
    }

    // 6. Watch. An outbid copy frees its place under the per-card cap for the
    //    next copy; a bid the house turned down in the rush is quoted again;
    //    whatever is left of the list is priced between polls.
    if (live) {
      console.log(`  ── watching the bids  ·  looking every ${pollS}s, oftener as it closes`);
      let lastSpoke = 0;
      let polls = 0;
      for (;;) {
        if (auctionClosed) break;
        if (book.finished() && book.full(pool()) && cursor >= candidates.length) break;

        // The auction's own clock decides the pace and how deep a bench to
        // keep: the last quarter of an hour and extended bidding are when both
        // matter, and the hours before them are when there is time to prepare.
        await sleep(pollDelayS(pollS, phase(), secondsToClose()) * 1_000);
        polls++;

        // Every round, not only when a lot was outbid: a bid the house turned
        // down the first time is quoted again here, and costs nothing to try
        // when the budget has nothing free anyway.
        const polled = await pollAndFill();
        if (auctionClosed) break;

        // Whatever is left of the list, one short batch a pass, never a run of
        // them: pricing means waiting on Card Uploader to resolve a batch of
        // certs, which can take minutes, and those are minutes the bids are
        // not being watched. During extended bidding that trade is only worth
        // making with nothing left waiting for the budget at all.
        const extended = phase() === "EXTENDED_BIDDING";
        if (needMore() && (!extended || book.waiting(pool()) === 0)) {
          await priceRound(nextBatch());
          await pollAndFill();
          if (auctionClosed) break;
        }

        // Speak when something moved, and otherwise often enough that the log
        // shows a run that is waiting rather than one that has hung.
        const moved = polled.changes > 0 || polled.freed > 0 || polled.placed > 0;
        if (moved || Date.now() - lastSpoke >= HEARTBEAT_MS) {
          const standing = book.standing();
          const at = state.auction;
          const where = at ? `${at.name} ${at.status.toLowerCase().replace("_", " ")}` : untilClose(closesAt);
          console.log(`  ── ${clock()} ${venue.zoneLabel}  ·  ${where}  ·  ${untilClose(closesAt)}  ·  ${polls} poll(s), ${since(startedMs)} in`);
          console.log(`     ${standing}`);
          console.log(`     ${book.waiting(pool())} lot(s) priced and not bid on, ${cursor} of ${candidates.length} candidate(s) priced`);
          log("heartbeat", { polls, standing, waiting: book.waiting(pool()), priced: cursor, auction: at?.status });
          lastSpoke = Date.now();
        }
      }
      console.log(auctionClosed
        ? `\n    the auction has closed`
        : `\n    nothing open on the account and nothing more the ceiling reaches`);

      const result = book.result();
      console.log(`\n  ── result after ${since(startedMs)}`);
      for (const won of result.won) {
        console.log(`    🏆 ${dollars(won.cents)} hammer  ${won.lot}  ${won.title}`);
        console.log(`       ${venue.listingUrl(won.listingId)}`);
      }
      console.log(`    ${result.won.length} won for ${dollars(result.hammerCents)} hammer, ${dollars(result.allInCents)} all-in`);
      console.log(`    ${result.winning.length} still winning, ${result.outbid.length} outbid, ${result.lost.length} closed to someone else`);
      log("result", {
        won: result.won.length, hammerCents: result.hammerCents, allInCents: result.allInCents,
        winning: result.winning.length, outbid: result.outbid.length, lost: result.lost.length,
      });
    }

    // 7. What happened, written onto the rows the CSV is made of.
    //
    //    Sorted the way the fire met them, so the file reads as the run did:
    //    what was bid on and how it ended, then — in order — what the next
    //    bid would have gone to had the ceiling reached it.
    worthy.sort((a, b) => a.priority - b.priority || Number(b.headroom) - Number(a.headroom));
    const placedBy = new Map(book.placed.map((b) => [b.listingId, b]));
    const inheritedBy = new Map(book.inherited.map((b) => [b.listingId, b]));
    const skippedBy = new Map(book.skipped.map((s) => [s.listingId, s]));
    let queue = 0;
    let pricedOutCount = 0;
    for (const row of worthy) {
      const id = row.listing_id;
      const bid = placedBy.get(id);
      if (bid) {
        row.bid_placed = bid.cents / 100;
        row.bid_status = bidOutcome(bid);
        row.final_bid = bid.currentBidCents ? bid.currentBidCents / 100 : "";
        settle(row, bid);
        continue;
      }
      // A lot the account was already bidding on is left exactly as it was,
      // and its bid is the account's rather than this run's — so the row says
      // what is on it without claiming this run put it there.
      const already = inheritedBy.get(id);
      if (already) {
        row.bid_status = `not bid: this account already had ${dollars(already.cents)} on it`;
        row.final_bid = already.currentBidCents ? already.currentBidCents / 100 : "";
        settle(row, already);
        continue;
      }
      const skipped = skippedBy.get(id);
      if (skipped) { row.bid_status = `not bid: ${skipped.reason}`; continue; }
      const out = pricedOutBy.get(id);
      if (out) { row.bid_status = `not bid: ${out}`; pricedOutCount++; continue; }
      if (!toBiddable(row)) { row.bid_status = "not bid: see flags"; continue; }
      row.bid_rank = ++queue;
      row.bid_status = "next in line";
    }

    // The one file worth keeping, and the page the Actions summary shows.
    writeFileSync(join(outDir, csvName), toCsv(worthy));
    writeFileSync(join(outDir, "summary.md"), summaryMarkdown(worthy, rejected, onChaseList, lots.length,
      { venue: venue.name, csv: csvName, mode, standing: book.standing(), chaseList: venue.chaseList }));
    log("end", { standing: book.standing(), priced: cursor, worthy: worthy.length });

    // The run in one column. The CSV holds the detail; this says where the lots
    // went, so a thin bid list explains itself.
    const walked = candidates.slice(0, cursor);
    const neverAnswered = walked.filter((c) => prices.get(`${c.grader}:${c.cert}`)?.error).length;
    const pricedOk = walked.length - neverAnswered;
    const lines: FunnelLine[] = [{ kind: "total", n: lots.length, label: "live PSA/CGC 7–10 Pokémon lots" }];
    const cut = (n: number, label: string) => { if (n > 0) lines.push({ kind: "cut", n, label }); };

    cut(selected.counts.offChaseList, "off the chase list");
    cut(selected.counts.noCert, "no cert number");
    cut(selected.counts.blockList, `block list${selected.counts.blockListDetail ? ` (${selected.counts.blockListDetail})` : ""}`);
    cut(selected.counts.masterBallOrDuplicate, "Master Ball below grade / duplicate cert");
    cut(beyondMaxCards, `beyond --max-cards=${maxCards}`);
    lines.push({ kind: "rule" }, { kind: "total", n: candidates.length, label: venue.chaseList ? "on the chase list" : "candidates (every PSA/CGC lot)" });

    cut(candidates.length - cursor, "never reached — the auction closed first");
    lines.push({ kind: "rule" }, { kind: "total", n: cursor, label: "priced (free)" });

    cut(neverAnswered, "never answered — Card Uploader timed out");
    lines.push({ kind: "rule" }, { kind: "total", n: pricedOk, label: "actually priced" });

    cut(unawardableCount, "unawardable — no pack can award what the card is worth");
    cut(pricedOk - survivorCount - unawardableCount, "failed the bid maths");
    lines.push({ kind: "rule" }, { kind: "total", n: survivorCount, label: `survivors → identified, ~${identifiedFor * 2} credits` });

    cut(flaggedOut, "flagged as do-not-bid, or never identified — dropped");
    lines.push({ kind: "rule" }, { kind: "total", n: worthy.length, label: "worth a bid" });

    cut(notBiddable, "unidentified, so not bid on");
    cut(book.inherited.length, "already carrying a bid of this account's, left alone");
    cut(pricedOutCount, "passed the max before the bids went on");
    cut(book.skipped.length, `passed over at ${venue.name} — closed, or past the max`);
    cut(worthy.length - notBiddable - book.inherited.length - book.skipped.length - pricedOutCount - book.placed.length,
      "left waiting — beyond the ceiling");
    lines.push({ kind: "rule" }, { kind: "total", n: book.placed.length, label: live ? "bid on" : "would be bid on" });

    console.log(funnelText(lines));
    console.log(`\n    ${book.standing()}`);
  } catch (err) {
    if (cu) await snapshotFailure(cu.page, outDir);
    if (session) await session.snapshot(join(outDir, "bidder-failure.png")).catch(() => {});
    throw err;
  } finally {
    await cu?.close();
    await session?.close();
  }
}

/** The entry point every venue's file ends with. */
export function runAsMain(venue: Venue) {
  runSniper(venue).catch((err) => {
    console.error("\nSniper run failed:", err.message ?? err);
    process.exit(1);
  });
}
