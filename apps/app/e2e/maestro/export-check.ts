/**
 * Checks the Word files export-word.yaml made (pulled by export.sh):
 * `node export-check.ts <a.docx> <b.docx>` (either order; the export of erase.pdf is the one with
 * its words) — erase.docx carries every word
 * pdf.js reads from erase.pdf, in the same order, and its picture (word/media); the scan's
 * export ≥ 90 % of the words the scanned pages show (OCR). Exit 1 with the reasons.
 */
import { readFileSync } from "node:fs";
import { FIXTURES, scannedWords } from "@selis/fixtures";
import { pdfjsText } from "@selis/fixtures/oracle";
import JSZip from "jszip";

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.error("usage: node export-check.ts <a.docx> <b.docx>");
  process.exit(2);
}
const words = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");

/** Letters and digits only: word order without caring where pdf.js puts the spaces ("two.Form"). */
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

/** The text of each page (split at the page breaks) and the pictures of a .docx. */
async function docx(path: string): Promise<{ pages: string[]; text: string; media: string[] }> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const pages: string[] = [];
  let current = "";
  for (const [p] of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    current += ` ${[...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? "").join("")}`;
    if (p.includes('<w:br w:type="page"/>')) {
      pages.push(current);
      current = "";
    }
  }
  pages.push(current);
  return { pages, text: pages.join(" "), media: Object.keys(zip.files).filter((f) => f.startsWith("word/media/")) };
}

const failures: string[] = [];
const erase = FIXTURES.find((f) => f.name === "erase");
if (!erase) throw new Error("no erase fixture");
const source = (await pdfjsText(erase.build())).pages;
const [a, b] = [await docx(first), await docx(second)];
const [exported, scan] = a.text.includes("Wolfram") ? [a, b] : [b, a];
if (exported.pages.length !== source.length) failures.push(`erase.docx: ${String(exported.pages.length)} pages, erase.pdf ${String(source.length)}`);
source.forEach((text, i) => {
  // Page 3 is turned (/Rotate 90): read as shown, while pdf.js keeps the content order.
  const same =
    i === 2 ? words(exported.pages[i] ?? "").sort().join(" ") === words(text).sort().join(" ") : letters(exported.pages[i] ?? "") === letters(text);
  if (!same) failures.push(`erase.docx page ${String(i + 1)}: the words differ from erase.pdf (or their order)`);
});
if (exported.media.length === 0) failures.push("erase.docx: no picture");

const pool = new Map<string, number>();
for (const w of words(scan.text)) pool.set(w, (pool.get(w) ?? 0) + 1);
const expected = [0, 1].flatMap((page) => scannedWords("english", page).flatMap(words));
let found = 0;
for (const w of expected) {
  const n = pool.get(w) ?? 0;
  if (n > 0) {
    found++;
    pool.set(w, n - 1);
  }
}
const share = found / expected.length;
if (share < 0.9) failures.push(`scanned-english.docx: only ${(share * 100).toFixed(1)} % of the scanned words`);
console.log(
  `export: erase.docx ${String(words(source.join(" ")).length)} words in order, ${String(exported.media.length)} picture(s); scanned-english.docx ${(share * 100).toFixed(1)} % of ${String(expected.length)} words`,
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
