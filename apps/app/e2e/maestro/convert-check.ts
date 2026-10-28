/**
 * Checks a PDF convert-docx.yaml made on the device (pulled by convert.sh):
 * `node convert-check.ts <pdf> <corpus name>` — qpdf --check passes; pdf.js reads ≥ 98 % of the
 * source document's words and LibreOffice's page count ± 1 (ADR 0035 gate). Exit 1 with reasons.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CONVERT_FIXTURES, wordsOf } from "@selis/fixtures/convert";
import { LIBREOFFICE_PAGES } from "@selis/fixtures/convert-reference";
import { pdfjsPageCount, pdfjsText } from "@selis/fixtures/oracle";

const [path, name] = process.argv.slice(2);
const fixture = CONVERT_FIXTURES.find((f) => f.name === name);
if (!path || !fixture) {
  console.error("usage: node convert-check.ts <pdf> <corpus name>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const failures: string[] = [];
const check = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
if (check.status !== 0) failures.push(`qpdf --check exited ${String(check.status)}: ${`${check.stdout}${check.stderr}`.trim()}`);
const pages = await pdfjsPageCount(bytes);
const reference = LIBREOFFICE_PAGES[fixture.name] ?? -1;
if (Math.abs(pages - reference) > 1) failures.push(`${String(pages)} pages, LibreOffice ${String(reference)}`);
const pool = new Map<string, number>();
for (const w of wordsOf((await pdfjsText(bytes)).pages.join(" "))) pool.set(w.toLowerCase(), (pool.get(w.toLowerCase()) ?? 0) + 1);
let found = 0;
for (const w of fixture.words) {
  const n = pool.get(w.toLowerCase()) ?? 0;
  if (n > 0) {
    found++;
    pool.set(w.toLowerCase(), n - 1);
  }
}
const share = found / fixture.words.length;
if (share < 0.98) failures.push(`only ${(share * 100).toFixed(1)} % of the words`);
console.log(`convert: ${fixture.file} → ${String(pages)} pages (LibreOffice ${String(reference)}), ${(share * 100).toFixed(1)} % of ${String(fixture.words.length)} words`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
