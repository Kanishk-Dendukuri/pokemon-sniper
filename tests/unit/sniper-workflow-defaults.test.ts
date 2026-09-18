import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_BASIS,
  DEFAULT_SALES_RULE,
  formatBasis,
  parseBasis,
  parseSalesRule,
  DEFAULT_TIERS,
  parseTiers,
} from "@/scripts/sniper-core";
import { DEFAULT_BUDGET_DOLLARS } from "@/scripts/sniper-book";
import { fanatics } from "@/scripts/fanatics-sniper";
import { alt } from "@/scripts/alt-sniper";

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

/**
 * The budget box is the code's own ceiling, and the fire box is the venue's
 * own rule: the number typed in by default has to be the number the code
 * would use with the box left blank.
 */
describe("sniper workflow budget and fire defaults", () => {
  const read = (name: string) => readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8");
  const defaultOf = (text: string, input: string) =>
    new RegExp(`\\n\\s*${input}:[\\s\\S]*?\\n\\s*default:\\s*"([^"]*)"`).exec(text)?.[1];

  for (const [name, venue] of [["fanatics-sniper.yml", fanatics], ["alt-sniper.yml", alt]] as const) {
    test(`${name}: the budget box defaults to the code's ceiling and the fire box to the venue's minutes`, () => {
      const text = read(name);
      expect(Number(defaultOf(text, "budget"))).toBe(DEFAULT_BUDGET_DOLLARS);
      expect(Number(defaultOf(text, "fire_after_minutes"))).toBe(venue.fireAfterMinutes);
      // The command line falls back to the same ceiling when the box is emptied.
      expect(text).toContain(`--budget=\${{ inputs.budget || '${DEFAULT_BUDGET_DOLLARS}' }}`);
      expect(text).toContain("FIRE_AFTER_MINUTES: ${{ inputs.fire_after_minutes }}");
    });
  }

  test("Fanatics fires at 7:27 PM PT and Alt at 10:40 PM ET", () => {
    expect(fanatics.fireAfterMinutes).toBe(27);
    expect(fanatics.closesTogether).toBe(false);
    expect(alt.fireAfterMinutes).toBe(100);
    expect(alt.closesTogether).toBe(true);
  });
});

/**
 * The value basis and sales-rule boxes are the same three workflows' way of
 * choosing what a card is worth before any percentage touches it. Every option
 * in the dropdown has to be one the code can read — an option it cannot read
 * is a run that dies after the dispatch, with the auction already closing —
 * and the box's default has to be what the code does with the box left blank.
 */
describe("sniper workflow value basis and sales rule", () => {
  const read = (name: string) => readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8");
  const defaultOf = (text: string, input: string) =>
    new RegExp(`\\n\\s*${input}:[\\s\\S]*?\\n\\s*default:\\s*"([^"]*)"`).exec(text)?.[1];
  /** The option lines under an input's `options:` list. */
  const optionsOf = (text: string, input: string) => {
    const block = new RegExp(`\\n\\s*${input}:[\\s\\S]*?\\n\\s*options:\\n((?:\\s*- "[^"]*"\\n)+)`).exec(text)?.[1] ?? "";
    return [...block.matchAll(/- "([^"]*)"/g)].map((m) => m[1]);
  };

  for (const name of WORKFLOWS) {
    test(`${name}: every value_basis option reads, and the default is the code's own`, () => {
      const text = read(name);
      const options = optionsOf(text, "value_basis");
      expect(options.length, `${name} lists value_basis options`).toBeGreaterThan(1);
      for (const option of options) expect(() => parseBasis(option), option).not.toThrow();
      // The dropdown offers the default, and it is the basis the code bids by
      // with the box left alone.
      const chosen = defaultOf(text, "value_basis");
      expect(options).toContain(chosen);
      expect(parseBasis(chosen!)).toEqual(DEFAULT_BASIS);
      expect(chosen).toBe(formatBasis(DEFAULT_BASIS));
      expect(text).toContain("VALUE_BASIS: ${{ inputs.value_basis }}");
    });

    test(`${name}: the sales-rule box defaults to the code's own rule`, () => {
      const text = read(name);
      expect(parseSalesRule(defaultOf(text, "sales_rule")!)).toEqual(DEFAULT_SALES_RULE);
      expect(text).toContain("SALES_RULE: ${{ inputs.sales_rule }}");
    });

    test(`${name}: stays inside the ten inputs a dispatch form allows`, () => {
      const inputs = read(name).split("\n    inputs:\n")[1] ?? "";
      const names = [...inputs.matchAll(/\n      ([a-z_]+):\n/g)].map((m) => m[1]);
      expect(names).toContain("value_basis");
      expect(names.length).toBeLessThanOrEqual(10);
    });
  }
});
