/**
 * Alt — the exchange the sniper's book bids through.
 *
 * Everything here is about talking to alt.xyz as a bidder: holding a signed-in
 * session, asking where a lot stands, reading the account's bids and the
 * auction's clock, and placing a max bid. The budget, the ladder maths and the
 * rules with money behind them live in scripts/sniper-book.ts; the pipeline
 * that finds the lots is scripts/sniper-core.ts, driven by
 * scripts/alt-sniper.ts.
 *
 * How the site is built, as read off its own bundle on 2026-09-07:
 *   - The API is GraphQL at alt-platform-server.production.internal.onlyalt.com,
 *     one POST per operation at /graphql/<OperationName>. Prices are decimal
 *     dollars, not cents.
 *   - Sign-in is Stytch (email code, Google or Apple). The browser keeps two
 *     cookies on alt.xyz: stytch_session, a session token good for a year, and
 *     stytch_session_jwt, a short-lived JWT the Stytch SDK mints from it in the
 *     background. Every GraphQL request carries `authorization: Bearer <jwt>`.
 *     So the session lives in a browser profile here as well: the page's own
 *     SDK keeps the JWT fresh, and the requests read it off the cookie jar.
 *   - A lot's standing comes from MyAuction (current bid, bid count, this
 *     account's max, WINNING / OUTBID / WATCHING, and the presets whose first
 *     entry is the least the site will take next); whether it is still open
 *     from the public listing's state.
 *   - The account's open bids come from AuctionBids, the auction's clock from
 *     AuctionCycles and LiveAuctionCycle, and a bid goes through PlaceMaxBids.
 *
 * Signing in. A session is looked for in three places, in this order:
 *   1. the saved browser profile, .alt-session/
 *   2. ALT_SESSION_TOKEN — the stytch_session cookie, which --export-session prints
 *   3. a person at the keyboard, with --login
 * There is no password path: Alt's sign-in is a code sent to the email, or an
 * OAuth button, and neither can be filled in from a script.
 *   npm run sniper:alt -- --login            sign in by hand, once. The session
 *                                            lands in .alt-session/ and is
 *                                            renewed from there afterwards.
 *   npm run sniper:alt -- --export-session   prints the session token, for the
 *                                            ALT_SESSION_TOKEN secret the
 *                                            workflow runs on.
 *
 * The bid itself was verified on 2026-09-07 by placing one by hand with the
 * network panel open: a $10 max on a lot with no bids, accepted, and read back
 * as WINNING with userMaxBid 10. sendBid() sends what the page sent, field for
 * field. What has still never run signed in is the rest of the account side —
 * the session in CI, the account-wide bid read, whether a lot reads as
 * eligible to bid on — so a --quote-only run is the thing to do before a
 * --live one.
 */

import { join } from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  blameOf,
  dollars,
  incrementSteps,
  withinMax,
  type AccountBid,
  type AuctionState,
  type Biddable,
  type BidResult,
  type Ladder,
  type Lot,
} from "./sniper-book";
import type { Session } from "./sniper-core";

// ── Configuration ─────────────────────────────────────────────────────────────

export const ALT = "https://alt.xyz";
/** The site's own API. The documents below are the ones its pages send. */
export const GRAPHQL = "https://alt-platform-server.production.internal.onlyalt.com/graphql";
/** Logged-in browser profile; holds the Stytch session. Gitignored. */
export const SESSION_DIR = ".alt-session";
/** Stytch's two cookies on alt.xyz: the year-long session, and the JWT minted from it. */
const SESSION_COOKIE = "stytch_session";
const JWT_COOKIE = "stytch_session_jwt";

/**
 * Whether sendBid()'s request has been seen to match what alt.xyz itself
 * sends. It has, on 2026-09-07 — see the note at the top of the file. Set it
 * back to false if the site's bid dialog ever changes shape, and --live is
 * refused at sign-in again while a plan and --quote-only carry on working.
 */
export const BID_INPUT_VERIFIED = true;

const REQUEST_TIMEOUT_MS = 30_000;
/** Have the JWT re-minted when it has less than this long to live. */
const JWT_MARGIN_S = 90;
/** How long the page's SDK gets to mint a JWT after a load. */
const JWT_WAIT_MS = 30_000;
const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long one read of the auction's clock is trusted between quotes. */
const CLOCK_CACHE_MS = 20_000;
/**
 * Past its scheduled close, an auction in extended bidding keeps pushing its
 * expiresAt out a window at a time; one that has stopped moving for this long
 * is over, whatever its state field says.
 */
const CLOSED_AFTER_S = 30 * 60;

/**
 * Alt's bid increments, in cents, mostly from its help centre ("Buying in Alt
 * Auctions"): $25 to $1,000, $50 to $2,500, $100 to $5,000, $250 to $10,000,
 * $500 to $20,000, $1,000 to $30,000, $2,500 to $50,000, $5,000 to $100,000,
 * $10,000 to $200,000, $20,000 to $300,000, $25,000 to $600,000, $50,000 to
 * $1,500,000, $100,000 on.
 *
 * Unlike Fanatics, these are not rungs: the next bid is the standing bid plus
 * the step of its band — a $245,000 lot wants $265,000 next, not a multiple of
 * anything — and any whole dollar at or above that is taken as a max.
 *
 * The bottom band is not the help centre's. It says $10 up to $500, and the
 * site does not agree: a lot standing at $10 quoted $11 as its next bid, so
 * the step down there is $1. The two figures the table was checked against at
 * the other end — $245,000 → $265,000, $1,640,000 → $1,740,000 — do match it.
 * Where the $1 band really ends is unknown, and $500 is a guess.
 *
 * None of which matters much to a bidding run: the site quotes the next
 * acceptable bid itself, as MyAuction's first preset, and that figure wins
 * whenever a quote carries it. This table is the fallback for a plan, which
 * has no session to ask.
 */
export const BID_INCREMENTS: Ladder = [
  { step: 100, upTo: 50_000 },
  { step: 2_500, upTo: 100_000 },
  { step: 5_000, upTo: 250_000 },
  { step: 10_000, upTo: 500_000 },
  { step: 25_000, upTo: 1_000_000 },
  { step: 50_000, upTo: 2_000_000 },
  { step: 100_000, upTo: 3_000_000 },
  { step: 250_000, upTo: 5_000_000 },
  { step: 500_000, upTo: 10_000_000 },
  { step: 1_000_000, upTo: 20_000_000 },
  { step: 2_000_000, upTo: 30_000_000 },
  { step: 2_500_000, upTo: 60_000_000 },
  { step: 5_000_000, upTo: 150_000_000 },
  { step: 10_000_000, upTo: 100_000_000_000 },
];

/** Alt takes any whole dollar at or above the standing bid plus its increment. */
export const ALT_STEPS = incrementSteps(BID_INCREMENTS);

/** The lot's page, so a log line can be clicked through to what was bid on. */
export function listingUrl(listingId: string): string {
  return `${ALT}/itm/${listingId}`;
}

/** Alt has no lot numbers; the first bytes of the listing id stand in on a log line. */
export function lotLabel(listingId: string): string {
  return `Alt ${listingId.slice(0, 8)}`;
}

/** Decimal dollars as the API writes them ("1640000.000000"), to cents. */
export function centsOf(price: string | number | null | undefined): number {
  const n = typeof price === "string" ? Number(price) : price ?? 0;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const unixS = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1_000) || 0 : 0);

// ── The documents ─────────────────────────────────────────────────────────────

const ME_QUERY = `
  query Me {
    me {
      id
      email
      accountId
      accountName
    }
  }
`;

/**
 * Whether this account is barred from bidding.
 *
 * Asked once at sign-in rather than per lot: a restriction is on the account,
 * not the listing, and a run that cannot bid should say so before it spends
 * credits pricing an auction.
 *
 * Only this one field. The account also carries exchangeSpendingPower, which
 * looks like a ceiling on what may be committed and is not one: it read $0 on
 * an account that had just placed a $10 bid by hand and was winning with it.
 * Whatever it governs, it is not this, so it is not read and not reported.
 */
const BIDDING_RESTRICTION_QUERY = `
  query AccountBiddingRestriction {
    account {
      biddingRestricted
    }
  }
`;

const MY_AUCTION_QUERY = `
  query MyAuction($input: MyAuctionInput) {
    myAuction(input: $input) {
      listingId
      status
      totalBids
      currentBid
      userMaxBid
      auctionCycleId
      presets
    }
  }
`;

const LISTING_QUERY = `
  query PublicListingWithTransaction($listingId: ID!) {
    publicListing(id: $listingId) {
      publicListing {
        id
        state
        type
        expiresAt
        isEligibleForBidding
        items {
          displayNames { itemName }
          attributes { certNumber gradeNumber gradingCompany }
        }
      }
    }
  }
`;

const CYCLES_QUERY = `
  query AuctionCycles {
    auctionCycles {
      id
      name
      state
      expiresAt
      extendedBiddingWindowSeconds
      enteredHalfBidding
    }
  }
`;

const LIVE_CYCLE_QUERY = `
  query LiveAuctionCycle {
    liveAuctionCycle {
      auctionCycle {
        id
        expiresAt
        enteredExtendedBidding
        originalExpiresAt
      }
      extendedBiddingWindowSeconds
    }
  }
`;

const ACCOUNT_BIDS_QUERY = `
  query AuctionBids($filter: ListingFilter!) {
    account {
      maxBids(filter: $filter) {
        price
        listingId
        isLeadingBidder
        auction {
          currentEffectiveBidPrice
          enteredExtendedBidding
          expiresAt
          state
          items {
            asset { year brand subject }
          }
        }
      }
    }
  }
`;

/**
 * The bid itself, as Alt's own bid drawer sends it. The three fields on a
 * failed bid are the site's way of saying the account needs something — a
 * payment method, a retainer tier, a hold — rather than the lot being
 * unbiddable, so they are read back into the error.
 */
const PLACE_MAX_BIDS_MUTATION = `
  mutation PlaceMaxBids($input: PlaceMaxBidsInput!) {
    placeMaxBids(input: $input) {
      successfulBids {
        listingId
        itemName
        maxBid { price accountId listingId }
      }
      failedBids {
        listingId
        itemName
        paymentMethodFlow
        requiredRetainerTier
        requiredHoldAmount
        error { ... on BaseApiError { message } }
      }
      error { ... on BaseApiError { message } }
    }
  }
`;

/**
 * What goes in the mutation's `input`: one bid, the lot, and the max in whole
 * dollars as a string — "10", the way the page writes it, not cents and not a
 * number. Alt takes any whole dollar at or above the next acceptable bid, and
 * ALT_STEPS has already floored the max to one, so the string never has a
 * fractional part to round.
 */
export function placeMaxBidsInput(listingId: string, cents: number): { bids: { listingId: string; maxBidPrice: string }[] } {
  return { bids: [{ listingId, maxBidPrice: String(Math.floor(cents / 100)) }] };
}

type GqlResponse<T> = { data?: T; errors?: { message: string }[] };

type MyAuction = {
  listingId: string;
  status: string | null;
  totalBids: number | null;
  currentBid: string | null;
  userMaxBid: string | null;
  auctionCycleId: number | null;
  presets: number[] | null;
};

type PublicListing = {
  id: string;
  state: string | null;
  type: string | null;
  expiresAt: string | null;
  isEligibleForBidding: boolean | null;
  items: { displayNames: { itemName: string | null } | null; attributes: { certNumber: string | null; gradeNumber: string | null; gradingCompany: string | null } | null }[] | null;
};

type Cycle = {
  id: number;
  name: string | null;
  state: string | null;
  expiresAt: string | null;
  extendedBiddingWindowSeconds: number | null;
};

/** Where a cycle is, on Alt's own clock, as the book wants it said. */
export function cycleStatus(cycle: { state: string | null; expiresAt: string | null }, extended: boolean, nowS: number): "LIVE" | "EXTENDED_BIDDING" | "CLOSED" {
  if (cycle.state === "ENDED" || cycle.state === "CANCELED") return "CLOSED";
  const ends = unixS(cycle.expiresAt);
  if (extended) return ends > 0 && nowS > ends + CLOSED_AFTER_S ? "CLOSED" : "EXTENDED_BIDDING";
  if (ends > 0 && nowS >= ends) return nowS > ends + CLOSED_AFTER_S ? "CLOSED" : "EXTENDED_BIDDING";
  return "LIVE";
}

// ── GraphQL, with or without a session ───────────────────────────────────────

const PUBLIC_HEADERS = {
  "content-type": "application/json",
  origin: ALT,
  referer: `${ALT}/auctions`,
};

/** One operation, no account: what the scan uses, through plain fetch. */
export async function gqlPublic<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${GRAPHQL}/${operationName}`, {
    method: "POST", headers: PUBLIC_HEADERS, body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) throw new Error(`${operationName}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) throw new Error(`${operationName}: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error(`${operationName}: empty response`);
  return json.data;
}

// ── Alt session ───────────────────────────────────────────────────────────────

function jwtExpiresAt(token: string): number {
  try {
    const body = token.split(".")[1];
    const exp = body ? (JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as { exp?: unknown }).exp : undefined;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
}

/**
 * A signed-in Alt tab, and everything the book asks of it.
 *
 * The page stays on alt.xyz for the life of the run: Stytch's SDK in it keeps
 * the JWT cookie fresh, and every request here reads that cookie first.
 */
export class AltSession implements Session {
  readonly steps = ALT_STEPS;
  private clock: { at: number; cycles: Cycle[]; live: { id: number; extended: boolean; windowSeconds: number } | null } | null = null;

  constructor(readonly context: BrowserContext, readonly page: Page) {}

  listingUrl(listingId: string): string { return listingUrl(listingId); }

  close(): Promise<void> { return this.context.close(); }

  async snapshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async cookie(name: string): Promise<{ value: string; expires: number } | null> {
    const found = (await this.context.cookies(ALT)).find((c) => c.name === name);
    return found ? { value: found.value, expires: found.expires } : null;
  }

  async exportable() {
    const session = await this.cookie(SESSION_COOKIE);
    if (!session) throw new Error("No Alt session cookie to export — sign in first with --login.");
    return { name: "ALT_SESSION_TOKEN", value: session.value, expiresAtUnixS: session.expires > 0 ? Math.floor(session.expires) : null };
  }

  /**
   * The JWT the requests carry, re-minted by the page when it is near lapsing.
   * A reload is what prompts the SDK; the cookie changes when it is done.
   */
  async jwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const current = await this.cookie(JWT_COOKIE);
    if (current && jwtExpiresAt(current.value) - now > JWT_MARGIN_S) return current.value;

    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    const started = Date.now();
    while (Date.now() - started < JWT_WAIT_MS) {
      const next = await this.cookie(JWT_COOKIE);
      if (next && next.value !== current?.value && jwtExpiresAt(next.value) - now > JWT_MARGIN_S) return next.value;
      await this.page.waitForTimeout(500);
    }
    throw new Error("Alt never minted a fresh session token — the saved session has probably lapsed; sign in again with --login.");
  }

  async gql<T>(operationName: string, query: string, variables: Record<string, unknown> = {}, opts: { auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { ...PUBLIC_HEADERS };
    if (opts.auth ?? true) headers.authorization = `Bearer ${await this.jwt()}`;
    const res = await this.page.request.post(`${GRAPHQL}/${operationName}`, {
      headers, data: { operationName, query, variables }, timeout: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok()) throw new Error(`${operationName}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors?.length) throw new Error(`${operationName}: ${json.errors.map((e) => e.message).join("; ")}`);
    if (!json.data) throw new Error(`${operationName}: empty response`);
    return json.data;
  }

  /** Who Alt says the session belongs to. */
  async whoAmI(): Promise<{ email: string; accountId: string }> {
    const me = (await this.gql<{ me: { id: string; email: string | null; accountId: string | null } | null }>("Me", ME_QUERY)).me;
    if (!me?.id) throw new Error("Alt does not recognise the session — sign in again with --login.");
    return { email: (me.email ?? "").toLowerCase(), accountId: me.accountId ?? "" };
  }

  /**
   * Whether Alt has barred this account from bidding. Best effort: a run is
   * not stopped because this could not be read, only because it came back
   * saying yes.
   */
  async biddingRestricted(): Promise<boolean> {
    try {
      const account = (await this.gql<{ account: { biddingRestricted: boolean | null } | null }>(
        "AccountBiddingRestriction", BIDDING_RESTRICTION_QUERY)).account;
      return account?.biddingRestricted === true;
    } catch (err) {
      console.warn(`    ⚠️  could not read whether this account may bid (${err instanceof Error ? err.message : err})`);
      return false;
    }
  }

  /** The auction cycles and the live one's extended-bidding state, read at most every CLOCK_CACHE_MS. */
  private async readClock() {
    if (this.clock && Date.now() - this.clock.at < CLOCK_CACHE_MS) return this.clock;
    const [cycles, live] = await Promise.all([
      this.gql<{ auctionCycles: Cycle[] | null }>("AuctionCycles", CYCLES_QUERY, {}, { auth: false }),
      this.gql<{ liveAuctionCycle: { auctionCycle: { id: number; enteredExtendedBidding: boolean | null } | null; extendedBiddingWindowSeconds: number | null } | null }>(
        "LiveAuctionCycle", LIVE_CYCLE_QUERY, {}, { auth: false }).catch(() => null),
    ]);
    const l = live?.liveAuctionCycle;
    this.clock = {
      at: Date.now(),
      cycles: cycles.auctionCycles ?? [],
      live: l?.auctionCycle ? { id: l.auctionCycle.id, extended: l.auctionCycle.enteredExtendedBidding ?? false, windowSeconds: l.extendedBiddingWindowSeconds ?? 0 } : null,
    };
    return this.clock;
  }

  /**
   * Where one lot stands right now: MyAuction for the bidding and this
   * account's part in it, the public listing for whether it is still open.
   */
  async quote(listingId: string): Promise<Lot> {
    const [mine, pub, clock] = await Promise.all([
      this.gql<{ myAuction: MyAuction[] | null }>("MyAuction", MY_AUCTION_QUERY, { input: { listingIds: [listingId] } }),
      this.gql<{ publicListing: { publicListing: PublicListing | null } | null }>("PublicListingWithTransaction", LISTING_QUERY, { listingId }, { auth: false }),
      this.readClock(),
    ]);
    const m = mine.myAuction?.[0];
    const p = pub.publicListing?.publicListing;
    if (!m || !p) throw new Error(`listing ${listingId}: Alt has no such lot`);

    const currentBidCents = centsOf(m.currentBid);
    const bidCount = m.totalBids ?? 0;
    const userMaxBidCents = centsOf(m.userMaxBid);
    const status = m.status ?? "";
    const cycle = clock.cycles.find((c) => c.id === m.auctionCycleId);
    const nowS = Math.floor(Date.now() / 1000);
    const extended = clock.live?.id === m.auctionCycleId ? clock.live.extended : false;
    const isClosed = (p.state ?? "ACTIVE") !== "ACTIVE";

    return {
      id: listingId,
      title: p.items?.[0]?.displayNames?.itemName ?? "",
      lot: lotLabel(listingId),
      currentBidCents,
      // With no bids yet the current bid is the opening price, and the site
      // says outright what it wants next.
      startingPriceCents: bidCount > 0 ? 0 : currentBidCents,
      bidCount,
      minimumNextBidCents: m.presets?.[0] ? centsOf(m.presets[0]) : undefined,
      highestBidder: status === "WINNING",
      isOwner: false,
      userMaxBidCents,
      // Not isEligibleForBidding. That field reads false on every lot Alt
      // serves — the cheapest twelve in the closing cycle, the six-figure
      // ones, and the lot this account bid $10 on and is winning — so it is
      // not the site saying whether this account may bid. Whether the account
      // may bid at all is asked once, at sign-in; whether a particular bid is
      // taken is Alt's answer to the bid, which says what is missing.
      userCanBuy: true,
      userBidStatus: status === "WINNING" ? "HIGH_BID" : status === "OUTBID" ? "OUTBID" : userMaxBidCents > 0 ? "NO_STATUS" : "NO_BIDS",
      isClosed,
      auctionId: m.auctionCycleId ? String(m.auctionCycleId) : "",
      auctionStatus: cycle ? cycleStatus(cycle, extended, nowS) : isClosed ? "CLOSED" : "LIVE",
    };
  }

  /** The auction a run is bidding in, by id, or the one closing soonest. */
  async readAuction(auctionId: string): Promise<AuctionState | null> {
    this.clock = null;
    const clock = await this.readClock();
    const nowS = Math.floor(Date.now() / 1000);
    const open = clock.cycles
      .filter((c) => unixS(c.expiresAt) > nowS - CLOSED_AFTER_S)
      .sort((a, b) => unixS(a.expiresAt) - unixS(b.expiresAt));
    const mine = clock.cycles.find((c) => String(c.id) === auctionId) ?? open[0];
    if (!mine) return null;
    const extended = clock.live?.id === mine.id ? clock.live.extended : false;
    const window = clock.live?.id === mine.id ? clock.live.windowSeconds : (mine.extendedBiddingWindowSeconds ?? 0);
    return {
      id: String(mine.id),
      name: mine.name ?? `cycle ${mine.id}`,
      status: cycleStatus(mine, extended, nowS),
      endsAtUnixS: unixS(mine.expiresAt),
      windowEndsAtUnixS: extended && window > 0 ? unixS(mine.expiresAt) : 0,
      windowOrdinal: null,
    };
  }

  /** Every open bid on the account, in one request. */
  async accountBids(): Promise<Map<string, AccountBid> | null> {
    type Data = {
      account: {
        maxBids: {
          price: string | number | null; listingId: string; isLeadingBidder: boolean | null;
          auction: {
            currentEffectiveBidPrice: string | number | null; enteredExtendedBidding: boolean | null; expiresAt: string | null; state: string | null;
            items: { asset: { year: number | string | null; brand: string | null; subject: string | null } | null }[] | null;
          } | null;
        }[] | null;
      } | null;
    };
    const data = await this.gql<Data>("AuctionBids", ACCOUNT_BIDS_QUERY, { filter: { states: ["ACTIVE"] } });
    if (!data.account) throw new Error("AuctionBids: Alt answered with no account — the session is not signed in");

    const bids = new Map<string, AccountBid>();
    for (const b of data.account.maxBids ?? []) {
      const a = b.auction;
      const asset = a?.items?.[0]?.asset;
      const closed = a?.state !== undefined && a?.state !== null && a.state !== "ACTIVE";
      bids.set(b.listingId, {
        listingId: b.listingId,
        title: [asset?.year, asset?.brand, asset?.subject].filter(Boolean).join(" "),
        lot: lotLabel(b.listingId),
        maxCents: centsOf(b.price),
        status: b.isLeadingBidder ? "HIGH_BID" : "OUTBID",
        closed,
        currentBidCents: centsOf(a?.currentEffectiveBidPrice),
        highestBidder: b.isLeadingBidder ?? false,
        auctionId: "",
        auctionStatus: closed ? "CLOSED" : a?.enteredExtendedBidding ? "EXTENDED_BIDDING" : "LIVE",
      });
    }
    return bids;
  }

  /**
   * Sends one max bid. withinMax() runs here, last thing before the request —
   * and before everything, the sourcing check's verdict: a row carrying one
   * (the bids CSV's unawardable column, on a Biddable built from such a row)
   * is refused rather than sent. A row without the field, as from an older
   * CSV, is not unawardable.
   */
  async sendBid(row: Biddable & { unawardable?: string }, cents: number): Promise<BidResult> {
    if (row.unawardable) return { ok: false, error: `unawardable: ${row.unawardable}`, blame: "lot" };
    if (!BID_INPUT_VERIFIED) {
      throw new Error("Alt bidding is switched off in code: PlaceMaxBids' input has not been verified against the site. See scripts/alt-bidder.ts.");
    }
    const maxBid = withinMax(cents, row);
    const data = await this.gql<{
      placeMaxBids: {
        successfulBids: { listingId: string; maxBid: { price: string | number | null } | null }[] | null;
        failedBids: {
          listingId: string; paymentMethodFlow: string | null; requiredRetainerTier: string | null;
          requiredHoldAmount: string | number | null; error: { message: string | null } | null;
        }[] | null;
        error: { message: string | null } | null;
      } | null;
    }>("PlaceMaxBids", PLACE_MAX_BIDS_MUTATION, { input: placeMaxBidsInput(row.listingId, maxBid) });

    const out = data.placeMaxBids;
    const placed = out?.successfulBids?.find((b) => b.listingId === row.listingId);
    if (placed) {
      // Alt answers with the max it recorded. It agreed on the bid this was
      // checked against, but a bid is the one thing worth reading back rather
      // than assuming.
      const took = centsOf(placed.maxBid?.price);
      if (took > 0 && took !== maxBid) {
        console.warn(`    ⚠️  ${row.lot}: Alt recorded a max of ${dollars(took)}, not the ${dollars(maxBid)} sent`);
      }
      return { ok: true, bidId: null };
    }
    const failed = out?.failedBids?.find((b) => b.listingId === row.listingId);
    const needs = failed ? [
      failed.paymentMethodFlow && `payment: ${failed.paymentMethodFlow}`,
      failed.requiredRetainerTier && `retainer: ${failed.requiredRetainerTier}`,
      failed.requiredHoldAmount && `hold: ${failed.requiredHoldAmount}`,
    ].filter(Boolean).join(", ") : "";
    return {
      ok: false,
      error: [failed?.error?.message ?? out?.error?.message ?? "Alt did not take the bid", needs || null].filter(Boolean).join(" — "),
      // Alt names what the account is missing in those three fields. With none
      // of them set, PlaceMaxBids priced the bid against the lot's own book and
      // turned it down there — most often a max already standing above it,
      // which says nothing about this account.
      blame: needs ? "account" : blameOf(failed?.error?.message ?? out?.error?.message ?? ""),
    };
  }
}

async function launchAlt(headed: boolean): Promise<AltSession> {
  const context = await chromium.launchPersistentContext(join(process.cwd(), SESSION_DIR), {
    headless: !headed, viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  return new AltSession(context, page);
}

/** Waits for a person to sign in in the browser window. */
async function manualLogin(session: AltSession) {
  await session.page.goto(`${ALT}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  console.log(`\n    Sign in to Alt in the browser window that just opened.`);
  console.log(`    Waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 60_000} minutes; this window closes itself once the session is saved.\n`);
  const started = Date.now();
  while (Date.now() - started < MANUAL_LOGIN_TIMEOUT_MS) {
    if (await session.cookie(SESSION_COOKIE)) { console.log("    signed in"); return; }
    await session.page.waitForTimeout(2_000);
  }
  throw new Error("Nobody signed in within the wait.");
}

/**
 * A signed-in Alt tab.
 *
 * The session is looked for in the saved browser profile, then in
 * ALT_SESSION_TOKEN, then — with --login — from a person at the keyboard.
 * Whatever it finds, the page is loaded so Stytch's SDK mints a JWT, and the
 * session is checked with Alt before the run is allowed to go on.
 */
export async function openAlt(
  opts: { headed: boolean; login: boolean; email?: string; live?: boolean },
): Promise<AltSession> {
  if (opts.live && !BID_INPUT_VERIFIED) {
    throw new Error(
      "Alt live bidding is switched off in code until PlaceMaxBids' input has been checked against what alt.xyz sends. " +
      "See the note at the top of scripts/alt-bidder.ts. --quote-only and a plan still work.");
  }
  const session = await launchAlt(opts.headed);
  const wanted = opts.email?.trim().toLowerCase() || "";

  try {
    if (opts.login) {
      await session.context.clearCookies();
      console.log("    signing out of the saved session first");
    }
    await session.page.goto(ALT, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await session.cookie(SESSION_COOKIE)) {
      console.log("    session restored from the saved browser profile");
    } else if (process.env.ALT_SESSION_TOKEN && !opts.login) {
      await session.context.addCookies([{
        name: SESSION_COOKIE, value: process.env.ALT_SESSION_TOKEN, url: ALT, secure: true, sameSite: "Lax",
      }]);
      await session.page.goto(ALT, { waitUntil: "domcontentloaded", timeout: 60_000 });
      console.log("    session from ALT_SESSION_TOKEN");
    } else if (opts.login) {
      await manualLogin(session);
    } else {
      throw new Error(
        "No Alt session. Either sign in once with: npm run sniper:alt -- --login\n" +
        "       or set ALT_SESSION_TOKEN (printed by --export-session).");
    }

    // The page's own SDK turns the session into a JWT; nothing can be asked
    // until it has.
    await session.jwt();
    const me = await session.whoAmI();
    if (wanted && me.email !== wanted) {
      throw new Error(`--email asks for ${wanted}, but this session is ${me.email || `account ${me.accountId}`}. Sign in again with: npm run sniper:alt -- --login`);
    }
    console.log(`    signed in to Alt as ${me.email || `account ${me.accountId}`}`);

    // The per-lot "can this account buy" check Fanatics has does not exist
    // here, so the account-wide one stands in for it, once.
    if (await session.biddingRestricted()) {
      throw new Error("Alt says this account is restricted from bidding. Sort that out on alt.xyz before running again.");
    }
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

export { dollars };
