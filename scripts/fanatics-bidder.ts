/**
 * Fanatics Collect — the exchange the sniper's book bids through.
 *
 * Everything here is about talking to Fanatics as a bidder: signing in, asking
 * where a lot stands, reading the account's bids and the auction's clock, and
 * placing a max bid. The budget, the ladder maths and the rules with money
 * behind them live in scripts/sniper-book.ts; the pipeline that finds the lots
 * is scripts/sniper-core.ts, driven by scripts/fanatics-sniper.ts.
 *
 * Signing in. Fanatics Collect hands login to Fanatics ONE at id.fanatics.com,
 * an OAuth page that asks for an email and then a password. A session is looked
 * for in four places, in this order:
 *   1. the saved browser profile, .fanatics-session/
 *   2. FANATICS_REFRESH_TOKEN
 *   3. a person at the keyboard, with --login
 *   4. FANATICS_EMAIL / FANATICS_PASSWORD, filled into that form
 *
 * Cloudflare serves the sign-in page a blank document to a headless browser, so
 * 3 and 4 both need a window — openFanatics opens one by itself for 4 rather
 * than failing. That is why a run on a machine nobody is watching wants 1 or 2:
 *   npm run sniper -- --login            sign in by hand, once. The session
 *                                        lands in .fanatics-session/ and is
 *                                        renewed from there afterwards.
 *   npm run sniper -- --export-session   prints the refresh token, for the
 *                                        FANATICS_REFRESH_TOKEN secret the
 *                                        workflow runs on — the only one of the
 *                                        four that works in CI.
 *
 * An account that answers with a one-time code cannot be signed in by 4 at all;
 * the error says so rather than hanging.
 */

import { join } from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  BidBook as CoreBidBook,
  bidAmount as coreBidAmount,
  nextAffordable as coreNextAffordable,
  rungAtOrAbove as coreRungAtOrAbove,
  rungAtOrBelow as coreRungAtOrBelow,
  rungSteps,
  dollars,
  withinMax,
  type AccountBid,
  type AuctionState,
  type Biddable,
  type BidResult,
  type BidStatus,
  type CardCaps,
  type Exchange,
  type Ladder,
  type Log,
  type Lot,
  type Quote,
} from "./sniper-book";
import type { Session } from "./sniper-core";

export {
  BUYERS_PREMIUM, DEFAULT_BUDGET_DOLLARS, allInCents, committedCents, dollars, seedable, withinMax,
} from "./sniper-book";
export type { AccountBid, AuctionState, Biddable, BidStatus, Log, Lot, PlacedBid, Quote } from "./sniper-book";

// ── Configuration ─────────────────────────────────────────────────────────────

const FANATICS = "https://www.fanaticscollect.com";
/** The site's own API. The documents below are the ones its pages send. */
const GRAPHQL = "https://app.fanaticscollect.com/graphql";
/** Logged-in browser profile; holds the session. Gitignored. */
export const SESSION_DIR = ".fanatics-session";
/** Where the site keeps its two JWTs. The access one is short-lived. */
const ACCESS_COOKIE = "pwcc-access-token";
const REFRESH_COOKIE = "pwcc-refresh-token";

const REQUEST_TIMEOUT_MS = 30_000;
/** Renew the access token this long before it lapses. */
const TOKEN_MARGIN_S = 120;
const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long the Fanatics ID form has to draw each of its two fields. */
const LOGIN_FIELD_TIMEOUT_MS = 45_000;
/**
 * Bids asked for per page of the account-wide read, and how many pages one
 * read may turn. The read answers for every weekly bid the account has ever
 * placed — 2,766 of them on 2026-09-13, against a page of 500 — so it is
 * paged, and stops early once a page after the open bids holds nothing but
 * history. Ten pages is 5,000 bids; an account past that gets the warning
 * below and the slow lot-by-lot path for the rest.
 */
const ACCOUNT_BIDS_PAGE = 500;
const ACCOUNT_BIDS_PAGES = 10;

/**
 * Fanatics' bid ladder, in cents, as the site's own code has it: the step
 * grows at each boundary — $1 steps to $50, $2 to $100, $5 to $200, $10 to
 * $500, $25 to $2,000, $100 to $5,000, and on up.
 */
export const BID_LADDER: Ladder = [
  { step: 100, upTo: 5_000 },
  { step: 200, upTo: 10_000 },
  { step: 500, upTo: 20_000 },
  { step: 1_000, upTo: 50_000 },
  { step: 2_500, upTo: 200_000 },
  { step: 10_000, upTo: 500_000 },
  { step: 25_000, upTo: 1_000_000 },
  { step: 50_000, upTo: 3_000_000 },
  { step: 200_000, upTo: 5_000_000 },
  { step: 500_000, upTo: 10_000_000 },
  { step: 1_000_000, upTo: 20_000_000 },
  { step: 2_000_000, upTo: 50_000_000 },
  { step: 5_000_000, upTo: 150_000_000 },
  { step: 10_000_000, upTo: 5_000_000_000 },
];

// ── The ladder maths, bound to Fanatics' ladder ──────────────────────────────

/** Fanatics takes a bid on a rung of the ladder and nowhere else. */
export const FANATICS_STEPS = rungSteps(BID_LADDER);

/** The highest rung of the ladder at or below `cents`; 0 when there is none. */
export const rungAtOrBelow = (cents: number) => coreRungAtOrBelow(BID_LADDER, cents);
/** The lowest rung of the ladder at or above `cents`. */
export const rungAtOrAbove = (cents: number) => coreRungAtOrAbove(BID_LADDER, cents);
/** What to bid on a lot, or why not. */
export const bidAmount = (row: Pick<Biddable, "maxHammerCents">, quote: Quote) => coreBidAmount(row, quote, FANATICS_STEPS);
/** The next lot on the list that the free budget covers. */
export const nextAffordable = (rows: Biddable[], decided: Set<string>, freeCents: number) =>
  coreNextAffordable(rows, decided, freeCents, FANATICS_STEPS);

/** The book, bidding on Fanatics' ladder; without an exchange it plans against the scan. */
export class BidBook extends CoreBidBook {
  constructor(exchange: Exchange | null, opts: { budgetCents: number; live: boolean; log: Log; caps?: CardCaps; countInherited?: boolean }) {
    super(exchange, { ...opts, steps: FANATICS_STEPS, listingUrl });
  }
}

// ── A lot's page ──────────────────────────────────────────────────────────────

/** The lot's page, so a log line can be clicked through to what was bid on. */
export function listingUrl(listingId: string): string {
  return `${FANATICS}/weekly/${listingId}`;
}

export function listingIdFromUrl(url: string): string | null {
  return /\/weekly\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url)?.[1]?.toLowerCase() ?? null;
}

// ── Fanatics session ──────────────────────────────────────────────────────────

type Tokens = { access: string; refresh: string };

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const body = token.split(".")[1];
    return body ? (JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Unix seconds, or 0 for a token with no expiry to read. */
export function jwtExpiresAt(token: string): number {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : 0;
}

async function readTokens(context: BrowserContext): Promise<Tokens> {
  const cookies = await context.cookies(FANATICS);
  const get = (name: string) => cookies.find((c) => c.name === name)?.value ?? "";
  return { access: get(ACCESS_COOKIE), refresh: get(REFRESH_COOKIE) };
}

const REFRESH_MUTATION = `
  mutation webRefreshTokenMutation($refreshToken: String!) {
    collectRefreshToken(refreshToken: $refreshToken) {
      accessToken
      refreshToken
    }
  }
`;

/**
 * Who the session belongs to, which is also the check that it works at all: a
 * tenantId comes back when Fanatics recognises the caller and the whole thing
 * is null with an "unauthenticated" error when it does not.
 *
 * collectSessionValid looks like the obvious check and is not — it answers
 * valid:false for a session that is signed in and bidding, so it means some
 * other kind of session. frozen and bidLimit are worth having here because
 * both stop a bid at Fanatics' end rather than ours.
 */
const IDENTITY_QUERY = `
  query webCurrentUserQuery {
    collectCurrentUserV2 {
      tenantId
      frozen
      bidLimit
      email { address }
    }
  }
`;

const LISTING_QUERY = `
  query webWeeklyListingQuery($id: UUID!, $type: CollectListingType!) {
    collectListing(id: $id, type: $type) {
      id
      title
      lotString
      bidCount
      highestBidder
      isOwner
      currentBid { amountInCents currency }
      startingPrice { amountInCents currency }
      states {
        userMaxBid { amountInCents currency }
        userCanBuy
        userBidStatus
        isClosed
        lastWindowWhenBidWasReceived
      }
      auction {
        ... on CollectWeeklyAuction {
          id
          name
          status
          endsAt
        }
      }
    }
  }
`;

/**
 * The auctions themselves, with the clock Fanatics runs them on.
 *
 * status goes LIVE, then EXTENDED_BIDDING, then CLOSED. Extended bidding opens
 * at 7:00 PM PT and closes lots one by one, on the rule in the help centre: a
 * lot with no bid between 7:00 and 7:30 closes at 7:30 sharp; one still open
 * after 7:30 closes five minutes after its last bid; after 8:00, one minute
 * after. The timer here counts those windows off — windowDurationSeconds
 * long, windowOrdinal numbering them (60 s once the auction is over, whatever
 * phase it closed in). So a weekly auction has no fixed end, only a fixed
 * 7:30 cliff for every lot nobody has fought over, which is why the bids go
 * on just before it. The query needs no account: the site asks it on every
 * page load.
 */
const AUCTIONS_QUERY = `
  query webGlobalAuctionsQuery {
    collectGlobalAuctions {
      __typename
      ... on CollectWeeklyAuction {
        id
        name
        status
        endsAt
        collectListingTimer {
          auctionEndsAt
          windowEndsAt
          windowOrdinal
          windowDurationSeconds
        }
      }
    }
  }
`;

const ACTIVE_BIDS_QUERY = `
  query webGetActiveAuctionsBidsQuery($listingTypes: [CollectListingType], $first: Int, $after: String) {
    collectCurrentUserV2 {
      collectListings(includeBids: true, listingTypes: $listingTypes, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            lotString
            bidCount
            highestBidder
            currentBid { amountInCents currency }
            states {
              userMaxBid { amountInCents currency }
              userBidStatus
              isClosed
            }
            auction {
              ... on CollectWeeklyAuction { id status }
            }
          }
        }
        total
      }
    }
  }
`;

/**
 * The bid itself. One request, one lot, the max in cents; the site's own bid
 * dialog sends exactly this. Fanatics answers with a bidId, or with an error
 * on the result when the bid was not taken.
 */
const MULTI_BID_MUTATION = `
  mutation webMultiBidMutation($input: CollectMultiBidRequest!) {
    collectMultiBid(input: $input) {
      result {
        bidResults {
          error
          bidId
          returnedListing: listing { id }
        }
      }
      successful
      messages { message code }
    }
  }
`;

type GqlResponse<T> = { data?: T; errors?: { message: string; code?: string }[] };

type ListingData = {
  collectListing: {
    id: string;
    title: string | null;
    lotString: string | null;
    bidCount: number | null;
    highestBidder: boolean | null;
    isOwner: boolean | null;
    currentBid: { amountInCents: number } | null;
    startingPrice: { amountInCents: number } | null;
    states: {
      userMaxBid: { amountInCents: number } | null;
      userCanBuy: boolean | null;
      userBidStatus: string | null;
      isClosed: boolean | null;
    } | null;
    auction: { id: string | null; status: string | null } | null;
  } | null;
};

function asStatus(s: string | null | undefined): BidStatus {
  return s === "HIGH_BID" || s === "OUTBID" || s === "NO_BIDS" ? s : "NO_STATUS";
}

const unixS = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1_000) || 0 : 0);

/** Waits for a person to sign in in the browser window. */
async function manualLogin(page: Page) {
  await page.goto(`${FANATICS}/auth/login`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  console.log(`\n    Sign in to Fanatics in the browser window that just opened.`);
  console.log(`    Waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 60_000} minutes; this window closes itself once the session is saved.\n`);
  const started = Date.now();
  while (Date.now() - started < MANUAL_LOGIN_TIMEOUT_MS) {
    if ((await readTokens(page.context())).refresh) { console.log("    signed in"); return; }
    await page.waitForTimeout(2_000);
  }
  throw new Error("Nobody signed in within the wait.");
}

/**
 * Signs in by filling the Fanatics ID form.
 *
 * Fanatics Collect hands login to Fanatics ONE at id.fanatics.com, which asks
 * for the email on one screen and the password on the next, each behind a
 * Continue button that stays disabled until its field is valid. It then bounces
 * back through /callback/fanid, and the session cookies land on the way past.
 *
 * Two things this cannot get around. Cloudflare serves that page a blank
 * document to a headless browser, so the form only appears with --headed —
 * which is why openFanatics turns headed on by itself when it can see this path
 * coming. And an account that answers with a one-time code cannot be signed in
 * without a person to read the email; the error says so rather than hanging.
 */
async function passwordLogin(page: Page, email: string, password: string) {
  console.log(`    signing in as ${email.replace(/^(.)[^@]*/, "$1…")}`);
  await page.goto(`${FANATICS}/auth/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL(/id\.fanatics\.com/, { timeout: 30_000 }).catch(() => {});

  const emailBox = page.locator('input[type="email"], input[autocomplete="username"], input[type="text"]').first();
  try {
    await emailBox.waitFor({ timeout: LOGIN_FIELD_TIMEOUT_MS });
  } catch {
    throw new Error(
      "The Fanatics ID sign-in page never drew its form. Cloudflare serves a headless browser a blank page there — " +
      "run with --headed, or sign in once by hand with --login and let the saved session carry every run after it.");
  }
  await emailBox.fill(email);
  await page.getByRole("button", { name: /^continue$/i }).first().click();

  const passwordBox = page.locator('input[type="password"]').first();
  try {
    await passwordBox.waitFor({ timeout: LOGIN_FIELD_TIMEOUT_MS });
  } catch {
    throw new Error(
      "Fanatics asked for something other than a password after the email — a one-time code, most likely. " +
      "Sign in by hand once with --login; the saved session is renewed from then on.");
  }
  await passwordBox.fill(password);
  await page.getByRole("button", { name: /^(continue|sign ?in|log ?in)$/i }).first().click();

  // Back on the marketplace, with the cookies set on the way through.
  await page.waitForURL(/fanaticscollect\.com/, { timeout: 90_000 });
  for (let i = 0; i < 60 && !(await readTokens(page.context())).refresh; i++) await page.waitForTimeout(1_000);
  if (!(await readTokens(page.context())).refresh) {
    throw new Error("Signed in, but no session cookie appeared. Sign in by hand once with --login.");
  }
  console.log("    signed in");
}

/**
 * A signed-in Fanatics tab, and everything the book asks of it.
 *
 * The access token is renewed off the refresh token — the site's own
 * mechanism — before every request that needs one, and both are written back
 * to the profile so the saved session stays signed in across runs.
 */
export class FanaticsSession implements Session {
  readonly steps = FANATICS_STEPS;
  tokens: Tokens = { access: "", refresh: "" };
  private warnedTruncated = false;

  constructor(readonly context: BrowserContext, readonly page: Page) {}

  listingUrl(listingId: string): string { return listingUrl(listingId); }

  close(): Promise<void> { return this.context.close(); }

  async snapshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async exportable() {
    const exp = jwtExpiresAt(this.tokens.refresh);
    return { name: "FANATICS_REFRESH_TOKEN", value: this.tokens.refresh, expiresAtUnixS: exp || null };
  }

  /**
   * Keeps the site's own copy in step with ours, so the saved profile stays
   * signed in across runs and the page — should anyone be watching it — agrees
   * with what the requests are doing.
   */
  private async storeTokens(tokens: Tokens) {
    this.tokens = tokens;
    const cookie = (name: string, value: string) => ({
      name, value, url: FANATICS, secure: true, sameSite: "Lax" as const,
      expires: jwtExpiresAt(value) || -1,
    });
    await this.context.addCookies([cookie(ACCESS_COOKIE, tokens.access), cookie(REFRESH_COOKIE, tokens.refresh)]).catch(() => {});
  }

  /** Renews the access token off the refresh token when it is about to lapse. */
  async freshenTokens() {
    const { access, refresh } = this.tokens;
    const now = Math.floor(Date.now() / 1000);
    if (access && jwtExpiresAt(access) - now > TOKEN_MARGIN_S) return;
    if (!refresh) throw new Error("The session has lapsed and there is no refresh token to renew it with — sign in again with --login.");

    const data = await this.gql<{ collectRefreshToken: { accessToken: string | null; refreshToken: string | null } | null }>(
      "webRefreshTokenMutation", REFRESH_MUTATION, { refreshToken: refresh }, { auth: false });
    const next = data.collectRefreshToken;
    if (!next?.accessToken || !next.refreshToken) throw new Error("Fanatics would not renew the session — sign in again with --login.");
    await this.storeTokens({ access: next.accessToken, refresh: next.refreshToken });
    console.log(`    session renewed, good for ${Math.round((jwtExpiresAt(next.accessToken) - now) / 60)} min`);
  }

  async gql<T>(operationName: string, query: string, variables: Record<string, unknown>, opts: { auth?: boolean } = {}): Promise<T> {
    const auth = opts.auth ?? true;
    if (auth) await this.freshenTokens();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth && this.tokens.access) headers.authorization = `Bearer ${this.tokens.access}`;

    const res = await this.page.request.post(GRAPHQL, {
      headers, data: { operationName, query, variables }, timeout: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok()) throw new Error(`${operationName}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors?.length) throw new Error(`${operationName}: ${json.errors.map((e) => e.message).join("; ")}`);
    if (!json.data) throw new Error(`${operationName}: empty response`);
    return json.data;
  }

  /** Who Fanatics says the session belongs to, and whether it may bid at all. */
  async whoAmI(): Promise<{ address: string; tenantId: string; bidLimit: number | null }> {
    const me = (await this.gql<{ collectCurrentUserV2: {
      tenantId: string | null; frozen: boolean | null; bidLimit: number | null; email: { address: string | null } | null } | null }>(
      "webCurrentUserQuery", IDENTITY_QUERY, {})).collectCurrentUserV2;
    if (!me?.tenantId) throw new Error("Fanatics does not recognise the session — sign in again with --login.");
    if (me.frozen) throw new Error("This Fanatics account is frozen, so it cannot bid. Sort that out on fanaticscollect.com first.");
    return { address: (me.email?.address ?? "").toLowerCase(), tenantId: me.tenantId, bidLimit: me.bidLimit };
  }

  /**
   * Where one lot stands right now, straight from Fanatics. Free, and the only
   * honest answer about a lot the scan looked at hours ago.
   */
  async quote(listingId: string): Promise<Lot> {
    const data = await this.gql<ListingData>("webWeeklyListingQuery", LISTING_QUERY, { id: listingId, type: "WEEKLY" });
    const l = data.collectListing;
    if (!l) throw new Error(`listing ${listingId}: Fanatics has no such lot`);
    return {
      id: l.id,
      title: l.title ?? "",
      lot: l.lotString ?? "",
      currentBidCents: l.currentBid?.amountInCents ?? 0,
      startingPriceCents: l.startingPrice?.amountInCents ?? 0,
      bidCount: l.bidCount ?? 0,
      highestBidder: l.highestBidder ?? false,
      isOwner: l.isOwner ?? false,
      userMaxBidCents: l.states?.userMaxBid?.amountInCents ?? 0,
      userCanBuy: l.states?.userCanBuy ?? false,
      userBidStatus: asStatus(l.states?.userBidStatus),
      isClosed: l.states?.isClosed ?? false,
      auctionId: l.auction?.id ?? "",
      auctionStatus: l.auction?.status ?? "",
    };
  }

  /**
   * The auction a run is bidding in.
   *
   * Asks for all of them and picks ours by id, falling back to the weekly one
   * that is open and closing soonest — which is the auction the scan walked.
   */
  async readAuction(auctionId: string): Promise<AuctionState | null> {
    type Node = {
      __typename?: string; id?: string | null; name?: string | null; status?: string | null; endsAt?: string | null;
      collectListingTimer?: { windowEndsAt?: string | null; windowOrdinal?: number | null; windowDurationSeconds?: number | null } | null;
    };
    const data = await this.gql<{ collectGlobalAuctions: Node[] | null }>(
      "webGlobalAuctionsQuery", AUCTIONS_QUERY, {}, { auth: false });

    const weekly = (data.collectGlobalAuctions ?? []).filter((a) => a.__typename === "CollectWeeklyAuction" && a.id);
    const open = weekly
      .filter((a) => a.status === "LIVE" || a.status === "EXTENDED_BIDDING")
      .sort((a, b) => unixS(a.endsAt) - unixS(b.endsAt));
    const mine = weekly.find((a) => a.id === auctionId) ?? open[0];
    if (!mine?.id) return null;

    return {
      id: mine.id,
      name: mine.name ?? "",
      status: mine.status ?? "",
      // Fanatics closes lots one by one, so the auction's own end is the fixed
      // moment extended bidding opened; both fields say the same thing here.
      endsAtUnixS: unixS(mine.endsAt),
      scheduledEndUnixS: unixS(mine.endsAt),
      windowEndsAtUnixS: unixS(mine.collectListingTimer?.windowEndsAt),
      windowOrdinal: mine.collectListingTimer?.windowOrdinal ?? null,
      windowSeconds: mine.collectListingTimer?.windowDurationSeconds ?? 0,
    };
  }

  /**
   * Where the open bids begin in the account's list, as the last read found
   * it: the cursor the page holding the first of them was asked for with —
   * null for the first page. Null altogether until a read has found one.
   */
  private openBidsFrom: { after: string | null } | null = null;

  /**
   * The account's open bids, and whatever history shares their pages.
   *
   * The list is every weekly bid the account has ever placed — 4,543 of them
   * on 2026-10-04, ten pages — and only the handful in the auction closing
   * now are of any use to a run. They sit together, at one end of the list or
   * the other, so a read that has found them remembers where they began and
   * the next one starts there instead of at the top: a page or two a poll
   * rather than all ten. A read that starts there and finds none has lost
   * them — they have closed, or the list has moved — and forgets the place,
   * so the read after it walks the whole list once more.
   */
  async accountBids(): Promise<Map<string, AccountBid> | null> {
    type Data = {
      collectCurrentUserV2: {
        collectListings: {
          edges: { node: {
            id: string; title: string | null; lotString: string | null; highestBidder: boolean | null;
            currentBid: { amountInCents: number } | null;
            states: { userMaxBid: { amountInCents: number } | null; userBidStatus: string | null; isClosed: boolean | null } | null;
            auction: { id: string | null; status: string | null } | null;
          } }[];
          pageInfo: { hasNextPage: boolean | null; endCursor: string | null } | null;
          total: number | null;
        } | null;
      } | null;
    };
    const bids = new Map<string, AccountBid>();
    let after: string | null = this.openBidsFrom?.after ?? null;
    let firstOpen: { after: string | null } | null = null;
    let seenOpen = false;
    let total = 0;
    let more = false;
    try {
      for (let page = 1; page <= ACCOUNT_BIDS_PAGES; page++) {
        const askedWith = after;
        const data: Data = await this.gql<Data>("webGetActiveAuctionsBidsQuery", ACTIVE_BIDS_QUERY, { listingTypes: ["WEEKLY"], first: ACCOUNT_BIDS_PAGE, after });
        const listings = data.collectCurrentUserV2?.collectListings;
        total = listings?.total ?? total;
        let openHere = 0;
        for (const { node } of listings?.edges ?? []) {
          const status = node.auction?.status ?? "";
          const open = !(node.states?.isClosed ?? false) && (status === "LIVE" || status === "EXTENDED_BIDDING" || status === "");
          if (open) openHere++;
          bids.set(node.id, {
            listingId: node.id,
            title: node.title ?? "",
            lot: node.lotString ?? "",
            maxCents: node.states?.userMaxBid?.amountInCents ?? 0,
            status: asStatus(node.states?.userBidStatus),
            closed: node.states?.isClosed ?? false,
            currentBidCents: node.currentBid?.amountInCents ?? 0,
            highestBidder: node.highestBidder ?? false,
            auctionId: node.auction?.id ?? "",
            auctionStatus: status,
          });
        }
        more = listings?.pageInfo?.hasNextPage ?? false;
        after = listings?.pageInfo?.endCursor ?? null;
        // The open bids sit together in the list, whichever end it starts from.
        // A page with none, after pages that had some, is the far side of them:
        // nothing past it is a bid this run could be holding.
        if (openHere > 0) { seenOpen = true; firstOpen ??= { after: askedWith }; }
        else if (seenOpen) { more = false; }
        if (!more || !after) break;
      }
    } catch (err) {
      // A cursor the list no longer honours is one way to end up here, so the
      // place is forgotten and the next read starts from the top.
      this.openBidsFrom = null;
      throw err;
    }
    this.openBidsFrom = firstOpen;
    // Ten pages and still more: the lots left out are quoted one by one by
    // the book, which is slow. Said once, loudly.
    if (more && !this.warnedTruncated) {
      this.warnedTruncated = true;
      console.warn(`    ⚠️  this account has ${total} weekly bids and the read stopped at ${bids.size} — the rest are quoted lot by lot`);
    }
    return bids;
  }

  /**
   * Sends one max bid. withinMax() runs here, last thing before the request —
   * and before it, the sourcing check's verdict: a row carrying one (the bids
   * CSV's unawardable column, on a Biddable built from such a row) is refused
   * rather than sent. A row without the field, as from an older CSV, is not
   * unawardable.
   */
  async sendBid(row: Biddable & { unawardable?: string }, cents: number): Promise<BidResult> {
    if (row.unawardable) return { ok: false, error: `unawardable: ${row.unawardable}`, blame: "lot" };
    const maxBid = withinMax(cents, row);
    const data = await this.gql<{
      collectMultiBid: {
        successful: boolean | null;
        messages: { message: string | null; code: string | null }[] | null;
        result: { bidResults: { error: string | null; bidId: string | null }[] | null } | null;
      } | null;
    }>("webMultiBidMutation", MULTI_BID_MUTATION, {
      input: { bidRequests: [{ listingId: row.listingId, maxBid }], auctionType: "WEEKLY" },
    });

    const outcome = data.collectMultiBid;
    const first = outcome?.result?.bidResults?.[0];
    if (first?.error) return { ok: false, error: first.error };
    if (!outcome?.successful) {
      return { ok: false, error: outcome?.messages?.map((m) => m.message).filter(Boolean).join("; ") || "Fanatics did not take the bid" };
    }
    return { ok: true, bidId: first?.bidId ?? null };
  }
}

async function launchFanatics(headed: boolean): Promise<FanaticsSession> {
  const context = await chromium.launchPersistentContext(join(process.cwd(), SESSION_DIR), {
    headless: !headed, viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  return new FanaticsSession(context, page);
}

/**
 * A signed-in Fanatics tab.
 *
 * The session is looked for in four places, in this order: the saved browser
 * profile, FANATICS_REFRESH_TOKEN, a person at the keyboard (--login), and
 * finally FANATICS_EMAIL / FANATICS_PASSWORD. Whatever it finds, the access
 * token is renewed off the refresh token and the session checked with Fanatics
 * before the run is allowed to start bidding on it.
 */
export async function openFanatics(
  opts: { headed: boolean; login: boolean; email?: string; password?: string },
): Promise<FanaticsSession> {
  let session = await launchFanatics(opts.headed);
  const wanted = opts.email?.trim().toLowerCase() || "";
  const password = opts.password || process.env.FANATICS_PASSWORD || "";

  try {
    // --login means sign in, not "sign in unless you already are". The saved
    // session is dropped first, or the profile's own cookies would answer for
    // it and nobody would be asked anything.
    if (opts.login) {
      await session.context.clearCookies();
      console.log("    signing out of the saved session first");
    }
    await session.page.goto(FANATICS, { waitUntil: "domcontentloaded", timeout: 60_000 });
    session.tokens = await readTokens(session.context);
    if (session.tokens.refresh) {
      console.log("    session restored from the saved browser profile");
    } else if (process.env.FANATICS_REFRESH_TOKEN && !opts.login) {
      session.tokens = { access: "", refresh: process.env.FANATICS_REFRESH_TOKEN };
      console.log("    session from FANATICS_REFRESH_TOKEN");
    } else if (opts.login) {
      await manualLogin(session.page);
      session.tokens = await readTokens(session.context);
    } else if ((wanted || process.env.FANATICS_EMAIL) && password) {
      if (!opts.headed) {
        // Cloudflare hands a headless browser a blank sign-in page, so this one
        // path needs a window. Nothing has been done yet, so reopening is free.
        console.log("    opening a window: the Fanatics sign-in page does not render headless");
        await session.close();
        session = await launchFanatics(true);
      }
      await passwordLogin(session.page, wanted || process.env.FANATICS_EMAIL!, password);
      session.tokens = await readTokens(session.context);
    } else {
      throw new Error(
        "No Fanatics session. Either sign in once with: npm run sniper -- --login\n" +
        "       or put FANATICS_EMAIL and FANATICS_PASSWORD in .env.local, or set FANATICS_REFRESH_TOKEN.");
    }
    if (!session.tokens.refresh) throw new Error("Signed in, but the session cookies never appeared.");

    await session.freshenTokens();
    let me = await session.whoAmI();

    // --email names the account this run is for. A saved profile or a token
    // says nothing about whose it is, so being handed the wrong one is a quiet
    // mistake with money behind it: bid the right maths at the wrong account
    // and nobody notices until the invoice. If they disagree, sign in again as
    // the account asked for, or stop.
    if (wanted && me.address !== wanted) {
      const found = me.address || `tenant ${me.tenantId}`;
      if (!password) {
        throw new Error(
          `--email asks for ${wanted}, but this session is ${found}. ` +
          `Give --password as well (or set FANATICS_PASSWORD) to sign in as ${wanted}, ` +
          `or sign in by hand with: npm run sniper -- --login`);
      }
      console.log(`    session is ${found}, not the ${wanted} asked for — signing in again`);
      await session.context.clearCookies();
      if (!opts.headed) {
        console.log("    opening a window: the Fanatics sign-in page does not render headless");
        await session.close();
        session = await launchFanatics(true);
      }
      await passwordLogin(session.page, wanted, password);
      session.tokens = await readTokens(session.context);
      if (!session.tokens.refresh) throw new Error("Signed in, but the session cookies never appeared.");
      await session.freshenTokens();
      me = await session.whoAmI();
      if (me.address !== wanted) {
        throw new Error(`Signed in, but Fanatics says this session is ${me.address || "someone else"}, not ${wanted}.`);
      }
    }

    // Whose money this is. A session can come from four places and three of
    // them are silent about it, so the run says it out loud every time rather
    // than leaving anyone to guess which account is about to bid.
    console.log(`    signed in to Fanatics Collect as ${me.address || `tenant ${me.tenantId}`}${me.bidLimit ? `, bid limit ${dollars(me.bidLimit)}` : ""}`);
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}
