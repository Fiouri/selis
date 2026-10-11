/**
 * Signature images: every kind (drawn, typed, picture) becomes a transparent
 * PNG, cropped to the ink, at most MAX_WIDTH wide. Stored by Rust, placed on a
 * page as a stamp (visual signature, not PAdES).
 */
import mansalvaUrl from "./fonts/mansalva.woff2?url";
import mynerveUrl from "./fonts/mynerve.woff2?url";
import playpenUrl from "./fonts/playpensans.woff2?url";

export const MAX_WIDTH = 1200;
/** Transparent margin around the ink, in output pixels. */
const MARGIN = 12;

export type Point = { readonly x: number; readonly y: number };

/** Handwriting fonts with Greek (OFL; src/features/sign/fonts, scripts/subset-signature-fonts.sh). */
export const SIGNATURE_FONTS = [
  { id: "mansalva", family: "Selis Signature Mansalva", url: mansalvaUrl },
  { id: "mynerve", family: "Selis Signature Mynerve", url: mynerveUrl },
  { id: "playpen", family: "Selis Signature Playpen", url: playpenUrl },
] as const;
export type SignatureFontId = (typeof SIGNATURE_FONTS)[number]["id"];

const loaded = new Map<string, Promise<void>>();

/** Loads a signature font on first use (they are not part of the app's CSS). */
export function loadSignatureFont(id: SignatureFontId): Promise<void> {
  const font = SIGNATURE_FONTS.find((f) => f.id === id);
  if (!font) return Promise.reject(new Error(`unknown font ${id}`));
  let promise = loaded.get(id);
  if (!promise) {
    promise = (async () => {
      const face = new FontFace(font.family, `url(${font.url})`);
      await face.load();
      document.fonts.add(face);
    })();
    loaded.set(id, promise);
    promise.catch(() => loaded.delete(id));
  }
  return promise;
}

export function fontFamily(id: SignatureFontId): string {
  return SIGNATURE_FONTS.find((f) => f.id === id)?.family ?? "cursive";
}

/** Bounding box of pixels with alpha > 0, or null when there are none. */
export function contentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] as number) === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Makes paper transparent in place: light pixels (paper, shadows of a photo)
 * fade out, dark ones (ink) stay, with a soft edge between `low` and `high`
 * luminance so strokes keep anti-aliased borders.
 */
export function knockOutBackground(data: Uint8ClampedArray, low = 150, high = 205): void {
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * (data[i] as number) + 0.7152 * (data[i + 1] as number) + 0.0722 * (data[i + 2] as number);
    const keep = l <= low ? 1 : l >= high ? 0 : (high - l) / (high - low);
    data[i + 3] = Math.round((data[i + 3] as number) * keep);
  }
}

function canvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas");
  return { canvas: c, ctx };
}

async function toPng(c: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => {
    c.toBlob(resolve, "image/png");
  });
  // Free the backing store now, not at the next GC.
  c.width = 0;
  c.height = 0;
  if (!blob) throw new Error("PNG encoding failed");
  return blob;
}

/** Crops a canvas to its ink (plus a margin) and encodes it. */
async function cropToInk(source: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<Blob> {
  const image = ctx.getImageData(0, 0, source.width, source.height);
  const box = contentBounds(image.data, source.width, source.height);
  if (!box) throw new Error("the signature is empty");
  const x = Math.max(0, box.x - MARGIN);
  const y = Math.max(0, box.y - MARGIN);
  const w = Math.min(source.width - x, box.width + 2 * MARGIN);
  const h = Math.min(source.height - y, box.height + 2 * MARGIN);
  const scale = Math.min(1, MAX_WIDTH / w);
  const out = canvas(w * scale, h * scale);
  out.ctx.drawImage(source, x, y, w, h, 0, 0, out.canvas.width, out.canvas.height);
  source.width = 0;
  source.height = 0;
  return toPng(out.canvas);
}

/**
 * Drawn signature: strokes in pad coordinates (CSS px), smoothed with
 * quadratic curves through the midpoints, drawn at 3× for a crisp image.
 */
export async function strokesToPng(strokes: readonly (readonly Point[])[], color: string, lineWidth: number): Promise<Blob> {
  const points = strokes.flat();
  if (points.length === 0) throw new Error("the signature is empty");
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - lineWidth;
  const minY = Math.min(...ys) - lineWidth;
  const scale = Math.min(3, MAX_WIDTH / Math.max(1, Math.max(...xs) - minX + lineWidth));
  const { canvas: c, ctx } = canvas((Math.max(...xs) - minX + lineWidth) * scale + 2 * MARGIN, (Math.max(...ys) - minY + lineWidth) * scale + 2 * MARGIN);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const at = (p: Point) => ({ x: (p.x - minX) * scale + MARGIN, y: (p.y - minY) * scale + MARGIN });
  for (const stroke of strokes) {
    const pts = stroke.map(at);
    const first = pts[0];
    if (!first) continue;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i] as Point;
      const next = pts[i + 1] as Point;
      ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
    }
    const last = pts[pts.length - 1] as Point;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  return cropToInk(c, ctx);
}

/** Typed signature: the name in a handwriting font, 160 px high glyphs. */
export async function typedToPng(text: string, font: SignatureFontId, color: string): Promise<Blob> {
  const name = text.trim();
  if (name === "") throw new Error("the signature is empty");
  await loadSignatureFont(font);
  const size = 160;
  const probe = canvas(1, 1);
  probe.ctx.font = `${size}px "${fontFamily(font)}"`;
  const width = probe.ctx.measureText(name).width;
  const { canvas: c, ctx } = canvas(width + size, size * 1.8);
  ctx.font = `${size}px "${fontFamily(font)}"`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, size / 2, size * 1.25);
  return cropToInk(c, ctx);
}

/**
 * Picture of a signature on paper: scaled down, paper made transparent
 * (optional), cropped to the ink.
 */
export async function pictureToPng(bytes: ArrayBuffer, mime: string, removeBackground: boolean): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    const scale = Math.min(1, (MAX_WIDTH * 1.5) / Math.max(bitmap.width, bitmap.height));
    const { canvas: c, ctx } = canvas(bitmap.width * scale, bitmap.height * scale);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    if (removeBackground) {
      const image = ctx.getImageData(0, 0, c.width, c.height);
      knockOutBackground(image.data);
      ctx.putImageData(image, 0, 0);
    }
    return await cropToInk(c, ctx);
  } finally {
    bitmap.close();
  }
}
