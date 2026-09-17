import { describe, expect, test } from "vitest";
import type { Row } from "@/scripts/fanatics-sniper";
import { FANATICS_STEPS } from "@/scripts/fanatics-bidder";
import { ALT_STEPS } from "@/scripts/alt-bidder";
import {
  BUYERS_PREMIUM,
  cardCaps,
  fireAfterFromArgs,
  fireAtUnixS,
  pricedOut,
  timeToFire,
  CSV_COLUMNS,
  DEFAULT_TIERS,
  DEFAULT_MAX_COPIES_PER_CARD,
  applyRule,
  blockedBy,
  isRetryable,
  isFinalAnswer,
  cardKey,
  finalCut,
  funnelText,
  marketPct,
  parallel,
  prettyPattern,
  SALES_WINDOW_DAYS,
  formatTiers,
  marketPrice,
  masterBallAllowed,
  matchKeywords,
  maxBid,
  parseTiers,
  priorityRank,
  salesGate,
  salesMedian,
  selectCandidates,
  maxCopiesFromArgs,
  setMaxCopiesPerCard,
  setTierTable,
  settle,
  tierCeiling,
  tierFloor,
  tierFor,
  tierTable,
  tiersFromArgs,
  toCsv,
  type ScannedLot,
} from "@/scripts/fanatics-sniper";

describe("chase list", () => {
  test("matches the codes and phrases on the list", () => {
    expect(matchKeywords("2022 Pokemon Sword & Shield Lost Origin Alt Art Giratina V #186 PSA 10 GEM MINT"))
      .toEqual(["V", "Alt Art"]);
    expect(matchKeywords("2018 Pokemon Sun & Moon Celestial Storm Rainbow Rare Rayquaza GX #177 PSA 10 GEM MINT"))
      .toEqual(["GX", "Rainbow Rare"]);
    expect(matchKeywords("2025 Pokemon Scarlet & Violet Black Bolt SIR Zekrom ex #166 CGC 9 MINT")).toEqual(["SIR"]);
    expect(matchKeywords("2021 Pokemon Japanese Sword & Shield VMAX Climax CHR Pikachu #196 PSA 10")).toEqual(["CHR", "VMAX"]);
    expect(matchKeywords("2018 POKEMON SUN & MOON LOST THUNDER FA/LUGIA GX #227 PSA 9")).toEqual(["Full Art", "GX"]);
    expect(matchKeywords("2000 Pokemon Neo Genesis 1st Edition Holo Lugia #9 PSA 8 NM-MT")).toEqual(["1st Edition Holo"]);
    expect(matchKeywords("1999 Pokemon Jungle Holo Snorlax #11 CGC 8.5")).toEqual(["Jungle"]);
    expect(matchKeywords("2016 Pokemon XY Evolutions Holo Charizard #11 PSA 9")).toEqual(["XY Evolutions"]);
    expect(matchKeywords("2022 Pokemon Sword & Shield Brilliant Stars Trainer Gallery Charizard VSTAR #TG28 CGC 10"))
      .toEqual(["VSTAR", "Trainer Gallery"]);
  });

  test("V means the card type, not any letter V", () => {
    expect(matchKeywords("2005 Pokemon EX Unseen Forces Holo Unown #V CGC 8.5 NM-MT+")).toEqual([]);
    expect(matchKeywords("2021 Pokemon Sword & Shield Evolving Skies Rayquaza VMAX #111 PSA 10")).toEqual(["VMAX"]);
    expect(matchKeywords("2021 Pokemon Mewtwo V-UNION Promo #SWSH159 PSA 10")).toEqual(["Promo"]);
    expect(matchKeywords("2021 Pokemon Sword & Shield Evolving Skies Alt Art Rayquaza V #194 PSA 10 GEM MINT"))
      .toEqual(["V", "Alt Art"]);
  });

  test("short codes are case-sensitive so names never trip them", () => {
    expect(matchKeywords("1999 Pokemon Base Set Holo Sir Charizard PSA 8")).toEqual([]);
    expect(matchKeywords("2024 Pokemon Japanese Terastal Festival AR Ma Pikachu PSA 10")).toEqual(["AR"]);
  });

  test("a plain holo from a set not on the list is not chased", () => {
    expect(matchKeywords("2003 Pokemon Skyridge Holo Houndoom #H11 PSA 10 GEM MINT")).toEqual([]);
  });
});

describe("block list", () => {
  test("drops graded things that are not TCG cards", () => {
    expect(blockedBy("1997 Pokemon Japanese Old Maid Babanuki Charizard PSA 9")).not.toBeNull();
    expect(blockedBy("2000 Topps Chrome Pokemon Series 1 Sparkle Kadabra #64 PSA 10")).not.toBeNull();
    expect(blockedBy("1997 Pokemon Japanese Carddass Vending Charizard PSA 8")).not.toBeNull();
    expect(blockedBy("1999 Pokemon Playing Cards Pikachu Poker Deck Ace of Spades PSA 10")).not.toBeNull();
  });

  test("leaves real cards alone", () => {
    expect(blockedBy("2001 Pokemon Japanese CoroCoro Comic Promo Holo Shining Mew #151 CGC 10")).toBeNull();
    expect(blockedBy("2017 Pokemon Black & White Boundaries Crossed Battle Arena Decks Holo Black Kyurem EX #101 CGC 7"))
      .toBeNull();
  });
});

describe("Master Ball gate", () => {
  test("PSA 10 or CGC Pristine 10 only", () => {
    expect(masterBallAllowed({ grade: 10, gradingService: "PSA", title: "Master Ball Pikachu PSA 10" })).toBe(true);
    expect(masterBallAllowed({ grade: 10, gradingService: "CGC", title: "Master Ball Pikachu CGC 10 PRISTINE" })).toBe(true);
    expect(masterBallAllowed({ grade: 10, gradingService: "CGC", title: "Master Ball Pikachu CGC 10 GEM MINT" })).toBe(false);
    expect(masterBallAllowed({ grade: 9, gradingService: "PSA", title: "Master Ball Pikachu PSA 9" })).toBe(false);
  });
});

describe("tier table", () => {
  test("CGC rules by price band", () => {
    expect(tierFor("CGC", 7.49)).toBeNull();
    expect(tierFor("CGC", 7.5)).toEqual({ kind: "flat", hammer: 5 });
    expect(tierFor("CGC", 7.99)).toEqual({ kind: "flat", hammer: 5 });
    expect(tierFor("CGC", 8)).toEqual({ kind: "offset", less: 3 });
    expect(tierFor("CGC", 9.99)).toEqual({ kind: "offset", less: 3 });
    expect(tierFor("CGC", 10)).toEqual({ kind: "share", share: 0.77 });
    expect(tierFor("CGC", 89.99)).toEqual({ kind: "share", share: 0.77 });
    expect(tierFor("CGC", 90)).toEqual({ kind: "share", share: 0.70 });
    expect(tierFor("CGC", 450)).toEqual({ kind: "share", share: 0.70 });
    expect(tierFor("CGC", 450.01)).toBeNull();
  });

  test("PSA rules by price band", () => {
    expect(tierFor("PSA", 7.49)).toBeNull();
    expect(tierFor("PSA", 7.5)).toEqual({ kind: "flat", hammer: 5 });
    expect(tierFor("PSA", 9)).toEqual({ kind: "offset", less: 3 });
    expect(tierFor("PSA", 10)).toEqual({ kind: "share", share: 0.85 });
    expect(tierFor("PSA", 89.99)).toEqual({ kind: "share", share: 0.85 });
    expect(tierFor("PSA", 90)).toEqual({ kind: "share", share: 0.80 });
    expect(tierFor("PSA", 450)).toEqual({ kind: "share", share: 0.80 });
    expect(tierFor("PSA", 451)).toBeNull();
    expect(tierFloor("PSA")).toBe(7.5);
    expect(tierFloor("CGC")).toBe(7.5);
    expect(tierCeiling("PSA")).toBe(450);
  });

  test("the floor is what keeps a flat $5 off a card worth $1", () => {
    expect(maxBid("PSA", 1)).toBeNull();
    expect(maxBid("CGC", 5.99)).toBeNull();
    // $6–7.49 was bid on until odds v6; the pack ladder now starts at $7.50.
    expect(maxBid("CGC", 7.49)).toBeNull();
    expect(maxBid("PSA", 7.5)).toEqual({ rule: "flat $5", share: null, allIn: 6, hammer: 5 });
  });

  test("the table is written one line per grader, and reads back the same", () => {
    expect(formatTiers(DEFAULT_TIERS.PSA)).toBe("$7.5-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%");
    expect(formatTiers(DEFAULT_TIERS.CGC)).toBe("$7.5-8: flat $5, $8-10: market - $3, $10-90: 77%, $90-450: 70%");
    expect(parseTiers(formatTiers(DEFAULT_TIERS.PSA))).toEqual(DEFAULT_TIERS.PSA);
    expect(parseTiers(formatTiers(DEFAULT_TIERS.CGC))).toEqual(DEFAULT_TIERS.CGC);
    // The workflow inputs spell the floor "$7.50"; the parser reads it the same.
    expect(parseTiers("$7.50-8: flat $5, $8-10: market - $3, $10-90: 85%, $90-450: 80%")).toEqual(DEFAULT_TIERS.PSA);
  });

  test("the line is read loosely: dollar signs, spaces and semicolons optional, a bare share as well", () => {
    expect(parseTiers("4-8:flat 3; 8 - 10 : market-2 ; 10-100: 90 %")).toEqual({
      floor: 4,
      bands: [
        { upTo: 8, rule: { kind: "flat", hammer: 3 } },
        { upTo: 10, rule: { kind: "offset", less: 2 } },
        { upTo: 100, rule: { kind: "share", share: 0.9 } },
      ],
    });
    expect(parseTiers("$10-500: 72.5%").bands[0].rule).toEqual({ kind: "share", share: 0.725 });
  });

  test("a line that cannot be read is an error naming the band, not a guess", () => {
    expect(() => parseTiers("$6-8: flat $5, $10-90: 85%")).toThrow(/starts at \$10 but the one before it ends at \$8/);
    expect(() => parseTiers("$8-6: flat $5")).toThrow(/does not run upward/);
    expect(() => parseTiers("$6-8: cheap")).toThrow(/cannot read the rule "cheap"/);
    expect(() => parseTiers("flat $5")).toThrow(/cannot read the band/);
    expect(() => parseTiers("$6-8: flat $0")).toThrow(/at least \$1/);
    expect(() => parseTiers("$10-90: 250%")).toThrow(/between 0% and 200%/);
    expect(() => parseTiers("")).toThrow(/at least one band/);
  });

  test("a run bids by the table it is given, per grader, and the default otherwise", () => {
    const before = tierTable();
    try {
      setTierTable(tiersFromArgs({ TIERS_PSA: "$4-8: flat $3, $8-200: 90%" }));
      expect(tierFloor("PSA")).toBe(4);
      expect(tierCeiling("PSA")).toBe(200);
      expect(maxBid("PSA", 5)).toEqual({ rule: "flat $3", share: null, allIn: 3.6, hammer: 3 });
      expect(maxBid("PSA", 100)).toEqual({ rule: "90% all-in", share: 0.9, allIn: 90, hammer: 75 });
      expect(maxBid("PSA", 201)).toBeNull();
      // CGC was not given, so it is the default still.
      expect(tierTable().CGC).toBe(DEFAULT_TIERS.CGC);
      expect(maxBid("CGC", 100)).toEqual({ rule: "70% all-in", share: 0.7, allIn: 70, hammer: 58 });
      expect(() => tiersFromArgs({ TIERS_CGC: "$6-8: nope" })).toThrow(/the CGC tier table could not be read/);
    } finally {
      setTierTable(before);
    }
  });

  test("a rule on its own, for trying one that is not in the table", () => {
    expect(applyRule({ kind: "share", share: 0.5 }, 100)).toEqual({ rule: "50% all-in", share: 0.5, allIn: 50, hammer: 41 });
    expect(applyRule({ kind: "offset", less: 3 }, 3.5)).toBeNull();
    expect(applyRule({ kind: "flat", hammer: 1 }, 1_000)).toEqual({ rule: "flat $1", share: null, allIn: 1.2, hammer: 1 });
  });

  test("the set max bids are the bid itself, with the premium on top", () => {
    expect(BUYERS_PREMIUM).toBe(0.20);
    // $7.50-8: a flat $5 bid, which costs $6 all-in.
    expect(maxBid("CGC", 7.75)).toEqual({ rule: "flat $5", share: null, allIn: 6, hammer: 5 });
    // $8-10: market less $3, rounded down to the whole dollar Fanatics bids in.
    expect(maxBid("PSA", 9.75)).toEqual({ rule: "market - $3", share: null, allIn: 7.2, hammer: 6 });
    // The two rules meet at $8, where market - $3 is the same flat $5.
    expect(maxBid("PSA", 8)).toEqual({ rule: "market - $3", share: null, allIn: 6, hammer: 5 });
  });

  test("the percentages are all-in, and the hammer strips the premium rounding down", () => {
    // $73.38 PSA: 85% all-in = $62.37; hammer = floor(62.37 / 1.2) = $51
    expect(maxBid("PSA", 73.38)).toEqual({ rule: "85% all-in", share: 0.85, allIn: 62.37, hammer: 51 });
    // $250 CGC: 70% = $175 all-in, $145 hammer
    expect(maxBid("CGC", 250)).toEqual({ rule: "70% all-in", share: 0.70, allIn: 175, hammer: 145 });
    expect(maxBid("CGC", 1000)).toBeNull();
    expect(maxBid("CGC", 4)).toBeNull();
  });
});

describe("market price", () => {
  const at = (price: number) => ({ price, date: "2026-09-01" });

  test("the lowest of the recent sales, not their average", () => {
    const m = marketPrice([60, 64, 70, 72, 74].map(at));
    expect(m.price).toBe(60);
    expect(m.used).toHaveLength(5);
  });

  test("a comp that is far too high costs nothing, because the lowest is taken", () => {
    // The real case: Card Ladder filed a $635 Base Set Charizard among five
    // sales of a Japanese SV151 AR Psyduck PSA 10.
    expect(marketPrice([127.66, 91, 89, 93, 635].map(at)).price).toBe(89);
  });

  test("a comp that is too low only makes the bid smaller", () => {
    expect(marketPrice([2, 58, 60, 62, 68].map(at)).price).toBe(2);
  });

  test("only the five newest sales count", () => {
    const on = (price: number, date: string) => ({ price, date });
    const m = marketPrice([
      on(9, "2026-01-01"),
      on(50, "2026-09-05"), on(52, "2026-09-04"), on(54, "2026-09-03"),
      on(56, "2026-09-02"), on(58, "2026-09-01"),
    ]);
    expect(m.used.map((s) => s.price)).toEqual([50, 52, 54, 56, 58]);
    expect(m.price).toBe(50);
  });

  test("no sales at all", () => {
    expect(marketPrice([])).toEqual({ price: null, used: [] });
  });
});

describe("market value", () => {
  const at = (price: number) => ({ price, date: "2026-09-01" });

  test("the median of the same five sales, which a wild comp does not move", () => {
    expect(salesMedian([127.66, 91, 89, 93, 635].map(at))).toBe(93);
    expect(salesMedian([60, 64, 70, 72, 74].map(at))).toBe(70);
  });

  test("the middle two averaged when the count is even", () => {
    expect(salesMedian([10, 20, 31, 41].map(at))).toBe(25.5);
    expect(salesMedian([])).toBeNull();
  });

  test("only the five newest sales count, as for the price", () => {
    const on = (price: number, date: string) => ({ price, date });
    expect(salesMedian([
      on(900, "2026-01-01"),
      on(50, "2026-09-05"), on(52, "2026-09-04"), on(54, "2026-09-03"),
      on(56, "2026-09-02"), on(58, "2026-09-01"),
    ])).toBe(54);
  });

  test("what was paid as a share of it, in percent to one decimal", () => {
    expect(marketPct(48, 100)).toBe(48);
    expect(marketPct(55.2, 118.93)).toBe(46.4);
    expect(marketPct(10, 0)).toBe("");
  });

  test("a lot the account is winning is settled onto its row, premium included", () => {
    const row = { sales_median: 100, final_paid_all_in: "", market_pct: "" } as Row;
    settle(row, { status: "HIGH_BID", currentBidCents: 4_000 });
    expect(row.final_paid_all_in).toBe(48);
    expect(row.market_pct).toBe(48);
  });

  test("an outbid or unread lot has no price paid", () => {
    const outbid = { sales_median: 100, final_paid_all_in: "", market_pct: "" } as Row;
    settle(outbid, { status: "OUTBID", currentBidCents: 4_100 });
    expect(outbid.final_paid_all_in).toBe("");
    const pending = { sales_median: 100, final_paid_all_in: "", market_pct: "" } as Row;
    settle(pending, { status: "PENDING", currentBidCents: 0 });
    expect(pending.market_pct).toBe("");
  });
});

describe("the CSV", () => {
  test("carries only the columns worth reading, in order", () => {
    expect(CSV_COLUMNS).toEqual([
      "url", "title", "auction", "lot", "language", "grader", "grade", "cert",
      "market_price", "sales_median", "tier_rule", "max_bid_hammer", "max_bid_all_in",
      "bid_placed", "bid_status", "final_bid", "final_paid_all_in", "market_pct",
      "unawardable",
    ]);
  });

  test("leaves the working fields out and quotes what needs quoting", () => {
    const row = {
      url: "https://www.fanaticscollect.com/weekly/x", title: 'Pikachu, "the" one', auction: "WA242", lot: "WA242 Lot: 1",
      language: "English", grader: "PSA", grade: "10", cert: "123", market_price: 60, sales_median: 70, tier_rule: "65% all-in",
      max_bid_hammer: 32, max_bid_all_in: 39, bid_placed: 32, bid_status: "won", final_bid: 30, final_paid_all_in: 36, market_pct: 51.4,
      unawardable: "",
      listing_id: "x", priority: 0, current_bid: 30, bid_count: 4, headroom: 2, card_key: "secret", bid_rank: "", flags: "", reason: "internal",
    } satisfies Row;
    const [header, line] = toCsv([row]).trim().split("\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(line).toBe('https://www.fanaticscollect.com/weekly/x,"Pikachu, ""the"" one",WA242,WA242 Lot: 1,English,PSA,10,123,60,70,65% all-in,32,39,32,won,30,36,51.4,');
    expect(line).not.toContain("secret");
    expect(line).not.toContain("internal");
  });
});

describe("parallel", () => {
  test("runs at most the limit at once and keeps the items' order", async () => {
    let running = 0;
    let peak = 0;
    const out = await parallel([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  test("a failure fails the whole call", async () => {
    await expect(parallel([1, 2], 2, async (n) => { if (n === 2) throw new Error("no"); return n; })).rejects.toThrow("no");
  });

  test("nothing to do", async () => {
    expect(await parallel([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("card priority order", () => {
  const lot = (gradingService: string, grade: number, title = "") => ({ gradingService, grade, title });

  test("PSA 10 down to 7, then CGC Pristine, Gem Mint, then CGC 9.5 down to 7", () => {
    const ranks = [
      lot("PSA", 10), lot("PSA", 9.5), lot("PSA", 9), lot("PSA", 7),
      lot("CGC", 10, "Charizard CGC 10 PRISTINE"),
      lot("CGC", 10, "Charizard CGC 10 GEM MINT"),
      lot("CGC", 9.5), lot("CGC", 9), lot("CGC", 8.5), lot("CGC", 7),
    ].map(priorityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("the worst PSA still outranks the best CGC", () => {
    expect(priorityRank(lot("PSA", 7)))
      .toBeLessThan(priorityRank(lot("CGC", 10, "Charizard CGC 10 PRISTINE")));
  });

  test("a CGC Gem Mint 10 outranks a CGC 9.5", () => {
    expect(priorityRank(lot("CGC", 10, "Charizard CGC 10 GEM MINT")))
      .toBeLessThan(priorityRank(lot("CGC", 9.5)));
  });
});

describe("sales gate", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const sale = (daysAgo: number) => ({ price: 10, date: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() });

  test("needs five sales all inside the last two months", () => {
    expect(SALES_WINDOW_DAYS).toBe(60);
    expect(salesGate([1, 5, 10, 20, 59].map(sale), now)).toEqual({ ok: true, oldestDays: 59 });
  });

  test("too few sales", () => {
    const r = salesGate([1, 2, 3, 4].map(sale), now);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only 4 recent sale/);
  });

  test("one sale past the two months fails the lot", () => {
    const r = salesGate([1, 2, 3, 4, 68].map(sale), now);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/68d old/);
    expect(r.oldestDays).toBe(68);
  });

  test("a sale six weeks old failed at a month and passes at two", () => {
    expect(salesGate([1, 2, 3, 4, 45].map(sale), now).ok).toBe(true);
  });

  test("an older sixth sale behind the five is neither used nor held against the lot", () => {
    expect(salesGate([1, 2, 3, 4, 5, 200].map(sale), now)).toEqual({ ok: true, oldestDays: 5 });
  });

  test("no history at all", () => {
    expect(salesGate([], now)).toEqual({ ok: false, reason: "no sales history", oldestDays: null });
  });
});

describe("per-card caps", () => {
  test("the same card is the same key whatever the grade or the punctuation", () => {
    const a = cardKey({ cardName: "Mega Charizard X ex", setName: "Black Star Promos", cardNumber: "023", language: "English" });
    const b = cardKey({ cardName: "MEGA CHARIZARD-X  EX", setName: "Black Star Promos", cardNumber: "023", language: "English" });
    expect(a).toBe(b);
  });

  test("a Japanese print is a different card from the English one", () => {
    const en = cardKey({ cardName: "Pikachu", setName: "Celebrations", cardNumber: "005/025", language: "English" });
    const jp = cardKey({ cardName: "Pikachu", setName: "Celebrations", cardNumber: "005/025", language: "Japanese" });
    expect(en).not.toBe(jp);
  });

  test("the card number survives normalising", () => {
    expect(cardKey({ cardName: "Rowlet", setName: "Nihil Zero", cardNumber: "082/080" }))
      .toContain("082/080");
  });

  test("four lots of one card per auction by default, and nothing is read from the database", () => {
    expect(DEFAULT_MAX_COPIES_PER_CARD).toBe(4);
    expect(cardCaps()).toEqual({ perCard: 4 });
  });

  test("the run's own cap wins over the default, and only a whole number of at least 1 is one", () => {
    expect(maxCopiesFromArgs({})).toBe(DEFAULT_MAX_COPIES_PER_CARD);
    expect(maxCopiesFromArgs({ MAX_COPIES_PER_CARD: " 2 " })).toBe(2);
    expect(() => maxCopiesFromArgs({ MAX_COPIES_PER_CARD: "0" })).toThrow(/at least 1/);
    expect(() => maxCopiesFromArgs({ MAX_COPIES_PER_CARD: "2.5" })).toThrow(/whole number/);
    expect(() => maxCopiesFromArgs({ MAX_COPIES_PER_CARD: "lots" })).toThrow(/whole number/);
  });

  test("the cap the run was given is the one the book bids under", () => {
    try {
      setMaxCopiesPerCard(2);
      expect(cardCaps()).toEqual({ perCard: 2 });
    } finally {
      setMaxCopiesPerCard(DEFAULT_MAX_COPIES_PER_CARD);
    }
  });
});

describe("the chase list is the venue's choice", () => {
  const base: ScannedLot = {
    listingId: "a", url: "https://alt.xyz/itm/a", title: "2003 Pokemon Skyridge Holo Houndoom #H11 PSA 10 GEM MINT",
    grader: "PSA", grade: 10, cert: "11111111", currentBid: 40, bidCount: 2, auction: "Aug 28 - Sep 10, 2026", lot: "a", language: "English",
  };

  test("Fanatics chases the list: a plain holo from a set not on it is dropped", () => {
    const out = selectCandidates([base], () => {});
    expect(out.candidates).toEqual([]);
    expect(out.counts.offChaseList).toBe(1);
  });

  test("Alt takes every lot: the same holo is a candidate, with no keywords to its name", () => {
    const out = selectCandidates([base], () => {}, { chaseList: false });
    expect(out.candidates.map((c) => c.listingId)).toEqual(["a"]);
    expect(out.candidates[0].keywords).toEqual([]);
    expect(out.counts.offChaseList).toBe(0);
  });

  test("the block list, the cert and the Master Ball gate still apply without a chase list", () => {
    const out = selectCandidates([
      { ...base, listingId: "topps", title: "2000 Topps Chrome Pokemon Series 1 Sparkle Kadabra #64 PSA 10" },
      { ...base, listingId: "no-cert", cert: "" },
      { ...base, listingId: "master", title: "2023 Pokemon Japanese SV 151 Master Ball Reverse Holo Magnemite #81 PSA 9", grade: 9 },
      { ...base, listingId: "bgs", grader: "BGS" },
    ], () => {}, { chaseList: false });
    expect(out.candidates).toEqual([]);
    expect(out.counts.noCert).toBe(1);
    expect(out.counts.blockList).toBe(1);
    expect(out.counts.masterBallOrDuplicate).toBe(1);
    expect(out.rejected.map((r) => r.candidate.listingId).sort()).toEqual(["master", "topps"]);
  });
});


describe("asking Card Uploader again", () => {
  const priced = { card: null, info: null, altValue: 10, salesAverage: 10, sales: [] };

  test("a refusal is an answer, a failure to answer is not", () => {
    expect(isFinalAnswer("/backend/card-price/cert?…: HTTP 404 no such certificate")).toBe(true);
    expect(isFinalAnswer("/backend/card-price/cert?…: HTTP 400 bad grader")).toBe(true);
    expect(isFinalAnswer("/backend/card-price/cert?…: HTTP 429 slow down")).toBe(false);
    expect(isFinalAnswer("/backend/card-price/cert?…: HTTP 408 request timeout")).toBe(false);
    expect(isFinalAnswer("/backend/card-price/cert?…: HTTP 502 bad gateway")).toBe(false);
    expect(isFinalAnswer("page.request.get: Timeout 60000ms exceeded")).toBe(false);
  });

  test("a lookup that failed is worth repeating, one that answered is not", () => {
    expect(isRetryable({ ...priced })).toBe(false);
    // Repeating a lookup costs no credits, so any outright failure is retried.
    expect(isRetryable({ ...priced, error: "HTTP 502" })).toBe(true);
    // A cert Card Uploader does not know answers with no info and no error;
    // asking again would get the same nothing.
    expect(isRetryable({ ...priced, info: null })).toBe(false);
  });
});

describe("the run funnel", () => {
  test("lines the numbers up under each other, minus signs included", () => {
    const out = funnelText([
      { kind: "total", n: 23397, label: "scanned" },
      { kind: "cut", n: 9237, label: "off the chase list" },
      { kind: "cut", n: 1, label: "no cert number" },
      { kind: "rule" },
      { kind: "total", n: 13968, label: "priced" },
    ]).split("\n");
    expect(out).toEqual([
      "    23397  scanned",
      "    -9237  off the chase list",
      "       -1  no cert number",
      "    ─────",
      "    13968  priced",
    ]);
  });

  test("widens to the longest number in the column", () => {
    const out = funnelText([
      { kind: "total", n: 7, label: "a" },
      { kind: "cut", n: 1234567, label: "b" },
    ]).split("\n");
    expect(out[0]).toBe(`${" ".repeat(11)}7  a`);
    expect(out[1]).toBe("    -1234567  b");
  });
});

describe("block-list patterns read as words", () => {
  test("strips the regex out of a pattern", () => {
    expect(prettyPattern("\\bfigures?\\b")).toBe("figures");
    expect(prettyPattern("\\bplaying[\\s-]?cards?\\b")).toBe("playing cards");
    expect(prettyPattern("\\blot of\\b")).toBe("lot of");
  });
});

describe("the last cut before the bid list", () => {
  /** Only the fields finalCut reads; the rest of a Row is along for the ride. */
  const row = (over: Partial<Row>): Row => ({
    ...({} as Row), flags: "", card_key: "", reason: "", ...over,
  });

  test("drops a lot whose cert disagrees with the listing", () => {
    const out = finalCut([row({ card_key: "pikachu|base|58", flags: "grade: cert says 9, listing says 10" })]);
    expect(out.worthy).toEqual([]);
    expect(out.flaggedOut).toBe(1);
    expect(out.dropped[0].reason).toMatch(/^flagged, not bid: grade:/);
  });

  test("drops a lot that never identified, because the cap cannot be checked", () => {
    const out = finalCut([row({ card_key: "" })]);
    expect(out.worthy).toEqual([]);
    expect(out.flaggedOut).toBe(1);
    expect(out.dropped[0].reason).toMatch(/4-per-card cap could not be checked/);
  });

  test("every copy of a card goes on the list — the book holds the per-card cap, so the copy past it gets its turn", () => {
    const key = "pikachu|base|58";
    const copies = DEFAULT_MAX_COPIES_PER_CARD + 1;
    const out = finalCut(
      [...Array.from({ length: copies }, () => row({ card_key: key })), row({ card_key: key, flags: "language: cert says Japanese" })],
    );
    expect(out.worthy).toHaveLength(copies);
    expect(out.flaggedOut).toBe(1);
  });
});

/**
 * The fire: when the bids go on, and what a re-scan says about a lot.
 */
describe("the fire", () => {
  test("fire-after: the venue's own unless told, the environment when told, and only a number of minutes", () => {
    expect(fireAfterFromArgs(27, {})).toBe(27);
    expect(fireAfterFromArgs(27, { FIRE_AFTER_MINUTES: " 100 " })).toBe(100);
    expect(fireAfterFromArgs(27, { FIRE_AFTER_MINUTES: "0" })).toBe(0);
    expect(fireAfterFromArgs(27, { FIRE_AFTER_MINUTES: "2.5" })).toBe(2.5);
    expect(() => fireAfterFromArgs(27, { FIRE_AFTER_MINUTES: "-1" })).toThrow(/minutes/);
    expect(() => fireAfterFromArgs(27, { FIRE_AFTER_MINUTES: "late" })).toThrow(/minutes/);
  });

  test("the fire is so many minutes after extended bidding was scheduled to open", () => {
    const sevenPm = 1_757_811_600;  // 2026-09-14T02:00:00Z, Sunday 7 PM PT
    expect(fireAtUnixS(sevenPm, 27)).toBe(sevenPm + 27 * 60);
    expect(fireAtUnixS(sevenPm, 0)).toBe(sevenPm);
  });

  test("at the fire time, yes; before it, no — unless the whole auction is about to end", () => {
    const fireAt = 1_000_000;
    const before = { nowUnixS: fireAt - 600, fireAtUnixS: fireAt };
    expect(timeToFire({ ...before, closesTogether: false, auction: null })).toEqual({ fire: false });
    expect(timeToFire({ nowUnixS: fireAt, fireAtUnixS: fireAt, closesTogether: false, auction: null })).toMatchObject({ fire: true, why: "the fire time" });
    expect(timeToFire({ nowUnixS: fireAt + 5, fireAtUnixS: fireAt, closesTogether: true, auction: null })).toMatchObject({ fire: true });

    // Alt, extended bidding on, the clock reading six seconds from the end: now.
    const ending = { status: "EXTENDED_BIDDING", endsAtUnixS: before.nowUnixS + 6 };
    expect(timeToFire({ ...before, closesTogether: true, auction: ending })).toMatchObject({ fire: true, why: expect.stringContaining("6s from the end") });
    // The same clock at a house whose lots close one by one says nothing about the whole.
    expect(timeToFire({ ...before, closesTogether: false, auction: ending })).toEqual({ fire: false });
    // Not yet in extended bidding: the end it reads is the scheduled open, and nothing ends there.
    expect(timeToFire({ ...before, closesTogether: true, auction: { status: "LIVE", endsAtUnixS: before.nowUnixS + 6 } })).toEqual({ fire: false });
    // Comfortably far from the end.
    expect(timeToFire({ ...before, closesTogether: true, auction: { status: "EXTENDED_BIDDING", endsAtUnixS: before.nowUnixS + 14 } })).toEqual({ fire: false });
    // A clock the house has not given.
    expect(timeToFire({ ...before, closesTogether: true, auction: { status: "EXTENDED_BIDDING", endsAtUnixS: 0 } })).toEqual({ fire: false });
  });

  test("a re-scan's snapshot says whether the least next bid is already past the max", () => {
    const row = { maxHammerCents: 4_000 };
    // Fanatics: rungs. Standing at $39 the next rung is $40, still ours; at $40 the next is $41, not.
    expect(pricedOut(row, { currentBidCents: 3_900, bidCount: 4 }, FANATICS_STEPS)).toBeNull();
    expect(pricedOut(row, { currentBidCents: 4_000, bidCount: 5 }, FANATICS_STEPS)).toMatch(/\$41/);
    // Alt: standing bid plus the increment. $39 wants $40 next; $40 wants $41.
    expect(pricedOut(row, { currentBidCents: 3_900, bidCount: 4 }, ALT_STEPS)).toBeNull();
    expect(pricedOut(row, { currentBidCents: 4_000, bidCount: 5 }, ALT_STEPS)).not.toBeNull();
    // No bids yet: the snapshot has no starting price, so the lot is kept.
    expect(pricedOut(row, { currentBidCents: 4_500, bidCount: 0 }, FANATICS_STEPS)).toBeNull();
  });
});
