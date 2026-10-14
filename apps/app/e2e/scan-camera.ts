/**
 * A fake back camera for the document scan (P4c), in any browser: `getUserMedia` returns the
 * stream of a canvas that shows a page in perspective on a dark desk (text lines, a table), so
 * live detection, the still and the straightened page are deterministic. The Image Capture API
 * is hidden, so stills come from the video frame (the path WebKit and desktops take).
 */
import type { Page } from "@playwright/test";

/** The page's corners in the 720 × 960 camera frame. */
export const FAKE_PAGE_CORNERS = [
  [150, 140],
  [590, 118],
  [640, 830],
  [96, 852],
] as const;

export async function useFakeScanCamera(page: Page, options: { denied?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ corners, denied }) => {
      const W = 720;
      const H = 960;
      // Playwright's WebKit on Windows has no mediaDevices at all: give it one.
      if (!(navigator.mediaDevices as MediaDevices | undefined)) {
        Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
      }
      const media = navigator.mediaDevices;
      (window as unknown as { ImageCapture?: unknown }).ImageCapture = undefined;
      type Pt = readonly [number, number];
      const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // A point of the page at (u, v) in 0..1, by bilinear interpolation of its corners.
      const at = (u: number, v: number) => lerp(lerp(corners[0], corners[1], u), lerp(corners[3], corners[2], u), v);
      const draw = (ctx: CanvasRenderingContext2D) => {
        ctx.fillStyle = "#3a2e26";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#f2efe8";
        ctx.beginPath();
        corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#222222";
        for (let row = 0; row < 26; row++) {
          const v = 0.08 + row * 0.033;
          ctx.lineWidth = row === 0 ? 9 : 4;
          const end = row === 0 ? 0.55 : row % 6 === 5 ? 0.6 : 0.9;
          const [x0, y0] = at(0.1, v);
          const [x1, y1] = at(end, v);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      };
      media.getUserMedia = (constraints?: MediaStreamConstraints) => {
        if (denied) return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
        if (!constraints?.video) return Promise.reject(new DOMException("No audio here", "NotFoundError"));
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return Promise.reject(new DOMException("No canvas", "NotReadableError"));
        draw(ctx);
        // A canvas stream sends frames when the canvas is painted: repaint it like a camera.
        // (The repaint stops with the page; a stopped track just ignores it.)
        window.setInterval(() => draw(ctx), 100);
        const stream = canvas.captureStream(10);
        return Promise.resolve(stream);
      };
    },
    { corners: FAKE_PAGE_CORNERS, denied: options.denied ?? false },
  );
}
