/**
 * Automatic capture (ADR 0032) through the real WebAssembly module: the scan-sample corpus
 * replayed as 15 fps live frames fires once after the steady time; the same frames out of
 * focus, or with the camera panning, never fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeScanSample, type RgbaFrame, scanSamplePaths } from "@selis/fixtures/scan-samples";
import { beforeAll, describe, expect, it } from "vitest";
import { ScanModule } from "./wasm";

const FRAME_MS = 1000 / 15;
const DETECT_SIDE = 320;

let samples: Array<{ name: string; frame: RgbaFrame }> = [];

beforeAll(async () => {
  samples = await Promise.all(
    scanSamplePaths().map(async (path) => ({ name: path.split(/[\\/]/).pop() ?? path, frame: await decodeScanSample(path, DETECT_SIDE) })),
  );
});

const load = () => ScanModule.load(readFileSync(join(import.meta.dirname, "..", "wasm", "selis_scan_simd.wasm")));

/** `frame` shifted by whole pixels (edges repeated), with a little noise; optionally blurred. */
function videoFrame(frame: RgbaFrame, i: number, dx: number, blur: boolean): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, rgba } = frame;
  let out = new Uint8ClampedArray(rgba.length);
  let seed = (i * 2654435761) | 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x - dx));
      const s = (y * width + sx) * 4;
      const o = (y * width + x) * 4;
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (Math.abs(seed) % 5) - 2;
      out[o] = (rgba[s] ?? 0) + noise;
      out[o + 1] = (rgba[s + 1] ?? 0) + noise;
      out[o + 2] = (rgba[s + 2] ?? 0) + noise;
      out[o + 3] = 255;
    }
  }
  // Out of focus: three box blurs of radius 1 (about a Gaussian of σ 1.4 px).
  if (blur) for (let pass = 0; pass < 3; pass++) out = boxBlur(out, width, height, 1);
  return out;
}

function boxBlur(src: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, r: number): Uint8ClampedArray<ArrayBuffer> {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const pass = (from: Uint8ClampedArray, to: Uint8ClampedArray, horizontal: boolean) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
            sum += from[(yy * width + xx) * 4 + c] ?? 0;
          }
          to[(y * width + x) * 4 + c] = sum / (2 * r + 1);
        }
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

/** Feeds `count` frames; returns the times (ms) the module said to capture. */
function replay(scan: ScanModule, frame: RgbaFrame, count: number, shift: (i: number) => number, blur: boolean): number[] {
  scan.resetAuto();
  const fired: number[] = [];
  for (let i = 0; i < count; i++) {
    const now = i * FRAME_MS;
    if (scan.live(videoFrame(frame, i, shift(i), blur), frame.width, frame.height, now).fire) fired.push(now);
  }
  return fired;
}

describe("automatic capture on the scan-sample corpus", () => {
  it("fires once on every sample held steady", async () => {
    const scan = await load();
    expect(samples.length).toBeGreaterThanOrEqual(9);
    for (const { name, frame } of samples) {
      // A hand holding still: the frame moves by a pixel now and then.
      const fired = replay(scan, frame, 45, (i) => (i % 5 === 0 ? 1 : 0), false);
      expect(fired, name).toHaveLength(1);
      expect(fired[0], name).toBeGreaterThanOrEqual(600);
      expect(fired[0], name).toBeLessThanOrEqual(2000);
    }
  });

  it("reports the steady progress and a hint", async () => {
    const scan = await load();
    const { frame } = samples[0]!;
    scan.resetAuto();
    const first = scan.live(videoFrame(frame, 0, 0, false), frame.width, frame.height, 0);
    expect(first.quad).not.toBeNull();
    expect(first.hint).toBe("holdSteady");
    expect(first.luma).toBeGreaterThan(60);
    expect(first.areaShare).toBeGreaterThan(0.35);
    const later = scan.live(videoFrame(frame, 1, 0, false), frame.width, frame.height, 66);
    const mid = scan.live(videoFrame(frame, 2, 0, false), frame.width, frame.height, 366);
    expect(later.progress).toBeLessThan(mid.progress);
    expect(mid.progress).toBeGreaterThan(0.4);
  });

  it("does not fire on blurred frames", async () => {
    const scan = await load();
    for (const { name, frame } of samples) {
      expect(replay(scan, frame, 45, () => 0, true), name).toEqual([]);
    }
  });

  it("does not fire while the camera pans", async () => {
    const scan = await load();
    for (const { name, frame } of samples) {
      // 3 % of the frame's diagonal per frame, back and forth (more than 2 % of the page's).
      const step = Math.round(Math.hypot(frame.width, frame.height) * 0.03);
      const pan = (i: number) => {
        const phase = i % 8;
        return (phase < 4 ? phase : 8 - phase) * step - 2 * step;
      };
      expect(replay(scan, frame, 45, pan, false), name).toEqual([]);
    }
  });
});
