/**
 * The scan WebAssembly module (`crates/selis-scan`, `src/wasm.rs`): a typed wrapper over its
 * C ABI. Two builds ship (scripts/build-scan-wasm.ts): with WebAssembly SIMD and without (iOS
 * before 16.4); `simdSupported` picks one.
 *
 * The module imports three wasm-bindgen functions that imageproc's random-number dependency
 * links in and nothing calls (the module has no start function, and the scan code never asks
 * for random numbers). They are bound to functions that throw, so a call could not go
 * unnoticed.
 */
import type { Point, Quad } from "./geometry";

/** Filter codes of the module, by index (`Filter::from_code`). */
export const FILTERS = ["original", "grey", "bw", "enhance"] as const;
export type ScanFilter = (typeof FILTERS)[number];

/** A touch-up eraser stroke: points in 0–1 of the straight page (before rotation), radius as a share of its long side. */
export type Stroke = { readonly radius: number; readonly points: readonly Point[] };

/** How a page is made from its photo (Scan 2.0, ADR 0032). */
export type PageEdits = {
  readonly quad: Quad;
  readonly filter: ScanFilter;
  readonly strokes: readonly Stroke[];
  /** Clockwise quarter turns, 0–3. */
  readonly turns: number;
};

/** Hint codes of `live::Hint`. */
export const HINTS = ["none", "findPage", "moreLight", "moveCloser", "holdSteady"] as const;
export type LiveHint = (typeof HINTS)[number];

/** What one live frame says: the outline and the automatic-capture verdict. */
export type LiveFrame = {
  readonly quad: Quad | null;
  /** Variance of the Laplacian over the outline's box. */
  readonly sharpness: number;
  /** Mean luma, 0–255. */
  readonly luma: number;
  /** The outline's share of the frame. */
  readonly areaShare: number;
  /** Steady progress towards an automatic capture, 0–1. */
  readonly progress: number;
  /** Capture now. */
  readonly fire: boolean;
  readonly hint: LiveHint;
  /** The outline's edge support, 0–1: the share of its weakest side on edge pixels. */
  readonly confidence: number;
};

/** Edge support above which an automatic capture in a batch is kept without Adjust (`live::AUTO_KEEP_SUPPORT`). */
export const AUTO_KEEP_CONFIDENCE = 0.85;

export type StraightPage = { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray<ArrayBuffer> };

type Exports = {
  memory: WebAssembly.Memory;
  scan_alloc: (len: number) => number;
  scan_free: (ptr: number, len: number) => void;
  scan_live: (rgba: number, width: number, height: number, nowMs: number, out: number) => number;
  scan_auto_reset: () => void;
  scan_auto_resume: () => void;
  scan_find_page: (rgba: number, width: number, height: number, out: number) => number;
  scan_filter: (rgba: number, width: number, height: number, filter: number) => number;
  scan_render: (
    rgba: number,
    width: number,
    height: number,
    quad: number,
    maxPixels: number,
    filter: number,
    edits: number,
    editsLen: number,
    turns: number,
    outSize: number,
  ) => number;
};

const trap = (name: string) => () => {
  throw new Error(`selis-scan: unexpected call to ${name}`);
};

const IMPORTS: WebAssembly.Imports = {
  __wbindgen_placeholder__: { __wbindgen_describe: trap("__wbindgen_describe") },
  __wbindgen_externref_xform__: {
    __wbindgen_externref_table_grow: trap("__wbindgen_externref_table_grow"),
    __wbindgen_externref_table_set_null: trap("__wbindgen_externref_table_set_null"),
  },
};

/** A minimal module using one SIMD instruction (i8x16.splat): valid only where SIMD is. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function simdSupported(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** `f32`s `scan_live` writes (`LIVE_OUT`). */
const LIVE_OUT = 15;

/** The strokes as the module reads them: count, then per stroke radius, point count, points. */
export function encodeStrokes(strokes: readonly Stroke[]): Float32Array {
  const length = 1 + strokes.reduce((n, s) => n + 2 + s.points.length * 2, 0);
  const out = new Float32Array(length);
  out[0] = strokes.length;
  let i = 1;
  for (const stroke of strokes) {
    out[i++] = stroke.radius;
    out[i++] = stroke.points.length;
    for (const [x, y] of stroke.points) {
      out[i++] = x;
      out[i++] = y;
    }
  }
  return out;
}

export class ScanModule {
  private readonly x: Exports;
  /** A reused buffer for live frames (they all have the same size). */
  private frame = { ptr: 0, len: 0 };
  /** `LIVE_OUT` f32 (a live frame: quad, measures, verdict) + 2 u32 (a size). */
  private readonly scratch: number;

  private constructor(exports: Exports) {
    this.x = exports;
    this.scratch = this.x.scan_alloc((LIVE_OUT + 2) * 4);
    if (!this.scratch) throw new Error("selis-scan: out of memory");
  }

  static async load(source: BufferSource | Response | Promise<Response>): Promise<ScanModule> {
    const response = source instanceof Response || source instanceof Promise ? await source : null;
    const instance = response
      ? (await WebAssembly.instantiate(await response.arrayBuffer(), IMPORTS)).instance
      : (await WebAssembly.instantiate(source as BufferSource, IMPORTS)).instance;
    return new ScanModule(instance.exports as unknown as Exports);
  }

  private bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, ptr, len);
  }

  private readQuad(): Quad {
    const f = new Float32Array(this.x.memory.buffer, this.scratch, 8);
    const v = (i: number) => f[i] ?? 0;
    return [
      [v(0), v(1)],
      [v(2), v(3)],
      [v(4), v(5)],
      [v(6), v(7)],
    ];
  }

  private writeQuad(quad: Quad): void {
    const f = new Float32Array(this.x.memory.buffer, this.scratch, 8);
    quad.forEach(([x, y], i) => {
      f[i * 2] = x;
      f[i * 2 + 1] = y;
    });
  }

  private alloc(len: number): number {
    const ptr = this.x.scan_alloc(len);
    if (!ptr) throw new Error("selis-scan: out of memory");
    return ptr;
  }

  /**
   * One live frame (about 320 px on the long side) taken at `nowMs`: the page outline in frame
   * pixels and the automatic-capture verdict. The frame is copied into a buffer reused for
   * every frame of that size.
   */
  live(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, nowMs: number): LiveFrame {
    if (this.frame.len !== rgba.length) {
      if (this.frame.ptr) this.x.scan_free(this.frame.ptr, this.frame.len);
      this.frame = { ptr: this.alloc(rgba.length), len: rgba.length };
    }
    this.bytes(this.frame.ptr, rgba.length).set(rgba);
    const found = this.x.scan_live(this.frame.ptr, width, height, nowMs, this.scratch) === 1;
    const f = new Float32Array(this.x.memory.buffer, this.scratch, LIVE_OUT);
    return {
      quad: found ? this.readQuad() : null,
      sharpness: f[8] ?? 0,
      luma: f[9] ?? 0,
      areaShare: f[10] ?? 0,
      progress: f[11] ?? 0,
      fire: f[12] === 1,
      hint: HINTS[f[13] ?? 0] ?? "none",
      confidence: f[14] ?? 0,
    };
  }

  /** Forgets the automatic-capture state (camera reopened, Retake, Auto switched on). */
  resetAuto(): void {
    this.x.scan_auto_reset();
  }

  /** The page in a full-size photo, sharpened at full size; in photo pixels. */
  findPage(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Quad | null {
    const ptr = this.alloc(rgba.length);
    try {
      this.bytes(ptr, rgba.length).set(rgba);
      return this.x.scan_find_page(ptr, width, height, this.scratch) ? this.readQuad() : null;
    } finally {
      this.x.scan_free(ptr, rgba.length);
    }
  }

  /** Applies `filter` to `rgba` in place. */
  filter(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, filter: ScanFilter): void {
    if (filter === "original") return;
    const ptr = this.alloc(rgba.length);
    try {
      const view = this.bytes(ptr, rgba.length);
      view.set(rgba);
      if (!this.x.scan_filter(ptr, width, height, FILTERS.indexOf(filter))) throw new Error("selis-scan: filter failed");
      rgba.set(this.bytes(ptr, rgba.length));
    } finally {
      this.x.scan_free(ptr, rgba.length);
    }
  }

  /**
   * Makes a page from a full-size photo: straightens `edits.quad` into an image of at most
   * `maxPixels`, then applies the filter, the touch-up strokes and the rotation.
   */
  render(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, edits: PageEdits, maxPixels: number): StraightPage {
    const ptr = this.alloc(rgba.length);
    this.bytes(ptr, rgba.length).set(rgba);
    this.writeQuad(edits.quad);
    const strokes = edits.strokes.length > 0 ? encodeStrokes(edits.strokes) : null;
    const strokesPtr = strokes ? this.alloc(strokes.byteLength) : 0;
    try {
      if (strokes) new Float32Array(this.x.memory.buffer, strokesPtr, strokes.length).set(strokes);
      // The module takes (and frees) the photo buffer.
      const out = this.x.scan_render(
        ptr,
        width,
        height,
        this.scratch,
        Math.floor(maxPixels),
        FILTERS.indexOf(edits.filter),
        strokesPtr,
        strokes?.length ?? 0,
        ((edits.turns % 4) + 4) % 4,
        this.scratch + LIVE_OUT * 4,
      );
      if (!out) throw new Error("selis-scan: rendering the page failed");
      const size = new Uint32Array(this.x.memory.buffer, this.scratch + LIVE_OUT * 4, 2);
      const w = size[0] ?? 0;
      const h = size[1] ?? 0;
      const len = w * h * 4;
      const copy = new Uint8ClampedArray(len);
      copy.set(this.bytes(out, len));
      this.x.scan_free(out, len);
      return { width: w, height: h, rgba: copy };
    } finally {
      if (strokes) this.x.scan_free(strokesPtr, strokes.byteLength);
    }
  }

  /** The camera starts again after a capture: the captured page is not taken again, and the camera's first empty frames do not count. */
  resumeAuto(): void {
    this.x.scan_auto_resume();
  }

  /** Bytes of linear memory (it grows to the largest photo and never shrinks). */
  get memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }
}
