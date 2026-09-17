/**
 * Alt — the closed Alt Auctions, for scripts/sold-report.ts.
 *
 * Alt keeps its sold lots in a second Typesense collection,
 * production_sold_listing_v2, which the site's own "Sold listings" toggle
 * reads. The search config the sniper already fetches (scripts/alt-sniper.ts)
 * carries a scoped key for it under pastAuctionSearch — no account, ten
 * minutes a key. A sold document has the card, the grade key, the auction's
 * name ("Aug 21 - Sep 04, 2026") and the price — which is the price paid
 * with the 20% buyer's premium in it, as Alt's help centre says of every
 * sold price it shows; the hammer is that less the premium. It has no cert
 * and no bid count: the cert comes off the public listing, as in the live
 * scan — for every PSA/CGC lot, since the Alt sniper chases every one — and
 * the bid count is simply not kept.
 *
 * The cycles are listed off the collection's own auctionName facet, newest
 * close first; Alt runs two-week cycles closing every Thursday at 9 PM ET.
 */

import { ALT, gqlPublic, listingUrl, lotLabel } from "./alt-bidder";
import { gradeKeys } from "./alt-sniper";
import { BUYERS_PREMIUM, GRADERS, fmtLocal, parallel } from "./sniper-core";
import type { SoldAuction, SoldLot } from "./sold-report";

const TIME_ZONE = "America/New_York";
/** Cycles close at 9 PM Eastern. */
const CLOSE_HOUR_ET = 21;
/** Lots the index serves per page, its ceiling. */
const PAGE = 250;
const KEY_MARGIN_S = 60;
const CERT_CONCURRENCY = 16;
/** Alt's grade key for a CGC Pristine 10. */
const CGC_PRISTINE_KEY = "CGC-PRI";

type SearchConfig = {
  serviceConfig: {
    search: {
      pastAuctionSearch: {
        clientConfig: { nodes: { host: string; port: number; protocol: string }[]; apiKey: string };
        collectionName: string;
        expiresAt: number;
      };
    };
  };
};

/** One sold document — the fields the report reads. */
type SoldDoc = {
  listingId: string;
  name?: string;
  gradingCompany?: string;
  grade?: string;
  gradeKey?: string;
  /** Dollars, buyer's premium included. */
  price?: number;
  auctionName?: string;
  soldDate?: string;
};

class SoldSearchKey {
  private url = "";
  private expiresAt = 0;

  async endpoint(): Promise<string> {
    if (this.url && this.expiresAt - Date.now() / 1000 > KEY_MARGIN_S) return this.url;
    const cfg = await gqlPublic<SearchConfig>("SearchServiceConfig", `
      query SearchServiceConfig {
        serviceConfig { search { pastAuctionSearch { clientConfig { nodes { host port protocol } apiKey } collectionName expiresAt } } }
      }`);
    const s = cfg.serviceConfig.search.pastAuctionSearch;
    const node = s.clientConfig.nodes[0];
    this.url = `${node.protocol}://${node.host}:${node.port}/multi_search?collection=${s.collectionName}&use_cache=true&x-typesense-api-key=${encodeURIComponent(s.clientConfig.apiKey)}`;
    this.expiresAt = s.expiresAt;
    return this.url;
  }
}

type SearchResult = { found?: number; hits?: { document: SoldDoc }[]; facet_counts?: { field_name: string; counts: { value: string; count: number }[] }[]; error?: string };

async function search(key: SoldSearchKey, params: Record<string, unknown>): Promise<SearchResult> {
  const res = await fetch(await key.endpoint(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ searches: [params] }),
  });
  if (!res.ok) throw new Error(`Alt sold search: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { results?: SearchResult[] };
  const result = json.results?.[0];
  if (!result) throw new Error("Alt sold search: empty response");
  if (result.error) throw new Error(`Alt sold search: ${result.error}`);
  return result;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Unix seconds for a wall-clock hour on a calendar day in a time zone. */
export function zonedUnixS(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.floor((guess - (local - guess)) / 1000);
}

/**
 * When a cycle closed, from its name: "Aug 21 - Sep 04, 2026" closes on Sep 4,
 * "Dec 19, 2025 - Jan 01, 2026" on Jan 1. Null for a name in any other shape.
 */
export function cycleCloseUnixS(name: string): number | null {
  const end = name.split(" - ").pop() ?? "";
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(end.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  if (month === 0) return null;
  return zonedUnixS(Number(m[3]), month, Number(m[2]), CLOSE_HOUR_ET, TIME_ZONE);
}

/** A sold document as the report reads it. The cert is filled in afterwards. */
export function toSoldLot(doc: SoldDoc, closedAtUnixS: number): SoldLot {
  const pristine = doc.gradeKey === CGC_PRISTINE_KEY;
  const grade = pristine ? 10 : Number(doc.grade);
  const grader = doc.gradingCompany ?? "";
  // The sold index leaves the grade out of the name; the chase list and the
  // block list read titles, and the sniper's read "… PSA 10", so it goes back.
  const title = `${doc.name ?? ""} ${grader} ${Number.isFinite(grade) ? grade : ""}${pristine ? " Pristine" : ""}`.trim();
  const allIn = doc.price ?? 0;
  return {
    listingId: doc.listingId,
    url: `${listingUrl(doc.listingId)}/sold`,
    title,
    grader,
    grade: Number.isFinite(grade) ? grade : undefined,
    pristine,
    cert: "",
    currentBid: Math.round((allIn / (1 + BUYERS_PREMIUM)) * 100) / 100,
    bidCount: 0,
    auction: doc.auctionName ?? "",
    lot: lotLabel(doc.listingId),
    language: /\bjapanese\b/i.test(title) ? "Japanese" : "English",
    closesAtUnixS: closedAtUnixS,
    hammer: Math.round((allIn / (1 + BUYERS_PREMIUM)) * 100) / 100,
    allIn,
    closedAtUnixS,
    houseValue: null,
    bidCountKnown: false,
  };
}

async function certOf(listingId: string): Promise<string> {
  const data = await gqlPublic<{ publicListing: { publicListing: { items: { attributes: { certNumber: string | null } | null }[] | null } | null } | null }>(
    "PublicListingWithTransaction",
    `query PublicListingWithTransaction($listingId: ID!) { publicListing(id: $listingId) { publicListing { id items { attributes { certNumber } } } } }`,
    { listingId });
  return (data.publicListing?.publicListing?.items?.[0]?.attributes?.certNumber ?? "").trim();
}

/**
 * The most recent `count` closed Alt Auctions, newest first, every sold
 * PSA/CGC 7–10 Pokémon lot in each, with its cert.
 */
export async function scanAltSold(opts: { count: number }): Promise<SoldAuction[]> {
  if (opts.count <= 0) return [];
  const key = new SoldSearchKey();
  const base = `category:[POKEMON_CARDS]&&gradingCompany:[${GRADERS.join(",")}]&&gradeKey:[${gradeKeys().join(",")}]`;

  const facet = await search(key, { q: "", preset: "recommended", filter_by: base, per_page: 0, facet_by: "auctionName", max_facet_values: 250 });
  const cycles = (facet.facet_counts?.[0]?.counts ?? [])
    .map((c) => ({ name: c.value, count: c.count, closedAtUnixS: cycleCloseUnixS(c.value) }))
    .filter((c): c is { name: string; count: number; closedAtUnixS: number } => c.closedAtUnixS !== null && c.closedAtUnixS < Date.now() / 1000)
    .sort((a, b) => b.closedAtUnixS - a.closedAtUnixS);
  if (cycles.length === 0) throw new Error("Alt's sold index names no closed auction with PSA/CGC Pokémon lots.");
  console.log(`    ${cycles.length} closed auction(s) in the sold index, newest ${cycles[0].name}`);
  if (cycles.length < opts.count) console.log(`    only ${cycles.length} could be found, ${opts.count} were asked for`);

  const auctions: SoldAuction[] = [];
  for (const cycle of cycles.slice(0, opts.count)) {
    const lots: SoldLot[] = [];
    let page = 1;
    let found = Infinity;
    let got = 0;
    while (got < found) {
      const res = await search(key, { q: "", preset: "price_desc", filter_by: `${base}&&auctionName:=\`${cycle.name}\``, per_page: PAGE, page });
      found = res.found ?? 0;
      got += res.hits?.length ?? 0;
      for (const { document } of res.hits ?? []) lots.push(toSoldLot(document, cycle.closedAtUnixS));
      if ((res.hits?.length ?? 0) < PAGE) break;
      page++;
    }

    // The cert, for every PSA/CGC lot: the Alt sniper has no chase list.
    const chased = lots.filter((l) => GRADERS.includes(l.grader as (typeof GRADERS)[number]));
    let missing = 0;
    await parallel(chased, CERT_CONCURRENCY, async (lot) => {
      try {
        lot.cert = await certOf(lot.listingId);
      } catch (err) {
        console.warn(`    ⚠️  ${lot.lot}: no cert (${err instanceof Error ? err.message : err})`);
      }
      if (!lot.cert) missing++;
    });
    console.log(`    ${cycle.name}  ·  closed ${fmtLocal(cycle.closedAtUnixS, TIME_ZONE, "ET")}  ·  ${lots.length} sold PSA/CGC 7–10 Pokémon lot(s)${missing > 0 ? `, ${missing} without a cert` : ""}`);
    auctions.push({ venue: "alt", id: cycle.name, name: cycle.name, closedAtUnixS: cycle.closedAtUnixS, lots });
  }
  return auctions;
}

export { ALT };
