/**
 * The sourcing check in the snipers (odds v6): a lot whose card is worth a
 * value no pack can award is never bid on, whatever tier table the run was
 * given, and the verdict travels with the row so nothing downstream bids on
 * it either.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { unawardableRanges } from "@/lib/odds-config";
import { AltSession } from "@/scripts/alt-bidder";
import { FanaticsSession } from "@/scripts/fanatics-bidder";
import type { Biddable } from "@/scripts/sniper-book";
import {
  CSV_COLUMNS,
  DEFAULT_TIERS,
  baseRow,
  evaluate,
  parseTiers,
  selectCandidates,
  setSourcingCheck,
  sourcingCheckFromArgs,
  setTierTable,
  tierFloor,
  tierTable,
  toBiddable,
  toCsv,
  unawardableLotReason,
  type CuPrice,
  type Row,
  type ScannedLot,
} from "@/scripts/sniper-core";

const NOW = new Date("2026-09-15T20:00:00Z");

/** A chase-list lot, so selectCandidates keeps it. */
const lot = (over: Partial<ScannedLot> = {}): ScannedLot => ({
  listingId: "e06fcf08-9739-11f1-b601-0a58a9feac02",
  url: "https://www.fanaticscollect.com/weekly/e06fcf08-9739-11f1-b601-0a58a9feac02",
  title: "2022 Pokemon Sword & Shield Lost Origin Alt Art Giratina V #186 PSA 10 GEM MINT",
  grader: "PSA",
  grade: 10,
  cert: "12345678",
  currentBid: 1,
  bidCount: 0,
  auction: "WA242",
  lot: "WA242 Lot: 1",
  language: "English",
  ...over,
});

const candidate = (over: Partial<ScannedLot> = {}) => {
  const { candidates } = selectCandidates([lot(over)], () => {});
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

/** Five sales inside the window at these prices; the cert resolved but was not identified. */
const priced = (prices: number[]): CuPrice => ({
  card: null,
  info: { description: "Giratina V", condition: "GEM MT 10", gradingCompany: "PSA" },
  altValue: null,
  salesAverage: null,
  sales: prices.map((price, i) => ({ price, date: `2026-09-${String(10 - i).padStart(2, "0")}` })),
});

// Every grader starts switched off now: a run bids nothing until it is given
// a tier table. These tests are about the table that was fitted, so they ask
// for it by name rather than leaning on a default that no longer exists.
//
// The sourcing check is off unless a run asks for it (--awardable-only): the
// sniper buys cards, and what the app does with one afterwards is the app's
// business. These tests are about what the check does when it is on, so they
// turn it on.
beforeEach(() => {
  setTierTable(DEFAULT_TIERS);
  setSourcingCheck(true);
});
afterEach(() => setSourcingCheck(false));

describe("what no pack can award", () => {
  test("under the ladder's floor, whichever figure is the low one", () => {
    expect(unawardableLotReason({ medianDollars: 6.5, basisDollars: 6 }))
      .toMatch(/^sales median \$6\.5: No pack can award \$6\.50: the ladder starts at \$7\.50$/);
    // The median clears the floor and the bid basis does not: still no.
    expect(unawardableLotReason({ medianDollars: 8, basisDollars: 6.99 }))
      .toMatch(/^bid basis \(2nd lowest sale\) \$6\.99: No pack can award \$6\.99: the ladder starts at \$7\.50$/);
  });

  test("in the hole between Gaia's jackpot ceiling and Infernal's jackpot floor", () => {
    const reason = unawardableLotReason({ medianDollars: 8_400, basisDollars: 8_000 });
    expect(reason).toMatch(/^sales median \$8400: No pack can award \$8,400\.00/);
    expect(reason).toMatch(/between \$7,325\.00 \(gaia jackpot ceiling\) and \$13,550\.00 \(infernal jackpot floor\)/);
    expect(unawardableLotReason({ medianDollars: 7_325.01, basisDollars: 7_325.01 })).not.toBeNull();
    expect(unawardableLotReason({ medianDollars: 13_549.99, basisDollars: 13_549.99 })).not.toBeNull();
  });

  test("above the ladder's ceiling", () => {
    expect(unawardableLotReason({ medianDollars: 20_000, basisDollars: 17_000 }))
      .toMatch(/^sales median \$20000: No pack can award \$20,000\.00: the ladder ends at \$16,925\.00$/);
    expect(unawardableLotReason({ medianDollars: 16_925.01, basisDollars: 16_925.01 })).toMatch(/ladder ends/);
  });

  test("the edges are awardable: $7.50 and $16,925 exactly, and both ends of the hole", () => {
    expect(unawardableLotReason({ medianDollars: 7.5, basisDollars: 7.5 })).toBeNull();
    expect(unawardableLotReason({ medianDollars: 16_925, basisDollars: 16_925 })).toBeNull();
    expect(unawardableLotReason({ medianDollars: 7_325, basisDollars: 7_325 })).toBeNull();
    expect(unawardableLotReason({ medianDollars: 13_550, basisDollars: 13_550 })).toBeNull();
    // Whole cents, rounded: $7.499 is 750 cents to the ladder, $7.494 is 749.
    expect(unawardableLotReason({ medianDollars: 7.499, basisDollars: 7.499 })).toBeNull();
    expect(unawardableLotReason({ medianDollars: 7.494, basisDollars: 7.494 })).toMatch(/ladder starts/);
  });

  test("a figure that is not there is not held against the lot", () => {
    expect(unawardableLotReason({ medianDollars: null, basisDollars: null })).toBeNull();
    expect(unawardableLotReason({ medianDollars: null, basisDollars: 9 })).toBeNull();
    expect(unawardableLotReason({ medianDollars: 9, basisDollars: null })).toBeNull();
  });

  test("the default floors are the ladder's floor, for both graders", () => {
    const ladder = unawardableRanges();
    expect(ladder.floorCents).toBe(750);
    expect(DEFAULT_TIERS.PSA.floor).toBe(7.5);
    expect(DEFAULT_TIERS.CGC.floor).toBe(7.5);
    expect(tierFloor("PSA", DEFAULT_TIERS)).toBe(ladder.floorCents / 100);
    expect(tierFloor("CGC", DEFAULT_TIERS)).toBe(ladder.floorCents / 100);
  });
});

describe("who asks for the sourcing check", () => {
  test("off unless the run asks: a $7.20 card is bought like any other", () => {
    setSourcingCheck(false);
    const { row, worthy } = evaluate(candidate(), priced([7.25, 7, 7, 6.5, 6]), NOW);
    expect(row.unawardable).toBe("");
    expect(row.reason).not.toMatch(/unawardable/);
    // The table is what decides it now — $7 is under the fitted $7.50 floor.
    expect(worthy).toBe(false);
    expect(row.reason).toMatch(/under the \$7\.5 PSA floor/);
  });

  test("the flag and the environment variable both ask for it", () => {
    expect(sourcingCheckFromArgs({})).toBe(false);
    expect(sourcingCheckFromArgs({ AWARDABLE_ONLY: "" })).toBe(false);
    expect(sourcingCheckFromArgs({ AWARDABLE_ONLY: "1" })).toBe(true);
    expect(sourcingCheckFromArgs({ AWARDABLE_ONLY: "true" })).toBe(true);
    expect(sourcingCheckFromArgs({ AWARDABLE_ONLY: "no" })).toBe(false);
  });
});

describe("the bid decision", () => {
  test("rejects an unawardable lot with the reason, before the table is consulted", () => {
    const { row, worthy } = evaluate(candidate(), priced([7.25, 7, 7, 6.5, 6]), NOW);
    expect(worthy).toBe(false);
    // The basis is the second-lowest sale, $6.50; the median is judged first and is under the floor too.
    expect(row.market_price).toBe(6.5);
    expect(row.sales_median).toBe(7);
    expect(row.reason).toMatch(/^unawardable: sales median \$7: No pack can award \$7\.00: the ladder starts at \$7\.50$/);
    expect(row.unawardable).toBe(row.reason.slice("unawardable: ".length));
    expect(row.tier_rule).toBe("");
    expect(row.max_bid_hammer).toBe("");
  });

  test("a table that reaches lower than the ladder does not get to buy such a lot", () => {
    const before = tierTable();
    try {
      setTierTable({ ...DEFAULT_TIERS, PSA: parseTiers("$4-8: flat $3, $8-20000: 50%") });
      const cheap = evaluate(candidate(), priced([6, 6, 6.5, 6.5, 7]), NOW);
      expect(cheap.worthy).toBe(false);
      expect(cheap.row.reason).toMatch(/^unawardable: /);
      // …and the same for the hole in the middle of the ladder.
      const hole = evaluate(candidate(), priced([8_000, 8_100, 8_200, 8_300, 8_400]), NOW);
      expect(hole.worthy).toBe(false);
      expect(hole.row.reason).toMatch(/^unawardable: sales median \$8200: No pack can award \$8,200\.00: no band covers the range between/);
    } finally {
      setTierTable(before);
    }
  });

  test("an awardable lot goes through with the column empty", () => {
    // Second-lowest sale $7.75: on the ladder ($7.50 up) and in the flat-$5 band.
    const { row, worthy } = evaluate(candidate(), priced([12, 10, 9, 7.75, 7.6]), NOW);
    expect(worthy).toBe(true);
    expect(row.unawardable).toBe("");
    expect(row.reason).toBe("");
    expect(row.tier_rule).toBe("flat $5");
  });
});

describe("the verdict travels with the row", () => {
  const row = (over: Partial<Row> = {}): Row => ({
    ...baseRow(candidate()),
    max_bid_hammer: 5,
    max_bid_all_in: 6,
    card_key: "giratina v|lost origin|186|english",
    ...over,
  });

  test("the CSV carries it, last, and an older row without the field is an empty cell", () => {
    expect(CSV_COLUMNS[CSV_COLUMNS.length - 1]).toBe("unawardable");
    const marked = row({ unawardable: "sales median $7: No pack can award $7.00: the ladder starts at $7.50" });
    const [header, line] = toCsv([marked]).trim().split("\n");
    expect(header).toMatch(/,unawardable$/);
    expect(line).toMatch(/,sales median \$7: No pack can award \$7\.00: the ladder starts at \$7\.50$/);
    const older = row();
    delete older.unawardable;
    expect(toCsv([older]).trim().split("\n")[1]).toMatch(/,$/);
  });

  test("a marked row is never handed to the book; one without the field is", () => {
    expect(toBiddable(row())).not.toBeNull();
    expect(toBiddable(row({ unawardable: "sales median $7: No pack can award $7.00: the ladder starts at $7.50" }))).toBeNull();
    const older = row();
    delete older.unawardable;
    expect(toBiddable(older)).not.toBeNull();
  });

  test("both bidders refuse a marked row at the request, and send an unmarked one on", async () => {
    const biddable: Biddable = {
      listingId: "e06fcf08-9739-11f1-b601-0a58a9feac02", title: "Giratina V PSA 10", lot: "WA242 Lot: 1",
      maxHammerCents: 500, maxAllInCents: 600, currentBidCents: 100, bidCount: 0,
    };
    const marked = { ...biddable, unawardable: "sales median $7: No pack can award $7.00: the ladder starts at $7.50" };
    // Neither session has signed in: a refusal has to come back before any
    // request is made, and an unmarked row has to get past the guard — it
    // then fails on the missing session, which is the point: it was not
    // refused as unawardable.
    const fanatics = Object.create(FanaticsSession.prototype) as FanaticsSession;
    await expect(fanatics.sendBid(marked, 500)).resolves.toEqual({ ok: false, error: `unawardable: ${marked.unawardable}`, blame: "lot" });
    const alt = Object.create(AltSession.prototype) as AltSession;
    await expect(alt.sendBid(marked, 500)).resolves.toEqual({ ok: false, error: `unawardable: ${marked.unawardable}`, blame: "lot" });
    const past = await alt.sendBid(biddable, 500).then(() => null, (err: unknown) => err);
    expect(past).toBeInstanceOf(Error);
    expect(String((past as Error).message)).not.toMatch(/unawardable/);
  });
});
