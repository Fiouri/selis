import { type DeviceRect, type DocHandle, EngineError, type QuarterTurns, type RenderPlan, type Tile, TILE_SIZE, visibleTiles } from "@selis/engine";
import { memo, useEffect, useEffectEvent, useRef } from "react";
import type { ViewportBus } from "./viewport";

/** Visible tiles are requested; drawn ones are kept while their cell is this close (device px). */
const KEEP_MARGIN = 256;
/**
 * Tiles are drawn into canvases of this many device px (2 × 2 tiles): every canvas is a
 * compositor layer, and ~65 small ones cost the AVD ~10 fps while scrolling at 100 %.
 */
const CELL_SIZE = TILE_SIZE * 2;
/**
 * New tiles are requested once scrolling has paused this long: rendering them during a
 * fling competes with scrolling for the CPU (the base shows meanwhile).
 */
const SCROLL_IDLE_MS = 50;

type Props = {
  doc: DocHandle;
  index: number;
  plan: RenderPlan;
  rotation: QuarterTurns;
  night: boolean;
  dpr: number;
  /** The page box in content coordinates (CSS px). */
  boxLeft: number;
  boxTop: number;
  viewport: ViewportBus;
  /** Bumps when the page's content changes. */
  revision: number;
  /** Visible tiles drawn / visible tiles at `scale`, after every change. */
  onProgress: (scale: number, drawn: number, visible: number) => void;
};

type Entry = { tile: Tile; controller: AbortController; drawn: boolean };
type Cell = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };

/**
 * Released cell canvases, kept for the next cells: a new canvas backing store is a costly
 * allocation in the WebView (the viewer recycles its page canvases for the same reason).
 * Every cell is CELL_SIZE square; the page box clips the ones at its edges. Freed once no
 * page is tiled for a few seconds.
 */
const POOL_MAX = 16;
const POOL_TRIM_MS = 4000;
const pool: Cell[] = [];
let layers = 0;
let trimTimer = 0;

function takeCell(): Cell | null {
  const reused = pool.pop();
  if (reused) {
    reused.context.clearRect(0, 0, CELL_SIZE, CELL_SIZE);
    return reused;
  }
  const canvas = document.createElement("canvas");
  canvas.width = CELL_SIZE;
  canvas.height = CELL_SIZE;
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

function freeCanvas(cell: Cell): void {
  cell.canvas.width = 0;
  cell.canvas.height = 0;
}

function giveCell(cell: Cell): void {
  cell.canvas.remove();
  if (pool.length < POOL_MAX) pool.push(cell);
  else freeCanvas(cell);
}

function layerMounted(): void {
  layers++;
  window.clearTimeout(trimTimer);
}

function layerUnmounted(): void {
  layers--;
  if (layers > 0) return;
  trimTimer = window.setTimeout(() => {
    if (layers === 0) for (const cell of pool.splice(0)) freeCanvas(cell);
  }, POOL_TRIM_MS);
}

/** The key of the cell holding `tile`, as `visibleTiles(…, CELL_SIZE)` names it. */
const cellKey = (tile: DeviceRect) => `${String(Math.floor(tile.x / CELL_SIZE))},${String(Math.floor(tile.y / CELL_SIZE))}`;

/**
 * Full-resolution tiles over the visible part of a page whose whole bitmap would be
 * too large (ADR 0002 amendment). Tiles are rendered small (quick to finish after a
 * zoom) and drawn into larger cell canvases at exact device-pixel positions, so
 * nothing is resampled; tiles are the same pixels as a whole-page render, so their
 * edges do not show. Undrawn parts of a cell stay transparent over the base.
 * Managed imperatively: scrolling updates tiles without re-rendering React.
 */
export const TileLayer = memo(function TileLayer({
  doc,
  index,
  plan,
  rotation,
  night,
  dpr,
  boxLeft,
  boxTop,
  viewport,
  revision,
  onProgress,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const progress = useEffectEvent(onProgress);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || plan.scale <= 0) return;
    const entries = new Map<string, Entry>();
    const cells = new Map<string, Cell>();
    let disposed = false;
    let reportFrame = 0;
    let idleTimer = 0;

    /** The visible area on the page, in device px of the full-resolution bitmap. */
    const view = () => {
      const v = viewport.get();
      return { x: (v.left - boxLeft) * dpr, y: (v.top - boxTop) * dpr, width: v.width * dpr, height: v.height * dpr };
    };

    // Once per frame: a React update per tile would re-render the page box ~60 times after a zoom.
    const report = () => {
      if (reportFrame) return;
      reportFrame = requestAnimationFrame(() => {
        reportFrame = 0;
        const visible = visibleTiles(plan.deviceWidth, plan.deviceHeight, view());
        let drawn = 0;
        for (const tile of visible) if (entries.get(tile.key)?.drawn) drawn++;
        progress(plan.scale, drawn, visible.length);
      });
    };

    const cellFor = (tile: Tile): Cell | null => {
      const key = cellKey(tile);
      const existing = cells.get(key);
      if (existing) return existing;
      const x = Math.floor(tile.x / CELL_SIZE) * CELL_SIZE;
      const y = Math.floor(tile.y / CELL_SIZE) * CELL_SIZE;
      const cell = takeCell();
      if (!cell) return null;
      // Whole device pixels: the page box is snapped, so this lands 1:1 on the screen.
      const side = String(CELL_SIZE / dpr);
      cell.canvas.style.cssText = `position:absolute;left:${String(x / dpr)}px;top:${String(y / dpr)}px;width:${side}px;height:${side}px`;
      host.appendChild(cell.canvas);
      cells.set(key, cell);
      return cell;
    };

    const request = (tile: Tile) => {
      const controller = new AbortController();
      const entry: Entry = { tile, controller, drawn: false };
      entries.set(tile.key, entry);
      const draw = async () => {
        let image: ImageData;
        try {
          image = await doc.renderPageImage(index, plan.scale, { signal: controller.signal, rotation, night, rect: tile });
        } catch (err) {
          if (err instanceof EngineError && (err.code === "cancelled" || err.code === "closed")) return;
          console.warn(`selis: tile render failed for page ${String(index + 1)}`, err);
          entries.delete(tile.key);
          return;
        }
        if (disposed || controller.signal.aborted) return;
        const cell = cellFor(tile);
        if (!cell) return;
        const left = Math.floor(tile.x / CELL_SIZE) * CELL_SIZE;
        const top = Math.floor(tile.y / CELL_SIZE) * CELL_SIZE;
        cell.context.putImageData(image, tile.x - left, tile.y - top);
        entry.drawn = true;
        report();
      };
      void draw();
    };

    /** Drops tiles and cells that left the area; requests what is missing when `fill`. */
    const sync = (fill: boolean) => {
      if (viewport.get().gesture) return;
      const area = view();
      const keep = new Set(visibleTiles(plan.deviceWidth, plan.deviceHeight, area, KEEP_MARGIN, CELL_SIZE).map((t) => t.key));
      for (const [key, entry] of entries) {
        if (keep.has(cellKey(entry.tile))) continue;
        entry.controller.abort();
        entries.delete(key);
      }
      for (const [key, cell] of cells) {
        if (keep.has(key)) continue;
        giveCell(cell);
        cells.delete(key);
      }
      // While scrolling, nothing is reported: a React update per frame would cost the fling
      // frames. Progress is reported when the tiles are requested, before any lands.
      if (!fill) return;
      // Nearest the centre first: the worker renders visible-page jobs in request order.
      for (const tile of visibleTiles(plan.deviceWidth, plan.deviceHeight, area)) {
        if (!entries.has(tile.key)) request(tile);
      }
      report();
    };

    layerMounted();
    const unsubscribe = viewport.subscribe(() => {
      sync(false);
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => sync(true), SCROLL_IDLE_MS);
    });
    sync(true);
    return () => {
      disposed = true;
      unsubscribe();
      window.clearTimeout(idleTimer);
      if (reportFrame) cancelAnimationFrame(reportFrame);
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
      for (const cell of cells.values()) giveCell(cell);
      cells.clear();
      layerUnmounted();
    };
  }, [doc, index, plan, rotation, night, dpr, boxLeft, boxTop, viewport, revision]);

  return <div ref={hostRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />;
});
