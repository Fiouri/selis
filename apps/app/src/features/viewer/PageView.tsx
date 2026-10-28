import { clampScale, type DocHandle, EngineError, type QuarterTurns, renderPlan, rotateRect, rotateSize } from "@selis/engine";
import { Skeleton } from "@selis/ui";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { reportFirstPage } from "../../lib/perf";
import type { PageHighlights } from "./PdfViewer";
import { sharpness } from "./sharpness";
import { TextLayer } from "./TextLayer";
import { TileLayer } from "./TileLayer";
import type { ViewportBus } from "./viewport";

type Props = {
  doc: DocHandle;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** Pixel budget per bitmap; keeps mobile WebView memory bounded. */
  maxPixels: number;
  /** Device pixel ratio the box is snapped to (1 for thumbnails that need no more). */
  dpr?: number;
  /**
   * The viewer's visible area. With it, a page too large for one bitmap gets a base
   * plus full-resolution tiles of what is on screen; without it (thumbnails) the page
   * is drawn once within `maxPixels`.
   */
  viewport?: ViewportBus | undefined;
  /** The viewer's visible area in device pixels (bounds a single page bitmap). */
  viewportPixels?: number;
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
  /**
   * Drawn over the page (annotate input layer); gets CSS px per page point. Kept
   * on buffer pages too, so an open editor survives the page leaving the screen.
   */
  renderOverlay?: ((index: number, scale: number) => ReactNode) | undefined;
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
  dpr = 1,
  viewport,
  viewportPixels = 0,
  rotation = 0,
  night = false,
  textLayer = false,
  highlights,
  label,
  active = false,
  prefetch = false,
  onClick,
  renderOverlay,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Edits bump the page's revision: redraw it (the previous bitmap stays up meanwhile).
  const revision = useSyncExternalStore(
    useCallback((notify: () => void) => doc.onPageChange((page) => page === index && notify()), [doc, index]),
    () => doc.pageRevision(index),
  );
  // Which page (and look) the canvas currently shows; a recycled canvas shows a skeleton until redrawn.
  const [drawn, setDrawn] = useState<{ look: string; scale: number; width: number; height: number } | null>(null);
  // Visible tiles drawn, for the plan (scale) they were drawn at.
  const [tiles, setTiles] = useState({ scale: 0, drawn: 0, visible: 0 });
  const look = `${index}:${rotation}:${night ? "n" : "d"}`;
  const shown = drawn?.look === look ? drawn : null;
  const ready = shown !== null;
  const source = doc.pages[index];
  const page = source ? rotateSize(source, rotation) : null;
  // CSS size × devicePixelRatio, in whole device pixels, at every zoom (ADR 0002 amendment).
  const plan = useMemo(
    () => (page ? renderPlan(page, width, dpr, maxPixels, viewportPixels) : null),
    // Page sizes only change with the document's structure (new handle or page list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page?.width, page?.height, width, dpr, maxPixels, viewportPixels],
  );
  const tiled = Boolean(plan?.tiled && viewport);
  // Without tiles (thumbnails), the whole page within the pixel budget, as before.
  const planned = plan && page ? (viewport ? plan.baseScale : clampScale(page, plan.scale, maxPixels)) : 0;
  // Under tiles, a base already drawn at about the planned resolution (e.g. the fit-width
  // bitmap when zooming in) is kept: re-rendering it would only delay the tiles.
  const keepBase = tiled && plan !== null && shown !== null && shown.scale >= planned * 0.75 && shown.scale <= plan.scale;
  const baseScale = keepBase ? shown.scale : planned;

  useEffect(() => {
    if (!source || baseScale <= 0) return;
    const controller = new AbortController();
    const draw = async () => {
      let image: ImageData;
      try {
        image = await doc.renderPageImage(index, baseScale, { signal: controller.signal, prefetch, rotation, night });
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
      setDrawn({ look: `${index}:${rotation}:${night ? "n" : "d"}`, scale: baseScale, width: image.width, height: image.height });
      reportFirstPage(index);
    };
    void draw();

    return () => controller.abort();
    // `prefetch` is a scheduling hint only; a change must not trigger a re-render.
    // `revision` is not read inside, but a new one means the page changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, baseScale, rotation, night, revision]);

  const onTiles = useCallback((scale: number, count: number, visible: number) => {
    setTiles((prev) => (prev.scale === scale && prev.drawn === count && prev.visible === visible ? prev : { scale, drawn: count, visible }));
  }, []);

  // Sharpness diagnostics for the viewer's pages on screen (local only, see sharpness.ts).
  const sharp =
    plan !== null &&
    shown !== null &&
    (tiled ? tiles.scale === plan.scale && tiles.visible > 0 && tiles.drawn === tiles.visible : shown.scale === plan.scale);
  const lowRes = useRef({ shown: false, upgrades: 0 });
  useEffect(() => {
    if (!viewport || !plan || !shown || prefetch) {
      sharpness.page(index, null);
      return;
    }
    if (!sharp) lowRes.current.shown = true;
    else if (lowRes.current.shown) {
      lowRes.current.shown = false;
      lowRes.current.upgrades++;
    }
    sharpness.page(index, {
      page: index,
      cssWidth: plan.deviceWidth / dpr,
      cssHeight: plan.deviceHeight / dpr,
      dpr,
      deviceWidth: plan.deviceWidth,
      deviceHeight: plan.deviceHeight,
      maxBitmapPixels: maxPixels,
      bitmapWidth: shown.width,
      bitmapHeight: shown.height,
      tiled,
      tilesVisible: tiled ? tiles.visible : 0,
      tilesDrawn: tiled ? tiles.drawn : 0,
      sharp,
      upgrades: lowRes.current.upgrades,
    });
  }, [viewport, plan, shown, prefetch, sharp, index, dpr, maxPixels, tiled, tiles]);
  useEffect(() => () => sharpness.page(index, null), [index]);

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

  // The box takes the plan's whole-device-pixel size, so the bitmap maps 1:1.
  const boxWidth = plan && plan.deviceWidth > 0 ? plan.deviceWidth / dpr : width;
  const boxHeight = plan && plan.deviceHeight > 0 ? plan.deviceHeight / dpr : height;
  const scale = page && page.width > 0 ? boxWidth / page.width : 0;
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
      {tiled && plan && viewport && ready ? (
        <TileLayer
          doc={doc}
          index={index}
          plan={plan}
          rotation={rotation}
          night={night}
          dpr={dpr}
          boxLeft={left}
          boxTop={top}
          viewport={viewport}
          revision={revision}
          onProgress={onTiles}
        />
      ) : null}
      {marks}
      {/* After the bitmap: text extraction must not delay the first paint. */}
      {textLayer && ready && scale > 0 ? <TextLayer doc={doc} index={index} scale={scale} /> : null}
      {renderOverlay && scale > 0 ? renderOverlay(index, scale) : null}
    </>
  );
  const className = `absolute overflow-hidden rounded-[2px] p-0 shadow-1 ${night ? "bg-neutral-12" : "bg-white"} ${
    active ? "outline-2 outline-offset-2 outline-accent-9" : ""
  }`;
  const style = { top, left, width: boxWidth, height: boxHeight };

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
  // A group, not an image: an image's children are presentational, which would hide
  // the editors on the page (text box, note, their buttons) from TalkBack.
  return (
    <div role="group" aria-label={label} data-page={index + 1} className={className} style={style}>
      {body}
    </div>
  );
});
