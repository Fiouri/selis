/**
 * `node make-scan-pages.ts <dir> <count>`: photos of numbered pages for scan-batch.yaml (ADR
 * 0032): page k is a white sheet in slight perspective on a dark desk with k thick black bars
 * across it (scan-batch-check.ts counts them in the PDF to check the page order). 1200 × 1600
 * JPEGs, no metadata.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const [dir, countArg] = process.argv.slice(2);
if (!dir || !countArg) throw new Error("usage: make-scan-pages.ts <dir> <count>");
mkdirSync(dir, { recursive: true });

const W = 1200;
const H = 1600;
/** The sheet's corners: top-left, top-right, bottom-right, bottom-left. */
const CORNERS = [
  [190, 170],
  [1010, 210],
  [1060, 1430],
  [140, 1400],
] as const;

type Pt = readonly [number, number];
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** A point of the sheet at (u, v) in 0..1 (bilinear between the corners). */
const at = (u: number, v: number): Pt => lerp(lerp(CORNERS[0], CORNERS[1], u), lerp(CORNERS[3], CORNERS[2], u), v);

export function pageBars(index: number): { from: number; to: number }[] {
  // Bars of 3 % of the sheet's height with 3 % gaps, from 15 % down.
  return Array.from({ length: index }, (_, i) => ({ from: 0.15 + i * 0.06, to: 0.18 + i * 0.06 }));
}

for (let k = 1; k <= Number(countArg); k++) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // Desk: dark wood-like stripes.
  for (let y = 0; y < H; y += 8) {
    const v = 58 + ((y / 8) % 5) * 4;
    ctx.fillStyle = `rgb(${String(v + 18)}, ${String(v + 6)}, ${String(v - 6)})`;
    ctx.fillRect(0, y, W, 8);
  }
  const quad = (points: Pt[], colour: string) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  quad([...CORNERS], "#f4f2ec");
  for (const bar of pageBars(k)) quad([at(0.12, bar.from), at(0.88, bar.from), at(0.88, bar.to), at(0.12, bar.to)], "#151515");
  writeFileSync(join(dir, `selis-scan-page-${String(k).padStart(2, "0")}.jpg`), canvas.toBuffer("image/jpeg", 90));
}
console.log(`made ${countArg} page photos in ${dir}`);
