import { describe, expect, test } from "vitest";
import { BUYERS_PREMIUM, type Row, bidOutcome, pollDelayS, toBiddable } from "@/scripts/fanatics-sniper";
import {
  BidBook,
  DEFAULT_BUDGET_DOLLARS,
  FANATICS_STEPS,
  type Biddable,
  type PlacedBid,
  allInCents,
  bidAmount,
  committedCents,
  dollars,
  jwtExpiresAt,
  listingIdFromUrl,
  nextAffordable,
  rungAtOrAbove,
  rungAtOrBelow,
  seedable,
  withinMax,
} from "@/scripts/fanatics-bidder";

const ID_A = "e06fcf08-9739-11f1-b601-0a58a9feac02";
const ID_B = "2a659c16-9e3b-11f1-984c-02ffc2f23927";
const ID_C = "db0a41da-a54c-11f1-9f87-0a58a9feac02";

const lot = (over: Partial<Biddable> = {}): Biddable => ({
  listingId: ID_A,
  title: "Mr. Mime PSA 10",
  lot: "WA242 Lot: 19961",
  maxHammerCents: 4000,
  maxAllInCents: 4810,
  currentBidCents: 2600,
  bidCount: 6,
  ...over,
});

describe("the bid ladder", () => {
  test("$1 rungs to $50, then $2, $5, $10, $25, $100", () => {
    expect(rungAtOrAbove(2_700)).toBe(2_700);
    expect(rungAtOrAbove(5_001)).toBe(5_200);
    expect(rungAtOrAbove(10_001)).toBe(10_500);
    expect(rungAtOrAbove(20_001)).toBe(21_000);
    expect(rungAtOrAbove(50_001)).toBe(52_500);
    expect(rungAtOrAbove(200_001)).toBe(210_000);
  });

  test("the rung below never rounds up", () => {
    expect(rungAtOrBelow(4_000)).toBe(4_000);
    expect(rungAtOrBelow(6_300)).toBe(6_200);
    expect(rungAtOrBelow(6_400)).toBe(6_400);
    expect(rungAtOrBelow(52_400)).toBe(50_000);
    expect(rungAtOrBelow(50)).toBe(0);
  });

  test("every rung below is at most the amount, for every whole-dollar max the tier table can produce", () => {
    for (let dollarsMax = 1; dollarsMax <= 600; dollarsMax++) {
      const cents = dollarsMax * 100;
      const rung = rungAtOrBelow(cents);
      expect(rung).toBeLessThanOrEqual(cents);
      expect(rungAtOrAbove(rung)).toBe(rung);
    }
  });
});

describe("the amount to bid", () => {
  test("the max itself when the ladder allows it and the lot is below it", () => {
    expect(bidAmount(lot(), { currentBidCents: 2_600, startingPriceCents: 500, bidCount: 6 })).toEqual({ cents: 4_000 });
  });

  test("the rung below the max where the ladder steps by more than a dollar", () => {
    expect(bidAmount(lot({ maxHammerCents: 6_300 }), { currentBidCents: 2_600, startingPriceCents: 500, bidCount: 6 })).toEqual({ cents: 6_200 });
  });

  test("no bid once the next acceptable bid is past the max", () => {
    expect(bidAmount(lot(), { currentBidCents: 4_000, startingPriceCents: 500, bidCount: 9 })).toMatchObject({ skip: expect.stringContaining("$41") });
    expect(bidAmount(lot(), { currentBidCents: 3_900, startingPriceCents: 500, bidCount: 9 })).toEqual({ cents: 4_000 });
  });

  test("a lot nobody has bid on starts at its starting price, not a cent above it", () => {
    expect(bidAmount(lot({ maxHammerCents: 500 }), { currentBidCents: 500, startingPriceCents: 500, bidCount: 0 })).toEqual({ cents: 500 });
    expect(bidAmount(lot({ maxHammerCents: 400 }), { currentBidCents: 0, startingPriceCents: 500, bidCount: 0 })).toMatchObject({ skip: expect.any(String) });
  });

  test("never above the max, whatever the lot says", () => {
    for (let current = 0; current <= 5_000; current += 100) {
      const out = bidAmount(lot(), { currentBidCents: current, startingPriceCents: 500, bidCount: current > 0 ? 1 : 0 });
      if ("cents" in out) expect(out.cents).toBeLessThanOrEqual(4_000);
    }
  });
});

describe("the guard on the way out", () => {
  test("lets the max and anything under it through", () => {
    expect(withinMax(4_000, lot())).toBe(4_000);
    expect(withinMax(100, lot())).toBe(100);
  });

  test("throws on a cent over the max hammer", () => {
    expect(() => withinMax(4_001, lot())).toThrow(/max hammer is \$40/);
  });

  test("throws when the all-in would pass the all-in max", () => {
    expect(() => withinMax(4_000, lot({ maxAllInCents: 4_700 }))).toThrow(/all-in/);
  });

  test("throws on nonsense", () => {
    expect(() => withinMax(0, lot())).toThrow();
    expect(() => withinMax(-100, lot())).toThrow();
    expect(() => withinMax(40.5, lot())).toThrow();
  });

  test("all-in is the premium on top", () => {
    expect(BUYERS_PREMIUM).toBe(0.2);
    expect(allInCents(4_000)).toBe(4_800);
    expect(dollars(4_800)).toBe("$48");
    expect(dollars(4_810)).toBe("$48.10");
  });
});

describe("the budget", () => {
  const placed = (over: Partial<PlacedBid>): PlacedBid => ({
    listingId: "x", title: "t", lot: "l", cents: 4_000, allInCents: 4_800, status: "HIGH_BID", closed: false, at: "", ...over,
  });

  test("holds what is winning or pending, drops what is outbid, keeps what is won", () => {
    expect(committedCents([
      placed({ listingId: "a", status: "HIGH_BID" }),
      placed({ listingId: "b", status: "OUTBID" }),
      placed({ listingId: "c", status: "PENDING", allInCents: 1_200 }),
      placed({ listingId: "d", status: "HIGH_BID", closed: true, allInCents: 2_400 }),
    ])).toBe(4_800 + 1_200 + 2_400);
  });

  test("a bid Fanatics has not made up its mind about is still money at risk", () => {
    // For a few seconds after a bid lands, the lot reads back NO_BIDS with a
    // zero max. Counting that as nothing committed put the whole budget back
    // on the table and the run would have bid on everything it could find.
    expect(committedCents([placed({ status: "NO_BIDS" })])).toBe(4_800);
    expect(committedCents([placed({ status: "NO_STATUS" })])).toBe(4_800);
    expect(committedCents([placed({ status: "PLANNED" })])).toBe(4_800);
  });

  test("a lot that closed to someone else is over, whatever it says", () => {
    expect(committedCents([placed({ status: "NO_BIDS", closed: true })])).toBe(0);
    expect(committedCents([placed({ status: "OUTBID", closed: true })])).toBe(0);
    expect(committedCents([placed({ status: "OUTBID", closed: false })])).toBe(0);
  });

  test("the default budget is $100", () => {
    expect(DEFAULT_BUDGET_DOLLARS).toBe(100);
  });

  test("the next lot is the first on the list the free budget covers, skipping what is decided", () => {
    const pool = [
      lot({ listingId: "a", maxHammerCents: 8_000 }),   // $96 all-in
      lot({ listingId: "b", maxHammerCents: 4_000 }),   // $48
      lot({ listingId: "c", maxHammerCents: 3_000 }),   // $36
    ];
    expect(nextAffordable(pool, new Set(), 10_000)?.listingId).toBe("a");
    expect(nextAffordable(pool, new Set(), 5_000)?.listingId).toBe("b");
    expect(nextAffordable(pool, new Set(["b"]), 5_000)?.listingId).toBe("c");
    expect(nextAffordable(pool, new Set(), 3_000)).toBeNull();
  });
});

/**
 * With no session the book bids nothing and quotes the scan's own snapshot, so
 * the whole walk — order, ladder, budget, what frees it — runs in a test.
 */
describe("the book, without an account", () => {
  const book = (budgetCents: number) => new BidBook(null, { budgetCents, live: false, log: () => {} });

  test("bids down the pool in the order given until the budget cannot reach the next lot", async () => {
    const pool = [
      lot({ listingId: ID_A, maxHammerCents: 4_000, currentBidCents: 2_600 }),   // $48 all-in
      lot({ listingId: ID_B, maxHammerCents: 3_700, currentBidCents: 3_300 }),   // $44.40
      lot({ listingId: ID_C, maxHammerCents: 3_900, currentBidCents: 3_500 }),   // $46.80
    ];
    const b = book(10_000);
    const out = await b.fill(pool);

    expect(out.placed).toBe(2);
    expect(b.placed.map((p) => [p.listingId, p.cents])).toEqual([[ID_A, 4_000], [ID_B, 3_700]]);
    expect(b.committed()).toBe(4_800 + 4_440);
    expect(b.free()).toBe(760);
    expect(b.full(pool)).toBe(true);
    expect(b.waiting(pool)).toBe(1);
  });

  test("a bid the account was already carrying is left alone and costs this run's budget nothing", async () => {
    const b = book(5_000);
    b.inherited.push({
      listingId: ID_C, title: "bid by hand last week", lot: "WA242 Lot: 1", cents: 400_000,
      allInCents: 480_000, status: "HIGH_BID", closed: false, at: new Date().toISOString(),
    });
    // $4,800 already on the account, and every cent of the budget still free.
    expect(b.committed()).toBe(0);
    expect(b.free()).toBe(5_000);

    const pool = [lot({ listingId: ID_A, maxHammerCents: 4_000 })];
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual([ID_A]);
    expect(b.standing()).toMatch(/already on the account, left alone/);
  });

  test("a lot already bid past its max is passed over, not bid at the wrong price", async () => {
    const pool = [lot({ maxHammerCents: 4_000, currentBidCents: 4_000, bidCount: 9 })];
    const b = book(10_000);
    await b.fill(pool);
    expect(b.placed).toHaveLength(0);
    expect(b.skipped[0].reason).toMatch(/the next bid is \$41/);
  });

  test("an outbid lot gives its share back, and the next lot down takes it", async () => {
    const pool = [
      lot({ listingId: ID_A, maxHammerCents: 4_000 }),
      lot({ listingId: ID_B, maxHammerCents: 3_700 }),
    ];
    const b = book(5_000);
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual([ID_A]);
    expect(b.free()).toBe(200);

    b.placed[0].status = "OUTBID";
    expect(b.free()).toBe(5_000);
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual([ID_A, ID_B]);
  });

  test("nothing is bid twice, however often the pool comes round again", async () => {
    const pool = [lot({ maxHammerCents: 4_000 })];
    const b = book(50_000);
    await b.fill(pool);
    await b.fill(pool);
    await b.fill(pool);
    expect(b.placed).toHaveLength(1);
  });

  test("a budget too small for anything on the list bids nothing", async () => {
    const b = book(1_000);
    await b.fill([lot({ maxHammerCents: 4_000 })]);
    expect(b.placed).toHaveLength(0);
    expect(b.finished()).toBe(true);
  });
});

/**
 * --count-existing-bids: the same bids, charged to the budget. What the
 * account is already standing behind is money it may have to pay, so a run
 * told to count it has that much less to spend — and still never touches
 * those lots.
 */
describe("the book counting the bids already on the account", () => {
  const counting = (budgetCents: number) =>
    new BidBook(null, { budgetCents, live: false, log: () => {}, countInherited: true });
  const already = (over: Partial<PlacedBid> = {}): PlacedBid => ({
    listingId: ID_C, title: "bid by hand last week", lot: "WA242 Lot: 1", cents: 2_000,
    allInCents: 2_400, status: "HIGH_BID", closed: false, at: new Date().toISOString(), ...over,
  });

  test("what is already on the account comes off the budget", () => {
    const b = counting(10_000);
    b.inherited.push(already());
    expect(b.committed()).toBe(2_400);
    expect(b.free()).toBe(7_600);
    expect(b.standing()).toMatch(/charged to the budget/);
  });

  test("the budget it holds is what is left for new bids, and stops the run sooner", async () => {
    const pool = [
      lot({ listingId: ID_A, maxHammerCents: 4_000 }),   // $48 all-in
      lot({ listingId: ID_B, maxHammerCents: 3_700 }),   // $44.40
    ];
    const b = counting(10_000);
    b.inherited.push(already({ cents: 4_000, allInCents: 4_800 }));
    await b.fill(pool);
    // $48 of the $100 spoken for before the run starts: one lot fits, not two.
    expect(b.placed.map((p) => p.listingId)).toEqual([ID_A]);
    expect(b.free()).toBe(400);
  });

  test("those lots are still left alone — counted, never bid on", async () => {
    const b = counting(50_000);
    b.inherited.push(already({ listingId: ID_A }));
    b.settled.add(ID_A);
    await b.fill([lot({ listingId: ID_A, maxHammerCents: 4_000 })]);
    expect(b.placed).toHaveLength(0);
  });

  test("one of them outbid gives its share back like any other bid", () => {
    const b = counting(10_000);
    const bid = already();
    b.inherited.push(bid);
    expect(b.free()).toBe(7_600);
    bid.status = "OUTBID";
    expect(b.free()).toBe(10_000);
  });

  test("a poll reads those bids back, and one gone outbid hands its share to the run", async () => {
    const account = new Map([[ID_C, {
      listingId: ID_C, title: "bid by hand last week", lot: "WA242 Lot: 1", maxCents: 2_000,
      status: "OUTBID" as const, closed: false, currentBidCents: 2_500, highestBidder: false,
      auctionId: "1", auctionStatus: "LIVE",
    }]]);
    const exchange = {
      steps: FANATICS_STEPS,
      listingUrl: (id: string) => `https://www.fanaticscollect.com/weekly/${id}`,
      quote: async () => { throw new Error("the account-wide read answers for these lots"); },
      accountBids: async () => account,
      readAuction: async () => null,
      sendBid: async () => ({ ok: true as const, bidId: null }),
    };
    const b = new BidBook(exchange, { budgetCents: 10_000, live: true, log: () => {}, countInherited: true });
    b.inherited.push(already());
    expect(b.free()).toBe(7_600);

    const polled = await b.poll();
    expect(polled.freed).toBe(2_400);
    expect(b.inherited[0].status).toBe("OUTBID");
    expect(b.free()).toBe(10_000);
    // Still the account's lot: the run reads it, and never bids on it.
    expect(b.placed).toHaveLength(0);
  });

  test("without the flag they cost the budget nothing, however they stand", () => {
    const b = new BidBook(null, { budgetCents: 10_000, live: false, log: () => {} });
    b.inherited.push(already());
    expect(b.committed()).toBe(0);
    expect(b.free()).toBe(10_000);
  });
});

/**
 * A bid refused for the lot's own reason is the lot. Every bid refused for the
 * account's reasons is the account, and there is nothing down the list for
 * that.
 */
describe("a run whose bids are all turned down", () => {
  const exchange = (error: string) => ({
    steps: FANATICS_STEPS,
    listingUrl: (id: string) => `https://www.fanaticscollect.com/weekly/${id}`,
    quote: async (listingId: string) => ({
      id: listingId, title: "a lot", lot: listingId, currentBidCents: 1_000, startingPriceCents: 1_000,
      bidCount: 0, highestBidder: false, isOwner: false, userMaxBidCents: 0, userCanBuy: true,
      userBidStatus: "NO_BIDS" as const, isClosed: false, auctionId: "1", auctionStatus: "LIVE",
    }),
    accountBids: async () => new Map(),
    readAuction: async () => null,
    sendBid: async () => ({ ok: false as const, error }),
  });
  const pool = (n: number) => Array.from({ length: n }, (_, i) =>
    lot({ listingId: `lot-${i}`, maxHammerCents: 4_000, maxAllInCents: 4_800, currentBidCents: 1_000, bidCount: 0 }));

  test("stops once enough have been refused in a row, and says it reads as the account", async () => {
    const b = new BidBook(exchange("no payment method on file"), { budgetCents: 1_000_000, live: true, log: () => {} });
    await expect(b.fill(pool(20))).rejects.toThrow(/read as the account/);
    expect(b.placed).toHaveLength(0);
  });

  test("bids outbid by maxes already standing are the lots, however many in a row", async () => {
    // The Alt run of 2026-09-10: twelve of these in a row stopped a run whose
    // account was taking bids minutes before.
    const outbid = exchange("Attempted bid of 110 was immediately outbid by an existing max bid. New effective bid price is 114.000000");
    const b = new BidBook(outbid, { budgetCents: 1_000_000, live: true, log: () => {} });
    await expect(b.fill(pool(20))).resolves.toMatchObject({ auctionClosed: false });
    expect(b.placed).toHaveLength(0);
  });

  test("a bid taken earlier in the run answers for the account, whatever comes after", async () => {
    // One bid taken, then nothing but account-shaped refusals: the account
    // plainly works, so the run stays on the lots rather than giving up.
    let n = 0;
    const oneThenRefused = {
      ...exchange("no payment method on file"),
      sendBid: async () => (++n === 1 ? { ok: true as const, bidId: null } : { ok: false as const, error: "no payment method on file" }),
    };
    const b = new BidBook(oneThenRefused, { budgetCents: 1_000_000, live: true, log: () => {} });
    await expect(b.fill(pool(20))).resolves.toMatchObject({ auctionClosed: false });
    expect(b.placed).toHaveLength(1);
  });

  test("a refusal here and there is the lots, and the run carries on", async () => {
    // Every third bid taken: the counter resets, so the run never gives up.
    let n = 0;
    const flaky = { ...exchange("outbid while the bid was in flight"), sendBid: async () => (++n % 3 === 0 ? { ok: true as const, bidId: null } : { ok: false as const, error: "outbid while the bid was in flight" }) };
    const b = new BidBook(flaky, { budgetCents: 1_000_000, live: true, log: () => {} });
    await expect(b.fill(pool(12))).resolves.toMatchObject({ auctionClosed: false });
    expect(b.placed.length).toBeGreaterThan(0);
  });
});

/**
 * The per-card caps are the book's, counted live: two lots of one card may
 * carry a bid at once, and an outbid one makes room for the next copy.
 */
describe("the per-card cap, counted live", () => {
  const CAPS = { perCard: 3 };
  const KEY = "pikachu|base|58";
  const capped = (budgetCents: number) => new BidBook(null, { budgetCents, live: false, log: () => {}, caps: CAPS });
  const copies = (n: number) =>
    Array.from({ length: n }, (_, i) => lot({ listingId: `copy-${i}`, maxHammerCents: 1_000, maxAllInCents: 1_200, currentBidCents: 500, cardKey: KEY }));

  test("three copies at a time; the fourth waits, and takes the place of one that is outbid", async () => {
    const pool = copies(4);
    const b = capped(100_000);
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual(["copy-0", "copy-1", "copy-2"]);
    expect(b.waiting(pool)).toBe(1);
    expect(b.full(pool)).toBe(true);

    b.placed[0].status = "OUTBID";
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual(["copy-0", "copy-1", "copy-2", "copy-3"]);
  });

  test("a copy won keeps its place: three won is three, and no fourth", async () => {
    const pool = copies(4);
    const b = capped(100_000);
    await b.fill(pool);
    for (const p of b.placed) { p.status = "HIGH_BID"; p.closed = true; }
    await b.fill(pool);
    expect(b.placed).toHaveLength(3);
    expect(b.full(pool)).toBe(true);

    // One of them lost to someone else at the close: that one is not a copy held, so the fourth gets its turn.
    b.placed[1].status = "OUTBID";
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual(["copy-0", "copy-1", "copy-2", "copy-3"]);
  });

  test("different cards do not count against each other, and a lot with no card key is never capped", async () => {
    const cheap = { maxHammerCents: 1_000, maxAllInCents: 1_200, currentBidCents: 500 };
    const pool = [...copies(3), lot({ listingId: "other", cardKey: "other|card", ...cheap }), lot({ listingId: "unkeyed", ...cheap })];
    const b = capped(100_000);
    await b.fill(pool);
    expect(b.placed.map((p) => p.listingId)).toEqual(["copy-0", "copy-1", "copy-2", "other", "unkeyed"]);
  });

  test("without a cap every copy is bid on", async () => {
    const b = new BidBook(null, { budgetCents: 100_000, live: false, log: () => {} });
    await b.fill(copies(4));
    expect(b.placed).toHaveLength(4);
  });
});

describe("the row the bidder is handed", () => {
  const row = (over: Partial<Row> = {}): Row => ({
    ...({} as Row),
    listing_id: ID_A,
    url: `https://www.fanaticscollect.com/weekly/${ID_A}`,
    title: "Mr. Mime PSA 10",
    lot: "WA242 Lot: 19961",
    current_bid: 26,
    bid_count: 6,
    max_bid_all_in: 48.1,
    max_bid_hammer: 40,
    flags: "",
    ...over,
  });

  test("carries the max, the scan's own snapshot of the bidding, and the card for the cap", () => {
    expect(toBiddable(row())).toEqual({
      listingId: ID_A, title: "Mr. Mime PSA 10", lot: "WA242 Lot: 19961",
      maxHammerCents: 4_000, maxAllInCents: 4_810, currentBidCents: 2_600, bidCount: 6,
      cardKey: undefined,
    });
    const keyed = toBiddable(row({ card_key: "mr mime|sv2a|122" }));
    expect(keyed?.cardKey).toBe("mr mime|sv2a|122");
  });

  test("a flagged row is never handed over", () => {
    expect(toBiddable(row({ flags: "grade: cert says 9, listing says 10" }))).toBeNull();
    expect(toBiddable(row({ flags: "unidentified: the 3-per-card cap was not checked (dry run)" }))).toBeNull();
  });

  test("nor is one without a max or a listing to bid on", () => {
    expect(toBiddable(row({ max_bid_hammer: "" }))).toBeNull();
    expect(toBiddable(row({ max_bid_all_in: "" }))).toBeNull();
    expect(toBiddable(row({ listing_id: "" }))).toBeNull();
  });

  test("the listing id comes off the lot URL", () => {
    expect(listingIdFromUrl(`https://www.fanaticscollect.com/weekly/${ID_A}`)).toBe(ID_A);
    expect(listingIdFromUrl(`https://www.fanaticscollect.com/weekly/${ID_A}/some-slug`)).toBe(ID_A);
    expect(listingIdFromUrl("https://www.fanaticscollect.com/marketplace")).toBeNull();
  });
});

describe("session tokens", () => {
  test("reads the expiry off a JWT and shrugs at anything else", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
    expect(jwtExpiresAt(`h.${payload}.s`)).toBe(1_800_000_000);
    expect(jwtExpiresAt("not a token")).toBe(0);
    expect(jwtExpiresAt("")).toBe(0);
  });
});

/**
 * The auction is only dangerous at the end, so that is where the run spends
 * its attention.
 */
describe("pace, as the auction closes in", () => {
  const HOUR = 3_600;

  test("slower than the base pace while the close is hours away", () => {
    expect(pollDelayS(20, "LIVE", 6 * HOUR)).toBe(60);
    expect(pollDelayS(20, "LIVE", HOUR + 60)).toBe(60);
  });

  test("the base pace through the last hour", () => {
    expect(pollDelayS(20, "LIVE", HOUR)).toBe(20);
    expect(pollDelayS(20, "LIVE", 20 * 60)).toBe(20);
  });

  test("twice as often inside the last quarter of an hour", () => {
    expect(pollDelayS(20, "LIVE", 15 * 60)).toBe(10);
    expect(pollDelayS(20, "LIVE", 60)).toBe(10);
  });

  test("four times as often once extended bidding starts, whatever the clock says", () => {
    expect(pollDelayS(20, "EXTENDED_BIDDING", 6 * HOUR)).toBe(5);
    expect(pollDelayS(20, "EXTENDED_BIDDING", -600)).toBe(5);
  });

  test("never faster than the floor, however small the base", () => {
    expect(pollDelayS(5, "EXTENDED_BIDDING", 0)).toBe(5);
    expect(pollDelayS(8, "EXTENDED_BIDDING", 0)).toBe(5);
  });
});

describe("which of the account's bids this budget holds against it", () => {
  const bid = (over: Partial<Parameters<typeof seedable>[0]>) =>
    ({ maxCents: 4_000, closed: false, auctionStatus: "LIVE", ...over });

  test("an open bid in a running auction", () => {
    expect(seedable(bid({}))).toBe(true);
    expect(seedable(bid({ auctionStatus: "EXTENDED_BIDDING" }))).toBe(true);
  });

  test("last month's won lots are history, not this budget — the whole point of the check", () => {
    expect(seedable(bid({ closed: true }))).toBe(false);
    expect(seedable(bid({ closed: true, auctionStatus: "CLOSED" }))).toBe(false);
    expect(seedable(bid({ auctionStatus: "CLOSED" }))).toBe(false);
  });

  test("no max bid is no bid", () => {
    expect(seedable(bid({ maxCents: 0 }))).toBe(false);
  });

  test("an auction Fanatics did not name is given the benefit of the doubt", () => {
    expect(seedable(bid({ auctionStatus: "" }))).toBe(true);
  });
});

describe("what became of a bid", () => {
  test("winning and won are the same word from Fanatics, told apart by the close", () => {
    expect(bidOutcome({ status: "HIGH_BID", closed: false })).toBe("winning");
    expect(bidOutcome({ status: "HIGH_BID", closed: true })).toBe("won");
  });

  test("outbid, and closed to someone else", () => {
    expect(bidOutcome({ status: "OUTBID", closed: false })).toBe("outbid");
    expect(bidOutcome({ status: "OUTBID", closed: true })).toBe("lost");
    expect(bidOutcome({ status: "NO_BIDS", closed: true })).toBe("lost");
  });

  test("this run's own two: never sent, and sent but not seen again", () => {
    expect(bidOutcome({ status: "PLANNED", closed: false })).toBe("would bid");
    expect(bidOutcome({ status: "PENDING", closed: false })).toBe("bid sent, standing unknown");
  });
});
