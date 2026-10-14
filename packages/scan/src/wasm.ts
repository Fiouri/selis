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
import type { Quad } from "./geometry";

export const FILTERS = ["original", "grey", "bw"] as const;
export type ScanFilter = (typeof FILTERS)[number];

export type StraightPage = { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray<ArrayBuffer> };

type Exports = {
  memory: WebAssembly.Memory;
  scan_alloc: (len: number) => number;
  scan_free: (ptr: number, len: number) => void;
  scan_detect: (rgba: number, width: number, height: number, out: number) => number;
  scan_find_page: (rgba: number, width: number, height: number, out: number) => number;
  scan_filter: (rgba: number, width: number, height: number, filter: number) => number;
  scan_straighten: (rgba: number, width: number, height: number, quad: number, maxPixels: number, filter: number, outSize: number) => number;
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

export class ScanModule {
  private readonly x: Exports;
  /** A reused buffer for live frames (they all have the same size). */
  private frame = { ptr: 0, len: 0 };
  /** 8 f32 (a quad) + 2 u32 (a size). */
  private readonly scratch: number;

  private constructor(exports: Exports) {
    this.x = exports;
    this.scratch = this.x.scan_alloc(40);
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

  /** The page in a small live frame (about 320 px on the long side), in frame pixels. */
  detect(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Quad | null {
    if (this.frame.len !== rgba.length) {
      if (this.frame.ptr) this.x.scan_free(this.frame.ptr, this.frame.len);
      this.frame = { ptr: this.alloc(rgba.length), len: rgba.length };
    }
    this.bytes(this.frame.ptr, rgba.length).set(rgba);
    return this.x.scan_detect(this.frame.ptr, width, height, this.scratch) ? this.readQuad() : null;
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
   * Straightens the page `quad` of a full-size photo into an image of at most `maxPixels`
   * and applies `filter`.
   */
  straighten(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, quad: Quad, maxPixels: number, filter: ScanFilter): StraightPage {
    const ptr = this.alloc(rgba.length);
    this.bytes(ptr, rgba.length).set(rgba);
    this.writeQuad(quad);
    // The module takes (and frees) the photo buffer.
    const out = this.x.scan_straighten(ptr, width, height, this.scratch, Math.floor(maxPixels), FILTERS.indexOf(filter), this.scratch + 32);
    if (!out) throw new Error("selis-scan: straightening failed");
    const size = new Uint32Array(this.x.memory.buffer, this.scratch + 32, 2);
    const w = size[0] ?? 0;
    const h = size[1] ?? 0;
    const len = w * h * 4;
    const copy = new Uint8ClampedArray(len);
    copy.set(this.bytes(out, len));
    this.x.scan_free(out, len);
    return { width: w, height: h, rgba: copy };
  }

  /** Bytes of linear memory (it grows to the largest photo and never shrinks). */
  get memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }
}
