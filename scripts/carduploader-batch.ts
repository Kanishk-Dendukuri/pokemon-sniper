/**
 * Card Uploader — batch pricing run
 *
 * Drives the browser through the manual pricing loop: sign in, paste a batch of
 * cert numbers into Graded Cards, fill every price from Alt Value, and export
 * the eBay CSV into the run directory, where `npm run import:cards` picks it up
 * and turns it into inventory and valuations.
 *
 * Input is whatever `npm run price:export` wrote — one `<grader>-batch-NN.txt`
 * per 200 certs, which is Card Uploader's own cap.
 *
 * Credits are real money: 2 per PSA/CGC/TAG/ACE card, 1 per BGS. --dry-run
 * stops after pasting the certs, before the submit that spends them, so the
 * selectors can be exercised for free.
 *
 * The browser profile lives in .carduploader-session so a signed-in session
 * survives between runs. Fewer sign-ins is both faster and less likely to look
 * like a bot.
 *
 * Beside every CSV it also leaves the comps the batch was priced from —
 * comps.json, one entry per cert: Card Ladder's estimate, the last sale and
 * the recent sales behind the Alt Value. That is what lets the import hold a
 * price its own comps do not support. See scripts/carduploader-comps.ts.
 *
 * Every batch it creates is renamed in Previous Batches afterwards, and batches
 * older than four weeks are deleted — a daily run leaves 365 identically-named
 * "CGC" batches a year otherwise.
 *
 * Batches stand on their own: one that fails is captured (failure-<batch>.png)
 * and reported, and the rest still run. A grader the site's own banner says is
 * offline is skipped before any credits are spent. The exit code is non-zero
 * only for a failure on this side or a night that priced nothing.
 *
 * Usage:
 *   npm run price:fetch                          newest export, headless
 *   npm run price:fetch -- --headed              watch it work
 *   npm run price:fetch -- --dry-run --headed    no credits spent
 *   npm run price:fetch -- --dir=pricing-batches/2026-08-27_1913
 *   npm run price:fetch -- --price-source="Fill from CardLadder"
 *   npm run price:fetch -- --no-prune            keep old batches
 *   npm run price:fetch -- --prune-days=60       keep them longer
 *   npm run price:fetch -- --prune-all           also delete batches this did not create
 *
 * Required environment (read from .env.local or the real environment):
 *   CARDUPLOADER_EMAIL, CARDUPLOADER_PASSWORD
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { pathToFileURL } from "url";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { parseCsv } from "./ebay-csv";
import { COMPS_FILE, captureBearer, fetchJobComps, mergeComps, type Bearer } from "./carduploader-comps";

// ── Configuration ─────────────────────────────────────────────────────────────

export const BASE = "https://carduploader.com";
const GRADED_URL = `${BASE}/dashboard/graded`;
export const HISTORY_URL = `${BASE}/dashboard/history`;
export const SESSION_DIR = ".carduploader-session";

/**
 * Leads every batch name this script creates. It is also the safety catch on
 * pruning: without --prune-all only names carrying this prefix are eligible for
 * deletion, so a batch someone made by hand is never swept up by the cleanup.
 */
const BATCH_NAME_PREFIX = "Ripprz";

/** Batches older than this are deleted from Previous Batches after a run. */
const PRUNE_AFTER_DAYS = 28;

/**
 * How much of a batch must come back priced before the run counts as healthy.
 *
 * Below this the run exits non-zero so the workflow goes red. It is a coverage
 * alarm, not a data guard: the exported CSVs are still valid and still worth
 * importing, and cards Card Uploader simply has no Alt Value for are a normal
 * outcome. 50% is well under a good run (a healthy batch lands near 100%) and
 * well above the 3% that slipped through as a success.
 */
const MIN_PRICED_PCT = 50;

/** Card Uploader's own cap, shown as "CERTIFICATION NUMBERS — 0/200". */
export const MAX_CERTS_PER_BATCH = 200;

/**
 * Which "Price Source" the bulk price dialog uses.
 *
 * Alt Value runs above what cards actually clear for — one CGC 10 in the batch
 * history reads Alt $101.78 against a last eBay sale of $80 — so it is an ask,
 * not a realised price. "Fill from CardLadder" is the closer-to-sold option if
 * the buyback margin ever needs to come from the valuation rather than from
 * VAULT_BUYBACK_RATE.
 */
const DEFAULT_PRICE_SOURCE = "Fill from Alt Value";

/**
 * The price fill is retried while it is still making progress, not a fixed
 * number of times.
 *
 * Values arrive card by card from a lookup that outlives the batch load, so an
 * early fill prices only what has landed and every later pass picks up more. A
 * real run climbed 3 → 6 → 9 → 11 → 14 → 16 priced and was failed mid-climb by
 * a flat six-attempt cap, having thrown away a batch that was still filling in.
 *
 * What means "this is as good as it gets" is the count going still, so the loop
 * gives up only after this many passes in a row add nothing. The deadline is
 * the backstop: a source with genuinely no data for a card never improves, and
 * without a wall clock a large batch could retry all afternoon.
 *
 * The tail is how long the loop gets after the values are believed to be in.
 * A --batch-url recovery has no batch size to budget from and gets the flat
 * deadline instead.
 */
const PRICE_FILL_STALL_ATTEMPTS = 6;
const PRICE_FILL_TAIL_MS = 5 * 60 * 1000;
const PRICE_FILL_DEADLINE_MS = 15 * 60 * 1000;
const PRICE_FILL_BACKOFF_MS = 20_000;

/**
 * How long a batch's Alt Values may take to arrive.
 *
 * They land one at a time at a steady six or so a minute whatever the batch
 * size — the 2026-09-09 run watched 105 cards climb from 12 priced to 102 over
 * fifteen minutes, about one every 10s the whole way — so a flat wait either
 * strands a big batch or squanders most of a small one. Budgeting per card
 * fits both: 105 cards get 21 minutes, 200 get 40, a handful gets the floor.
 */
const VALUE_MS_PER_CARD = 12_000;
const VALUE_LOAD_FLOOR_MS = 5 * 60 * 1000;
const VALUE_POLL_MS = 5_000;
/**
 * Consecutive unchanged polls that count as "the values have stopped arriving".
 *
 * A minute, not the fifteen seconds it used to be. At one value every ~10s a
 * 15s lull is routine, and the wait returned on one two minutes into that same
 * run with 12 of 105 priced — leaving the fill loop to export the batch
 * twenty-six more times to collect the rest.
 */
const VALUE_STABLE_POLLS = 12;

export function valueBudgetMs(cards: number): number {
  return Math.max(VALUE_LOAD_FLOOR_MS, cards * VALUE_MS_PER_CARD);
}

/** A batch of 200 certs is 200 lookups against the grader's API. */
const BATCH_TIMEOUT_MS = 10 * 60 * 1000;
const CARD_POLL_MS = 2_000;
/**
 * Consecutive unchanged polls that count as "no more cards are coming".
 *
 * A cert the grader has no record of never resolves, so a batch holding one
 * sits one short of its count until the timeout. Waiting the full ten minutes
 * for a card that will never arrive costs the run an hour across a long queue.
 */
const CARD_STALL_POLLS = 15;

export function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function opt(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

// ── What the page says ────────────────────────────────────────────────────────

/** The grading companies Card Uploader's Graded Cards page offers. */
export const GRADERS = ["PSA", "CGC", "BGS", "TAG", "ACE"] as const;

/**
 * Which graders a page's text says are out of service, with the sentence that
 * says so.
 *
 * Card Uploader announces an outage as a banner over the dashboard — "PSA and
 * BGS listing are currently offline while we work on a fix" on 2026-09-09 —
 * and leaves the form underneath fully working: the tile selects, the certs
 * paste, and "Process PSA Cards" clicks and does nothing at all. That run sat
 * ten minutes waiting for a batch page that was never coming, then failed the
 * whole night over it, the finished CGC export included.
 *
 * Read line by line, so a grader has to be named in the same sentence as the
 * outage word: a card name or footer link elsewhere on the page cannot pair up
 * with it. Case-sensitive on the codes for the same reason — "ace" is a word,
 * "ACE" is a grader.
 */
export function offlineGraders(text: string): { grader: string; notice: string }[] {
  const outage = /\b(offline|unavailable|paused|suspended|out of service|not available)\b/i;
  const found = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!outage.test(line)) continue;
    for (const grader of GRADERS) {
      if (!found.has(grader) && new RegExp(`\\b${grader}\\b`).test(line)) found.set(grader, line);
    }
  }
  return [...found].map(([grader, notice]) => ({ grader, notice }));
}

/** The site says this grader is out of service: nothing to retry, no credits spent. */
export class GraderOfflineError extends Error {
  constructor(readonly grader: string, readonly notice: string) {
    super(`Card Uploader says ${grader} is offline: "${notice}"`);
    this.name = "GraderOfflineError";
  }
}

/**
 * A batch that exists — credits spent — but could not be taken further. Carries
 * the id so the run can still name it in Previous Batches, where an unnamed
 * "CGC" would otherwise sit outside the prune forever.
 */
export class BatchError extends Error {
  constructor(readonly batchId: string, message: string) {
    super(message);
    this.name = "BatchError";
  }
}

/** The page as a person sees it — what every "is it there yet" check reads. */
async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText).catch(() => "");
}

// ── Steps ─────────────────────────────────────────────────────────────────────

/**
 * The session usually survives in the browser profile, so most runs never touch
 * the credentials.
 *
 * The wait after submitting matches on pathname rather than the whole URL: the
 * sign-in page is `/signin?next=%2Fdashboard%2Fgraded`, so a naive /dashboard/
 * test passes while still sitting on the form, and navigating away on that false
 * positive aborts the login that was still in flight.
 */
export async function ensureLoggedIn(page: Page) {
  await page.goto(GRADED_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (!/\/signin/.test(new URL(page.url()).pathname)) {
    console.log("    already signed in");
    return;
  }

  const email = process.env.CARDUPLOADER_EMAIL;
  const password = process.env.CARDUPLOADER_PASSWORD;
  if (!email || !password) {
    throw new Error("CARDUPLOADER_EMAIL / CARDUPLOADER_PASSWORD are not set in .env.local");
  }

  console.log("    signing in");
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).first().click();

  await page.waitForURL((url) => !/\/signin/.test(url.pathname), { timeout: 60_000 });
  console.log("    signed in");
}

/**
 * One batch: paste the certs, wait for the cards to resolve, fill prices, and
 * export the eBay CSV. Returns the CSV and the batch's id, or null on a dry run.
 */
async function runBatch(
  page: Page,
  grader: string,
  certs: string[],
  priceSource: string,
  dryRun: boolean,
): Promise<{ id: string; csv: { name: string; content: string } | null } | null> {
  const id = await createBatch(page, grader, certs, dryRun);
  if (id === null) return null;
  try {
    return { id, csv: await priceAndExport(page, priceSource, certs.length) };
  } catch (err) {
    if (err instanceof BatchError) throw err;
    throw new BatchError(id, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Paste the certs, submit, and wait for every card to resolve. Returns the new
 * batch's id, or null on a dry run. Leaves the page on the batch itself so the
 * caller can go on to price it, export it, or read it.
 *
 * Split out of runBatch because the export is not the only thing worth doing
 * with a resolved batch — fanatics-sniper.ts reads each card's pricing straight
 * off the batch and never exports at all.
 */
export async function createBatch(
  page: Page,
  grader: string,
  certs: string[],
  dryRun: boolean,
  opts: { requireAll?: boolean } = {},
): Promise<string | null> {
  await page.goto(GRADED_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Before touching the form: the site's own word that this grader is down is
  // the one thing no amount of clicking gets past.
  const outage = offlineGraders(await bodyText(page)).find((o) => o.grader === grader);
  if (outage) throw new GraderOfflineError(grader, outage.notice);

  // Grading company. The five tiles are a proper ARIA radiogroup — role="radio"
  // on a <button> — not plain buttons, so a role: "button" locator matches
  // nothing and times out rather than erroring, which is what a broken run
  // looks like from here. Each tile's accessible name runs the code into the
  // full company name — "CGCCertified Guaranty Company". Mixing companies in
  // one batch is how a PSA comp gets priced onto a CGC slab, so it is always
  // set explicitly rather than inherited from the account's last selection —
  // seen mid-run as aria-checked="true" on whichever tile was picked last time.
  await clickThroughOverlays(page, page.getByRole("radio", { name: new RegExp(`^${grader}`) }).first(), `${grader} tile`);

  // The importer's COLUMN_MAP is keyed on this export's exact headers and throws
  // on anything else, so the format is pinned rather than assumed.
  const format = page.getByRole("combobox").filter({ hasText: /eBay|Shopify|Whatnot|Extras/i }).first();
  if (!/eBay Fixed Price/i.test((await format.textContent()) ?? "")) {
    await clickThroughOverlays(page, format, "Export Format");
    await clickThroughOverlays(page, page.getByRole("option", { name: "eBay Fixed Price" }).first(), "eBay Fixed Price");
  }

  await page.getByPlaceholder(/certification numbers/i).first().fill(certs.join("\n"));
  console.log(`    pasted ${certs.length} cert(s)`);

  if (dryRun) {
    console.log(`    ⏸  dry run — stopping before submit, no credits spent`);
    return null;
  }

  // The submit button names the selected company: "Process CGC Cards".
  await clickThroughOverlays(page, page.getByRole("button", { name: /^Process .*Cards$/i }).first(), "Process Cards");

  // Submitting spends credits and kicks off a per-cert lookup, so the wait is
  // long and keyed on landing in the batch history.
  await waitForBatchPage(page, grader);
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log(`    batch created: ${page.url()}`);

  const id = batchIdFromUrl(page.url());
  try {
    await waitForCards(page, certs.length, opts.requireAll ?? true);
  } catch (err) {
    throw new BatchError(id, err instanceof Error ? err.message : String(err));
  }

  return id;
}

/**
 * Waits for the submit to land on the new batch's page.
 *
 * Only that navigation means the batch exists, so it is what the wait is for —
 * but not blindly. The page also says when it is *not* going to happen: an
 * outage banner, or an error toast in place of the redirect. Either ends the
 * wait at once with the page's own words, instead of ten minutes later with a
 * timeout that names neither. The toast is only read while the form is still
 * up; once the batch page loads, whatever it says is about work already done.
 */
async function waitForBatchPage(page: Page, grader: string) {
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  const refusal = /\b(error|failed|invalid|insufficient|not enough|offline|unavailable)\b/i;

  while (Date.now() < deadline) {
    if (/\/history\/graded\//.test(page.url())) return;

    const toast = await page
      .evaluate(() => document.querySelector("#_rht_toaster")?.textContent ?? "")
      .catch(() => "");
    if (refusal.test(toast)) {
      throw new Error(`Card Uploader refused the batch: "${toast.trim().slice(0, 160)}"`);
    }

    const outage = offlineGraders(await bodyText(page)).find((o) => o.grader === grader);
    if (outage) throw new GraderOfflineError(grader, outage.notice);

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `No batch page within ${BATCH_TIMEOUT_MS / 60_000} minutes of submitting — still on ${page.url()}. ` +
    `Card Uploader took the click but never created the batch.`);
}

/** The trailing id of /dashboard/history/graded/<id> — how a batch is addressed. */
export function batchIdFromUrl(url: string): string {
  const match = /\/history\/graded\/([^/?#]+)/.exec(url);
  if (!match) throw new Error(`Not a batch URL: ${url}`);
  return match[1];
}

/**
 * Blocks until every cert in the batch has resolved into a card.
 *
 * Landing on the history URL only means the batch exists — the cards populate
 * asynchronously behind it. Pricing before they finish applies "Apply to All
 * Cards" to however many happen to be loaded, which is how a 40-cert batch came
 * back with one priced card and thirty-nine blanks.
 *
 * That is why `requireAll` defaults to on. It is a real gate for the export
 * path, where the price is applied to the batch as a whole and a missing card
 * silently exports blank. A caller that reads each cert's price individually —
 * fanatics-sniper.ts — has nothing to lose from a cert that never resolves, so
 * it passes false: the count going quiet ends the wait and the run carries on
 * with however many cards the grader could find.
 *
 * Returns the number of cards that resolved.
 */
async function waitForCards(page: Page, expected: number, requireAll = true): Promise<number> {
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  let seen = 0;
  let quiet = 0;

  while (Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const match = /Total Cards\s*(\d+)/i.exec(document.body.innerText);
      return match ? Number(match[1]) : 0;
    });
    if (now >= expected) {
      console.log(`    ${now} card(s) resolved`);
      return now;
    }
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;

    if (!requireAll && seen > 0 && quiet >= CARD_STALL_POLLS) {
      console.warn(`    ⚠️  ${expected - seen} of ${expected} cert(s) never resolved — carrying on with ${seen}`);
      return seen;
    }
    await page.waitForTimeout(CARD_POLL_MS);
  }

  if (!requireAll && seen > 0) {
    console.warn(`    ⚠️  ${expected - seen} of ${expected} cert(s) never resolved — carrying on with ${seen}`);
    return seen;
  }

  throw new Error(
    `Only ${seen} of ${expected} cert(s) resolved into cards before the timeout. ` +
    `Pricing now would leave the rest blank.`);
}

/** The batch header's three aggregates: card count, priced total, value total. */
async function batchTotals(page: Page) {
  // Text out, parsing here. A helper defined inside page.evaluate gets
  // instrumented by esbuild's keepNames and dies in the browser with
  // "__name is not defined".
  const text = await page.evaluate(() => document.body.innerText);
  const num = (re: RegExp) => {
    const match = re.exec(text);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  };

  return {
    cards: num(/Total Cards\s*([\d,]+)/i),
    price: num(/\bPrice\s*\$([\d,.]+)/i),
    estValue: num(/Est\.?\s*Value\s*\$([\d,.]+)/i),
  };
}

/**
 * Waits until every card's Alt Value has arrived.
 *
 * A card resolves from its cert well before its value does — separate fetches —
 * and the batch page renders one card at a time, so nothing on screen lists the
 * per-card state. The header's "Est. Value" is the sum of the values that have
 * landed, so it climbs while they stream in and goes quiet when they are done.
 *
 * Equality between Price and Est. Value is not enough on its own: mid-load both
 * are partial and agree with each other. Only the total going still means the
 * batch is fully loaded.
 */
async function waitForValues(page: Page, expected: number, deadline: number): Promise<number> {
  const started = Date.now();
  let last: number | null = null;
  let stable = 0;

  while (Date.now() < deadline) {
    const { cards, estValue } = await batchTotals(page);

    if (cards === expected && estValue !== null && estValue > 0 && estValue === last) {
      if (++stable >= VALUE_STABLE_POLLS) {
        console.log(`    values in after ${Math.round((Date.now() - started) / 1000)}s (Est. Value $${estValue})`);
        return estValue;
      }
    } else {
      stable = 0;
    }

    last = estValue;
    await page.waitForTimeout(VALUE_POLL_MS);
  }

  throw new Error(
    `Card values were still arriving after ${Math.round((Date.now() - started) / 60_000)} minutes ` +
    `(Est. Value last read $${last ?? 0}). Pricing now would leave cards blank.`);
}

/**
 * Waits for any toast to clear.
 *
 * Success toasts stack over the toolbar and swallow the next click — the retry
 * pass fails on "Bulk Edit" with the toaster subtree intercepting pointer
 * events. They auto-dismiss, so waiting is enough; tearing them out of the DOM
 * would fight React for no gain.
 */
async function waitForToasts(page: Page) {
  const clear = await page.waitForFunction(
    () => (document.querySelector("#_rht_toaster")?.childElementCount ?? 0) === 0,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false);
  if (clear) return;

  // Waiting is not enough when the toasts never stop. Card Uploader raises one
  // per card as prices stream in, so during a large batch the toaster is never
  // empty for 15 consecutive seconds — the wait above times out, the click goes
  // ahead into a toast that is still covering Bulk Edit, and Playwright refuses
  // it for another 30s with "#_rht_toaster subtree intercepts pointer events".
  //
  // That is what cost a 103-cert run every retry it had: six consecutive
  // timeouts, then the loop kept its one early export of 3 priced cards and
  // reported success.
  //
  // Emptying the container is safe. react-hot-toast owns the nodes inside it,
  // not the container, and re-renders into it as new toasts arrive; the ones
  // removed here are notifications about work that already happened.
  await page.evaluate(() => {
    const toaster = document.querySelector("#_rht_toaster");
    if (toaster) toaster.replaceChildren();
  }).catch(() => {});
}

/**
 * How often each recovery step had to save a click, for the run summary.
 *
 * The point is not the count, it is the trend. Every one of these is a
 * workaround for something Card Uploader's UI does to us, and the set has been
 * growing: toasts since August, a stray dialog in September, an unclosing price
 * dialog after that. A step that starts firing on every click is the earliest
 * signal their page changed shape again — earlier than a failed run, because
 * the recovery is still succeeding at that point.
 */
const recoveries = new Map<string, number>();
function noteRecovery(step: string) {
  recoveries.set(step, (recoveries.get(step) ?? 0) + 1);
}

export function recoverySummary(): string | null {
  if (recoveries.size === 0) return null;
  return [...recoveries.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([step, n]) => `${step} ×${n}`)
    .join(", ");
}

/**
 * Clicks something, working through everything the page puts in the way.
 *
 * One ladder instead of a workaround per button. Each rung handles a failure we
 * have actually hit, cheapest first, and stops as soon as the click lands:
 *
 *   1. plain click, after sweeping toasts
 *   2. forced click — skips the actionability check a transient toast fails,
 *      which is right when the element itself is visible and enabled
 *   3. dispatch the event in the page — the last resort for a target that
 *      Playwright can see but cannot reach
 *
 * Only overlay-shaped failures are retried. A locator that matches nothing
 * because a button was renamed is a real break and has to surface as one
 * rather than be buried under four attempts.
 */
async function clickThroughOverlays(page: Page, locator: Locator, label: string) {
  const overlayish = (err: unknown) =>
    /intercepts pointer events|not visible|element is not|timeout|detached|not stable/i
      .test(err instanceof Error ? err.message : String(err));

  await waitForToasts(page);

  // Every rung must be safe to try on any target, because this runs on all of
  // them. Dismissing a modal deliberately is NOT on the ladder: "Apply to All
  // Cards" lives inside the price dialog, so pressing Escape to clear the way
  // deletes the button being reached for, and the rungs below it then fail
  // against something that no longer exists. Closing a stray dialog is a real
  // recovery, but only where the caller knows the target is not inside it —
  // which is why closeStrayDialog stays an explicit call at those two sites.
  const rungs: [string, () => Promise<void>][] = [
    ["plain", async () => { await locator.click({ timeout: 10_000 }); }],
    ["force", async () => {
      await waitForToasts(page);
      await locator.click({ force: true, timeout: 10_000 });
    }],
    ["dispatch", async () => {
      await locator.dispatchEvent("click", undefined, { timeout: 10_000 });
    }],
  ];

  let last: unknown;
  for (const [step, attempt] of rungs) {
    try {
      await attempt();
      if (step !== "plain") {
        noteRecovery(step);
        console.warn(`    ⚠️  ${label} needed "${step}"`);
      }
      return;
    } catch (err) {
      last = err;
      if (!overlayish(err)) throw err;
    }
  }

  throw new Error(
    `${label} could not be clicked after every recovery step. ` +
    `Card Uploader's page has probably changed shape.\n` +
    `Last error: ${last instanceof Error ? last.message.split("\n")[0] : last}`);
}

/**
 * A previous attempt that failed partway through leaves "Set Price for All
 * Cards" open — its backdrop then covers Bulk Edit, so every retry burns its
 * own 30s timeout on a button it can never reach and the loop's error is
 * always "Bulk Edit" rather than whatever actually went wrong. Idempotent: a
 * no-op when nothing is open.
 */
async function closeStrayDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  if (await dialog.count() === 0) return;
  await page.keyboard.press("Escape").catch(() => {});
  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

/** Bulk Edit → Prices → <source> → Apply to All Cards. */
async function applyPriceSource(page: Page, priceSource: string, expected?: number) {
  await waitForToasts(page);
  await closeStrayDialog(page);
  await clickThroughOverlays(page, page.getByRole("button", { name: /bulk edit/i }).first(), "Bulk Edit");
  await clickThroughOverlays(page, page.getByRole("menuitem", { name: /^prices$/i }).first(), "Prices");
  await page.getByRole("dialog").waitFor({ timeout: 30_000 });

  const scope = await page.getByRole("dialog").textContent();
  const stated = Number(/for all (\d+) cards?/i.exec(scope ?? "")?.[1] ?? 0);
  if (expected !== undefined && stated > 0 && stated < expected) {
    throw new Error(
      `Price dialog covers only ${stated} of ${expected} card(s) — the batch is still loading.`,
    );
  }

  const priceSelect = page
    .getByRole("dialog")
    .getByRole("combobox")
    .first();

  // The page keeps re-rendering while price data streams in behind the dialog,
  // which can tear down and remount this trigger right after it opens — the
  // click lands, aria-expanded flips back to false, and the option this is
  // about to look for never appears. Confirm the menu is actually open before
  // trusting it, and retry the click rather than waiting 30s for an option
  // that was never going to render.
  const option = page.getByRole("option", { name: priceSource, exact: true });
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await clickThroughOverlays(page, priceSelect, "price source dropdown");
    opened = await option
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!opened) {
    throw new Error(`Price source option "${priceSource}" did not appear after opening the dropdown.`);
  }

  await clickThroughOverlays(page, option, `"${priceSource}" option`);

  await clickThroughOverlays(page, page.getByRole("button", { name: /apply to all cards/i }).first(), "Apply to All Cards");

  // A dialog left open is not cosmetic. Radix marks everything behind a modal
  // aria-hidden, so Bulk Edit and List / Export leave the accessibility tree
  // entirely and getByRole finds no element at all — which surfaces as "waiting
  // for locator" rather than as anything mentioning a dialog, and is how the
  // export step started timing out on a button that was plainly on screen.
  const closed = await page.getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 60_000 })
    .then(() => true).catch(() => false);
  if (!closed) {
    console.warn(`    ⚠️  price dialog stayed open — closing it`);
    await closeStrayDialog(page);
  }
}

/**
 * Price and export the batch the page is already sitting on.
 *
 * Split out from runBatch so a batch that was paid for but failed to export can
 * be recovered with --batch-url instead of spending the credits again.
 */
async function priceAndExport(
  page: Page,
  priceSource: string,
  expected?: number,
): Promise<{ name: string; content: string } | null> {
  // One clock for the whole batch: the values get their per-card budget, the
  // fill loop gets the tail after it. Sized from the batch, because a 200-card
  // batch genuinely takes forty minutes to value and a flat quarter-hour left
  // half of it blank — to be re-selected and paid for again the next night.
  const started = Date.now();
  const deadline = started + (expected !== undefined
    ? valueBudgetMs(expected) + PRICE_FILL_TAIL_MS
    : PRICE_FILL_DEADLINE_MS);

  // Fast path: wait for the values to stop arriving before filling, so the
  // usual run fills once and exports once instead of exporting repeatedly to
  // find out. Deliberately not load-bearing — it reads header labels, and if
  // Card Uploader renames one this must degrade to the slow path rather than
  // fail a batch that would have exported fine.
  if (expected !== undefined) {
    try {
      await waitForValues(page, expected, deadline - PRICE_FILL_TAIL_MS);
    } catch (err) {
      console.warn(`    ⚠️  ${err instanceof Error ? err.message : err}`);
      console.warn(`    falling back to fill-and-check against the export`);
    }
  }

  // The authority. The exported CSV is the artifact that reaches the database
  // and is the only thing that cannot be wrong about its own contents, so the
  // retry loop is driven by it — the wait above only decides how many times
  // this is expected to go round.
  let file: { name: string; content: string } | null = null;

  // Fewest blanks any pass has managed. Compared against strictly, so a pass
  // that prices nothing new counts as stalled even if it priced a lot overall —
  // "still climbing" is the only thing that buys another attempt.
  let fewestBlanks = Infinity;
  let stalled = 0;
  let attempt = 0;

  for (;;) {
    attempt++;

    // A stale-dialog hiccup (see applyPriceSource) is exactly the kind of
    // transient failure this loop already retries for — losing the whole
    // batch to one bad pass, after values were already confirmed still
    // arriving above, would throw away real progress. Only a pass that never
    // recovers before the deadline should end the run.
    let counted: { rows: number; blanks: number };
    try {
      await applyPriceSource(page, priceSource, expected);
      file = await exportCsv(page);
      counted = countBlankPrices(file);
    } catch (err) {
      stalled++;
      // A stuck dialog recovers in one retry; a batch with no price data
      // anywhere in the source never will. Bounding this on the same stall
      // count as the blanks path below means a structurally broken pass fails
      // in minutes instead of grinding out the full deadline to say the same
      // thing.
      const giveUp = Date.now() >= deadline || stalled >= PRICE_FILL_STALL_ATTEMPTS;
      if (!giveUp) {
        console.warn(`    ⚠️  ${err instanceof Error ? err.message : err} — retrying`);
        continue;
      }
      // No pricing data is a normal outcome, not a pipeline failure — the slab
      // is already in inventory_item (import-cards.ts inserts it regardless of
      // price) and shows up in /admin/pricing on its own. A card whose Alt
      // Value / CardLadder data genuinely does not exist can render this
      // dialog without the source picker at all, so a pass can fail here
      // without ever producing a CSV — that is still not worth crashing the
      // rest of the run over. A prior successful pass in this same loop is
      // better than nothing, so it wins over giving up empty-handed.
      console.warn(`    ⚠️  ${err instanceof Error ? err.message : err}`);
      if (file) {
        // Say what is actually in the export being kept. Reporting only
        // "keeping the last successful export" is how a batch that priced 3 of
        // 103 cards left a green run: the blanks warning below lives on the
        // other exit path and never ran.
        const kept = countBlankPrices(file);
        console.warn(
          `    keeping the last successful export — ${kept.rows - kept.blanks}/${kept.rows} priced` +
          (kept.blanks > 0 ? `, ${kept.blanks} still blank and needing manual pricing` : ""));
      } else {
        console.warn(`    no price ever loaded for this batch — needs manual pricing`);
      }
      return file;
    }
    const { rows, blanks } = counted;

    if (blanks < fewestBlanks) {
      fewestBlanks = blanks;
      stalled = 0;
    } else {
      stalled++;
    }

    const outOfTime = Date.now() >= deadline;
    const done = blanks === 0 || stalled >= PRICE_FILL_STALL_ATTEMPTS || outOfTime;

    console.log(
      `    applied "${priceSource}" — ${rows - blanks}/${rows} priced` +
      (done ? "" : stalled > 0
        ? `, no gain (${stalled}/${PRICE_FILL_STALL_ATTEMPTS}), retrying`
        : `, retrying`));

    if (blanks === 0) return file;

    if (done) {
      const why = outOfTime
        ? `after ${Math.round((Date.now() - started) / 60_000)} minutes of waiting and retries`
        : `after ${PRICE_FILL_STALL_ATTEMPTS} passes that priced nothing new (${attempt} in total)`;
      // No pricing data is not a reason to fail the batch: the slab is already
      // in inventory_item either way, and a blank price here just means it
      // shows up in /admin/pricing for a human instead of being priced
      // automatically. Failing the run bought nothing a warning does not.
      console.warn(`    ⚠️  ${blanks} of ${rows} card(s) exported without a price ${why} — needs manual pricing`);
      return file;
    }

    // Give the outstanding value lookups time to land before filling again.
    await page.waitForTimeout(PRICE_FILL_BACKOFF_MS);
  }
}

/** Counts rows in a downloaded export whose *StartPrice cell is empty. */
function countBlankPrices(file: { name: string; content: string }) {
  const { columns, rows } = parseCsv(file.content, file.name);
  const priceIdx = columns.indexOf("start_price");
  if (priceIdx === -1) return { rows: rows.length, blanks: 0 };
  return {
    rows: rows.length,
    blanks: rows.filter((r) => r[priceIdx] === null || r[priceIdx] === "").length,
  };
}

/** Select All, then List / Export → Export CSV → Export eBay. */
async function exportCsv(page: Page): Promise<{ name: string; content: string }> {
  await waitForToasts(page);
  // Cheap insurance for the same aria-hidden trap: whatever this is called
  // after, the export controls have to be reachable.
  await closeStrayDialog(page);

  // Export acts on the selection, and a fresh batch starts with none — with
  // "0 selected" the menu item is a no-op rather than an error.
  //
  // Idempotent on purpose: the retry pass arrives with everything already
  // selected, and the menu offers "Deselect All" then, so blindly clicking
  // "Select All" a second time waits forever for an item that is not there.
  const selected = await page.evaluate(() =>
    Number(/(\d+) selected/.exec(document.body.innerText)?.[1] ?? 0));

  if (selected === 0) {
    await clickThroughOverlays(page, page.getByRole("button", { name: /select cards/i }).first(), "Select Cards");
    await clickThroughOverlays(page, page.getByText("Select All", { exact: true }).first(), "Select All");
    await page.keyboard.press("Escape").catch(() => {});
    console.log(`    selected all cards`);
  }

  // "Export CSV" is a submenu, not an action — the download sits one level
  // deeper under the config it exports for. Clicking the parent only opens it,
  // which looks exactly like a hang if you are waiting on a download.
  //
  // The warnings panel above these items (missing postal code, unset eBay
  // policies) is advisory. It does not block the CSV, and the config links in
  // it get prefetched when the menu renders, which is misleading to watch.
  await clickThroughOverlays(page, page.getByRole("button", { name: /list ?\/ ?export/i }).first(), "List / Export");

  // The submenu is driven by keyboard, not clicked through. Clicking the item
  // inside makes Playwright jump the pointer straight there — which leaves the
  // trigger, closes the submenu, and detaches the element mid-click
  // ("<html> intercepts pointer events").
  //
  // focus() rather than hover(): hovering only sets Radix's highlight, and
  // whether DOM focus follows is a race that a slow runner loses. Without focus
  // on the trigger the arrow keys go nowhere and the download never fires.
  const csvTrigger = page.getByRole("menuitem", { name: /export csv/i }).first();
  const exportEbay = page.getByRole("menuitem", { name: /export ebay/i }).first();

  await csvTrigger.focus();
  await page.keyboard.press("ArrowRight");
  await exportEbay.waitFor({ timeout: 15_000 });

  // Radix moves focus onto the first submenu item when it opens, but confirm it
  // landed rather than assuming — pressing Enter on the wrong item silently
  // does something else entirely.
  for (let attempt = 0; attempt < 4; attempt++) {
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    if (/export ebay/i.test(focused)) break;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
  }

  const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
  if (!/export ebay/i.test(focused)) {
    throw new Error(
      `Could not put keyboard focus on "Export eBay" — focus sat on "${focused.trim().slice(0, 60)}". ` +
      `The export menu has probably changed shape.`);
  }

  // Armed immediately before the keypress that fires it. Left pending if that
  // throws, and an unhandled rejection here would crash the process and mask
  // the error that actually stopped the run.
  const download = page.waitForEvent("download", { timeout: 120_000 });
  download.catch(() => {});

  await page.keyboard.press("Enter");
  const file = await download;

  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);

  return { name: file.suggestedFilename(), content: Buffer.concat(chunks).toString("utf-8") };
}

// ── Previous Batches housekeeping ─────────────────────────────────────────────

/**
 * The run's calendar day in Pacific time.
 *
 * The schedule is expressed in Pacific ("2am PST") but GitHub only runs cron in
 * UTC, so a run that fires at 10:00 UTC is already tomorrow by the runner's
 * clock. Naming batches by the UTC day would put every run under the wrong date
 * and make "older than four weeks" measure a day out.
 */
export function pstDate(now: Date): string {
  // en-CA gives ISO order (2026-08-28) without hand-assembling parts.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** e.g. "Ripprz 2026-08-28 CGC 2/3 (200 cards)". */
export function batchName(opts: {
  prefix?: string; date: string; grader: string;
  index: number; total: number; cards: number;
}): string {
  const prefix = opts.prefix ?? BATCH_NAME_PREFIX;
  return `${prefix} ${opts.date} ${opts.grader} ${opts.index}/${opts.total} (${opts.cards} cards)`;
}

/** The date this script stamped into a batch name, if it is one of ours. */
export function dateFromBatchName(name: string, prefix = BATCH_NAME_PREFIX): string | null {
  const match = new RegExp(`^${prefix}\\s+(\\d{4}-\\d{2}-\\d{2})\\b`).exec(name.trim());
  return match ? match[1] : null;
}

/** The M/D/YYYY the batch card shows, as a UTC-midnight date. */
export function parseCardDate(text: string): Date | null {
  const match = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (!match) return null;
  const [, m, d, y] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export type BatchCard = { id: string; name: string; cardText: string };

/**
 * Which batches the cleanup should delete.
 *
 * Deleting a batch also deletes its cards from Card Uploader's inventory, so by
 * default this only touches names this script wrote: batches created by hand
 * are somebody's records, and they are indistinguishable from ours by age alone.
 * --prune-all drops that guard and goes purely on the date the card shows.
 */
export function pruneTargets(
  batches: BatchCard[], now: Date, days: number, all: boolean, prefix = BATCH_NAME_PREFIX,
): BatchCard[] {
  const cutoff = now.getTime() - days * 86_400_000;

  return batches.filter((batch) => {
    const stamped = dateFromBatchName(batch.name, prefix);
    if (stamped === null && !all) return false;

    // The name's own date is authoritative when it has one: Card Uploader shows
    // the date the batch was created, and the two agree, but a name we wrote is
    // not subject to whatever the card's date column means next release.
    const when = stamped !== null
      ? new Date(`${stamped}T00:00:00Z`)
      : parseCardDate(batch.cardText);

    // No readable date is not a licence to delete.
    return when !== null && when.getTime() < cutoff;
  });
}

/** Every batch on the history page, with the id each one is addressed by. */
export async function listBatches(page: Page): Promise<BatchCard[]> {
  await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // A year of daily runs is more batches than one screen holds, and a list that
  // stops loading at the fold would silently never prune the oldest ones.
  let seen = -1;
  for (let i = 0; i < 40; i++) {
    const count = await page.locator('a[href^="/dashboard/history/graded/"]').count();
    if (count === seen) break;
    seen = count;
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(700);
  }

  const raw = await page.evaluate(() => {
    const cards: { href: string; lines: string[] }[] = [];
    document.querySelectorAll('a[href^="/dashboard/history/graded/"]').forEach((anchor) => {
      let node = anchor.parentElement;
      for (let i = 0; i < 8 && node; i++) {
        if (node.querySelector('button[aria-label="Batch actions"]')) break;
        node = node.parentElement;
      }
      if (!node) return;
      cards.push({
        href: anchor.getAttribute("href") ?? "",
        lines: node.innerText.split("\n").map((line) => line.trim()).filter(Boolean),
      });
    });
    return cards;
  });

  return raw.map(({ href, lines }) => ({
    id: batchIdFromUrl(href),
    // "Graded — CGC" / the name / "$2,456.73" / "56 cards·8/25/2026" / "View".
    // The name is the only line that is none of those.
    name: lines.find((line) =>
      !/^Graded\s*[—-]/.test(line) && !line.startsWith("$") &&
      !/^\d[\d,]*\s+cards?\b/.test(line) && line !== "View") ?? "",
    cardText: lines.join(" "),
  }));
}

/** The card on the history page for one batch id. */
function batchCard(page: Page, id: string) {
  return page
    .locator(`a[href="/dashboard/history/graded/${id}"]`)
    .locator('xpath=ancestor::*[.//button[@aria-label="Batch actions"]][1]')
    .first();
}

/** Opens a batch card's ⋮ menu and picks an item. */
async function batchAction(page: Page, id: string, item: RegExp) {
  await waitForToasts(page);
  await clickThroughOverlays(page, batchCard(page, id).getByLabel("Batch actions").first(), "Batch actions");
  await clickThroughOverlays(page, page.getByRole("menuitem", { name: item }).first(), "batch menu item");
}

/**
 * Rename is an inline input on the card, not a dialog — the title is swapped for
 * a focused text box pre-filled with the current name, and Enter commits it.
 */
export async function renameBatch(page: Page, id: string, name: string) {
  await batchAction(page, id, /^rename$/i);

  const input = page.getByPlaceholder("Enter job name").first();
  await input.waitFor({ timeout: 15_000 });
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
}

/** Delete, then confirm — the dialog warns it takes the batch's cards with it. */
export async function deleteBatch(page: Page, id: string) {
  await batchAction(page, id, /^delete$/i);

  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 15_000 });
  await clickThroughOverlays(page, dialog.getByRole("button", { name: /^delete$/i }).first(), "Delete");
  await dialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
}

/**
 * Names the batches this run created, then deletes the ones that have aged out.
 *
 * Card Uploader names a batch after its grading company, so a daily run leaves a
 * wall of batches all called "CGC" and no way to tell which run each came from.
 */
async function tidyHistory(
  page: Page,
  ran: { id: string; grader: string; cards: number }[],
  opts: { prefix: string; prune: boolean; pruneDays: number; pruneAll: boolean },
) {
  const date = pstDate(new Date());

  for (const [i, batch] of ran.entries()) {
    const name = batchName({
      prefix: opts.prefix, date, grader: batch.grader,
      index: i + 1, total: ran.length, cards: batch.cards,
    });
    await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await renameBatch(page, batch.id, name);
    console.log(`    renamed  ${name}`);
  }

  if (!opts.prune) return;

  const stale = pruneTargets(
    await listBatches(page), new Date(), opts.pruneDays, opts.pruneAll, opts.prefix);

  if (stale.length === 0) {
    console.log(`    no batches older than ${opts.pruneDays} days`);
    return;
  }

  for (const batch of stale) {
    await deleteBatch(page, batch.id);
    console.log(`    deleted  ${batch.name}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Newest run directory under pricing-batches/, by name — the stamp sorts. */
function newestBatchDir(root: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return dirs.length > 0 ? join(root, dirs[dirs.length - 1]) : null;
}

async function main() {
  loadEnvLocal();

  const dryRun = process.argv.includes("--dry-run");
  const headed = process.argv.includes("--headed");

  const priceSource = opt("price-source", DEFAULT_PRICE_SOURCE);

  const namePrefix = opt("name-prefix", BATCH_NAME_PREFIX);
  const prune = !process.argv.includes("--no-prune");
  const pruneDays = Number(opt("prune-days", String(PRUNE_AFTER_DAYS)));
  const pruneAll = process.argv.includes("--prune-all");

  const explicitDir = opt("dir", "");
  const dir = explicitDir || newestBatchDir(opt("out", "pricing-batches"));
  if (!dir || !existsSync(dir)) {
    // An empty run is the normal outcome when every cohort is already current:
    // price:export writes no directory at all, and that is success, not failure.
    // A --dir the caller named by hand is different — that one has to exist.
    if (explicitDir) {
      console.error(`❌  No such batch directory: ${explicitDir}`);
      process.exit(1);
    }
    console.log("✅  No batches to price — every cohort is current.");
    return;
  }

  // Recovery: a batch that was already paid for but never exported. Skips the
  // paste and the submit, so it costs nothing to retry.
  const batchUrl = opt("batch-url", "");

  const batches = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  if (batches.length === 0) {
    console.error(`❌  No batch files in ${dir}`);
    process.exit(1);
  }

  console.log(`🃏  Card Uploader batch run${dryRun ? "  (dry run — no credits spent)" : ""}\n`);
  console.log(`    batches      ${dir} (${batches.length} file(s))`);
  console.log(`    price source ${priceSource}`);
  console.log(`    cleanup      ${prune
    ? `delete ${pruneAll ? "any batch" : `"${namePrefix} …" batches`} older than ${pruneDays}d`
    : "off"}\n`);

  const context: BrowserContext = await chromium.launchPersistentContext(
    join(process.cwd(), SESSION_DIR),
    { headless: !headed, acceptDownloads: true, viewport: { width: 1600, height: 1000 } },
  );
  const page = context.pages()[0] ?? await context.newPage();
  // Attached before the first navigation: the backend's bearer is only ever
  // seen in flight, on the dashboard's own requests.
  const bearer = captureBearer(page, BASE);

  const produced: { name: string; content: string }[] = [];
  const ran: { id: string; grader: string; cards: number }[] = [];
  const outcomes: BatchOutcome[] = [];

  try {
    await ensureLoggedIn(page);

    if (batchUrl) {
      console.log(`  ── recovering ${batchUrl}`);
      await page.goto(batchUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const csv = await priceAndExport(page, priceSource);
      if (csv) {
        writeFileSync(join(dir, csv.name), csv.content);
        console.log(`    saved ${csv.name}`);
        produced.push(csv);
        const comps = await saveComps(page, bearer, batchIdFromUrl(batchUrl), dir);
        outcomes.push({ batch: batchUrl, status: "priced", note: pricedNote(csv) + compsNote(comps) });
      } else {
        console.warn(`    ⚠️  no pricing data available — cards are already in inventory, needs /admin/pricing`);
        outcomes.push({ batch: batchUrl, status: "unpriced", note: "no pricing data" });
      }
    }

    for (const batch of batchUrl ? [] : batches) {
      // psa-batch-01.txt / cgc-batch-02.txt — the grader is the leading token.
      const grader = basename(batch).split("-")[0].toUpperCase();
      const certs = readFileSync(join(dir, batch), "utf-8")
        .split("\n").map((c) => c.trim()).filter(Boolean);

      if (certs.length > MAX_CERTS_PER_BATCH) {
        throw new Error(
          `${batch} holds ${certs.length} certs; Card Uploader caps a batch at ${MAX_CERTS_PER_BATCH}.`);
      }

      console.log(`  ── ${batch}  (${grader}, ${certs.length} cert(s))`);

      // One batch must not take the night with it. The PSA batch that never
      // submitted — PSA was offline at Card Uploader — threw out of here and
      // took the finished CGC export down with it: the CSV was on disk, the
      // import step never ran. Each batch now stands or falls on its own, and
      // the run reports every one of them at the end.
      try {
        const result = await runBatch(page, grader, certs, priceSource, dryRun);
        if (!result) continue;

        // The batch was created and credits were spent either way, so it still
        // gets renamed/pruned below even when no CSV came out of it.
        ran.push({ id: result.id, grader, cards: certs.length });
        if (result.csv) {
          writeFileSync(join(dir, result.csv.name), result.csv.content);
          console.log(`    saved ${result.csv.name}`);
          produced.push(result.csv);
          const comps = await saveComps(page, bearer, result.id, dir);
          outcomes.push({ batch, status: "priced", note: pricedNote(result.csv) + compsNote(comps) });
        } else {
          console.warn(`    ⚠️  no pricing data available — cards are already in inventory, needs /admin/pricing`);
          outcomes.push({ batch, status: "unpriced", note: "no pricing data" });
        }
      } catch (err) {
        if (err instanceof BatchError) ran.push({ id: err.batchId, grader, cards: certs.length });

        if (err instanceof GraderOfflineError) {
          console.warn(`    ⚠️  skipped — ${err.message}`);
          outcomes.push({ batch, status: "skipped", note: `${grader} offline at Card Uploader — "${err.notice}"` });
          continue;
        }

        const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
        console.error(`    ❌  ${batch} failed: ${reason}`);
        await captureFailure(page, dir, `failure-${basename(batch, ".txt")}`);
        outcomes.push({ batch, status: "failed", note: reason });
      }
    }

    // Cosmetic, and deliberately after the CSVs are on disk: a naming or
    // cleanup failure must not fail a run whose prices are already exported.
    if (ran.length > 0) {
      console.log(`\n  ── tidying Previous Batches`);
      try {
        await tidyHistory(page, ran, { prefix: namePrefix, prune, pruneDays, pruneAll });
      } catch (err) {
        console.warn(`    ⚠️  could not tidy history: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    await captureFailure(page, dir, "failure");
    throw err;
  } finally {
    await context.close();
  }

  const skipped = outcomes.filter((o) => o.status === "skipped");
  const failed = outcomes.filter((o) => o.status === "failed");

  if (dryRun) {
    for (const o of skipped) console.warn(`    ⚠️  ${o.batch} skipped — ${o.note}`);
    if (failed.length > 0) {
      console.error(`\n❌  Dry run: ${failed.length} batch(es) never reached the cert box — see failure-*.png in ${dir}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n✅  Dry run reached the cert box on every batch${skipped.length > 0 ? " it could" : ""}. Nothing submitted.`);
    return;
  }

  // Coverage, not file count. A CSV exists whether it holds 103 prices or 3,
  // so "1 CSV(s) exported" was true of the run that priced 3% of its batch and
  // still exited 0 — the nightly cron went green over it.
  const totals = produced.reduce(
    (acc, file) => {
      const { rows, blanks } = countBlankPrices(file);
      return { rows: acc.rows + rows, priced: acc.priced + (rows - blanks) };
    },
    { rows: 0, priced: 0 },
  );
  const pct = totals.rows === 0 ? 0 : Math.round((totals.priced / totals.rows) * 100);

  console.log(
    `\n    ${produced.length} CSV(s) exported to ${dir}` +
    (totals.rows > 0 ? `  —  ${totals.priced}/${totals.rows} card(s) priced (${pct}%)` : ""));

  // Which workarounds carried the run. A step that fires on nearly every click
  // is the signal to go look at their page, before it stops working entirely.
  const recovered = recoverySummary();
  if (recovered) console.log(`    recoveries: ${recovered}`);
  for (const o of skipped) console.warn(`    ⚠️  ${o.batch} skipped — ${o.note}`);
  for (const o of failed) console.error(`    ❌  ${o.batch} failed — ${o.note}`);
  if (produced.length > 0) {
    console.log(`    npm run import:cards -- --dir=${dir}`);
  }

  writeStepSummary(outcomes, totals, dir);

  // Fail loudly rather than leave it to somebody reading the log. Unpriced
  // cards are not a crash — the slabs are in inventory and /admin/pricing picks
  // them up — but a run that priced almost nothing is a broken run, and a green
  // cron over it is how the last one went unnoticed for a day.
  //
  // A grader the site itself declares offline is the one exception: there is
  // nothing on this side to fix, the certs are re-selected the next night, and
  // a red run every night of their outage would teach everyone to ignore red.
  // It goes on the run page instead — unless it left the night with nothing.
  if (failed.length > 0) {
    console.error(
      `\n❌  ${failed.length} of ${outcomes.length} batch(es) failed — see failure-<batch>.png/.html in ${dir}.\n` +
      `    The CSVs that did export are on disk and importing them is safe.`);
    process.exitCode = 1;
    return;
  }

  if (totals.rows === 0 && skipped.length > 0) {
    console.error(`\n❌  Nothing priced — every batch was skipped for an outage at Card Uploader.`);
    process.exitCode = 1;
    return;
  }

  if (totals.rows > 0 && pct < MIN_PRICED_PCT) {
    console.error(
      `\n❌  Only ${totals.priced} of ${totals.rows} card(s) came back with a price (${pct}%, ` +
      `expected at least ${MIN_PRICED_PCT}%).\n` +
      `    The CSVs are on disk and importing them is safe — this is a warning about ` +
      `coverage, not corrupt data.\n` +
      `    Check for an expired session, a changed price dialog, or Card Uploader ` +
      `having no Alt Value for these cards.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅  Done.` + (skipped.length > 0
    ? `  ${skipped.length} batch(es) skipped — ${[...new Set(skipped.map((o) => o.batch.split("-")[0].toUpperCase()))].join(", ")} offline at Card Uploader.`
    : ""));
}

type BatchOutcome = {
  batch: string;
  status: "priced" | "unpriced" | "skipped" | "failed";
  note: string;
};

/** ", comps saved" or ", comps missing" — whether the import can check the prices. */
function compsNote(total: number | null): string {
  return total === null ? ", comps missing" : ", comps saved";
}

/** "102/105 priced, 3 blank" — what a saved export actually holds. */
function pricedNote(file: { name: string; content: string }): string {
  const { rows, blanks } = countBlankPrices(file);
  return `${rows - blanks}/${rows} priced` + (blanks > 0 ? `, ${blanks} blank` : "");
}

/**
 * Saves the comps behind a batch's prices beside its CSV.
 *
 * Best effort, and after the CSV is on disk: the export is what the database
 * needs, the comps only make the import stricter about it. A batch whose
 * comps could not be read imports exactly as one priced before comps existed,
 * and says so, rather than losing a paid-for export to a second request that
 * failed. Returns how many certs the file now covers, or null on failure.
 */
async function saveComps(page: Page, bearer: Bearer, batchId: string, dir: string): Promise<number | null> {
  try {
    const comps = await fetchJobComps(page, bearer, BASE, batchId);
    const { total } = mergeComps(dir, comps);
    console.log(`    comps for ${Object.keys(comps).length} card(s) → ${COMPS_FILE}`);
    return total;
  } catch (err) {
    console.warn(
      `    ⚠️  could not save the batch's comps (${err instanceof Error ? err.message.split("\n")[0] : err}) — ` +
      `its prices will import without a confidence check`);
    return null;
  }
}

/**
 * A locator timeout says what it was waiting for, never what the page actually
 * looked like. Headless CI runs on a stranger's machine every time — a
 * screenshot and the rendered text are the only way a failure there becomes
 * debuggable from here instead of a guess. Named per batch so a night with two
 * failures keeps both.
 */
async function captureFailure(page: Page, dir: string, stem: string) {
  await page.screenshot({ path: join(dir, `${stem}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => null);
  if (html) writeFileSync(join(dir, `${stem}.html`), html);
  console.error(`    URL at failure: ${page.url()}`);
}

/**
 * The night's outcome on the workflow run's own page, batch by batch.
 *
 * A skipped grader that only shows up as one warning line in a half-hour log
 * is a skipped grader nobody notices. GitHub renders whatever is appended to
 * this file under the job; outside Actions there is no file and nothing to do.
 */
function writeStepSummary(
  outcomes: BatchOutcome[],
  totals: { rows: number; priced: number },
  dir: string,
) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;

  const icon = { priced: "✅", unpriced: "⚠️", skipped: "⏭️", failed: "❌" } as const;
  const lines = [
    `### Card Uploader pricing — ${basename(dir)}`,
    "",
    `${totals.priced}/${totals.rows} card(s) priced across ${outcomes.length} batch(es).`,
    "",
    "| batch | outcome |",
    "| --- | --- |",
    ...outcomes.map((o) => `| \`${o.batch}\` | ${icon[o.status]} ${o.status} — ${o.note.replace(/\|/g, "\\|")} |`),
  ];
  const recovered = recoverySummary();
  if (recovered) lines.push("", `Recoveries: ${recovered}`);

  try {
    appendFileSync(path, lines.join("\n") + "\n\n");
  } catch {
    // Cosmetic — the log has all of this already.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\nBatch run failed:", err.message ?? err);
    process.exit(1);
  });
}
