import { afterEach, describe, expect, test } from "vitest";
import {
  BID_FLOW_VERIFIED,
  BID_INCREMENTS,
  EBAY_STEPS,
  openEbay,
  parseSessionState,
  readBidAnswer,
  readGreeting,
  readOutcome,
} from "@/scripts/ebay-bidder";
import {
  authenticityGuaranteed,
  centsOf,
  clockOffsetFrom,
  gradeOf,
  graderOf,
  itemUrl,
  legacyId,
  readAspects,
  searchFilter,
  shippingCents,
  toLot,
  type Item,
} from "@/scripts/ebay-search";
import { OcrBudget, certLooksRight, jpegSize, largeImageUrl, voteOnCert } from "@/scripts/ebay-ocr";
import {
  CSV_COLUMNS,
  DEFAULT_GRADE_RANGES,
  DEFAULT_SELLERS,
  Ledger,
  armAtMs,
  cardNumberFromText,
  certMismatches,
  emptyState,
  fireAtMs,
  gradeAllowed,
  sellersOnlyFromArgs,
  parseGradeRange,
  setGuard,
  toCsv,
  yearFromText,
  type ItemRecord,
} from "@/scripts/ebay-sniper";
import {
  cutoffDate,
  findSet,
  nameVariants,
  normaliseSetName,
  parseLimitlessDate,
  parseLimitlessSets,
  setAgeVerdict,
  splitNameAndCode,
  tokensCompatible,
  type SetRelease,
} from "@/scripts/set-dates";
import { BUYERS_PREMIUM, allInCents, bidAmount, buyersPremium, hammerForAllIn, incrementAt, setBuyersPremium, withinMax } from "@/scripts/sniper-book";
import { applyRule } from "@/scripts/sniper-core";

const NOW = new Date("2026-09-17T18:00:00Z");

// ── Set release dates ─────────────────────────────────────────────────────────

const SETS: SetRelease[] = [
  { name: "Surging Sparks", code: "SSP", releaseDate: "2024-11-08", language: "English" },
  { name: "Prismatic Evolutions", code: "PRE", releaseDate: "2025-01-17", language: "English" },
  { name: "Perfect Order", code: "POR", releaseDate: "2026-03-27", language: "English" },
  { name: "Pitch Black", code: "PBL", releaseDate: "2026-07-17", language: "English" },
  { name: "30th Celebration", code: "30C", releaseDate: "2026-09-16", language: "English" },
  { name: "30th Celebration", code: "M6a", releaseDate: "2026-09-16", language: "Japanese" },
  { name: "Shiny Treasure ex", code: "SV4a", releaseDate: "2023-12-01", language: "Japanese" },
  { name: "Mega Dream ex", code: "M2a", releaseDate: "2025-11-28", language: "Japanese" },
  { name: "Nihil Zero", code: "M3", releaseDate: "2026-01-23", language: "Japanese" },
  { name: "SV Black Star Promos", code: "SVP", releaseDate: "2023-03-31", language: "English" },
  { name: "ME Black Star Promos", code: "MEP", releaseDate: "2025-09-26", language: "English" },
  { name: "Pokémon GO", code: "PGO", releaseDate: "2022-07-01", language: "English" },
  { name: "Scarlet & Violet", code: "SVI", releaseDate: "2023-03-31", language: "English" },
  { name: "Pokémon 151", code: "MEW", releaseDate: "2023-09-22", language: "English" },
  { name: "Scarlet ex", code: "SV1S", releaseDate: "2023-01-20", language: "Japanese" },
  { name: "Terastal Fest ex", code: "SV8a", releaseDate: "2024-12-06", language: "Japanese" },
  { name: "Base Set", code: "BS", releaseDate: "1999-01-09", language: "English" },
];

describe("Limitless set pages", () => {
  test("dates read as YYYY-MM-DD, two-digit or four-digit year", () => {
    expect(parseLimitlessDate("16 Sep 26")).toBe("2026-09-16");
    expect(parseLimitlessDate("8 Nov 2024")).toBe("2024-11-08");
    expect(parseLimitlessDate("9 Jan 99")).toBe("1999-01-09");
    expect(parseLimitlessDate("Release Date")).toBeNull();
    expect(parseLimitlessDate("32 Jan 26")).toBeNull();
  });

  test("the name cell splits into the name and the code, and a trailing 'ex' is not a code", () => {
    expect(splitNameAndCode("Mega Dream ex M2a")).toEqual({ name: "Mega Dream ex", code: "M2a" });
    expect(splitNameAndCode("30th Celebration 30C")).toEqual({ name: "30th Celebration", code: "30C" });
    expect(splitNameAndCode("Inferno X M2")).toEqual({ name: "Inferno X", code: "M2" });
    expect(splitNameAndCode("ex Starter Set Eevee ex MEE")).toEqual({ name: "ex Starter Set Eevee ex", code: "MEE" });
    expect(splitNameAndCode("Mewtwo Half Deck MGm")).toEqual({ name: "Mewtwo Half Deck", code: "MGm" });
    expect(splitNameAndCode("Shiny Treasure ex")).toEqual({ name: "Shiny Treasure ex", code: "" });
    expect(splitNameAndCode("Mega Rising")).toEqual({ name: "Mega Rising", code: "" });
  });

  test("a page parses to its sets: header and series rows are skipped, entities are read", () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Release Date</th><th>Cards</th></tr>
        <tr><td colspan="3">Mega</td></tr>
        <tr><td><a href="/cards/jp/M6a"><img class="set" alt="M6a" src="x.png"> 30th Celebration <span class="code annotation">M6a</span></a></td> <td><a href="/cards/jp/M6a">16 Sep 26</a></td> <td class="md-only"><a>111 <span>9.91%</span></a></td></tr>
        <tr><td><a>30th Celebration Premium Deck Set Espeon &amp; Umbreon <span>MF</span></a></td><td>16 Sep 26</td><td>49</td></tr>
        <tr><td><a>Mega Dream ex <span>M2a</span></a></td><td>28 Nov 25</td><td>250</td></tr>
      </table>`;
    expect(parseLimitlessSets(html, "Japanese")).toEqual([
      { name: "30th Celebration", code: "M6a", releaseDate: "2026-09-16", language: "Japanese" },
      { name: "30th Celebration Premium Deck Set Espeon & Umbreon", code: "MF", releaseDate: "2026-09-16", language: "Japanese" },
      { name: "Mega Dream ex", code: "M2a", releaseDate: "2025-11-28", language: "Japanese" },
    ]);
  });
});

describe("matching a set name", () => {
  test("names flatten: case, accents, '&', punctuation, parenthesised codes", () => {
    expect(normaliseSetName("Pokémon GO")).toBe("pokemon go");
    expect(normaliseSetName("Scarlet & Violet—Surging Sparks (SSP)")).toBe("scarlet and violet surging sparks");
  });

  test("a seller's series prefix or set code comes off as a variant", () => {
    expect(nameVariants("Scarlet & Violet: Surging Sparks")).toContain("surging sparks");
    expect(nameVariants("SV08 Surging Sparks")).toContain("surging sparks");
    expect(nameVariants("Sword & Shield - Evolving Skies")).toContain("evolving skies");
    expect(nameVariants("Mega Evolution: Pitch Black")).toContain("pitch black");
  });

  test("exact first, in the language asked for; then a substring; then word by word; several fits take the newest", () => {
    expect(findSet("Surging Sparks", SETS)?.set.code).toBe("SSP");
    expect(findSet("Scarlet & Violet: Surging Sparks", SETS)?.set.code).toBe("SSP");
    // The series-named base set is matched exactly and never as a prefix of a longer name.
    expect(findSet("Scarlet & Violet", SETS)?.set.code).toBe("SVI");
    expect(findSet("Scarlet & Violet: 151", SETS)?.set.code).toBe("MEW");
    expect(findSet("Scarlet & Violet — Paldea Evolved", SETS)).toBeNull();
    // Two names for one set: word by word, a word being the start of the other.
    expect(findSet("Terastal Festival ex", SETS, "Japanese")).toMatchObject({ how: "tokens", set: { code: "SV8a" } });
    expect(findSet("Base Set", SETS)?.set.releaseDate).toBe("1999-01-09");
    expect(findSet("30th Celebration", SETS, "Japanese")?.set.code).toBe("M6a");
    expect(findSet("30th Celebration", SETS, "English")?.set.code).toBe("30C");
    expect(findSet("Shiny Treasure ex", SETS)?.set.code).toBe("SV4a");
    // "Black Star Promos" is inside both promo sets' names; the newer wins, so the guardrail fails closed.
    expect(findSet("Black Star Promos", SETS)).toMatchObject({ how: "contains", set: { code: "MEP" } });
    expect(findSet("Evolving Skies", SETS)).toBeNull();
    expect(findSet("", SETS)).toBeNull();
  });

  test("the cutoff is the same day of the month, months back", () => {
    expect(cutoffDate(NOW, 6)).toBe("2026-03-17");
    expect(cutoffDate(new Date("2026-01-15T00:00:00Z"), 6)).toBe("2025-07-15");
    expect(cutoffDate(NOW, 0)).toBe("2026-09-17");
  });

  test("word matching: every telling word of the shorter name in the longer, at most one word to spare, one real word matched", () => {
    expect(tokensCompatible("terastal festival ex", "terastal fest ex")).toBe(true);
    expect(tokensCompatible("black star promos", "sv black star promos")).toBe(true);
    expect(tokensCompatible("151", "pokemon 151")).toBe(true);
    expect(tokensCompatible("mega brave", "mega dream ex")).toBe(false);
    expect(tokensCompatible("evolving skies", "evolutions")).toBe(false);
    expect(tokensCompatible("ex", "shiny treasure ex")).toBe(false);
    // One word in common is not the same set when the longer name has two more.
    expect(tokensCompatible("scarlet and violet 151", "scarlet ex")).toBe(false);
  });

  test("a set released on or after the cutoff is blocked, one before it is not, an unknown one is neither", () => {
    expect(setAgeVerdict("Pitch Black", SETS, { now: NOW, months: 6 }).blocked).toMatch(/Pitch Black.*2026-07-17.*6 months/);
    expect(setAgeVerdict("Perfect Order", SETS, { now: NOW, months: 6 }).blocked).toMatch(/2026-03-27/);
    expect(setAgeVerdict("Prismatic Evolutions", SETS, { now: NOW, months: 6 }).blocked).toBeNull();
    expect(setAgeVerdict("Nihil Zero", SETS, { now: NOW, months: 6, language: "Japanese" }).blocked).toBeNull();
    expect(setAgeVerdict("Nihil Zero", SETS, { now: NOW, months: 9, language: "Japanese" }).blocked).toMatch(/Nihil Zero/);
    // A set not out yet is newer than anything.
    expect(setAgeVerdict("30th Celebration", SETS, { now: new Date("2026-09-01T00:00:00Z"), months: 6 }).blocked).toMatch(/2026-09-16/);
    expect(setAgeVerdict("Evolving Skies", SETS, { now: NOW, months: 6 })).toEqual({ match: null, blocked: null });
  });
});

describe("the sniper's set guardrail", () => {
  const guard = (name: string, year: string, language: "English" | "Japanese" | "" = "English") =>
    setGuard({ name, year, language, sets: SETS, now: NOW, months: 6 });

  test("a known new set is refused; a known old one is not", () => {
    expect(guard("Pitch Black", "2026")).toMatch(/inside the last 6 months/);
    expect(guard("Surging Sparks", "2024")).toBeNull();
  });

  test("an unknown set fails closed when the card's year could put it inside the window", () => {
    expect(guard("Storm Emeralda", "2026", "Japanese")).toMatch(/not in the release list.*2026/);
    expect(guard("Storm Emeralda", "2025", "Japanese")).toBeNull();
    expect(guard("Mystery Set", "", "English")).toBeNull();
    expect(guard("", "2026")).toBeNull();
  });
});

// ── The Browse API ────────────────────────────────────────────────────────────

describe("eBay search", () => {
  test("the filter names live auctions, the sellers and Authenticity Guarantee", () => {
    expect(searchFilter({ sellers: ["probstein123", "psa"], zip: "19406" }))
      .toBe("buyingOptions:{AUCTION},sellers:{probstein123|psa},qualifiedPrograms:{AUTHENTICITY_GUARANTEE},deliveryCountry:US,deliveryPostalCode:19406");
    expect(searchFilter({ sellers: ["psa"], authenticityGuarantee: false })).toBe("buyingOptions:{AUCTION},sellers:{psa}");
    expect(searchFilter({ sellers: [], zip: "19406" }))
      .toBe("buyingOptions:{AUCTION},qualifiedPrograms:{AUTHENTICITY_GUARANTEE},deliveryCountry:US,deliveryPostalCode:19406");
    // eBay answers HTTP 400 on the Authenticity Guarantee filter with no
    // delivery postcode, so the run is stopped before the call is made.
    expect(() => searchFilter({ sellers: ["psa"] })).toThrow(/needs a delivery postcode/);
  });

  test("the item id carries the listing number", () => {
    expect(legacyId("v1|123456789012|0")).toBe("123456789012");
    expect(legacyId("123456789012")).toBe("123456789012");
    expect(itemUrl("v1|123456789012|0")).toBe("https://www.ebay.com/itm/123456789012");
  });

  test("money and clocks", () => {
    expect(centsOf({ value: "12.50", currency: "USD" })).toBe(1_250);
    expect(centsOf(undefined)).toBe(0);
    expect(clockOffsetFrom("Thu, 17 Sep 2026 18:00:10 GMT", Date.parse("2026-09-17T18:00:07Z"))).toBe(3_000);
    expect(clockOffsetFrom(null, 0)).toBeNull();
  });

  test("graders and grades read off eBay's item specifics", () => {
    expect(graderOf("Professional Sports Authenticator (PSA)")).toBe("PSA");
    expect(graderOf("Certified Guaranty Company (CGC)")).toBe("CGC");
    expect(graderOf("Beckett Grading Services (BGS)")).toBe("BGS");
    expect(gradeOf("10")).toBe(10);
    expect(gradeOf("Gem Mint 10")).toBe(10);
    expect(gradeOf("9.5")).toBe(9.5);
    expect(gradeOf("Mint")).toBeUndefined();
  });

  const item: Item = {
    itemId: "v1|123456789012|0",
    title: "Pokemon Charizard ex 199/165 SIR 151 PSA 10 GEM MINT",
    itemWebUrl: "https://www.ebay.com/itm/123456789012",
    itemEndDate: "2026-09-20T01:02:03.000Z",
    currentBidPrice: { value: "410.00", currency: "USD" },
    bidCount: 12,
    seller: { username: "probstein123" },
    qualifiedPrograms: ["AUTHENTICITY_GUARANTEE"],
    localizedAspects: [
      { name: "Professional Grader", value: "Professional Sports Authenticator (PSA)" },
      { name: "Grade", value: "10" },
      { name: "Certification Number", value: "8765 4321" },
      { name: "Set", value: "Scarlet & Violet: 151" },
      { name: "Card Name", value: "Charizard ex" },
      { name: "Card Number", value: "199/165" },
      { name: "Language", value: "English" },
      { name: "Game", value: "Pokémon TCG" },
      { name: "Year Manufactured", value: "2023" },
    ],
  };

  test("the item specifics become a lot the pipeline reads", () => {
    const aspects = readAspects(item);
    expect(aspects).toMatchObject({ grader: "PSA", grade: 10, cert: "87654321", set: "Scarlet & Violet: 151", language: "English", year: "2023" });
    expect(authenticityGuaranteed(item)).toBe(true);
    expect(toLot(item, aspects)).toEqual({
      listingId: "v1|123456789012|0",
      url: "https://www.ebay.com/itm/123456789012",
      title: item.title,
      grader: "PSA",
      grade: 10,
      pristine: false,
      cert: "87654321",
      currentBid: 410,
      bidCount: 12,
      auction: "probstein123",
      lot: "123456789012",
      language: "English",
      closesAtUnixS: Math.floor(Date.parse("2026-09-20T01:02:03.000Z") / 1000),
    });
  });

  test("with no specifics the grader and grade come off the title, and the cert is blank", () => {
    const bare = readAspects({ title: "2024 Pokemon Japanese Terastal Festival Umbreon ex SAR CGC 9.5", localizedAspects: [] });
    expect(bare).toMatchObject({ grader: "CGC", grade: 9.5, cert: "", language: "Japanese", game: "Pokémon TCG" });
    expect(authenticityGuaranteed({ qualifiedPrograms: [] })).toBe(false);
  });
});

// ── The bidder ────────────────────────────────────────────────────────────────

describe("eBay's bid increments", () => {
  test("$0.05 under a dollar, $0.25 to $5, $0.50 to $25, $1 to $100, $2.50 to $250, $5 to $500, $10 to $1,000, $25 to $2,500, $50 to $5,000, then $100", () => {
    expect(incrementAt(BID_INCREMENTS, 99)).toBe(5);
    expect(incrementAt(BID_INCREMENTS, 100)).toBe(25);
    expect(incrementAt(BID_INCREMENTS, 499)).toBe(25);
    expect(incrementAt(BID_INCREMENTS, 500)).toBe(50);
    expect(incrementAt(BID_INCREMENTS, 2_499)).toBe(50);
    expect(incrementAt(BID_INCREMENTS, 2_500)).toBe(100);
    expect(incrementAt(BID_INCREMENTS, 9_999)).toBe(100);
    expect(incrementAt(BID_INCREMENTS, 10_000)).toBe(250);
    expect(incrementAt(BID_INCREMENTS, 25_000)).toBe(500);
    expect(incrementAt(BID_INCREMENTS, 50_000)).toBe(1_000);
    expect(incrementAt(BID_INCREMENTS, 100_000)).toBe(2_500);
    expect(incrementAt(BID_INCREMENTS, 250_000)).toBe(5_000);
    expect(incrementAt(BID_INCREMENTS, 500_000)).toBe(10_000);
    expect(incrementAt(BID_INCREMENTS, 99_999_999)).toBe(10_000);
  });

  test("the next bid is the standing bid plus its increment, unless eBay quoted one itself", () => {
    expect(EBAY_STEPS.minimum({ currentBidCents: 41_000, startingPriceCents: 0, bidCount: 12 })).toBe(41_500);
    expect(bidAmount({ maxHammerCents: 41_249 }, { currentBidCents: 41_000, startingPriceCents: 0, bidCount: 12 }, EBAY_STEPS))
      .toEqual({ skip: "the next bid is $415, the max hammer is $412.49" });
    expect(bidAmount({ maxHammerCents: 42_000 }, { currentBidCents: 41_000, startingPriceCents: 0, bidCount: 12, minimumNextBidCents: 41_500 }, EBAY_STEPS))
      .toEqual({ cents: 42_000 });
    // eBay's own figure wins over the table.
    expect(bidAmount({ maxHammerCents: 42_000 }, { currentBidCents: 41_000, startingPriceCents: 0, bidCount: 12, minimumNextBidCents: 42_100 }, EBAY_STEPS))
      .toEqual({ skip: "the next bid is $421, the max hammer is $420" });
  });

  test("the max is sent to the whole dollar", () => {
    expect(EBAY_STEPS.below(41_299)).toBe(41_200);
  });
});

describe("what eBay's pages say", () => {
  test("the bid layer's answer", () => {
    expect(readBidAnswer("You're the highest bidder! Your max bid: $412.00")).toBe("highest");
    expect(readBidAnswer("You've been outbid. Increase your max bid")).toBe("outbid");
    expect(readBidAnswer("Please enter a bid of at least $415.00")).toBe("refused");
    expect(readBidAnswer("Bidding has ended on this item")).toBe("ended");
    expect(readBidAnswer("Place bid")).toBe("unknown");
  });

  test("how a listing closed for this account", () => {
    expect(readOutcome("You won this item for US $412.00. Pay now")).toMatchObject({ verdict: "won", finalCents: 41_200 });
    expect(readOutcome("You didn't win. Sold for US $1,205.00")).toMatchObject({ verdict: "lost", finalCents: 120_500 });
    expect(readOutcome("Bidding has ended on this item. Sold for US $99.00")).toMatchObject({ verdict: "ended", finalCents: 9_900 });
    expect(readOutcome("US $410.00 12 bids Time left: 2h 4m Place bid")).toMatchObject({ verdict: "live" });
  });

  test("the greeting", () => {
    expect(readGreeting("Hi Kanishk! Daily Deals Sell")).toBe("Kanishk");
    expect(readGreeting("Sign in or register")).toBe("");
  });

  test("the bid flow has been walked on a real listing", () => {
    // Rehearsed 2026-09-20 on listing 800672965889: the max was typed, the
    // Bid button came alive and was not clicked. Set this back to false if
    // eBay's layer changes, and rehearse again before setting it true. There
    // is no openEbay() here on purpose — with the gate open it would launch a
    // browser rather than refuse, and that is not a unit test's business.
    expect(BID_FLOW_VERIFIED).toBe(true);
  });
});

// ── The daemon's own rules ────────────────────────────────────────────────────

describe("grades and sellers", () => {
  test("PSA 1–10 and CGC 7–10 by default; ranges read either way round the dash", () => {
    expect(DEFAULT_GRADE_RANGES).toEqual({ PSA: { min: 1, max: 10 }, CGC: { min: 7, max: 10 } });
    expect(parseGradeRange("1-10")).toEqual({ min: 1, max: 10 });
    expect(parseGradeRange("7 – 10")).toEqual({ min: 7, max: 10 });
    expect(parseGradeRange("9.5 to 10")).toEqual({ min: 9.5, max: 10 });
    expect(parseGradeRange("10")).toEqual({ min: 10, max: 10 });
    expect(() => parseGradeRange("10-7")).toThrow(/low to high/);
    expect(() => parseGradeRange("psa")).toThrow(/grade range/);
  });

  test("a grade is allowed inside its grader's range and nowhere else", () => {
    expect(gradeAllowed("PSA", 1, DEFAULT_GRADE_RANGES)).toBe(true);
    expect(gradeAllowed("CGC", 6.5, DEFAULT_GRADE_RANGES)).toBe(false);
    expect(gradeAllowed("CGC", 7, DEFAULT_GRADE_RANGES)).toBe(true);
    expect(gradeAllowed("BGS", 10, DEFAULT_GRADE_RANGES)).toBe(false);
    expect(gradeAllowed("PSA", undefined, DEFAULT_GRADE_RANGES)).toBe(false);
  });

  test("the sellers asked for on 2026-09-17", () => {
    expect(DEFAULT_SELLERS).toEqual(["zandgemporium", "ryans_cardhouse", "probstein123", "psa"]);
  });

  test("both pools by default: the wider guarantee, and the named sellers", () => {
    expect(sellersOnlyFromArgs({})).toBe(false);
    expect(sellersOnlyFromArgs({ SELLERS_ONLY: "true" })).toBe(true);
    expect(sellersOnlyFromArgs({ SELLERS_ONLY: "1" })).toBe(true);
    expect(sellersOnlyFromArgs({ SELLERS_ONLY: "no" })).toBe(false);
  });

  test("the arm and the fire count back from the end", () => {
    const end = Date.parse("2026-09-20T01:02:03Z");
    expect(fireAtMs(end, 5)).toBe(end - 5_000);
    expect(armAtMs(end, 60)).toBe(end - 60_000);
  });
});

describe("the ledger", () => {
  const item = (over: Partial<ItemRecord>): ItemRecord => ({
    itemId: over.itemId ?? "v1|1|0", legacyId: "1", url: "u", title: "t", seller: "s", endsAtMs: 0, firstSeenAt: "", status: "scheduled", ...over,
  });
  const ledgerOf = (items: ItemRecord[], budget = 100_000, perCard = 2, maxWins = 0) => {
    const state = emptyState();
    for (const i of items) state.items[i.itemId] = i;
    return new Ledger(state, budget, perCard, maxWins);
  };

  test("the win limit ends the run, and what is in flight counts against it", () => {
    const won = (id: string) => item({ itemId: id, status: "won", paidAllInCents: 1_000 });
    const inFlight = (id: string) => item({ itemId: id, status: "bid", maxAllInCents: 1_000 });

    // No limit: the budget is the only thing that stops the run.
    expect(ledgerOf([won("a"), won("b"), won("c")]).stopReason()).toBeNull();
    expect(ledgerOf([won("a")]).roomToWin()).toBe(true);

    // Two of three won, one bid standing: no room for a fourth lot, but the
    // run is not over — that bid could still be lost.
    const two = ledgerOf([won("a"), won("b"), inFlight("c")], 100_000, 2, 3);
    expect(two.roomToWin()).toBe(false);
    expect(two.stopReason()).toBeNull();

    // The third win ends it.
    const three = ledgerOf([won("a"), won("b"), won("c")], 100_000, 2, 3);
    expect(three.roomToWin()).toBe(false);
    expect(three.stopReason()).toMatch(/win limit is reached: 3 lot\(s\) won of 3/);

    // A lot whose outcome never came is counted as won, here as everywhere.
    const unknown = ledgerOf([won("a"), item({ itemId: "b", status: "unknown", paidAllInCents: 1_000 })], 100_000, 2, 2);
    expect(unknown.stopReason()).toMatch(/win limit is reached: 2 lot\(s\) won of 2/);
  });

  test("won is spent, armed and bid are held at their max, the rest is free", () => {
    const ledger = ledgerOf([
      item({ itemId: "a", status: "won", paidAllInCents: 30_000, maxAllInCents: 40_000 }),
      item({ itemId: "b", status: "bid", maxAllInCents: 20_000 }),
      item({ itemId: "c", status: "armed", maxAllInCents: 10_000 }),
      item({ itemId: "d", status: "scheduled", maxAllInCents: 50_000 }),
      item({ itemId: "e", status: "lost", maxAllInCents: 50_000 }),
    ]);
    expect(ledger.spent()).toBe(30_000);
    expect(ledger.held()).toBe(30_000);
    expect(ledger.free()).toBe(40_000);
    expect(ledger.fits(40_000)).toBe(true);
    expect(ledger.fits(40_001)).toBe(false);
    expect(ledger.stopReason()).toBeNull();
  });

  test("an outcome that never came is counted as won, at its max when nothing else is known", () => {
    const ledger = ledgerOf([item({ itemId: "a", status: "unknown", maxAllInCents: 12_000 })]);
    expect(ledger.spent()).toBe(12_000);
  });

  test("the run stops when the wins reach the budget, or when what is left is under any bid and nothing is in flight", () => {
    expect(ledgerOf([item({ itemId: "a", status: "won", paidAllInCents: 100_000 })]).stopReason()).toMatch(/budget is spent/);
    expect(ledgerOf([item({ itemId: "a", status: "won", paidAllInCents: 99_700 })]).stopReason()).toMatch(/bought up to the budget/);
    expect(ledgerOf([
      item({ itemId: "a", status: "won", paidAllInCents: 99_700 }),
      item({ itemId: "b", status: "bid", maxAllInCents: 200 }),
    ]).stopReason()).toBeNull();
  });

  test("the per-card cap counts copies in flight and won", () => {
    const ledger = ledgerOf([
      item({ itemId: "a", status: "won", cardKey: "pikachu|151|025", paidAllInCents: 100 }),
      item({ itemId: "b", status: "armed", cardKey: "pikachu|151|025", maxAllInCents: 100 }),
      item({ itemId: "c", status: "lost", cardKey: "pikachu|151|025" }),
    ]);
    expect(ledger.copies("pikachu|151|025")).toBe(2);
    expect(ledger.capped("pikachu|151|025")).toBe(true);
    expect(ledger.capped("other")).toBe(false);
    expect(ledger.capped(undefined)).toBe(false);
  });
});

describe("the CSV", () => {
  test("in-flight lots first, then the outcomes, then everything else, soonest end first inside each", () => {
    const rows: ItemRecord[] = [
      { itemId: "1", legacyId: "1", url: "u1", title: "rejected", seller: "s", endsAtMs: 1, firstSeenAt: "", status: "rejected", reason: "no cert" },
      { itemId: "2", legacyId: "2", url: "u2", title: "won, \"quoted\"", seller: "s", endsAtMs: 2, firstSeenAt: "", status: "won", bidCents: 5_000, finalCents: 4_100, paidAllInCents: 4_100, salesMedian: 100 },
      { itemId: "3", legacyId: "3", url: "u3", title: "bid", seller: "s", endsAtMs: 9, firstSeenAt: "", status: "bid", bidCents: 1_000 },
      { itemId: "4", legacyId: "4", url: "u4", title: "armed", seller: "s", endsAtMs: 3, firstSeenAt: "", status: "armed" },
    ];
    const lines = toCsv(rows).trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["u4", "u3", "u2", "u1"]);
    expect(lines[3]).toContain("\"won, \"\"quoted\"\"\"");
    expect(lines[3]).toContain(",41,41,41,");
  });
});

describe("reading the cert off the slab", () => {
  const pass = (text: string, weight = 1) => ({ text, weight });

  test("the passes vote, and the label band counts double", () => {
    // Three readings of the label agree; one stray number from the card body
    // does not outweigh them.
    expect(voteOnCert([pass("148000057"), pass("148000057", 2), pass("2006 64")], "PSA"))
      .toEqual({ cert: "148000057", votes: 3, runnerUp: 0 });
    // A number found only on the card loses to one found on the label.
    expect(voteOnCert([pass("19952000"), pass("19952000"), pass("6152364009", 2)], "CGC").cert)
      .toBe("6152364009");
  });

  test("only runs the right length for the grader are counted", () => {
    // The card number and the year are the wrong length for a PSA cert.
    expect(voteOnCert([pass("2006"), pass("64"), pass("111")], "PSA").cert).toBe("");
    // A ten-digit run is not a nine-digit PSA cert with a stray digit beside
    // it — taking the first nine would price a different card.
    expect(voteOnCert([pass("0142524880")], "PSA").cert).toBe("");
    // The same run is a perfectly good CGC cert.
    expect(voteOnCert([pass("0142524880")], "CGC").cert).toBe("0142524880");
    expect(certLooksRight("PSA", "148000057")).toBe(true);
    expect(certLooksRight("CGC", "6152364009")).toBe(true);
    expect(certLooksRight("PSA", "61523640091")).toBe(false);
    expect(certLooksRight("PSA", "14800005X")).toBe(false);
  });

  test("one reading per pass, however many times it appears in it", () => {
    // A barcode read twice in one pass is still one pass's opinion.
    expect(voteOnCert([pass("86718557 86718557 86718557")], "PSA"))
      .toEqual({ cert: "86718557", votes: 1, runnerUp: 0 });
  });

  test("a tie is no answer — the caller refuses rather than guesses", () => {
    const tied = voteOnCert([pass("148000057"), pass("148000058")], "PSA");
    expect(tied.votes).toBe(tied.runnerUp);
  });

  test("a JPEG's size is read off its own header, for the crop", () => {
    // SOI, a JFIF APP0, then SOF0 carrying 1600 high by 955 wide.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x03, 0xbb, 0x03, 0x01, 0x11, 0x00,
    ]);
    expect(jpegSize(jpeg)).toEqual({ width: 955, height: 1600 });
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  test("eBay's small image is swapped for the one the label reads on", () => {
    expect(largeImageUrl("https://i.ebayimg.com/images/g/abc/s-l500.jpg"))
      .toBe("https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
    expect(largeImageUrl("https://i.ebayimg.com/images/g/abc/s-l1600.jpg"))
      .toBe("https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  });

  test("the day's allowance is spent once and rolls over at midnight", () => {
    const budget = new OcrBudget(2);
    const monday = new Date("2026-09-20T23:59:00Z");
    expect(budget.left(monday)).toBe(2);
    budget.spend(monday);
    budget.spend(monday);
    expect(budget.left(monday)).toBe(0);
    expect(budget.left(new Date("2026-09-21T00:01:00Z"))).toBe(2);
    expect(new OcrBudget(0).left()).toBeGreaterThan(1_000_000);
  });
});

describe("a session carried to another machine", () => {
  const cookies = [{ name: "s", value: "abc", domain: ".ebay.com", path: "/" }];

  test("what --export-session prints comes back as cookies", () => {
    const line = Buffer.from(JSON.stringify(cookies)).toString("base64");
    expect(parseSessionState(line)).toEqual(cookies);
    // Pasted with the whitespace a form box adds.
    expect(parseSessionState(`  ${line}\n`)).toEqual(cookies);
    // Raw JSON is taken too, for a session moved by hand.
    expect(parseSessionState(JSON.stringify(cookies))).toEqual(cookies);
  });

  test("anything else is refused rather than half-used", () => {
    expect(() => parseSessionState("")).toThrow(/empty/);
    expect(() => parseSessionState("   ")).toThrow(/empty/);
    expect(() => parseSessionState("not a session")).toThrow(/not what --export-session prints/);
    // Valid base64 of something that is not a cookie list.
    expect(() => parseSessionState(Buffer.from('{"a":1}').toString("base64"))).toThrow(/carries no cookies/);
    expect(() => parseSessionState(Buffer.from("[]").toString("base64"))).toThrow(/carries no cookies/);
  });
});

describe("the cert against the listing", () => {
  const skitty = { gradingCompany: "PSA", condition: "PSA 9", description: "2006 Pokemon EX Legend Maker #64 Skitty" };

  test("a cert that answers to the listing passes", () => {
    expect(certMismatches(
      { title: "2006 POKEMON EX LEGEND MAKER #64 SKITTY PSA 9", grader: "PSA", grade: 9 },
      { grader: "PSA", grade: 9 },
      skitty,
    )).toEqual([]);
    // Nothing is held against a title that states less.
    expect(certMismatches({ title: "Skitty slab", grader: "", grade: undefined }, { grader: "", grade: null }, skitty)).toEqual([]);
  });

  test("a misread digit shows up as the cert being another card", () => {
    // The label was read as a 10; the cert is a 9.
    expect(certMismatches(
      { title: "2006 POKEMON EX LEGEND MAKER #64 SKITTY PSA 10", grader: "PSA", grade: 10 },
      { grader: "PSA", grade: 10 },
      skitty,
    )).toEqual([
      "the label reads 10 and the cert is graded 9 — the number was misread",
      "the listing says 10 and the cert is graded 9",
    ]);
    // A cert belonging to a different grader entirely.
    expect(certMismatches(
      { title: "Togetic CGC 9", grader: "CGC", grade: 9 },
      { grader: "CGC", grade: 9 },
      skitty,
    )).toContain("the listing says CGC and the cert is PSA");
  });

  test("the year and the card number are checked when both sides state them", () => {
    expect(certMismatches(
      { title: "2016 POKEMON EX LEGEND MAKER #64 SKITTY PSA 9", grader: "PSA", grade: 9 },
      { grader: "PSA", grade: 9 },
      skitty,
    )).toEqual(["the listing says 2016 and the cert is a 2006 card"]);
    expect(certMismatches(
      { title: "2006 POKEMON EX LEGEND MAKER #46 SKITTY PSA 9", grader: "PSA", grade: 9 },
      { grader: "PSA", grade: 9 },
      skitty,
    )).toEqual(["the listing says card #46 and the cert is #64"]);
  });

  test("years and card numbers are read the way titles write them", () => {
    expect(yearFromText("2000 Pokémon Togetic Holo Neo Genesis - 1st Ed. #16/111 CGC 9")).toBe(2000);
    expect(yearFromText("Pokemon Mew ex EX Legend Maker Holo 88 BGS 9.5")).toBeUndefined();
    // A card number is not a year.
    expect(yearFromText("Charizard 1234/9999")).toBeUndefined();
    expect(cardNumberFromText("2006 POKEMON EX LEGEND MAKER #64 SKITTY PSA 9")).toBe("64");
    expect(cardNumberFromText("Togetic Neo Genesis - 1st Ed. - 16/111")).toBe("16");
    expect(cardNumberFromText("2025 POKEMON JAPANESE ART RARE #066 LITLEO PSA 10")).toBe("66");
    expect(cardNumberFromText("Pokemon Skitty PSA 9")).toBeUndefined();
  });
});

describe("postage in the all-in", () => {
  afterEach(() => setBuyersPremium(BUYERS_PREMIUM));

  test("the cheapest priced option is what the lot costs to post", () => {
    expect(shippingCents({ shippingOptions: [
      { shippingCostType: "FIXED", shippingCost: { value: "5.99", currency: "USD" } },
      { shippingCostType: "FIXED", shippingCost: { value: "24.99", currency: "USD" } },
    ] })).toBe(599);
    expect(shippingCents({ shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }] })).toBe(0);
  });

  test("an unpriced or missing option is not read as free postage", () => {
    // A calculated rate with no postcode to work it out from.
    expect(shippingCents({ shippingOptions: [{ shippingCostType: "CALCULATED" }] })).toBeNull();
    expect(shippingCents({ shippingOptions: [] })).toBeNull();
    expect(shippingCents({})).toBeNull();
    // One quoted option among unquoted ones still counts.
    expect(shippingCents({ shippingOptions: [
      { shippingCostType: "CALCULATED" },
      { shippingCostType: "FIXED", shippingCost: { value: "4.50", currency: "USD" } },
    ] })).toBe(450);
  });

  test("postage comes off the hammer so the all-in lands on the ceiling", () => {
    setBuyersPremium(0);
    // A $200 all-in max on a lot that charges $6 to post: bid at most $194.
    expect(hammerForAllIn(20_000, 600)).toBe(19_400);
    expect(allInCents(19_400, 600)).toBe(20_000);
    // Where the house charges a premium the sum still lands on the ceiling.
    setBuyersPremium(0.2);
    const hammer = hammerForAllIn(20_000, 600);
    expect(hammer).toBe(16_166);
    // The floor property, before any rounding to the cent: this hammer fits
    // under the ceiling and the next one up does not.
    expect(hammer * 1.2 + 600).toBeLessThanOrEqual(20_000);
    expect((hammer + 1) * 1.2 + 600).toBeGreaterThan(20_000);
  });

  test("a bid whose postage would carry it over the max is refused", () => {
    setBuyersPremium(0);
    const row = { title: "a slab", maxHammerCents: 19_400, maxAllInCents: 20_000, shippingCents: 600 };
    expect(withinMax(19_400, row)).toBe(19_400);
    // The same amount on a lot that posts for $20 is over the ceiling, even
    // though the hammer itself is not.
    expect(() => withinMax(19_400, { ...row, shippingCents: 2_000 })).toThrow(/all-in \(\$20 of it postage\) is over the max/);
  });
});

describe("no buyer's premium at eBay", () => {
  afterEach(() => setBuyersPremium(BUYERS_PREMIUM));

  test("the default premium is the auction houses' 20%, and a venue can set its own", () => {
    expect(buyersPremium()).toBe(0.2);
    expect(allInCents(4_000)).toBe(4_800);
    setBuyersPremium(0);
    expect(allInCents(4_000)).toBe(4_000);
    // A share of market is then a share of the hammer.
    expect(applyRule({ kind: "share", share: 0.5 }, 100)).toEqual({ rule: "50% all-in", share: 0.5, allIn: 50, hammer: 50 });
    expect(() => setBuyersPremium(1.5)).toThrow(/between 0 and 1/);
  });
});
