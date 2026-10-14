/**
 * Checks the PDF images.yaml made from the pushed photos (pulled by images.sh):
 * `node images-check.ts <pdf> <pages>` — qpdf --check passes, pdf.js opens `pages` pages, and no
 * photo metadata (EXIF, GPS, XMP, IPTC, comments, the planted strings) is anywhere in the file,
 * raw or inflated. Exit 1 with the reasons on stderr.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PHOTO_SECRETS } from "@selis/fixtures";
import { findInFile, pdfjsPageCount } from "@selis/fixtures/oracle";

const [path, pagesArg] = process.argv.slice(2);
if (!path || !pagesArg) {
  console.error("usage: node images-check.ts <pdf> <pages>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const failures: string[] = [];
const check = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
if (check.status !== 0) failures.push(`qpdf --check exited ${String(check.status)}: ${`${check.stdout}${check.stderr}`.trim()}`);
const pages = await pdfjsPageCount(bytes);
if (pages !== Number(pagesArg)) failures.push(`pdf.js opened ${String(pages)} pages, expected ${pagesArg}`);
const leaks = findInFile(bytes, [...PHOTO_SECRETS, "Exif", "GPS", "ns.adobe.com/xap", "Photoshop 3.0"]);
if (leaks.length > 0) failures.push(`metadata in the PDF: ${leaks.join(", ")}`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`images: ${String(pages)} pages, ${(bytes.length / 1e6).toFixed(1)} MB, qpdf ok, no photo metadata`);
