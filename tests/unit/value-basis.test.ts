/**
 * The value basis: how a card's recent sales become the one price every tier
 * table percentage multiplies, and the box a run picks it with.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_BASIS,
  DEFAULT_SALES_RULE,
  applyBasis,
  basisFromArgs,
  basisRule,
  bidBasis,
  formatBasis,
  formatSalesRule,
  marketPrice,
  minSales,
  parseBasis,
  parseSalesRule,
  salesGate,
  salesRuleFromArgs,
  salesWindowDays,
  setBasis,
  setSalesRule,
  type BasisRule,
} from "@/scripts/sniper-core";

afterEach(() => {
  setBasis(DEFAULT_BASIS);
  setSalesRule(DEFAULT_SALES_RULE);
});

describe("reading a basis", () => {
  const cases: [string, BasisRule][] = [
    ["lowest", { kind: "nth-lowest", n: 1 }],
    ["the lowest", { kind: "nth-lowest", n: 1 }],
    ["cheapest", { kind: "nth-lowest", n: 1 }],
    ["2nd lowest", { kind: "nth-lowest", n: 2 }],
    ["second-lowest", { kind: "nth-lowest", n: 2 }],
    ["Second Lowest", { kind: "nth-lowest", n: 2 }],
    ["3rd lowest", { kind: "nth-lowest", n: 3 }],
    ["highest", { kind: "nth-highest", n: 1 }],
    ["2nd highest", { kind: "nth-highest", n: 2 }],
    ["average of the 2 lowest", { kind: "lowest-average", n: 2 }],
    ["average of the lowest 3", { kind: "lowest-average", n: 3 }],
    ["mean of the three cheapest", { kind: "lowest-average", n: 3 }],
    ["median", { kind: "median" }],
    ["average", { kind: "mean" }],
    ["mean", { kind: "mean" }],
    ["trimmed mean", { kind: "trimmed-mean" }],
    ["drop the lowest and the highest, average the rest", { kind: "trimmed-mean" }],
  ];
  for (const [text, rule] of cases) {
    test(`"${text}"`, () => expect(parseBasis(text)).toEqual(rule));
  }

  test("an average of one is that one sale, not an average", () => {
    expect(parseBasis("average of the 1 lowest")).toEqual({ kind: "nth-lowest", n: 1 });
  });

  test("what it cannot read is an error naming the forms, not a guess", () => {
    expect(() => parseBasis("cheapish")).toThrow(/cannot read the value basis "cheapish"/);
    expect(() => parseBasis("cheapish")).toThrow(/"2nd lowest"/);
    expect(() => parseBasis("")).toThrow(/cannot be blank/);
    expect(() => parseBasis("umpteenth lowest")).toThrow(/which sale/);
  });

  test("every basis reads back from the words it is written in", () => {
    for (const [, rule] of cases) expect(parseBasis(formatBasis(rule))).toEqual(rule);
  });

  test("the default is the second-lowest, and that is what it is called", () => {
    expect(DEFAULT_BASIS).toEqual({ kind: "nth-lowest", n: 2 });
    expect(formatBasis(DEFAULT_BASIS)).toBe("2nd lowest");
  });
});

describe("working a basis out", () => {
  const five = [60, 64, 70, 72, 74];

  test("each rule on the same five sales", () => {
    const of = (text: string) => applyBasis(parseBasis(text), five);
    expect(of("lowest")).toBe(60);
    expect(of("2nd lowest")).toBe(64);
    expect(of("3rd lowest")).toBe(70);
    expect(of("highest")).toBe(74);
    expect(of("average of the 2 lowest")).toBe(62);
    expect(of("average of the 3 lowest")).toBe(64.67);
    expect(of("median")).toBe(70);
    expect(of("average")).toBe(68);
    // 60 and 74 thrown out, 64/70/72 averaged.
    expect(of("drop the lowest and the highest, average the rest")).toBe(68.67);
  });

  test("the order sales come in never matters", () => {
    const shuffled = [74, 60, 72, 64, 70];
    for (const text of ["lowest", "2nd lowest", "median", "average", "trimmed mean"]) {
      expect(applyBasis(parseBasis(text), shuffled)).toBe(applyBasis(parseBasis(text), five));
    }
  });

  test("a basis that runs off the end takes what there is", () => {
    expect(applyBasis(parseBasis("3rd lowest"), [50, 40])).toBe(50);
    expect(applyBasis(parseBasis("average of the 3 lowest"), [50, 40])).toBe(45);
    // Under three sales there is nothing to trim, so what is there is averaged.
    expect(applyBasis(parseBasis("trimmed mean"), [50, 40])).toBe(45);
    expect(applyBasis(parseBasis("trimmed mean"), [50])).toBe(50);
  });

  test("sales at no price are not sales, and nothing left is nothing", () => {
    expect(applyBasis(parseBasis("lowest"), [0, -5, 40])).toBe(40);
    expect(applyBasis(parseBasis("lowest"), [])).toBeNull();
  });

  test("the run's own basis is what bidBasis and marketPrice take", () => {
    const at = (price: number) => ({ price, date: "2026-09-01" });
    expect(bidBasis(five)).toBe(64);
    setBasis(parseBasis("drop the lowest and the highest, average the rest"));
    expect(basisRule()).toEqual({ kind: "trimmed-mean" });
    expect(bidBasis(five)).toBe(68.67);
    expect(marketPrice(five.map(at)).price).toBe(68.67);
  });
});

describe("the sales rule", () => {
  test("the numbers either side of the words", () => {
    expect(parseSalesRule("5 sales in 60 days")).toEqual({ count: 5, windowDays: 60 });
    expect(parseSalesRule("3 in 30")).toEqual({ count: 3, windowDays: 30 });
    expect(parseSalesRule("8 sales within the last 90 days")).toEqual({ count: 8, windowDays: 90 });
    expect(parseSalesRule("5 sales/60d")).toEqual({ count: 5, windowDays: 60 });
    expect(formatSalesRule({ count: 5, windowDays: 60 })).toBe("5 sales in 60 days");
    expect(parseSalesRule(formatSalesRule(DEFAULT_SALES_RULE))).toEqual(DEFAULT_SALES_RULE);
  });

  test("half a rule is an error, not a guess", () => {
    expect(() => parseSalesRule("5 sales")).toThrow(/cannot read the sales rule/);
    expect(() => parseSalesRule("0 sales in 60 days")).toThrow(/at least 1 sale/);
    expect(() => parseSalesRule("5 sales in 0 days")).toThrow(/at least 1 day/);
  });

  test("it gates the lot and feeds the price at once", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const sale = (daysAgo: number, price: number) => ({ price, date: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() });
    const sales = [sale(1, 10), sale(5, 12), sale(70, 14)];
    // Five inside 60 days: only three sales, so the lot never gets priced.
    expect(salesGate(sales, now).ok).toBe(false);
    setSalesRule(parseSalesRule("3 sales in 90 days"));
    expect(minSales()).toBe(3);
    expect(salesWindowDays()).toBe(90);
    expect(salesGate(sales, now)).toEqual({ ok: true, oldestDays: 70 });
    expect(marketPrice(sales).price).toBe(12);
  });
});

describe("the boxes a run is given", () => {
  test("the environment, else the default", () => {
    expect(basisFromArgs({})).toEqual(DEFAULT_BASIS);
    expect(basisFromArgs({ VALUE_BASIS: "" })).toEqual(DEFAULT_BASIS);
    expect(basisFromArgs({ VALUE_BASIS: "average of the 3 lowest" })).toEqual({ kind: "lowest-average", n: 3 });
    expect(salesRuleFromArgs({})).toEqual(DEFAULT_SALES_RULE);
    expect(salesRuleFromArgs({ SALES_RULE: "7 sales in 45 days" })).toEqual({ count: 7, windowDays: 45 });
  });

  test("a box nobody meant stops the run before anything is scanned", () => {
    expect(() => basisFromArgs({ VALUE_BASIS: "the cheap one" })).toThrow(/the value basis could not be read/);
    expect(() => salesRuleFromArgs({ SALES_RULE: "lots of them" })).toThrow(/the sales rule could not be read/);
  });
});
