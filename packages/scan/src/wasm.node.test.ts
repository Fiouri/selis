import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { distance, mapQuad, type Quad } from "./geometry";
import { scene } from "./scene.test-util";
import { ScanModule, simdSupported } from "./wasm";

const wasm = (variant: "simd" | "base") => readFileSync(join(import.meta.dirname, "..", "wasm", `selis_scan_${variant}.wasm`));

const PAGE: Quad = [
  [40, 52],
  [196, 40],
  [214, 286],
  [26, 292],
];

describe.each(["simd", "base"] as const)("the %s module", (variant) => {
  it("finds a page in a live frame", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const found = scan.detect(scene(240, 320, PAGE), 240, 320);
    expect(found).not.toBeNull();
    found!.forEach((p, i) => expect(distance(p, PAGE[i]!)).toBeLessThan(3));
    // The frame buffer is reused for the next frame of that size.
    expect(scan.detect(scene(240, 320, PAGE), 240, 320)).not.toBeNull();
  });

  it("finds nothing on an empty desk", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const offFrame: Quad = [
      [-10, -10],
      [-5, -10],
      [-5, -5],
      [-10, -5],
    ];
    expect(scan.detect(scene(240, 320, offFrame), 240, 320)).toBeNull();
  });

  it("finds and sharpens the page in a full-size photo, then straightens it", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const big = mapQuad(PAGE, ([x, y]) => [x * 5, y * 5]);
    const photo = scene(1200, 1600, big);
    const found = scan.findPage(photo, 1200, 1600);
    expect(found).not.toBeNull();
    found!.forEach((p, i) => expect(distance(p, big[i]!)).toBeLessThan(2.5));
    const page = scan.straighten(photo, 1200, 1600, found!, 400_000, "bw");
    expect(page.width * page.height).toBeLessThanOrEqual(400_000 + 2000);
    expect(page.width / page.height).toBeCloseTo(850 / 1100, 1);
    expect(page.rgba.every((v, i) => i % 4 === 3 || v === 0 || v === 255)).toBe(true);
    // Paper is white; a column through the text crosses black lines.
    expect(page.rgba[(Math.round(page.height * 0.03) * page.width + Math.round(page.width / 2)) * 4]).toBe(255);
    const column = Array.from({ length: page.height }, (_, y) => page.rgba[(y * page.width + Math.round(page.width / 2)) * 4]!);
    expect(column.filter((v) => v === 0).length).toBeGreaterThan(page.height * 0.05);
  });

  it("filters in place", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const rgba = new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i % 4 === 0 ? 200 : i % 4 === 3 ? 255 : 60));
    scan.filter(rgba, 16, 16, "grey");
    expect(rgba[0]).toBe(rgba[1]);
    expect(rgba[1]).toBe(rgba[2]);
  });
});

describe("feature detection", () => {
  it("finds WebAssembly SIMD in Node's V8", () => {
    expect(simdSupported()).toBe(true);
  });
});
