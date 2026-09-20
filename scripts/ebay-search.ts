/**
 * eBay — finding the auctions.
 *
 * The Browse API, with an application token: a developer account's client id
 * and secret, no user sign-in, no approval beyond the keys themselves. It is
 * the read side of the eBay sniper only. eBay's own bidding API is closed to
 * new applications and its licence forbids a sniper outright, so the bid goes
 * through a signed-in browser instead — scripts/ebay-bidder.ts.
 *
 * Two calls do the work:
 *   - item_summary/search, for every live auction the chosen sellers have in
 *     the trading-card category, under Authenticity Guarantee. The filters
 *     are eBay's own: buyingOptions, sellers, qualifiedPrograms.
 *   - item/{id}, once per new listing, for the item specifics the search
 *     leaves out — grader, grade, cert number, set, language — plus the
 *     current bid, the least the site will take next, the end time, and what
 *     the listing charges to post. Postage worked out from the buyer's
 *     address is quoted only when the request names a postcode: EBAY_ZIP.
 *
 * The keys live in .env.local as EBAY_CLIENT_ID and EBAY_CLIENT_SECRET. The
 * API answers with its own clock in the Date header; the sniper reads that
 * off every response, because a bid five seconds before the end is measured
 * on eBay's clock rather than the PC's.
 */
import type { ScannedLot } from "./sniper-core";

export const BROWSE = "https://api.ebay.com/buy/browse/v1";
export const OAUTH_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
export const MARKETPLACE = "EBAY_US";
/** Toys & Hobbies > Collectible Card Games > CCG Individual Cards. */
export const CCG_INDIVIDUAL_CARDS = "183454";
export const DEFAULT_QUERY = "pokemon";
/** The most the search will page: eBay's own ceiling per query is 10,000. */
const SEARCH_PAGE = 200;
const SEARCH_MAX_OFFSET = 10_000;
/** Renew the application token this long before it lapses. */
const TOKEN_MARGIN_S = 120;
const REQUEST_TIMEOUT_MS = 30_000;
/** The Browse API's daily allowance for a new application; the run warns as it nears it. */
export const DAILY_CALL_ALLOWANCE = 5_000;

export type Money = { value: string; currency: string };

/**
 * One way the seller will post the item. FIXED options quote a price outright;
 * CALCULATED ones are worked out from the buyer's address, and eBay quotes
 * them only when the request names a postcode — see EbayApp's `zip`. An option
 * with no cost at all is one eBay would not put a number on.
 */
export type ShippingOption = {
  shippingServiceCode?: string;
  type?: string;
  shippingCostType?: string;
  shippingCost?: Money;
};

/** One search hit — the fields the run reads. */
export type ItemSummary = {
  itemId: string;
  legacyItemId?: string;
  title: string;
  itemWebUrl?: string;
  itemEndDate?: string;
  currentBidPrice?: Money;
  price?: Money;
  bidCount?: number;
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  buyingOptions?: string[];
  qualifiedPrograms?: string[];
  condition?: string;
  conditionId?: string;
  shippingOptions?: ShippingOption[];
  image?: { imageUrl?: string };
  additionalImages?: { imageUrl?: string }[];
};

/** The item page, as the API tells it. */
export type Item = ItemSummary & {
  localizedAspects?: { type?: string; name: string; value: string }[];
  minimumPriceToBid?: Money;
  uniqueBidderCount?: number;
  reservePriceMet?: boolean;
  itemEndDate?: string;
  eligibleForInlineCheckout?: boolean;
  /** Set on a listing that has ended or been taken down; absent while live. */
  itemEndDateEstimated?: boolean;
};

type SearchPage = { total?: number; limit?: number; offset?: number; itemSummaries?: ItemSummary[]; warnings?: unknown[] };

type ApiError = { errors?: { errorId?: number; message?: string; longMessage?: string }[] };

export class EbayApiError extends Error {
  constructor(message: string, readonly status: number, readonly errorId?: number) {
    super(message);
  }
}

/** "v1|123456789012|0" → "123456789012": the number in the listing's URL. */
export function legacyId(itemId: string): string {
  const parts = itemId.split("|");
  return parts.length === 3 ? parts[1] : itemId;
}

/** The listing's page. */
export function itemUrl(id: string): string {
  return `https://www.ebay.com/itm/${legacyId(id)}`;
}

/** Unix milliseconds from the API's ISO end time; null when it gives none. */
export function parseEndDate(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How far the PC's clock is from eBay's, from a response's Date header —
 * eBay's time minus ours, to the second. Positive means the PC runs slow.
 */
export function clockOffsetFrom(dateHeader: string | null, nowMs: number): number | null {
  if (!dateHeader) return null;
  const serverMs = Date.parse(dateHeader);
  return Number.isFinite(serverMs) ? serverMs - nowMs : null;
}

/** The search filter: live auctions, from these sellers, under Authenticity Guarantee. */
export function searchFilter(opts: { sellers: string[]; authenticityGuarantee?: boolean; zip?: string; country?: string }): string {
  const parts = ["buyingOptions:{AUCTION}"];
  const sellers = opts.sellers.map((s) => s.trim()).filter(Boolean);
  if (sellers.length > 0) parts.push(`sellers:{${sellers.join("|")}}`);
  if (opts.authenticityGuarantee ?? true) {
    // eBay will not filter on Authenticity Guarantee without somewhere to
    // deliver to: the programme is a per-country one, and the search refuses
    // the filter outright when the request does not say where the buyer is.
    const zip = opts.zip?.trim();
    if (!zip) {
      throw new Error("eBay's Authenticity Guarantee filter needs a delivery postcode — pass --zip=<postcode>, or set EBAY_ZIP in .env.local.");
    }
    parts.push("qualifiedPrograms:{AUTHENTICITY_GUARANTEE}", `deliveryCountry:${opts.country ?? "US"}`, `deliveryPostalCode:${zip}`);
  }
  return parts.join(",");
}

/** Cents from a Money figure; 0 when there is none. */
export function centsOf(money: Money | undefined): number {
  const n = Number(money?.value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// ── The application ───────────────────────────────────────────────────────────

/**
 * What the listing charges to post it, in cents: the cheapest option eBay put
 * a price on. Free postage is 0. Null means eBay quoted nothing this call
 * could read — a calculated rate with no postcode given, or a listing that
 * names no option at all — and the caller decides what to assume; it is never
 * read as free, because a guess of zero would be a guess in the wrong
 * direction.
 */
/**
 * The photographs, the listing's own first. Every one of these sellers shows
 * the slab label in the first picture; the rest are there for the runs where
 * it does not read.
 */
export function imageUrls(item: Pick<ItemSummary, "image" | "additionalImages">): string[] {
  const urls = [item.image?.imageUrl, ...(item.additionalImages ?? []).map((i) => i.imageUrl)];
  return [...new Set(urls.filter((u): u is string => !!u))];
}

export function shippingCents(item: Pick<ItemSummary, "shippingOptions">): number | null {
  let cheapest: number | null = null;
  for (const option of item.shippingOptions ?? []) {
    if (option.shippingCost?.value === undefined) continue;
    const cents = centsOf(option.shippingCost);
    if (!Number.isFinite(cents) || cents < 0) continue;
    if (cheapest === null || cents < cheapest) cheapest = cents;
  }
  return cheapest;
}

export class EbayApp {
  private token = "";
  private tokenExpiresAtMs = 0;
  /** Calls made since the app was opened, for the daily allowance. */
  calls = 0;
  /** eBay's clock minus the PC's, in milliseconds, from the last response. */
  clockOffsetMs: number | null = null;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string },
    private readonly fetchImpl: typeof fetch = fetch,
    /** The buyer's postcode, so eBay quotes calculated postage. */
    readonly zip: string = "",
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): EbayApp {
    const clientId = env.EBAY_CLIENT_ID?.trim();
    const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are not set in .env.local — the keys from a developer.ebay.com application, production keyset.");
    }
    if (/SBX/.test(clientId) || /SBX/.test(clientSecret)) {
      throw new Error("those are sandbox keys (the id carries SBX) and the sandbox has no real listings — copy the Production App ID and Cert ID from developer.ebay.com into .env.local.");
    }
    return new EbayApp({ clientId, clientSecret }, fetchImpl, env.EBAY_ZIP?.trim() ?? "");
  }

  /** eBay's time now, as best the last response said. */
  nowMs(): number {
    return Date.now() + (this.clockOffsetMs ?? 0);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.tokenExpiresAtMs - Date.now() > TOKEN_MARGIN_S * 1_000) return this.token;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.calls++;
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new EbayApiError(`eBay would not issue an application token (HTTP ${res.status}: ${body.error_description ?? body.error ?? "no detail"}) — check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET`, res.status);
    }
    this.token = body.access_token;
    this.tokenExpiresAtMs = Date.now() + (body.expires_in ?? 7_200) * 1_000;
    return this.token;
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BROWSE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
        accept: "application/json",
      };
      // Postage worked out from the buyer's address is quoted only when the
      // request says where the buyer is.
      if (this.zip) headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=${encodeURIComponent(`country=US,zip=${this.zip}`)}`;
      const res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.calls++;
      const offset = clockOffsetFrom(res.headers.get("date"), Date.now());
      if (offset !== null) this.clockOffsetMs = offset;
      if (res.status === 401 && attempt === 1) { this.token = ""; continue; }
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 200);
        let errorId: number | undefined;
        try {
          const err = JSON.parse(text) as ApiError;
          const first = err.errors?.[0];
          if (first) { detail = first.longMessage ?? first.message ?? detail; errorId = first.errorId; }
        } catch { /* not JSON */ }
        throw new EbayApiError(`eBay ${path} answered HTTP ${res.status}: ${detail}`, res.status, errorId);
      }
      return JSON.parse(text) as T;
    }
    throw new EbayApiError(`eBay ${path}: the token was refused twice`, 401);
  }

  /** One page of search results. */
  search(params: Record<string, string>): Promise<SearchPage> {
    return this.get<SearchPage>("/item_summary/search", params);
  }

  /** The item, with its specifics and where the bidding stands. */
  item(itemId: string): Promise<Item> {
    return this.get<Item>(`/item/${encodeURIComponent(itemId)}`);
  }
}

/**
 * Every live auction the sellers have in the category, under Authenticity
 * Guarantee, matching the query. Paged to the end, or to eBay's ceiling.
 */
export async function searchAuctions(
  app: EbayApp,
  opts: {
    sellers: string[]; query?: string; categoryId?: string; authenticityGuarantee?: boolean; zip?: string;
    /**
     * Stop paging once the results run past this moment. The search comes
     * back soonest-ending first, so everything after it ends later still —
     * and a lot that ends in three days is not worth a call today. Without
     * it these sellers' thirty thousand live auctions would cost fifty calls
     * a scan against an allowance of five thousand a day.
     */
    endsBeforeMs?: number;
    log?: (line: string) => void;
  },
): Promise<ItemSummary[]> {
  const hits: ItemSummary[] = [];
  const seen = new Set<string>();
  const filter = searchFilter({ sellers: opts.sellers, authenticityGuarantee: opts.authenticityGuarantee, zip: opts.zip ?? app.zip });
  let total = Infinity;
  let pastHorizon = false;
  for (let offset = 0; offset < total && offset < SEARCH_MAX_OFFSET; offset += SEARCH_PAGE) {
    const page = await app.search({
      q: opts.query ?? DEFAULT_QUERY,
      category_ids: opts.categoryId ?? CCG_INDIVIDUAL_CARDS,
      filter,
      limit: String(SEARCH_PAGE),
      offset: String(offset),
      sort: "endingSoonest",
    });
    total = page.total ?? 0;
    const items = page.itemSummaries ?? [];
    for (const item of items) {
      if (opts.endsBeforeMs !== undefined) {
        const ends = parseEndDate(item.itemEndDate);
        if (ends !== null && ends > opts.endsBeforeMs) { pastHorizon = true; break; }
      }
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      hits.push(item);
    }
    if (pastHorizon || items.length < SEARCH_PAGE) break;
  }
  if (!pastHorizon && total > SEARCH_MAX_OFFSET) {
    opts.log?.(`    ⚠️  ${total} auctions match and only the first ${SEARCH_MAX_OFFSET} could be read; narrow the sellers or the query`);
  }
  return hits;
}

// ── The item specifics ────────────────────────────────────────────────────────

export type Aspects = {
  /** PSA, CGC, BGS… or "" when the listing does not say. */
  grader: string;
  grade?: number;
  cert: string;
  set: string;
  cardName: string;
  cardNumber: string;
  language: "English" | "Japanese" | "";
  game: string;
  year: string;
};

/** "Professional Sports Authenticator (PSA)" → PSA, and the other graders likewise. */
export function graderOf(text: string): string {
  const t = text.toUpperCase();
  if (/\bPSA\b|PROFESSIONAL SPORTS AUTHENTICATOR/.test(t)) return "PSA";
  if (/\bCGC\b|CERTIFIED GUARANTY/.test(t)) return "CGC";
  if (/\bBGS\b|BECKETT/.test(t)) return "BGS";
  if (/\bSGC\b|SPORTSCARD GUARANTY/.test(t)) return "SGC";
  if (/\bACE\b/.test(t)) return "ACE";
  if (/\bTAG\b/.test(t)) return "TAG";
  return text.trim().toUpperCase().split(/\s+/)[0] ?? "";
}

/** The number in "10", "9.5", "Gem Mint 10", "GEM MT 10"; undefined when there is none. */
export function gradeOf(text: string): number | undefined {
  const m = /(\d{1,2}(?:\.\d)?)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : undefined;
}

const ASPECT_NAMES: Record<keyof Omit<Aspects, "grade">, string[]> = {
  grader: ["professional grader", "grader", "grading company", "graded by"],
  cert: ["certification number", "cert number", "certificate number", "cert #", "serial number"],
  set: ["set", "expansion", "card set"],
  cardName: ["card name", "character", "name"],
  cardNumber: ["card number", "number", "card #"],
  language: ["language"],
  game: ["game", "franchise", "tcg"],
  year: ["year manufactured", "year", "release year"],
};
const GRADE_NAMES = ["grade", "card grade", "card condition grade"];

/**
 * The listing's item specifics as the pipeline wants them. What the seller
 * left out is read off the title where it can be — the grader and grade are
 * nearly always there — and left blank where it cannot; a lot without a cert
 * is not priced.
 */
export function readAspects(item: Pick<Item, "localizedAspects" | "title">): Aspects {
  const byName = new Map<string, string>();
  for (const a of item.localizedAspects ?? []) {
    const key = a.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, a.value.trim());
  }
  const pick = (names: string[]) => names.map((n) => byName.get(n)).find((v) => v) ?? "";

  const title = item.title ?? "";
  const titleGrade = /\b(PSA|CGC|BGS|SGC)\s*(?:GEM\s*(?:MT|MINT)\s*|MINT\s*|PRISTINE\s*)?(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b/i.exec(title);

  const graderText = pick(ASPECT_NAMES.grader);
  const grader = graderText ? graderOf(graderText) : titleGrade ? titleGrade[1].toUpperCase() : "";
  const gradeText = pick(GRADE_NAMES);
  const grade = gradeText ? gradeOf(gradeText) : titleGrade ? Number(titleGrade[2]) : undefined;

  const languageText = pick(ASPECT_NAMES.language) || (/\bjapanese\b/i.test(title) ? "Japanese" : "");
  const language: Aspects["language"] = /japanese/i.test(languageText) ? "Japanese" : /english/i.test(languageText) ? "English" : "";

  return {
    grader,
    grade,
    cert: pick(ASPECT_NAMES.cert).replace(/\s+/g, ""),
    set: pick(ASPECT_NAMES.set),
    cardName: pick(ASPECT_NAMES.cardName),
    cardNumber: pick(ASPECT_NAMES.cardNumber),
    language,
    game: pick(ASPECT_NAMES.game) || (/pok[eé]mon/i.test(title) ? "Pokémon TCG" : ""),
    year: pick(ASPECT_NAMES.year),
  };
}

/** Whether the listing is under eBay's Authenticity Guarantee, as the API reports it. */
export function authenticityGuaranteed(item: Pick<ItemSummary, "qualifiedPrograms">): boolean {
  return (item.qualifiedPrograms ?? []).some((p) => /AUTHENTICITY_GUARANTEE/i.test(p));
}

/** A listing as the pipeline reads it. The seller stands in for the auction's name, the item number for the lot's. */
export function toLot(item: Item, aspects: Aspects = readAspects(item)): ScannedLot {
  const endMs = parseEndDate(item.itemEndDate);
  return {
    listingId: item.itemId,
    url: item.itemWebUrl ?? itemUrl(item.itemId),
    title: item.title,
    grader: aspects.grader,
    grade: aspects.grade,
    pristine: /\bpristine\b/i.test(item.title) || /pristine/i.test(pick(item, GRADE_NAMES)),
    cert: aspects.cert,
    currentBid: centsOf(item.currentBidPrice ?? item.price) / 100,
    bidCount: item.bidCount ?? 0,
    auction: item.seller?.username ?? "",
    lot: legacyId(item.itemId),
    language: aspects.language,
    closesAtUnixS: endMs === null ? undefined : Math.floor(endMs / 1000),
  };
}

function pick(item: Pick<Item, "localizedAspects">, names: string[]): string {
  for (const a of item.localizedAspects ?? []) {
    if (names.includes(a.name.trim().toLowerCase())) return a.value;
  }
  return "";
}
