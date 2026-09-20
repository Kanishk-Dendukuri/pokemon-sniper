import { describe, expect, test } from "vitest";
import { ALT_STEPS, BID_INCREMENTS, BID_INPUT_VERIFIED, centsOf, cycleStatus, listingUrl, lotLabel, placeMaxBidsInput } from "@/scripts/alt-bidder";
import { alt, auctionFromArgs, gradeKeys, pickCycles, toLot } from "@/scripts/alt-sniper";
import { fanatics } from "@/scripts/fanatics-sniper";
import { bidAmount, blameOf, incrementAt, nextAffordable } from "@/scripts/sniper-book";
import { priorityRank, selectCandidates, type ScannedLot } from "@/scripts/sniper-core";

const LISTING = "ac1fdf3d-c085-4e84-85cc-0e6f485b73b2";

describe("Alt's bid increments", () => {
  test("$1 to $500 — as the site quoted, not the help centre's $10 — then $25, $50, $100, $250, $500, $1,000, $2,500…", () => {
    expect(incrementAt(BID_INCREMENTS, 0)).toBe(100);
    expect(incrementAt(BID_INCREMENTS, 1_000)).toBe(100);
    expect(incrementAt(BID_INCREMENTS, 49_900)).toBe(100);
    expect(incrementAt(BID_INCREMENTS, 50_000)).toBe(2_500);
    expect(incrementAt(BID_INCREMENTS, 100_000)).toBe(5_000);
    expect(incrementAt(BID_INCREMENTS, 250_000)).toBe(10_000);
    expect(incrementAt(BID_INCREMENTS, 500_000)).toBe(25_000);
    expect(incrementAt(BID_INCREMENTS, 1_000_000)).toBe(50_000);
    expect(incrementAt(BID_INCREMENTS, 2_000_000)).toBe(100_000);
    expect(incrementAt(BID_INCREMENTS, 3_000_000)).toBe(250_000);
    expect(incrementAt(BID_INCREMENTS, 999_999_999_999)).toBe(10_000_000);
  });

  test("the next bid is the standing bid plus its increment — what the site quoted on real lots", () => {
    // $245,000 with bids on it → $265,000 next; $1,640,000 → $1,740,000.
    expect(ALT_STEPS.minimum({ currentBidCents: 24_500_000, startingPriceCents: 0, bidCount: 12 })).toBe(26_500_000);
    expect(ALT_STEPS.minimum({ currentBidCents: 164_000_000, startingPriceCents: 0, bidCount: 14 })).toBe(174_000_000);
    // With no bids yet the opening price is the least it takes.
    expect(ALT_STEPS.minimum({ currentBidCents: 1_000, startingPriceCents: 1_000, bidCount: 0 })).toBe(1_000);
  });

  test("the max itself is what is sent, to the whole dollar, never rounded up", () => {
    expect(ALT_STEPS.below(4_600)).toBe(4_600);
    expect(ALT_STEPS.below(4_650)).toBe(4_600);
    expect(ALT_STEPS.below(0)).toBe(0);
  });

  test("a $5 max — the flat tier — is passed over when the lot opens at $10", () => {
    const out = bidAmount({ maxHammerCents: 500 }, { currentBidCents: 1_000, startingPriceCents: 1_000, bidCount: 0 }, ALT_STEPS);
    expect(out).toEqual({ skip: "the next bid is $10, the max hammer is $5" });
  });

  test("a lot at $40 with bids wants $41 next, so a $40 max is passed over and a $46 one is bid", () => {
    const at40 = { currentBidCents: 4_000, startingPriceCents: 0, bidCount: 3 };
    expect(bidAmount({ maxHammerCents: 4_000 }, at40, ALT_STEPS)).toEqual({ skip: "the next bid is $41, the max hammer is $40" });
    expect(bidAmount({ maxHammerCents: 4_600 }, at40, ALT_STEPS)).toEqual({ cents: 4_600 });
  });

  test("the site's own next-bid figure wins over the table", () => {
    const quote = { currentBidCents: 3_000, startingPriceCents: 0, bidCount: 3, minimumNextBidCents: 4_500 };
    expect(bidAmount({ maxHammerCents: 4_400 }, quote, ALT_STEPS)).toEqual({ skip: "the next bid is $45, the max hammer is $44" });
    expect(bidAmount({ maxHammerCents: 4_600 }, quote, ALT_STEPS)).toEqual({ cents: 4_600 });
  });

  test("the budget is measured at the amount that would be sent", () => {
    const rows = [
      { listingId: "a", title: "a", lot: "a", maxHammerCents: 4_600, maxAllInCents: 5_520, currentBidCents: 3_000, bidCount: 1 },
      { listingId: "b", title: "b", lot: "b", maxHammerCents: 1_000, maxAllInCents: 1_200, currentBidCents: 0, bidCount: 0 },
    ];
    // $46 is $55.20 all-in; $50 free reaches only the $10 lot.
    expect(nextAffordable(rows, new Set(), 5_000, ALT_STEPS)?.listingId).toBe("b");
    expect(nextAffordable(rows, new Set(), 5_520, ALT_STEPS)?.listingId).toBe("a");
  });
});

describe("Alt's money and names", () => {
  test("decimal dollars as the API writes them, to cents", () => {
    expect(centsOf("1640000.000000")).toBe(164_000_000);
    expect(centsOf("74.5")).toBe(7_450);
    expect(centsOf(1740000)).toBe(174_000_000);
    expect(centsOf(null)).toBe(0);
    expect(centsOf("nonsense")).toBe(0);
  });

  test("a lot's page and its label", () => {
    expect(listingUrl(LISTING)).toBe(`https://alt.xyz/itm/${LISTING}`);
    expect(lotLabel(LISTING)).toBe("Alt ac1fdf3d");
  });
});

describe("Alt's auction clock", () => {
  const cycle = (expiresAt: string, state = "LIVE") => ({ state, expiresAt });
  const t = Math.floor(Date.parse("2026-09-11T01:00:00+00:00") / 1000);

  test("live until the scheduled close", () => {
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00"), false, t - 3_600)).toBe("LIVE");
  });

  test("extended bidding once the site says so, or once the close has passed", () => {
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00"), true, t - 60)).toBe("EXTENDED_BIDDING");
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00"), false, t + 60)).toBe("EXTENDED_BIDDING");
  });

  test("closed when ended outright, or when the close stopped moving half an hour ago", () => {
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00", "ENDED"), false, t - 3_600)).toBe("CLOSED");
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00"), true, t + 31 * 60)).toBe("CLOSED");
    expect(cycleStatus(cycle("2026-09-11T01:00:00+00:00"), false, t + 31 * 60)).toBe("CLOSED");
  });
});

describe("the Alt scan", () => {
  const cycles = [
    { id: 3512, name: "Aug 28 - Sep 10, 2026", state: "ENDING_TOMORROW", expiresAt: "2026-09-11T01:00:00+00:00" },
    { id: 3513, name: "Sep 04 - Sep 17, 2026", state: "LIVE", expiresAt: "2026-09-18T01:00:00+00:00" },
    { id: 3677, name: "Sep 11 - Sep 24, 2026", state: "LIVE", expiresAt: "2026-09-25T01:00:00+00:00" },
    { id: 3511, name: "Aug 21 - Sep 04, 2026", state: "ENDED", expiresAt: "2026-09-05T01:00:00+00:00" },
  ];

  test("picks the cycle closing first and skips the two behind it", () => {
    const now = Math.floor(Date.parse("2026-09-07T21:00:00Z") / 1000);
    const { chosen, skipped } = pickCycles(cycles, now);
    expect(chosen.map((c) => c.id)).toEqual([3512]);
    expect(skipped.map((c) => c.id)).toEqual([3513, 3677]);
  });

  test("with nothing inside the week, takes the soonest rather than nothing", () => {
    const now = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
    expect(pickCycles(cycles, now).chosen.map((c) => c.id)).toEqual([3512]);
  });

  test("leaves next week's cycle alone on the night this one is in extended bidding", () => {
    // 9:39 PM ET on the Thursday 3513 closes: it has extended a few minutes
    // past its 9 PM close, and 3677 is a week out but well inside seven days.
    const now = Math.floor(Date.parse("2026-09-18T01:39:00Z") / 1000);
    const extending = cycles.map((c) => (c.id === 3513 ? { ...c, expiresAt: "2026-09-18T01:41:00+00:00" } : c));
    const { chosen, skipped } = pickCycles(extending, now);
    expect(chosen.map((c) => c.id)).toEqual([3513]);
    expect(skipped.map((c) => c.id)).toEqual([3677]);
  });

  test("takes cycles that close within hours of each other together", () => {
    const now = Math.floor(Date.parse("2026-09-07T21:00:00Z") / 1000);
    const alongside = [...cycles, { id: 3999, name: "Twin", state: "LIVE", expiresAt: "2026-09-11T04:00:00+00:00" }];
    expect(pickCycles(alongside, now).chosen.map((c) => c.id)).toEqual([3512, 3999]);
  });

  test("--auction picks by name, whatever closes first", () => {
    const now = Math.floor(Date.parse("2026-09-07T21:00:00Z") / 1000);
    const { chosen, skipped } = pickCycles(cycles, now, "sep 11");
    expect(chosen.map((c) => c.id)).toEqual([3677]);
    expect(skipped.map((c) => c.id)).toEqual([3512, 3513]);
  });

  test("--auction picks by id, and takes several", () => {
    const now = Math.floor(Date.parse("2026-09-07T21:00:00Z") / 1000);
    expect(pickCycles(cycles, now, "3513, 3677").chosen.map((c) => c.id)).toEqual([3513, 3677]);
  });

  test("--auction matching no open auction stops the run and names the ones there are", () => {
    const now = Math.floor(Date.parse("2026-09-07T21:00:00Z") / 1000);
    expect(() => pickCycles(cycles, now, "Oct 02")).toThrow(/no open Alt auction matches/);
    expect(() => pickCycles(cycles, now, "Oct 02")).toThrow(/Sep 04 - Sep 17, 2026 \(id 3513\)/);
  });

  test("the auction to scan comes off --auction, else AUCTION, else blank", () => {
    expect(auctionFromArgs({})).toBe("");
    expect(auctionFromArgs({ AUCTION: "  Sep 04  " })).toBe("Sep 04");
  });

  test("asks for every PSA and CGC grade chased, in Alt's spelling, Pristine included", () => {
    const keys = gradeKeys();
    expect(keys).toContain("PSA-10");
    expect(keys).toContain("PSA-7.5");
    expect(keys).toContain("CGC-9.5");
    expect(keys).toContain("CGC-PRI");
    expect(keys).not.toContain("BGS-10");
  });

  test("reads a search document into a lot, with Pristine known outright", () => {
    const cycle = cycles[0];
    const lot = toLot({
      listingId: LISTING, itemName: "2023 Pokemon Japanese Scarlet & Violet 151 Master Ball Reverse Holo Magnemite #81 CGC 10 Pristine",
      gradingCompany: "CGC", grade: "PRI", gradeKey: "CGC-PRI", price: 38, bidCount: 5, auctionCycleId: 3512, auctionName: cycle.name,
    }, cycle);
    expect(lot.grade).toBe(10);
    expect(lot.pristine).toBe(true);
    expect(lot.language).toBe("Japanese");
    expect(lot.url).toBe(`https://alt.xyz/itm/${LISTING}`);
    expect(lot.closesAtUnixS).toBe(Math.floor(Date.parse(cycle.expiresAt) / 1000));
    expect(lot.cert).toBe("");
    // The order is the full arts first now, so a Master Ball reverse holo and
    // a plain one rank alike and price breaks the tie.
    expect(priorityRank({ grade: 10, gradingService: "CGC", title: "CGC 10", pristine: true }))
      .toBe(priorityRank({ grade: 10, gradingService: "CGC", title: "CGC 10", pristine: false }));
  });

  test("an English lot is English, and a numeric grade is a number", () => {
    const lot = toLot({ listingId: LISTING, itemName: "1999 Pokemon Base Set Holo Charizard #4 PSA 9", gradingCompany: "PSA", grade: "9", gradeKey: "PSA-9" }, cycles[0]);
    expect(lot.language).toBe("English");
    expect(lot.grade).toBe(9);
    expect(lot.pristine).toBe(false);
  });

  test("Alt chases every PSA/CGC lot; Fanatics chases the list for CGC only", () => {
    expect(alt.chaseList).toBe(false);
    expect(fanatics.chaseList).toEqual({ PSA: false, CGC: true });
    const plain: ScannedLot = {
      listingId: LISTING, url: listingUrl(LISTING), title: "2003 Pokemon Skyridge Holo Houndoom #H11 PSA 10 GEM MINT",
      grader: "PSA", grade: 10, cert: "12345678", currentBid: 40, bidCount: 2, auction: "Aug 28 - Sep 10, 2026", lot: lotLabel(LISTING), language: "English",
    };
    expect(selectCandidates([plain], () => {}, { chaseList: alt.chaseList }).candidates).toHaveLength(1);
    // PSA is off the list at Fanatics now, so a plain PSA lot is priced there too.
    expect(selectCandidates([plain], () => {}, { chaseList: fanatics.chaseList }).candidates).toHaveLength(1);
    // The same lot in a CGC slab still has to earn its place.
    const cgc: ScannedLot = { ...plain, grader: "CGC", title: plain.title.replace("PSA 10 GEM MINT", "CGC 9") , grade: 9 };
    expect(selectCandidates([cgc], () => {}, { chaseList: fanatics.chaseList }).candidates).toHaveLength(0);
    expect(selectCandidates([cgc], () => {}, { chaseList: alt.chaseList }).candidates).toHaveLength(1);
  });

  test("a chased lot whose cert never came back is counted, not priced", () => {
    const base: ScannedLot = {
      listingId: LISTING, url: listingUrl(LISTING), title: "2022 Pokemon Sword & Shield Lost Origin Alt Art Giratina V #186 PSA 10",
      grader: "PSA", grade: 10, cert: "", currentBid: 40, bidCount: 2, auction: "Aug 28 - Sep 10, 2026", lot: lotLabel(LISTING), language: "English",
    };
    const out = selectCandidates([base, { ...base, listingId: "b", cert: "12345678" }], () => {});
    expect(out.counts.noCert).toBe(1);
    expect(out.candidates.map((c) => c.listingId)).toEqual(["b"]);
  });
});

/**
 * The bid Alt actually took, on 2026-09-07: a $10 max on a lot with no bids,
 * sent as the page sends it and read back as WINNING.
 */
describe("the bid Alt takes", () => {
  test("one bid, the lot, and the max in whole dollars as a string", () => {
    expect(placeMaxBidsInput("99aa0262-2545-4037-97f9-9ee2eaa390d6", 1_000)).toEqual({
      bids: [{ listingId: "99aa0262-2545-4037-97f9-9ee2eaa390d6", maxBidPrice: "10" }],
    });
  });

  test("dollars, never cents, and never a fraction of one", () => {
    expect(placeMaxBidsInput("x", 5_200).bids[0].maxBidPrice).toBe("52");
    expect(placeMaxBidsInput("x", 5_250).bids[0].maxBidPrice).toBe("52");
    expect(placeMaxBidsInput("x", 100).bids[0].maxBidPrice).toBe("1");
  });

  test("the request is verified, so a live run is not refused in code", () => {
    expect(BID_INPUT_VERIFIED).toBe(true);
  });

  test("the standing read back off that bid: winning, at the max, in dollars", () => {
    // MyAuction's answer after the bid landed. currentBid is a string, userMaxBid a number.
    expect(centsOf("10.000000")).toBe(1_000);
    expect(centsOf(10.0)).toBe(1_000);
  });

  test("a $10 lot's next bid is $11 — the site's own figure, which the table now agrees with", () => {
    // presets [11, 13, 15] came back on that lot; the help centre's $10 step
    // down here was wrong.
    expect(ALT_STEPS.minimum({ currentBidCents: 1_000, startingPriceCents: 0, bidCount: 1 })).toBe(1_100);
  });
});

/**
 * The run of 2026-09-10 stopped itself after twelve refusals in a row, every
 * one of them Alt saying another bidder's max stood above ours. Nothing was
 * wrong with the account — it had taken eight bids minutes earlier.
 */
describe("who a refused bid is about", () => {
  test("a max already standing above ours is the lot, not the account", () => {
    expect(blameOf("Attempted bid of 110 was immediately outbid by an existing max bid. New effective bid price is 114.000000")).toBe("lot");
  });

  test("a bid under the next increment is the lot", () => {
    expect(blameOf("Bid must be at least 125")).toBe("lot");
    expect(blameOf("bid amount is too low")).toBe("lot");
    expect(blameOf("This listing is closed")).toBe("lot");
  });

  test("what the account is missing is the account", () => {
    expect(blameOf("A payment method is required to bid")).toBe("account");
    expect(blameOf("Your bidding limit has been reached")).toBe("account");
  });

  test("a refusal that says nothing useful is read as the account", () => {
    expect(blameOf("Alt did not take the bid")).toBe("account");
  });
});
