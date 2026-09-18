/**
 * Alt — auction sniper
 *
 * The pipeline is scripts/sniper-core.ts; this file is the Alt half of it:
 * the scan of the Alt Auction about to close, and the session the book bids
 * through (scripts/alt-bidder.ts).
 *
 * Alt Auctions run two weeks each, overlapping, so one closes every Thursday:
 * extended bidding opens at 9 PM ET and the whole auction extends together —
 * any bid on any lot pushes every lot's close out by the window of the hour
 * (two minutes until 9:30, one until 10:00, 30 seconds until 10:30, 15 from
 * then on) — until a window passes with no bid anywhere. Nothing closes
 * early, and the whole thing runs three to five hours: the 26 auctions to
 * 2026-09-10 ended between 12:03 and 2:30 AM, bar one holiday-week Friday
 * that ended at 10:45 PM. So the bids go on late — 100 minutes in by default,
 * 10:40 PM — and an outbid bidder has only what is left of the night to
 * answer, rather than all of it.
 *
 * The scan. The site's catalogue is a Typesense index; the search page fetches
 * a ten-minute scoped key for it from the site's own GraphQL (no account
 * needed), and that is what this does too. The index is missing one thing the
 * pipeline needs — the slab's cert number — so every PSA/CGC lot is asked
 * about once more, through the public listing query, which carries it.
 *
 * There is no chase list here. An Alt Auction holds a thousand or so PSA/CGC
 * 7–10 Pokémon lots — the size of one Fanatics category, not one Fanatics
 * auction — so every one of them is a candidate and the sales rule and the
 * tier table decide the rest.
 *
 * Usage:
 *   npm run sniper:alt                          plan a $100 budget, no account needed, nothing sent
 *   npm run sniper:alt -- --quote-only          sign in and quote every lot, still sending nothing
 *   npm run sniper:alt -- --live                place the bids, poll, rebid what is outbid
 *   npm run sniper:alt -- --login               sign in to Alt by hand, once, and save the session
 *   npm run sniper:alt -- --export-session      print the session token for the GitHub secret
 *   npm run sniper:alt -- --auction="Sep 04"    scan that auction rather than the one closing first
 * and the flags every venue shares — see scripts/sniper-core.ts.
 */

import { pathToFileURL } from "url";
import { ALT_STEPS, BID_INPUT_VERIFIED, SESSION_DIR, gqlPublic, listingUrl, lotLabel, openAlt } from "./alt-bidder";
import {
  GRADERS,
  GRADES,
  fmtLocal,
  parallel,
  opt,
  runAsMain,
  type ScannedLot,
  type Venue,
} from "./sniper-core";

// ── Configuration ─────────────────────────────────────────────────────────────

const TIME_ZONE = "America/New_York";

/** Lots the index serves per page, its ceiling. */
const PAGE = 250;
/** Fetch a fresh search key when this one has less than this long to live. */
const KEY_MARGIN_S = 60;
/**
 * Cert lookups at once. Each is one small GraphQL read of about 80 ms, so a
 * cycle's thousand lots are five seconds or so at sixteen — well below what
 * the site's own pages ask of it.
 */
const CERT_CONCURRENCY = 16;

/**
 * How far past the soonest close another cycle may end and still count as
 * closing with it. Alt's cycles are a week apart, so this only has to clear
 * one night of extended bidding, which has run as late as 2:30 AM.
 */
const SAME_CLOSE_GRACE_S = 6 * 3_600;

/** Alt's grade key for a CGC Pristine 10, which its grade field calls "PRI". */
const CGC_PRISTINE_KEY = "CGC-PRI";

// ── Alt search ────────────────────────────────────────────────────────────────

type SearchConfig = {
  serviceConfig: {
    search: {
      universalSearch: {
        clientConfig: { nodes: { host: string; port: number; protocol: string }[]; apiKey: string };
        collectionName: string;
        expiresAt: number;
      };
    };
  };
};

/** One Typesense document for an auction lot — the fields the run reads. */
type Doc = {
  listingId: string;
  itemName?: string;
  name?: string;
  gradingCompany?: string;
  grade?: string;
  gradeKey?: string;
  /** Dollars: the current bid, or the opening price with no bids yet. */
  price?: number;
  bidCount?: number;
  auctionCycleId?: number;
  auctionName?: string;
  expiresAtEpoch?: number;
};

type Cycle = { id: number; name: string | null; state: string | null; expiresAt: string | null };

/**
 * When a cycle was advertised to close — 9 PM ET on its Thursday. The list
 * of cycles carries only the moving end, which before extended bidding reads
 * five minutes past the advertised close; the cycle's own record has the
 * original, and that is what the fire time is counted from.
 */
async function scheduledCloseUnixS(cycle: Cycle): Promise<number> {
  const fallback = Math.floor(Date.parse(cycle.expiresAt ?? "") / 1000) || 0;
  try {
    const data = await gqlPublic<{ auctionCycle: { originalExpiresAt: string | null } | null }>(
      "AuctionCycle", `query AuctionCycle { auctionCycle(id: ${Number(cycle.id)}) { id originalExpiresAt } }`);
    return Math.floor(Date.parse(data.auctionCycle?.originalExpiresAt ?? "") / 1000) || fallback;
  } catch {
    return fallback;
  }
}

/** Holds the scoped search key and fetches a fresh one before it lapses. */
class SearchKey {
  private url = "";
  private expiresAt = 0;

  async endpoint(): Promise<string> {
    if (this.url && this.expiresAt - Date.now() / 1000 > KEY_MARGIN_S) return this.url;
    const cfg = await gqlPublic<SearchConfig>("SearchServiceConfig", `
      query SearchServiceConfig {
        serviceConfig { search { universalSearch { clientConfig { nodes { host port protocol } apiKey } collectionName expiresAt } } }
      }`);
    const s = cfg.serviceConfig.search.universalSearch;
    const node = s.clientConfig.nodes[0];
    this.url = `${node.protocol}://${node.host}:${node.port}/multi_search?collection=${s.collectionName}&use_cache=true&x-typesense-api-key=${encodeURIComponent(s.clientConfig.apiKey)}`;
    this.expiresAt = s.expiresAt;
    console.log(`    search key fetched, valid ${Math.round(this.expiresAt - Date.now() / 1000)}s`);
    return this.url;
  }
}

async function search(key: SearchKey, params: Record<string, unknown>): Promise<{ found: number; hits: Doc[] }> {
  const res = await fetch(await key.endpoint(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ searches: [params] }),
  });
  if (!res.ok) throw new Error(`Alt search: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { results?: { found?: number; hits?: { document: Doc }[]; error?: string }[] };
  const result = json.results?.[0];
  if (!result) throw new Error("Alt search: empty response");
  if (result.error) throw new Error(`Alt search: ${result.error}`);
  return { found: result.found ?? 0, hits: (result.hits ?? []).map((h) => h.document) };
}

/** The grade keys of every PSA and CGC grade chased, in Alt's spelling. */
export function gradeKeys(): string[] {
  const keys = GRADERS.flatMap((g) => GRADES.map((n) => `${g}-${n}`));
  keys.push(CGC_PRISTINE_KEY);
  return keys;
}

/** Unix seconds as "Thu Sep 10, 9:00 PM ET". */
const fmtEastern = (unixS: number) => fmtLocal(unixS, TIME_ZONE, "ET");

/**
 * The auction about to close, from Alt's own list.
 *
 * Alt keeps two or three cycles open at once and they overlap, so "closing
 * soon" is never one auction: on the Thursday night a cycle is in extended
 * bidding, the cycle a week behind it is open too and takes bids just the
 * same. Only the one closing tonight is worth a bid list — a bid put on next
 * week's lots at tonight's fire would stand there for a week for anyone to
 * answer — so what is scanned is the soonest close and anything closing with
 * it, and never the cycle behind.
 *
 * `want` overrides that pick: a cycle id, or any part of a cycle's name, or
 * several of either separated by commas.
 */
export function pickCycles(cycles: Cycle[], nowS: number, want = ""): { chosen: Cycle[]; skipped: Cycle[] } {
  const ends = (c: Cycle) => Math.floor(Date.parse(c.expiresAt ?? "") / 1000) || 0;
  const open = cycles
    .filter((c) => c.state !== "ENDED" && c.state !== "CANCELED" && ends(c) > nowS)
    .sort((a, b) => ends(a) - ends(b));
  const wanted = want.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (wanted.length > 0) {
    const chosen = open.filter((c) => wanted.some((w) => String(c.id) === w || (c.name ?? "").toLowerCase().includes(w)));
    if (chosen.length === 0) {
      const names = open.map((c) => `${c.name} (id ${c.id})`).join(", ") || "none";
      throw new Error(`no open Alt auction matches --auction="${want}". Open now: ${names}`);
    }
    return { chosen, skipped: open.filter((c) => !chosen.includes(c)) };
  }
  if (open.length === 0) return { chosen: [], skipped: [] };
  const soonest = ends(open[0]);
  const chosen = open.filter((c) => ends(c) <= soonest + SAME_CLOSE_GRACE_S);
  return { chosen, skipped: open.filter((c) => !chosen.includes(c)) };
}

/**
 * Which auction to scan, as this run was told: --auction=, else the AUCTION
 * environment variable, else blank for the one closing soonest.
 */
export function auctionFromArgs(env: Record<string, string | undefined> = process.env): string {
  return opt("auction", env.AUCTION ?? "").trim();
}

/** A search document as the pipeline reads it. The cert is filled in afterwards. */
export function toLot(doc: Doc, cycle: Cycle, closesAtUnixS?: number): ScannedLot {
  const title = doc.itemName ?? doc.name ?? "";
  const pristine = doc.gradeKey === CGC_PRISTINE_KEY;
  const grade = pristine ? 10 : Number(doc.grade);
  return {
    listingId: doc.listingId,
    url: listingUrl(doc.listingId),
    title,
    grader: doc.gradingCompany ?? "",
    grade: Number.isFinite(grade) ? grade : undefined,
    pristine,
    cert: "",
    currentBid: doc.price ?? 0,
    bidCount: doc.bidCount ?? 0,
    auction: doc.auctionName ?? cycle.name ?? `cycle ${cycle.id}`,
    lot: lotLabel(doc.listingId),
    // Alt files English and Japanese together; the title says which.
    language: /\bjapanese\b/i.test(title) ? "Japanese" : "English",
    closesAtUnixS: closesAtUnixS || Math.floor(Date.parse(cycle.expiresAt ?? "") / 1000) || doc.expiresAtEpoch,
  };
}

/** The slab's cert number, off the public listing — the one thing the index leaves out. */
async function certOf(listingId: string): Promise<string> {
  const data = await gqlPublic<{ publicListing: { publicListing: { items: { attributes: { certNumber: string | null } | null }[] | null } | null } | null }>(
    "PublicListingWithTransaction",
    `query PublicListingWithTransaction($listingId: ID!) { publicListing(id: $listingId) { publicListing { id items { attributes { certNumber } } } } }`,
    { listingId });
  return (data.publicListing?.publicListing?.items?.[0]?.attributes?.certNumber ?? "").trim();
}

/**
 * Every live PSA/CGC 7–10 Pokémon lot in the Alt Auction about to close.
 *
 * The index is filtered to the cycle, the category and the grade keys, and
 * paged through in full — a cycle holds a thousand or so such lots. Then the
 * cert is fetched for every PSA/CGC lot, since every one is a candidate.
 *
 * A `light` scan is the same read of the index without the certs and without
 * the chatter: the pipeline takes one every few minutes before the bids go
 * on, for nothing but where each lot's bidding stands now.
 */
async function scanAlt(now: Date, light = false): Promise<{ lots: ScannedLot[]; closesAtUnixS: number }> {
  const nowS = Math.floor(now.getTime() / 1000);
  const say = light ? () => {} : (line: string) => console.log(line);
  const { auctionCycles } = await gqlPublic<{ auctionCycles: Cycle[] | null }>("AuctionCycles",
    `query AuctionCycles { auctionCycles { id name state expiresAt } }`);
  const want = auctionFromArgs();
  const { chosen, skipped } = pickCycles(auctionCycles ?? [], nowS, want);
  if (chosen.length === 0) throw new Error("No Alt Auction with a future close — nothing to scan.");
  const scheduled = new Map<number, number>();
  for (const c of chosen) scheduled.set(c.id, await scheduledCloseUnixS(c));
  const ends = (c: Cycle) => scheduled.get(c.id) || Math.floor(Date.parse(c.expiresAt ?? "") / 1000) || 0;
  say(`    scanning ${chosen.length} auction(s)${want ? ` matching "${want}"` : " closing first"}: ${chosen.map((c) => `${c.name} (${fmtEastern(ends(c))})`).join(", ")}`);
  if (skipped.length > 0) say(`    leaving ${skipped.length} auction(s) that close later: ${skipped.map((c) => `${c.name} (${fmtEastern(ends(c))})`).join(", ")}`);

  const key = new SearchKey();
  const lots: ScannedLot[] = [];
  for (const cycle of chosen) {
    const filter = [
      "listingType:[AUCTION]",
      "auctionHouse:[Alt]",
      "showResult:true",
      "category:[POKEMON_CARDS]",
      `gradingCompany:[${GRADERS.join(",")}]`,
      `gradeKey:[${gradeKeys().join(",")}]`,
      `auctionCycleId:[${cycle.id}]`,
    ].join("&&");
    let page = 1;
    let found = Infinity;
    let got = 0;
    while (got < found) {
      const res = await search(key, { q: "", preset: "price_desc", filter_by: filter, per_page: PAGE, page });
      found = res.found;
      got += res.hits.length;
      for (const doc of res.hits) lots.push(toLot(doc, cycle, ends(cycle)));
      if (res.hits.length < PAGE) break;
      page++;
    }
    say(`    ${cycle.name}: ${got} lot(s)`);
  }

  const closesAtUnixS = Math.min(...chosen.map(ends).filter((t) => t > 0));
  if (light) return { lots, closesAtUnixS: Number.isFinite(closesAtUnixS) ? closesAtUnixS : Infinity };

  // The cert, for every lot the pipeline could price.
  const chased = lots.filter((l) => GRADERS.includes(l.grader as (typeof GRADERS)[number]));
  console.log(`    fetching the cert for ${chased.length} PSA/CGC lot(s), ${CERT_CONCURRENCY} at a time`);
  let missing = 0;
  await parallel(chased, CERT_CONCURRENCY, async (lot) => {
    try {
      lot.cert = await certOf(lot.listingId);
    } catch (err) {
      console.warn(`    ⚠️  ${lot.lot}: no cert (${err instanceof Error ? err.message : err})`);
    }
    if (!lot.cert) missing++;
  });
  if (missing > 0) console.log(`    ${missing} of those have no cert on the listing`);

  return { lots, closesAtUnixS: Number.isFinite(closesAtUnixS) ? closesAtUnixS : Infinity };
}

// ── The venue ─────────────────────────────────────────────────────────────────

export const alt: Venue = {
  name: "Alt",
  key: "alt",
  outDir: "alt-sniper-runs",
  batchPrefix: "AltSniper",
  timeZone: TIME_ZONE,
  zoneLabel: "ET",
  sessionDir: SESSION_DIR,
  steps: ALT_STEPS,
  chaseList: false,
  // The whole auction extends together and ends together: see the note at
  // the top. 100 minutes after 9 PM ET is 10:40 PM, inside the 15-second
  // windows and ahead of every end but one in 26 auctions.
  closesTogether: true,
  fireAfterMinutes: 100,
  listingUrl,

  scan({ now, light }) {
    return scanAlt(now, light ?? false);
  },

  open({ headed, login, email, live }) {
    return openAlt({ headed, login, email, live });
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Said now, not after a scan: a live run has nowhere to go until the bid
  // request has been checked against the site.
  if (process.argv.includes("--live") && !BID_INPUT_VERIFIED) {
    console.error("\nSniper run failed: Alt live bidding is switched off in code until PlaceMaxBids' input has been verified — see the note at the top of scripts/alt-bidder.ts. A plan and --quote-only still work.");
    process.exit(1);
  }
  runAsMain(alt);
}
