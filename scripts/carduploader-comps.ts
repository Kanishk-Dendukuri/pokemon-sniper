/**
 * Card Uploader — the comps behind a batch's prices
 *
 * A priced batch is more than the CSV it exports. Its data endpoint
 * (/backend/jobs/<id>/data) carries, per card, the Alt Value it filled in,
 * Card Ladder's own estimate for the cert, the last sale and the five most
 * recent sales with their dates and venues — everything a human looks at on
 * the batch page before deciding whether to believe the number. One call per
 * batch, no credits.
 *
 * scripts/carduploader-batch.ts writes it as `comps.json` beside the CSV, keyed
 * "GRADER|cert", and scripts/import-valuations.ts reads it back to judge each
 * price against its comps (lib/price-confidence.ts). A run directory without
 * one imports exactly as before — the file is evidence, not a requirement.
 *
 * The bearer Card Uploader's backend wants is lifted off the page's own
 * requests, the same way scripts/sniper-core.ts does it: the app keeps the
 * token in memory rather than a cookie, and every dashboard load makes
 * authenticated calls it can be read from.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Page } from "playwright";
import type { CertComps, Sale } from "@/lib/price-confidence";

export const COMPS_FILE = "comps.json";

/** Keyed "GRADER|cert" — the same key the valuation import matches slabs on. */
export type CompsByCert = Record<string, CertComps>;

export function compsKey(grader: string, cert: string): string {
  return `${grader.trim().toUpperCase()}|${cert.trim()}`;
}

/** The slow tail on Card Uploader's backend sits around 40 s; a minute leaves it room. */
const REQUEST_TIMEOUT_MS = 60_000;

export type Bearer = { current: () => string };

/**
 * Starts listening for the backend's bearer on every request the page makes.
 * Attach before the first navigation — the token is only ever seen in flight.
 */
export function captureBearer(page: Page, base: string): Bearer {
  let token = "";
  page.on("request", (request) => {
    if (!request.url().startsWith(`${base}/backend/`)) return;
    const auth = request.headers()["authorization"];
    if (auth) token = auth;
  });
  return { current: () => token };
}

/** One card as the batch data endpoint returns it — only the fields read here. */
export type JobCard = {
  certificationNumber?: string | number | null;
  gradingCompany?: string | null;
  /** The price the batch filled in, as a string ("726.25") or blank. */
  price?: string | number | null;
  /** Keyed by grader in lower case — `pricing.cgc.currentAltValue`. */
  pricing?: Record<string, { currentAltValue?: number | null } | null | undefined> | null;
  certPricing?: {
    estimate?: {
      value?: number | null;
      lastSaleDate?: string | null;
      lastSalePrice?: number | null;
    } | null;
    recentSales?: {
      price?: number | null;
      date?: string | null;
      platform?: string | null;
      listingType?: string | null;
      url?: string | null;
      title?: string | null;
    }[] | null;
  } | null;
};

type JobData = { results?: { cards?: JobCard[] | null } | null };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Pulls the comps out of a batch's cards. Pure, so the mapping can be tested
 * against a captured payload without a browser.
 *
 * A card with no cert or no grader cannot be matched to a slab and is dropped.
 * A card with a cert but no comps is kept with empty sales: "Card Uploader
 * had nothing" is itself the answer the confidence check needs.
 */
export function compsFromJobCards(cards: JobCard[], fetchedAt: Date = new Date()): CompsByCert {
  const out: CompsByCert = {};
  for (const card of cards) {
    const cert = card.certificationNumber === null || card.certificationNumber === undefined
      ? "" : String(card.certificationNumber).trim();
    const grader = (card.gradingCompany ?? "").trim().toUpperCase();
    if (!cert || !grader) continue;

    const altFromPricing = Object.values(card.pricing ?? {})
      .map((p) => num(p?.currentAltValue))
      .find((v): v is number => v !== null) ?? null;
    const estimate = card.certPricing?.estimate ?? null;
    const lastPrice = num(estimate?.lastSalePrice);

    const sales: Sale[] = (card.certPricing?.recentSales ?? [])
      .flatMap((s) => {
        const price = num(s.price);
        if (price === null || !s.date) return [];
        const sale: Sale = { price, date: s.date };
        if (s.platform) sale.platform = s.platform;
        if (s.listingType) sale.listingType = s.listingType;
        if (s.url) sale.url = s.url;
        if (s.title) sale.title = s.title;
        return [sale];
      });

    out[compsKey(grader, cert)] = {
      cert,
      grader,
      altValue: num(card.price) ?? altFromPricing,
      cardLadderValue: num(estimate?.value),
      lastSale: lastPrice !== null && estimate?.lastSaleDate
        ? { price: lastPrice, date: estimate.lastSaleDate }
        : null,
      sales,
      fetchedAt: fetchedAt.toISOString(),
    };
  }
  return out;
}

/** The comps for every card in one batch, off its data endpoint. */
export async function fetchJobComps(
  page: Page,
  bearer: Bearer,
  base: string,
  jobId: string,
): Promise<CompsByCert> {
  const token = bearer.current();
  if (!token) throw new Error("No Card Uploader API token captured — the page made no authenticated request.");

  const res = await page.request.get(`${base}/backend/jobs/${encodeURIComponent(jobId)}/data`, {
    headers: { authorization: token },
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (!res.ok()) {
    throw new Error(`/backend/jobs/${jobId}/data: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as JobData;
  return compsFromJobCards(data.results?.cards ?? []);
}

/** The comps file in a run directory, or null when the run wrote none. */
export function readComps(dir: string): CompsByCert | null {
  const path = join(dir, COMPS_FILE);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a comps file`);
  }
  return parsed as CompsByCert;
}

/** The comps beside a CSV — the file its run directory holds, if any. */
export function compsBeside(csvPath: string): CompsByCert | null {
  return readComps(dirname(csvPath));
}

/**
 * Adds a batch's comps to the run's file. Read-modify-write, because a run
 * prices one batch after another into the same directory and each one's comps
 * have to survive the next.
 */
export function mergeComps(dir: string, comps: CompsByCert): { added: number; total: number } {
  const existing = readComps(dir) ?? {};
  const before = Object.keys(existing).length;
  const merged = { ...existing, ...comps };
  writeFileSync(join(dir, COMPS_FILE), JSON.stringify(merged, null, 1) + "\n");
  const total = Object.keys(merged).length;
  return { added: total - before, total };
}
