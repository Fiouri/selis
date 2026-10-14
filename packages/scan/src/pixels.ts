/** RGBA helpers that need no canvas (the worker may have none). */

export type RgbaImage = { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray<ArrayBuffer> };

/**
 * A copy with its long side at most `side` px, by box averaging (sharp enough for previews
 * and thumbnails; the full image is never shown).
 */
export function downscale(image: RgbaImage, side: number): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const scale = Math.min(1, side / Math.max(image.width, image.height));
  if (scale === 1) return { width: image.width, height: image.height, rgba: new Uint8ClampedArray(image.rgba) };
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  const src = image.rgba;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * image.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src[i] ?? 0;
          g += src[i + 1] ?? 0;
          b += src[i + 2] ?? 0;
          a += src[i + 3] ?? 0;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width, height, rgba: out };
}
