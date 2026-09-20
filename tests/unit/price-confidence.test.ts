import { describe, expect, test } from "vitest";
import {
  CONFIDENCE_SALES_WINDOW_DAYS,
  MAX_SALES_SPREAD_RATIO,
  MIN_CONFIDENT_SALES,
  MIN_DISAGREEMENT_DOLLARS,
  REFERENCE_TOLERANCE,
  SALES_PRICE_MIN_SALES,
  SALES_PRICE_WINDOW_DAYS,
  assessPriceConfidence,
  median,
  priceFromRecentSales,
  usableSales,
  type CertComps,
  type Sale,
} from "@/lib/price-confidence";

const NOW = new Date("2026-09-09T20:00:00Z");

function comps(overrides: Partial<CertComps> & { sales?: Sale[] }): CertComps {
  return {
    cert: "6206361015",
    grader: "CGC",
    altValue: null,
    cardLadderValue: null,
    lastSale: null,
    sales: [],
    fetchedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Real numbers, captured from Card Uploader on 2026-09-09. */
const ZEKROM: Sale[] = [
  { price: 276, date: "2026-08-24T03:25:00.000Z", platform: "Fanatics-Weekly" },
  { price: 417, date: "2026-08-17T04:13:35.000Z", platform: "eBay" },
  { price: 830, date: "2026-08-17T00:56:00.000Z", platform: "eBay" },
  { price: 938, date: "2026-05-14T20:11:04.420Z", platform: "Heritage" },
  { price: 77,  date: "2026-04-20T02:00:00.000Z", platform: "eBay" },
];

const TYNAMO: Sale[] = [
  { price: 15,    date: "2026-09-01T23:53:30.000Z" },
  { price: 23.67, date: "2026-08-26T12:26:50.000Z" },
  { price: 28,    date: "2026-08-24T02:10:26.000Z" },
  { price: 20,    date: "2026-08-12T23:05:58.000Z" },
  { price: 14.5,  date: "2026-08-10T15:18:20.000Z" },
];

const DUSTOX: Sale[] = [
  { price: 153,   date: "2026-04-06T21:26:00.000Z" },
  { price: 45.53, date: "2024-09-26T02:30:00.000Z" },
  { price: 45.6,  date: "2023-11-06T04:14:00.000Z" },
];

/**
 * The case this exists for: a CGC 10 Zekrom filled in at $726.25 off five
 * sales between $77 and $938, with Card Ladder reading $305. Every rule but
 * "too few sales" should fire, and the reason should say which.
 */
describe("assessPriceConfidence — the Zekrom", () => {
  const verdict = assessPriceConfidence(726.25, comps({ sales: ZEKROM, cardLadderValue: 305 }));

  test("is held", () => {
    expect(verdict.flagged).toBe(true);
  });

  test("names the spread, the median and Card Ladder", () => {
    expect(verdict.reasons).toHaveLength(3);
    expect(verdict.reasons[0]).toBe("5 sales range $77.00–$938.00 (12.2×)");
    expect(verdict.reasons[1]).toBe("ask $726.25 is 1.7× the $417.00 median of 5 sales");
    expect(verdict.reasons[2]).toBe("Card Ladder estimates $305.00 (ask is 2.4×)");
  });

  test("sits above the market", () => {
    expect(verdict.direction).toBe("rise");
  });

  test("carries the numbers the reviewer will want", () => {
    expect(verdict.stats).toMatchObject({
      salesCounted: 5, salesMin: 77, salesMax: 938, salesMedian: 417,
      newestSale: "2026-08-24T03:25:00.000Z", cardLadderValue: 305,
    });
  });
});

describe("assessPriceConfidence — well-supported prices pass", () => {
  test("a bulk card with five tight sales is left alone", () => {
    // $14.50–$28 is 1.9×, under the spread bar; an ask of $22 sits on the median.
    const verdict = assessPriceConfidence(22, comps({ sales: TYNAMO }));
    expect(verdict).toMatchObject({ flagged: false, reasons: [], direction: "none" });
  });

  test("an ask a little above the sales is the normal case, not a hold", () => {
    // Alt Value is an ask; a $101.78 ask over $80 sales was the first thing
    // anyone noticed about it, and it is inside tolerance.
    const sales = [80, 82, 78, 85, 80].map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));
    expect(assessPriceConfidence(101.78, comps({ sales })).flagged).toBe(false);
  });

  test("Card Ladder agreeing within tolerance is not a reason", () => {
    const sales = [100, 105, 98, 110, 102].map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));
    expect(assessPriceConfidence(120, comps({ sales, cardLadderValue: 95 })).flagged).toBe(false);
  });
});

describe("assessPriceConfidence — too few sales", () => {
  test("one sale inside the window is not enough to check a price against", () => {
    // Dustox: one sale this year, the other two are from 2023 and 2024.
    const verdict = assessPriceConfidence(140, comps({ sales: DUSTOX }));
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toEqual([`only 1 sale in the last ${CONFIDENCE_SALES_WINDOW_DAYS} days`]);
    expect(verdict.direction).toBe("none");
    expect(verdict.stats.salesCounted).toBe(1);
  });

  test("no sales at all says so, and names the newest one on record", () => {
    const stale = [{ price: 50, date: "2025-01-01T00:00:00Z" }];
    const verdict = assessPriceConfidence(60, comps({ sales: stale }));
    expect(verdict.reasons).toEqual([
      `no sales in the last ${CONFIDENCE_SALES_WINDOW_DAYS} days (newest 2025-01-01)`,
    ]);
  });

  test("a card worth less than the dollar floor is not held for thin history", () => {
    // A $6 card with one sale: the price cannot be wrong by enough to matter.
    expect(assessPriceConfidence(6, comps({ sales: DUSTOX.slice(0, 1) })).flagged).toBe(false);
    expect(assessPriceConfidence(MIN_DISAGREEMENT_DOLLARS, comps({ sales: [] })).flagged).toBe(true);
  });

  test("the bar is the one the constant advertises", () => {
    const sales = Array.from({ length: MIN_CONFIDENT_SALES }, (_, i) => ({ price: 50, date: `2026-08-${10 + i}T00:00:00Z` }));
    expect(assessPriceConfidence(50, comps({ sales })).flagged).toBe(false);
    expect(assessPriceConfidence(50, comps({ sales: sales.slice(1) })).flagged).toBe(true);
  });
});

describe("assessPriceConfidence — the sales disagree with each other", () => {
  test("a wrong comp among right ones is caught by the spread", () => {
    // The $635 Charizard filed among $90 Psyducks.
    const sales = [90, 88, 635, 92, 89].map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));
    const verdict = assessPriceConfidence(95, comps({ sales }));
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toEqual(["5 sales range $88.00–$635.00 (7.2×)"]);
    // The ask itself sits on the median, so the spread is the only complaint
    // and it says nothing about direction.
    expect(verdict.direction).toBe("none");
  });

  test("the ratio bar is the one the constant advertises, with the dollar floor", () => {
    const at = (prices: number[]) => prices.map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));
    expect(assessPriceConfidence(30, comps({ sales: at([20, 20 * MAX_SALES_SPREAD_RATIO]) })).flagged).toBe(false);
    expect(assessPriceConfidence(30, comps({ sales: at([20, 20 * MAX_SALES_SPREAD_RATIO + 0.01]) })).flagged).toBe(true);
    // 3× on a $3 card is a $6 problem, not a review.
    expect(assessPriceConfidence(5, comps({ sales: at([3, 9]) })).flagged).toBe(false);
  });
});

describe("assessPriceConfidence — the ask sits far from the market", () => {
  const at = (prices: number[]) => prices.map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));

  test("an ask far above the sales is a rise", () => {
    const verdict = assessPriceConfidence(239.66, comps({ sales: at([24, 22, 26, 24, 25]) }));
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toEqual(["ask $239.66 is 10× the $24.00 median of 5 sales"]);
    expect(verdict.direction).toBe("rise");
  });

  test("an ask far below the sales is a drop", () => {
    const verdict = assessPriceConfidence(40, comps({ sales: at([100, 105, 98, 110, 102]) }));
    expect(verdict).toMatchObject({ flagged: true, direction: "drop" });
  });

  test("the tolerance is the one the constant advertises, with the dollar floor", () => {
    const sales = at([100, 100, 100]);
    expect(assessPriceConfidence(100 * REFERENCE_TOLERANCE, comps({ sales })).flagged).toBe(false);
    expect(assessPriceConfidence(100 * REFERENCE_TOLERANCE + 0.01, comps({ sales })).flagged).toBe(true);
    expect(assessPriceConfidence(100 / REFERENCE_TOLERANCE, comps({ sales })).flagged).toBe(false);
    expect(assessPriceConfidence(100 / REFERENCE_TOLERANCE - 0.01, comps({ sales })).flagged).toBe(true);
    // 2× on a $4 card is an $4 gap — under the floor.
    expect(assessPriceConfidence(8, comps({ sales: at([4, 4, 4]) })).flagged).toBe(false);
  });

  test("Card Ladder disagreeing on its own is enough", () => {
    const sales = at([100, 100, 100]);
    const verdict = assessPriceConfidence(100, comps({ sales, cardLadderValue: 40 }));
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toEqual(["Card Ladder estimates $40.00 (ask is 2.5×)"]);
    expect(verdict.direction).toBe("rise");
  });
});

describe("assessPriceConfidence — no opinion without comps", () => {
  test("no comps means no hold", () => {
    expect(assessPriceConfidence(500, null)).toEqual({
      flagged: false, reasons: [], direction: "none",
      stats: { salesCounted: 0, salesMin: null, salesMax: null, salesMedian: null, newestSale: null, cardLadderValue: null },
    });
    expect(assessPriceConfidence(500, undefined).flagged).toBe(false);
  });

  test("an unusable price is not judged", () => {
    expect(assessPriceConfidence(0, comps({ sales: ZEKROM })).flagged).toBe(false);
    expect(assessPriceConfidence(Number.NaN, comps({ sales: ZEKROM })).flagged).toBe(false);
  });

  test("the window is measured from when the comps were pulled, not from today", () => {
    // Pulled a year later, the same Zekrom sales are all history.
    const later = comps({ sales: ZEKROM, fetchedAt: "2027-09-09T00:00:00Z" });
    const verdict = assessPriceConfidence(726.25, later);
    expect(verdict.stats.salesCounted).toBe(0);
    expect(verdict.reasons[0]).toMatch(/^no sales in the last/);
  });
});

describe("usableSales", () => {
  test("keeps the newest priced sales inside the window, newest first", () => {
    const kept = usableSales(ZEKROM, NOW);
    expect(kept.map((s) => s.price)).toEqual([276, 417, 830, 938, 77]);
  });

  test("drops sales past the window, without a price, or dated in the future", () => {
    const sales: Sale[] = [
      { price: 10, date: "2026-09-01T00:00:00Z" },
      { price: 0,  date: "2026-09-02T00:00:00Z" },
      { price: 12, date: "2020-01-01T00:00:00Z" },
      { price: 14, date: "2027-01-01T00:00:00Z" },
      { price: 16, date: "not a date" },
    ];
    expect(usableSales(sales, NOW).map((s) => s.price)).toEqual([10]);
  });

  test("never judges more than the newest five", () => {
    const sales = Array.from({ length: 8 }, (_, i) => ({ price: 10 + i, date: `2026-08-${10 + i}T00:00:00Z` }));
    expect(usableSales(sales, NOW)).toHaveLength(5);
    expect(usableSales(sales, NOW)[0].price).toBe(17);
  });
});

/**
 * The owner's rule of 2026-09-17: five sales all inside 60 days price the
 * card themselves — drop the highest and the lowest, average the rest — and
 * anything short of that leaves the Alt Value standing.
 */
describe("priceFromRecentSales", () => {
  test("five fresh sales price the card off the middle three", () => {
    // Tynamo, pulled 2026-09-09: sales from Aug 10 to Sep 1, all inside 60 days.
    // Sorted $14.50, $15, $20, $23.67, $28 — the ends go, (15 + 20 + 23.67) / 3.
    const priced = priceFromRecentSales(comps({ sales: TYNAMO, altValue: 22 }));
    expect(priced).toMatchObject({
      price: 19.56,
      averaged: [15, 20, 23.67],
      dropped: { low: 14.5, high: 28 },
      newestSale: "2026-09-01T23:53:30.000Z",
      oldestSale: "2026-08-10T15:18:20.000Z",
      windowDays: SALES_PRICE_WINDOW_DAYS,
    });
  });

  test("one of the five being older than the window leaves the Alt Value standing", () => {
    // The Zekrom: three sales in August, two from April and May.
    expect(priceFromRecentSales(comps({ sales: ZEKROM }))).toBeNull();
  });

  test("four fresh sales are not five", () => {
    expect(priceFromRecentSales(comps({ sales: TYNAMO.slice(0, 4) }))).toBeNull();
    expect(priceFromRecentSales(comps({ sales: [] }))).toBeNull();
  });

  test("the window is the one the constant advertises, to the millisecond", () => {
    const edge = (offsetMs: number) => [
      ...TYNAMO.slice(0, 4),
      { price: 14.5, date: new Date(NOW.getTime() - SALES_PRICE_WINDOW_DAYS * 86_400_000 + offsetMs).toISOString() },
    ];
    expect(priceFromRecentSales(comps({ sales: edge(0) }))?.price).toBe(19.56);
    expect(priceFromRecentSales(comps({ sales: edge(-1) }))).toBeNull();
  });

  test("only the newest five count when Card Uploader hands back more", () => {
    // Six sales, all fresh: the oldest ($9) is not looked at, so the five are
    // $10–$14 and the middle three average $12.
    const sales = [9, 10, 11, 12, 13, 14].map((price, i) => ({ price, date: `2026-08-${10 + i}T00:00:00Z` }));
    const priced = priceFromRecentSales(comps({ sales }));
    expect(priced?.price).toBe(12);
    expect(priced?.dropped).toEqual({ low: 10, high: 14 });
    expect(SALES_PRICE_MIN_SALES).toBe(5);
  });

  test("a sale without a price, or dated in the future, does not count towards five", () => {
    const sales: Sale[] = [
      ...TYNAMO.slice(0, 4),
      { price: 0, date: "2026-09-02T00:00:00Z" },
      { price: 30, date: "2027-01-01T00:00:00Z" },
    ];
    expect(priceFromRecentSales(comps({ sales }))).toBeNull();
  });

  test("the window is measured from when the comps were pulled", () => {
    const later = comps({ sales: TYNAMO, fetchedAt: "2027-09-09T00:00:00Z" });
    expect(priceFromRecentSales(later)).toBeNull();
    expect(priceFromRecentSales(later, NOW)?.price).toBe(19.56);
  });

  test("no comps, no opinion", () => {
    expect(priceFromRecentSales(null)).toBeNull();
    expect(priceFromRecentSales(undefined)).toBeNull();
  });

  test("the bars are knobs", () => {
    // Loosened to a year, the Zekrom's five qualify: $77, $276, $417, $830, $938 → (276 + 417 + 830) / 3.
    const priced = priceFromRecentSales(comps({ sales: ZEKROM }), undefined, { windowDays: 365, minSales: 5 });
    expect(priced?.price).toBe(507.67);
    // Fewer than three sales leaves nothing to average once the ends are dropped.
    expect(priceFromRecentSales(comps({ sales: TYNAMO }), undefined, { windowDays: 60, minSales: 2 })).toBeNull();
  });
});

describe("median", () => {
  test("odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
