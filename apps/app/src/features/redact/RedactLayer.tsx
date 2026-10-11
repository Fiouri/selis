/**
 * Redaction mode, over one page. Pending marks are drawn here (red outline;
 * black ones darkened, whiteouts white with their replacement text) and made
 * with the current tool:
 * - text: drag across text, the marks follow the selected lines;
 * - area: drag a box (text, images, drawings, anything under it);
 * - whiteout: drag a box, then type the text that replaces it (may be empty);
 * - eraser: tap or drag over marks to remove them.
 * Two fingers move and zoom the page (the viewer handles them).
 */
import { annotationAt, type DocHandle, type Glyph, glyphAt, type PageRect, type Point, selectionRects, unionRect } from "@selis/engine";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import { TextEditor } from "../annotate/PageEditors";
import type { EditSession } from "../annotate/session";
import { usePageAnnotations } from "../annotate/usePageAnnotations";
import { type Mark, markCommand, newMarkId, unmarkCommand, useRedactState } from "./redactState";

/** A box smaller than this (points) is a slip, not a mark. */
const MIN_BOX_PT = 4;

type Gesture =
  | { kind: "text"; pointerId: number; glyphs: readonly Glyph[] | null; from: number; to: number }
  | { kind: "box"; pointerId: number; start: Point; end: Point }
  | { kind: "erase"; pointerId: number; erased: Set<string> };

type Props = { doc: DocHandle; index: number; scale: number; session: EditSession };

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

function boxOf(a: Point, b: Point): PageRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function RedactLayer({ doc, index, scale, session }: Props) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const tool = useRedactState((s) => s.tool);
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Set<number>());
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [whiteout, setWhiteout] = useState<PageRect | null>(null);
  const marks = usePageAnnotations(doc, index, true).filter((a): a is Mark => a.kind === "redact");
  const page = doc.pages[index];

  useEffect(() => {
    if (tool === "text") void loadGlyphs(doc, index);
  }, [doc, index, tool]);

  const run = useCallback(
    (command: Parameters<EditSession["run"]>[0]) => {
      session.run(command).catch((err: unknown) => {
        console.warn("selis: redaction mark failed", err);
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

  const eraseAt = (g: Extract<Gesture, { kind: "erase" }>, p: Point) => {
    const hit = annotationAt(
      marks.filter((m) => !g.erased.has(m.id)),
      p,
      Math.max(4, 8 / scale),
    );
    if (!hit || hit.kind !== "redact") return;
    g.erased.add(hit.id);
    run(unmarkCommand(doc, hit));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      touches.current.add(event.pointerId);
      if (touches.current.size > 1) {
        gesture.current = null;
        setPreview(null);
        return;
      }
    }
    if (whiteout) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const p = toPage(event.clientX, event.clientY);
    let next: Gesture;
    if (tool === "text") {
      const g: Extract<Gesture, { kind: "text" }> = { kind: "text", pointerId: event.pointerId, glyphs: null, from: -1, to: -1 };
      void (async () => {
        const glyphs = await loadGlyphs(doc, index);
        if (gesture.current !== g) return;
        g.glyphs = glyphs;
        g.from = glyphAt(glyphs, p);
        g.to = g.from;
        setPreview({ ...g });
      })();
      next = g;
    } else if (tool === "eraser") {
      const g: Extract<Gesture, { kind: "erase" }> = { kind: "erase", pointerId: event.pointerId, erased: new Set() };
      eraseAt(g, p);
      next = g;
    } else {
      next = { kind: "box", pointerId: event.pointerId, start: p, end: p };
    }
    gesture.current = next;
    setPreview(next);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const p = toPage(event.clientX, event.clientY);
    if (g.kind === "text") {
      if (!g.glyphs || g.from < 0) return;
      g.to = glyphAt(g.glyphs, p);
      if (g.to < 0) g.to = g.from;
      setPreview({ ...g });
    } else if (g.kind === "box") {
      g.end = p;
      setPreview({ ...g });
    } else {
      eraseAt(g, p);
    }
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (event.type === "pointercancel") return;
    const base = { page: index, color: "#000000", opacity: 1, text: "" };
    if (g.kind === "text") {
      if (!g.glyphs) return;
      const segments = selectionRects(g.glyphs, g.from, g.to);
      const rect = unionRect(segments);
      if (!rect) return;
      run(markCommand(doc, { ...base, id: newMarkId(), kind: "redact", rect, segments, fill: "black" }));
      return;
    }
    if (g.kind !== "box") return;
    const rect = boxOf(g.start, g.end);
    if (rect.width < MIN_BOX_PT || rect.height < MIN_BOX_PT) return;
    if (tool === "whiteout") {
      // Ask for the replacement text within this gesture (Android opens the keyboard only then).
      flushSync(() => setWhiteout(rect));
      layerRef.current?.querySelector("textarea")?.focus();
      return;
    }
    run(markCommand(doc, { ...base, id: newMarkId(), kind: "redact", rect, segments: [rect], fill: "black" }));
  };

  const placeWhiteout = (text: string) => {
    if (!whiteout) return;
    const rect = whiteout;
    setWhiteout(null);
    run(
      markCommand(doc, {
        id: newMarkId(),
        page: index,
        kind: "redact",
        rect,
        segments: [rect],
        fill: "white",
        text: text.trim(),
        color: "#000000",
        opacity: 1,
      }),
    );
  };

  const draft =
    preview?.kind === "text" && preview.glyphs
      ? selectionRects(preview.glyphs, preview.from, preview.to)
      : preview?.kind === "box"
        ? [boxOf(preview.start, preview.end)]
        : whiteout
          ? [whiteout]
          : [];

  return (
    <div
      ref={layerRef}
      className="absolute inset-0"
      style={{ touchAction: "none", cursor: tool === "eraser" ? "cell" : "crosshair" }}
      data-testid={`redact-layer-${index + 1}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={(e) => e.stopPropagation()}
    >
      {marks.map((m) =>
        m.segments.map((r, i) => (
          <div
            key={`${m.id}:${i}`}
            className={`pointer-events-none absolute overflow-hidden border-[1.5px] border-danger-9 ${
              m.fill === "white" ? "border-dashed bg-paper" : "bg-note-ink/70"
            }`}
            style={{ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale }}
            data-testid="redact-mark"
          >
            {m.fill === "white" && m.text !== "" ? (
              <span
                className="block truncate px-0.5 leading-none text-note-ink"
                style={{ fontSize: Math.max(8, Math.min(24, (r.height - 4) / 1.36)) * scale, lineHeight: 1.36 }}
              >
                {m.text}
              </span>
            ) : null}
          </div>
        )),
      )}
      {draft.map((r, i) => (
        <div
          key={`draft:${i}`}
          className="pointer-events-none absolute border-[1.5px] border-dashed border-danger-9 bg-danger-9/20"
          style={{ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale }}
        />
      ))}
      {whiteout ? (
        <TextEditor
          left={whiteout.x * scale}
          top={(whiteout.y + whiteout.height) * scale + 4}
          width={Math.max(160, whiteout.width * scale)}
          fontSize={14}
          color="#000000"
          onDone={placeWhiteout}
          onCancel={() => setWhiteout(null)}
        />
      ) : null}
    </div>
  );
}
