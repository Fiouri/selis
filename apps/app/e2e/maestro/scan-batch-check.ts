/**
 * Checks the PDF scan-batch.yaml made (pulled by scan.sh): `node scan-batch-check.ts <pdf>
 * <expected>` — `expected` lists the pages in order: a number k is the photo of page k (k
 * black bars, make-scan-pages.ts), "kr" the same turned a quarter (landscape, bars upright),
 * "x" a page from the camera (not checked beyond being there). Bars are counted as dark runs
 * along the page's middle line in a pdf.js render. Exit 1 with the reasons on stderr.
 */
import { readFileSync } from "node:fs";
import { pdfjsPageCount, pdfjsRender } from "@selis/fixtures/oracle";

const [path, expectedArg] = process.argv.slice(2);
if (!path || !expectedArg) {
  console.error("usage: node scan-batch-check.ts <pdf> <expected, e.g. 3,x,2,5r>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const expected = expectedArg.split(",");
const failures: string[] = [];
const pages = await pdfjsPageCount(bytes);
if (pages !== expected.length) failures.push(`${String(pages)} pages, expected ${String(expected.length)}`);

/** Dark runs (luma < 100, at least 3 px) along a line through the middle of the page. */
function bars(img: { width: number; height: number; data: Uint8ClampedArray }, across: "rows" | "columns"): number {
  const length = across === "rows" ? img.height : img.width;
  let runs = 0;
  let run = 0;
  for (let i = 0; i < length; i++) {
    const [x, y] = across === "rows" ? [Math.round(img.width / 2), i] : [i, Math.round(img.height / 2)];
    const o = (y * img.width + x) * 4;
    const luma = 0.299 * (img.data[o] ?? 0) + 0.587 * (img.data[o + 1] ?? 0) + 0.114 * (img.data[o + 2] ?? 0);
    if (luma < 100) run++;
    else {
      if (run >= 3) runs++;
      run = 0;
    }
  }
  return run >= 3 ? runs + 1 : runs;
}

const found: string[] = [];
for (let i = 0; i < Math.min(pages, expected.length); i++) {
  const want = expected[i] ?? "";
  const img = await pdfjsRender(bytes, i, 0.75);
  const landscape = img.width > img.height;
  if (want === "x") {
    found.push("x");
    continue;
  }
  const turned = want.endsWith("r");
  const k = Number(turned ? want.slice(0, -1) : want);
  if (landscape !== turned) failures.push(`page ${String(i + 1)}: ${landscape ? "landscape" : "portrait"}, expected ${turned ? "landscape" : "portrait"}`);
  const n = bars(img, landscape ? "columns" : "rows");
  found.push(`${String(n)}${landscape ? "r" : ""}`);
  if (n !== k) failures.push(`page ${String(i + 1)}: ${String(n)} bars, expected ${String(k)} (photo of page ${String(k)})`);
}
console.log(`scan-batch: pages ${found.join(",")}, expected ${expected.join(",")}`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
