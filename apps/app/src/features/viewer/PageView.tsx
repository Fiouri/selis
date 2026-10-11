import { clampScale, type DocHandle, EngineError, type QuarterTurns, renderScale, rotateRect, rotateSize } from "@selis/engine";
import { Skeleton } from "@selis/ui";
import { memo, useEffect, useRef, useState } from "react";
import { currentRenderLimits } from "../../lib/engine";
import { reportFirstPage } from "../../lib/perf";
import type { PageHighlights } from "./PdfViewer";
import { TextLayer } from "./TextLayer";

type Props = {
  doc: DocHandle;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** Pixel budget per bitmap; keeps mobile WebView memory bounded. */
  maxPixels: number;
  rotation?: QuarterTurns;
  night?: boolean;
  /** Selectable text over the bitmap (visible pages, unrotated). */
  textLayer?: boolean;
  highlights?: PageHighlights | undefined;
  label: string;
  active?: boolean;
  /** Off-screen buffer page: rendered after the visible ones. */
  prefetch?: boolean;
  onClick?: (index: number) => void;
};

/**
 * One page box, drawn into a canvas that the viewer recycles between pages
 * (slot pool): the canvas backing store is reused instead of allocating a new
 * GPU/shared-memory resource per render. Unmounting aborts pending renders and
 * frees the canvas.
 */
export const PageView = memo(function PageView({
  doc,
  index,
  top,
  left,
  width,
  height,
  maxPixels,
  rotation = 0,
  night = false,
  textLayer = false,
  highlights,
  label,
  active = false,
  prefetch = false,
  onClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Which page (and look) the canvas currently shows; a recycled canvas shows a skeleton until redrawn.
  const [drawn, setDrawn] = useState<string | null>(null);
  const look = `${index}:${rotation}:${night ? "n" : "d"}`;
  const ready = drawn === look;
  const renderWidth = Math.round(width);

  useEffect(() => {
    const source = doc.pages[index];
    if (!source || renderWidth <= 0) return;
    const page = rotateSize(source, rotation);
    const controller = new AbortController();
    // Resolution cap from the device's memory tier (2 / 1.5 / 1.25): pixel count,
    // and with it WebView memory, grows with its square.
    const dpr = Math.min(window.devicePixelRatio || 1, currentRenderLimits().maxRenderScale);
    const scale = clampScale(page, renderScale(page, renderWidth, dpr), maxPixels);

    const draw = async () => {
      let image: ImageData;
      try {
        image = await doc.renderPageImage(index, scale, { signal: controller.signal, prefetch, rotation, night });
      } catch (err) {
        if (err instanceof EngineError && (err.code === "cancelled" || err.code === "closed")) return;
        console.warn(`selis: render failed for page ${index + 1}`, err);
        return;
      }
      const canvas = canvasRef.current;
      if (controller.signal.aborted || !canvas) return;
      // Draw only now: the previous content stays visible (CSS-scaled) during
      // zoom changes, so there is no blank flash. Resize only when needed so the
      // backing store is reused.
      if (canvas.width !== image.width) canvas.width = image.width;
      if (canvas.height !== image.height) canvas.height = image.height;
      canvas.getContext("2d", { alpha: false })?.putImageData(image, 0, 0);
      setDrawn(`${index}:${rotation}:${night ? "n" : "d"}`);
      reportFirstPage(index);
    };
    void draw();

    return () => controller.abort();
    // `prefetch` is a scheduling hint only; a change must not trigger a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, renderWidth, maxPixels, rotation, night]);

  // Release the backing store as soon as the page leaves the render window.
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  const source = doc.pages[index];
  const page = source ? rotateSize(source, rotation) : null;
  const scale = page && page.width > 0 ? width / page.width : 0;
  const marks =
    highlights && source && scale > 0 ? (
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {[...highlights.rects.map((r) => ({ r, on: false })), ...highlights.active.map((r) => ({ r, on: true }))].map(
          ({ r, on }, i) => {
            const box = rotateRect(r, source, rotation);
            return (
              <span
                key={i}
                data-testid={on ? "search-hit-active" : "search-hit"}
                className={`absolute rounded-[2px] ${on ? "bg-warning-9/55 outline-2 outline-warning-9" : "bg-warning-9/30"}`}
                style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}
              />
            );
          },
        )}
      </div>
    ) : null;

  const body = (
    <>
      {ready ? null : <Skeleton className="absolute inset-0 rounded-none" />}
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
      {marks}
      {/* After the bitmap: text extraction must not delay the first paint. */}
      {textLayer && ready && scale > 0 ? <TextLayer doc={doc} index={index} scale={scale} /> : null}
    </>
  );
  const className = `absolute overflow-hidden rounded-[2px] p-0 shadow-1 ${night ? "bg-neutral-12" : "bg-white"} ${
    active ? "outline-2 outline-offset-2 outline-accent-9" : ""
  }`;
  const style = { top, left, width, height };

  if (onClick) {
    return (
      <button
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-page={index + 1}
        onClick={() => onClick(index)}
        className={`selis-focus cursor-pointer border-0 ${className}`}
        style={style}
      >
        {body}
      </button>
    );
  }
  return (
    <div role="img" aria-label={label} data-page={index + 1} className={className} style={style}>
      {body}
    </div>
  );
});
