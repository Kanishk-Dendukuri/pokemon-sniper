/**
 * Fanatics Collect — the closed Weekly Auctions, for scripts/sold-report.ts.
 *
 * The same Algolia index the sniper scans (scripts/fanatics-sniper.ts) keeps
 * every sold lot: status "Sold", the hammer in currentBid, the price paid
 * with the buyer's premium in purchasePrice, the bid count, and Fanatics' own
 * guide value. Nothing here needs an account — the search key comes off a
 * page load, as the sniper's does.
 *
 * Auctions are numbered and weekly, so the closed ones are walked by number:
 * the newest closed one from the site's own auction list, then one fewer at
 * a time, each looked up by name ("Weekly Sunday Auction #241" in the index,
 * "Weekly Auction #241" in the auction list). A number with no Pokémon lots
 * is skipped; a run of them means the index ends there.
 */

import { chromium } from "playwright";
import {
  AlgoliaKey,
  CATEGORIES,
  FANATICS,
  HIT_ATTRIBUTES,
  SCAN_CONCURRENCY,
  TIME_ZONE,
  algolia,
  collect,
  quote,
  toLot,
  type Hit,
} from "./fanatics-sniper";
import { BUYERS_PREMIUM, GRADERS, fmtLocal, gradeRanges, gradesIn, parallel } from "./sniper-core";
import type { SoldAuction, SoldLot } from "./sold-report";

/** The site's own list of auctions, closed ones included, which needs no account. */
const GRAPHQL = "https://app.fanaticscollect.com/graphql";
const AUCTIONS_QUERY = `
  query webGlobalAuctionsQuery {
    collectGlobalAuctions {
      __typename
      ... on CollectWeeklyAuction { id name status endsAt }
    }
  }
`;

/** Numbers with no lots in a row before the walk back stops. */
const MISSES_IN_A_ROW = 6;

/** "Weekly Auction #241", "Weekly Sunday Auction #241" → 241. */
export function auctionNumber(name: string | null | undefined): number | null {
  const n = /#\s*(\d+)/.exec(name ?? "")?.[1];
  return n ? Number(n) : null;
}

/** The two names an auction goes by, as one filter clause. */
export function auctionNameFilter(n: number): string {
  return `(auctionName:${quote(`Weekly Sunday Auction #${n}`)} OR auctionName:${quote(`Weekly Auction #${n}`)})`;
}

const BASE = [
  `marketplace:WEEKLY`,
  `status:Sold`,
  `(${GRADERS.map((g) => `gradingService:${g}`).join(" OR ")})`,
  `(${CATEGORIES.map((c) => `subCategory1:${quote(c)}`).join(" OR ")})`,
].join(" AND ");

/** The newest closed Weekly Auction's number, from the site's own list; null when it cannot be read. */
async function latestClosedNumber(): Promise<number | null> {
  try {
    const res = await fetch(GRAPHQL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationName: "webGlobalAuctionsQuery", query: AUCTIONS_QUERY, variables: {} }),
    });
    const json = (await res.json()) as { data?: { collectGlobalAuctions?: { __typename?: string; name?: string | null; status?: string | null }[] | null } };
    const closed = (json.data?.collectGlobalAuctions ?? [])
      .filter((a) => a.__typename === "CollectWeeklyAuction" && a.status === "CLOSED")
      .map((a) => auctionNumber(a.name))
      .filter((n): n is number => n !== null);
    return closed.length > 0 ? Math.max(...closed) : null;
  } catch {
    return null;
  }
}

/** What a sold record carries beyond the live one: the price paid all-in, and the house's own guide value. */
export type SoldHit = Hit & { purchasePrice?: number; value?: number };
const SOLD_ATTRIBUTES = [...HIT_ATTRIBUTES, "purchasePrice", "value"];

/** A sold Algolia record as the report reads it. */
export function toSoldLot(hit: SoldHit): SoldLot {
  const lot = toLot(hit);
  const hammer = hit.currentBid ?? 0;
  return {
    ...lot,
    url: `${FANATICS}/weekly/${hit.listingUuid}`,
    hammer,
    allIn: hit.purchasePrice ?? Math.round(hammer * (1 + BUYERS_PREMIUM) * 100) / 100,
    closedAtUnixS: hit.auctionEndDatetime ?? 0,
    houseValue: hit.value ?? null,
  };
}

/**
 * The most recent `count` closed Weekly Auctions, newest first, every sold
 * PSA/CGC 7–10 Pokémon lot in each.
 */
export async function scanFanaticsSold(opts: { count: number; headed: boolean }): Promise<SoldAuction[]> {
  if (opts.count <= 0) return [];
  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    const keyer = new AlgoliaKey(browser);
    let latest = await latestClosedNumber();
    if (latest === null) {
      // The list could not be read: the index's own names say what is newest.
      const facets = await algolia(keyer, { filters: BASE, hitsPerPage: 0, facets: ["auctionName"], maxValuesPerFacet: 1000 });
      const numbers = Object.keys(facets.facets?.auctionName ?? {}).map(auctionNumber).filter((n): n is number => n !== null);
      if (numbers.length === 0) throw new Error("No closed Weekly Auction could be found — neither the auction list nor the index names one.");
      latest = Math.max(...numbers);
      console.log(`    the auction list could not be read; the index's newest closed auction is #${latest}`);
    } else {
      console.log(`    newest closed auction is #${latest}`);
    }

    const auctions: SoldAuction[] = [];
    let misses = 0;
    for (let n = latest; n >= 1 && auctions.length < opts.count && misses < MISSES_IN_A_ROW; n--) {
      const probe = await algolia(keyer, {
        filters: `${BASE} AND ${auctionNameFilter(n)}`, hitsPerPage: 0,
        facets: ["auctionEndDatetime", "auctionName"], maxValuesPerFacet: 10,
      });
      const total = probe.nbHits ?? 0;
      if (total === 0) { misses++; continue; }
      misses = 0;

      const ends = Object.keys(probe.facets?.auctionEndDatetime ?? {}).map(Number).filter((t) => t > 0).sort((a, b) => b - a);
      const closedAtUnixS = ends[0] ?? 0;
      const name = Object.keys(probe.facets?.auctionName ?? {})[0] ?? `Weekly Auction #${n}`;

      // The same cells as the live scan — grader × grade × category — so each
      // fits a query or needs at most one split (scripts/fanatics-sniper.ts).
      const cells: string[] = [];
      for (const grader of GRADERS) {
        for (const grade of gradesIn(gradeRanges()[grader])) {
          for (const category of CATEGORIES) {
            cells.push(`${BASE} AND ${auctionNameFilter(n)} AND gradingService:${grader} AND grade:${grade} AND subCategory1:${quote(category)}`);
          }
        }
      }
      const collected = await parallel(cells, SCAN_CONCURRENCY, (filters) => collect(keyer, filters, [], 0, SOLD_ATTRIBUTES));
      const lots = collected.flat().map((h) => toSoldLot(h as SoldHit));
      console.log(`    ${name}  ·  closed ${closedAtUnixS ? fmtLocal(closedAtUnixS, TIME_ZONE, "PT") : "?"}  ·  ${lots.length} sold PSA/CGC Pokémon lot(s)`);
      auctions.push({ venue: "fanatics", id: String(n), name, closedAtUnixS, lots });
    }
    if (auctions.length < opts.count) {
      console.log(`    only ${auctions.length} closed auction(s) could be found, ${opts.count} were asked for`);
    }
    return auctions;
  } finally {
    await browser.close();
  }
}
