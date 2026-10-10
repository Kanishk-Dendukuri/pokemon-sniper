/**
 * Pricing by batch upload: Card Uploader prices a batch only once its window
 * is open, so the window is opened and the five sales it shows under each
 * card are what the run prices from.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { batchWindowUrl, identifyViaBatch, type Candidate, type CuPrice, type CuSession } from "@/scripts/sniper-core";

const SALES = [
  { price: 25, date: "2026-10-10T00:00:00.000Z", platform: "Fanatics-Vault", url: "https://example.test/1" },
  { price: 28.95, date: "2026-10-02T00:00:00.000Z", platform: "eBay" },
  { price: 40, date: "2026-09-25T00:00:00.000Z", platform: "eBay" },
  { price: 41, date: "2026-09-23T00:00:00.000Z", platform: "eBay" },
  { price: 34, date: "2026-09-18T00:00:00.000Z", platform: "eBay" },
];

type Listener = (event: { url(): string; status(): number }) => void;

/**
 * Card Uploader, as far as a batch is concerned: a job that completes at
 * once, cards that carry no price until the batch's window has been opened,
 * and then whichever of them `prices` says the window managed.
 */
function cardUploader(opts: {
  certs: string[];
  prices?: (cert: string, opened: number) => boolean;
  /** What the window asks its backend for on loading. */
  onOpen?: (emit: (event: string, url: string, status?: number) => void, opened: number) => void;
}) {
  const listeners = new Map<string, Set<Listener>>();
  const seen: string[] = [];
  let opened = 0;
  const emit = (event: string, url: string, status = 200) => listeners.get(event)?.forEach((fn) => fn({ url: () => url, status: () => status }));
  const answer = (body: unknown) => ({ ok: () => true, status: () => 200, json: async () => body, text: async () => JSON.stringify(body) });
  const card = (cert: string) => ({
    certificationNumber: cert, cardName: "Pikachu", setName: "151", cardnumber: "025", year: "2023",
    gradeNumber: "10", gradeText: "GEM MT 10", language: "English", price: null,
    ...(opened > 0 && (opts.prices?.(cert, opened) ?? true)
      ? { pricingFetchedAt: "2026-10-10T19:55:00.000Z", pricing: { psa: { currentAltValue: 31.4 } }, certPricing: { recentSales: SALES } }
      : {}),
  });
  const page = {
    on: (event: string, fn: Listener) => { listeners.set(event, (listeners.get(event) ?? new Set()).add(fn)); },
    off: (event: string, fn: Listener) => { listeners.get(event)?.delete(fn); },
    goto: async (url: string) => {
      seen.push(`open ${url}`);
      if (url === batchWindowUrl("job-1")) { opened++; opts.onOpen?.(emit, opened); }
    },
    request: {
      post: async () => { seen.push("upload"); return answer({ job_id: "job-1", status: "queued" }); },
      get: async (url: string) => {
        if (url.endsWith("/backend/jobs/job-1")) return answer({ job_id: "job-1", status: "completed" });
        if (url.endsWith("/backend/jobs/job-1/data")) { seen.push("read"); return answer({ results: { cards: opts.certs.map(card) } }); }
        throw new Error(`unexpected GET ${url}`);
      },
      put: async () => answer({}),
      delete: async () => { seen.push("delete"); return answer({}); },
    },
  };
  const session = { page, bearer: { current: () => "Bearer test" }, refreshedAtMs: Date.now(), close: async () => {} } as unknown as CuSession;
  return { session, seen, listeners };
}

const candidates = (certs: string[]) => certs.map((cert) => ({ grader: "PSA", cert }) as Candidate);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pricing a batch off its window", () => {
  test("the window is opened before anything is read, and the five sales it shows are the price", async () => {
    const cu = cardUploader({ certs: ["111", "222"] });
    const prices = new Map<string, CuPrice>();
    const identified = await identifyViaBatch(cu.session, candidates(["111", "222"]), "Test", { prices });

    expect(cu.seen).toEqual(["upload", `open ${batchWindowUrl("job-1")}`, "read", "delete"]);
    expect([...identified.keys()]).toEqual(["PSA:111", "PSA:222"]);
    const price = prices.get("PSA:111")!;
    expect(price.sales.map((s) => [s.price, s.date.slice(0, 10), s.platform])).toEqual([
      [25, "2026-10-10", "Fanatics-Vault"], [28.95, "2026-10-02", "eBay"], [40, "2026-09-25", "eBay"],
      [41, "2026-09-23", "eBay"], [34, "2026-09-18", "eBay"],
    ]);
    expect(price.altValue).toBe(31.4);
    expect(price.card?.cardName).toBe("Pikachu");
    expect(price.error).toBeUndefined();
    // Nothing is left listening on the page once the batch is done.
    expect([...cu.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  test("identifying alone never needed the window, and still does not open it", async () => {
    const cu = cardUploader({ certs: ["111"] });
    const identified = await identifyViaBatch(cu.session, candidates(["111"]), "Test");
    expect(identified.get("PSA:111")?.setName).toBe("151");
    expect(cu.seen).toEqual(["upload", "read", "delete"]);
  });

  test("the address is the batch's own page", () => {
    expect(batchWindowUrl("45b8f734-c241")).toBe("https://carduploader.com/dashboard/history/graded/45b8f734-c241");
  });

  test("a window that asks for no price is opened once more", async () => {
    vi.useFakeTimers();
    // The first load does nothing at all; the second prices the batch.
    const cu = cardUploader({ certs: ["111"], prices: (_cert, opened) => opened >= 2 });
    const prices = new Map<string, CuPrice>();
    const run = identifyViaBatch(cu.session, candidates(["111"]), "Test", { prices });
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(cu.seen.filter((s) => s.startsWith("open "))).toHaveLength(2);
    expect(prices.get("PSA:111")?.sales).toHaveLength(5);
  });

  test("a card the window could not price does not hold the batch once the window has stopped asking", async () => {
    vi.useFakeTimers();
    const lookup = "https://carduploader.com/backend/graded-pricing/cardladder?certNumber=111&grader=psa";
    const cu = cardUploader({
      certs: ["111", "222", "333"],
      prices: (cert) => cert !== "333",
      // The third card's lookup is turned away as rate limited, the way one was on 2026-10-10.
      onOpen: (emit) => { emit("request", lookup); emit("response", lookup, 429); emit("requestfinished", lookup); },
    });
    const prices = new Map<string, CuPrice>();
    const run = identifyViaBatch(cu.session, candidates(["111", "222", "333"]), "Test", { prices });
    // Well inside the two minutes and more a three-card batch would otherwise be given.
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(cu.seen.filter((s) => s.startsWith("open "))).toHaveLength(1);
    expect(prices.get("PSA:111")?.sales).toHaveLength(5);
    expect(prices.get("PSA:222")?.sales).toHaveLength(5);
    // Identified, and with nothing to price it from: the sales rule turns it down like any thin card.
    expect(prices.get("PSA:333")?.sales).toEqual([]);
    expect(prices.get("PSA:333")?.card?.cardName).toBe("Pikachu");
    // And the log says why, rather than leaving a card with no sales to be guessed at.
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/refused 1 of the window's lookup\(s\) as rate limited/);
  });
});
