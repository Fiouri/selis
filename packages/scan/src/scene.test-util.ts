/** Synthetic camera frames for the tests: a page in perspective on a textured desk. */
import type { Quad } from "./geometry";

/** Maps `from` points onto `to`: the 8 homography unknowns by Gauss–Jordan elimination. */
function homography(from: Quad, to: Quad): (x: number, y: number) => [number, number] {
  const n = 8;
  // Row-major augmented matrix (8 × 9).
  const m = new Float64Array(n * (n + 1));
  const get = (r: number, c: number) => m[r * (n + 1) + c] ?? 0;
  const set = (r: number, c: number, v: number) => {
    m[r * (n + 1) + c] = v;
  };
  from.forEach(([x, y], i) => {
    const [u, v] = to[i] ?? to[0];
    [x, y, 1, 0, 0, 0, -u * x, -u * y, u].forEach((value, c) => set(i * 2, c, value));
    [0, 0, 0, x, y, 1, -v * x, -v * y, v].forEach((value, c) => set(i * 2 + 1, c, value));
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(get(r, c)) > Math.abs(get(p, c))) p = r;
    for (let k = 0; k <= n; k++) {
      const t = get(c, k);
      set(c, k, get(p, k));
      set(p, k, t);
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = get(r, c) / get(c, c);
      for (let k = c; k <= n; k++) set(r, k, get(r, k) - f * get(c, k));
    }
  }
  const h = Array.from({ length: n }, (_, i) => get(i, n) / get(i, i));
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = h;
  return (x, y) => {
    const w = g * x + k * y + 1;
    return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
  };
}

/** RGBA of a `width × height` photo of a page (850 × 1100 units, text lines) seen through `quad`. */
export function scene(width: number, height: number, quad: Quad): Uint8ClampedArray<ArrayBuffer> {
  const toPage = homography(quad, [
    [0, 0],
    [850, 0],
    [850, 1100],
    [0, 1100],
  ]);
  const rgba = new Uint8ClampedArray(width * height * 4);
  let s = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const [u, v] = toPage(x + 0.5, y + 0.5);
      let c: number;
      if (u >= 0 && u < 850 && v >= 0 && v < 1100) {
        const ink = u > 85 && u < 765 && v > 80 && ((v / 1100) * 24) % 1 < 0.12;
        c = ink ? 40 : 230;
      } else {
        c = 70 + ((((x / 7) | 0) + ((y / 23) | 0)) % 3) * 6 + ((s >>> 0) % 24);
      }
      const i = (y * width + x) * 4;
      rgba[i] = c;
      rgba[i + 1] = c;
      rgba[i + 2] = c;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}
