/**
 * Pages grid per docs/design/p1-ui-brief.md §4: 3 columns, gap 16 × 14,
 * thumbnails 148 high (radius 4); selected = 2 px accent ring (box-shadow, no
 * layout shift) + 22 px check badge; page number below, accent + 600 when
 * selected. Virtualized (a 1000-page document mounts a few rows), thumbnails
 * rendered by the engine and cached per page.
 *
 * Reorder: long-press a page and drag it (or the selection, if it is part of
 * it); a bar marks where it lands; the list scrolls near its edges.
 */
import { type DocHandle, EngineError } from "@selis/engine";
import { Check } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const COLUMNS = 3;
const ROW_GAP = 16;
const COL_GAP = 14;
const SIDE = 20;
const THUMB_H = 148;
/** Number under the thumbnail: 6 px gap + 18 px line. */
const LABEL_H = 24;
const ROW_H = THUMB_H + LABEL_H;
const OVERSCAN_ROWS = 2;
const LONG_PRESS_MS = 400;
const SLOP_PX = 8;
const EDGE_PX = 64;
/** Thumbnails kept as object URLs (each a few KB). */
const CACHE_PAGES = 90;

type Props = {
  doc: DocHandle;
  /** Bumped by every structural change: thumbnails are redrawn. */
  structure: number;
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  /** Moves `pages` so they land in the gap `slot` (0…n). */
  onMove: (pages: number[], slot: number) => void;
  insetTop: number;
  insetBottom: number;
};

/** Small LRU of thumbnail object URLs, per document structure. */
function useThumbnails(doc: DocHandle, structure: number) {
  const cache = useRef(new Map<string, string>());
  useEffect(() => {
    const urls = cache.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [doc]);
  // Bitmaps of an older structure are wrong (pages moved, rotated, removed).
  useEffect(() => {
    const urls = cache.current;
    for (const [key, url] of urls) {
      if (!key.startsWith(`${structure}:`)) {
        URL.revokeObjectURL(url);
        urls.delete(key);
      }
    }
  }, [structure]);
  return useCallback(
    (index: number) => ({
      get: () => cache.current.get(`${structure}:${index}`) ?? null,
      put: (url: string) => {
        const urls = cache.current;
        urls.set(`${structure}:${index}`, url);
        while (urls.size > CACHE_PAGES) {
          const [oldest, value] = urls.entries().next().value as [string, string];
          URL.revokeObjectURL(value);
          urls.delete(oldest);
        }
      },
    }),
    [structure],
  );
}

function Thumb({
  doc,
  index,
  width,
  slot,
}: {
  doc: DocHandle;
  index: number;
  width: number;
  slot: { get: () => string | null; put: (url: string) => void };
}) {
  const [url, setUrl] = useState<string | null>(() => slot.get());
  useEffect(() => {
    if (slot.get()) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const thumb = await doc.renderThumbnail(index, Math.round(width * dpr), Math.round(THUMB_H * dpr), { signal: controller.signal });
        if (controller.signal.aborted) return;
        const made = URL.createObjectURL(new Blob([thumb.bytes], { type: thumb.mime }));
        slot.put(made);
        setUrl(made);
      } catch (err) {
        if (err instanceof EngineError && (err.code === "cancelled" || err.code === "closed")) return;
        console.warn(`selis: no thumbnail for page ${index + 1}`, err);
      }
    })();
    return () => controller.abort();
  }, [doc, index, width, slot]);
  return url ? (
    <img src={url} alt="" draggable={false} className="max-h-full max-w-full rounded-[2px] bg-white shadow-1" />
  ) : (
    <span className="h-full w-[70%] rounded-[2px] bg-neutral-4" aria-hidden="true" />
  );
}

type Drag = {
  pointerId: number;
  pages: number[];
  x: number;
  y: number;
  slot: number;
  from: number;
};

export function PagesGrid({ doc, structure, selected, onToggle, onMove, insetTop, insetBottom }: Props) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<{ pointerId: number; index: number; x: number; y: number; timer: number } | null>(null);
  const thumbnails = useThumbnails(doc, structure);
  const count = doc.pageCount;
  const cellW = Math.max(0, (width - 2 * SIDE - (COLUMNS - 1) * COL_GAP) / COLUMNS);
  const rows = Math.ceil(count / COLUMNS);
  const contentH = insetTop + 12 + rows * ROW_H + Math.max(0, rows - 1) * ROW_GAP + insetBottom;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const onScroll = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    el.addEventListener("scroll", onScroll, { passive: true });
    // While dragging, a finger must move the page, not scroll the list.
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  const top0 = insetTop + 12;
  const cellLeft = (col: number) => SIDE + col * (cellW + COL_GAP);
  const cellTop = (row: number) => top0 + row * (ROW_H + ROW_GAP);

  /** The gap (0…n) nearest to a point in content coordinates. */
  const slotAt = (x: number, y: number) => {
    const row = Math.max(0, Math.min(rows - 1, Math.floor((y - top0 + ROW_GAP / 2) / (ROW_H + ROW_GAP))));
    const col = Math.max(0, Math.min(COLUMNS - 1, Math.floor((x - SIDE + COL_GAP / 2) / (cellW + COL_GAP))));
    const before = x > cellLeft(col) + cellW / 2 ? 1 : 0;
    return Math.max(0, Math.min(count, row * COLUMNS + col + before));
  };

  // Auto-scroll near the edges while dragging.
  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const tick = () => {
      const el = scrollerRef.current;
      const d = dragRef.current;
      if (el && d) {
        const rect = el.getBoundingClientRect();
        const up = d.y - rect.top - insetTop;
        const down = rect.bottom - insetBottom - d.y;
        if (up < EDGE_PX) el.scrollTop -= Math.ceil((EDGE_PX - up) / 6);
        else if (down < EDGE_PX) el.scrollTop += Math.ceil((EDGE_PX - down) / 6);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [drag, insetTop, insetBottom]);

  const toContent = (clientX: number, clientY: number) => {
    const el = scrollerRef.current;
    const rect = el?.getBoundingClientRect();
    return rect && el ? { x: clientX - rect.left, y: clientY - rect.top + el.scrollTop } : { x: 0, y: 0 };
  };

  const indexOf = (e: { currentTarget: HTMLElement }) => Number(e.currentTarget.dataset.index);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const index = indexOf(e);
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    const timer = window.setTimeout(() => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      target.setPointerCapture(pointerId);
      const pages = selected.has(index) ? [...selected].sort((a, b) => a - b) : [index];
      const c = toContent(p.x, p.y);
      const next = { pointerId, pages, x: p.x, y: p.y, slot: slotAt(c.x, c.y), from: index };
      dragRef.current = next;
      setDrag(next);
      if ("vibrate" in navigator) navigator.vibrate(10);
    }, LONG_PRESS_MS);
    press.current = { pointerId, index, x: e.clientX, y: e.clientY, timer };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (p && p.pointerId === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) {
      // A scroll, not a long press.
      window.clearTimeout(p.timer);
      press.current = null;
    }
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const c = toContent(e.clientX, e.clientY);
    const next = { ...d, x: e.clientX, y: e.clientY, slot: slotAt(c.x, c.y) };
    dragRef.current = next;
    setDrag(next);
  };

  const endPress = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (p && p.pointerId === e.pointerId) {
      window.clearTimeout(p.timer);
      press.current = null;
      if (e.type === "pointerup") onToggle(p.index);
      return;
    }
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (e.type === "pointerup") onMove(d.pages, d.slot);
  };

  const firstRow = Math.max(0, Math.floor((viewport.top - top0) / (ROW_H + ROW_GAP)) - OVERSCAN_ROWS);
  const lastRow = Math.min(rows - 1, Math.ceil((viewport.top + viewport.height - top0) / (ROW_H + ROW_GAP)) + OVERSCAN_ROWS);
  const cells = [];
  if (cellW > 0) {
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = 0; col < COLUMNS; col++) {
        const index = row * COLUMNS + col;
        if (index >= count) break;
        const on = selected.has(index);
        const lifted = drag?.pages.includes(index) ?? false;
        cells.push(
          <li key={`${structure}:${index}`} className="absolute" style={{ left: cellLeft(col), top: cellTop(row), width: cellW, height: ROW_H }}>
            <button
              type="button"
              aria-pressed={on}
              aria-label={t("pages.pageLabel", { page: index + 1 })}
              data-index={index}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPress}
              onPointerCancel={endPress}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onToggle(index);
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
              className="selis-focus flex w-full flex-col items-center select-none [-webkit-touch-callout:none]"
              style={{ opacity: lifted ? 0.35 : 1 }}
              data-testid={`page-thumb-${index + 1}`}
            >
              <span
                className="relative flex w-full items-center justify-center rounded-[4px] bg-neutral-3 p-2 transition-shadow duration-150"
                style={{ height: THUMB_H, boxShadow: on ? "0 0 0 2px var(--accent-9)" : "none" }}
              >
                <Thumb doc={doc} index={index} width={cellW - 16} slot={thumbnails(index)} />
                {on ? (
                  <span className="absolute -top-1.5 -right-1.5 flex size-[22px] items-center justify-center rounded-full bg-accent-9 text-accent-contrast shadow-1" aria-hidden="true">
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                ) : null}
              </span>
              <span className={`mt-1.5 text-xs tabular-nums ${on ? "font-semibold text-accent-selected" : "text-neutral-11"}`}>{index + 1}</span>
            </button>
          </li>,
        );
      }
    }
  }

  // Where a drag would drop: a bar at the left edge of the slot's cell (or after the last).
  let marker = null;
  if (drag && cellW > 0) {
    const atEnd = drag.slot >= count;
    const index = atEnd ? count - 1 : drag.slot;
    const row = Math.floor(index / COLUMNS);
    const col = index % COLUMNS;
    const left = atEnd ? cellLeft(col) + cellW + COL_GAP / 2 : cellLeft(col) - COL_GAP / 2;
    marker = (
      <span
        aria-hidden="true"
        className="pointer-events-none absolute w-1 rounded-full bg-accent-9"
        style={{ left: left - 2, top: cellTop(row), height: THUMB_H }}
        data-testid="drop-marker"
      />
    );
  }

  return (
    <div ref={scrollerRef} className="h-full w-full overflow-y-auto bg-page-canvas" data-testid="pages-grid">
      <ul className="relative" style={{ height: contentH }} aria-label={t("pages.title")}>
        {cells}
        {marker}
      </ul>
      {drag ? (
        <span
          aria-hidden="true"
          className="pointer-events-none fixed z-30 flex items-center justify-center rounded-[4px] bg-accent-9 px-2 text-xs font-semibold text-accent-contrast shadow-3"
          style={{ left: drag.x + 12, top: drag.y - 12, height: 24 }}
          data-testid="drag-ghost"
        >
          {drag.pages.length > 1 ? `${drag.pages.length}` : drag.from + 1}
        </span>
      ) : null}
    </div>
  );
}
