import { beforeEach, describe, expect, test } from "vitest";
import {
  bidGroupOf,
  byBidOrder,
  cgcLabel,
  columnOf,
  formatBidOrder,
  formatTiers,
  graderOff,
  labelKey,
  maxBid,
  parseBidOrder,
  readSections,
  setBidOrder,
  setTierTable,
  splitsCgcLabels,
  tierKeyFor,
  tiersFromArgs,
  TIERS_OFF,
  type Row,
  type TierTable,
} from "../../scripts/sniper-core";

const table = (env: Record<string, string>): TierTable => tiersFromArgs(env);

describe("a CGC box split into Pristine and Gem Mint", () => {
  test("gives each label its own column, and the bare section covers the rest", () => {
    const t = table({
      TIERS_CGC: "$1-100: 70% of lowest | pristine: $1-100: 75% of lowest",
      TIERS_PSA: "$1-100: 85% of 2nd lowest, $100-500: 70% of lowest",
    });
    expect(formatTiers(columnOf("CGC", t))).toBe("$1-100: 70% of lowest");
    expect(formatTiers(columnOf("CGC Pristine", t))).toBe("$1-100: 75% of lowest");
    // Gem Mint was not named, so it falls back to the bare CGC column.
    expect(t["CGC Gem Mint"]).toBeUndefined();
    expect(splitsCgcLabels(t)).toBe(true);
  });

  test("names both labels and nothing else, which switches the bare column off", () => {
    const t = table({ TIERS_CGC: "grades 10, pristine: $1-100: 75% of lowest | gem mint: $1-100: 70% of lowest" });
    expect(formatTiers(columnOf("CGC Pristine", t))).toBe("$1-100: 75% of lowest");
    expect(formatTiers(columnOf("CGC Gem Mint", t))).toBe("$1-100: 70% of lowest");
    expect(columnOf("CGC", t).bands).toEqual([]);
    // Two live columns is not "CGC is off".
    expect(graderOff("CGC", t)).toBe(false);
  });

  test("an unsplit box reads exactly as it always did", () => {
    const t = table({ TIERS_CGC: "$10-90: 77%, $90-450: 70%" });
    expect(splitsCgcLabels(t)).toBe(false);
    expect(formatTiers(columnOf("CGC", t))).toBe("$10-90: 77%, $90-450: 70%");
  });

  test("refuses a label on the PSA table, an unknown section, and a repeat", () => {
    expect(() => readSections("PSA", "pristine: $1-100: 85%")).toThrow(/CGC 10 label/);
    expect(() => readSections("CGC", "mint: $1-100: 70%")).toThrow(/want "pristine" or "gem mint"/);
    expect(() => readSections("CGC", "pristine: $1-10: 70% | pristine: $1-10: 60%")).toThrow(/given twice/);
  });

  test("a label section can be switched off on its own", () => {
    const t = table({ TIERS_CGC: "$1-100: 70% of lowest | gem mint: none" });
    expect(columnOf("CGC Gem Mint", t)).toEqual(TIERS_OFF);
    expect(maxBid("CGC Gem Mint", 50, t)).toBeNull();
    expect(maxBid("CGC", 50, t)).not.toBeNull();
  });
});

describe("which of the two a CGC 10 is", () => {
  const lot = (over: Record<string, unknown> = {}) =>
    ({ grade: 10, gradingService: "CGC", title: "Charizard #4 CGC 10", ...over }) as Parameters<typeof cgcLabel>[0];

  test("the cert is asked first", () => {
    expect(cgcLabel(lot({ pristine: false }), { gradeText: "PRISTINE 10" })).toBe("Pristine");
    expect(cgcLabel(lot({ pristine: true }), { condition: "Gem Mint 10" })).toBe("Gem Mint");
  });

  test("then the house, then the title", () => {
    expect(cgcLabel(lot({ pristine: true }))).toBe("Pristine");
    expect(cgcLabel(lot({ pristine: false }))).toBe("Gem Mint");
    expect(cgcLabel(lot({ title: "Charizard #4 CGC Pristine 10" }))).toBe("Pristine");
    expect(cgcLabel(lot({ title: "Charizard #4 CGC Gem Mint 10" }))).toBe("Gem Mint");
  });

  test("null when nothing says, and never for a PSA slab or a CGC 9.5", () => {
    expect(cgcLabel(lot())).toBeNull();
    expect(cgcLabel(lot({ gradingService: "PSA", title: "PSA 10" }))).toBeNull();
    expect(cgcLabel(lot({ grade: 9.5 }))).toBeNull();
  });
});

describe("the column a lot is priced from", () => {
  const split = table({ TIERS_CGC: "pristine: $1-100: 75% of lowest | gem mint: $1-100: 70% of lowest" });
  const plain = table({ TIERS_CGC: "$1-100: 70% of lowest" });

  test("a label's own column where the table has one", () => {
    expect(tierKeyFor("CGC", 10, "Pristine", split)).toBe("CGC Pristine");
    expect(tierKeyFor("CGC", 10, "Gem Mint", split)).toBe("CGC Gem Mint");
  });

  test("the grader's column where it does not", () => {
    expect(tierKeyFor("CGC", 10, "Pristine", plain)).toBe("CGC");
    expect(tierKeyFor("PSA", 10, null, split)).toBe("PSA");
    expect(tierKeyFor("CGC", 9.5, null, split)).toBe("CGC");
  });

  test("nothing at all for an unlabelled CGC 10 on a table that splits them", () => {
    expect(tierKeyFor("CGC", 10, null, split)).toBeNull();
    // The same lot on a table that does not split them is priced like any other.
    expect(tierKeyFor("CGC", 10, null, plain)).toBe("CGC");
  });

  test("the two labels really do bid different numbers", () => {
    expect(maxBid("CGC Pristine", 100, split)).toEqual({ rule: "75% all-in", share: 0.75, allIn: 75, hammer: 62 });
    expect(maxBid("CGC Gem Mint", 100, split)).toEqual({ rule: "70% all-in", share: 0.7, allIn: 70, hammer: 58 });
  });

  test("labelKey spells the column the way the table keys it", () => {
    expect(labelKey("Pristine")).toBe("CGC Pristine");
    expect(labelKey("Gem Mint")).toBe("CGC Gem Mint");
  });
});

describe("the bid order", () => {
  const ORDER = "PSA $1-100, CGC $1-100, PSA $100-500, CGC Pristine $100-500, CGC Gem Mint $100-500";

  test("reads the rungs, and reads back what it read", () => {
    const order = parseBidOrder(ORDER);
    expect(order.map((g) => [g.keys, g.from, g.to])).toEqual([
      [["PSA"], 1, 100],
      [["CGC", "CGC Pristine", "CGC Gem Mint"], 1, 100],
      [["PSA"], 100, 500],
      [["CGC Pristine"], 100, 500],
      [["CGC Gem Mint"], 100, 500],
    ]);
    expect(formatBidOrder(order)).toBe(ORDER);
  });

  test("a rung with no band covers the whole column", () => {
    const order = parseBidOrder("PSA, CGC");
    expect(bidGroupOf("PSA", 9_999, order)).toBe(0);
    expect(bidGroupOf("CGC Pristine", 3, order)).toBe(1);
  });

  test("puts each lot on the first rung that holds it", () => {
    const order = parseBidOrder(ORDER);
    expect(bidGroupOf("PSA", 50, order)).toBe(0);
    expect(bidGroupOf("CGC", 50, order)).toBe(1);
    expect(bidGroupOf("CGC Pristine", 50, order)).toBe(1);
    expect(bidGroupOf("PSA", 300, order)).toBe(2);
    expect(bidGroupOf("CGC Pristine", 300, order)).toBe(3);
    expect(bidGroupOf("CGC Gem Mint", 300, order)).toBe(4);
  });

  test("a lot no rung holds is bid last, not never", () => {
    const order = parseBidOrder(ORDER);
    expect(bidGroupOf("PSA", 900, order)).toBe(order.length);
    expect(bidGroupOf("CGC", 900, order)).toBe(order.length);
  });

  test("no bid order is one rung holding everything", () => {
    expect(bidGroupOf("PSA", 5, [])).toBe(0);
    expect(bidGroupOf("CGC Gem Mint", 5_000, [])).toBe(0);
    expect(formatBidOrder([])).toMatch(/no bid order given/);
  });

  test("refuses a rung it cannot read", () => {
    expect(() => parseBidOrder("BGS $1-100")).toThrow(/cannot read "BGS \$1-100"/);
    expect(() => parseBidOrder("PSA $100-10")).toThrow(/does not run upward/);
  });
});

describe("the order the fire meets the lots in", () => {
  const row = (over: Partial<Row>): Row => ({ bid_group: 0, priority: 1, max_bid_all_in: 0, ...over }) as Row;

  beforeEach(() => {
    setTierTable({ PSA: TIERS_OFF, CGC: TIERS_OFF });
    setBidOrder([]);
  });

  test("the rung beats the full arts, and the full arts beat the cheapest", () => {
    const rows = [
      row({ bid_group: 1, priority: 0, max_bid_all_in: 5 }),
      row({ bid_group: 0, priority: 1, max_bid_all_in: 400 }),
      row({ bid_group: 0, priority: 0, max_bid_all_in: 900 }),
      row({ bid_group: 0, priority: 1, max_bid_all_in: 10 }),
    ];
    expect([...rows].sort(byBidOrder).map((r) => [r.bid_group, r.priority, r.max_bid_all_in])).toEqual([
      [0, 0, 900],
      [0, 1, 10],
      [0, 1, 400],
      [1, 0, 5],
    ]);
  });
});
