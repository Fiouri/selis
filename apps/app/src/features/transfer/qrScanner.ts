/**
 * QR scanning in the WebView (ADR 0013): the back camera (`lib/camera.ts`, getUserMedia), the
 * code decoded by jsQR (Apache-2.0, pure JS, no network) from a centred square of each frame,
 * a few times a second. No Google ML Kit, no native plugin.
 */
import jsQR from "jsqr";
import { CameraError, type CameraFailure, openBackCamera } from "../../lib/camera";

export type ScanFailure = CameraFailure;
export { CameraError as ScanError };

export type Scanner = { stop: () => void };

/** Frames decoded per second (enough for a code held still; cheap on mid-range phones). */
const SCAN_FPS = 6;
/** Side of the square handed to the decoder, px. */
const SAMPLE_PX = 480;

/**
 * Starts the back camera into `video` and calls `onCode` with the first QR
 * code's text. Resolves with a stopper, or rejects with a `ScanError`.
 */
export async function startScanner(video: HTMLVideoElement, onCode: (text: string) => void): Promise<Scanner> {
  const camera = await openBackCamera(video, 1280, 720);

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_PX;
  canvas.height = SAMPLE_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let timer = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    camera.stop();
  };

  const scan = () => {
    if (stopped || !ctx) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w > 0 && h > 0) {
      const side = Math.min(w, h);
      ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SAMPLE_PX, SAMPLE_PX);
      const frame = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX);
      const code = jsQR(frame.data, SAMPLE_PX, SAMPLE_PX, { inversionAttempts: "dontInvert" });
      if (code?.data) {
        stop();
        onCode(code.data);
        return;
      }
    }
    timer = window.setTimeout(scan, 1000 / SCAN_FPS);
  };
  timer = window.setTimeout(scan, 1000 / SCAN_FPS);
  return { stop };
}
