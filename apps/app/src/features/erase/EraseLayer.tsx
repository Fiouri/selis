/**
 * The Erase tool over one page (ADR 0033). What is drawn here is exactly what
 * "Apply" erases: brush strokes as chains of squares and rectangles, filled
 * with the colour that will be painted, hatched while pending. In object mode
 * a tap outlines the topmost page object under the finger and a long press
 * steps to the next one underneath. With the eyedropper armed a tap picks the
 * fill colour. Two fingers move and zoom the page (the viewer handles them).
 */
import type { DocHandle, PageObjectInfo, Point } from "@selis/engine";
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import type { EditSession } from "../annotate/session";
import { newStrokeId, selectedObject, strokeCommand, useEraseState, WHITE } from "./eraseState";
import { BRUSH_PX, boxOf, brushRects, clipRect, objectsAt, rectsPath } from "./geometry";

/** A long press, in ms; moving farther than SLOP_PX first makes it a drag. */
const LONG_PRESS_MS = 500;
const SLOP_PX = 8;
/** A rectangle smaller than this (points) is a slip, not an area. */
const MIN_BOX_PT = 3;
/** How far from an object's bounds a tap still picks it, in screen pixels. */
const PICK_PX = 8;

type Gesture =
  | { kind: "brush"; pointerId: number; points: Point[] }
  | { kind: "rect"; pointerId: number; start: Point; end: Point }
  | { kind: "tap"; pointerId: number; at: Point; client: Point; timer: number | null; long: boolean };

type Props = { doc: DocHandle; index: number; scale: number; session: EditSession };

export function EraseLayer({ doc, index, scale, session }: Props) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const mode = useEraseState((s) => s.mode);
  const brush = useEraseState((s) => s.brush);
  const fill = useEraseState((s) => s.fill);
  const picked = useEraseState((s) => s.picked);
  const picking = useEraseState((s) => s.picking);
  const strokes = useEraseState((s) => s.strokes);
  const selection = useEraseState((s) => s.selection);
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Set<number>());
  const objects = useRef<Promise<PageObjectInfo[]> | null>(null);
  const [draft, setDraft] = useState<Gesture | null>(null);
  const page = doc.pages[index];

  const run = useCallback(
    (command: Parameters<EditSession["run"]>[0]) => {
      session.run(command).catch((err: unknown) => {
        console.warn("selis: erase stroke failed", err);
        showToast(t("annotate.failed"), "error");
      });
    },
    [session, showToast, t],
  );

  if (!page) return null;

  const toPage = (clientX: number, clientY: number): Point => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || scale <= 0) return { x: 0, y: 0 };
    return {
      x: Math.min(page.width, Math.max(0, (clientX - rect.left) / scale)),
      y: Math.min(page.height, Math.max(0, (clientY - rect.top) / scale)),
    };
  };

  const pageObjects = (): Promise<PageObjectInfo[]> => {
    objects.current ??= doc.pageObjects(index).catch((err: unknown) => {
      console.warn("selis: page objects unavailable", err);
      objects.current = null;
      return [];
    });
    return objects.current;
  };

  const pickColor = async (at: Point) => {
    try {
      useEraseState.getState().setPicked(await doc.sampleColor(index, [{ x: at.x, y: at.y, width: 0, height: 0 }]));
    } catch (err) {
      console.warn("selis: colour pick failed", err);
      showToast(t("erase.pickFailed"), "error");
    }
  };

  const select = async (at: Point, step: boolean) => {
    const state = useEraseState.getState();
    const current = state.selection;
    if (step && current?.page === index && current.candidates.length > 1) {
      state.select({ ...current, at: (current.at + 1) % current.candidates.length });
      return;
    }
    const candidates = objectsAt(await pageObjects(), at, PICK_PX / scale);
    state.select(candidates.length > 0 ? { page: index, candidates, at: 0 } : null);
  };

  const finishStroke = async (rects: ReturnType<typeof brushRects>) => {
    if (rects.length === 0) return;
    let color = fill === "pick" ? (picked ?? WHITE) : WHITE;
    if (fill === "match") {
      try {
        color = await doc.sampleColor(index, rects);
      } catch (err) {
        console.warn("selis: background sample failed", err);
      }
    }
    run(strokeCommand({ id: newStrokeId(), page: index, rects, fill: color }));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      touches.current.add(event.pointerId);
      if (touches.current.size > 1) {
        const g = gesture.current;
        if (g?.kind === "tap" && g.timer !== null) window.clearTimeout(g.timer);
        gesture.current = null;
        setDraft(null);
        return;
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const p = toPage(event.clientX, event.clientY);
    let next: Gesture;
    if (mode === "object" || picking) {
      const g: Extract<Gesture, { kind: "tap" }> = {
        kind: "tap",
        pointerId: event.pointerId,
        at: p,
        client: { x: event.clientX, y: event.clientY },
        timer: null,
        long: false,
      };
      if (mode === "object" && !picking) {
        g.timer = window.setTimeout(() => {
          g.timer = null;
          g.long = true;
          void select(g.at, true);
        }, LONG_PRESS_MS);
      }
      next = g;
    } else if (mode === "brush") {
      next = { kind: "brush", pointerId: event.pointerId, points: [p] };
    } else {
      next = { kind: "rect", pointerId: event.pointerId, start: p, end: p };
    }
    gesture.current = next;
    setDraft(next.kind === "tap" ? null : next);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    if (g.kind === "tap") {
      if (g.timer !== null && Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) > SLOP_PX) {
        window.clearTimeout(g.timer);
        g.timer = null;
      }
      return;
    }
    const p = toPage(event.clientX, event.clientY);
    if (g.kind === "brush") g.points.push(p);
    else g.end = p;
    setDraft({ ...g });
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDraft(null);
    if (g.kind === "tap" && g.timer !== null) window.clearTimeout(g.timer);
    if (event.type === "pointercancel") return;
    if (g.kind === "tap") {
      if (picking) void pickColor(g.at);
      else if (!g.long) void select(g.at, false);
      return;
    }
    if (g.kind === "brush") {
      void finishStroke(brushRects(g.points, BRUSH_PX[brush] / scale, page));
      return;
    }
    const box = clipRect(boxOf(g.start, g.end), page);
    if (box && box.width >= MIN_BOX_PT && box.height >= MIN_BOX_PT) void finishStroke([box]);
  };

  const pending = strokes.filter((s) => s.page === index);
  const draftRects =
    draft?.kind === "brush" ? brushRects(draft.points, BRUSH_PX[brush] / scale, page) : draft?.kind === "rect" ? [boxOf(draft.start, draft.end)] : [];
  const draftFill = fill === "pick" ? (picked ?? WHITE) : WHITE;
  const chosen = selection?.page === index ? selectedObject(selection) : null;
  const hatch = `erase-hatch-${index}`;

  return (
    <div
      ref={layerRef}
      className="absolute inset-0"
      style={{ touchAction: "none", cursor: picking ? "copy" : mode === "object" ? "pointer" : "crosshair" }}
      data-testid={`erase-layer-${index + 1}`}
      data-picking={picking ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={(e) => e.stopPropagation()}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <pattern id={hatch} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" className="stroke-danger-9" strokeWidth="2" strokeOpacity="0.45" />
          </pattern>
        </defs>
        {pending.map((s) => (
          <g key={s.id} data-testid="erase-stroke" data-fill={s.fill}>
            <path d={rectsPath(s.rects, scale)} fill={s.fill} />
            <path d={rectsPath(s.rects, scale)} fill={`url(#${hatch})`} />
          </g>
        ))}
        {draftRects.length > 0 ? (
          <g data-testid="erase-draft">
            <path d={rectsPath(draftRects, scale)} fill={draftFill} />
            <path d={rectsPath(draftRects, scale)} fill={`url(#${hatch})`} />
          </g>
        ) : null}
        {chosen ? (
          <g data-testid="erase-selection" data-kind={chosen.kind}>
            <rect
              x={chosen.rect.x * scale - 3}
              y={chosen.rect.y * scale - 3}
              width={chosen.rect.width * scale + 6}
              height={chosen.rect.height * scale + 6}
              fill="none"
              stroke="white"
              strokeWidth="4"
            />
            <rect
              x={chosen.rect.x * scale - 3}
              y={chosen.rect.y * scale - 3}
              width={chosen.rect.width * scale + 6}
              height={chosen.rect.height * scale + 6}
              className="fill-danger-9/10 stroke-danger-9"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
