/**
 * Private exclusions: lots a run leaves out by a rule that is kept out of the
 * repository, counted in the log, and never printed.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  parsePrivateExclusions,
  privateExclusionsFromEnv,
  privatelyExcluded,
  selectCandidates,
  setPrivateExclusions,
  type ScannedLot,
} from "@/scripts/sniper-core";

afterEach(() => setPrivateExclusions([]));

const lot = (over: Partial<ScannedLot> = {}): ScannedLot => ({
  listingId: "a", url: "https://example.test/a", title: "2003 Pokemon Skyridge Holo Houndoom #H11 CGC 9 MINT",
  grader: "CGC", grade: 9, cert: "11111111", currentBid: 40, bidCount: 2, auction: "WA247", lot: "a", language: "English",
  ...over,
});

describe("reading the rules", () => {
  test("a language, a grader and a grade or a range, any of them, in any order", () => {
    expect(parsePrivateExclusions("English CGC 8-9")).toEqual([{ language: "English", grader: "CGC", grades: { min: 8, max: 9 } }]);
    expect(parsePrivateExclusions("cgc 9.5 japanese")).toEqual([{ language: "Japanese", grader: "CGC", grades: { min: 9.5, max: 9.5 } }]);
    expect(parsePrivateExclusions("PSA 1-3, English; CGC 7")).toEqual([
      { grader: "PSA", grades: { min: 1, max: 3 } }, { language: "English" }, { grader: "CGC", grades: { min: 7, max: 7 } },
    ]);
    expect(parsePrivateExclusions("  ")).toEqual([]);
  });

  test("an error names the rule by its place and never by its words", () => {
    const secret = "English CGC 8-9, Japanese BGS sideways";
    const error = (() => { try { privateExclusionsFromEnv({ PRIVATE_EXCLUDE: secret }); return ""; } catch (err) { return String((err as Error).message); } })();
    expect(error).toBe("the private exclusion list (PRIVATE_EXCLUDE) could not be read: rule 2 of 2 has a word that is not a language, a grader or a grade");
    for (const word of ["Japanese", "BGS", "sideways", "English", "8-9"]) expect(error).not.toContain(word);
    expect(() => parsePrivateExclusions("CGC CGC 9")).toThrow(/rule 1 of 1 names a grader twice/);
    expect(() => parsePrivateExclusions("9 10")).toThrow(/rule 1 of 1 names a grade twice/);
  });

  test("the environment, and nothing when it is blank", () => {
    expect(privateExclusionsFromEnv({})).toEqual([]);
    expect(privateExclusionsFromEnv({ PRIVATE_EXCLUDE: "" })).toEqual([]);
    expect(privateExclusionsFromEnv({ PRIVATE_EXCLUDE: "English CGC 9" })).toHaveLength(1);
  });
});

describe("what a rule leaves out", () => {
  const rules = parsePrivateExclusions("English CGC 8-9");

  test("a lot that answers to every part of it, and no other", () => {
    expect(privatelyExcluded(lot(), rules)).toBe(true);
    expect(privatelyExcluded(lot({ grade: 8.5 }), rules)).toBe(true);
    expect(privatelyExcluded(lot({ grade: 9.5 }), rules)).toBe(false);
    expect(privatelyExcluded(lot({ grader: "PSA" }), rules)).toBe(false);
    expect(privatelyExcluded(lot({ language: "Japanese" }), rules)).toBe(false);
    // A slab with no number grade is not inside any range of them.
    expect(privatelyExcluded(lot({ grade: undefined }), rules)).toBe(false);
  });

  test("what a rule does not name matches anything", () => {
    expect(privatelyExcluded(lot({ language: "Japanese", grade: 3 }), parsePrivateExclusions("CGC"))).toBe(true);
    expect(privatelyExcluded(lot({ grader: "PSA", grade: 10 }), parsePrivateExclusions("English"))).toBe(true);
  });

  test("no rules, nothing left out", () => {
    expect(privatelyExcluded(lot(), [])).toBe(false);
    expect(privatelyExcluded(lot())).toBe(false);
  });
});

describe("the selection", () => {
  const lots = [
    lot({ listingId: "out-1" }),
    lot({ listingId: "out-2", cert: "22222222", grade: 8 }),
    lot({ listingId: "kept-grade", cert: "33333333", grade: 10 }),
    lot({ listingId: "kept-language", cert: "44444444", language: "Japanese" }),
  ];

  test("an excluded lot is never a candidate: it is counted, and listed nowhere", () => {
    setPrivateExclusions(parsePrivateExclusions("English CGC 8-9"));
    const said: string[] = [];
    const out = selectCandidates(lots, (line) => said.push(line), { chaseList: false });
    expect(out.candidates.map((c) => c.listingId).sort()).toEqual(["kept-grade", "kept-language"]);
    expect(out.counts.excluded).toBe(2);
    expect(out.rejected).toEqual([]);
    // The log says how many, and nothing a reader could put the rule back together from.
    const line = said.find((l) => l.includes("private rule"));
    expect(line).toBe("    excluded: 2 by a private rule — set outside the repository, and not listed here");
    expect(said.join("\n")).not.toMatch(/out-1|out-2|English|8-9/);
  });

  test("with no rule set, nothing is excluded and nothing is said about it", () => {
    const said: string[] = [];
    const out = selectCandidates(lots, (line) => said.push(line), { chaseList: false });
    expect(out.candidates).toHaveLength(4);
    expect(out.counts.excluded).toBe(0);
    expect(said.join("\n")).not.toContain("private rule");
  });
});
