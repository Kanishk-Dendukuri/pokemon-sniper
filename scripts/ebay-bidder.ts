/**
 * eBay — the signed-in browser the sniper bids through.
 *
 * eBay's bidding API is not an option: PlaceOffer is closed to new
 * applications and its licence forbids "any application that places bids on
 * a buyer's behalf based on time remaining or at a scheduled time", and the
 * Offer API that replaced it is approval-only. So the bid is placed the way
 * a person places one — the item page, the bid layer, the max, Confirm —
 * from a browser profile the account was signed into once by hand:
 *
 *   npm run sniper:ebay -- --login       sign in by hand, once. The session
 *                                        lands in .ebay-session/ and is used
 *                                        from there afterwards.
 *
 * The profile is a credential and stays out of git. There is no password
 * path and no token to export: eBay's sign-in is a page with a one-time code
 * behind it, and the run lives on the one PC the profile is on.
 *
 * Timing. A snipe is two moments: the bid is *prepared* a minute out — the
 * page opened, the max typed, the flow walked up to the Confirm button and no
 * further — and *confirmed* at the fire, seconds before the end, with one
 * click. The clock the fire is measured on is eBay's, read off the API's
 * responses (scripts/ebay-search.ts), not the PC's.
 *
 * What is verified and what is not. Nothing here has yet been walked against
 * a signed-in session: the bid layer's fields and buttons are found by their
 * roles and labels as eBay has drawn them, with a screenshot at every step
 * for when they are not. BID_FLOW_VERIFIED holds a live run off until
 * --rehearse has walked the flow on a real listing and the flow below has
 * been read against what it found. A rehearsal goes up to Confirm and stops.
 */
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { chromium, type BrowserContext, type Cookie, type Locator, type Page } from "playwright";
import { itemUrl } from "./ebay-search";
import { dollars, incrementSteps, withinMax, type Biddable, type BidResult, type Ladder } from "./sniper-book";

export const EBAY = "https://www.ebay.com";
export const SIGNIN_URL = "https://signin.ebay.com/";
/** A page that only draws when signed in; anything else bounces to sign-in. */
const MY_EBAY_URL = "https://www.ebay.com/mye/myebay/summary";
/** Logged-in browser profile; holds the session. Gitignored. */
export const SESSION_DIR = ".ebay-session";

/**
 * Whether the bid flow below has been checked against eBay's real bid layer.
 * Flip to true only after a --rehearse has walked a real listing to Confirm
 * and every step matched. Until then --live is refused in openEbay().
 */
export const BID_FLOW_VERIFIED = false;

const PAGE_TIMEOUT_MS = 45_000;
const STEP_TIMEOUT_MS = 20_000;
const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long Confirm is given to answer with a standing. */
const CONFIRM_ANSWER_TIMEOUT_MS = 15_000;

/**
 * eBay's bid increments in the US, cents: the least a bid must rise by,
 * from where the bidding stands. upTo is the next band's floor — the way
 * incrementAt() reads a ladder. The site quotes the exact next bid on the
 * item itself (minimumPriceToBid), which the sniper prefers; the table is
 * the fallback and the check.
 */
export const BID_INCREMENTS: Ladder = [
  { step: 5, upTo: 100 },            // $0.01–0.99: $0.05
  { step: 25, upTo: 500 },           // $1.00–4.99: $0.25
  { step: 50, upTo: 2_500 },         // $5.00–24.99: $0.50
  { step: 100, upTo: 10_000 },       // $25–99.99: $1
  { step: 250, upTo: 25_000 },       // $100–249.99: $2.50
  { step: 500, upTo: 50_000 },       // $250–499.99: $5
  { step: 1_000, upTo: 100_000 },    // $500–999.99: $10
  { step: 2_500, upTo: 250_000 },    // $1,000–2,499.99: $25
  { step: 5_000, upTo: 500_000 },    // $2,500–4,999.99: $50
  { step: 10_000, upTo: Number.MAX_SAFE_INTEGER }, // $5,000 and up: $100
];

/** eBay takes any amount at or above the next bid; ours is the max to the whole dollar. */
export const EBAY_STEPS = incrementSteps(BID_INCREMENTS);

/** What the page said when the bid went on, boiled down. */
export type BidAnswer = "highest" | "outbid" | "refused" | "ended" | "unknown";

/** The lot's page, opened and walked to the Confirm button, waiting for the fire. */
export type PreparedBid = {
  row: Biddable;
  cents: number;
  page: Page;
  confirm: Locator;
  preparedAtMs: number;
};

export type Outcome = {
  verdict: "won" | "lost" | "ended" | "live" | "unknown";
  /** What the listing closed at, when the page says. */
  finalCents?: number;
  text: string;
};

/**
 * The bid layer's answer, from the words on the page. Matched in this order:
 * an outright refusal first (a bid under the minimum, a blocked buyer), then
 * winning, then outbid.
 */
export function readBidAnswer(text: string): BidAnswer {
  const t = text.replace(/\s+/g, " ");
  if (/bidding has ended|listing has ended|this listing was ended|item is no longer available/i.test(t)) return "ended";
  if (/enter (?:a )?(?:bid|amount)? ?(?:of|that.s)? ?(?:at least|higher)|bid must be|minimum bid|can.t bid|cannot bid|unable to (?:place|bid)|not eligible|something went wrong|try again/i.test(t)) return "refused";
  if (/you.re the (?:highest|high) bidder|you are the (?:highest|high) bidder|you.re winning|you are winning|highest bidder/i.test(t)) return "highest";
  if (/you.ve been outbid|you have been outbid|you.re not the highest|outbid/i.test(t)) return "outbid";
  return "unknown";
}

/** How a closed listing ended for this account, from the words on its page. */
export function readOutcome(text: string): Outcome {
  const t = text.replace(/\s+/g, " ");
  const final = /(?:sold for|winning bid|won (?:this item )?for|final (?:bid|price))[^$]{0,30}\$\s?([\d,]+(?:\.\d{2})?)/i.exec(t);
  const finalCents = final ? Math.round(Number(final[1].replace(/,/g, "")) * 100) : undefined;
  if (/you won|congratulations[^.]{0,40}won|you.re the winning bidder|you are the winning bidder|you.ve won/i.test(t)) return { verdict: "won", finalCents, text: t.slice(0, 200) };
  if (/you didn.t win|you did not win|you were outbid|you.ve been outbid|you.re not the winning bidder|sold to another|someone else won/i.test(t)) return { verdict: "lost", finalCents, text: t.slice(0, 200) };
  if (/bidding has ended|this listing has ended|listing was ended|item has ended|sold for/i.test(t)) return { verdict: "ended", finalCents, text: t.slice(0, 200) };
  if (/place bid|time left|bids?\b.*\bleft/i.test(t)) return { verdict: "live", text: t.slice(0, 200) };
  return { verdict: "unknown", finalCents, text: t.slice(0, 200) };
}

/** The signed-in name eBay greets with — "Hi Kanishk!" — or "" when there is no greeting. */
export function readGreeting(text: string): string {
  const m = /\bHi[,]?\s+([^!\n]{1,40})!/.exec(text);
  return m ? m[1].trim() : "";
}

// ── The session ───────────────────────────────────────────────────────────────

export class EbaySession {
  readonly steps = EBAY_STEPS;
  readonly listingUrl = itemUrl;
  /** Pages open on prepared bids, so a shutdown can close them. */
  private readonly open = new Set<Page>();

  constructor(readonly context: BrowserContext, readonly page: Page, private readonly outDir: string) {}

  /** For the post-mortem when a run dies. */
  async snapshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true }).catch(() => {});
  }

  async close(): Promise<void> {
    for (const page of this.open) await page.close().catch(() => {});
    await this.context.close().catch(() => {});
  }

  private async bodyText(page: Page): Promise<string> {
    return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  }

  /** Whether the profile is signed in, and who eBay thinks that is. */
  async whoAmI(): Promise<{ signedIn: boolean; greeting: string }> {
    await this.page.goto(MY_EBAY_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await this.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const url = new URL(this.page.url());
    if (/signin\.ebay|\/signin/.test(url.host + url.pathname)) return { signedIn: false, greeting: "" };
    const greeting = readGreeting(await this.bodyText(this.page));
    return { signedIn: true, greeting };
  }

  /** A person signs in at the keyboard; the profile keeps it. */
  async manualLogin(): Promise<void> {
    await this.page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    console.log("\n    Sign in to eBay in the browser window (email, password, any code it asks for).");
    console.log(`    Waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 60_000} minutes…`);
    const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3_000);
      const url = this.page.url();
      if (/signin\.ebay/.test(url)) continue;
      const me = await this.whoAmI().catch(() => ({ signedIn: false, greeting: "" }));
      if (me.signedIn) return;
    }
    throw new Error("Timed out waiting for the eBay sign-in to finish.");
  }

  private async shot(page: Page, name: string): Promise<string> {
    const path = join(this.outDir, `${name}.png`);
    await page.screenshot({ path, fullPage: false }).catch(() => {});
    return path;
  }

  /** Every button and link the page shows, for the error when a step cannot find its control. */
  private async controls(page: Page): Promise<string> {
    const names = await page.getByRole("button").allInnerTexts().catch(() => [] as string[]);
    const links = await page.getByRole("link").allInnerTexts().catch(() => [] as string[]);
    const clean = (xs: string[]) => [...new Set(xs.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 40);
    return `buttons: ${clean(names).join(" | ")}\n       links: ${clean(links).join(" | ")}`;
  }

  /**
   * The item page, the bid layer, the max typed, and the flow walked to the
   * Confirm button — which is not clicked. The page is left open on it.
   *
   * withinMax() runs here, before anything is typed, and again in confirm().
   */
  async prepareBid(row: Biddable, cents: number, tag = row.lot): Promise<PreparedBid> {
    withinMax(cents, row);
    const page = await this.context.newPage();
    this.open.add(page);
    try {
      await page.goto(itemUrl(row.listingId), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

      // 1. "Place bid" on the item page opens the bid layer.
      const placeBid = page.getByRole("link", { name: /place bid/i }).or(page.getByRole("button", { name: /place bid/i })).first();
      try {
        await placeBid.click({ timeout: STEP_TIMEOUT_MS });
      } catch {
        const text = await this.bodyText(page);
        const shot = await this.shot(page, `prepare-${tag}-1-item`);
        if (/signin\.ebay/.test(page.url())) throw new Error(`eBay wants a sign-in — the saved session has lapsed. Run: npm run sniper:ebay -- --login  (${shot})`);
        if (readOutcome(text).verdict !== "live") throw new Error(`the listing is not open for bids (${readOutcome(text).verdict}) — ${shot}`);
        throw new Error(`no "Place bid" control on the item page — ${shot}\n       ${await this.controls(page)}`);
      }

      // 2. The bid layer: a dialog with one text box for the max.
      const dialog = page.getByRole("dialog").first();
      const scope = (await dialog.count().catch(() => 0)) > 0 ? dialog : page;
      const input = scope.locator('input[type="text"], input[type="number"], input[type="tel"], input[inputmode="decimal"]').first();
      try {
        await input.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      } catch {
        const shot = await this.shot(page, `prepare-${tag}-2-layer`);
        throw new Error(`the bid layer drew no amount box — ${shot}\n       ${await this.controls(page)}`);
      }
      await input.fill("");
      await input.fill((cents / 100).toFixed(2));

      // 3. "Bid" / "Review bid" takes it to the review step, which is where
      //    the Confirm button lives. Some layers go straight to Confirm.
      const confirm = scope.getByRole("button", { name: /confirm bid/i }).first();
      const review = scope.getByRole("button", { name: /^(?:bid|review(?: bid)?|place bid|continue)$/i }).first();
      if ((await confirm.count().catch(() => 0)) === 0 || !(await confirm.isVisible().catch(() => false))) {
        try {
          await review.click({ timeout: STEP_TIMEOUT_MS });
        } catch {
          const shot = await this.shot(page, `prepare-${tag}-3-review`);
          throw new Error(`no Bid / Review bid button in the layer — ${shot}\n       ${await this.controls(page)}`);
        }
      }
      try {
        await confirm.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      } catch {
        const text = await this.bodyText(page);
        const shot = await this.shot(page, `prepare-${tag}-4-confirm`);
        const answer = readBidAnswer(text);
        if (answer === "refused") throw new Error(`the layer refused the amount before Confirm: ${text.replace(/\s+/g, " ").slice(0, 160)} — ${shot}`);
        throw new Error(`no Confirm bid button after the review step — ${shot}\n       ${await this.controls(page)}`);
      }
      await this.shot(page, `prepare-${tag}-ready`);
      return { row, cents, page, confirm, preparedAtMs: Date.now() };
    } catch (err) {
      this.open.delete(page);
      await page.close().catch(() => {});
      throw err;
    }
  }

  /** The one irreversible click. The amount is checked against the max once more, right before. */
  async confirm(prepared: PreparedBid): Promise<BidResult & { answer: BidAnswer; text: string }> {
    const { page, row, cents } = prepared;
    withinMax(cents, row);
    try {
      await prepared.confirm.click({ timeout: 5_000 });
      // The layer answers in place; give it a moment, then read the words.
      const deadline = Date.now() + CONFIRM_ANSWER_TIMEOUT_MS;
      let text = "";
      let answer: BidAnswer = "unknown";
      while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        text = await this.bodyText(page);
        answer = readBidAnswer(text);
        if (answer !== "unknown") break;
      }
      await this.shot(page, `confirm-${row.lot}`);
      const line = text.replace(/\s+/g, " ").slice(0, 200);
      if (answer === "refused") return { ok: false, error: line, blame: "lot", answer, text: line };
      if (answer === "ended") return { ok: false, error: "the listing had ended", blame: "lot", answer, text: line };
      return { ok: true, bidId: null, answer, text: line };
    } finally {
      this.open.delete(page);
      await page.close().catch(() => {});
    }
  }

  /** Lets a prepared bid go without confirming — the fire was called off. */
  async abandon(prepared: PreparedBid): Promise<void> {
    this.open.delete(prepared.page);
    await prepared.page.close().catch(() => {});
  }

  /** How a listing ended for this account, from its page. */
  async outcome(listingId: string): Promise<Outcome> {
    const page = await this.context.newPage();
    try {
      await page.goto(itemUrl(listingId), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      return readOutcome(await this.bodyText(page));
    } finally {
      await page.close().catch(() => {});
    }
  }
}

// ── Opening one ───────────────────────────────────────────────────────────────

/**
 * The signed-in browser. `login` puts a person at the keyboard; `account`
 * is the name eBay greets the account by, refused when the session is
 * someone else's; `live` says bids will be confirmed through it, which the
 * flow above is not yet trusted with; `rehearsal` opens it for a walk to
 * Confirm and nothing further.
 *
 * Headed by default: eBay serves a headless browser a different, often
 * blank, page, and the PC this runs on has a screen.
 */
export async function openEbay(opts: {
  headless?: boolean;
  login?: boolean;
  account?: string;
  live?: boolean;
  outDir: string;
  /**
   * A session exported from a signed-in machine, for a runner that has no
   * profile of its own: what --export-session prints. Used only when there is
   * no .ebay-session directory here already, so the PC keeps its own.
   */
  sessionState?: string;
}): Promise<EbaySession> {
  if (opts.live && !BID_FLOW_VERIFIED) {
    throw new Error(
      "eBay live bidding is switched off in code until the bid flow has been walked on a real listing: " +
      "run  npm run sniper:ebay -- --rehearse=<item number> --max=<dollars>  and read scripts/ebay-bidder.ts against what it found. " +
      "A plan (no --live) and --once still work.");
  }
  const dir = join(process.cwd(), SESSION_DIR);
  // A pasted session is seeded into a fresh profile rather than used as a
  // context of its own, so everything downstream — the bid flow, the
  // screenshots, the greeting check — works the one way.
  if (opts.sessionState && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    const seeded = await chromium.launchPersistentContext(dir, { headless: true });
    try {
      await seeded.addCookies(parseSessionState(opts.sessionState));
    } finally {
      await seeded.close();
    }
  }
  const context = await chromium.launchPersistentContext(dir, {
    headless: opts.headless ?? false,
    viewport: { width: 1400, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  const session = new EbaySession(context, page, opts.outDir);
  try {
    if (opts.login) {
      await context.clearCookies();
      await session.manualLogin();
    }
    const me = await session.whoAmI();
    if (!me.signedIn) {
      throw new Error(opts.sessionState
        ? "The pasted eBay session is not signed in. eBay ties a session to the machine it was made on as well as to the cookie, and one presented from somewhere else is often challenged — export a fresh one and try again, or run where you signed in."
        : "No eBay session. Sign in once with: npm run sniper:ebay -- --login");
    }
    const wanted = opts.account?.trim().toLowerCase() ?? "";
    if (wanted && !me.greeting.toLowerCase().includes(wanted)) {
      throw new Error(`--account asks for "${opts.account}", but eBay greets this session as "${me.greeting || "(no greeting found)"}". Sign in again with: npm run sniper:ebay -- --login`);
    }
    console.log(`    signed in to eBay${me.greeting ? ` as ${me.greeting}` : ""}`);
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

/**
 * The signed-in session, as one line to paste into a run or keep as a secret.
 *
 * Cookies only — no localStorage, no history — base64 so it survives a form
 * box and a shell. It is a way in to the account: treat it as the password it
 * stands for, and it lapses the way any eBay sign-in does.
 */
export async function exportSession(outDir: string): Promise<string> {
  const context = await chromium.launchPersistentContext(join(process.cwd(), SESSION_DIR), { headless: true });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const session = new EbaySession(context, page, outDir);
    const me = await session.whoAmI();
    if (!me.signedIn) throw new Error("This machine has no eBay session to export. Sign in first: npm run sniper:ebay -- --login");
    const cookies = (await context.cookies()).filter((c) => /(^|\.)ebay\.[a-z.]+$/i.test(c.domain.replace(/^\./, "")) || /ebay/i.test(c.domain));
    return Buffer.from(JSON.stringify(cookies)).toString("base64");
  } finally {
    await context.close();
  }
}

/** What exportSession printed, back into cookies. */
export function parseSessionState(text: string): Cookie[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("the eBay session is empty");
  let json: string;
  try {
    json = trimmed.startsWith("[") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    throw new Error("the eBay session is not what --export-session prints");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("the eBay session is not what --export-session prints");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("the eBay session carries no cookies");
  return parsed as Cookie[];
}

export { dollars };
