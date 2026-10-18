/**
 * The scanned pages (P4c; Scan 2.0, ADR 0032; docs/design/p4-ui-brief.md §7): a grid where a
 * tap opens a page to edit it, a long press lifts it to drag it elsewhere (a bar marks where it
 * lands; move earlier / later buttons do the same for keyboards and screen readers), and
 * remove. "Add page" goes back to the camera, "Save as PDF" makes the document. An ID card
 * session shows its front and back.
 */
import { Button, IconButton } from "@selis/ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Busy } from "../transfer/parts";
import { ID_SIDES, useScan } from "./scanStore";

const LONG_PRESS_MS = 400;
const SLOP_PX = 8;

type Drag = { pointerId: number; id: string; x: number; y: number; slot: number };

export function ScanQueue({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pages = useScan((s) => s.pages);
  const mode = useScan((s) => s.mode);
  const move = useScan((s) => s.move);
  const moveTo = useScan((s) => s.moveTo);
  const remove = useScan((s) => s.remove);
  const openPage = useScan((s) => s.openPage);
  const backToCamera = useScan((s) => s.backToCamera);
  const saving = phase.step === "saving";
  const idcard = mode === "idcard";
  const complete = !idcard || pages.length === ID_SIDES;
  const list = useRef<HTMLUListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const press = useRef<{ pointerId: number; id: string; x: number; y: number; timer: number } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** The click that ends a drag must not open the page. */
  const dragged = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  // While dragging, a finger moves the page, not the list.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  const label = (index: number) => (idcard ? t(index === 0 ? "scan.sideFront" : "scan.sideBack") : t("scan.pageNumber", { number: index + 1 }));

  /** The gap (0…n) nearest to a point: before or after the tile under it. */
  const slotAt = (x: number, y: number) => {
    const tiles = [...(list.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])];
    let best = { slot: pages.length, d: Infinity };
    tiles.forEach((tile, i) => {
      const r = tile.getBoundingClientRect();
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < best.d) best = { slot: x > r.left + r.width / 2 ? i + 1 : i, d };
    });
    return best.slot;
  };

  const onPointerDown = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || saving || pages.length < 2) return;
    dragged.current = false;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const timer = window.setTimeout(() => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      target.setPointerCapture(pointerId);
      const next = { pointerId, id, x: p.x, y: p.y, slot: slotAt(p.x, p.y) };
      dragRef.current = next;
      dragged.current = true;
      setDrag(next);
      if ("vibrate" in navigator) navigator.vibrate(10);
    }, LONG_PRESS_MS);
    press.current = { pointerId, id, x: e.clientX, y: e.clientY, timer };
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
    const next = { ...d, x: e.clientX, y: e.clientY, slot: slotAt(e.clientX, e.clientY) };
    dragRef.current = next;
    setDrag(next);
  };

  const endPress = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (p && p.pointerId === e.pointerId) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (e.type === "pointerup") moveTo(d.id, d.slot);
  };

  const onOpen = async (id: string) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (opening || saving) return;
    setOpening(id);
    await openPage(id);
    setOpening(null);
  };

  const lifted = drag ? pages.find((p) => p.id === drag.id) : undefined;

  return (
    <div className="flex h-full flex-col bg-surface-app text-neutral-12" data-testid="scan-queue">
      <header
        className="flex shrink-0 items-center gap-1 border-b border-neutral-5 px-1"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        {idcard && pages.length >= ID_SIDES ? (
          <IconButton label={t("scan.close")} icon={<X size={22} strokeWidth={1.75} />} onClick={onClose} disabled={saving} />
        ) : (
          <IconButton label={t("scan.backToCamera")} icon={<ChevronLeft size={22} strokeWidth={1.75} />} onClick={backToCamera} disabled={saving} />
        )}
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{idcard ? t("scan.modeIdCard") : t("scan.queueTitle")}</h1>
        <span className="px-3 text-sm text-neutral-11 tabular-nums" data-testid="scan-queue-count">
          {t("scan.count", { count: pages.length })}
        </span>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!idcard && pages.length > 1 ? <p className="mb-3 text-[13px] text-neutral-11">{t("scan.dragHint")}</p> : null}
        <ul ref={list} className="grid grid-cols-3 gap-3" data-testid="scan-pages">
          {pages.map((page, index) => {
            const before = drag && drag.slot === index && drag.id !== page.id;
            const after = drag && index === pages.length - 1 && drag.slot === pages.length && drag.id !== page.id;
            return (
              <li key={page.id} className="relative flex flex-col gap-1" data-tile data-testid="scan-page">
                {before ? <span className="absolute top-0 -left-2 h-[calc(100%-48px)] w-1 rounded-full bg-accent-9" aria-hidden="true" data-testid="scan-drop-marker" /> : null}
                {after ? <span className="absolute top-0 -right-2 h-[calc(100%-48px)] w-1 rounded-full bg-accent-9" aria-hidden="true" data-testid="scan-drop-marker" /> : null}
                <div
                  className="relative aspect-[3/4] overflow-hidden rounded-[12px] border border-neutral-5 bg-neutral-3"
                  style={{ opacity: drag?.id === page.id ? 0.35 : 1 }}
                >
                  <button
                    type="button"
                    className="selis-focus size-full select-none [-webkit-touch-callout:none]"
                    aria-label={idcard ? t("scan.openSide", { side: label(index) }) : t("scan.openPage", { number: index + 1 })}
                    onClick={() => void onOpen(page.id)}
                    onPointerDown={onPointerDown(page.id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={endPress}
                    onPointerCancel={endPress}
                    onContextMenu={(e) => e.preventDefault()}
                    disabled={saving}
                    data-testid="scan-page-open"
                  >
                    <img src={page.thumb} alt="" draggable={false} className="size-full object-contain" />
                  </button>
                  {opening === page.id ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-surface-app/60">
                      <span className="size-6 animate-spin rounded-full border-[3px] border-neutral-5 border-t-accent-9 motion-reduce:animate-none" aria-hidden="true" />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="selis-focus absolute top-0 right-0 flex size-11 items-center justify-center"
                    aria-label={t("scan.remove", { number: index + 1 })}
                    onClick={() => remove(page.id)}
                    disabled={saving}
                    data-testid="scan-page-remove"
                  >
                    <span className="flex size-6 items-center justify-center rounded-full bg-neutral-12/70 text-neutral-1">
                      <X size={16} strokeWidth={2} aria-hidden="true" />
                    </span>
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="selis-focus flex size-11 items-center justify-center rounded-full text-neutral-11 disabled:opacity-40"
                    aria-label={t("scan.earlier", { number: index + 1 })}
                    onClick={() => move(page.id, -1)}
                    disabled={saving || index === 0}
                    data-testid="scan-page-earlier"
                  >
                    <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <span className="truncate text-sm text-neutral-11 tabular-nums">{idcard ? label(index) : index + 1}</span>
                  <button
                    type="button"
                    className="selis-focus flex size-11 items-center justify-center rounded-full text-neutral-11 disabled:opacity-40"
                    aria-label={t("scan.later", { number: index + 1 })}
                    onClick={() => move(page.id, 1)}
                    disabled={saving || index === pages.length - 1}
                    data-testid="scan-page-later"
                  >
                    <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {drag && lifted ? (
        <img
          src={lifted.thumb}
          alt=""
          aria-hidden="true"
          className="pointer-events-none fixed z-10 w-20 -translate-1/2 rounded-[8px] border border-neutral-5 shadow-3"
          style={{ left: drag.x, top: drag.y }}
          data-testid="scan-drag-ghost"
        />
      ) : null}
      <footer className="flex shrink-0 flex-col gap-3 border-t border-neutral-5 px-5 pt-3" style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}>
        {saving ? (
          <div className="flex h-12 items-center justify-center">
            <Busy label={t("scan.saving", { done: phase.done, total: phase.total })} testId="scan-saving" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={backToCamera} disabled={idcard && complete} data-testid="scan-add-page">
              {t("scan.addPage")}
            </Button>
            <Button onClick={onSave} disabled={pages.length === 0 || !complete} data-testid="scan-save">
              {t("scan.save")}
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}
