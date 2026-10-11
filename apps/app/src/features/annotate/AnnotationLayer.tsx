/**
 * Input layer over one page in annotate mode. It turns pointer gestures into
 * annotations for the current tool and shows a live preview while drawing.
 *
 * Touch model (phone first):
 * - One finger (or the stylus) draws / selects / erases; two fingers move and
 *   zoom the page (handled by the viewer, which sees the touches bubble up).
 * - Palm rejection: once a stylus has been used, finger touches never draw:
 *   they move the page instead. Contacts wider than a fingertip are ignored.
 * - Text and note tools keep native scrolling: a tap places, a drag scrolls.
 *
 * Geometry is in page points (top-left, unrotated); annotate mode always shows
 * pages unrotated.
 */
import {
  type Annotation,
  annotationAt,
  type DocHandle,
  type Glyph,
  glyphAt,
  type PageRect,
  type Point,
  selectionRects,
  simplifyStroke,
  strokesBounds,
  unionRect,
} from "@selis/engine";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import type { EditSession } from "./session";
import { NoteEditor, TextEditor } from "./PageEditors";
import { usePageAnnotations } from "./usePageAnnotations";
import {
  addCommand,
  COLORS,
  HIGHLIGHT_OPACITY,
  newAnnotationId,
  removeCommand,
  replaceCommand,
  type Tool,
  useTools,
} from "./tools";

/** A contact wider than this (CSS px) is a palm, not a fingertip. */
const PALM_PX = 40;
/** Movement (CSS px) after which a tap is a drag. */
const TAP_SLOP_PX = 8;
/** Typed text boxes start this wide (points), capped by the page edge. */
const TEXT_BOX_PT = 220;
/** Sticky note icon size (points). */
const NOTE_PT = 20;

let stylusSeen = false;

/** Glyphs per page, loaded once per open document. */
const glyphCache = new WeakMap<DocHandle, Map<number, Promise<readonly Glyph[]>>>();
function loadGlyphs(doc: DocHandle, index: number): Promise<readonly Glyph[]> {
  let pages = glyphCache.get(doc);
  if (!pages) {
    pages = new Map();
    glyphCache.set(doc, pages);
  }
  let glyphs = pages.get(index);
  if (!glyphs) {
    glyphs = doc.glyphs(index).catch(() => []);
    pages.set(index, glyphs);
  }
  return glyphs;
}

type Gesture =
  | { kind: "markup"; pointerId: number; glyphs: readonly Glyph[] | null; from: number; to: number }
  | { kind: "pen"; pointerId: number; points: Point[] }
  | { kind: "shape"; pointerId: number; start: Point; end: Point }
  | { kind: "erase"; pointerId: number; erased: Set<string> }
  | { kind: "tap"; pointerId: number; start: Point; client: { x: number; y: number }; moved: boolean }
  | { kind: "pan"; pointerId: number; x: number; y: number };

type Editor =
  | { kind: "text"; at: Point; tool: Tool }
  | { kind: "note"; at: Point; tool: Tool; existing: Extract<Annotation, { kind: "note" }> | null };

/** Pointer events with coalesced samples where the WebView has them. */
type CoalescingEvent = Omit<PointerEvent, "getCoalescedEvents"> & { getCoalescedEvents?: () => PointerEvent[] };

type Props = {
  doc: DocHandle;
  index: number;
  /** CSS px per page point. */
  scale: number;
  session: EditSession;
};

export function AnnotationLayer({ doc, index, scale, session }: Props) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const tool = useTools((s) => s.tool);
  const shape = useTools((s) => s.shape);
  const colorName = useTools((s) => s.colors[s.tool]);
  const thickness = useTools((s) => s.thickness);
  const fontSize = useTools((s) => s.fontSize);
  const color = COLORS[colorName];
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Set<number>());
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [openEditor, setEditor] = useState<Editor | null>(null);
  // An editor belongs to the tool that opened it; switching tools drops it.
  const editor = openEditor?.tool === tool ? openEditor : null;
  const annotations = usePageAnnotations(doc, index, tool === "eraser" || tool === "note");
  const page = doc.pages[index];

  // Warm the glyphs up front: the first drag must not wait for them.
  useEffect(() => {
    if (tool === "highlight" || tool === "underline" || tool === "strikeout") void loadGlyphs(doc, index);
  }, [doc, index, tool]);

  const run = useCallback(
    (command: Parameters<EditSession["run"]>[0]) => {
      session.run(command).catch((err: unknown) => {
        console.warn("selis: annotation failed", err);
        showToast(t("annotate.failed"), "error");
      });
    },
    [session, showToast, t],
  );

  if (!page) return null;

  const toPage = (clientX: number, clientY: number): Point => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || scale <= 0) return { x: 0, y: 0 };
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;
    return { x: Math.min(page.width, Math.max(0, x)), y: Math.min(page.height, Math.max(0, y)) };
  };

  const cancel = () => {
    gesture.current = null;
    setPreview(null);
  };

  const eraseAt = (g: Extract<Gesture, { kind: "erase" }>, p: Point) => {
    const hit = annotationAt(
      annotations.filter((a) => !g.erased.has(a.id)),
      p,
      Math.max(6, 10 / scale),
    );
    if (!hit) return;
    g.erased.add(hit.id);
    run(removeCommand(doc, hit, "eraser"));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const isTouch = event.pointerType === "touch";
    if (event.pointerType === "pen") stylusSeen = true;
    if (isTouch && (event.width > PALM_PX || event.height > PALM_PX)) return;
    if (isTouch) {
      touches.current.add(event.pointerId);
      // A second finger: this is a pan / pinch for the viewer, not a stroke.
      if (touches.current.size > 1) {
        cancel();
        return;
      }
    }
    if (editor) return;
    const p = toPage(event.clientX, event.clientY);
    const tapTool = tool === "text" || tool === "note";
    if (isTouch && stylusSeen && !tapTool) {
      gesture.current = { kind: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tapTool) {
      // No compatibility mousedown: it would move focus to the scroller and take
      // it from the editor this tap opens (scrolling is up to touch-action).
      event.preventDefault();
      gesture.current = { kind: "tap", pointerId: event.pointerId, start: p, client: { x: event.clientX, y: event.clientY }, moved: false };
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    let next: Gesture;
    switch (tool) {
      case "highlight":
      case "underline":
      case "strikeout": {
        const g: Extract<Gesture, { kind: "markup" }> = { kind: "markup", pointerId: event.pointerId, glyphs: null, from: -1, to: -1 };
        void (async () => {
          const glyphs = await loadGlyphs(doc, index);
          if (gesture.current !== g) return;
          g.glyphs = glyphs;
          g.from = glyphAt(glyphs, p);
          g.to = g.from;
          setPreview({ ...g });
        })();
        next = g;
        break;
      }
      case "pen":
        next = { kind: "pen", pointerId: event.pointerId, points: [p] };
        break;
      case "shapes":
        next = { kind: "shape", pointerId: event.pointerId, start: p, end: p };
        break;
      default: {
        const g: Extract<Gesture, { kind: "erase" }> = { kind: "erase", pointerId: event.pointerId, erased: new Set() };
        eraseAt(g, p);
        next = g;
      }
    }
    gesture.current = next;
    setPreview(next);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    switch (g.kind) {
      case "pan": {
        const scroller = layerRef.current?.closest(".selis-viewer-scroller");
        scroller?.scrollBy(g.x - event.clientX, g.y - event.clientY);
        g.x = event.clientX;
        g.y = event.clientY;
        return;
      }
      case "tap":
        if (Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) > TAP_SLOP_PX) g.moved = true;
        return;
      case "pen": {
        // Coalesced events: the stylus reports far more points than frames.
        const samples = (event.nativeEvent as unknown as CoalescingEvent).getCoalescedEvents?.() ?? [];
        for (const e of samples.length > 0 ? samples : [event.nativeEvent]) g.points.push(toPage(e.clientX, e.clientY));
        setPreview({ ...g, points: g.points.slice() });
        return;
      }
      case "shape":
        g.end = toPage(event.clientX, event.clientY);
        setPreview({ ...g });
        return;
      case "markup":
        if (!g.glyphs || g.from < 0) return;
        g.to = glyphAt(g.glyphs, toPage(event.clientX, event.clientY));
        if (g.to < 0) g.to = g.from;
        setPreview({ ...g });
        return;
      case "erase":
        eraseAt(g, toPage(event.clientX, event.clientY));
        return;
    }
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (event.type === "pointercancel") return;
    const base = { page: index, color, opacity: 1 };
    switch (g.kind) {
      case "markup": {
        if (!g.glyphs) return;
        const segments = selectionRects(g.glyphs, g.from, g.to);
        const rect = unionRect(segments);
        if (!rect) return;
        const kind = tool === "underline" ? "underline" : tool === "strikeout" ? "strikeout" : "highlight";
        const annotation: Annotation = {
          ...base,
          id: newAnnotationId(kind),
          kind,
          rect,
          segments,
          opacity: kind === "highlight" ? HIGHLIGHT_OPACITY : 1,
        };
        run(addCommand(doc, annotation, tool));
        return;
      }
      case "pen": {
        const points = simplifyStroke(g.points, 0.25);
        const rect = strokesBounds([points], thickness);
        if (!rect) return;
        run(addCommand(doc, { ...base, id: newAnnotationId("ink"), kind: "ink", rect, width: thickness, strokes: [points] }, "pen"));
        return;
      }
      case "shape": {
        const annotation = shapeAnnotation(shape, g.start, g.end, { ...base, width: thickness });
        if (annotation) run(addCommand(doc, annotation, "shapes"));
        return;
      }
      case "tap": {
        if (g.moved) return;
        const hit =
          tool === "note"
            ? annotations.find(
                (a): a is Extract<Annotation, { kind: "note" }> => a.kind === "note" && annotationAt([a], g.start, 6) !== null,
              )
            : undefined;
        // Render and focus within this tap: Android only opens the keyboard for
        // a focus that happens during the user's gesture.
        flushSync(() => {
          if (tool === "text") setEditor({ kind: "text", at: g.start, tool });
          else setEditor({ kind: "note", at: hit ? { x: hit.rect.x, y: hit.rect.y } : g.start, tool, existing: hit ?? null });
        });
        layerRef.current?.querySelector("textarea")?.focus();
        return;
      }
      case "erase":
      case "pan":
        return;
    }
  };

  const addText = (text: string) => {
    if (editor?.kind !== "text") return;
    setEditor(null);
    if (text.trim() === "") return;
    const width = Math.max(40, Math.min(TEXT_BOX_PT, page.width - editor.at.x - 4));
    const annotation: Annotation = {
      id: newAnnotationId("text"),
      page: index,
      kind: "text",
      rect: { x: editor.at.x, y: editor.at.y, width, height: fontSize * 1.4 },
      color,
      opacity: 1,
      text,
      fontSize,
    };
    run(addCommand(doc, annotation, "text"));
  };

  const saveNote = (text: string) => {
    if (editor?.kind !== "note") return;
    setEditor(null);
    const { existing, at } = editor;
    if (existing) {
      if (text !== existing.text) run(replaceCommand(doc, existing, { ...existing, text }, "note"));
      return;
    }
    if (text.trim() === "") return;
    const half = NOTE_PT / 2;
    const rect: PageRect = {
      x: Math.min(page.width - NOTE_PT, Math.max(0, at.x - half)),
      y: Math.min(page.height - NOTE_PT, Math.max(0, at.y - half)),
      width: NOTE_PT,
      height: NOTE_PT,
    };
    run(addCommand(doc, { id: newAnnotationId("note"), page: index, kind: "note", rect, color, opacity: 1, text }, "note"));
  };

  const deleteNote = () => {
    if (editor?.kind !== "note" || !editor.existing) return;
    const existing = editor.existing;
    setEditor(null);
    run(removeCommand(doc, existing, "note"));
  };

  const tapTool = tool === "text" || tool === "note";
  return (
    <div
      ref={layerRef}
      className="absolute inset-0"
      style={{ touchAction: tapTool ? "pan-x pan-y" : "none", cursor: tool === "eraser" ? "cell" : "crosshair" }}
      data-testid={`annotation-layer-${index + 1}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      // Taps here must not toggle the viewer chrome or zoom.
      onClick={(e) => e.stopPropagation()}
    >
      <Preview gesture={preview} scale={scale} tool={tool} shape={shape} color={color} thickness={thickness} />
      {editor?.kind === "text" ? (
        <TextEditor
          left={editor.at.x * scale}
          top={editor.at.y * scale}
          width={Math.max(40, Math.min(TEXT_BOX_PT, page.width - editor.at.x - 4)) * scale}
          fontSize={fontSize * scale}
          color={color}
          onDone={addText}
          onCancel={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === "note" ? (
        <NoteEditor
          anchorLeft={editor.at.x * scale}
          anchorTop={(editor.at.y + NOTE_PT) * scale}
          pageWidth={page.width * scale}
          initial={editor.existing?.text ?? ""}
          canDelete={editor.existing !== null}
          onSave={saveNote}
          onDelete={deleteNote}
          onCancel={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

function shapeAnnotation(
  shape: "square" | "circle" | "line" | "arrow",
  start: Point,
  end: Point,
  base: { page: number; color: string; opacity: number; width: number },
): Annotation | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return null;
  if (shape === "line" || shape === "arrow") {
    const pad = base.width * 2 + 4;
    const rect = {
      x: Math.min(start.x, end.x) - pad,
      y: Math.min(start.y, end.y) - pad,
      width: Math.abs(end.x - start.x) + 2 * pad,
      height: Math.abs(end.y - start.y) + 2 * pad,
    };
    return { ...base, id: newAnnotationId(shape), kind: shape, rect, start, end };
  }
  const rect = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
  return { ...base, id: newAnnotationId(shape), kind: shape, rect, fill: null };
}

/** Live preview of the gesture in progress (CSS px). */
function Preview({
  gesture,
  scale,
  tool,
  shape,
  color,
  thickness,
}: {
  gesture: Gesture | null;
  scale: number;
  tool: Tool;
  shape: "square" | "circle" | "line" | "arrow";
  color: string;
  thickness: number;
}) {
  if (!gesture) return null;
  const s = (v: number) => v * scale;
  let body = null;
  if (gesture.kind === "pen" && gesture.points.length > 0) {
    const d = gesture.points.map((p, i) => `${i === 0 ? "M" : "L"}${s(p.x).toFixed(1)} ${s(p.y).toFixed(1)}`).join(" ");
    body = <path d={d} fill="none" stroke={color} strokeWidth={Math.max(1, s(thickness))} strokeLinecap="round" strokeLinejoin="round" />;
  } else if (gesture.kind === "shape") {
    const { start, end } = gesture;
    const w = Math.max(1, s(thickness));
    if (shape === "line" || shape === "arrow") {
      body = <line x1={s(start.x)} y1={s(start.y)} x2={s(end.x)} y2={s(end.y)} stroke={color} strokeWidth={w} strokeLinecap="round" />;
    } else {
      const x = s(Math.min(start.x, end.x));
      const y = s(Math.min(start.y, end.y));
      const width = s(Math.abs(end.x - start.x));
      const height = s(Math.abs(end.y - start.y));
      body =
        shape === "square" ? (
          <rect x={x} y={y} width={width} height={height} fill="none" stroke={color} strokeWidth={w} />
        ) : (
          <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} fill="none" stroke={color} strokeWidth={w} />
        );
    }
  } else if (gesture.kind === "markup" && gesture.glyphs) {
    const rects = selectionRects(gesture.glyphs, gesture.from, gesture.to);
    body = (
      <>
        {rects.map((r, i) => {
          const box = { x: s(r.x), y: s(r.y), width: s(r.width), height: s(r.height) };
          if (tool === "highlight") return <rect key={i} {...box} fill={color} opacity={HIGHLIGHT_OPACITY} />;
          const lineY = tool === "underline" ? box.y + box.height - 1 : box.y + box.height / 2;
          return <line key={i} x1={box.x} x2={box.x + box.width} y1={lineY} y2={lineY} stroke={color} strokeWidth={Math.max(1.5, s(1))} />;
        })}
      </>
    );
  }
  if (!body) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true" data-testid="annotation-preview">
      {body}
    </svg>
  );
}
