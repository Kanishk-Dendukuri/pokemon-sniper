/**
 * The tier table's long form: a band that prices its own way.
 *
 * The short form — "$10-90: 85%" — prices the way the run does and is
 * covered in fanatics-sniper.test.ts. What is tested here is everything a
 * band may say for itself: which sales it works from, how far back, how few
 * will do, which way a part-dollar goes, and what it does when the sales are
 * not there. With it, the purses and the duplicate caps a grader may have of
 * its own, and the filters that keep a $6 energy off the list.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { BidBook, type BidSteps, type Biddable } from "@/scripts/sniper-book";
import {
  copyGrade,
  pricesFromJobCards,
  batchPricingFromArgs,
  DEFAULT_BASIS,
  DEFAULT_GRADE_RANGES,
  DEFAULT_SALES_RULE,
  applyRule,
  bandBasis,
  blockedBy,
  cgcUngraded,
  formatTiers,
  gradeRanges,
  hasCardNumber,
  isFullArt,
  parsePerGrader,
  parseSalesRule,
  parseSalesWindow,
  parseTiers,
  quoteBand,
  selectionRule,
  setBasis,
  setGradeRanges,
  setSalesRule,
  setTierTable,
  tierTable,
  tiersFromArgs,
  type PriceEvidence,
  type Sale,
} from "@/scripts/sniper-core";

// The tables the run was asked for on 2026-09-20, written the way the
// workflow box takes them.
const PSA_TABLE = "$1-30: 95% of average of the 3 lowest in 5 sales/60 days, min 3, round up, else 90% of alt value,"
  + " $30-100: 85% of 2nd lowest in 3 months, else 80% of alt value,"
  + " $100-500: 75% of lowest in 2 months,"
  + " $500-1000: 60% of lowest in 2 months, min 5";
const CGC_TABLE = "$1-15: 90% of average of the 3 lowest, min 3, $15-50: 70% of average of the 3 lowest, min 3";

const NOW = new Date("2026-09-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
const sale = (price: number, d: number): Sale => ({ price, date: daysAgo(d) });
const evidence = (sales: Sale[], altValue: number | null = null): PriceEvidence => ({ sales, altValue, now: NOW });

beforeEach(() => {
  setBasis(DEFAULT_BASIS);
  setSalesRule(DEFAULT_SALES_RULE);
  setGradeRanges(DEFAULT_GRADE_RANGES);
  setTierTable({ PSA: parseTiers(PSA_TABLE), CGC: parseTiers(CGC_TABLE) });
});

describe("reading a band that prices its own way", () => {
  test("the basis, the window, the minimum, the rounding and the fallback", () => {
    const [cheap, mid, dear, top] = parseTiers(PSA_TABLE).bands;
    expect(cheap).toEqual({
      upTo: 30,
      rule: { kind: "share", share: 0.95 },
      pricing: { basis: { kind: "lowest-average", n: 3 }, count: 5, windowDays: 60, need: 3 },
      round: "up",
      fallback: { kind: "alt-value", share: 0.9 },
    });
    expect(mid.pricing).toEqual({ basis: { kind: "nth-lowest", n: 2 }, windowDays: 90 });
    expect(mid.fallback).toEqual({ kind: "alt-value", share: 0.8 });
    expect(dear.pricing).toEqual({ basis: { kind: "nth-lowest", n: 1 }, windowDays: 60 });
    expect(dear.fallback).toBeUndefined();
    expect(top.pricing).toEqual({ basis: { kind: "nth-lowest", n: 1 }, windowDays: 60, need: 5 });
  });

  test("a table written the long way reads back the way it prints", () => {
    for (const text of [PSA_TABLE, CGC_TABLE]) {
      const table = parseTiers(text);
      expect(parseTiers(formatTiers(table))).toEqual(table);
    }
    expect(formatTiers(parseTiers(CGC_TABLE)))
      .toBe("$1-15: 90% of average of the 3 lowest, min 3, $15-50: 70% of average of the 3 lowest, min 3");
  });

  test("a band that says nothing is the run's own way, as it always was", () => {
    const plain = parseTiers("$10-90: 85%, $90-450: 80%");
    expect(plain.bands.every((b) => b.pricing === undefined && b.round === undefined && b.fallback === undefined)).toBe(true);
    expect(formatTiers(plain)).toBe("$10-90: 85%, $90-450: 80%");
  });

  test("months, weeks and days are all windows; a count may stand alone", () => {
    expect(parseSalesWindow("3 months")).toEqual({ count: null, windowDays: 90 });
    expect(parseSalesWindow("8 weeks")).toEqual({ count: null, windowDays: 56 });
    expect(parseSalesWindow("the last 2 months")).toEqual({ count: null, windowDays: 60 });
    expect(parseSalesWindow("5 sales in 60 days")).toEqual({ count: 5, windowDays: 60 });
    expect(parseSalesWindow("5 sales/2 months")).toEqual({ count: 5, windowDays: 60 });
    expect(parseSalesWindow("5 sales")).toEqual({ count: 5, windowDays: null });
    expect(parseSalesWindow("whenever")).toBeNull();
  });

  test("the run's own sales rule may settle for fewer too", () => {
    expect(parseSalesRule("5 sales in 60 days, at least 3")).toEqual({ count: 5, windowDays: 60, need: 3 });
    expect(parseSalesRule("5 sales in 2 months")).toEqual({ count: 5, windowDays: 60 });
    expect(() => parseSalesRule("5 sales in 60 days, at least 7")).toThrow(/cannot need 7 sales when it only looks at 5/);
  });

  test("what it cannot read it names, rather than guessing at", () => {
    expect(() => parseTiers("$1-30: 95% of the moon")).toThrow(/cannot read the value basis "the moon"/);
    expect(() => parseTiers("$1-30: 95% in a fortnight")).toThrow(/cannot read the sales window "a fortnight"/);
    expect(() => parseTiers("$1-30: 95%, sideways")).toThrow(/cannot read the rule/);
    expect(() => parseTiers("$1-30: 95%, else 90% of thin air")).toThrow(/cannot read the fallback/);
    expect(() => parseTiers("$1-30: 95% in 3 sales, min 5")).toThrow(/cannot need 5 sales when it only looks at 3/);
  });

  test("a grade range may ride in the grader's own box", () => {
    setGradeRanges(DEFAULT_GRADE_RANGES);
    const table = tiersFromArgs({ TIERS_PSA: "grades 1-10, $10-90: 85%", TIERS_CGC: "grades 7-10, none" });
    expect(table.PSA.bands).toHaveLength(1);
    expect(table.CGC.bands).toHaveLength(0);
    expect(gradeRanges()).toEqual({ PSA: { min: 1, max: 10 }, CGC: { min: 7, max: 10 } });
    expect(() => tiersFromArgs({ TIERS_PSA: "grades 0-11, $10-90: 85%" })).toThrow(/grades run 1 to 10/);
  });
});

describe("what a band bids", () => {
  type Answer = Partial<{ band: number; price: number; via: string; rule: string; hammer: number; allIn: number; share: number | null; reason: string }>;
  const quote = (grader: "PSA" | "CGC", ev: PriceEvidence): Answer => {
    const basis = bandBasis(grader, ev);
    if (basis.price === null) return { reason: basis.reason };
    const bid = quoteBand(grader, basis.price, ev);
    return bid.ok ? { band: basis.price, ...bid.quote } : { band: basis.price, reason: bid.reason };
  };

  test("the band is picked once, on the widest net the table casts", () => {
    // $30-100 reaches back three months, so that is how far the picking looks.
    expect(selectionRule(tierTable().PSA)).toEqual({ count: 5, windowDays: 90, need: 3 });
    expect(selectionRule(tierTable().CGC)).toEqual({ count: 5, windowDays: 60, need: 3 });
  });

  test("each band prices its own way once it has been picked", () => {
    const cheap = quote("PSA", evidence([sale(20, 3), sale(22, 10), sale(25, 20), sale(28, 30), sale(40, 50)]));
    // Picked on the 2nd lowest ($22), priced on the average of the 3 lowest.
    expect(cheap.band).toBe(22);
    expect(cheap.price).toBe(22.33);
    expect(cheap.via).toBe("average of the 3 lowest of 5 sale(s) inside 60d");
    // 95% all-in, rounded up to the dollar: $21.21 all-in is $17.68 hammer.
    expect(cheap.hammer).toBe(18);
    expect(cheap.rule).toBe("95% all-in, rounded up");

    const dear = quote("PSA", evidence([sale(200, 5), sale(220, 20), sale(240, 40), sale(260, 50), sale(300, 55)]));
    expect(dear.band).toBe(220);
    // The $100-500 band takes the lowest inside two months, not the 2nd lowest.
    expect(dear.price).toBe(200);
    expect(dear.hammer).toBe(125);
  });

  test("a band reaching back further prices off sales the run's rule would not have", () => {
    const stale = [sale(60, 70), sale(66, 75), sale(70, 80), sale(72, 85), sale(80, 88)];
    expect(quote("PSA", evidence(stale)).price).toBe(66);
    // Nothing inside sixty days, so the $100-500 band's own window would fail.
    expect(quote("PSA", evidence([sale(200, 70), sale(220, 75), sale(240, 80), sale(260, 85), sale(300, 88)])))
      .toMatchObject({ reason: "only 0 sale(s) inside 60d, the $100-500 band needs 5" });
  });

  test("too few sales falls back on the alt value, where the band was given one", () => {
    const thin = [sale(20, 3), sale(22, 10)];
    expect(quote("PSA", evidence(thin, 26))).toMatchObject({
      band: 26,
      price: 26,
      rule: "90% all-in, rounded up",
      via: "alt value — only 2 sale(s) inside 60d, the $1-30 band needs 3",
    });
    // With no alt value there is nothing to bid on.
    expect(quote("PSA", evidence(thin))).toEqual({ reason: "only 2 recent sale(s), need 3" });
  });

  test("a band with no fallback refuses rather than bidding on a number it made up", () => {
    // Three sales inside two months puts it in the top band, which wants five.
    expect(quote("PSA", evidence([sale(600, 5), sale(650, 20), sale(700, 40)], 700)))
      .toMatchObject({ reason: "only 3 sale(s) inside 60d, the $500-1000 band needs 5" });
  });

  test("CGC settles for three sales where the run's rule wants five", () => {
    expect(quote("CGC", evidence([sale(20, 5), sale(24, 20), sale(30, 40)])))
      .toMatchObject({ price: 24.67, rule: "70% all-in" });
  });

  test("rounding up costs the odd dollar and the all-in says so", () => {
    expect(applyRule({ kind: "share", share: 0.95 }, 22.33)).toEqual({ rule: "95% all-in", share: 0.95, allIn: 21.21, hammer: 17 });
    expect(applyRule({ kind: "share", share: 0.95 }, 22.33, "up"))
      .toEqual({ rule: "95% all-in, rounded up", share: 0.95, allIn: 21.6, hammer: 18 });
  });
});

describe("a purse and a duplicate cap of a grader's own", () => {
  // Steps that take the max exactly as it stands, so the only arithmetic
  // under test is the purse's and the cap's.
  const STEPS: BidSteps = { below: (cents) => cents, minimum: () => 0 };
  const lot = (id: string, grader: string, hammer: number): Biddable => ({
    listingId: id, title: `${grader} lot ${id}`, lot: id, grader, cardKey: "pikachu|base|58|en",
    maxHammerCents: hammer * 100, maxAllInCents: Math.round(hammer * 120), currentBidCents: 0, bidCount: 0,
  });

  test("a grader stops spending when its purse is out, and the others carry on", () => {
    const book = new BidBook(null, {
      budgetCents: 100_000, perGraderCents: { PSA: 12_000 }, live: false, log: () => {}, steps: STEPS,
    });
    const pool = [lot("a", "PSA", 100), lot("b", "PSA", 100), lot("c", "CGC", 100)];
    const plan = book.plan(pool);
    // $100 hammer is $120 all-in, so the $120 PSA purse takes one of the two.
    expect(plan.picks.map((p) => p.listingId)).toEqual(["a", "c"]);
    expect(plan.beyond).toBe(1);
  });

  test("a grader's copies are counted apart from the card's", () => {
    const book = new BidBook(null, {
      budgetCents: 1_000_000, live: false, log: () => {}, steps: STEPS,
      caps: { perCard: 6, perCardByGrader: { CGC: 2 } },
    });
    const pool = [
      lot("a", "CGC", 10), lot("b", "CGC", 10), lot("c", "CGC", 10),
      lot("d", "PSA", 10), lot("e", "PSA", 10), lot("f", "PSA", 10),
    ];
    const plan = book.plan(pool);
    // Two CGC copies, then the card's own cap of six takes the rest.
    expect(plan.picks.map((p) => p.listingId)).toEqual(["a", "b", "d", "e", "f"]);
  });

  test("CGC is held to four copies of a card at each grade, and PSA to none", () => {
    const at = (id: string, grader: string, grade: string): Biddable => ({ ...lot(id, grader, 10), grade });
    const book = new BidBook(null, {
      budgetCents: 1_000_000, live: false, log: () => {}, steps: STEPS,
      caps: { perCard: Infinity, perCardByGrader: { CGC: 4 } },
    });
    const pool = [
      ...["a", "b", "c", "d", "e"].map((id) => at(`cgc9-${id}`, "CGC", "9")),
      ...["a", "b"].map((id) => at(`pri-${id}`, "CGC", "10 Pristine")),
      ...["a", "b"].map((id) => at(`gem-${id}`, "CGC", "10 Gem Mint")),
      ...["a", "b", "c", "d", "e", "f", "g"].map((id) => at(`psa10-${id}`, "PSA", "10")),
    ];
    const picks = book.plan(pool).picks.map((p) => p.listingId);
    // The fifth CGC 9 is the only copy left off: the 10s are other grades,
    // a Pristine and a Gem Mint are not the same slab, and PSA is uncapped.
    expect(picks).not.toContain("cgc9-e");
    expect(picks.filter((id) => id.startsWith("cgc9-"))).toHaveLength(4);
    expect(picks.filter((id) => id.startsWith("pri-") || id.startsWith("gem-"))).toHaveLength(4);
    expect(picks.filter((id) => id.startsWith("psa10-"))).toHaveLength(7);
  });

  test("a batch's cards price the way the free lookup does: identity, Alt Value, the newest sales", () => {
    const prices = pricesFromJobCards([
      { certificationNumber: 123, cardName: "Pikachu", setName: "151", cardnumber: "025", year: "2023", gradeText: "GEM MT 10", price: "40.50",
        certPricing: { recentSales: [{ price: 38, date: "2026-09-30", platform: "ebay" }, { price: "41.00", date: "2026-09-20" }, { price: null, date: "2026-09-01" }] } },
      { cardName: "no cert" },
    ], "PSA");
    expect([...prices.keys()]).toEqual(["PSA:123"]);
    const p = prices.get("PSA:123")!;
    expect(p.card?.cardName).toBe("Pikachu");
    expect(p.altValue).toBe(40.5);
    expect(p.sales).toEqual([{ price: 38, date: "2026-09-30", platform: "ebay" }, { price: 41, date: "2026-09-20" }]);
    expect(p.error).toBeUndefined();
    expect(p.info?.description).toBe("2023 151 Pikachu #025");
  });

  test("every candidate is priced by batch unless the run asks for the free lookup", () => {
    expect(batchPricingFromArgs({})).toBe(Infinity);
    expect(batchPricingFromArgs({ BATCH_ONLY: "0" })).toBe(0);
    expect(batchPricingFromArgs({ BATCH_PRICING: "500" })).toBe(500);
    expect(() => batchPricingFromArgs({ BATCH_PRICING: "lots" })).toThrow(/whole number/);
  });

  test("the copy grade is the number, with a CGC 10's label", () => {
    expect(copyGrade({ grade: "9", grade_label: "" })).toBe("9");
    expect(copyGrade({ grade: "10", grade_label: "Pristine" })).toBe("10 Pristine");
    expect(copyGrade({ grade: "", grade_label: "" })).toBeUndefined();
  });

  test("one box carries the run's figure and a grader's", () => {
    expect(parsePerGrader("10000", "--budget")).toEqual({ all: 10_000, byGrader: {} });
    expect(parsePerGrader("10000, PSA 6000, CGC 1500", "--budget"))
      .toEqual({ all: 10_000, byGrader: { PSA: 6_000, CGC: 1_500 } });
    expect(parsePerGrader("$10000", "--budget").all).toBe(10_000);
    expect(() => parsePerGrader("PSA 6000", "--budget")).toThrow(/needs a figure for the run itself/);
    expect(() => parsePerGrader("10000, BGS 500", "--budget")).toThrow(/not a grader/);
  });
});

describe("what never reaches the list", () => {
  test("CGC's own block list catches what PSA's does not", () => {
    const energy = "2026 Pokemon Mega Evolution Basic Energy Play Prize Pack Series Holo Fire Energy #2 CGC 9 MINT";
    const insert = "2026 Pokemon Insert Card Chaos Rising Trainer Tips Greninja CGC 6.5 EXMT+";
    expect(blockedBy(energy, "CGC")).toBeTruthy();
    expect(blockedBy(insert, "CGC")).toBeTruthy();
    expect(blockedBy(energy, "PSA")).toBeNull();
    // Stickers and playing cards are blocked for everyone, as they always were.
    expect(blockedBy("2022 Pokemon Japanese Daiichi Pan Deco Character Part 192 Stickers Garchomp CGC 9.5", "PSA")).toBeTruthy();
    expect(blockedBy("2019 Pokemon Japanese Playing Cards Old Maid Top Player CGC 8.5", "PSA")).toBeTruthy();
  });

  test("a CGC slab with no number on it is not bid on", () => {
    expect(cgcUngraded({ grade: 9, title: "Charizard CGC 9" })).toBeNull();
    expect(cgcUngraded({ grade: undefined, title: "Charizard CGC" })).toMatch(/no number grade/);
    expect(cgcUngraded({ grade: 0, title: "Charizard CGC AUTHENTIC" })).toMatch(/CGC Authentic/);
    // "Authenticity" is another word and is left alone.
    expect(cgcUngraded({ grade: 9, title: "Charizard CGC 9 Authenticity Guarantee" })).toBeNull();
  });

  test("a card has a number; an energy, an insert and a deck of Old Maid do not", () => {
    expect(hasCardNumber("2022 Pokemon Sword & Shield Lost Origin Alt Art Giratina V #186 PSA 10")).toBe(true);
    expect(hasCardNumber("1999 Pokemon Jungle 1st Edition Holo Scyther 10/64 PSA 8")).toBe(true);
    expect(hasCardNumber("2021 Pokemon Celebrations Promo Mew SWSH127 CGC 10")).toBe(true);
    expect(hasCardNumber("2019 Pokemon Japanese Playing Cards Old Maid Top Player CGC 8.5")).toBe(false);
    expect(hasCardNumber("2006 Pokemon Japanese Unnumbered Energy Cards Metal Energy CGC 9 MINT")).toBe(false);
    expect(hasCardNumber("2024 Pokemon Japanese Insert Card Generations Special Battle Set How To Play CGC 8.5")).toBe(false);
  });

  test("the full arts lead, whatever they are called", () => {
    expect(isFullArt({ title: "Lost Origin Alt Art Giratina V #186" })).toBe(true);
    expect(isFullArt({ title: "SV2a 151 Full Art Charizard ex #201" })).toBe(true);
    expect(isFullArt({ title: "Clay Burst Iono SAR #091" })).toBe(true);
    expect(isFullArt({ title: "Crimson Haze Special Illustration Rare Sableye #086" })).toBe(true);
    expect(isFullArt({ title: "Base Set Holo Charizard #4" })).toBe(false);
  });
});
