/**
 * Checks the versions erase.yaml wrote on the device, with pdf.js (not PDFium,
 * which wrote them): `node erase-check.ts <v3.pdf> <v2.pdf> <original erase.pdf>`.
 *
 * - v2 (the rectangle) and v3 (the deleted diagonal) no longer have the secret
 *   line, neither as text nor in the bytes; the neighbouring lines are kept;
 * - the area is white where the line was; the diagonal is red in v2 and gone in
 *   v3, while the blue rectangle beside it is still blue;
 * - page 2, which shares the image and the form with page 1, renders exactly as
 *   in the original;
 * - both pass qpdf --check.
 *
 * Exit code 1 with the reasons on stderr when a check fails.
 */
import { readFileSync } from "node:fs";
import { ERASE_TEXT } from "@selis/fixtures";
import { findInFile, pdfjsRender, pdfjsText, qpdfCheck, type Raster } from "@selis/fixtures/oracle";

const [v3Path, v2Path, originalPath] = process.argv.slice(2);
if (!v3Path || !v2Path || !originalPath) {
  console.error("usage: node erase-check.ts <v3.pdf> <v2.pdf> <original erase.pdf>");
  process.exit(2);
}
const v3 = new Uint8Array(readFileSync(v3Path));
const v2 = new Uint8Array(readFileSync(v2Path));
const original = new Uint8Array(readFileSync(originalPath));
const failures: string[] = [];
const check = (ok: boolean, why: string) => {
  if (!ok) failures.push(why);
};

const H = 841.89;
const rgb = (img: Raster, x: number, y: number) => {
  const o = (Math.round(y * img.scale) * img.width + Math.round(x * img.scale)) * 4;
  return [img.data[o] ?? 0, img.data[o + 1] ?? 0, img.data[o + 2] ?? 0];
};
const near = (a: number[], b: number[], tol = 12) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

for (const [name, bytes] of [
  ["v2", v2],
  ["v3", v3],
] as const) {
  const text = (await pdfjsText(bytes)).pages[0] ?? "";
  check(!text.includes("Wolfram") && !text.includes("Quartz"), `${name}: the secret line is still extracted`);
  for (const kept of [ERASE_TEXT.title, ERASE_TEXT.above, ERASE_TEXT.below]) check(text.includes(kept), `${name}: lost "${kept}"`);
  check(findInFile(bytes, ["Wolfram", "Quartz"]).length === 0, `${name}: the secret words are still in the bytes`);
  try {
    qpdfCheck(bytes);
  } catch (err) {
    failures.push(`${name}: qpdf --check: ${String(err)}`);
  }
}

const before = await pdfjsRender(original, 0, 2, false);
const after2 = await pdfjsRender(v2, 0, 2, false);
const after3 = await pdfjsRender(v3, 0, 2, false);
// The middle of the secret line (pdf.js draws its standard font as boxes, so sample the boxes' row).
check(near(rgb(after2, 120, H - 703), [255, 255, 255], 2), "v2: the erased line's area is not white");
// The diagonal's middle point (420, 560 in PDF space): red, then gone.
const diagonal = [420, H - 560] as const;
check(near(rgb(after2, ...diagonal), [204, 26, 26], 40), `v2: the diagonal is not there (${rgb(after2, ...diagonal).join(",")})`);
check(near(rgb(after3, ...diagonal), [255, 255, 255], 2), `v3: the diagonal is still drawn (${rgb(after3, ...diagonal).join(",")})`);
check(near(rgb(after3, 100, H - 560), rgb(before, 100, H - 560), 2), "v3: the blue rectangle changed");

const page2Before = await pdfjsRender(original, 1, 1, false);
const page2After = await pdfjsRender(v3, 1, 1, false);
let changed = 0;
for (let i = 0; i < page2Before.data.length; i++) if (page2Before.data[i] !== page2After.data[i]) changed++;
check(changed === 0, `page 2 (shared image and form) changed in ${changed} channel values`);

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("erase-check: line and diagonal gone (text, bytes, pixels), neighbours kept, page 2 identical, qpdf ok");
