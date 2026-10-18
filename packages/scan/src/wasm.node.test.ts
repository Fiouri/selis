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
    const found = scan.live(scene(240, 320, PAGE), 240, 320, 0).quad;
    expect(found).not.toBeNull();
    found!.forEach((p, i) => expect(distance(p, PAGE[i]!)).toBeLessThan(3));
    // The frame buffer is reused for the next frame of that size.
    expect(scan.live(scene(240, 320, PAGE), 240, 320, 66).quad).not.toBeNull();
  });

  it("finds nothing on an empty desk", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const offFrame: Quad = [
      [-10, -10],
      [-5, -10],
      [-5, -5],
      [-10, -5],
    ];
    const frame = scan.live(scene(240, 320, offFrame), 240, 320, 0);
    expect(frame.quad).toBeNull();
    expect(frame.fire).toBe(false);
    expect(frame.hint).toBe("findPage");
  });

  it("finds and sharpens the page in a full-size photo, then straightens it", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const big = mapQuad(PAGE, ([x, y]) => [x * 5, y * 5]);
    const photo = scene(1200, 1600, big);
    const found = scan.findPage(photo, 1200, 1600);
    expect(found).not.toBeNull();
    found!.forEach((p, i) => expect(distance(p, big[i]!)).toBeLessThan(2.5));
    const page = scan.render(photo, 1200, 1600, { quad: found!, filter: "bw", strokes: [], turns: 0 }, 400_000);
    expect(page.width * page.height).toBeLessThanOrEqual(400_000 + 2000);
    expect(page.width / page.height).toBeCloseTo(850 / 1100, 1);
    expect(page.rgba.every((v, i) => i % 4 === 3 || v === 0 || v === 255)).toBe(true);
    // Paper is white; a column through the text crosses black lines.
    expect(page.rgba[(Math.round(page.height * 0.03) * page.width + Math.round(page.width / 2)) * 4]).toBe(255);
    const column = Array.from({ length: page.height }, (_, y) => page.rgba[(y * page.width + Math.round(page.width / 2)) * 4]!);
    expect(column.filter((v) => v === 0).length).toBeGreaterThan(page.height * 0.05);
  });

  it("renders a page with Enhance, a touch-up and a quarter turn", async () => {
    const scan = await ScanModule.load(wasm(variant));
    const big = mapQuad(PAGE, ([x, y]) => [x * 5, y * 5]);
    const photo = scene(1200, 1600, big);
    const plain = scan.render(photo, 1200, 1600, { quad: big, filter: "enhance", strokes: [], turns: 0 }, 400_000);
    // Colour kept (not grey), paper white.
    expect(plain.rgba[(Math.round(plain.height * 0.03) * plain.width + Math.round(plain.width / 2)) * 4]).toBeGreaterThan(240);
    const darkRow = (p: { width: number; height: number; rgba: Uint8ClampedArray }) =>
      Array.from({ length: p.height }, (_, y) => p.rgba[(y * p.width + Math.round(p.width / 2)) * 4]!).findIndex((v) => v < 100);
    const row = darkRow(plain);
    expect(row).toBeGreaterThan(0);
    const y = row / plain.height;
    const wiped = scan.render(
      photo,
      1200,
      1600,
      { quad: big, filter: "enhance", strokes: [{ radius: 0.03, points: [[0.02, y], [0.98, y]] }], turns: 1 },
      400_000,
    );
    expect([wiped.width, wiped.height]).toEqual([plain.height, plain.width]);
    // Turned clockwise: the old row y is now the column (1 - y) from the left; the line is gone.
    const x = Math.round((1 - y) * wiped.width);
    const column = Array.from({ length: wiped.height }, (_, yy) => wiped.rgba[(yy * wiped.width + x) * 4]!);
    expect(column.slice(Math.round(wiped.height * 0.2), Math.round(wiped.height * 0.8)).every((v) => v > 150)).toBe(true);
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
