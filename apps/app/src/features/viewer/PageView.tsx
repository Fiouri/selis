import { clampScale, type DocHandle, EngineError, renderScale } from "@selis/engine";
import { Skeleton } from "@selis/ui";
import { memo, useEffect, useRef, useState } from "react";
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
  onClick?: (index: number) => void;
};

/**
 * One page box. Its bitmap lives only while the page is mounted (inside the
 * render window); unmounting aborts pending renders and frees the canvas.
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
  onClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const renderWidth = Math.round(width);

  useEffect(() => {
    const page = doc.pages[index];
    if (!page || renderWidth <= 0) return;
    const controller = new AbortController();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = clampScale(page, renderScale(page, renderWidth, dpr), maxPixels);

    const draw = async () => {
      let bitmap: ImageBitmap;
      try {
        bitmap = await doc.renderPage(index, scale, { signal: controller.signal });
      } catch (err) {
        if (err instanceof EngineError && (err.code === "cancelled" || err.code === "closed")) return;
        console.warn(`selis: render failed for page ${index + 1}`, err);
        return;
      }
      const canvas = canvasRef.current;
      if (controller.signal.aborted || !canvas) {
        bitmap.close();
        return;
      }
      // Swap in the new bitmap only now: the previous one stays visible
      // (CSS-scaled) during zoom changes, so there is no blank flash.
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("bitmaprenderer");
      if (ctx) {
        ctx.transferFromImageBitmap(bitmap);
      } else {
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      setReady(true);
      reportFirstPage(index);
    };
    void draw();

    return () => controller.abort();
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
