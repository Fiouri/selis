/**
 * Checks the PDF scan-idcard.yaml made: `node scan-idcard-check.ts <pdf>` — one A4 page
 * (210 × 297 mm ± 1) holding two images, each 85.6 × 54 mm ± 1 mm (either way round),
 * centred across the page, one above the other (ADR 0032); as pdf.js reads the drawing. Exit 1
 * with the reasons on stderr.
 */
import { readFileSync } from "node:fs";
import { pdfjsImagePlacements, pdfjsPageCount } from "@selis/fixtures/oracle";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scan-idcard-check.ts <pdf>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const failures: string[] = [];
const mm = (pt: number) => (pt * 25.4) / 72;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const pages = await pdfjsPageCount(bytes);
if (pages !== 1) failures.push(`${String(pages)} pages, expected 1`);
const page = await pdfjsImagePlacements(bytes, 0);
if (!near(mm(page.width), 210) || !near(mm(page.height), 297)) failures.push(`page ${mm(page.width).toFixed(1)} × ${mm(page.height).toFixed(1)} mm, expected A4`);
if (page.images.length !== 2) failures.push(`${String(page.images.length)} images, expected 2`);
const sides = page.images.map((b) => ({ ...b, long: mm(Math.max(b.width, b.height)), short: mm(Math.min(b.width, b.height)) }));
for (const [i, side] of sides.entries()) {
  if (!near(side.long, 85.6) || !near(side.short, 54)) failures.push(`side ${String(i + 1)}: ${side.long.toFixed(2)} × ${side.short.toFixed(2)} mm, expected 85.6 × 54`);
  if (!near(mm(side.x + side.width / 2), mm(page.width / 2))) failures.push(`side ${String(i + 1)} is not centred across the page`);
}
const [a, b] = sides;
if (a && b && !(a.y >= b.y + b.height || b.y >= a.y + a.height)) failures.push("the sides overlap instead of one above the other");
console.log(`scan-idcard: ${String(pages)} page, ${mm(page.width).toFixed(1)} × ${mm(page.height).toFixed(1)} mm, sides ${sides.map((s) => `${s.long.toFixed(2)} × ${s.short.toFixed(2)} mm`).join(", ")}`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
