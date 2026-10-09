import { clampScale, type DocHandle, EngineError, renderScale } from "@selis/engine";
import { Skeleton } from "@selis/ui";
import { memo, useEffect, useRef, useState } from "react";
import { currentRenderLimits } from "../../lib/engine";
import { reportFirstPage } from "../../lib/perf";

type Props = {
  doc: DocHandle;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** Pixel budget per bitmap; keeps mobile WebView memory bounded. */
  maxPixels: number;
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
  label,
  active = false,
  prefetch = false,
  onClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Which page the canvas currently shows; a recycled canvas shows a skeleton until redrawn.
  const [drawnIndex, setDrawnIndex] = useState<number | null>(null);
  const ready = drawnIndex === index;
  const renderWidth = Math.round(width);

  useEffect(() => {
    const page = doc.pages[index];
    if (!page || renderWidth <= 0) return;
    const controller = new AbortController();
    // Resolution cap from the device's memory tier (2 / 1.5 / 1.25): pixel count,
    // and with it WebView memory, grows with its square.
    const dpr = Math.min(window.devicePixelRatio || 1, currentRenderLimits().maxRenderScale);
    const scale = clampScale(page, renderScale(page, renderWidth, dpr), maxPixels);

    const draw = async () => {
      let image: ImageData;
      try {
        image = await doc.renderPageImage(index, scale, { signal: controller.signal, prefetch });
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
      setDrawnIndex(index);
      reportFirstPage(index);
    };
    void draw();

    return () => controller.abort();
    // `prefetch` is a scheduling hint only; a change must not trigger a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, renderWidth, maxPixels]);

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

  const body = (
    <>
      {ready ? null : <Skeleton className="absolute inset-0 rounded-none" />}
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
    </>
  );
  const className = `absolute overflow-hidden bg-white p-0 shadow-1 ${
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
