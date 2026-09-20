/**
 * When a set came out.
 *
 * The one guardrail the eBay sniper has that the auction-house snipers do
 * not: a card from a set released inside the last few months is not bought,
 * whatever the comps say. A set's first months are its most expensive — the
 * sales that price a card are hype sales, and the card is worth less by the
 * time it arrives — so the sniper refuses the whole set until it has aged.
 *
 * Where the dates come from. Limitless TCG lists every set in English with
 * its code and release date, one page for the English-language game and one
 * for the Japanese — which matters because Card Uploader names Japanese sets
 * in English ("Shiny Treasure ex", "Nihil Zero"), and the free set databases
 * carry Japanese sets under their Japanese names, or not at all. Both pages
 * are read once a day and kept on disk; a run that cannot fetch them uses the
 * copy it has, and a run with no copy at all refuses to start rather than bid
 * with the guardrail down.
 *
 * Matching is by name, since that is all a listing or a cert gives: the name
 * flattened (case, accents, punctuation, "&"), then with any series prefix a
 * seller typed in front of it ("Scarlet & Violet: Surging Sparks") taken off,
 * then as a substring. When more than one set fits, the newest is taken —
 * the guardrail fails closed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export type SetLanguage = "English" | "Japanese";

export type SetRelease = {
  name: string;
  /** Limitless's set code: SSP, PRE, M2a… */
  code: string;
  /** YYYY-MM-DD. */
  releaseDate: string;
  language: SetLanguage;
};

export const LIMITLESS_SETS: Record<SetLanguage, string> = {
  English: "https://limitlesstcg.com/cards",
  Japanese: "https://limitlesstcg.com/cards/jp",
};

/** Where the daily copy lives; under the run folder, next to the state. */
export const DEFAULT_SETS_CACHE = "ebay-sniper-runs/sets.json";
export const SETS_MAX_AGE_MS = 24 * 3_600_000;
/**
 * A page that parses to fewer sets than this has changed shape, and is
 * treated as unreadable rather than as a short list.
 */
const MIN_SETS_PER_PAGE = 20;
export const DEFAULT_NEW_SET_MONTHS = 6;

// ── Reading the Limitless pages ───────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "16 Sep 26" or "16 Sep 2026" as YYYY-MM-DD; null for anything else. A
 * two-digit year from 90 up is the 1990s — the game began in 1996.
 */
export function parseLimitlessDate(text: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = m[3].length === 2 ? (Number(m[3]) >= 90 ? 1900 : 2000) + Number(m[3]) : Number(m[3]);
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The name cell reads "Mega Dream ex M2a" — the name, then the code. A code
 * starts with a capital or a digit and has at least two of them ("SSP",
 * "M6a", "SV11B", "MGm"); "ex" and "Rising" are not codes.
 */
export function splitNameAndCode(cell: string): { name: string; code: string } {
  const words = cell.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const looksLikeCode = words.length > 1 && last.length >= 2 && /^[A-Z0-9][A-Za-z0-9.\-]+$/.test(last)
    && (last.match(/[A-Z0-9]/g) ?? []).length >= 2;
  if (!looksLikeCode) return { name: cell.trim(), code: "" };
  return { name: words.slice(0, -1).join(" "), code: last };
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Every set on one Limitless page: rows with a name cell and a date cell. */
export function parseLimitlessSets(html: string, language: SetLanguage): SetRelease[] {
  const sets: SetRelease[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((m) => unescapeHtml(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    if (cells.length < 2) continue;
    const releaseDate = parseLimitlessDate(cells[1]);
    if (!releaseDate) continue;
    const { name, code } = splitNameAndCode(cells[0]);
    if (!name) continue;
    sets.push({ name, code, releaseDate, language });
  }
  return sets;
}

export type SetsCache = { fetchedAt: string; sets: SetRelease[] };

/**
 * The set list, from the daily copy when it is fresh, else from Limitless —
 * and from a stale copy when Limitless will not answer. Nothing to fall back
 * on is an error: the guardrail is not run without its list.
 */
export async function loadSetReleases(opts: {
  cachePath?: string;
  maxAgeMs?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
} = {}): Promise<{ sets: SetRelease[]; fetchedAt: string; fromCache: boolean }> {
  const cachePath = opts.cachePath ?? DEFAULT_SETS_CACHE;
  const maxAgeMs = opts.maxAgeMs ?? SETS_MAX_AGE_MS;
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});

  let cached: SetsCache | null = null;
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, "utf-8")) as SetsCache;
    } catch {
      cached = null;
    }
  }
  if (cached && now.getTime() - Date.parse(cached.fetchedAt) < maxAgeMs) {
    return { sets: cached.sets, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  try {
    const sets: SetRelease[] = [];
    for (const language of ["English", "Japanese"] as SetLanguage[]) {
      const res = await fetchImpl(LIMITLESS_SETS[language], {
        headers: { "user-agent": "Mozilla/5.0 (pokemon-sniper set-date check)" },
      });
      if (!res.ok) throw new Error(`${LIMITLESS_SETS[language]} answered HTTP ${res.status}`);
      const page = parseLimitlessSets(await res.text(), language);
      if (page.length < MIN_SETS_PER_PAGE) throw new Error(`${LIMITLESS_SETS[language]} parsed to ${page.length} set(s) — the page has changed shape`);
      sets.push(...page);
    }
    const fetchedAt = now.toISOString();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAt, sets } satisfies SetsCache, null, 2));
    log(`    ${sets.length} sets read from Limitless TCG (${sets.filter((s) => s.language === "English").length} English, ${sets.filter((s) => s.language === "Japanese").length} Japanese)`);
    return { sets, fetchedAt, fromCache: false };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (cached) {
      log(`    ⚠️  could not refresh the set list (${why}); using the copy from ${cached.fetchedAt}`);
      return { sets: cached.sets, fetchedAt: cached.fetchedAt, fromCache: true };
    }
    throw new Error(`The set release dates could not be read (${why}) and there is no copy at ${cachePath}. The new-set guardrail cannot run without them.`);
  }
}

// ── Matching a name to a set ──────────────────────────────────────────────────

/** Series names sellers put in front of a set's: "Scarlet & Violet: Surging Sparks". */
const SERIES_PREFIXES = [
  "scarlet and violet", "sword and shield", "sun and moon", "black and white", "diamond and pearl",
  "heartgold soulsilver", "mega evolution", "pokemon tcg", "pokemon", "xy", "sv", "swsh", "sm", "me",
];

/** A set name flattened for comparison: no case, accents, punctuation, or "&". */
export function normaliseSetName(name: string): string {
  return name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The ways one typed name might be meant: as is; after a separator ("SV08:
 * Surging Sparks", "Sword & Shield - Evolving Skies"); with a series name or
 * a set code taken off the front. Longest first, so the plain name wins.
 */
export function nameVariants(name: string): string[] {
  const out = new Set<string>();
  const full = normaliseSetName(name);
  if (full) out.add(full);
  const parts = name.split(/[:\-–—|]/).map((p) => normaliseSetName(p)).filter((p) => p.length >= 2);
  if (parts.length > 1 && !SERIES_PREFIXES.includes(parts[parts.length - 1])) out.add(parts[parts.length - 1]);
  for (const base of [...out]) {
    for (const prefix of SERIES_PREFIXES) {
      if (base.startsWith(prefix + " ") && base.length - prefix.length - 1 >= 3) out.add(base.slice(prefix.length + 1));
    }
    // A set code typed before the name: "sv08 surging sparks", "me02 phantasmal flames".
    const coded = /^[a-z]{1,4}\d{1,3}[a-z]?\s+(.{3,})$/.exec(base);
    if (coded) out.add(coded[1]);
  }
  return [...out];
}

export type SetMatch = { set: SetRelease; how: "exact" | "contains" | "tokens" };

/** Words that say nothing about which set: the card types and the articles. */
const NOISE_TOKENS = new Set(["ex", "gx", "v", "the", "of", "and", "set", "pokemon"]);

/**
 * Whether two flattened names are the same set said two ways: every telling
 * word of the shorter is a word of the longer or the start of one ("terastal
 * fest ex" and "terastal festival ex"), the longer has at most one word to
 * spare, and one matched word is a real one — four letters as a prefix, or
 * three as a whole word ("151").
 */
export function tokensCompatible(a: string, b: string): boolean {
  const tokens = (s: string) => s.split(" ").filter((t) => t && !NOISE_TOKENS.has(t));
  let short = tokens(a);
  let long = tokens(b);
  if (short.length > long.length) [short, long] = [long, short];
  if (short.length === 0 || long.length - short.length > 1) return false;
  let strong = false;
  const spare = [...long];
  for (const t of short) {
    const i = spare.findIndex((l) => l === t || l.startsWith(t) || t.startsWith(l));
    if (i < 0) return false;
    const hit = spare.splice(i, 1)[0];
    if (hit === t ? t.length >= 3 : Math.min(t.length, hit.length) >= 4) strong = true;
  }
  return strong;
}

/**
 * The set a name means, or null. Exact on any variant first, preferring the
 * language given; then the name inside a set's or a set's inside the name,
 * six characters or more; then word by word. Several fits take the newest.
 * A set named for its series alone — "Scarlet & Violet", the base set — is
 * matched exactly and never as part of a longer name, since every set in
 * the series is typed with that prefix by someone.
 */
export function findSet(name: string, sets: SetRelease[], language?: SetLanguage): SetMatch | null {
  const variants = nameVariants(name);
  if (variants.length === 0) return null;
  const newest = (a: SetRelease, b: SetRelease) => (b.releaseDate > a.releaseDate ? b : a);
  const prefer = (hits: SetRelease[]): SetRelease | null => {
    if (hits.length === 0) return null;
    const same = language ? hits.filter((s) => s.language === language) : [];
    return (same.length > 0 ? same : hits).reduce(newest);
  };

  const indexed = sets.map((set) => ({ set, norm: normaliseSetName(set.name) })).filter((s) => s.norm);
  for (const v of variants) {
    const hit = prefer(indexed.filter((s) => s.norm === v).map((s) => s.set));
    if (hit) return { set: hit, how: "exact" };
  }
  const loose = indexed.filter((s) => !SERIES_PREFIXES.includes(s.norm));
  for (const v of variants) {
    if (v.length < 6) continue;
    const hit = prefer(loose.filter((s) => s.norm.length >= 6 && (v.includes(s.norm) || s.norm.includes(v))).map((s) => s.set));
    if (hit) return { set: hit, how: "contains" };
  }
  for (const v of variants) {
    const hit = prefer(loose.filter((s) => tokensCompatible(v, s.norm)).map((s) => s.set));
    if (hit) return { set: hit, how: "tokens" };
  }
  return null;
}

/** The same day `months` months ago, in UTC: 2026-09-17 less six months is 2026-03-17. */
export function cutoffDate(now: Date, months: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export type SetAgeVerdict = {
  match: SetMatch | null;
  /** Why the lot is refused, or null when the set is old enough or unknown. */
  blocked: string | null;
};

/**
 * Whether a set named like this is too new to buy from. A set released on or
 * after the cutoff — or not yet at all — is blocked. A name that matches no
 * set is not blocked here; whether an unknown set is bought is the caller's
 * rule, since it depends on what else is known about the card.
 */
export function setAgeVerdict(
  name: string,
  sets: SetRelease[],
  opts: { now: Date; months: number; language?: SetLanguage },
): SetAgeVerdict {
  const match = findSet(name, sets, opts.language);
  if (!match) return { match: null, blocked: null };
  const cutoff = cutoffDate(opts.now, opts.months);
  if (match.set.releaseDate >= cutoff) {
    return {
      match,
      blocked: `set "${match.set.name}"${match.set.code ? ` (${match.set.code})` : ""} released ${match.set.releaseDate}, inside the last ${opts.months} months`,
    };
  }
  return { match, blocked: null };
}
