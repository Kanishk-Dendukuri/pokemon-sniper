/**
 * The sniper's book: the budget, and what it is holding.
 *
 * Everything here is about money and nothing here is about any one auction
 * house. An Exchange — scripts/fanatics-bidder.ts, scripts/alt-bidder.ts — is
 * what talks to a site: it quotes a lot, reads the account's bids, reads the
 * auction's clock and sends a bid. The book drives it, and holds the rules:
 *
 * The bid placed is a max bid, the way both sites take one: the site bids up
 * on this account's behalf an increment at a time and never past the amount
 * given. The amount given is the largest rung of the site's bid ladder at or
 * below the lot's max hammer — never above it. withinMax() checks that on the
 * way out, right before the request, and throws rather than sends. A lot whose
 * next acceptable bid is already past the max gets no bid at all. And a lot
 * that has this account's max on it is never bid again: outbid means someone
 * went past the max, and past the max is not somewhere this goes.
 *
 * Budget is the all-in cost — hammer plus the buyer's premium — of the bids
 * this run has placed and is still winning. An outbid lot releases its share;
 * a won lot keeps it.
 *
 * Bids that were on the account before the run started are not part of it.
 * They are left exactly as they are — the run never bids on those lots again
 * and never raises them — but the budget given is what this run may commit,
 * not what the account may hold in total.
 */

/** Both houses: "A 20% buyer's premium is added to the hammer price of all sales." */
export const BUYERS_PREMIUM = 0.20;

export const DEFAULT_BUDGET_DOLLARS = 100;

/**
 * A bid the site turned down — too low by the time it landed, say — is quoted
 * again on a later round and tried once more, this many times in all.
 */
const BID_ATTEMPTS = 3;
/**
 * Lots the account is not allowed to bid on, in a row, before the run gives up
 * on the account rather than the lots: no payment method on file reads the
 * same as any other lot it cannot buy.
 */
const CANNOT_BUY_LIMIT = 3;
/**
 * Bids refused in a row for the account's own reasons, with none taken all
 * run, before the run gives up on the account rather than the lots. A house
 * that tells us per lot whether this account may buy has CANNOT_BUY_LIMIT for
 * the same thing; Alt does not, and says what is missing only when a bid is
 * turned down. A refusal the house blames on the lot — outbid by a max already
 * standing, say — is not counted at all: see RefusalBlame.
 */
const REFUSAL_LIMIT = 5;
/**
 * Per-lot quotes one poll may spend on bids that read left out. It is a
 * ceiling on how long a poll can take, which during extended bidding is the
 * whole game: better a stale standing on a few lots than a poll that runs
 * longer than the window it is watching.
 */
const FALLBACK_QUOTES_PER_POLL = 25;
/** Tries the account-wide read gets before the caller is told it failed. */
const ACCOUNT_BIDS_ATTEMPTS = 3;
/**
 * How long a site is given to own up to a bid it has accepted.
 *
 * Both reads — the lot's own page and the account-wide one — can answer for a
 * few seconds as though a just-placed bid does not exist. Inside this window a
 * lot with no max on it says nothing about the bid, so nothing is concluded
 * from it.
 */
const BID_SETTLE_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Money ─────────────────────────────────────────────────────────────────────

/**
 * A bid ladder, in cents: the step grows at each boundary. Two houses read
 * the same table two ways. Fanatics builds fixed rungs from it — a bid has to
 * sit on one, so the amount sent is the rung at or below the lot's max, never
 * the max rounded up to one. Alt reads it as increments — the next bid is the
 * standing bid plus the step of its band, and any whole dollar at or above
 * that is taken. BidSteps is the house's own reading, and the book only ever
 * asks through it.
 */
export type Ladder = { step: number; upTo: number }[];

/** The highest rung of the ladder at or below `cents`; 0 when there is none. */
export function rungAtOrBelow(ladder: Ladder, cents: number): number {
  let at = 0;
  for (;;) {
    const band = ladder.find((b) => b.upTo > at);
    if (!band || at + band.step > cents) return at;
    at += band.step;
  }
}

/** The lowest rung of the ladder at or above `cents`. */
export function rungAtOrAbove(ladder: Ladder, cents: number): number {
  let at = 0;
  while (at < cents) {
    const band = ladder.find((b) => b.upTo > at);
    if (!band) return Infinity;
    at += band.step;
  }
  return at;
}

/** The step of the band a standing bid of `cents` sits in — what the next bid must add. */
export function incrementAt(ladder: Ladder, cents: number): number {
  const band = ladder.find((b) => b.upTo > cents) ?? ladder[ladder.length - 1];
  return band.step;
}

/**
 * How a house takes a bid: the most it will accept at or below a max, and the
 * least it will take next given where a lot stands.
 */
export type BidSteps = {
  /** The highest amount the house accepts at or below `cents`; 0 when there is none. */
  below(cents: number): number;
  /** The least the house will take next, from the standing bid and the opening price. */
  minimum(quote: Quote): number;
};

/** Fixed rungs, the Fanatics way. */
export function rungSteps(ladder: Ladder): BidSteps {
  return {
    below: (cents) => rungAtOrBelow(ladder, cents),
    minimum: (quote) => rungAtOrAbove(ladder, Math.max(quote.startingPriceCents, quote.bidCount > 0 ? quote.currentBidCents + 1 : 0)),
  };
}

/** Standing bid plus the band's increment, any whole dollar on or above, the Alt way. */
export function incrementSteps(ladder: Ladder): BidSteps {
  return {
    below: (cents) => Math.max(0, Math.floor(cents / 100) * 100),
    minimum: (quote) => quote.bidCount > 0
      ? quote.currentBidCents + incrementAt(ladder, quote.currentBidCents)
      : Math.max(quote.startingPriceCents, 0),
  };
}

/** What a hammer price costs once the buyer's premium is on it. */
export function allInCents(hammerCents: number): number {
  return Math.round(hammerCents * (1 + BUYERS_PREMIUM));
}

export function dollars(cents: number): string {
  const s = (cents / 100).toFixed(2);
  return `$${s.endsWith(".00") ? s.slice(0, -3) : s}`;
}

// ── A lot worth bidding on ────────────────────────────────────────────────────

/**
 * What the pipeline hands over: which lot, the most to pay for it, and the
 * scan's own snapshot of where the bidding stood. The snapshot stands in for a
 * quote when there is no exchange — see snapshotLot() below.
 */
export type Biddable = {
  listingId: string;
  title: string;
  lot: string;
  maxHammerCents: number;
  maxAllInCents: number;
  currentBidCents: number;
  bidCount: number;
  /** Which card this is a copy of, for the per-card cap; two lots of one card share it. */
  cardKey?: string;
};

/**
 * The most lots of one card this run may be winning or have won at once —
 * grade and grader do not come into it. An outbid copy makes room for the
 * next; a won one keeps its place.
 */
export type CardCaps = { perCard: number };

/**
 * The one rule with real money behind it: the amount sent is never above the
 * lot's max. Called on the way out, right before the request, and it throws
 * rather than returns — a bid this cannot vouch for is not placed.
 */
export function withinMax(cents: number, row: Pick<Biddable, "maxHammerCents" | "maxAllInCents" | "title">): number {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`refusing to bid ${cents} cents on ${row.title}`);
  }
  if (cents > row.maxHammerCents) {
    throw new Error(`refusing to bid ${dollars(cents)} on ${row.title}: the max hammer is ${dollars(row.maxHammerCents)}`);
  }
  if (allInCents(cents) > row.maxAllInCents) {
    throw new Error(`refusing to bid ${dollars(cents)} on ${row.title}: ${dollars(allInCents(cents))} all-in is over the max of ${dollars(row.maxAllInCents)}`);
  }
  return cents;
}

/** Where a lot stands, as the site reports it. */
export type Quote = {
  currentBidCents: number;
  startingPriceCents: number;
  bidCount: number;
  /**
   * The least the site will take next, when it says so itself. Without it the
   * ladder works it out from the current bid and the starting price.
   */
  minimumNextBidCents?: number;
};

/**
 * What to bid on a lot, or why not.
 *
 * The site's rule for the lowest bid it will take, from the starting price and
 * the current bid — or the figure the site quotes outright. Ours is the most
 * the site accepts at or below the max. When the lowest it takes is above the
 * highest we give, the lot is passed over — that is the whole of the rule.
 */
export function bidAmount(row: Pick<Biddable, "maxHammerCents">, quote: Quote, steps: BidSteps): { cents: number } | { skip: string } {
  const minimum = quote.minimumNextBidCents ?? steps.minimum(quote);
  const ours = steps.below(row.maxHammerCents);
  if (ours <= 0 || ours < minimum) {
    return { skip: `the next bid is ${dollars(minimum)}, the max hammer is ${dollars(row.maxHammerCents)}` };
  }
  return { cents: ours };
}

// ── Standing ──────────────────────────────────────────────────────────────────

/**
 * The site's word for where a bid stands, plus two of ours: PENDING for a bid
 * just sent and not yet read back, PLANNED for one never sent.
 */
export type BidStatus = "HIGH_BID" | "OUTBID" | "NO_BIDS" | "NO_STATUS" | "PENDING" | "PLANNED";

export type PlacedBid = {
  listingId: string;
  title: string;
  lot: string;
  cents: number;
  allInCents: number;
  status: BidStatus;
  closed: boolean;
  at: string;
  /** What the lot stood at when it was last looked at — what it went for, once closed. */
  currentBidCents?: number;
  /** The card this lot is a copy of, so the cap can count what is live per card. */
  cardKey?: string;
};

/** One of this account's bids, as the site reports it in the account-wide read. */
export type AccountBid = {
  listingId: string;
  title: string;
  lot: string;
  maxCents: number;
  status: BidStatus;
  closed: boolean;
  currentBidCents: number;
  highestBidder: boolean;
  /** Which auction the lot belongs to, and where that auction is in its life. */
  auctionId: string;
  auctionStatus: string;
};

/** Where one lot stands right now, straight from the site. */
export type Lot = Quote & {
  id: string;
  title: string;
  lot: string;
  highestBidder: boolean;
  isOwner: boolean;
  userMaxBidCents: number;
  userCanBuy: boolean;
  userBidStatus: BidStatus;
  isClosed: boolean;
  auctionId: string;
  /** LIVE, EXTENDED_BIDDING or CLOSED, whatever the site's own word for it. */
  auctionStatus: string;
};

/** Where an auction is in its life, on the site's own clock. */
export type AuctionState = {
  id: string;
  name: string;
  /** PREVIEW, LIVE, EXTENDED_BIDDING or CLOSED. */
  status: string;
  endsAtUnixS: number;
  /** When the open extended-bidding window shuts, if one is open. */
  windowEndsAtUnixS: number;
  windowOrdinal: number | null;
};

/**
 * Who a refused bid is about.
 *
 * "lot": the house took the request, priced it against this lot's book and
 * turned it down — outbid in the moment it took to send, under the next
 * increment, closed. A bid it priced at all is a bid this account was allowed
 * to make, so it says nothing about the account.
 *
 * "account": nothing was priced, because this account may not bid — no payment
 * method on file, a hold it will not cover, a limit reached.
 *
 * Only "account" counts toward REFUSAL_LIMIT.
 */
export type RefusalBlame = "lot" | "account";

export type BidResult = { ok: true; bidId: string | null } | { ok: false; error: string; blame?: RefusalBlame };

/**
 * What a refusal reads as when the house gives no structured reason, only a
 * sentence. Anything that quotes a price, an increment or the lot's own state
 * is the lot talking; everything else is read as the account, which is the
 * cautious way round — a run that stops on a working account is a nuisance, a
 * run that keeps firing at a broken one is hundreds of turned-down requests.
 */
export function blameOf(error: string): RefusalBlame {
  const lot = [
    /immediately outbid/i,
    /effective bid price/i,
    /already (?:the )?high(?:est)? bid/i,
    /(?:bid|amount|price)[^.]{0,40}too low/i,
    /must be (?:at least|greater|higher|more)/i,
    /bid increment/i,
    /(?:auction|listing|lot)[^.]{0,40}(?:closed|ended|over)/i,
    /no longer (?:open|accepting|available)/i,
  ];
  return lot.some((re) => re.test(error)) ? "lot" : "account";
}

/**
 * A bid on the account this run has to work around.
 *
 * The account-wide read can answer for every bid this account has ever placed,
 * last month's included. Only a lot still open, in an auction still running,
 * is one this run could otherwise have bid on — the rest are history and worth
 * neither reporting nor remembering.
 */
export function seedable(bid: Pick<AccountBid, "maxCents" | "closed" | "auctionStatus">): boolean {
  if (bid.maxCents <= 0 || bid.closed) return false;
  return bid.auctionStatus === "LIVE" || bid.auctionStatus === "EXTENDED_BIDDING" || bid.auctionStatus === "";
}

/**
 * What the budget currently holds: every bid this run placed that is winning,
 * or whose fate is not yet known. An outbid lot is off the books — it will not
 * be bid again — and a won lot stays on them, because it is being paid for.
 *
 * Only this run's bids reach here. What the account was already carrying lives
 * in BidBook.inherited and is nobody's budget but the account's.
 */
export function committedCents(placed: PlacedBid[]): number {
  return placed.filter(atRisk).reduce((sum, p) => sum + p.allInCents, 0);
}

/**
 * Whether a bid still has money behind it.
 *
 * Stated as what is *not* at risk, which is the only part there is no doubt
 * about: outbid means someone went past our max, and a lot that closed to
 * someone else is over. Everything else counts, and that includes a bid the
 * site has not made up its mind about yet.
 *
 * It was written the other way round — count HIGH_BID, PENDING and PLANNED —
 * and that was wrong in the one direction a budget must never be wrong. For a
 * few seconds after a bid is placed Fanatics answers NO_BIDS with a zero max
 * on a lot it has in fact taken the bid for, and a bid read that way fell out
 * of the budget entirely: committed went back to zero, the free budget never
 * shrank, and the run would have bid on every lot it could find.
 */
function atRisk(p: Pick<PlacedBid, "status" | "closed">): boolean {
  if (p.status === "OUTBID") return false;
  return !p.closed || p.status === "HIGH_BID";
}

/**
 * The next lot on the list that the free budget covers — at the amount that
 * would actually be bid, which the house's steps fix from the max alone.
 */
export function nextAffordable(rows: Biddable[], decided: Set<string>, freeCents: number, steps: BidSteps): Biddable | null {
  for (const row of rows) {
    if (decided.has(row.listingId)) continue;
    const ours = steps.below(row.maxHammerCents);
    if (ours > 0 && allInCents(ours) <= freeCents) return row;
  }
  return null;
}

// ── The exchange ──────────────────────────────────────────────────────────────

/**
 * What the book asks of an auction house. One of these per site, holding a
 * signed-in session; the book never sees the session itself.
 */
export interface Exchange {
  /** How the site takes a bid. */
  readonly steps: BidSteps;
  /** The lot's page, so a log line can be clicked through to what was bid on. */
  listingUrl(listingId: string): string;
  /** Where one lot stands right now. Throws when the site will not say. */
  quote(listingId: string): Promise<Lot>;
  /**
   * Every open bid on the account, in one request; null when the read itself
   * failed, which the book tells apart from an account with no bids on it.
   */
  accountBids(): Promise<Map<string, AccountBid> | null>;
  /** The auction a run is bidding in, by id, or the one closing soonest. */
  readAuction(auctionId: string): Promise<AuctionState | null>;
  /**
   * Sends one max bid. The book has already run withinMax(); the exchange runs
   * it again, last thing before the request.
   */
  sendBid(row: Biddable, cents: number): Promise<BidResult>;
}

/**
 * The scan's own snapshot dressed as a quote, for a run with no exchange: the
 * bid the search index reported when the lot was found. Everything a quote
 * knows about this account is blank, because there is no account.
 */
function snapshotLot(row: Biddable): Lot {
  return {
    id: row.listingId, title: row.title, lot: row.lot,
    currentBidCents: row.currentBidCents, startingPriceCents: 0, bidCount: row.bidCount,
    highestBidder: false, isOwner: false, userMaxBidCents: 0, userCanBuy: true,
    userBidStatus: "NO_BIDS", isClosed: false, auctionId: "", auctionStatus: "LIVE",
  };
}

// ── The book ──────────────────────────────────────────────────────────────────

export type Log = (event: string, detail: Record<string, unknown>, line?: string) => void;

/**
 * The budget, and what it is holding.
 *
 * fill() walks a pool of lots in the order given and bids until nothing left
 * in it fits the free budget; poll() reads the standing of every open bid back
 * and lets an outbid one go, which is what frees the budget for the next fill.
 * Between them they are the whole bidding loop — the pipeline decides when to
 * call which, and tops the pool up as it prices more of the auction.
 *
 * Without an exchange it is the same walk against the scan's snapshot instead
 * of a live quote, and nothing is sent: that is what a run without --live does.
 */
export class BidBook {
  readonly placed: PlacedBid[] = [];
  /**
   * Bids the account was already carrying when the run started, from an
   * earlier run or from a person. Recorded so the run can say it saw them and
   * why it left those lots alone; never bid on and never raised, whatever the
   * budget is told to count. Charged to this run's budget only with
   * countInherited.
   */
  readonly inherited: PlacedBid[] = [];
  readonly skipped: { listingId: string; title: string; reason: string }[] = [];
  /** Lots this is finished with: bid on, passed over, or already carrying a bid. */
  readonly settled = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private cannotBuy = 0;
  /** Bids turned down for the account's own reasons since the last one taken. */
  private refusals = 0;
  /** Bids this run has had taken, over every round. */
  private taken = 0;
  /** Learned from the first lot quoted, and used to read that auction's clock. */
  private auctionId = "";
  /** Where the last poll stopped quoting the bids the account read left out. */
  private fallbackCursor = 0;

  constructor(
    private readonly exchange: Exchange | null,
    private readonly opts: {
      budgetCents: number; live: boolean; log: Log; steps: BidSteps;
      listingUrl?: (listingId: string) => string;
      /** Without a cap, every copy of a card may be bid on. */
      caps?: CardCaps;
      /**
       * Charge the bids already on the account to this run's budget: money the
       * account is standing behind is money it may have to pay, whoever put it
       * there. A $2,000 run that finds $600 of open bids already on the account
       * has $1,400 to spend, and each of those bids that is outbid gives its
       * share back like any other.
       *
       * Those lots are still left alone — never raised, never re-bid. This is
       * about what the budget may spend, not what the run may touch.
       */
      countInherited?: boolean;
    },
  ) {}

  private url(listingId: string): string {
    return this.exchange?.listingUrl(listingId) ?? this.opts.listingUrl?.(listingId) ?? listingId;
  }

  committed(): number {
    return committedCents(this.placed) + (this.opts.countInherited ? committedCents(this.inherited) : 0);
  }
  free(): number { return this.opts.budgetCents - this.committed(); }

  /**
   * The lots the per-card cap holds back right now: copies of a card that
   * already has perCard lots winning, pending, planned or won this run.
   * Counted off the book itself, so an outbid copy frees its place for the
   * next copy in the pool the moment the poll sees it, and a won copy keeps
   * its place — it is one of the copies the cap is counting.
   */
  capped(pool: Biddable[]): Set<string> {
    const blocked = new Set<string>();
    const caps = this.opts.caps;
    if (!caps) return blocked;

    const byCard = new Map<string, number>();
    for (const p of this.placed) {
      if (!p.cardKey || p.status === "OUTBID" || (p.closed && p.status !== "HIGH_BID")) continue;
      byCard.set(p.cardKey, (byCard.get(p.cardKey) ?? 0) + 1);
    }
    for (const row of pool) {
      if (!row.cardKey || this.settled.has(row.listingId)) continue;
      if ((byCard.get(row.cardKey) ?? 0) >= caps.perCard) blocked.add(row.listingId);
    }
    return blocked;
  }

  /** Lots in the pool this has not decided about yet. */
  waiting(pool: Biddable[]): number { return pool.filter((r) => !this.settled.has(r.listingId)).length; }

  /** True once the free budget cannot reach anything left in the pool that the caps allow. */
  full(pool: Biddable[]): boolean {
    return nextAffordable(pool, new Set([...this.settled, ...this.capped(pool)]), this.free(), this.opts.steps) === null;
  }

  /** Nothing open on the account: every bid is closed, outbid, or was never sent. */
  finished(): boolean {
    return !this.placed.some((p) => !p.closed && p.status !== "OUTBID" && p.status !== "PLANNED");
  }

  /**
   * Every bid on the account, in one request, with a few tries: this one read
   * is how the budget learns what it is already holding, and a poll that has
   * to fall back to quoting lot by lot is the slow path this exists to avoid.
   */
  private async accountBids(): Promise<Map<string, AccountBid> | null> {
    if (!this.exchange) return null;
    for (let attempt = 1; attempt <= ACCOUNT_BIDS_ATTEMPTS; attempt++) {
      const bids = await this.exchange.accountBids().catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        if (attempt === ACCOUNT_BIDS_ATTEMPTS) console.warn(`    ⚠️  could not read the account's bids after ${attempt} tries (${why})`);
        return null;
      });
      if (bids) return bids;
      if (attempt < ACCOUNT_BIDS_ATTEMPTS) await sleep(attempt * 2_000);
    }
    return null;
  }

  /**
   * Bids already on the account, from an earlier run or a person: counted
   * before anything new is placed, so a restart never spends the budget twice.
   *
   * Only the ones still open, in an auction still running — see seedable().
   * Holding last month's winnings against tonight's budget would leave a run
   * with nothing to spend and no reason given.
   *
   * Best effort — the per-lot quote catches the same thing, lot by lot, if this
   * cannot be read.
   */
  async seed() {
    const bids = await this.accountBids();
    // Not fatal: this is a shortcut, not the guard. fill() quotes every lot
    // before bidding on it and finds the same thing lot by lot, and a bid on a
    // lot outside the chase list needs no working around anyway.
    if (!bids) { console.warn(`    each lot is checked before it is bid on instead`); return; }

    let seeded = 0;
    let history = 0;
    for (const bid of bids.values()) {
      if (this.settled.has(bid.listingId)) continue;
      if (!seedable(bid)) { if (bid.maxCents > 0) history++; continue; }
      seeded++;
      this.settled.add(bid.listingId);
      this.inherited.push({
        listingId: bid.listingId, title: bid.title, lot: bid.lot, cents: bid.maxCents, allInCents: allInCents(bid.maxCents),
        // Same reading as fill() and poll() give it: Fanatics leaves the
        // status blank on some lots this account is in fact winning.
        status: bid.status === "NO_STATUS" && bid.highestBidder ? "HIGH_BID" : bid.status,
        closed: bid.closed, at: new Date().toISOString(), currentBidCents: bid.currentBidCents,
      });
      this.opts.log("inherited", { listingId: bid.listingId, url: this.url(bid.listingId), cents: bid.maxCents, status: bid.status },
        `    =  ${bid.lot}: ${dollars(bid.maxCents)} already on this account (${bid.status}) — left alone\n       ${this.url(bid.listingId)}`);
    }
    if (seeded > 0) {
      const money = this.opts.countInherited
        ? `left alone, and ${dollars(committedCents(this.inherited))} of them charged to this run's budget`
        : `left alone, and not counted against this run's budget`;
      console.log(`    ${seeded} bid(s) were already on this account — ${money}`);
    }
    if (history > 0) console.log(`    ${history} bid(s) on lots that have closed are this account's history`);
  }

  private pass(row: Biddable, reason: string) {
    this.settled.add(row.listingId);
    this.skipped.push({ listingId: row.listingId, title: row.title, reason });
    this.opts.log("skip", { listingId: row.listingId, url: this.url(row.listingId), reason },
      `    –  ${row.lot}: ${reason}\n       ${this.url(row.listingId)}`);
  }

  /**
   * Bids down the pool, best lot first, while the free budget reaches
   * something. Returns once nothing left in the pool fits — which is either
   * the budget being committed or the pool running dry, and the caller tells
   * those apart with full() and waiting().
   */
  async fill(pool: Biddable[]): Promise<{ placed: number; auctionClosed: boolean }> {
    const stalled = new Set<string>();
    let placed = 0;

    for (;;) {
      // The caps are counted again every time round: a bid placed a moment ago
      // is one more live copy of its card.
      const row = nextAffordable(pool, new Set([...this.settled, ...stalled, ...this.capped(pool)]), this.free(), this.opts.steps);
      if (!row) return { placed, auctionClosed: false };
      stalled.add(row.listingId);

      let lot: Lot;
      if (!this.exchange) {
        lot = snapshotLot(row);
      } else {
        try {
          lot = await this.exchange.quote(row.listingId);
        } catch (err) {
          console.warn(`    ⚠️  ${row.lot}: could not read the lot (${err instanceof Error ? err.message : err}); next round`);
          continue;
        }
      }

      if (lot.auctionId) this.auctionId = lot.auctionId;
      if (lot.auctionStatus === "CLOSED") { this.pass(row, "the auction has closed"); return { placed, auctionClosed: true }; }
      if (lot.isClosed) { this.pass(row, "the lot has closed"); continue; }
      if (lot.isOwner) { this.pass(row, "this account is the seller"); continue; }
      if (lot.userMaxBidCents > 0) {
        // Bid on already — by an earlier run, or by hand. Left as it is: never
        // raised, and not this run's budget to hold.
        this.settled.add(row.listingId);
        this.inherited.push({
          listingId: row.listingId, title: row.title, lot: row.lot, cents: lot.userMaxBidCents, allInCents: allInCents(lot.userMaxBidCents),
          status: lot.userBidStatus === "NO_STATUS" && lot.highestBidder ? "HIGH_BID" : lot.userBidStatus, closed: lot.isClosed,
          at: new Date().toISOString(), currentBidCents: lot.currentBidCents,
        });
        this.opts.log("already-bid", { listingId: row.listingId, url: this.url(row.listingId), cents: lot.userMaxBidCents, status: lot.userBidStatus },
          `    =  ${row.lot}: already carries this account's max of ${dollars(lot.userMaxBidCents)} (${lot.userBidStatus}) — left alone\n       ${this.url(row.listingId)}`);
        continue;
      }
      if (!lot.userCanBuy) {
        this.pass(row, "the site says this account cannot bid on it (no payment method on file, or the profile is incomplete)");
        if (++this.cannotBuy >= CANNOT_BUY_LIMIT && this.taken === 0) {
          throw new Error(`${this.cannotBuy} lots in a row that this account is not allowed to bid on — check the payment method and profile on the site before running again.`);
        }
        continue;
      }

      const amount = bidAmount(row, lot, this.opts.steps);
      if ("skip" in amount) { this.pass(row, amount.skip); continue; }
      const cents = withinMax(amount.cents, row);
      const allIn = allInCents(cents);
      if (allIn > this.free()) continue;  // the ladder moved under us; next round

      if (!this.opts.live) {
        this.settled.add(row.listingId);
        placed++;
        this.placed.push({ listingId: row.listingId, title: row.title, lot: row.lot, cents, allInCents: allIn, status: "PLANNED", closed: false, at: new Date().toISOString(), currentBidCents: lot.currentBidCents, cardKey: row.cardKey });
        this.opts.log("would-bid", { listingId: row.listingId, url: this.url(row.listingId), cents, allIn, currentBid: lot.currentBidCents },
          `    ○  would bid ${dollars(cents)} (${dollars(allIn)} all-in) on ${row.lot} — current ${dollars(lot.currentBidCents)}, ${lot.bidCount} bid(s) — ${row.title}\n       ${this.url(row.listingId)}`);
        continue;
      }

      // Live. The request is the one irreversible thing in this file.
      const pending: PlacedBid = { listingId: row.listingId, title: row.title, lot: row.lot, cents, allInCents: allIn, status: "PENDING", closed: false, at: new Date().toISOString(), currentBidCents: lot.currentBidCents, cardKey: row.cardKey };
      let result: BidResult;
      try {
        result = await this.exchange!.sendBid(row, cents);
      } catch (err) {
        // The request itself failed. The site may or may not have taken the
        // bid, so it is held on the books as pending; the next poll reads the
        // truth off the account.
        this.settled.add(row.listingId);
        this.placed.push(pending);
        this.opts.log("bid-unknown", { listingId: row.listingId, url: this.url(row.listingId), cents, error: err instanceof Error ? err.message : String(err) },
          `    ⚠️  ${row.lot}: the bid request failed (${err instanceof Error ? err.message : err}); holding ${dollars(allIn)} until the account says\n       ${this.url(row.listingId)}`);
        continue;
      }

      if (!result.ok) {
        const n = (this.attempts.get(row.listingId) ?? 0) + 1;
        this.attempts.set(row.listingId, n);
        const blame = result.blame ?? blameOf(result.error);
        this.opts.log("refused", { listingId: row.listingId, url: this.url(row.listingId), cents, attempt: n, error: result.error, blame });
        if (n >= BID_ATTEMPTS) this.pass(row, `the site refused the bid ${n} times, last: ${result.error}`);
        else console.log(`    ✖  ${row.lot}: the site refused ${dollars(cents)} (${result.error}); will quote again next round`);
        // A lot refused for its own reason — outbid in the moment it took to
        // send — is one lot, and it clears the count: the house priced that
        // bid, so the account was allowed to make it. Bids refused one after
        // another for the account's own reasons are the account: no payment
        // method, a hold it will not cover, a limit reached. There is nothing
        // down the list for that, so stop rather than turn a bad account into
        // hundreds of turned-down requests.
        if (blame === "lot") {
          this.refusals = 0;
        } else if (++this.refusals >= REFUSAL_LIMIT && this.taken === 0) {
          throw new Error(
            `${this.refusals} bids in a row were refused for reasons that read as the account, the last with: ${result.error}. ` +
            `Check the payment method, holds and bidding limits on the site.`);
        }
        continue;
      }

      this.refusals = 0;
      this.taken++;
      this.settled.add(row.listingId);
      placed++;
      this.placed.push(pending);
      this.opts.log("bid", { listingId: row.listingId, url: this.url(row.listingId), cents, allIn, bidId: result.bidId, currentBid: lot.currentBidCents },
        `    ●  bid ${dollars(cents)} (${dollars(allIn)} all-in) on ${row.lot} — current was ${dollars(lot.currentBidCents)} — ${row.title}\n       ${this.url(row.listingId)}`);

      // Read it straight back: the max on the account must be the max sent.
      try {
        const after = await this.exchange!.quote(row.listingId);
        // A site takes a few seconds to own up to a bid it has already
        // accepted: for that moment the lot reads back with no max on it at
        // all. That is not news about the bid, so it is not written down as
        // news — the bid stays PENDING, stays in the budget, and the next poll
        // says what really became of it.
        if (after.userMaxBidCents <= 0) {
          console.log(`       not settled at the site yet — held as pending, the next poll will say`);
        } else {
          pending.status = after.userBidStatus === "NO_STATUS" && after.highestBidder ? "HIGH_BID" : after.userBidStatus;
          pending.closed = after.isClosed;
          if (after.userMaxBidCents !== cents) {
            console.warn(`    ⚠️  ${row.lot}: the site reports this account's max as ${dollars(after.userMaxBidCents)}, not the ${dollars(cents)} sent`);
          } else {
            console.log(`       confirmed: max ${dollars(after.userMaxBidCents)}, standing ${pending.status}, current ${dollars(after.currentBidCents)}`);
          }
        }
      } catch (err) {
        console.warn(`    ⚠️  ${row.lot}: could not read the bid back (${err instanceof Error ? err.message : err}); next poll will`);
      }
    }
  }

  /**
   * Reads every open bid back and notes what changed.
   *
   * Two requests, whatever the number of bids: one for the auction's own clock,
   * one for every bid on the account. Only a bid the account-wide read leaves
   * out is asked about on its own, which in practice means one that has just
   * closed. `changes` counts the standings that moved, which is what a run
   * holding sixty bids for six hours uses to decide whether it has anything to
   * say.
   */
  async poll(): Promise<{ auctionClosed: boolean; freed: number; changes: number; auction: AuctionState | null }> {
    if (!this.exchange) return { auctionClosed: false, freed: 0, changes: 0, auction: null };
    const exchange = this.exchange;
    let freed = 0;
    let changes = 0;

    const auction = await exchange.readAuction(this.auctionId).catch((err: unknown) => {
      console.warn(`    ⚠️  could not read the auction clock (${err instanceof Error ? err.message : err})`);
      return null;
    });
    if (auction) this.auctionId = auction.id;
    let auctionClosed = auction?.status === "CLOSED";

    const account = await this.accountBids();

    // Whatever the account-wide read did not cover has to be asked about lot by
    // lot, and a big budget holds enough bids that doing all of them would turn
    // one poll into hundreds of requests — slower than the poll interval, right
    // when the interval matters most. So a poll spends a fixed number of those
    // and starts where the last one stopped, which walks the whole list over a
    // few polls instead of stalling on one.
    const open = this.placed.filter((b) => !b.closed && b.status !== "OUTBID" && b.status !== "PLANNED");
    const missing = account ? open.filter((b) => !account.has(b.listingId)) : open;
    const quotable = new Set<string>();
    if (missing.length > 0) {
      const from = this.fallbackCursor % missing.length;
      for (let i = 0; i < Math.min(FALLBACK_QUOTES_PER_POLL, missing.length); i++) {
        quotable.add(missing[(from + i) % missing.length].listingId);
      }
      this.fallbackCursor = from + quotable.size;
      if (missing.length > quotable.size) {
        console.warn(`    ⚠️  ${missing.length} bid(s) the account read left out; quoting ${quotable.size} of them this poll`);
      }
    }

    // Over a copy: a bid that never landed is taken off the books mid-walk.
    for (const bid of [...this.placed]) {
      if (bid.closed || bid.status === "OUTBID" || bid.status === "PLANNED") continue;

      let now = account?.get(bid.listingId) ?? null;
      if (!now) {
        // Not in the account-wide list — usually a lot that has just closed.
        // One left over the quota keeps its standing and is asked about next poll.
        if (!quotable.has(bid.listingId)) continue;
        try {
          const lot = await exchange.quote(bid.listingId);
          if (lot.auctionStatus === "CLOSED") auctionClosed = true;
          now = {
            listingId: lot.id, title: lot.title, lot: lot.lot, maxCents: lot.userMaxBidCents,
            status: lot.userBidStatus, closed: lot.isClosed, currentBidCents: lot.currentBidCents,
            highestBidder: lot.highestBidder, auctionId: lot.auctionId, auctionStatus: lot.auctionStatus,
          };
        } catch (err) {
          console.warn(`    ⚠️  ${bid.lot}: could not read the lot (${err instanceof Error ? err.message : err})`);
          continue;
        }
      }

      // A lot that reads back with no max on it, moments after a bid was put
      // on it, is the site still catching up rather than a bid that missed.
      // Left exactly as it was until it has had time to settle.
      if (now.maxCents <= 0 && Date.now() - Date.parse(bid.at) < BID_SETTLE_MS) continue;

      // A bid whose request never answered: the account says whether it landed.
      if (bid.status === "PENDING" && now.maxCents <= 0 && now.status === "NO_BIDS") {
        this.placed.splice(this.placed.indexOf(bid), 1);
        this.skipped.push({ listingId: bid.listingId, title: bid.title, reason: "the bid never landed, and a bid whose outcome was unknown is not sent twice" });
        freed += bid.allInCents;
        changes++;
        this.opts.log("never-landed", { listingId: bid.listingId, url: this.url(bid.listingId), cents: bid.cents },
          `    ✖  ${bid.lot}: the bid never landed — not retried\n       ${this.url(bid.listingId)}`);
        continue;
      }
      if (now.maxCents > 0 && now.maxCents !== bid.cents) {
        console.warn(`    ⚠️  ${bid.lot}: the site has this account's max at ${dollars(now.maxCents)}, this run sent ${dollars(bid.cents)}`);
        bid.cents = now.maxCents;
        bid.allInCents = allInCents(now.maxCents);
      }

      const before = bid.status;
      const wasClosed = bid.closed;
      bid.status = now.status === "NO_STATUS" && now.highestBidder ? "HIGH_BID" : now.status;
      bid.closed = now.closed;
      bid.currentBidCents = now.currentBidCents;
      if (before !== bid.status || wasClosed !== bid.closed) changes++;
      const current = dollars(now.currentBidCents);
      if (bid.closed && bid.status === "HIGH_BID") {
        this.opts.log("won", { listingId: bid.listingId, url: this.url(bid.listingId), cents: now.currentBidCents },
          `    🏆 won ${bid.lot} at ${current} hammer — ${bid.title}\n       ${this.url(bid.listingId)}`);
      } else if (bid.status === "OUTBID") {
        freed += bid.allInCents;
        this.opts.log("outbid", { listingId: bid.listingId, url: this.url(bid.listingId), currentBid: now.currentBidCents, freed: bid.allInCents },
          `    ↩  outbid on ${bid.lot} (now ${current}, our max ${dollars(bid.cents)}) — ${dollars(bid.allInCents)} back in the budget\n       ${this.url(bid.listingId)}`);
      } else if (bid.closed) {
        this.opts.log("closed", { listingId: bid.listingId, url: this.url(bid.listingId), status: bid.status },
          `    –  ${bid.lot} closed at ${current}, not ours\n       ${this.url(bid.listingId)}`);
      } else if (before !== bid.status) {
        this.opts.log("status", { listingId: bid.listingId, url: this.url(bid.listingId), from: before, to: bid.status });
      }
    }

    // The bids the account was already carrying move too — the account is
    // bidding, or a person is. Their standings come off the same account-wide
    // answer and are never quoted lot by lot: this run will not bid on those
    // lots whatever they say, and the poll's quote budget belongs to the bids
    // it placed itself. Read anyway, because the run reports what became of
    // them; and when they are charged to the budget, one of them outbid hands
    // its share back exactly like one of this run's own.
    for (const bid of this.inherited) {
      const now = account?.get(bid.listingId);
      if (!now || now.maxCents <= 0) continue;
      const held = bid.allInCents;
      const wasAtRisk = atRisk(bid);
      bid.cents = now.maxCents;
      bid.allInCents = allInCents(now.maxCents);
      bid.status = now.status === "NO_STATUS" && now.highestBidder ? "HIGH_BID" : now.status;
      bid.closed = now.closed;
      bid.currentBidCents = now.currentBidCents;
      if (this.opts.countInherited && wasAtRisk && !atRisk(bid)) {
        freed += held;
        changes++;
        this.opts.log("inherited-freed", { listingId: bid.listingId, url: this.url(bid.listingId), status: bid.status, freed: held },
          `    ↩  the bid already on this account for ${bid.lot} is ${bid.status === "OUTBID" ? "outbid" : "over"} — ${dollars(held)} back in this run's budget\n       ${this.url(bid.listingId)}`);
      }
    }
    return { auctionClosed, freed, changes, auction };
  }

  /** How the run ended: what was won, what got away, and what it cost. */
  result(): { won: PlacedBid[]; winning: PlacedBid[]; outbid: PlacedBid[]; lost: PlacedBid[]; hammerCents: number; allInCents: number } {
    const won = this.placed.filter((p) => p.closed && p.status === "HIGH_BID");
    return {
      won,
      winning: this.placed.filter((p) => !p.closed && p.status === "HIGH_BID"),
      outbid: this.placed.filter((p) => p.status === "OUTBID"),
      lost: this.placed.filter((p) => p.closed && p.status !== "HIGH_BID"),
      hammerCents: won.reduce((sum, p) => sum + p.cents, 0),
      allInCents: won.reduce((sum, p) => sum + p.allInCents, 0),
    };
  }

  /** One line: what the budget is holding and how the bids stand. */
  standing(): string {
    const winning = this.placed.filter((p) => p.status === "HIGH_BID" && !p.closed).length;
    const won = this.placed.filter((p) => p.status === "HIGH_BID" && p.closed).length;
    const outbid = this.placed.filter((p) => p.status === "OUTBID").length;
    const pending = this.placed.filter((p) => p.status === "PENDING").length;
    const planned = this.placed.filter((p) => p.status === "PLANNED").length;
    const held = `committed ${dollars(this.committed())} of ${dollars(this.opts.budgetCents)}, ${dollars(this.free())} free`;
    const also = this.inherited.length === 0 ? ""
      : this.opts.countInherited
        ? ` (including ${dollars(committedCents(this.inherited))} of bids already on the account, left alone but charged to the budget)`
        : ` (plus ${this.inherited.length} bid(s) already on the account, left alone)`;
    if (!this.opts.live) return `${held} — ${planned} lot(s) would be bid on${also}`;
    return `${held} — ${winning} winning, ${won} won, ${outbid} outbid${pending ? `, ${pending} pending` : ""}${also}`;
  }
}
