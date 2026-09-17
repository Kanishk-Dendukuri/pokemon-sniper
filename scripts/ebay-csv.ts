/**
 * The eBay CSV export, read into ordered columns and coerced row tuples.
 *
 * Two things read an eBay export: scripts/import-cards.ts, which ingests one
 * into the vault, and the Card Uploader driver (scripts/carduploader-batch.ts),
 * which counts how many rows of a downloaded export came back without a price.
 * The driver is shared with the snipers, which live in their own repository and
 * have no database, so the parser sits here on its own rather than inside the
 * importer that happens to have been written first.
 *
 * Unknown headers are an error, not a shrug: a silently dropped column is data
 * loss nobody notices until the card is already sold.
 */

import { parse } from "csv-parse/sync";

// ── CSV header → database column ──────────────────────────────────────────────
// Keyed on the exact header text eBay emits. The *Action header is handled
// separately because it embeds a version number that changes between exports.
const COLUMN_MAP: Record<string, string> = {
  "ItemID":                                 "item_id",
  "*Category":                              "category",
  "*Title":                                 "title",
  "Subtitle":                               "subtitle",
  "CustomLabel":                            "custom_label",
  "*ConditionID":                           "condition_id",
  "CD:Professional Grader - (ID: 27501)":   "grader",
  "CD:Grade - (ID: 27502)":                 "grade",
  "CDA:Certification Number - (ID: 27503)": "cert_number",
  "*C:Game":                                "game",
  "*C:Sport":                               "sport",
  "PicURL":                                 "pic_url",
  "*Description":                           "description",
  "*Format":                                "format",
  "*Duration":                              "duration",
  "ListingDuration":                        "listing_duration",
  "ScheduleTime":                           "schedule_time",
  "*StartPrice":                            "start_price",
  // Mapped so the header is recognised, never read. See the cost comment
  // in toIngestRecords.
  "BuyItNowPrice":                          "buy_it_now_price",
  "*Quantity":                              "quantity",
  "*DispatchTimeMax":                       "dispatch_time_max",
  "ShippingProfileName":                    "shipping_profile_name",
  "*C:Set":                                 "set_name",
  "*C:Rarity":                              "rarity",
  "*C:Speciality":                          "speciality",
  "*C:Finish":                              "finish",
  "*C:Card Type":                           "card_type",
  "*C:Card Name":                           "card_name",
  "*C:Illustrator":                         "illustrator",
  "*C:Manufacturer":                        "manufacturer",
  "*C:Graded":                              "graded",
  "*C:Attribute/MTG:Colour":                "attribute_colour",
  "*C:Card Size":                           "card_size",
  "*C:Character":                           "character",
  "*C:Language":                            "language",
  "*C:Stage":                               "stage",
  "*C:Country/Region of Manufacture":       "country_region_of_manufacture",
  "*C:Country of Origin":                   "country_of_origin",
  "*C:Age Level":                           "age_level",
  "*C:Card Number":                         "card_number",
  "*C:Year Manufactured":                   "year_manufactured",
  "*C:Autographed":                         "autographed",
  "C:Player/Athlete":                       "player_athlete",
  "C:Signed By":                            "signed_by",
  "C:Season":                               "season",
  "C:Parallel/Variety":                     "parallel_variety",
  "C:Features":                             "features",
  "C:League":                               "league",
  "C:Team":                                 "team",
  "C:Autograph Authentication":             "autograph_authentication",
  "C:Autograph Authentication Number":      "autograph_authentication_number",
  "C:Autograph Format":                     "autograph_format",
  "*C:Material":                            "material",
  "PostalCode":                             "postal_code",
  "WeightMajor":                            "weight_major",
  "WeightMinor":                            "weight_minor",
  "PackageLength":                          "package_length",
  "PackageWidth":                           "package_width",
  "PackageDepth":                           "package_depth",
  "WeightUnit":                             "weight_unit",
  "BestOfferEnabled":                       "best_offer_enabled",
  "MinimumBestOfferPrice":                  "minimum_best_offer_price",
  "BestOfferAutoAcceptPrice":               "best_offer_auto_accept_price",
  "StoreCategory":                          "store_category",
  "Storecategory2":                         "store_category2",
  "PaymentProfileName":                     "payment_profile_name",
  "ReturnProfileName":                      "return_profile_name",
  "Location":                               "location",
};

const INT_COLUMNS = new Set([
  "quantity", "dispatch_time_max", "year_manufactured",
]);

const NUMERIC_COLUMNS = new Set([
  // buy_it_now_price is deliberately absent: nothing reads it, so a junk
  // value in it should not fail an otherwise good file.
  "start_price", "weight_major", "weight_minor",
  "package_length", "package_width", "package_depth",
  "minimum_best_offer_price", "best_offer_auto_accept_price",
]);

function columnFor(header: string): string | null {
  // *Action(SiteID=US|...|Version=1193|CC=UTF-8) — the version bumps over time,
  // so match on the prefix rather than the full string.
  if (header.startsWith("*Action(")) return "action";
  return COLUMN_MAP[header] ?? null;
}

// ── Value coercion ────────────────────────────────────────────────────────────
// eBay writes "" for every unset field. Left as-is, an empty string fails to
// cast into INT/NUMERIC, so it has to become NULL first.
function coerce(column: string, raw: string): string | number | null {
  const value = raw.trim();
  if (value === "") return null;

  if (INT_COLUMNS.has(column)) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) throw new Error(`${column}: expected integer, got "${raw}"`);
    return n;
  }

  if (NUMERIC_COLUMNS.has(column)) {
    const n = Number.parseFloat(value);
    if (Number.isNaN(n)) throw new Error(`${column}: expected number, got "${raw}"`);
    return n;
  }

  return value;
}

/** Turns a CSV file's text into ordered columns plus coerced row tuples. */
export function parseCsv(text: string, filename: string) {
  const records = parse(text, {
    columns:          false,
    skip_empty_lines: true,
    relax_column_count: false,
  }) as string[][];

  if (records.length === 0) throw new Error(`${filename}: file is empty`);

  const headers = records[0];
  const columns: string[] = [];
  const keptIdx: number[] = [];

  headers.forEach((header, i) => {
    const column = columnFor(header);
    if (!column) {
      // Fail loudly. A silently dropped column is data loss that nobody notices
      // until the card is already sold.
      throw new Error(
        `${filename}: unrecognized CSV header "${header}" (column ${i + 1}). ` +
        `eBay may have changed its export format — update COLUMN_MAP.`);
    }
    columns.push(column);
    keptIdx.push(i);
  });

  const rows = records.slice(1).map((record, r) =>
    keptIdx.map((i, c) => {
      try {
        return coerce(columns[c], record[i] ?? "");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${filename} row ${r + 2}: ${message}`);
      }
    }));

  return { columns, rows };
}
