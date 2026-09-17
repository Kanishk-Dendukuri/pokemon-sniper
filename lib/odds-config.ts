/**
 * Pack odds configuration — the single source the database is seeded from
 * (db/migrate.ts), the catalog prints from (data/packs.ts), the classifier
 * brackets inventory with (lib/inventory-classification.ts), and the pull
 * engine rolls against (lib/pull-engine.ts, after reading the same numbers
 * back out of bracket_odds / tier_bands for the version a session was sold
 * under, inside the pull transaction).
 *
 * Odds version 6 — the full odds & pricing revamp (Sept 2026):
 *
 *   - Relics is $15 and Enchanted is $30 (they were $10 and $25). Every
 *     other tier keeps its price. Tier names, slugs and order are unchanged.
 *   - Five value brackets per pack in strict descending probability order.
 *     The SAME odds apply to every one of the eight tiers; only the dollar
 *     bands differ per tier. Normal 62.6 / 25.7 / 8.6 / 2.2 / 0.9;
 *     Jackpot Mode ("high") 80.1 / 12.0 / 3.0 / 2.5 / 2.4.
 *   - Every bracket splits at its exact arithmetic midpoint into a low half
 *     and a high half; 75% of the bracket's probability lands in the low
 *     half, 25% in the high half (it was 70/30). This is a modelling device
 *     that produces realistic low-skewed card values. It is NOT a rarity
 *     tier, has no customer-facing name, and must never leave the server
 *     (see publicOddsFor, which is the only shape the public API and the UI
 *     receive). The split is versioned: the database carries it per odds
 *     version (odds_versions.sub_low_ppm) so a pull sold under 70/30 still
 *     replays under 70/30 after this table went live.
 *   - Epic begins ABOVE the pack price — about 135% of it — so the smallest
 *     Epic pull is a gain, not break-even. Ultra Rare also ENDS above the
 *     price (about 125%), so part of every tier's Ultra Rare band is a
 *     winning pull: "Epic or better" is NOT the profit boundary on any tier
 *     and must not be described that way anywhere. See profitProbabilityPpm.
 *   - The bands are deliberately NOT contiguous. On every tier there is a
 *     gap between the Ultra Rare ceiling and the Epic floor, and a gap
 *     between the Legendary ceiling and the Jackpot floor. Across the whole
 *     ladder two ranges can be awarded by no tier at all — below $7.50,
 *     above $16,925, and $7,325–$13,550 between Gaia's jackpot ceiling and
 *     Infernal's jackpot floor. All of that is intentional; see
 *     unawardableRanges, which the sourcing check and the review queue use.
 *     Do not close any of it.
 *
 * Money is integer cents everywhere. Probabilities are integer parts per
 * million (numeric(9,6) in the database), so "sums to exactly 100%" is an
 * integer equality, never a float comparison. No floating point touches a
 * money value or an odds comparison in this module; the expected-value
 * arithmetic runs in BigInt because the exact numerator overflows 2^53.
 *
 * Client-safe: no server imports, so the pack page can print the table for
 * either mode without a round trip (the live endpoint then confirms it).
 */

export const VOLATILITY_MODES = ["normal", "high"] as const;
export type VolatilityMode = (typeof VOLATILITY_MODES)[number];

export const ODDS_BRACKET_KEYS = ["common", "ultra_rare", "epic", "legendary", "jackpot"] as const;
export type OddsBracketKey = (typeof ODDS_BRACKET_KEYS)[number];

export const SUB_HALVES = ["low", "high"] as const;
export type SubHalf = (typeof SUB_HALVES)[number];

/** One million parts = 100.0000%. Matches numeric(9,6) exactly. */
export const PPM = 1_000_000;

/**
 * Bumped whenever the odds, the bands, the sub-split or a price change.
 * Every pull session snapshots the version it was sold under
 * (pull_session.odds_version → odds_config.version → odds_versions.id) and
 * every pull records the version it rolled against (pulls.odds_version), so
 * a pull can be replayed against the exact table that was live for it.
 */
export const ODDS_VERSION = 6;

/** Stored on the odds_versions row the migration seeds for this table. */
export const ODDS_VERSION_LABEL = "v6 — full odds & pricing revamp (Sept 2026): $15 / $30 entry tiers, 75/25 halves, 40 new bands";

/**
 * Published bracket odds per mode, in parts per million.
 *
 *   Normal: 62.6 / 25.7 / 8.6 / 2.2 / 0.9
 *   High:   80.1 / 12.0 / 3.0 / 2.5 / 2.4
 */
export const BRACKET_ODDS_PPM: Record<VolatilityMode, Record<OddsBracketKey, number>> = {
  normal: { common: 626_000, ultra_rare: 257_000, epic: 86_000, legendary: 22_000, jackpot: 9_000 },
  high:   { common: 801_000, ultra_rare: 120_000, epic: 30_000, legendary: 25_000, jackpot: 24_000 },
};

/**
 * INTERNAL. 75% of a bracket's probability goes to its low half, 25% to its
 * high half — one constant for all 80 sub-brackets. This is the split for
 * THIS version of the table; the database stores the split of every
 * version, and the engine and the replay read the stored one.
 */
export const SUB_HALF_PPM: Record<SubHalf, number> = { low: 750_000, high: 250_000 };

export interface TierBand {
  lowFloorCents: number;
  /** Exact arithmetic midpoint of the bracket: (lowFloor + highCeil) / 2. Internal. */
  midpointCents: number;
  highCeilCents: number;
}

export interface TierConfig {
  /** URL-facing identity: /packs/<slug>, /api/packs/<slug>/odds, data/packs.ts id. */
  slug: string;
  displayName: string;
  /** Other names this tier goes by (the spec calls the $50 tier "Mythic"; it sells as Olympus). */
  aliases: string[];
  priceCents: number;
  sortOrder: number;
  bands: Record<OddsBracketKey, TierBand>;
}

/**
 * Per-tier dollar bands, `[low_floor, high_ceil]` in cents. The midpoint is
 * derived (exact arithmetic midpoint), never typed by hand, so it cannot
 * drift from the halves it separates.
 *
 * Structural facts, all asserted below and pinned by tests:
 *   1. epic.low_floor == EPIC_FLOOR_CENTS for the tier, ~135% of the pack
 *      price on every tier ($20 on Relics = 133%, $335 on Sovereign = 134%).
 *   2. ultra_rare.high_ceil == ULTRA_RARE_CEILING_CENTS, ~125% of the price,
 *      and ultra_rare's midpoint sits BELOW the price everywhere, so the
 *      winning part of the band lies entirely inside its high half.
 *   3. common→ultra_rare and epic→legendary are contiguous; ultra_rare→epic
 *      and legendary→jackpot are gaps on EVERY tier. No card is ever selected
 *      from a gap. Do not close them.
 */
const band = (lowFloorCents: number, highCeilCents: number): TierBand => {
  const sum = lowFloorCents + highCeilCents;
  if (sum % 2 !== 0) {
    throw new Error(`odds-config: band ${lowFloorCents}–${highCeilCents} has no whole-cent midpoint`);
  }
  return { lowFloorCents, midpointCents: sum / 2, highCeilCents };
};

const tier = (
  slug: string,
  displayName: string,
  aliases: string[],
  priceCents: number,
  sortOrder: number,
  ranges: [[number, number], [number, number], [number, number], [number, number], [number, number]],
): TierConfig => ({
  slug,
  displayName,
  aliases,
  priceCents,
  sortOrder,
  bands: {
    common:     band(...ranges[0]),
    ultra_rare: band(...ranges[1]),
    epic:       band(...ranges[2]),
    legendary:  band(...ranges[3]),
    jackpot:    band(...ranges[4]),
  },
});

export const TIER_CONFIGS: readonly TierConfig[] = [
  tier("relics",    "Relics Pack",    [],                        1_500,   1, [[750, 1_000],       [1_000, 1_900],       [2_000, 3_700],       [3_700, 6_600],       [9_800, 12_000]]),
  tier("enchanted", "Enchanted Pack", [],                        3_000,   2, [[1_500, 2_000],     [2_000, 3_800],       [4_050, 7_800],       [7_800, 13_000],      [19_500, 25_000]]),
  tier("olympus",   "Olympus Pack",   ["Mythic Pack", "Mythic"], 5_000,   3, [[2_500, 3_400],     [3_400, 6_200],       [6_750, 13_000],      [13_000, 20_500],     [33_500, 41_500]]),
  tier("ascended",  "Ascended Pack",  [],                        10_000,  4, [[5_400, 6_800],     [6_800, 12_500],      [13_500, 25_500],     [25_500, 37_500],     [69_500, 86_500]]),
  tier("sovereign", "Sovereign Pack", [],                        25_000,  5, [[14_000, 17_500],   [17_500, 31_000],     [33_500, 62_500],     [62_500, 83_500],     [162_500, 202_500]]),
  tier("nebula",    "Nebula Pack",    [],                        50_000,  6, [[30_000, 34_500],   [34_500, 62_500],     [67_500, 122_500],    [122_500, 150_000],   [300_000, 380_000]]),
  tier("gaia",      "Gaia Pack",      [],                        100_000, 7, [[63_000, 70_500],   [70_500, 125_000],    [135_000, 197_500],   [197_500, 267_500],   [582_500, 732_500]]),
  tier("infernal",  "Infernal Pack",  [],                        250_000, 8, [[165_000, 180_000], [180_000, 312_500],   [337_500, 435_000],   [435_000, 587_500],   [1_355_000, 1_692_500]]),
];

/**
 * The Epic floor for every tier, in cents. A second, independent copy of the
 * number typed into TIER_CONFIGS above, so a typo in one is caught by the
 * assertion below rather than quietly shipping a different band. About 135%
 * of the pack price: exactly that on Enchanted, Olympus, Ascended, Nebula,
 * Gaia and Infernal; $20 (133%) on Relics and $335 (134%) on Sovereign, the
 * figures the published table prints.
 */
export const EPIC_FLOOR_CENTS: Record<string, number> = {
  relics:       2_000,
  enchanted:    4_050,
  olympus:      6_750,
  ascended:    13_500,
  sovereign:   33_500,
  nebula:      67_500,
  gaia:       135_000,
  infernal:   337_500,
};

/**
 * The Ultra Rare ceiling for every tier, in cents — the same second-copy
 * discipline. About 125% of the pack price: exactly that on Ascended,
 * Nebula, Gaia and Infernal; $19 / $38 (127%) on Relics and Enchanted; $62
 * (124%) on Olympus; $310 (124%) on Sovereign. Every one sits ABOVE the pack
 * price, so the Ultra Rare band straddles break-even on all eight tiers.
 */
export const ULTRA_RARE_CEILING_CENTS: Record<string, number> = {
  relics:       1_900,
  enchanted:    3_800,
  olympus:      6_200,
  ascended:    12_500,
  sovereign:   31_000,
  nebula:      62_500,
  gaia:       125_000,
  infernal:   312_500,
};

export function getTierConfig(slug: string): TierConfig | undefined {
  return TIER_CONFIGS.find((t) => t.slug === slug);
}

export function isVolatilityMode(value: unknown): value is VolatilityMode {
  return value === "normal" || value === "high";
}

/**
 * Server-authoritative parse of a client-supplied mode. Absent → the default
 * ("normal"); anything that is not exactly one of the two modes → null, which
 * callers turn into a 400. Never coerces.
 */
export function parseVolatilityMode(value: unknown, fallback: VolatilityMode = "normal"): VolatilityMode | null {
  if (value === undefined || value === null || value === "") return fallback;
  return isVolatilityMode(value) ? value : null;
}

// ── Integrity ─────────────────────────────────────────────────────────────

/**
 * Every rule the spec makes structural, checked as integer equalities. Runs
 * at module load (below) so a bad table cannot be imported, and again by the
 * migration before it seeds, and by the tests.
 */
export function assertOddsConfig(): void {
  for (const mode of VOLATILITY_MODES) {
    const odds = BRACKET_ODDS_PPM[mode];
    const sum = ODDS_BRACKET_KEYS.reduce((s, k) => s + odds[k], 0);
    if (sum !== PPM) throw new Error(`odds-config: ${mode} odds sum to ${sum} ppm, not ${PPM}`);
    for (let i = 1; i < ODDS_BRACKET_KEYS.length; i++) {
      const prev = odds[ODDS_BRACKET_KEYS[i - 1]];
      const cur = odds[ODDS_BRACKET_KEYS[i]];
      if (!(prev > cur)) {
        throw new Error(`odds-config: ${mode} odds are not strictly descending at ${ODDS_BRACKET_KEYS[i]}`);
      }
    }
    for (const k of ODDS_BRACKET_KEYS) {
      if (!Number.isInteger(odds[k]) || odds[k] <= 0 || odds[k] >= PPM) {
        throw new Error(`odds-config: ${mode}.${k} probability ${odds[k]} is out of (0, 1)`);
      }
    }
  }
  if (!Number.isInteger(SUB_HALF_PPM.low) || SUB_HALF_PPM.low <= 0 || SUB_HALF_PPM.low >= PPM) {
    throw new Error("odds-config: sub-half low share is out of (0, 1)");
  }
  if (SUB_HALF_PPM.low + SUB_HALF_PPM.high !== PPM) throw new Error("odds-config: sub-half split does not sum to 100%");

  const slugs = new Set<string>();
  const orders = new Set<number>();
  let previousPrice = 0;
  for (const t of [...TIER_CONFIGS].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (slugs.has(t.slug)) throw new Error(`odds-config: duplicate tier slug ${t.slug}`);
    slugs.add(t.slug);
    if (orders.has(t.sortOrder)) throw new Error(`odds-config: duplicate sort order ${t.sortOrder}`);
    orders.add(t.sortOrder);
    if (!Number.isInteger(t.priceCents) || t.priceCents <= 0) throw new Error(`odds-config: ${t.slug} price`);
    if (!(t.priceCents > previousPrice)) throw new Error(`odds-config: ${t.slug} is not priced above the tier before it`);
    previousPrice = t.priceCents;

    for (const k of ODDS_BRACKET_KEYS) {
      const b = t.bands[k];
      for (const v of [b.lowFloorCents, b.midpointCents, b.highCeilCents]) {
        if (!Number.isInteger(v) || v < 0) throw new Error(`odds-config: ${t.slug}.${k} has a non-integer cents value`);
      }
      if (!(b.lowFloorCents < b.midpointCents && b.midpointCents < b.highCeilCents)) {
        throw new Error(`odds-config: ${t.slug}.${k} bands are not low < midpoint < high`);
      }
      if (b.midpointCents * 2 !== b.lowFloorCents + b.highCeilCents) {
        throw new Error(`odds-config: ${t.slug}.${k} midpoint is not the exact arithmetic midpoint`);
      }
    }
    const urCeiling = ULTRA_RARE_CEILING_CENTS[t.slug];
    if (urCeiling === undefined) {
      throw new Error(`odds-config: ${t.slug} has no ULTRA_RARE_CEILING_CENTS entry`);
    }
    if (t.bands.ultra_rare.highCeilCents !== urCeiling) {
      throw new Error(`odds-config: ${t.slug} ultra_rare ceiling ${t.bands.ultra_rare.highCeilCents} != the configured ${urCeiling}`);
    }
    // Ultra Rare ends above the price on every tier, so the band straddles
    // break-even and "Epic or better" is not the profit boundary anywhere;
    // its midpoint stays below the price, so the winning part of the band is
    // wholly inside the high half.
    if (!(t.bands.ultra_rare.highCeilCents > t.priceCents)) {
      throw new Error(`odds-config: ${t.slug} ultra_rare ceiling ${t.bands.ultra_rare.highCeilCents} is not above price ${t.priceCents}`);
    }
    if (!(t.bands.ultra_rare.midpointCents < t.priceCents)) {
      throw new Error(`odds-config: ${t.slug} ultra_rare midpoint ${t.bands.ultra_rare.midpointCents} is not below price ${t.priceCents}`);
    }
    const epicFloor = EPIC_FLOOR_CENTS[t.slug];
    if (epicFloor === undefined) {
      throw new Error(`odds-config: ${t.slug} has no EPIC_FLOOR_CENTS entry`);
    }
    if (t.bands.epic.lowFloorCents !== epicFloor) {
      throw new Error(`odds-config: ${t.slug} epic floor ${t.bands.epic.lowFloorCents} != the configured ${epicFloor}`);
    }
    // Epic starts above the price — that is what the floor buys. The smallest
    // Epic pull must be a gain, never break-even.
    if (!(t.bands.epic.lowFloorCents > t.priceCents)) {
      throw new Error(`odds-config: ${t.slug} epic floor ${t.bands.epic.lowFloorCents} is not above price ${t.priceCents}`);
    }
    // Ascending ladder: each bracket starts at or above where the previous ended.
    for (let i = 1; i < ODDS_BRACKET_KEYS.length; i++) {
      const prev = t.bands[ODDS_BRACKET_KEYS[i - 1]];
      const cur = t.bands[ODDS_BRACKET_KEYS[i]];
      if (cur.lowFloorCents < prev.highCeilCents) {
        throw new Error(`odds-config: ${t.slug}.${ODDS_BRACKET_KEYS[i]} overlaps the bracket below it`);
      }
    }
    // Where the ladder is contiguous and where it is not, on every tier.
    if (t.bands.ultra_rare.lowFloorCents !== t.bands.common.highCeilCents) {
      throw new Error(`odds-config: ${t.slug} common→ultra_rare is not contiguous`);
    }
    if (t.bands.legendary.lowFloorCents !== t.bands.epic.highCeilCents) {
      throw new Error(`odds-config: ${t.slug} epic→legendary is not contiguous`);
    }
    // Both deliberate gaps. Snapping a bracket down onto the ceiling below it
    // is the one class of "fix" the spec forbids.
    if (!(t.bands.epic.lowFloorCents > t.bands.ultra_rare.highCeilCents)) {
      throw new Error(`odds-config: ${t.slug} ultra_rare→epic gap has been closed`);
    }
    if (!(t.bands.jackpot.lowFloorCents > t.bands.legendary.highCeilCents)) {
      throw new Error(`odds-config: ${t.slug} legendary→jackpot gap has been closed`);
    }
  }
}

assertOddsConfig();

// ── Derived numbers (integer arithmetic only) ─────────────────────────────

function assertSubLowPpm(subLowPpm: number): void {
  if (!Number.isInteger(subLowPpm) || subLowPpm <= 0 || subLowPpm >= PPM) {
    throw new Error(`odds-config: sub-half low share ${subLowPpm} ppm is out of (0, 1)`);
  }
}

/**
 * Probability-weighted average item value in cents for one odds table: a set
 * of bracket probabilities, a tier's bands and the low-half share. Exact
 * integer arithmetic, rounded to the cent (half-to-even, below).
 *
 * A card in the low half is uniform on [low_floor, midpoint], in the high
 * half uniform on [midpoint, high_ceil]. With the midpoint at the exact
 * centre and `low` / `high` the two sub-half shares (summing to PPM):
 *
 *   mean_b = [ low · (3·lf + hc) + high · (lf + 3·hc) ] / (4 · PPM)
 *
 * so the whole thing is Σ ppm_b · mean_b / PPM. The numerator reaches ~5e18
 * on Infernal, past 2^53, hence BigInt. This is the one formula for every
 * version; expectedValueCents applies it to the module's own table, and
 * lib/odds-live.ts applies it to whatever version the database holds.
 *
 * Rounded to the cent half-to-even (banker's rounding). The one exact tie
 * in the version 6 table is Infernal Normal, 2221.725, which the change
 * order prints as $2,221.72; half-up would print $2,221.73 and the
 * published average would disagree with the approved document by a cent.
 */
export function expectedValueFromTable(
  oddsPpm: Record<OddsBracketKey, number>,
  bands: Record<OddsBracketKey, TierBand>,
  subLowPpm: number = SUB_HALF_PPM.low,
): number {
  assertSubLowPpm(subLowPpm);
  const low = BigInt(subLowPpm);
  const high = BigInt(PPM - subLowPpm);
  let numerator = BigInt(0);
  for (const k of ODDS_BRACKET_KEYS) {
    const b = bands[k];
    const lf = BigInt(b.lowFloorCents);
    const hc = BigInt(b.highCeilCents);
    numerator += BigInt(oddsPpm[k]) * (low * (BigInt(3) * lf + hc) + high * (lf + BigInt(3) * hc));
  }
  const denominator = BigInt(4) * BigInt(PPM) * BigInt(PPM);
  return Number(divideHalfToEven(numerator, denominator));
}

/** Integer division rounded half to even, for non-negative operands. */
function divideHalfToEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * BigInt(2);
  if (twice > denominator) return quotient + BigInt(1);
  if (twice < denominator) return quotient;
  return quotient % BigInt(2) === BigInt(0) ? quotient : quotient + BigInt(1);
}

/** The declared average item value for one tier and mode under THIS table, in cents. */
export function expectedValueCents(mode: VolatilityMode, t: TierConfig, subLowPpm: number = SUB_HALF_PPM.low): number {
  return expectedValueFromTable(BRACKET_ODDS_PPM[mode], t.bands, subLowPpm);
}

/**
 * The share of pulls worth MORE than the pack price, in parts per million,
 * under the same uniform-within-window model the average uses.
 *
 * This is the only correct "odds of profit" figure. It is NOT the sum of the
 * Epic, Legendary and Jackpot probabilities: every tier's Ultra Rare band
 * ends above the price, so the top of Ultra Rare's high half is a winning
 * pull too (the midpoint is below the price everywhere, so only the high
 * half contributes). Strictly greater than the price; a pull worth exactly
 * the price is not a profit. Real inventory is discrete, so the realised
 * share depends on which slabs are on the shelf — this is the table's own
 * figure, ~17.4% Normal and ~10.6% Jackpot Mode on every tier.
 */
export function profitProbabilityPpm(
  oddsPpm: Record<OddsBracketKey, number>,
  bands: Record<OddsBracketKey, TierBand>,
  priceCents: number,
  subLowPpm: number = SUB_HALF_PPM.low,
): number {
  assertSubLowPpm(subLowPpm);
  const shares: Record<SubHalf, bigint> = { low: BigInt(subLowPpm), high: BigInt(PPM - subLowPpm) };
  let numerator = BigInt(0);
  for (const k of ODDS_BRACKET_KEYS) {
    for (const half of SUB_HALVES) {
      const w = resolveWindow(bands[k], half);
      // Fraction of a uniform draw on [low, high] that exceeds the price, in ppm.
      let fractionPpm: bigint;
      if (w.highCents <= priceCents) fractionPpm = BigInt(0);
      else if (w.lowCents >= priceCents) fractionPpm = BigInt(PPM);
      else fractionPpm = (BigInt(w.highCents - priceCents) * BigInt(PPM)) / BigInt(w.highCents - w.lowCents);
      numerator += BigInt(oddsPpm[k]) * shares[half] * fractionPpm;
    }
  }
  const denominator = BigInt(PPM) * BigInt(PPM);
  return Number((numerator + denominator / BigInt(2)) / denominator);
}

/** Odds of a pull worth more than the pack price for one tier and mode under THIS table, in ppm. */
export function profitOddsPpm(mode: VolatilityMode, t: TierConfig, subLowPpm: number = SUB_HALF_PPM.low): number {
  return profitProbabilityPpm(BRACKET_ODDS_PPM[mode], t.bands, t.priceCents, subLowPpm);
}

/** The lowest value a pull of this tier can be worth, in cents. */
export function minValueCents(t: TierConfig): number {
  return t.bands.common.lowFloorCents;
}

/** The highest value a pull of this tier can be worth, in cents. */
export function maxValueCents(t: TierConfig): number {
  return t.bands.jackpot.highCeilCents;
}

/** "0.626" for 626_000 ppm — trailing zeros trimmed, never more than six decimals. */
export function ppmToProbability(ppm: number): number {
  return ppm / PPM;
}

/** "62.6" for 626_000 ppm, as a percentage number with at most four decimals. */
export function ppmToPercent(ppm: number): number {
  return ppm / 10_000;
}

// ── The ladder as a whole: what no tier can award ─────────────────────────

export interface UnawardableGap {
  /** The last awardable cent below the hole (a band ceiling). */
  fromCents: number;
  /** The first awardable cent above the hole (a band floor). */
  toCents: number;
  /** Which band ends the coverage below the hole, e.g. "gaia jackpot". */
  below: string;
  /** Which band resumes it above, e.g. "infernal jackpot". */
  above: string;
}

export interface UnawardableRanges {
  /** Values below this many cents cannot be awarded (the ladder's floor). */
  floorCents: number;
  /** Values above this many cents cannot be awarded (the ladder's ceiling). */
  ceilingCents: number;
  /** Holes strictly inside the ladder: the open interval (fromCents, toCents). */
  gaps: UnawardableGap[];
}

/**
 * The value ranges no tier's band covers, computed from the table rather
 * than typed. A band is inclusive at both ends (the engine's window is
 * `value >= low AND value <= high`), so the interior holes are OPEN
 * intervals: a card worth exactly a ceiling or a floor is awardable.
 *
 * For version 6 that is: below $7.50, above $16,925.00, and one interior
 * hole between $7,325.00 (Gaia's jackpot ceiling) and $13,550.00 (Infernal's
 * jackpot floor). The within-tier gaps are all covered by neighbouring
 * tiers. These are accepted, not bugs: do not adjust bands to close them.
 */
export function unawardableRanges(configs: readonly TierConfig[] = TIER_CONFIGS): UnawardableRanges {
  const spans = configs
    .flatMap((t) => ODDS_BRACKET_KEYS.map((k) => ({ lo: t.bands[k].lowFloorCents, hi: t.bands[k].highCeilCents, name: `${t.slug} ${k}` })))
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  if (spans.length === 0) throw new Error("odds-config: no bands to derive the ladder from");
  const gaps: UnawardableGap[] = [];
  let reach = spans[0];
  for (const span of spans.slice(1)) {
    if (span.lo > reach.hi) gaps.push({ fromCents: reach.hi, toCents: span.lo, below: reach.name, above: span.name });
    if (span.hi > reach.hi) reach = span;
  }
  return { floorCents: spans[0].lo, ceilingCents: reach.hi, gaps };
}

/** True when at least one tier has a band containing this value (inclusive). */
export function isAwardableCents(cents: number, configs: readonly TierConfig[] = TIER_CONFIGS): boolean {
  if (!Number.isInteger(cents) || cents < 0) return false;
  return configs.some((t) => ODDS_BRACKET_KEYS.some((k) => cents >= t.bands[k].lowFloorCents && cents <= t.bands[k].highCeilCents));
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Every unawardableReason string starts with this. Client-safe copy for the
 * admin review queue; lib/inventory-classification.ts (server-only) exports
 * the same literal for its SQL match, and a unit test keeps the two equal.
 */
export const UNAWARDABLE_REASON_PREFIX = "No pack can award";

/**
 * Why a value cannot be awarded, in words a reviewer can act on, or null
 * when some tier can award it. Used by the sourcing check (import and
 * sniper) and by the classification review queue.
 */
export function unawardableReason(cents: number, configs: readonly TierConfig[] = TIER_CONFIGS): string | null {
  if (!Number.isInteger(cents) || cents < 0) return `${UNAWARDABLE_REASON_PREFIX} ${String(cents)}: not a whole number of cents`;
  if (isAwardableCents(cents, configs)) return null;
  const ladder = unawardableRanges(configs);
  if (cents < ladder.floorCents) {
    return `${UNAWARDABLE_REASON_PREFIX} ${dollars(cents)}: the ladder starts at ${dollars(ladder.floorCents)}`;
  }
  if (cents > ladder.ceilingCents) {
    return `${UNAWARDABLE_REASON_PREFIX} ${dollars(cents)}: the ladder ends at ${dollars(ladder.ceilingCents)}`;
  }
  const gap = ladder.gaps.find((g) => cents > g.fromCents && cents < g.toCents);
  if (gap) {
    return `${UNAWARDABLE_REASON_PREFIX} ${dollars(cents)}: no band covers the range between ${dollars(gap.fromCents)} (${gap.below} ceiling) and ${dollars(gap.toCents)} (${gap.above} floor)`;
  }
  return `${UNAWARDABLE_REASON_PREFIX} ${dollars(cents)}`;
}

// ── The public shape ──────────────────────────────────────────────────────

export interface PublicBracket {
  key: OddsBracketKey;
  /** cents */
  low: number;
  /** cents */
  high: number;
  /** 0–1, at most six decimals */
  probability: number;
}

/**
 * Exactly what GET /api/packs/:slug/odds returns and what the pack page
 * renders. Five aggregate brackets and three summary values. By construction
 * it carries no midpoint, no sub-half, no 75/25 weight, no acquisition cost
 * and no margin — tests/unit/odds-config.test.ts walks the object to make
 * sure that stays true.
 */
export interface PublicOdds {
  tier: string;
  /** cents */
  price: number;
  mode: VolatilityMode;
  min_value: number;
  max_value: number;
  average_value: number;
  brackets: PublicBracket[];
}

export function publicOddsFor(t: TierConfig, mode: VolatilityMode): PublicOdds {
  const odds = BRACKET_ODDS_PPM[mode];
  return {
    tier: t.slug,
    price: t.priceCents,
    mode,
    min_value: minValueCents(t),
    max_value: maxValueCents(t),
    average_value: expectedValueCents(mode, t),
    brackets: ODDS_BRACKET_KEYS.map((key) => ({
      key,
      low: t.bands[key].lowFloorCents,
      high: t.bands[key].highCeilCents,
      probability: ppmToProbability(odds[key]),
    })),
  };
}

/**
 * Field names that must never appear anywhere in a customer-reachable odds
 * payload. The API test and the route's own guard both use this list.
 */
export const FORBIDDEN_PUBLIC_ODDS_FIELDS = [
  "midpoint", "midpoint_cents", "midpointCents",
  "sub_half", "subHalf", "sub_bracket", "subBracket", "low_half", "high_half",
  "sub_half_ppm", "sub_low_ppm", "subLowPpm", "split", "skew",
  "acquisition", "acquisition_cost", "cost", "margin", "payout_target", "payoutTarget",
] as const;

export function findForbiddenPublicOddsField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenPublicOddsField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if ((FORBIDDEN_PUBLIC_ODDS_FIELDS as readonly string[]).some((f) => lower === f.toLowerCase() || lower.includes("midpoint") || lower.includes("sub_half") || lower.includes("subhalf") || lower.includes("sub_low") || lower.includes("sublow") || lower.includes("margin"))) {
        return `${path}.${k}`;
      }
      const hit = findForbiddenPublicOddsField(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Pull resolution (pure) ────────────────────────────────────────────────

/**
 * Cumulative-sum bracket selection against a uniform integer roll in
 * [0, PPM). Integer comparison only: a roll of exactly 626_000 lands in
 * ultra_rare under Normal, and PPM - 1 always lands in the jackpot.
 */
export function selectBracket(rollPpm: number, mode: VolatilityMode): OddsBracketKey {
  if (!Number.isInteger(rollPpm) || rollPpm < 0 || rollPpm >= PPM) throw new Error(`selectBracket: roll ${rollPpm} out of range`);
  const odds = BRACKET_ODDS_PPM[mode];
  let acc = 0;
  for (const k of ODDS_BRACKET_KEYS) {
    acc += odds[k];
    if (rollPpm < acc) return k;
  }
  // Unreachable while assertOddsConfig holds (acc == PPM > any roll).
  throw new Error("selectBracket: odds do not cover the roll");
}

/**
 * The low half takes rolls in [0, subLowPpm). Defaults to this table's
 * 75/25; the engine and the replay pass the split of the version the pull
 * belongs to, so a pull sold under 70/30 keeps resolving under 70/30.
 */
export function selectSubHalf(rollPpm: number, subLowPpm: number = SUB_HALF_PPM.low): SubHalf {
  if (!Number.isInteger(rollPpm) || rollPpm < 0 || rollPpm >= PPM) throw new Error(`selectSubHalf: roll ${rollPpm} out of range`);
  assertSubLowPpm(subLowPpm);
  return rollPpm < subLowPpm ? "low" : "high";
}

/** The resolved dollar window, inclusive at both ends, in cents. */
export function resolveWindow(b: TierBand, half: SubHalf): { lowCents: number; highCents: number } {
  return half === "low"
    ? { lowCents: b.lowFloorCents, highCents: b.midpointCents }
    : { lowCents: b.midpointCents, highCents: b.highCeilCents };
}

/** Unit-test seam: apply the whole resolution to a pair of uniform rolls. */
export function resolveRolls(
  t: TierConfig,
  mode: VolatilityMode,
  bracketRollPpm: number,
  subRollPpm: number,
  subLowPpm: number = SUB_HALF_PPM.low,
): { bracket: OddsBracketKey; subHalf: SubHalf; lowCents: number; highCents: number } {
  const bracket = selectBracket(bracketRollPpm, mode);
  const subHalf = selectSubHalf(subRollPpm, subLowPpm);
  return { bracket, subHalf, ...resolveWindow(t.bands[bracket], subHalf) };
}

/**
 * Snapshot of the whole configuration, stored in odds_config.config as the
 * auditable record of what version N meant. JSON-stable field order. The
 * replay reads bands, odds AND the sub-half split from here, never from the
 * module, so a stored pull is explained by the table that was live for it.
 */
export function oddsConfigSnapshot() {
  return {
    version: ODDS_VERSION,
    label: ODDS_VERSION_LABEL,
    ppm: PPM,
    bracket_odds_ppm: BRACKET_ODDS_PPM,
    sub_half_ppm: SUB_HALF_PPM,
    tiers: TIER_CONFIGS.map((t) => ({
      slug: t.slug,
      display_name: t.displayName,
      price_cents: t.priceCents,
      sort_order: t.sortOrder,
      bands: ODDS_BRACKET_KEYS.map((k) => ({
        bracket: k,
        low_floor_cents: t.bands[k].lowFloorCents,
        midpoint_cents: t.bands[k].midpointCents,
        high_ceil_cents: t.bands[k].highCeilCents,
      })),
    })),
  };
}

/** The shape odds_config.config has carried since version 3 (label arrived with 6). */
export type OddsConfigSnapshot = ReturnType<typeof oddsConfigSnapshot>;
