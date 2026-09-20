/**
 * Fanatics Collect — auction sniper
 *
 * The pipeline is scripts/sniper-core.ts; this file is the Fanatics half of
 * it: the scan of the Weekly Auction about to close, and the session the book
 * bids through (scripts/fanatics-bidder.ts).
 *
 * The scan. The marketplace page runs on Algolia with a short-lived (10 minute)
 * secured key, so the key is harvested from a real page load and the index is
 * then queried directly — no scrolling, no DOM. Each record carries the slab's
 * cert number ("serial"), grader, grade, category, current bid and the time
 * extended bidding starts. Auctions closing later than AUCTION_WINDOW_DAYS are
 * left alone: their lots cannot be bid past their opening price for another
 * week, and the comps behind a max bid go stale long before then.
 *
 * The close. Extended bidding opens at 7:00 PM PT and Fanatics closes lots
 * one by one: a lot with no bid between 7:00 and 7:30 closes at 7:30 sharp,
 * one still open after 7:30 closes five minutes after its last bid, and after
 * 8:00 one minute after. The bids go on at 7:27 — the "fire after" box, 27
 * minutes past the open — so the quiet lots close three minutes later with
 * our max on them and the fought-over ones give the other bidder five
 * minutes rather than an evening. See scripts/sniper-core.ts for the hold.
 *
 * Usage:
 *   npm run sniper                          plan a $100 budget, no account needed, nothing sent
 *   npm run sniper -- --budget=250          plan a bigger one
 *   npm run sniper -- --quote-only          sign in and quote every lot, still sending nothing
 *   npm run sniper -- --live                place the bids, poll, rebid what is outbid
 *   npm run sniper -- --login               sign in to Fanatics by hand, once, and save the session
 *   npm run sniper -- --export-session      print the refresh token for the GitHub secret
 * and the flags every venue shares — see scripts/sniper-core.ts.
 *
 * Bidding needs a Fanatics session, from any one of: the saved profile that
 * --login writes, FANATICS_REFRESH_TOKEN, or FANATICS_EMAIL and
 * FANATICS_PASSWORD. Only the token works on a machine with no screen, because
 * Cloudflare will not draw the sign-in page for a headless browser. See
 * scripts/fanatics-bidder.ts.
 */

import { pathToFileURL } from "url";
import { chromium, type Browser } from "playwright";
import { FANATICS_STEPS, SESSION_DIR, listingUrl, openFanatics } from "./fanatics-bidder";
import {
  GRADERS,
  fmtLocal,
  gradeRanges,
  gradesIn,
  parallel,
  runAsMain,
  type ScannedLot,
  type Venue,
} from "./sniper-core";

export * from "./sniper-core";

// ── Configuration ─────────────────────────────────────────────────────────────

export const FANATICS = "https://www.fanaticscollect.com";
const MARKETPLACE_URL = `${FANATICS}/marketplace?type=WEEKLY`;
export const TIME_ZONE = "America/Los_Angeles";

/**
 * The marketplace's search backend. The application id is public and baked
 * into the site's JavaScript; the API key is not — it is a secured key the
 * server mints per page load with the marketplace's base filters and a
 * ten-minute validUntil embedded in it, so it is read off a real page load
 * rather than stored here.
 */
const ALGOLIA_APP = "3XT9C4X62I";
const ALGOLIA_INDEX = "prod_item_state_v1";
const ALGOLIA_URL = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

/** Largest page Algolia will serve, and the most hits one query may page through. */
const ALGOLIA_PAGE = 1000;
const ALGOLIA_MAX_HITS = 2000;

/** Re-harvest the search key when it has less than this long to live. */
const ALGOLIA_KEY_MARGIN_S = 90;

/**
 * Search cells asked for at once. The scan is 28 small queries — one per
 * auction × grader × grade × category — and Algolia answers them as happily
 * together as one after another.
 */
export const SCAN_CONCURRENCY = 8;

/**
 * The Pokémon categories, as a fallback. What a scan actually filters on is
 * every subCategory1 the facet reports with Pokémon in its name — Fanatics
 * has added a language before now, and a category nobody listed here is a
 * few hundred lots the run never sees.
 */
export const CATEGORIES = [
  "Trading Card Games > Pokémon (English)",
  "Trading Card Games > Pokémon (Japanese)",
];

/** Every Pokémon category the facet knows about, or CATEGORIES when it knows none. */
export function pokemonCategories(facet: Record<string, number> | undefined): string[] {
  const found = Object.keys(facet ?? {}).filter((name) => /pok[eé]mon/i.test(name));
  return found.length > 0 ? found.sort() : CATEGORIES;
}

/**
 * How far ahead an auction may close and still be scanned.
 *
 * Fanatics runs several Weekly Auctions at once — this Sunday's and the two
 * after it. Only the one about to close is worth a bid list: lots in a later
 * auction cannot be bid past their opening price for another week, and the
 * comps behind their max bid go stale long before that.
 */
const AUCTION_WINDOW_DAYS = 7;

// ── Fanatics search ───────────────────────────────────────────────────────────

/**
 * One Algolia record for a Weekly Auction lot — only the attributes the run
 * reads, which keeps a 12,000-lot scan to a few megabytes.
 */
export type Hit = {
  listingUuid: string;
  title: string;
  /** The slab's cert number. */
  serial?: string;
  grade?: number;
  gradingService?: string;
  currentBid?: number;
  bidCount?: number;
  /** Unix seconds; when extended bidding starts for this lot's auction. */
  auctionEndDatetime?: number;
  auctionName?: string;
  lotNumber?: string;
  subCategory1?: string[];
};

export const HIT_ATTRIBUTES = [
  "listingUuid", "title", "serial", "grade", "gradingService", "currentBid", "bidCount",
  "auctionEndDatetime", "auctionName", "lotNumber", "subCategory1",
];

type AlgoliaResult = {
  hits?: Hit[];
  nbHits?: number;
  facets?: Record<string, Record<string, number>>;
  message?: string;
  status?: number;
};

/**
 * Holds the search key and re-harvests it before it lapses.
 *
 * A page load is the only place the key comes from, so a browser is kept open
 * for the whole scan; harvesting is one navigation that watches for the first
 * request to Algolia and reads the key off its query string.
 */
export class AlgoliaKey {
  private key = "";
  private validUntil = 0;
  /** The harvest in flight, so queries running side by side share one page load. */
  private harvesting: Promise<string> | null = null;

  constructor(private readonly browser: Browser, private readonly quiet = false) {}

  async get(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.key && this.validUntil - now > ALGOLIA_KEY_MARGIN_S) return this.key;
    if (!this.harvesting) this.harvesting = this.harvest().finally(() => { this.harvesting = null; });
    return this.harvesting;
  }

  /**
   * One page load, and the key is read off the first request the page makes to
   * Algolia — which is well before the page has finished loading, so that is
   * what is waited for rather than a quiet network.
   */
  private async harvest(): Promise<string> {
    const now = Date.now() / 1000;
    const context = await this.browser.newContext();
    const page = await context.newPage();
    let key = "";
    try {
      const first = page.waitForRequest((r) => /algolia\.net/.test(r.url()), { timeout: 60_000 }).catch(() => null);
      await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const request = await first;
      if (request) {
        key = new URL(request.url()).searchParams.get("x-algolia-api-key") ?? request.headers()["x-algolia-api-key"] ?? "";
      }
    } finally {
      await context.close();
    }
    if (!key) throw new Error("The marketplace page never queried Algolia — the search backend may have changed.");

    // The secured key is base64 over "<hmac><url-encoded params>", and validUntil
    // is one of those params.
    const decoded = Buffer.from(key, "base64").toString("latin1");
    const validUntil = Number(/validUntil=(\d+)/.exec(decoded)?.[1] ?? 0);
    this.key = key;
    this.validUntil = validUntil || now + 300;
    if (!this.quiet) console.log(`    search key harvested, valid ${Math.round(this.validUntil - now)}s`);
    return key;
  }
}

export async function algolia(keyer: AlgoliaKey, request: Record<string, unknown>): Promise<AlgoliaResult> {
  const key = await keyer.get();
  const res = await fetch(`${ALGOLIA_URL}?x-algolia-api-key=${key}&x-algolia-application-id=${ALGOLIA_APP}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ requests: [{ indexName: ALGOLIA_INDEX, query: "", attributesToHighlight: [], ...request }] }),
  });
  const json = (await res.json()) as { results?: AlgoliaResult[]; message?: string; status?: number };
  const result = json.results?.[0] ?? json;
  if (result.message) throw new Error(`Algolia: ${result.message}`);
  return result;
}

export function quote(s: string) {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * The value at which a facet's counts split in half: everything at or below
 * it is one side, everything above the other.
 */
function medianOf(facet: Record<string, number> | undefined, total: number): { median: number; lowest: number; highest: number } | null {
  const counts = Object.entries(facet ?? {})
    .map(([value, n]) => [Number(value), n] as const)
    .sort((a, b) => a[0] - b[0]);
  if (counts.length < 2) return null;
  let running = 0;
  let median = counts[0][0];
  for (const [value, n] of counts) {
    running += n;
    if (running >= total / 2) { median = value; break; }
  }
  const highest = counts[counts.length - 1][0];
  return median < highest ? { median, lowest: counts[0][0], highest } : null;
}

/**
 * Sellers grouped so that no group holds more than ALGOLIA_MAX_HITS lots
 * (a single seller over the cap gets a group to itself and is split further
 * downstream). Greedy first-fit on descending counts.
 */
function sellerBins(facet: Record<string, number> | undefined): string[][] {
  const bins: { ids: string[]; n: number }[] = [];
  const sellers = Object.entries(facet ?? {}).sort((a, b) => b[1] - a[1]);
  for (const [id, n] of sellers) {
    const bin = bins.find((b) => b.n + n <= ALGOLIA_MAX_HITS);
    if (bin) { bin.ids.push(id); bin.n += n; } else bins.push({ ids: [id], n });
  }
  return bins.map((b) => b.ids);
}

/**
 * Every hit for a filter, no matter how many.
 *
 * Algolia refuses to page past ALGOLIA_MAX_HITS, so a partition that is too
 * big is split and each part collected in turn. The split has to be total —
 * a split on an attribute some records lack silently drops those records —
 * so the splitters are tried in order of how safe they are:
 *
 *   1. currentBid at its median. Always present, but every lot in an auction
 *      that has not opened for bidding yet reads $0, so it can fail to split.
 *   2. sellerId, binned. Always present; a cell is usually hundreds of sellers.
 *   3. year at its median. A lot without a year is lost here, so it is a
 *      warning; a single seller with over 2,000 lots of one grade in one
 *      auction is what it takes to get this far.
 *
 * A partition none of those can split is truncated with a warning.
 */
export async function collect(
  keyer: AlgoliaKey,
  filters: string,
  numericFilters: string[] = [],
  depth = 0,
  attributes: string[] = HIT_ATTRIBUTES,
): Promise<Hit[]> {
  // One request does for most cells: the first page of hits, plus the count
  // and the facets a split would need. Only a cell over a page long asks again.
  const first = await algolia(keyer, {
    filters, numericFilters, page: 0, hitsPerPage: ALGOLIA_PAGE, attributesToRetrieve: attributes,
    facets: ["currentBid", "sellerId", "year"], maxValuesPerFacet: 1000,
  });
  const total = first.nbHits ?? 0;
  if (total === 0) return [];

  if (total > ALGOLIA_MAX_HITS && depth < 30) {
    const halves = async (a: string, b: string) => {
      const [low, high] = await Promise.all([
        collect(keyer, filters, [...numericFilters, a], depth + 1, attributes),
        collect(keyer, filters, [...numericFilters, b], depth + 1, attributes),
      ]);
      return [...low, ...high];
    };

    const bid = medianOf(first.facets?.currentBid, total);
    if (bid) return halves(`currentBid<=${bid.median}`, `currentBid>${bid.median}`);

    const bins = sellerBins(first.facets?.sellerId);
    const binned = Object.values(first.facets?.sellerId ?? {}).reduce((a, b) => a + b, 0);
    if (bins.length > 1) {
      if (binned < total) {
        console.warn(`    ⚠️  ${total - binned} of ${total} lots have no seller under "${filters}" and are skipped`);
      }
      const parts = await parallel(bins, SCAN_CONCURRENCY, (ids) =>
        collect(keyer, `${filters} AND (${ids.map((id) => `sellerId:${quote(id)}`).join(" OR ")})`, numericFilters, depth + 1, attributes));
      return parts.flat();
    }

    const year = medianOf(first.facets?.year, total);
    if (year) {
      const dated = Object.values(first.facets?.year ?? {}).reduce((a, b) => a + b, 0);
      if (dated < total) {
        console.warn(`    ⚠️  ${total - dated} of ${total} lots have no year under "${filters}" and are skipped`);
      }
      return halves(`year<=${year.median}`, `year>${year.median}`);
    }

    console.warn(`    ⚠️  ${total} lots under "${filters}" could not be split; only the first ${ALGOLIA_MAX_HITS} are read`);
  }

  const hits: Hit[] = [...(first.hits ?? [])];
  const pages = Math.ceil(Math.min(total, ALGOLIA_MAX_HITS) / ALGOLIA_PAGE);
  for (let page = 1; page < pages; page++) {
    const res = await algolia(keyer, {
      filters, numericFilters, page, hitsPerPage: ALGOLIA_PAGE, attributesToRetrieve: attributes,
    });
    hits.push(...(res.hits ?? []));
  }
  return hits;
}

/** Unix seconds as "Sun Sep 6, 7:00 PM PT". */
const fmtPacific = (unixS: number) => fmtLocal(unixS, TIME_ZONE, "PT");

/**
 * Every live PSA/CGC Pokémon lot in the Weekly Auction about to close, at
 * the grades the run was told to scan.
 *
 * The status facet lags: a handful of lots from auctions that closed weeks ago
 * still read "Live", so auctions are taken from the end-time facet and only
 * those ending in the future are walked — and of those, only the ones inside
 * AUCTION_WINDOW_DAYS. Each (auction × grader × grade × category) cell is
 * collected separately so that most cells fit one query and the rest need at
 * most one split.
 */
async function scanFanatics(keyer: AlgoliaKey, now: Date, quiet = false): Promise<Hit[]> {
  const say = quiet ? () => {} : (line: string) => console.log(line);
  const base = [
    `marketplace:WEEKLY`,
    `status:Live`,
    `(${GRADERS.map((g) => `gradingService:${g}`).join(" OR ")})`,
    `(${CATEGORIES.map((c) => `subCategory1:${quote(c)}`).join(" OR ")})`,
  ].join(" AND ");

  const facets = await algolia(keyer, {
    filters: base, hitsPerPage: 0, facets: ["auctionEndDatetime", "grade", "subCategory1"], maxValuesPerFacet: 100,
  });
  const categories = pokemonCategories(facets.facets?.subCategory1);
  const nowS = Math.floor(now.getTime() / 1000);
  const open = Object.keys(facets.facets?.auctionEndDatetime ?? {})
    .map(Number)
    .filter((t) => t > nowS)
    .sort((a, b) => a - b);

  if (open.length === 0) throw new Error("No Weekly Auction with a future end time has any Pokémon lots — nothing to scan.");

  // This week's close only. If the soonest is somehow further out than the
  // window — a run right after a close, or a skipped week — take it anyway
  // rather than scanning nothing.
  const soon = open.filter((t) => t <= nowS + AUCTION_WINDOW_DAYS * 86_400);
  const ends = soon.length > 0 ? soon : [open[0]];
  const skipped = open.filter((t) => !ends.includes(t));

  say(`    ${ends.length} auction(s) closing within ${AUCTION_WINDOW_DAYS} days: ${ends.map((t) => fmtPacific(t)).join(", ")}`);
  if (skipped.length > 0) {
    say(`    skipping ${skipped.length} later auction(s): ${skipped.map((t) => fmtPacific(t)).join(", ")}`);
  }

  // Only the grades the auction actually has, inside the run's range: the
  // ladder runs 1–10 in half steps now, and enumerating all nineteen against
  // an auction that holds six of them is thirteen empty queries a cell.
  const listed = new Set(Object.keys(facets.facets?.grade ?? {}).map(Number).filter((g) => g > 0));
  const ranges = gradeRanges();
  say(`    grades ${GRADERS.map((g) => `${g} ${ranges[g].min}–${ranges[g].max}`).join(", ")}, in ${categories.length} Pokémon categor${categories.length === 1 ? "y" : "ies"}`);

  const hits: Hit[] = [];
  for (const end of ends) {
    const cells: string[] = [];
    for (const grader of GRADERS) {
      const grades = gradesIn(ranges[grader]).filter((g) => listed.size === 0 || listed.has(g));
      for (const grade of grades) {
        for (const category of categories) {
          cells.push(`${base} AND auctionEndDatetime:${end} AND gradingService:${grader} AND grade:${grade} AND subCategory1:${quote(category)}`);
        }
      }
    }
    const collected = await parallel(cells, SCAN_CONCURRENCY, (filters) => collect(keyer, filters));
    for (const part of collected) hits.push(...part);
    say(`    ${fmtPacific(end)}: ${hits.length} lot(s) so far`);
  }
  return hits;
}

/** An Algolia record as the pipeline reads it. */
export function toLot(hit: Hit): ScannedLot {
  const category = hit.subCategory1?.[0] ?? "";
  return {
    listingId: hit.listingUuid,
    url: `${FANATICS}/weekly/${hit.listingUuid}`,
    title: hit.title,
    grader: hit.gradingService ?? "",
    grade: hit.grade,
    cert: (hit.serial ?? "").trim(),
    currentBid: hit.currentBid ?? 0,
    bidCount: hit.bidCount ?? 0,
    auction: hit.auctionName ?? "",
    lot: hit.lotNumber ?? "",
    language: /Japanese/.test(category) ? "Japanese" : /English/.test(category) ? "English" : "",
    closesAtUnixS: hit.auctionEndDatetime,
  };
}

// ── The venue ─────────────────────────────────────────────────────────────────

export const fanatics: Venue = {
  name: "Fanatics Collect",
  key: "fanatics",
  outDir: "sniper-runs",
  batchPrefix: "Sniper",
  timeZone: TIME_ZONE,
  zoneLabel: "PT",
  sessionDir: SESSION_DIR,
  steps: FANATICS_STEPS,
  // PSA slabs are priced whatever the title says: Fanatics lists thousands of
  // them and pricing is free, so the chase list was only ever keeping the
  // credits off bulk that the tier table would have turned down anyway. CGC
  // keeps it — the CGC end of a Weekly Auction is where the $6 energies,
  // insert cards and sticker sheets live.
  chaseList: { PSA: false, CGC: true },
  // Lots close one by one here — a lot nobody bids on between 7:00 and 7:30
  // PM PT closes at 7:30 sharp — so the bids go on at 7:27, three minutes
  // before that cliff, and the whole auction never ends as one.
  closesTogether: false,
  fireAfterMinutes: 27,
  listingUrl,

  async scan({ headed, now, light }) {
    const browser = await chromium.launch({ headless: !headed });
    let hits: Hit[];
    try {
      hits = await scanFanatics(new AlgoliaKey(browser, light ?? false), now, light ?? false);
    } finally {
      await browser.close();
    }
    // Every lot here belongs to the one auction, so the soonest end is its end.
    let closesAtUnixS = Infinity;
    for (const h of hits) if (h.auctionEndDatetime && h.auctionEndDatetime < closesAtUnixS) closesAtUnixS = h.auctionEndDatetime;
    return { lots: hits.map(toLot), closesAtUnixS };
  },

  open({ headed, login, email, password }) {
    return openFanatics({ headed, login, email, password });
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAsMain(fanatics);
