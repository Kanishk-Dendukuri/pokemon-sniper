/**
 * eBay — reading the cert number off the slab.
 *
 * None of the sellers publish a certification number: not in the title, not
 * in eBay's item specifics, not in the description. Four hundred listings
 * were sampled and not one carried it. What every one of them does carry is a
 * photograph of the slab, label first, and the number is printed on the
 * label — so it is read from there.
 *
 * That matters because a cert number is the only thing Card Uploader prices
 * from, and the tier tables and the sales rule are all fitted on Card
 * Uploader's numbers. Reading the label keeps eBay on exactly the same
 * pricing as Fanatics and Alt rather than a second, incomparable one.
 *
 * It is Tesseract — free, offline, no account and no API key anywhere. The
 * target suits it: a fixed-length run of digits in clean type on a flat
 * label, with the grader already known from the title, so the reader is
 * asked for digits and nothing else.
 *
 * Nine passes are run over each photograph — the whole image and the two
 * bands at the top where the label sits, at three page-segmentation modes —
 * and the digit runs they turn up are voted on. Only runs the right length
 * for the grader are counted, which throws out the card number, the year and
 * the copyright line, and the winner must be ahead of the runner-up
 * outright. On the sample it read every cert exactly: seven of seven, PSA and
 * CGC, across all four sellers. A tie is no answer rather than a guess.
 *
 * It wants the real Tesseract, not the WASM build: tesseract.js cannot crop
 * (its rectangle option returned four characters where the label was) and its
 * model misread digits the binary reads cleanly — 60367241 came back as
 * 80367241. Installing it is one line, and the sniper says so if it is
 * missing: winget install UB-Mannheim.TesseractOCR on Windows, brew install
 * tesseract on a Mac.
 *
 * A misread is not a bad bid, either: the number goes to Card Uploader, and
 * the card that comes back is checked against the listing's own grader,
 * grade, year and card number (certMismatches in ebay-sniper.ts). A cert that
 * does not answer to its listing is dropped.
 */
import { execFile } from "child_process";
import { unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";

const run = promisify(execFile);

/**
 * The shares of the photograph, from the top, the grading label is looked for
 * in. Two bands rather than one because the slab sits differently in
 * different sellers' photographs.
 */
export const LABEL_BANDS = [0.25, 0.18];
/** eBay serves the big variant under this name; the label is unreadable below it. */
export const LARGE_IMAGE = "s-l1600";
/**
 * Page-segmentation modes to read under: one block, scattered text, one
 * column. Between them they catch a label photographed straight on and one at
 * an angle. The modes that detect orientation are left out — they want a data
 * file the usual install does not carry, and a label is never upside down.
 */
const PAGE_MODES = ["6", "11", "4"] as const;
/**
 * A reading off the label band counts double. The cert is printed there, so a
 * number that turns up in the band is likelier to be the cert than one found
 * anywhere on the card — the copyright line, the card number, the HP.
 */
const BAND_WEIGHT = 2;
const IMAGE_TIMEOUT_MS = 20_000;
const OCR_TIMEOUT_MS = 30_000;
/** The label is small in the frame; Tesseract reads it better enlarged. */
const BAND_SCALE = 3;

/** What the label says, as read. */
export type CertReading = {
  grader: string;
  cert: string;
  grade: number | null;
  /** How many of the passes agreed on it. */
  votes?: number;
  /** Why nothing could be read, when nothing could. */
  unreadable?: string;
};

/**
 * How long a cert number is, by grader. A reading the wrong length is a
 * misread — a card number or a year picked up instead — and is thrown away
 * rather than sent to Card Uploader, which would answer for some other card.
 */
export const CERT_LENGTHS: Record<string, { min: number; max: number }> = {
  PSA: { min: 7, max: 9 },
  CGC: { min: 9, max: 11 },
  BGS: { min: 8, max: 11 },
  SGC: { min: 7, max: 11 },
};

export function certBounds(grader: string): { min: number; max: number } {
  return CERT_LENGTHS[grader.toUpperCase()] ?? { min: 7, max: 11 };
}

export function certLooksRight(grader: string, cert: string): boolean {
  if (!/^\d+$/.test(cert)) return false;
  const { min, max } = certBounds(grader);
  return cert.length >= min && cert.length <= max;
}

/** eBay's image URLs carry the size in the filename; the label needs the big one. */
export function largeImageUrl(url: string): string {
  return url.replace(/s-l\d+\.(jpg|jpeg|png|webp)/i, `${LARGE_IMAGE}.$1`);
}

/**
 * A JPEG's dimensions, off its own header — enough to crop to the label
 * without an image library. Null for anything that is not a JPEG whose size
 * can be found, in which case the whole photograph is read instead.
 */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // Start-of-frame markers carry the size; DHT/DAC/RST and friends do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * The winner of a vote across passes: every digit run the right length for
 * the grader, counted, best first. A tie is no answer — two readings equally
 * supported means the label was not read, and a cert guessed between them
 * would price whichever card it happened to hit.
 */
export function voteOnCert(texts: { text: string; weight?: number }[], grader: string): { cert: string; votes: number; runnerUp: number } {
  const { min, max } = certBounds(grader);
  const counts = new Map<string, number>();
  for (const { text, weight = 1 } of texts) {
    // Maximal runs only: a ten-digit run is not a nine-digit PSA cert with a
    // stray digit beside it, it is a misreading, and taking the first nine of
    // it would price a different card.
    const runs = text.replace(/[^\d]+/g, "\n").match(new RegExp(`(?<!\\d)\\d{${min},${max}}(?!\\d)`, "g")) ?? [];
    for (const run of new Set(runs)) counts.set(run, (counts.get(run) ?? 0) + weight);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { cert: "", votes: 0, runnerUp: 0 };
  const runnerUp = ranked[1]?.[1] ?? 0;
  return { cert: ranked[0][0], votes: ranked[0][1], runnerUp };
}

export class OcrError extends Error {}

/**
 * A run's allowance for readings, so a runaway scan cannot spend the day's
 * time on labels. Counted per calendar day.
 */
export class OcrBudget {
  private day = "";
  private spent = 0;
  constructor(readonly perDay: number) {}

  private roll(now: Date) {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.spent = 0; }
  }
  left(now = new Date()): number {
    this.roll(now);
    return this.perDay <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, this.perDay - this.spent);
  }
  spend(now = new Date()): void { this.roll(now); this.spent++; }
  spentToday(now = new Date()): number { this.roll(now); return this.spent; }
}

/** Tesseract is not installed, or not on the PATH. */
export class OcrMissing extends OcrError {}

/**
 * Reads the cert number off a slab photograph with the Tesseract binary.
 *
 * Nothing is kept between reads but the check that Tesseract is there, so a
 * reader is cheap to make and safe to use from several places at once.
 */
export class CertReader {
  private checked = false;

  constructor(private readonly binary = process.env.TESSERACT_PATH || "tesseract") {}

  /** Tesseract's version, or a refusal naming how to install it. */
  async version(): Promise<string> {
    try {
      const { stdout, stderr } = await run(this.binary, ["--version"], { timeout: OCR_TIMEOUT_MS });
      return `${stdout}${stderr}`.split("\n")[0].trim();
    } catch {
      throw new OcrMissing(
        `Tesseract is not installed, or not on the PATH as "${this.binary}". These sellers publish no cert number, so it is read off the slab photograph and nothing can be priced without it. ` +
        `Install it with: winget install UB-Mannheim.TesseractOCR (Windows), brew install tesseract (Mac), apt install tesseract-ocr (Linux). Or set TESSERACT_PATH to the binary.`,
      );
    }
  }

  async ready(): Promise<void> {
    if (this.checked) return;
    await this.version();
    this.checked = true;
  }

  /** Nothing is held open, but the shape matches the other sessions. */
  async close(): Promise<void> {}

  /** The photograph, as bytes. Separate so a test can hand over its own. */
  protected async fetchImage(url: string): Promise<Buffer> {
    const res = await fetch(largeImageUrl(url), { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new OcrError(`the photograph would not load (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** One pass of Tesseract over an image file, digits only. */
  private async pass(path: string, mode: string): Promise<string> {
    const { stdout } = await run(
      this.binary,
      [path, "stdout", "-c", "tessedit_char_whitelist=0123456789", "--psm", mode],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: "buffer" },
    );
    return stdout.toString("utf8");
  }

  /**
   * Read one slab's label. `grader` is what the listing's title says, which
   * is how long a cert number to look for.
   */
  async read(url: string, grader: string): Promise<CertReading> {
    await this.ready();
    const image = await this.fetchImage(url);
    const size = jpegSize(image);

    // The whole photograph, then the bands at the top where the label sits,
    // enlarged — the cert is a small run of digits in a tall frame. Each view
    // is written once and read three ways; Tesseract wants a file.
    const views: { png: Buffer; weight: number }[] = [
      { png: await sharp(image).png().toBuffer(), weight: 1 },
    ];
    for (const band of size ? LABEL_BANDS : []) {
      const height = Math.max(1, Math.round(size!.height * band));
      views.push({
        png: await sharp(image)
          .extract({ left: 0, top: 0, width: size!.width, height })
          .resize({ width: size!.width * BAND_SCALE })
          .greyscale()
          .normalise()
          .png()
          .toBuffer(),
        weight: BAND_WEIGHT,
      });
    }

    const texts: { text: string; weight: number }[] = [];
    const stem = join(tmpdir(), `slab-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      for (const [i, view] of views.entries()) {
        const path = `${stem}-${i}.png`;
        await writeFile(path, view.png);
        try {
          for (const mode of PAGE_MODES) {
            texts.push({ text: await this.pass(path, mode), weight: view.weight });
          }
        } finally {
          await unlink(path).catch(() => {});
        }
      }
    } catch (err) {
      throw err instanceof OcrError ? err : new OcrError(`Tesseract failed: ${err instanceof Error ? err.message : err}`);
    }

    const { cert, votes, runnerUp } = voteOnCert(texts, grader);
    if (!cert) {
      const { min, max } = certBounds(grader);
      return { grader, cert: "", grade: null, unreadable: `no ${min}-${max} digit number on the label` };
    }
    if (votes <= runnerUp) {
      return { grader, cert: "", grade: null, unreadable: `two readings of the label tied at ${votes} — not read` };
    }
    return { grader, cert, grade: null, votes };
  }
}
