/**
 * Two rules about what is left alone: a card the auction holds too many
 * copies of, and a card whose price is falling.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CardCaps } from "@/scripts/sniper-book";
import {
  DEFAULT_BASIS,
  DEFAULT_SALES_RULE,
  copySupply,
  fallingCheckFromArgs,
  fallingReason,
  newestIsLowest,
  parseBasis,
  parseTiers,
  quoteBand,
  setBasis,
  setFallingCheck,
  setSalesRule,
  setTierTable,
  tooManyCopies,
  TIERS_OFF,
  type PriceEvidence,
  type Sale,
} from "@/scripts/sniper-core";

const NOW = new Date("2026-10-11T00:00:00Z");
const sale = (price: number, daysAgo: number): Sale => ({ price, date: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() });
const evidence = (sales: Sale[], over: Partial<PriceEvidence> = {}): PriceEvidence => ({ sales, altValue: null, now: NOW, ...over });

beforeEach(() => {
  setBasis(DEFAULT_BASIS);
  setSalesRule(DEFAULT_SALES_RULE);
  setTierTable({ PSA: parseTiers("$1-100: 75%, $100-1000: 65% of lowest"), CGC: TIERS_OFF });
});
afterEach(() => {
  setFallingCheck(false);
  setBasis(DEFAULT_BASIS);
});

describe("the newest sale being the lowest", () => {
  test("is found whatever order the sales come in", () => {
    const falling = [sale(30, 20), sale(20, 1), sale(28, 8), sale(26, 12), sale(32, 30)];
    expect(newestIsLowest(falling)?.price).toBe(20);
    expect(newestIsLowest([...falling].reverse())?.price).toBe(20);
  });

  test("is not so when an older sale was lower, or the newest merely low", () => {
    expect(newestIsLowest([sale(22, 1), sale(20, 8), sale(28, 12), sale(26, 20), sale(32, 30)])).toBeNull();
    expect(newestIsLowest([sale(40, 1), sale(20, 8), sale(28, 12)])).toBeNull();
  });

  test("a tie for the lowest still counts when the newest is one of the two", () => {
    expect(newestIsLowest([sale(20, 1), sale(20, 9), sale(28, 12)])?.price).toBe(20);
  });

  test("one sale, or every sale at one price, is not a card falling", () => {
    expect(newestIsLowest([sale(20, 1)])).toBeNull();
    expect(newestIsLowest([sale(20, 1), sale(20, 5), sale(20, 9)])).toBeNull();
    expect(newestIsLowest([])).toBeNull();
  });

  test("sales dated to the same moment are taken together, the cheapest of them the newest", () => {
    const at = NOW.toISOString();
    expect(newestIsLowest([{ price: 25, date: at }, { price: 18, date: at }, sale(30, 5)])?.price).toBe(18);
    expect(newestIsLowest([{ price: 25, date: at }, { price: 31, date: at }, sale(20, 5)])).toBeNull();
  });
});

describe("a falling card at the bid", () => {
  const falling = [sale(20, 1), sale(26, 8), sale(28, 12), sale(30, 20), sale(32, 30)];
  const steady = [sale(26, 1), sale(20, 8), sale(28, 12), sale(30, 20), sale(32, 30)];

  test("priced off the 2nd lowest, it is left alone; the same sales in another order are bid on", () => {
    setFallingCheck(true);
    expect(quoteBand("PSA", 26, evidence(falling))).toEqual({
      ok: false,
      reason: "the most recent of its 5 sales, $20, is also the lowest — the price is falling, so the lot is left alone",
    });
    const bid = quoteBand("PSA", 26, evidence(steady));
    expect(bid).toMatchObject({ ok: true, quote: { price: 26, rule: "75% all-in" } });
  });

  test("only where the 2nd lowest is the basis: a run on another basis is priced as it asked", () => {
    setFallingCheck(true);
    for (const basis of ["lowest", "3rd lowest", "average of the 3 lowest", "median", "average"]) {
      setBasis(parseBasis(basis));
      expect(quoteBand("PSA", 26, evidence(falling)), basis).toMatchObject({ ok: true });
    }
    setBasis(parseBasis("2nd lowest"));
    expect(quoteBand("PSA", 26, evidence(falling))).toMatchObject({ ok: false });
  });

  test("a band that names its own basis is judged by that one, not the run's", () => {
    setFallingCheck(true);
    const dear = [sale(200, 1), sale(260, 8), sale(280, 12), sale(300, 20), sale(320, 30)];
    // The $100-1000 band prices off the lowest, so a run on the 2nd lowest still bids there…
    expect(quoteBand("PSA", 260, evidence(dear))).toMatchObject({ ok: true, quote: { price: 200 } });
    // …and a band that names the 2nd lowest is judged on a run that does not.
    setBasis(parseBasis("median"));
    setTierTable({ PSA: parseTiers("$1-100: 75% of 2nd lowest"), CGC: TIERS_OFF });
    expect(quoteBand("PSA", 26, evidence(falling))).toMatchObject({ ok: false });
  });

  test("off unless a run turns it on, and a run turns it on unless told not to", () => {
    expect(quoteBand("PSA", 26, evidence(falling))).toMatchObject({ ok: true });
    expect(fallingCheckFromArgs({})).toBe(true);
    expect(fallingCheckFromArgs({ ALLOW_FALLING: "" })).toBe(true);
    expect(fallingCheckFromArgs({ ALLOW_FALLING: "1" })).toBe(false);
    expect(fallingCheckFromArgs({ ALLOW_FALLING: "true" })).toBe(false);
  });

  test("the backtest sets the lot's own sale aside first, so a lot that went cheap is not a card falling", () => {
    setFallingCheck(true);
    // The lot itself sold for $20 yesterday; before it, the newest sale was $28 and the lowest $26.
    const own = sale(20, 1);
    const wentCheap = [own, sale(28, 8), sale(26, 12), sale(30, 20), sale(32, 30)];
    expect(fallingReason(evidence(wentCheap), wentCheap)).toMatch(/price is falling/);
    expect(fallingReason(evidence(wentCheap, { omit: (s) => s === own }), wentCheap)).toBeNull();
    // With it set aside the next newest is judged: $22 a week ago, under everything older.
    const stillFalling = [own, sale(22, 8), sale(28, 12), sale(30, 20), sale(32, 30)];
    expect(fallingReason(evidence(stillFalling, { omit: (s) => s === own }), stillFalling))
      .toMatch(/the most recent of its 4 sales, \$22, is also the lowest/);
  });
});

describe("copies of a card, all or none", () => {
  const CAPS: CardCaps = { perCard: Infinity, perCardByGrader: { CGC: 4 } };
  const KEY = "pikachu|151|025|japanese";
  const copy = (grader: string, grade: string, grade_label = "", card_key = KEY) => ({ card_key, grader, grade, grade_label });
  const many = (n: number, grader: string, grade: string, label = "") => Array.from({ length: n }, () => copy(grader, grade, label));

  test("four CGC copies at one grade are all bid on; a fifth in the auction and none is", () => {
    const four = many(4, "CGC", "9");
    expect(four.map((row) => tooManyCopies(row, copySupply(four), CAPS))).toEqual([null, null, null, null]);
    const five = many(5, "CGC", "9");
    for (const row of five) {
      expect(tooManyCopies(row, copySupply(five), CAPS))
        .toBe("5 CGC 9 copies of this card in the auction, more than the 4 a run may hold — all or none");
    }
  });

  test("each grade is counted apart, and a CGC 10 Pristine apart from a Gem Mint", () => {
    const lots = [...many(4, "CGC", "9"), ...many(3, "CGC", "10", "Pristine"), ...many(3, "CGC", "10", "Gem Mint"), ...many(6, "CGC", "8.5")];
    const supply = copySupply(lots);
    expect(tooManyCopies(copy("CGC", "9"), supply, CAPS)).toBeNull();
    expect(tooManyCopies(copy("CGC", "10", "Pristine"), supply, CAPS)).toBeNull();
    expect(tooManyCopies(copy("CGC", "10", "Gem Mint"), supply, CAPS)).toBeNull();
    expect(tooManyCopies(copy("CGC", "8.5"), supply, CAPS)).toMatch(/^6 CGC 8\.5 copies/);
  });

  test("PSA has no limit unless the run gives it one", () => {
    const lots = many(12, "PSA", "10");
    expect(tooManyCopies(lots[0], copySupply(lots), CAPS)).toBeNull();
    expect(tooManyCopies(lots[0], copySupply(lots), { perCard: Infinity, perCardByGrader: { CGC: 4, PSA: 8 } }))
      .toMatch(/^12 PSA 10 copies .* more than the 8/);
  });

  test("a limit on the card itself counts every grade and both graders", () => {
    const lots = [...many(4, "PSA", "10"), ...many(3, "CGC", "9")];
    const caps: CardCaps = { perCard: 6, perCardByGrader: { CGC: 4 } };
    for (const row of lots) {
      expect(tooManyCopies(row, copySupply(lots), caps)).toBe("7 copies of this card in the auction, more than the 6 a run may hold — all or none");
    }
    expect(tooManyCopies(lots[0], copySupply(lots.slice(1)), caps)).toBeNull();
  });

  test("a copy that is not worth a bid is a copy in the auction all the same", () => {
    // Three worth a bid, two already past the max: five in the auction, so none.
    const worthy = many(3, "CGC", "9");
    const pastTheMax = many(2, "CGC", "9");
    expect(tooManyCopies(worthy[0], copySupply(worthy), CAPS)).toBeNull();
    expect(tooManyCopies(worthy[0], copySupply([...worthy, ...pastTheMax]), CAPS)).toMatch(/^5 CGC 9 copies/);
  });

  test("another card's copies are not this card's, and a lot that never identified is no copy of anything", () => {
    const lots = [...many(4, "CGC", "9"), ...Array.from({ length: 4 }, () => copy("CGC", "9", "", "eevee|151|133|japanese")), copy("CGC", "9", "", "")];
    const supply = copySupply(lots);
    expect(tooManyCopies(copy("CGC", "9"), supply, CAPS)).toBeNull();
    expect(tooManyCopies(copy("CGC", "9", "", ""), supply, CAPS)).toBeNull();
    expect(supply.size).toBe(4);
  });
});
