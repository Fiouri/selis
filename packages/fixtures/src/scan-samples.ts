/**
 * The scan-sample corpus (ADR 0016, 0032) for Node tests: the stored photos
 * (`packages/fixtures/scan`) and the store's sample photo (`docs/store/scan-sample`), decoded
 * by @napi-rs/canvas to RGBA at a chosen size (e.g. a 320 px live-detection frame).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const root = join(import.meta.dirname, "..", "..", "..");

/** Paths of every photo in the corpus. */
export function scanSamplePaths(): string[] {
  const dir = join(root, "packages", "fixtures", "scan");
  const list = JSON.parse(readFileSync(join(dir, "samples.json"), "utf8")) as Array<{ file: string }>;
  const store = join(root, "docs", "store", "scan-sample");
  return [...list.map((s) => join(dir, s.file)), join(store, "en.jpg"), join(store, "el.jpg")];
}

export type RgbaFrame = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };

/** The photo at `path`, scaled so its long side is `longSide` px (bilinear). */
export async function decodeScanSample(path: string, longSide: number): Promise<RgbaFrame> {
  const image = await loadImage(readFileSync(path));
  const scale = longSide / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { width, height, rgba: new Uint8ClampedArray(data) };
}
