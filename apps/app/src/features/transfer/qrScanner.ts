/**
 * QR scanning in the WebView (ADR 0013): the camera through getUserMedia (the
 * WebView asks for the camera permission; Android: wry's WebChromeClient), the
 * code decoded by jsQR (Apache-2.0, pure JS, no network) from a centred square
 * of each frame, a few times a second. No Google ML Kit, no native plugin.
 */
import jsQR from "jsqr";

export type ScanFailure = "denied" | "unavailable";

export type Scanner = { stop: () => void };

export class ScanError extends Error {
  readonly failure: ScanFailure;

  constructor(failure: ScanFailure) {
    super(failure);
    this.name = "ScanError";
    this.failure = failure;
  }
}

/** Frames decoded per second (enough for a code held still; cheap on mid-range phones). */
const SCAN_FPS = 6;
/** Side of the square handed to the decoder, px. */
const SAMPLE_PX = 480;

function failureOf(err: unknown): ScanFailure {
  const name = err instanceof DOMException ? err.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

/**
 * Starts the back camera into `video` and calls `onCode` with the first QR
 * code's text. Resolves with a stopper, or rejects with a `ScanError`.
 */
export async function startScanner(video: HTMLVideoElement, onCode: (text: string) => void): Promise<Scanner> {
  // Absent outside secure contexts and in some WebViews, whatever the types say.
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof media?.getUserMedia !== "function") throw new ScanError("unavailable");
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    throw new ScanError(failureOf(err));
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    // Autoplay of a muted inline stream is allowed; frames still arrive.
  }

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
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
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
