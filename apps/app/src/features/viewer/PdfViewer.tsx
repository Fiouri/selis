import {
  type DocHandle,
  layoutPages,
  type PageLayout,
  type PageRange,
  type PageRect,
  pageAt,
  type QuarterTurns,
  renderWindow,
  rotateSize,
  visibleRange,
} from "@selis/engine";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageView } from "./PageView";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** Double tap toggles between fit-width and this zoom. */
export const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;

export type PdfViewerHandle = {
  /** Scrolls so that `index` starts at the top; `offsetPts` moves further down the page (PDF points). */
  scrollToPage: (index: number, offsetPts?: number) => void;
  /** 0 = top of the document, 1 = bottom (the scrubber). */
  scrollToFraction: (fraction: number) => void;
};

/** Search highlights of one page (unrotated page points). */
export type PageHighlights = { readonly rects: readonly PageRect[]; readonly active: readonly PageRect[] };

export type ScrollInfo = { readonly top: number; readonly fraction: number; readonly delta: number };

type Props = {
  doc: DocHandle;
  /** Horizontal space around pages at zoom 1 (CSS px). */
  gutter?: number;
  gap?: number;
  /** Space reserved under overlaid chrome (CSS px). */
  insetTop?: number;
  insetBottom?: number;
  /** Pinch / ctrl+wheel / double-tap zoom. Off for thumbnail strips. */
  zoomable?: boolean;
  /** Pages kept rendered beyond the visible ones, on each side. */
  buffer?: number;
  maxPixels: number;
  rotation?: QuarterTurns;
  night?: boolean;
  /** Selectable text over the page images (needs rotation 0). */
  textLayer?: boolean;
  highlights?: ReadonlyMap<number, PageHighlights> | undefined;
  /** Page to show first (restored reading position). */
  initialPage?: number;
  activePage?: number | undefined;
  onPageChange?: ((index: number) => void) | undefined;
  onPageClick?: ((index: number) => void) | undefined;
  onTap?: (() => void) | undefined;
  onScroll?: ((info: ScrollInfo) => void) | undefined;
  testId?: string | undefined;
  ariaLabel?: string | undefined;
};

/**
 * Keeps each page in the window on its previous slot and gives new pages the
 * slots freed by pages that left. Mutates and returns `slots`.
 */
export function assignSlots(slots: Map<number, number>, range: PageRange): Map<number, number> {
  for (const page of slots.keys()) {
    if (page < range.first || page > range.last) slots.delete(page);
  }
  const used = new Set(slots.values());
  let candidate = 0;
  for (let i = range.first; i <= range.last; i++) {
    if (slots.has(i)) continue;
    while (used.has(candidate)) candidate++;
    slots.set(i, candidate);
    used.add(candidate);
  }
  return slots;
}

type Anchor = { page: number; fracY: number; screenY: number; fracX: number; screenX: number };

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

function anchorAt(layout: PageLayout, contentY: number, contentX: number, contentWidth: number): Omit<Anchor, "screenX" | "screenY"> {
  const page = Math.max(0, pageAt(layout, contentY));
  const top = layout.tops[page] ?? 0;
  const height = layout.heights[page] ?? 1;
  return { page, fracY: height > 0 ? (contentY - top) / height : 0, fracX: contentWidth > 0 ? contentX / contentWidth : 0 };
}

/**
 * Virtualized vertical page scroller. Only pages in the render window (visible
 * + `buffer`) are mounted, so a 1000-page document holds a handful of bitmaps.
 * Pinch zoom scales the content with a CSS transform during the gesture, then
 * commits a relayout and re-renders at the new resolution around the focal point.
 */
export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  {
    doc,
    gutter = 8,
    gap = 8,
    insetTop = 0,
    insetBottom = 0,
    zoomable = true,
    buffer = 1,
    maxPixels,
    rotation = 0,
    night = false,
    textLayer = false,
    highlights,
    initialPage = 0,
    activePage,
    onPageChange,
    onPageClick,
    onTap,
    onScroll,
    testId,
    ariaLabel,
  },
  ref,
) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  // The render window is tied to the layout it was computed for: a window from a
  // stale layout (e.g. before the width was measured, when every page is 0 px tall)
  // would mount and render dozens of pages at once.
  const [win, setWin] = useState<{ visible: PageRange; window: PageRange; layout: PageLayout } | null>(null);
  const pendingAnchor = useRef<Anchor | null>(null);
  /** Page → canvas slot. Slots are React keys, so canvases are recycled across pages. */
  const slots = useRef(new Map<number, number>());
  const gestureActive = useRef(false);
  const lastScrollTop = useRef(0);
  const restored = useRef(initialPage <= 0);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<number | null>(null);

  const pages = useMemo(() => (rotation === 0 ? doc.pages : doc.pages.map((p) => rotateSize(p, rotation))), [doc, rotation]);
  const fitWidth = Math.max(0, viewport.width - 2 * gutter);
  const layout = useMemo(() => layoutPages(pages, fitWidth, zoom, gap), [pages, fitWidth, zoom, gap]);
  const contentWidth = Math.max(viewport.width, layout.maxWidth + 2 * gutter);
  const contentHeight = insetTop + layout.totalHeight + insetBottom;

  // Track the scroller size.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || el.clientHeight === 0) return;
    if (fitWidth <= 0) {
      setWin(null);
      return;
    }
    const y = Math.max(0, el.scrollTop - insetTop);
    const visible = visibleRange(layout, y, el.clientHeight);
    const renderable = renderWindow(visible, doc.pageCount, buffer);
    const next = visible && renderable ? { visible, window: renderable, layout } : null;
    setWin((prev) =>
      prev &&
      next &&
      prev.layout === next.layout &&
      prev.window.first === next.window.first &&
      prev.window.last === next.window.last &&
      prev.visible.first === next.visible.first &&
      prev.visible.last === next.visible.last
        ? prev
        : next,
    );
    onPageChange?.(Math.max(0, pageAt(layout, y + el.clientHeight / 3)));
  }, [layout, fitWidth, insetTop, doc.pageCount, buffer, onPageChange]);

  // After a zoom commit, restore the focal point, then recompute the window.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const anchor = pendingAnchor.current;
    if (el && anchor) {
      pendingAnchor.current = null;
      const top = layout.tops[anchor.page] ?? 0;
      const height = layout.heights[anchor.page] ?? 0;
      el.scrollTop = insetTop + top + anchor.fracY * height - anchor.screenY;
      el.scrollLeft = anchor.fracX * contentWidth - anchor.screenX;
    }
    // Restore the reading position once the layout knows real page heights.
    if (el && !restored.current && fitWidth > 0) {
      restored.current = true;
      // Content y = insetTop + page top; the page lands right under the overlaid chrome.
      el.scrollTop = (layout.tops[initialPage] ?? 0) - gap;
    }
    update();
  }, [layout, contentWidth, insetTop, update, fitWidth, initialPage, gap]);

  // rAF-throttled scroll handling.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let frame = 0;
    const onScrollEvent = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        const delta = el.scrollTop - lastScrollTop.current;
        lastScrollTop.current = el.scrollTop;
        onScroll?.({ top: el.scrollTop, fraction: Math.min(1, Math.max(0, el.scrollTop / max)), delta });
      });
    };
    el.addEventListener("scroll", onScrollEvent, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScrollEvent);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [update, onScroll]);

  /**
   * Re-lays out at `nextZoom` so the content point (contentX, contentY) — in
   * scroll coordinates of the current layout — lands at (screenX, screenY).
   */
  const commitZoom = useCallback(
    (nextZoom: number, contentX: number, contentY: number, screenX: number, screenY: number) => {
      const z = clampZoom(nextZoom);
      if (Math.abs(z - zoom) < 0.01) return;
      pendingAnchor.current = { ...anchorAt(layout, contentY - insetTop, contentX, contentWidth), screenX, screenY };
      setZoom(z);
    },
    [zoom, layout, contentWidth, insetTop],
  );

  // Pinch-zoom (touch) and ctrl+wheel / trackpad pinch (desktop).
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || !zoomable) return;

    let pinch: {
      startDist: number;
      startMidX: number;
      startMidY: number;
      originX: number;
      originY: number;
      ratio: number;
      dx: number;
      dy: number;
    } | null = null;

    const touchInfo = (touches: TouchList) => {
      const a = touches[0];
      const b = touches[1];
      if (!a || !b) return null;
      const rect = el.getBoundingClientRect();
      return {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        midX: (a.clientX + b.clientX) / 2 - rect.left,
        midY: (a.clientY + b.clientY) / 2 - rect.top,
      };
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const info = touchInfo(event.touches);
      if (!info || info.dist < 1) return;
      event.preventDefault();
      gestureActive.current = true;
      const originX = el.scrollLeft + info.midX;
      const originY = el.scrollTop + info.midY;
      pinch = { startDist: info.dist, startMidX: info.midX, startMidY: info.midY, originX, originY, ratio: 1, dx: 0, dy: 0 };
      content.style.transformOrigin = `${originX}px ${originY}px`;
      content.style.willChange = "transform";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      const info = touchInfo(event.touches);
      if (!info) return;
      event.preventDefault();
      const raw = info.dist / pinch.startDist;
      pinch.ratio = clampZoom(zoom * raw) / zoom;
      pinch.dx = info.midX - pinch.startMidX;
      pinch.dy = info.midY - pinch.startMidY;
      content.style.transform = `translate(${pinch.dx}px, ${pinch.dy}px) scale(${pinch.ratio})`;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!pinch || event.touches.length >= 2) return;
      const { ratio, startMidX, startMidY, originX, originY, dx, dy } = pinch;
      pinch = null;
      content.style.transform = "";
      content.style.willChange = "";
      // The point that was under the fingers stays under where they ended up.
      commitZoom(zoom * ratio, originX, originY, startMidX + dx, startMidY + dy);
      window.setTimeout(() => {
        gestureActive.current = false;
      }, 50);
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      commitZoom(zoom * Math.exp(-event.deltaY * 0.01), el.scrollLeft + x, el.scrollTop + y, x, y);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [zoom, zoomable, commitZoom]);

  useEffect(
    () => () => {
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    },
    [],
  );

  /** Single tap toggles chrome (after the double-tap window); double tap zooms around the point. */
  const onClick = (event: React.MouseEvent) => {
    if (gestureActive.current) return;
    // A tap that ends a text selection must not toggle anything.
    if (window.getSelection()?.toString()) return;
    const el = scrollerRef.current;
    const now = Date.now();
    const previous = lastTap.current;
    if (
      zoomable &&
      el &&
      previous &&
      now - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < DOUBLE_TAP_SLOP_PX
    ) {
      lastTap.current = null;
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      commitZoom(zoom > 1.2 ? 1 : DOUBLE_TAP_ZOOM, el.scrollLeft + x, el.scrollTop + y, x, y);
      return;
    }
    lastTap.current = { time: now, x: event.clientX, y: event.clientY };
    if (!onTap) return;
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(
      () => {
        tapTimer.current = null;
        onTap();
      },
      zoomable ? DOUBLE_TAP_MS : 0,
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage: (index: number, offsetPts = 0) => {
        const el = scrollerRef.current;
        const top = layout.tops[index];
        const page = pages[index];
        if (!el || top === undefined || !page) return;
        const scale = (layout.widths[index] ?? 0) / page.width;
        // Content y = insetTop + page top; the target lands right under the overlaid chrome.
        el.scrollTo({ top: top + offsetPts * scale - gap });
      },
      scrollToFraction: (fraction: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollTop = Math.min(1, Math.max(0, fraction)) * Math.max(0, el.scrollHeight - el.clientHeight);
      },
    }),
    [layout, gap, pages],
  );

  const items = [];
  if (win && win.layout === layout && fitWidth > 0) {
    const assigned = assignSlots(slots.current, win.window);
    for (let i = win.window.first; i <= win.window.last; i++) {
      const width = layout.widths[i] ?? 0;
      const prefetch = i < win.visible.first || i > win.visible.last;
      items.push(
        <PageView
          key={assigned.get(i)}
          doc={doc}
          index={i}
          top={insetTop + (layout.tops[i] ?? 0)}
          left={(contentWidth - width) / 2}
          width={width}
          height={layout.heights[i] ?? 0}
          maxPixels={maxPixels}
          rotation={rotation}
          night={night}
          textLayer={textLayer && rotation === 0 && !prefetch}
          highlights={highlights?.get(i)}
          label={t("viewer.pageLabel", { page: i + 1 })}
          active={activePage === i}
          prefetch={prefetch}
          {...(onPageClick ? { onClick: onPageClick } : {})}
        />,
      );
    }
  }

  return (
    <div
      ref={scrollerRef}
      data-testid={testId}
      data-zoom={zoom.toFixed(2)}
      aria-label={ariaLabel}
      role="region"
      tabIndex={0}
      onClick={onClick}
      className="selis-viewer-scroller relative h-full w-full overflow-auto bg-page-canvas outline-none"
    >
      <div ref={contentRef} className="relative" style={{ width: contentWidth, height: contentHeight }}>
        {items}
      </div>
    </div>
  );
});
