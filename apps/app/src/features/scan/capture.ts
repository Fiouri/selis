/**
 * Camera frames for the document scan (P4c, ADR 0016): small live frames for page detection,
 * and the full-resolution still.
 */
import type { PhotoSource } from "@selis/scan";

/** Long side of the live frames handed to the detector. */
export const DETECT_SIDE = 320;

export type Frame = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };

/** The current video frame at `DETECT_SIDE` px on its long side (null before the first frame). */
export function sampleFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Frame | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) return null;
  const scale = DETECT_SIDE / Math.max(vw, vh);
  const width = Math.max(1, Math.round(vw * scale));
  const height = Math.max(1, Math.round(vh * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
}

type Range = { max?: number; min?: number; step?: number };
type PhotoCapabilities = { imageWidth?: Range; imageHeight?: Range };
/** Image Capture API (Chromium: Android WebView, WebView2); not in TypeScript's DOM types. */
type ImageCaptureLike = {
  getPhotoCapabilities: () => Promise<PhotoCapabilities>;
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

/** A sensor maximum up to this many times the device's pixel cap is taken as it is. */
const FULL_SIZE_FACTOR = 2.5;

/**
 * The photo size to ask for. Cameras take only the sizes they support and map any other
 * request to the nearest one, whatever its shape (the Galaxy S23 turns 3265 × 2449 into
 * 3000 × 3000, cutting off the sides): so the sensor's maximum, an exact size, is asked for
 * and the worker scales it down to the device's cap; only far larger sensors get a scaled
 * request.
 */
export function photoSize(caps: PhotoCapabilities, maxPixels: number): { imageWidth: number; imageHeight: number } | null {
  const w = caps.imageWidth?.max;
  const h = caps.imageHeight?.max;
  if (!w || !h) return null;
  if (w * h <= maxPixels * FULL_SIZE_FACTOR) return { imageWidth: w, imageHeight: h };
  const scale = Math.sqrt(maxPixels / (w * h));
  const step = caps.imageWidth?.step && caps.imageWidth.step > 0 ? caps.imageWidth.step : 1;
  const imageWidth = Math.max(caps.imageWidth?.min ?? 1, Math.floor((w * scale) / step) * step);
  return { imageWidth, imageHeight: Math.round((imageWidth * h) / w) };
}

/**
 * A still: a full-resolution photo through the Image Capture API where the WebView has it,
 * otherwise the current video frame. `rgbaOnly` when the worker cannot decode a JPEG itself.
 */
export async function takeStill(track: MediaStreamTrack, video: HTMLVideoElement, maxPixels: number, rgbaOnly: boolean): Promise<PhotoSource> {
  const ImageCapture = (globalThis as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
  if (ImageCapture && !rgbaOnly) {
    try {
      const capture = new ImageCapture(track);
      const size = photoSize(await capture.getPhotoCapabilities().catch(() => ({})), maxPixels);
      const blob = await capture.takePhoto(size ?? undefined);
      if (blob.size > 0) return { kind: "blob", blob };
    } catch (err) {
      console.warn("selis: takePhoto failed, using a video frame", err);
    }
  }
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) throw new Error("no video frame");
  const canvas = document.createElement("canvas");
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(video, 0, 0);
  const data = ctx.getImageData(0, 0, vw, vh).data;
  canvas.width = 0;
  canvas.height = 0;
  return { kind: "rgba", width: vw, height: vh, rgba: data.buffer };
}
