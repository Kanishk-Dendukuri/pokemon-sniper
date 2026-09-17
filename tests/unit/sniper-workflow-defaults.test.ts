import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { DEFAULT_TIERS, parseTiers } from "@/scripts/sniper-core";

/**
 * The workflow boxes' tier defaults are documented as "the code's own
 * (DEFAULT_TIERS)". Each one has to read back to exactly that table.
 */
const WORKFLOWS = ["fanatics-sniper.yml", "alt-sniper.yml", "sold-report.yml"];

describe("sniper workflow tier defaults", () => {
  for (const name of WORKFLOWS) {
    test(`${name}: psa_tiers / cgc_tiers defaults parse to DEFAULT_TIERS`, () => {
      const text = readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8");
      for (const [input, grader] of [["psa_tiers", "PSA"], ["cgc_tiers", "CGC"]] as const) {
        const m = new RegExp(`\\n\\s*${input}:[\\s\\S]*?\\n\\s*default:\\s*"([^"]+)"`).exec(text);
        expect(m, `${name} has a ${input} default`).not.toBeNull();
        expect(parseTiers(m![1])).toEqual(DEFAULT_TIERS[grader]);
      }
    });
  }
});
