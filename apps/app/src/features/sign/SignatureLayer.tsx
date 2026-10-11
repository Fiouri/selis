/**
 * Sign mode, over one page: a tap places the chosen saved signature (a stamp
 * annotation with its PNG, labelled "visual signature"); a placed one can be
 * selected, dragged, resized from its corner and removed. Every change is an
 * undoable command in the edit session.
 */
import { type Annotation, type DocHandle, type PageRect, type StampImage } from "@selis/engine";
import { Trash2 } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useToast } from "../../components/Toast";
import type { Signature } from "../../lib/api";
import type { Command, EditSession } from "../annotate/session";
import { addCommand, newAnnotationId, removeCommand, replaceCommand } from "../annotate/tools";
import { usePageAnnotations } from "../annotate/usePageAnnotations";

/** Width of a newly placed signature, points (capped by the page). */
const PLACE_WIDTH_PT = 160;
const MIN_WIDTH_PT = 40;
/** Touch target of the resize corner, CSS px. */
const HANDLE_PX = 44;
const DRAG_SLOP_PX = 4;

type SignatureAnnotation = Extract<Annotation, { kind: "signature" }>;

type SignState = {
  /** Saved signature chosen in the sheet, with its PNG once loaded. */
  chosen: { signature: Signature; image: StampImage } | null;
  /** The placed signature being moved / resized (one at a time). */
  active: { page: number; id: string } | null;
  choose: (chosen: SignState["chosen"]) => void;
  activate: (active: SignState["active"]) => void;
};

export const useSignState = create<SignState>((set) => ({
  chosen: null,
  active: null,
  choose: (chosen) => set({ chosen }),
  activate: (active) => set({ active }),
}));

/** Images of signatures placed this session (read-back ones get theirs from the engine). */
const placedImages = new Map<string, StampImage>();

async function withImage(doc: DocHandle, a: SignatureAnnotation): Promise<SignatureAnnotation> {
  if (a.image) return a;
  const known = placedImages.get(a.id);
  if (known) return { ...a, image: known };
  const image = await doc.annotationAppearance(a.page, a.id);
  placedImages.set(a.id, image);
  return { ...a, image };
}

type Drag = {
  pointerId: number;
  mode: "move" | "resize";
  start: { x: number; y: number };
  original: SignatureAnnotation;
  rect: PageRect;
  moved: boolean;
};

export function SignatureLayer({ doc, index, scale, session }: { doc: DocHandle; index: number; scale: number; session: EditSession }) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const chosen = useSignState((s) => s.chosen);
  const active = useSignState((s) => s.active);
  const activate = useSignState((s) => s.activate);
  const annotations = usePageAnnotations(doc, index, true);
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<PageRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const page = doc.pages[index];
  if (!page) return null;

  const signatures = annotations.filter((a): a is SignatureAnnotation => a.kind === "signature");
  const current = active?.page === index ? signatures.find((a) => a.id === active.id) : undefined;

  const run = (command: Command) => {
    session.run(command).catch((err: unknown) => {
      console.warn("selis: signature change failed", err);
      showToast(t("annotate.failed"), "error");
    });
  };

  const toPage = (clientX: number, clientY: number) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };
  const clampRect = (r: PageRect): PageRect => {
    const width = Math.min(page.width, Math.max(MIN_WIDTH_PT, r.width));
    const height = Math.min(page.height, r.height * (width / r.width));
    return {
      x: Math.min(page.width - width, Math.max(0, r.x)),
      y: Math.min(page.height - height, Math.max(0, r.y)),
      width,
      height,
    };
  };

  const place = (at: { x: number; y: number }) => {
    if (!chosen) return;
    const ratio = chosen.signature.height / chosen.signature.width;
    const width = Math.min(PLACE_WIDTH_PT, page.width * 0.45);
    const rect = clampRect({ x: at.x - width / 2, y: at.y - (width * ratio) / 2, width, height: width * ratio });
    const id = newAnnotationId("signature");
    placedImages.set(id, chosen.image);
    const annotation: SignatureAnnotation = { id, page: index, kind: "signature", rect, color: "#000000", opacity: 1, image: chosen.image };
    run(addCommand(doc, annotation, "sign"));
    activate({ page: index, id });
  };

  const hitSignature = (p: { x: number; y: number }) =>
    [...signatures].reverse().find((a) => p.x >= a.rect.x && p.x <= a.rect.x + a.rect.width && p.y >= a.rect.y && p.y <= a.rect.y + a.rect.height);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = toPage(event.clientX, event.clientY);
    // The resize corner of the active signature has a 44 px target outside its box too.
    if (current) {
      const cx = (current.rect.x + current.rect.width) * scale;
      const cy = (current.rect.y + current.rect.height) * scale;
      const near = Math.abs(p.x * scale - cx) <= HANDLE_PX / 2 && Math.abs(p.y * scale - cy) <= HANDLE_PX / 2;
      if (near) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, mode: "resize", start: p, original: current, rect: current.rect, moved: false };
        setDragging(true);
        return;
      }
    }
    const hit = hitSignature(p);
    if (hit) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      activate({ page: index, id: hit.id });
      drag.current = { pointerId: event.pointerId, mode: "move", start: p, original: hit, rect: hit.rect, moved: false };
      setDragging(true);
      return;
    }
    if (chosen) {
      // No compatibility mousedown: it would focus the scroller (see AnnotationLayer).
      event.preventDefault();
      place(p);
    } else {
      activate(null);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const p = toPage(event.clientX, event.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx * scale, dy * scale) < DRAG_SLOP_PX) return;
    d.moved = true;
    const o = d.original.rect;
    d.rect =
      d.mode === "move"
        ? clampRect({ ...o, x: o.x + dx, y: o.y + dy })
        : clampRect({ ...o, width: o.width + dx, height: o.height * ((o.width + dx) / o.width) });
    setPreview(d.rect);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setPreview(null);
    if (!d.moved || event.type === "pointercancel") return;
    const rect = d.rect;
    void (async () => {
      try {
        const before = await withImage(doc, d.original);
        run(replaceCommand(doc, before, { ...before, rect }, "sign"));
      } catch (err) {
        console.warn("selis: signature could not be moved", err);
        showToast(t("annotate.failed"), "error");
      }
    })();
  };

  const remove = async (a: SignatureAnnotation) => {
    try {
      run(removeCommand(doc, await withImage(doc, a), "sign"));
      activate(null);
    } catch (err) {
      console.warn("selis: signature could not be removed", err);
      showToast(t("annotate.failed"), "error");
    }
  };

  const box = preview ?? current?.rect ?? null;
  return (
    <div
      ref={layerRef}
      className="absolute inset-0"
      // Native scrolling stays: a tap places, a drag on empty paper scrolls.
      style={{ touchAction: dragging ? "none" : "pan-x pan-y" }}
      data-testid={`signature-layer-${index + 1}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      {box && current ? (
        <div
          className="pointer-events-none absolute rounded-[2px] outline-2 outline-offset-2 outline-accent-9 outline-dashed"
          style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}
          data-testid="signature-selection"
        >
          <span
            aria-hidden="true"
            className="absolute size-4 rounded-full border-2 border-white bg-accent-9 shadow-1"
            style={{ right: -10, bottom: -10 }}
          />
          {preview ? null : (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void remove(current)}
              aria-label={t("sign.remove")}
              title={t("sign.remove")}
              className="selis-focus pointer-events-auto absolute -top-14 right-0 flex size-11 items-center justify-center rounded-full bg-surface-raised text-danger-11 shadow-2"
              data-testid="signature-remove"
            >
              <Trash2 size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
