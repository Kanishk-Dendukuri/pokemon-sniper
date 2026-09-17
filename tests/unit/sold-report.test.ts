import { describe, expect, test } from "vitest";
import { auctionNameFilter, auctionNumber, toSoldLot as fanaticsSoldLot } from "@/scripts/fanatics-sold";
import { cycleCloseUnixS, toSoldLot as altSoldLot, zonedUnixS } from "@/scripts/alt-sold";
import { ALT_STEPS } from "@/scripts/alt-bidder";
import { FANATICS_STEPS } from "@/scripts/fanatics-bidder";
import {
  AUCTION_SUMMARY_COLUMNS,
  CURVE_COLUMNS,
  DEFAULT_RESALE,
  PRICE_GRID,
  answerFor,
  auctionSheet,
  bucketLabels,
  bucketOf,
  bucketSheet,
  candidateRules,
  columnsNamed,
  couldWin,
  formatResale,
  gridBandLabel,
  gridBands,
  groupColumns,
  guardPlaywrightTlsCrash,
  inBand,
  isPlaywrightTlsCrash,
  notesSheet,
  outcomeOf,
  parseResale,
  recommendTable,
  recommendUnderBudget,
  recommendedSheet,
  recommendations,
  resaleFromArgs,
  resaleRate,
  SHARE_SEARCH_TO,
  sameRule,
  setResaleTable,
  shareSearch,
  shareCurveSheet,
  shareGrid,
  summaryMarkdown,
  describe as stats,
  evaluateSold,
  generalise,
  ownSaleInComps,
  percentile,
  resaleTable,
  tierBandLabel,
  trimmedMean,
  wonBy,
  type AuctionFunnel,
  type LotRow,
  type SoldAuction,
  type SoldLot,
} from "@/scripts/sold-report";
import { DEFAULT_TIERS, formatTiers, parseTiers, ruleText as ruleTextOf, selectCandidates, setTierTable, tierTable, type CuPrice, type TierTable } from "@/scripts/sniper-core";
import { columnLetter, crc32, sheetName, xlsxBuffer, zipStored } from "@/scripts/xlsx";

describe("market value, the report's way", () => {
  test("five sales: drop the highest and the lowest, average the three left", () => {
    expect(trimmedMean([40, 95, 100, 105, 200])).toBe(100);
    expect(trimmedMean([10, 10, 10, 10, 10])).toBe(10);
    // Order does not matter; cents are kept to two places.
    expect(trimmedMean([105, 40, 100, 200, 95.5])).toBe(100.17);
  });

  test("fewer than three sales cannot be trimmed", () => {
    expect(trimmedMean([50, 60])).toBeNull();
    expect(trimmedMean([])).toBeNull();
  });
});

describe("buckets and shares", () => {
  test("50% to 100% in steps of 5, with a floor and a ceiling; the curve tries the same shares", () => {
    expect(bucketLabels()).toEqual(["<50%", "50-55%", "55-60%", "60-65%", "65-70%", "70-75%", "75-80%", "80-85%", "85-90%", "90-95%", "95-100%", "100%+"]);
    expect(shareGrid()).toEqual([50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
  });

  test("a percentage lands in [lo, lo + 5)", () => {
    expect(bucketOf(49.9)).toBe("<50%");
    expect(bucketOf(50)).toBe("50-55%");
    expect(bucketOf(54.9)).toBe("50-55%");
    expect(bucketOf(55)).toBe("55-60%");
    expect(bucketOf(99.9)).toBe("95-100%");
    expect(bucketOf(100)).toBe("100%+");
    expect(bucketOf(140)).toBe("100%+");
  });
});

describe("the price grid", () => {
  test("a fixed grid, nothing to do with the table being judged", () => {
    expect(gridBands().map((b) => b.label)).toEqual([
      "<$6", "$6-8", "$8-10", "$10-15", "$15-25", "$25-40", "$40-60", "$60-90", "$90-150", "$150-250", "$250-400", "$400-600", "$600+",
    ]);
    expect(PRICE_GRID[0]).toBe(6);
    // A grid of its own, for a test that wants one.
    expect(gridBands([10, 20]).map((b) => b.label)).toEqual(["<$10", "$10-20", "$20+"]);
  });

  test("a price is in exactly one band, the top of each exclusive", () => {
    const at = (label: string) => gridBands().find((b) => b.label === label)!;
    expect(inBand(at("<$6"), 5.99)).toBe(true);
    expect(inBand(at("<$6"), 6)).toBe(false);
    expect(inBand(at("$6-8"), 6)).toBe(true);
    expect(inBand(at("$6-8"), 8)).toBe(false);
    expect(inBand(at("$8-10"), 8)).toBe(true);
    expect(inBand(at("$400-600"), 600)).toBe(false);
    expect(inBand(at("$600+"), 600)).toBe(false);
    expect(inBand(at("$600+"), 600.01)).toBe(true);
    for (const price of [0, 5.99, 6, 9.5, 90, 450, 599, 1_000]) {
      expect(gridBands().filter((b) => inBand(b, price))).toHaveLength(1);
    }
    expect(gridBandLabel(90)).toBe("$90-150");
    expect(gridBandLabel(3)).toBe("<$6");
    expect(gridBandLabel(1_000)).toBe("$600+");
  });

  test("the band of the given table a price falls in is kept for the record, top of the last one inclusive", () => {
    expect(tierBandLabel("PSA", 450, DEFAULT_TIERS)).toBe("$90-450");
    expect(tierBandLabel("PSA", 450.01, DEFAULT_TIERS)).toBe("$450+");
    expect(tierBandLabel("CGC", 3, DEFAULT_TIERS)).toBe("<$7.5");
    expect(tierBandLabel("CGC", 10, DEFAULT_TIERS)).toBe("$10-90");
  });

  test("the shares searched run past 100%, because a share multiplies the lowest comp and not market value", () => {
    expect(shareSearch()[0]).toBe(50);
    expect(shareSearch().at(-1)).toBe(SHARE_SEARCH_TO);
    expect(SHARE_SEARCH_TO).toBeGreaterThan(100);
    // The buckets are a different question and still stop at 100%.
    expect(shareGrid().at(-1)).toBe(100);
  });

  test("every share in every band; flat and offset rules only where a card is cheap enough for them to matter", () => {
    const at = (label: string) => gridBands().find((b) => b.label === label)!;
    expect(candidateRules(at("$15-25")).map((r) => (r.kind === "share" ? Math.round(r.share * 100) : r)))
      .toEqual(shareSearch());
    // $8-10 tops out at $10, so a flat bid and an offset are tried there too.
    const cheap = candidateRules(at("$8-10"));
    expect(cheap).toHaveLength(shareSearch().length + 7 + 5);
    expect(cheap).toContainEqual({ kind: "flat", hammer: 5 });
    expect(cheap).toContainEqual({ kind: "offset", less: 3 });
    expect(candidateRules(at("$10-15")).every((r) => r.kind === "share")).toBe(true);
  });

  test("two rules that bid the same thing merge", () => {
    expect(sameRule({ kind: "share", share: 0.8 }, { kind: "share", share: 0.8 })).toBe(true);
    expect(sameRule({ kind: "share", share: 0.8 }, { kind: "share", share: 0.75 })).toBe(false);
    expect(sameRule({ kind: "flat", hammer: 5 }, { kind: "share", share: 5 })).toBe(false);
  });
});

describe("resale rates", () => {
  test("the user's own figures are the default", () => {
    expect(formatResale(DEFAULT_RESALE.PSA)).toBe("$0-100: 90%, $100-500: 85%, $500+: 85%");
    expect(formatResale(DEFAULT_RESALE.CGC)).toBe("$0-100: 82%, $100-500: 75%, $500+: 75%");
    expect(resaleRate("PSA", 99.99, DEFAULT_RESALE)).toBe(0.9);
    expect(resaleRate("PSA", 100, DEFAULT_RESALE)).toBe(0.85);
    expect(resaleRate("CGC", 5_000, DEFAULT_RESALE)).toBe(0.75);
  });

  test("a line reads back the way it was written, and an open last band is filled in", () => {
    expect(parseResale(formatResale(DEFAULT_RESALE.PSA))).toEqual(DEFAULT_RESALE.PSA);
    // No band above $500 given: the last rate carries on.
    expect(parseResale("$0-100: 90%, $100-500: 85%")).toEqual(DEFAULT_RESALE.PSA);
    expect(parseResale("0-50: 95%")).toEqual([{ upTo: 50, rate: 0.95 }, { upTo: Infinity, rate: 0.95 }]);
  });

  test("a line that cannot be read names the band", () => {
    expect(() => parseResale("$0-100: 90%, $200-500: 85%")).toThrow(/starts at \$200 but the one before it ends at \$100/);
    expect(() => parseResale("$0-100: cheap")).toThrow(/cannot read the band/);
    expect(() => parseResale("$0-100: 400%")).toThrow(/between 0% and 200%/);
    expect(() => parseResale("")).toThrow(/at least one band/);
    expect(() => resaleFromArgs({ RESALE_CGC: "nope" })).toThrow(/the CGC resale rates could not be read/);
  });

  test("a run takes the rates it is given, per grader", () => {
    const before = resaleTable();
    try {
      setResaleTable(resaleFromArgs({ RESALE_PSA: "$0-50: 100%" }));
      expect(resaleRate("PSA", 40)).toBe(1);
      expect(resaleRate("PSA", 5_000)).toBe(1);
      expect(resaleTable().CGC).toBe(DEFAULT_RESALE.CGC);
    } finally {
      setResaleTable(before);
    }
  });
});

describe("could the sniper have won", () => {
  test("Fanatics bids the ladder rung at or below the max, and wins only above the hammer", () => {
    // A $54 max sits on the $54 rung ($1 steps to $50, then $2): $54 is a rung.
    expect(couldWin(FANATICS_STEPS, 54, 52)).toBe(true);
    expect(couldWin(FANATICS_STEPS, 54, 54)).toBe(false);
    // A $55 max is not a rung above $50; the bid is $54, which loses to a $54 hammer.
    expect(couldWin(FANATICS_STEPS, 55, 54)).toBe(false);
    expect(couldWin(FANATICS_STEPS, 0, 1)).toBe(false);
  });

  test("Alt bids the whole dollar", () => {
    expect(couldWin(ALT_STEPS, 46.9, 46)).toBe(false);
    expect(couldWin(ALT_STEPS, 47, 46)).toBe(true);
  });
});

describe("statistics", () => {
  test("percentiles interpolate between ranks", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0.5)).toBe(25);
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 1)).toBe(40);
    expect(percentile(sorted, 0.25)).toBe(17.5);
  });

  test("describe", () => {
    const s = stats([50, 60, 70, 80, 90])!;
    expect(s.n).toBe(5);
    expect(s.mean).toBe(70);
    expect(s.median).toBe(70);
    expect(s.min).toBe(50);
    expect(s.max).toBe(90);
    expect(s.stdev).toBe(14.1);
    expect(stats([])).toBeNull();
  });

  test("reasons are generalised so the funnel can count them", () => {
    expect(generalise("only 3 recent sale(s), need 5")).toBe("only N recent sale(s), need 5");
    expect(generalise("oldest of the last 5 sales is 75d old, window is 60d")).toBe("oldest of the last N sales is Nd old, window is Nd");
    expect(generalise("market price $4.5 is under the $6 PSA floor")).toBe("market price $… is under the $… PSA floor");
  });
});

describe("the lot's own sale among its comps", () => {
  const lot = { hammer: 100, allIn: 120, closedAtUnixS: Date.UTC(2026, 8, 7, 2) / 1000 };

  test("a sale within three days of the close at the all-in price, or the hammer, is the lot itself", () => {
    expect(ownSaleInComps([{ price: 120, date: "2026-09-07T03:19:00Z" }], lot)).toBe(true);
    expect(ownSaleInComps([{ price: 100, date: "2026-09-08" }], lot)).toBe(true);
    // Close in price but weeks earlier: another copy.
    expect(ownSaleInComps([{ price: 120, date: "2026-08-01" }], lot)).toBe(false);
    // Same week, different price.
    expect(ownSaleInComps([{ price: 150, date: "2026-09-07" }], lot)).toBe(false);
  });
});

// ── A lot end to end ─────────────────────────────────────────────────────────

const AUCTION: SoldAuction = { venue: "fanatics", id: "242", name: "Weekly Sunday Auction #242", closedAtUnixS: 1788746400, lots: [] };

function lot(over: Partial<SoldLot> = {}): SoldLot {
  return {
    listingId: "lot-1", url: "https://www.fanaticscollect.com/weekly/lot-1",
    title: "2022 Pokemon Lost Origin Giratina V #186 Alt Art PSA 10 GEM MINT",
    grader: "PSA", grade: 10, cert: "12345678", currentBid: 60, bidCount: 12,
    auction: "Weekly Sunday Auction #242", lot: "WA242 Lot: 1", language: "English",
    closesAtUnixS: 1788746400, hammer: 60, allIn: 72, closedAtUnixS: 1788746400, houseValue: 150,
    ...over,
  };
}

function priced(prices: number[], daysAgo: number[] = [1, 5, 10, 15, 20]): CuPrice {
  const now = new Date("2026-09-10T00:00:00Z").getTime();
  return {
    card: null,
    info: { description: "Giratina V 186", condition: "10", gradingCompany: "PSA" },
    altValue: 110, salesAverage: 100,
    sales: prices.map((price, i) => ({ price, date: new Date(now - daysAgo[i] * 86_400_000).toISOString() })),
  };
}

const NOW = new Date("2026-09-10T00:00:00Z");

describe("evaluating a sold lot", () => {
  test("an eligible lot: market value off the middle three, the sniper's bid off the lowest, both percentages", () => {
    const l = lot();
    const { candidates } = selectCandidates([l], () => {});
    const row = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100, 105, 130]), NOW);
    expect(row.status).toBe("eligible");
    expect(row.priceable).toBe(true);
    expect(row.market_value).toBe(100);
    expect(row.market_low).toBe(80);
    expect(row.market_high).toBe(130);
    expect(row.hammer_pct).toBe(60);
    expect(row.all_in_pct).toBe(72);
    expect(row.bucket).toBe("70-75%");
    // PSA, $80 lowest comp → the $10–90 band at 85% all-in = $68, $56 hammer: under the $60 hammer, so no.
    expect(row.sniper_market_price).toBe(80);
    expect(row.low_pct_of_value).toBe(80);
    expect(row.tier_band).toBe("$10-90");
    expect(row.tier_rule).toBe("85% all-in");
    expect(row.sniper_max_all_in).toBe(68);
    expect(row.sniper_max_hammer).toBe(56);
    expect(row.sniper_max_pct).toBe(68);
    expect(row.sniper_could_win).toBe("no");
    expect(row.own_sale_in_comps).toBe("no");
  });

  test("a lot that went cheap is one the tier table could have won", () => {
    const l = lot({ hammer: 30, allIn: 36 });
    const { candidates } = selectCandidates([l], () => {});
    const row = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100, 105, 130]), NOW);
    expect(row.all_in_pct).toBe(36);
    expect(row.bucket).toBe("<50%");
    expect(row.sniper_could_win).toBe("yes");
  });

  test("the sales rule is the sniper's: five sales inside sixty days", () => {
    const l = lot();
    const { candidates } = selectCandidates([l], () => {});
    const fine = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100, 105, 130], [1, 5, 10, 15, 45]), NOW);
    expect(fine.status).toBe("eligible");

    const stale = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100, 105, 130], [1, 5, 10, 15, 75]), NOW);
    expect(stale.status).toMatch(/oldest of the last 5 sales is 75d old/);
    expect(stale.eligible).toBe(false);
    expect(stale.priceable).toBe(false);
    // The comps are still written down for a near miss.
    expect(stale.market_value).toBe(100);
    expect(stale.all_in_pct).toBe(72);

    const thin = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100], [1, 5, 10]), NOW);
    expect(thin.status).toBe("only 3 recent sale(s), need 5");
    expect(thin.market_value).toBe("");
  });

  test("outside the tier table the lot is priceable but not eligible; not priced and never resolved are neither", () => {
    const l = lot();
    const { candidates } = selectCandidates([l], () => {});
    const dear = evaluateSold(AUCTION, l, candidates[0], priced([600, 650, 700, 750, 800]), NOW);
    expect(dear.status).toMatch(/above the \$450 PSA tier ceiling/);
    expect(dear.priceable).toBe(true);
    expect(dear.tier_band).toBe("$450+");
    const cheap = evaluateSold(AUCTION, l, candidates[0], priced([4, 5, 5, 6, 7]), NOW);
    expect(cheap.status).toMatch(/under the \$7.5 PSA floor/);
    expect(cheap.priceable).toBe(true);
    expect(cheap.tier_band).toBe("<$7.5");
    expect(evaluateSold(AUCTION, l, candidates[0], undefined, NOW).status).toBe("not priced");
    expect(evaluateSold(AUCTION, l, candidates[0], { card: null, info: null, altValue: null, salesAverage: null, sales: [] }, NOW).status).toBe("cert did not resolve");
    expect(evaluateSold(AUCTION, l, candidates[0], { card: null, info: null, altValue: null, salesAverage: null, sales: [], error: "HTTP 500" }, NOW).status).toBe("never answered: HTTP 500");
  });

  test("the lot's own sale is spotted among the comps, and the sniper's bid is worked without it", () => {
    const l = lot();
    const { candidates } = selectCandidates([l], () => {});
    const comps = priced([72, 95, 100, 105, 130], [3, 5, 10, 15, 20]);
    const row = evaluateSold(AUCTION, l, candidates[0], comps, NOW);
    expect(row.own_sale_in_comps).toBe("yes");
    // The trimmed mean dropped it as the low, so market value is unmoved.
    expect(row.market_value).toBe(100);
    // The sniper's bid is worked from $95, the lowest comp that is not this lot — not from the lot's own $72:
    // the $90–450 band, 80% all-in = $76, a $63 hammer.
    expect(row.market_low).toBe(72);
    expect(row.sniper_market_price).toBe(95);
    expect(row.tier_band).toBe("$90-450");
    expect(row.sniper_max_all_in).toBe(76);
    expect(row.sniper_max_hammer).toBe(63);
  });

  test("the lots are judged under the table the run was given", () => {
    const before = tierTable();
    try {
      const table: TierTable = { ...DEFAULT_TIERS, PSA: parseTiers("$6-8: flat $5, $8-10: market - $3, $10-200: 100%") };
      setTierTable(table);
      const l = lot();
      const { candidates } = selectCandidates([l], () => {});
      const row = evaluateSold(AUCTION, l, candidates[0], priced([80, 95, 100, 105, 130]), NOW);
      expect(row.tier_band).toBe("$10-200");
      expect(row.tier_rule).toBe("100% all-in");
      expect(row.sniper_max_hammer).toBe(66);
      expect(row.sniper_could_win).toBe("yes");
    } finally {
      setTierTable(before);
    }
  });
});

// ── The sheets ───────────────────────────────────────────────────────────────

/** A priceable lot: market value $100, lowest comp $90, paid `pct`% of market value. Eligible under the default table unless told otherwise. */
const row = (venueKey: "fanatics" | "alt", pct: number, over: Partial<LotRow> = {}): LotRow => {
  const low = over.sniper_market_price ?? 90;
  return {
    venue: venueKey === "alt" ? "Alt" : "Fanatics Collect", auction: "a", closed: "", lot: "", title: "", grader: "PSA", grade: "10", language: "English", cert: "", keywords: "V",
    hammer: pct / 1.2, all_in: pct, bid_count: 5,
    market_low: low, market_value: 100, market_high: 110, sales_used: 5, oldest_sale_days: 10, own_sale_in_comps: "no",
    hammer_pct: pct / 1.2, all_in_pct: pct, bucket: bucketOf(pct),
    sniper_market_price: low, low_pct_of_value: Number(low), tier_band: "$90-450", tier_rule: "80% all-in", sniper_max_hammer: 60, sniper_max_all_in: 72, sniper_max_pct: 72,
    sniper_could_win: pct / 1.2 < 60 ? "yes" : "no",
    grid_band: gridBandLabel(Number(low)),
    resale_rate_pct: 90, resells_for: 90, winner_profit: Math.round((90 - pct) * 100) / 100,
    url: "", status: "eligible",
    priceable: true, eligible: true, venueKey, auctionId: "a", priority: 0, ...over,
  };
};

describe("the share curve", () => {
  test("a rule wins a lot when the bid it makes off the lowest comp beats the hammer, at the lot's own house's ladder", () => {
    // Lowest comp $90. 70% all-in is $63, a $52 hammer: beats a $50 hammer, not a $75 one.
    expect(wonBy(row("alt", 60), { kind: "share", share: 0.7 })).toBe(true);
    expect(wonBy(row("alt", 90), { kind: "share", share: 0.7 })).toBe(false);
    // Even 100% ($90 all-in, $75 hammer) does not beat a $75 hammer.
    expect(wonBy(row("alt", 90), { kind: "share", share: 1 })).toBe(false);
    // Fanatics wants a rung: a $52 max is on the $52 rung ($2 steps above $50).
    expect(wonBy(row("fanatics", 60), { kind: "share", share: 0.7 })).toBe(true);
    // A $51 max at Fanatics falls back to the $50 rung, which does not beat a $50 hammer.
    expect(wonBy(row("fanatics", 60, { sniper_market_price: 88 }), { kind: "share", share: 0.7 })).toBe(false);
    expect(wonBy(row("alt", 60, { sniper_market_price: "" }), { kind: "share", share: 1 })).toBe(false);
  });

  test("an outcome is what was won, what it cost, what it resells for and the profit that leaves", () => {
    const rows = [row("alt", 60), row("alt", 90)];
    // Market value $100, PSA — $100 is the top of the 90% band, so it resells
    // at 85%, for $85. The $60 lot was a $50 hammer.
    const o = outcomeOf(rows, [rows[0]], DEFAULT_RESALE);
    expect(o).toEqual({ won: 1, winRate: 50, paid: 60, value: 100, resale: 85, profit: 25, margin: 41.7, profitPerLot: 25 });
    expect(outcomeOf(rows, [], DEFAULT_RESALE)).toMatchObject({ won: 0, profit: 0, margin: "", profitPerLot: "" });
  });

  test("the best rule in a band is the one that made the most money, not the one with the best margin", () => {
    // Both off a $90 lowest comp. The first is worth $90 and went for a $50
    // hammer; the second is worth $99 and went for $70 — still profitable,
    // barely.
    const cheap = row("alt", 0, { sniper_market_price: 90, market_value: 90, hammer: 50, all_in: 60 });
    const dear = row("alt", 0, { sniper_market_price: 90, market_value: 99, hammer: 70, all_in: 84 });
    const answer = answerFor(gridBands().find((b) => b.label === "$90-150")!, [cheap, dear], DEFAULT_RESALE);
    const at = (pct: number) => answer.tried.find((t) => t.rule.kind === "share" && Math.round(t.rule.share * 100) === pct)!;
    // 70% takes the cheap one alone: $60 paid, $81 back — 35% on the spend.
    expect(at(70).outcome).toMatchObject({ won: 1, paid: 60, profit: 21, margin: 35 });
    // 95% takes both: $144 paid, $170.10 back — more money, half the margin.
    expect(at(95).outcome).toMatchObject({ won: 2, paid: 144, profit: 26.1, margin: 18.1 });
    expect(answer.best!.rule).toEqual({ kind: "share", share: 0.95 });
    expect(answer.best!.outcome.profit).toBe(26.1);
  });

  test("the cheapest rule that wins the same lots is the one taken", () => {
    // One lot, a $50 hammer off a $90 lowest comp: every share from 70% up takes
    // it for the same $60, so the lowest of them is the answer.
    const answer = answerFor(gridBands().find((b) => b.label === "$90-150")!, [row("alt", 60)], DEFAULT_RESALE);
    expect(answer.best!.rule).toEqual({ kind: "share", share: 0.7 });
    expect(answer.best!.outcome).toMatchObject({ won: 1, paid: 60, profit: 25 });
  });

  test("a band nothing could be won in has no best", () => {
    // A $90 lowest comp bid at the top share searched is a $112 hammer, which
    // a lot that went for $120 is still clear of.
    const gone = row("alt", 0, { sniper_market_price: 90, market_value: 100, hammer: 120, all_in: 144 });
    expect(answerFor(gridBands().find((b) => b.label === "$90-150")!, [gone], DEFAULT_RESALE).best).toBeNull();
  });

  test("a row per house, grader, band and rule, with the given table's own row beside them", () => {
    const sheet = shareCurveSheet([row("alt", 60), row("alt", 90)], DEFAULT_RESALE);
    expect(sheet[0]).toEqual(CURVE_COLUMNS);
    const at = (name: string) => columnsNamed(sheet[0], [name])[0];
    const rows = sheet.slice(1);
    // One house, PSA only, and a $90 lowest comp is in one grid band.
    expect([...new Set(rows.map((r) => `${r[at("venue")]} · ${r[at("grader")]} · ${r[at("band")]}`))]).toEqual(["Alt · PSA · $90-150"]);
    expect(rows.map((r) => r[at("rule")])).toEqual(["as configured", ...shareSearch().map((p) => `${p}%`)]);
    expect(rows[0].slice(at("lots"), at("rule"))).toEqual([2, 90, 100, 85]);
    // The given table (80% of $90 = $72 all-in, a $60 hammer) takes the $50-hammer lot.
    expect(rows[0].slice(at("could win"))).toEqual([1, 50, 60, 100, 85, 25, 41.7, 25, ""]);
    expect(rows.filter((r) => r[at("best")] === "yes")).toHaveLength(1);
    // The $75-hammer lot cannot be won at any share, so 70% — the cheapest
    // share that takes the other one — is the best there is.
    expect(rows.find((r) => r[at("best")] === "yes")![at("rule")]).toBe("70%");
  });

  test("both houses together when both are there", () => {
    const sheet = shareCurveSheet([row("alt", 60), row("fanatics", 60)], DEFAULT_RESALE);
    const at = (name: string) => columnsNamed(sheet[0], [name])[0];
    expect([...new Set(sheet.slice(1).map((r) => String(r[at("venue")])))]).toEqual(["both houses", "Fanatics Collect", "Alt"]);
  });
});

describe("the table the numbers point to", () => {
  /** A lot whose five comps all agree, so its lowest comp is its market value. */
  const flat = (venueKey: "fanatics" | "alt", low: number, hammer: number, grader = "PSA"): LotRow =>
    row(venueKey, 0, {
      grader, sniper_market_price: low, market_low: low, market_value: low, market_high: low, low_pct_of_value: 100,
      hammer, all_in: round(hammer * 1.2), hammer_pct: round((hammer / low) * 100), all_in_pct: round((hammer * 1.2 / low) * 100),
      grid_band: gridBandLabel(low),
    });
  const round = (n: number) => Math.round(n * 100) / 100;

  test("neighbouring bands that want the same rule are merged into one", () => {
    // $70 card taken at a $40 hammer, $100 card at a $60: both need 75% and no more.
    const rec = recommendTable([flat("alt", 70, 40), flat("alt", 100, 60)], "alt", "PSA", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(rec.parts.map((p) => [p.label, ruleTextOf(p.rule), p.borrowed])).toEqual([["$60-90", "75%", null], ["$90-150", "75%", null]]);
    expect(formatTiers(rec.tiers!)).toBe("$60-150: 75%");
    // And the line it prints is a line a sniper can be given.
    expect(parseTiers(formatTiers(rec.tiers!))).toEqual(rec.tiers);
    expect(rec.total.best).toMatchObject({ won: 2, paid: 120, profit: 28 });
  });

  test("the margin bar trims the ends, which is what sets the floor and the ceiling", () => {
    // A CGC card worth $200 resells for 75% of that, $150; won at a $160
    // hammer it costs $192, so the only share that takes it loses $42.
    const good = flat("alt", 100, 50, "CGC");
    const bad = flat("alt", 200, 160, "CGC");
    const rec = recommendTable([good, bad], "alt", "CGC", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(rec.parts.map((p) => p.label)).toEqual(["$90-150"]);
    expect(rec.trimmed.map((t) => t.label)).toEqual(["$150-250"]);
    expect(rec.trimmed[0].why).toMatch(/under 10%/);
    expect(formatTiers(rec.tiers!)).toBe("$90-150: 65%");
  });

  test("a band that could never be won at any share is trimmed with that said", () => {
    // A $15 card that went for a $19 hammer: even the top share searched is
    // only an $18 bid, so nothing comes near it.
    const rec = recommendTable([flat("alt", 15, 19), flat("alt", 100, 60)], "alt", "PSA", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(rec.trimmed).toEqual([{ label: "$15-25", why: "nothing here could be won at any share" }]);
    expect(rec.tiers!.floor).toBe(90);
  });

  test("an interior band keeps its best rule whatever the margin, because the bands have to touch", () => {
    const rec = recommendTable(
      [flat("alt", 100, 50, "CGC"), flat("alt", 200, 160, "CGC"), flat("alt", 300, 150, "CGC")],
      "alt", "CGC", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    // $150-250 loses money but sits between two bands that do not, so it stays.
    expect(rec.parts.map((p) => p.label)).toEqual(["$90-150", "$150-250", "$250-400"]);
    expect(rec.parts[1].outcome.profit).toBeLessThan(0);
    expect(rec.trimmed).toEqual([]);
    expect(rec.tiers!.floor).toBe(90);
    expect(rec.tiers!.bands[rec.tiers!.bands.length - 1].upTo).toBe(400);
  });

  test("an interior band with too few wins of its own borrows the nearest believed band's rule", () => {
    // Two bands with five wins apiece earn their own rules; the one lot
    // between them cannot set a rule off itself, so it takes the cheaper
    // neighbour's. The empty $150-250 band closes up on its own.
    const cheap = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const dear = [1, 2, 3, 4, 5].map(() => flat("alt", 300, 150));
    const rec = recommendTable([...cheap, flat("alt", 100, 80), ...dear], "alt", "PSA", { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE });
    expect(rec.parts.map((p) => [p.label, ruleTextOf(p.rule), p.borrowed]))
      .toEqual([["$60-90", "75%", null], ["$90-150", "75%", "$60-90"], ["$250-400", "65%", null]]);
    // Borrowing the cheaper share, the middle band wins nothing — which is
    // the safe way to be wrong.
    expect(rec.parts[1].outcome.won).toBe(0);
    expect(formatTiers(rec.tiers!)).toBe("$60-150: 75%, $150-400: 65%");
    expect(parseTiers(formatTiers(rec.tiers!))).toEqual(rec.tiers);
  });

  test("a band with too few wins cannot be the floor or the ceiling", () => {
    const cheap = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const rec = recommendTable([...cheap, flat("alt", 300, 150)], "alt", "PSA", { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE });
    expect(rec.parts.map((p) => p.label)).toEqual(["$60-90"]);
    expect(rec.trimmed.map((t) => [t.label, t.why])).toEqual([["$250-400", "only 1 win(s), fewer than the 5 a band needs to set its own rule"]]);
  });

  test("a budget picks among the bands rather than taking every best rule", () => {
    // Two bands, each earning its own rule at 75%: the cheap one spends $240
    // an auction for $75, the dear one $360 for $65.
    const cheap = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const dear = [1, 2, 3, 4, 5].map(() => flat("alt", 100, 60));
    const lots = [...cheap, ...dear];
    const opts = { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE, auctions: 1 };

    const free = recommendUnderBudget(lots, "alt", opts)[0];
    expect(formatTiers(free.tiers!)).toBe("$60-150: 75%");
    expect(free.total.best).toMatchObject({ won: 10, paid: 600, profit: 140 });

    // $300 cannot have both. The cheap band earns more per dollar, so it
    // keeps its rule and the dear one drops to a share that wins nothing.
    const tight = recommendUnderBudget(lots, "alt", { ...opts, budget: 300 })[0];
    expect(formatTiers(tight.tiers!)).toBe("$60-90: 75%, $90-150: 50%");
    expect(tight.total.best).toMatchObject({ won: 5, paid: 240, profit: 75 });
    expect(tight.total.best.paid).toBeLessThanOrEqual(300);
  });

  test("a budget may push a band's rule down, never up", () => {
    const cheap = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const opts = { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE, auctions: 1 };
    // Money to spare changes nothing: 75% is what the band earned.
    expect(formatTiers(recommendUnderBudget(cheap, "alt", { ...opts, budget: 1_000_000 })[0].tiers!)).toBe("$60-90: 75%");
  });

  test("a budget is read per auction, not over the whole run", () => {
    const cheap = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const opts = { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE, budget: 100 };
    // $240 over one auction is over a $100 budget; over four it is $60, which fits.
    expect(recommendUnderBudget(cheap, "alt", { ...opts, auctions: 1 })[0].total.best.won).toBe(0);
    expect(recommendUnderBudget(cheap, "alt", { ...opts, auctions: 4 })[0].total.best.won).toBe(5);
  });

  test("one budget covers both graders at a house", () => {
    const psa = [1, 2, 3, 4, 5].map(() => flat("alt", 70, 40));
    const cgc = [1, 2, 3, 4, 5].map(() => flat("alt", 100, 50, "CGC"));
    const recs = recommendUnderBudget([...psa, ...cgc], "alt", { minMargin: 10, minWins: 5, resale: DEFAULT_RESALE, auctions: 1, budget: 300 });
    expect(recs.map((r) => r.grader)).toEqual(["PSA", "CGC"]);
    // $240 of PSA and $300 of CGC will not both fit, so only one is bid for.
    const spend = recs.reduce((a, r) => a + r.total.best.paid, 0);
    expect(spend).toBeLessThanOrEqual(300);
    expect(spend).toBeGreaterThan(0);
  });

  test("nothing worth bidding on at all is said, not guessed at", () => {
    const rec = recommendTable([flat("alt", 200, 160, "CGC")], "alt", "CGC", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(rec.tiers).toBeNull();
    expect(rec.parts).toEqual([]);
  });

  test("the open top band is closed at the dearest lot it actually held", () => {
    const rec = recommendTable([flat("alt", 900, 400)], "alt", "PSA", { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(rec.tiers!.bands[rec.tiers!.bands.length - 1].upTo).toBe(900);
    expect(formatTiers(rec.tiers!)).toBe("$600-900: 55%");
  });

  test("one recommendation per house and grader, and the sheet ends each with the line to paste", () => {
    const recs = recommendations([flat("alt", 100, 60), flat("fanatics", 100, 50, "CGC")], { minMargin: 10, minWins: 1, resale: DEFAULT_RESALE });
    expect(recs.map((r) => [r.venue, r.grader])).toEqual([["fanatics", "CGC"], ["alt", "PSA"]]);
    const sheet = recommendedSheet(recs);
    const paste = sheet.filter((r) => r[2] === "→ the line to paste");
    expect(paste).toHaveLength(2);
    expect(paste[0].slice(0, 4)).toEqual(["Fanatics Collect", "CGC", "→ the line to paste", "$90-150: 65%"]);
    expect(sheet.some((r) => r[2] === "   against the table this run was given")).toBe(true);
  });
});

describe("the sheets", () => {
  test("buckets count lots per grader and per venue, with a running share", () => {
    const sheet = bucketSheet([
      row("fanatics", 52), row("fanatics", 53, { grader: "CGC" }), row("alt", 72), row("alt", 130),
    ]);
    expect(sheet[0][0]).toBe("bucket (all-in % of market value)");
    // all, PSA, CGC, fanatics, alt — three columns each.
    expect(sheet[0].slice(1, 16)).toEqual([
      "all lots", "all share %", "all at or under %",
      "PSA lots", "PSA share %", "PSA at or under %",
      "CGC lots", "CGC share %", "CGC at or under %",
      "fanatics lots", "fanatics share %", "fanatics at or under %",
      "alt lots", "alt share %", "alt at or under %",
    ]);
    const at = (label: string) => sheet.find((r) => r[0] === label)!;
    expect(at("50-55%").slice(1, 4)).toEqual([2, 50, 50]);
    expect(at("70-75%").slice(1, 4)).toEqual([1, 25, 75]);
    expect(at("100%+").slice(1, 4)).toEqual([1, 25, 100]);
    // PSA: three of the four, one in 50-55 and two above.
    expect(at("50-55%").slice(4, 7)).toEqual([1, 33.3, 33.3]);
    // CGC: the one lot, all of it in 50-55.
    expect(at("50-55%").slice(7, 10)).toEqual([1, 100, 100]);
    // fanatics: both of its lots in 50-55.
    expect(at("50-55%").slice(10, 13)).toEqual([2, 100, 100]);
    expect(at("total").slice(1, 2)).toEqual([4]);
    expect(at("total").slice(4, 5)).toEqual([3]);
  });

  test("the summary keeps the label and two columns of every group", () => {
    // Buckets are three wide: the count and the running share, not the bucket's own.
    expect(groupColumns(5, 3, [0, 2])).toEqual([0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15]);
  });
});

describe("Playwright's socket crash", () => {
  const crash = (message: string, where = "/app/node_modules/playwright-core/lib/coreBundle.js:26126:55") => {
    const err = new TypeError(message);
    err.stack = `TypeError: ${message}\n    at captureSecurityDetails (${where})\n    at ClientRequest.<anonymous> (${where})`;
    return err;
  };

  test("the null peer certificate is recognised, by any of the fields it reads", () => {
    expect(isPlaywrightTlsCrash(crash("Cannot read properties of null (reading 'subject')"))).toBe(true);
    expect(isPlaywrightTlsCrash(crash("Cannot read properties of null (reading 'valid_from')"))).toBe(true);
    expect(isPlaywrightTlsCrash(crash("Cannot read properties of null (reading 'issuer')"))).toBe(true);
  });

  test("anything else is somebody else's problem", () => {
    // Our own null, in our own code.
    const ours = new TypeError("Cannot read properties of null (reading 'subject')");
    ours.stack = "TypeError: x\n    at evaluateSold (/app/scripts/sold-report.ts:1:1)";
    expect(isPlaywrightTlsCrash(ours)).toBe(false);
    // Playwright, but a different fault.
    expect(isPlaywrightTlsCrash(crash("page.goto: Timeout 30000ms exceeded"))).toBe(false);
    expect(isPlaywrightTlsCrash(crash("Cannot read properties of undefined (reading 'subject')"))).toBe(false);
    expect(isPlaywrightTlsCrash(new Error("Cannot read properties of null (reading 'subject')"))).toBe(false);
    expect(isPlaywrightTlsCrash("not an error")).toBe(false);
  });

  test("the guard counts what it swallows, rethrows the rest, and lets go afterwards", () => {
    const before = process.listeners("uncaughtException").length;
    const guard = guardPlaywrightTlsCrash();
    expect(process.listeners("uncaughtException")).toHaveLength(before + 1);
    const handler = process.listeners("uncaughtException").at(-1)! as (err: unknown) => void;

    handler(crash("Cannot read properties of null (reading 'subject')"));
    handler(crash("Cannot read properties of null (reading 'valid_to')"));
    expect(guard.swallowed()).toBe(2);

    const other = new RangeError("something else entirely");
    expect(() => handler(other)).toThrow(other);
    expect(guard.swallowed()).toBe(2);

    guard.release();
    expect(process.listeners("uncaughtException")).toHaveLength(before);
  });
});

const funnel = (venue: "fanatics" | "alt", name: string, rows: LotRow[]): AuctionFunnel => ({
  auction: { venue, id: name, name, closedAtUnixS: 1788746400, lots: [] },
  scanned: 100, counts: { offChaseList: 50, noCert: 0, blockList: 0, blockListDetail: "", masterBallOrDuplicate: 0 },
  candidates: 20, beyondMaxCards: 0, rows,
});

describe("a run whose pricing stopped early", () => {
  const funnels = [funnel("fanatics", "Weekly Auction #242", [])];
  const partial = { reason: "Playwright died", priced: 20000, total: 66469 };

  test("says so on the page, before anything else", () => {
    const page = summaryMarkdown(new Date("2026-09-10T00:00:00Z"), { fanatics: 10, alt: 10 }, funnels, [], partial);
    expect(page.split("\n")[2]).toContain("**Partial run.**");
    expect(page).toContain("20000 of 66469 cert(s) were priced");
    expect(summaryMarkdown(new Date(), { fanatics: 1, alt: 0 }, funnels, [])).not.toContain("Partial run");
  });

  test("and in the notes, as the second thing in them", () => {
    const notes = notesSheet(new Date(), { fanatics: 10, alt: 10 }, funnels, partial);
    expect(notes[2][0]).toBe("PARTIAL RUN");
    expect(String(notes[2][1])).toContain("not a random sample");
    expect(notesSheet(new Date(), { fanatics: 1, alt: 0 }, funnels).map((r) => r[0])).not.toContain("PARTIAL RUN");
  });

  test("the notes carry the table the lots were judged under", () => {
    const notes = notesSheet(new Date(), { fanatics: 1, alt: 0 }, funnels);
    expect(String(notes.find((r) => r[0] === "tier table")![1])).toContain("PSA: $7.5-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%");
  });
});

describe("per auction", () => {
  const funnels = [
    funnel("fanatics", "#242", [row("fanatics", 60), row("fanatics", 90, { grader: "CGC" })]),
    funnel("alt", "Aug 21 - Sep 04, 2026", [row("alt", 95)]),
  ];

  test("the auctions sheet is a row per auction and one per grader inside it", () => {
    const sheet = auctionSheet(funnels);
    expect(sheet[0].slice(0, 6)).toEqual(["venue", "auction", "closed", "grader", "sold PSA/CGC 7-10 lots", "candidates"]);
    const rows = sheet.slice(1);
    // Alt's auction is PSA only, so its grader row would copy its "all" row.
    expect(rows.map((r) => [r[1], r[3]])).toEqual([
      ["#242", "all"], ["#242", "PSA"], ["#242", "CGC"],
      ["Aug 21 - Sep 04, 2026", "all"],
    ]);
    // The auction's own counts sit on its "all" row only.
    expect(rows[0][4]).toBe(100);
    expect(rows[1][4]).toBe("");
    // Eligible and the median are per row; the share of the candidates is
    // only meaningful for the auction as a whole.
    expect(rows[0].slice(7, 10)).toEqual([2, 10, 75]);
    expect(rows[1].slice(7, 10)).toEqual([1, "", 60]);
    expect(rows[2].slice(7, 10)).toEqual([1, "", 90]);
    // The configured table takes the $50-hammer lot: paid $60 of a $100 market value.
    const at = (name: string) => columnsNamed(sheet[0], [name])[0];
    expect(rows[0].slice(at("as configured could win"))).toEqual([1, 50, 60, 100, 60]);
    expect(AUCTION_SUMMARY_COLUMNS.every((i) => i < sheet[0].length)).toBe(true);
  });

  test("a PSA-only run keeps one row per auction, not a copy per grader", () => {
    const psaOnly = [funnel("alt", "one", [row("alt", 80), row("alt", 95)])];
    expect(auctionSheet(psaOnly).slice(1).map((r) => r[3])).toEqual(["all"]);
  });

  test("the page leads with the lines to paste, then the buckets, the auctions and the funnel", () => {
    const page = summaryMarkdown(new Date("2026-09-10T00:00:00Z"), { fanatics: 1, alt: 1 }, funnels, funnels.flatMap((f) => f.rows));
    expect(page).toContain("### The tables to run next week");
    expect(page).toContain("**Fanatics Collect · PSA**");
    expect(page).toContain("**Alt · PSA**");
    expect(page).toContain("### By bucket");
    expect(page).toContain("### Auctions");
    expect(page).toContain("### Funnel");
    expect(page).toContain("by grader:");
    expect(page).toContain("**PSA** 2 lot(s)");
    // The table it compares against, and the rates every profit follows from.
    expect(page).toContain("**PSA** $7.5-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%");
    expect(page).toContain("**PSA** $0-100: 90%, $100-500: 85%, $500+: 85%");
    // A house that was not looked at gets no line.
    expect(summaryMarkdown(new Date(), { fanatics: 1, alt: 0 }, [funnels[0]], funnels[0].rows)).not.toContain("**Alt · ");
  });
});

describe("Fanatics' closed auctions", () => {
  test("the auction's number, under either name", () => {
    expect(auctionNumber("Weekly Auction #241")).toBe(241);
    expect(auctionNumber("Weekly Sunday Auction #241")).toBe(241);
    expect(auctionNumber("Premier Auction")).toBeNull();
    expect(auctionNameFilter(241)).toBe(`(auctionName:"Weekly Sunday Auction #241" OR auctionName:"Weekly Auction #241")`);
  });

  test("a sold record: hammer, the price paid with the premium, the guide value", () => {
    const l = fanaticsSoldLot({
      listingUuid: "u", title: "2003 Pokemon Skyridge Holo Houndoom #H11 PSA 10 GEM MINT", serial: "27770567", grade: 10, gradingService: "PSA",
      currentBid: 26000, bidCount: 29, auctionEndDatetime: 1788746400, auctionName: "Weekly Sunday Auction #242", lotNumber: "WA242 Lot: 15843",
      subCategory1: ["Trading Card Games > Pokémon (English)"], purchasePrice: 31200, value: 150000,
    });
    expect(l.hammer).toBe(26000);
    expect(l.allIn).toBe(31200);
    expect(l.houseValue).toBe(150000);
    expect(l.closedAtUnixS).toBe(1788746400);
    expect(l.cert).toBe("27770567");
    expect(l.language).toBe("English");
    expect(l.url).toBe("https://www.fanaticscollect.com/weekly/u");
  });

  test("without purchasePrice the premium is put on", () => {
    expect(fanaticsSoldLot({ listingUuid: "u", title: "t", currentBid: 100 }).allIn).toBe(120);
  });
});

describe("Alt's closed auctions", () => {
  test("a cycle closes at 9 PM Eastern on the day its name ends", () => {
    // 9 PM EDT is 01:00 UTC the next day.
    expect(cycleCloseUnixS("Aug 21 - Sep 04, 2026")).toBe(Date.UTC(2026, 8, 5, 1) / 1000);
    // Across the year: the second half carries the year.
    expect(cycleCloseUnixS("Dec 19, 2025 - Jan 01, 2026")).toBe(Date.UTC(2026, 0, 2, 2) / 1000);
    expect(cycleCloseUnixS("Weekly Auction")).toBeNull();
  });

  test("zoned wall-clock times", () => {
    expect(zonedUnixS(2026, 9, 4, 21, "America/New_York")).toBe(Date.UTC(2026, 8, 5, 1) / 1000);
    // January: 9 PM EST is 02:00 UTC the next day.
    expect(zonedUnixS(2026, 1, 15, 21, "America/New_York")).toBe(Date.UTC(2026, 0, 16, 2) / 1000);
  });

  test("a sold document: the price includes the premium, the hammer is derived, the grade goes back on the title", () => {
    const l = altSoldLot({
      listingId: "5495fd9e", name: "2002 Pokemon Legendary Collection Reverse Holo Gengar #11", gradingCompany: "PSA", grade: "10", gradeKey: "PSA-10",
      price: 120, auctionName: "Aug 21 - Sep 04, 2026", soldDate: "2026-09-04",
    }, 1788656400);
    expect(l.allIn).toBe(120);
    expect(l.hammer).toBe(100);
    expect(l.currentBid).toBe(100);
    expect(l.title).toBe("2002 Pokemon Legendary Collection Reverse Holo Gengar #11 PSA 10");
    expect(l.grade).toBe(10);
    expect(l.bidCountKnown).toBe(false);
    expect(l.url).toBe("https://alt.xyz/itm/5495fd9e/sold");
    expect(l.cert).toBe("");
  });

  test("CGC Pristine reads as a 10 and says so on the title", () => {
    const l = altSoldLot({ listingId: "x", name: "Card", gradingCompany: "CGC", grade: "10", gradeKey: "CGC-PRI", price: 12 }, 0);
    expect(l.grade).toBe(10);
    expect(l.pristine).toBe(true);
    expect(l.title).toBe("Card CGC 10 Pristine");
  });

  test("a plain reverse holo is a candidate at Alt, as the Alt sniper would have it", () => {
    const l = altSoldLot({ listingId: "x", name: "2002 Pokemon Legendary Collection Reverse Holo Gengar #11", gradingCompany: "PSA", grade: "10", gradeKey: "PSA-10", price: 120 }, 0);
    expect(selectCandidates([{ ...l, cert: "1" }], () => {}, { chaseList: false }).candidates).toHaveLength(1);
    expect(selectCandidates([{ ...l, cert: "1" }], () => {}, { chaseList: true }).candidates).toHaveLength(0);
  });
});

describe("the workbook", () => {
  test("column letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });

  test("sheet names Excel will take", () => {
    expect(sheetName("Lots")).toBe("Lots");
    expect(sheetName("a/b:c*d?e[f]")).toBe("a b c d e f");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });

  test("CRC-32 of a known string", () => {
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  test("a stored zip has a local header per entry and one central directory", () => {
    const zip = zipStored([{ name: "a.txt", data: Buffer.from("hello") }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(1);
    expect(zip.subarray(30, 35).toString()).toBe("a.txt");
    expect(zip.subarray(35, 40).toString()).toBe("hello");
  });

  test("a workbook carries its parts, numbers as values and text inline", () => {
    const buf = xlsxBuffer([{ name: "Lots", rows: [["title", "pct"], ["Giratina & Co <V>", 72.5], ["", null]] }]);
    const text = buf.toString("latin1");
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("xl/worksheets/sheet1.xml");
    expect(text).toContain(`<c r="B2"><v>72.5</v></c>`);
    expect(text).toContain(`Giratina &amp; Co &lt;V&gt;`);
    expect(text).toContain(`<sheet name="Lots" sheetId="1" r:id="rId1"/>`);
    // The header row is bold; an empty row is still a row.
    expect(text).toContain(`<c r="A1" s="1" t="inlineStr">`);
    expect(text).toContain(`<row r="3"></row>`);
  });
});
