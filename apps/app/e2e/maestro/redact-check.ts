/**
 * Checks the version redact.yaml wrote on the device, with pdf.js (not PDFium,
 * which wrote it): `node redact-check.ts <version.pdf> <original greek.pdf>`.
 *
 * - the two redacted lines are not extracted, and their glyph codes are not
 *   anywhere in the file (raw or inflated); the rest of the text is kept;
 * - no /Redact mark is left; the whiteout's text stamp is the only annotation;
 * - the file is one fresh revision (no older one behind it);
 * - each box sits on its line: it covers that line's glyphs (as pdf.js reads
 *   the original) and touches neither neighbour. The swipes are in device
 *   pixels, so the exact box is not known here; the line it lands on is.
 *
 * Exit code 1 with the reasons on stderr when a check fails.
 */
import { readFileSync } from "node:fs";
import { GREEK_TEXT, greekGlyphHex } from "@selis/fixtures";
import {
  type Box,
  findInFile,
  intersects,
  isDark,
  pdfjsAnnotations,
  pdfjsRender,
  pdfjsText,
  solidBox,
  type TextItem,
} from "@selis/fixtures/oracle";

const [versionPath, originalPath] = process.argv.slice(2);
if (!versionPath || !originalPath) {
  console.error("usage: node redact-check.ts <version.pdf> <original greek.pdf>");
  process.exit(2);
}
const version = new Uint8Array(readFileSync(versionPath));
const original = new Uint8Array(readFileSync(originalPath));
const failures: string[] = [];
const check = (ok: boolean, why: string) => {
  if (!ok) failures.push(why);
};

function lineBox(items: readonly TextItem[], text: string): Box {
  const first = items.find((i) => i.page === 0 && i.str.trim() !== "" && text.startsWith(i.str.trim()));
  if (!first) throw new Error(`line not found in the original: ${text}`);
  const row = items.filter((i) => i.page === 0 && Math.abs(i.y - first.y) < 1);
  const x0 = Math.min(...row.map((i) => i.x));
  const y0 = Math.min(...row.map((i) => i.y));
  return { x: x0, y: y0, width: Math.max(...row.map((i) => i.x + i.width)) - x0, height: Math.max(...row.map((i) => i.y + i.height)) - y0 };
}

/**
 * A line's ink, from its item box (pdf.js: one font size up from the baseline):
 * cap height (≈ 0.7 em above the baseline) down to the descenders (≈ 0.25 em below).
 */
const ink = (line: Box): Box => ({ x: line.x, y: line.y + 0.3 * line.height, width: line.width, height: 0.95 * line.height });

/** The box lands on `line`: covers its capitals down to the baseline, and meets neither neighbour's ink. */
function onLine(name: string, box: Box | null, line: Box, neighbours: readonly Box[]): void {
  if (!box) {
    failures.push(`${name}: no box found`);
    return;
  }
  const baseline = line.y + line.height;
  const where = `${name} box y ${box.y.toFixed(1)}–${(box.y + box.height).toFixed(1)}, line caps–baseline ${ink(line).y.toFixed(1)}–${baseline.toFixed(1)}`;
  check(box.y <= ink(line).y && box.y + box.height >= baseline, `${where}: does not cover its line`);
  for (const n of neighbours) check(!intersects(box, ink(n)), `${where}: meets the line at y ${ink(n).y.toFixed(1)}`);
}

const { items } = await pdfjsText(original);
const lines = GREEK_TEXT.slice(0, 4).map((t) => lineBox(items, t));
const [line1, line2, line3, line4] = lines as [Box, Box, Box, Box];

const text = (await pdfjsText(version)).pages.join("\n");
const gone = ["σύννεφο", "ψυχοφθόρα", "βδελυγμία"];
for (const w of gone) check(!text.includes(w), `"${w}" is still extracted`);
for (const w of ["Η Σελίς κρατά", "Αριθμοί", "Δεύτερη σελίδα"]) check(text.includes(w), `"${w}" was lost`);
const leaks = findInFile(version, gone, gone.flatMap((w) => greekGlyphHex(w)));
check(leaks.length === 0, `left in the file: ${leaks.join(", ")}`);

// Written anew (ADR 0009): one cross-reference section, no older revision behind it.
const raw = Buffer.from(version).toString("latin1");
check(raw.split("startxref").length - 1 === 1, "the file has more than one revision");
check(!raw.slice(raw.lastIndexOf("trailer")).includes("/Prev"), "the trailer points at an older revision");

const annots = await pdfjsAnnotations(version);
check(!annots.some((a) => a.subtype === "Redact"), "a /Redact mark is left");
const stamps = annots.filter((a) => a.subtype === "Stamp");
check(stamps.length === 1 && stamps[0]?.page === 0 && stamps[0].contents === "Fixed line", `stamps: ${JSON.stringify(stamps)}`);
onLine("whiteout", stamps[0]?.rect ?? null, line3, [line2, line4]);

// The text tool's box over line 2: a solid dark area between lines 1 and 3.
const page = await pdfjsRender(version, 0, 2, false);
const between: Box = { x: 0, y: line1.y + line1.height, width: 595, height: line3.y - (line1.y + line1.height) };
onLine("black", solidBox(page, between, isDark), line2, [line1, line3]);

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("pdf.js: redacted lines not extracted and not in the file; boxes on their lines; only the whiteout stamp left");
