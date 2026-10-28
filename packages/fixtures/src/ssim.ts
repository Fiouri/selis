/**
 * Structural similarity (SSIM, Wang et al. 2004) of two RGBA images of the same
 * size, on luma, over 8 × 8 windows every 4 pixels. 1 = identical. Used to check
 * that the viewer shows pages as sharp as a direct PDFium render (ADR 0002).
 */
export type Rgba = { readonly data: Uint8ClampedArray | Uint8Array; readonly width: number; readonly height: number };

const WINDOW = 8;
const STEP = 4;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function luma(image: Rgba): Float64Array {
  const out = new Float64Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = 0.299 * (image.data[p] as number) + 0.587 * (image.data[p + 1] as number) + 0.114 * (image.data[p + 2] as number);
  }
  return out;
}

export function ssim(a: Rgba, b: Rgba): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  const x = luma(a);
  const y = luma(b);
  const n = WINDOW * WINDOW;
  let total = 0;
  let windows = 0;
  for (let top = 0; top + WINDOW <= a.height; top += STEP) {
    for (let left = 0; left + WINDOW <= a.width; left += STEP) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let j = 0; j < WINDOW; j++) {
        const row = (top + j) * a.width + left;
        for (let i = 0; i < WINDOW; i++) {
          const u = x[row + i] as number;
          const v = y[row + i] as number;
          sx += u;
          sy += v;
          sxx += u * u;
          syy += v * v;
          sxy += u * v;
        }
      }
      const mx = sx / n;
      const my = sy / n;
      const vx = sxx / n - mx * mx;
      const vy = syy / n - my * my;
      const cov = sxy / n - mx * my;
      total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      windows++;
    }
  }
  return windows > 0 ? total / windows : 1;
}

/** The `width` × `height` area of `image` at (`x`, `y`), as a new RGBA image. */
export function crop(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { data, width, height };
}
