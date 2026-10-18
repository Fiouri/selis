/**
 * One scanned page, opened from the review (Scan 2.0, ADR 0032): the page as it will be saved,
 * the filter chips, and Corners (the Adjust step), Rotate, Touch up, Retake and Delete. Touch
 * up: brush over a mark and it is filled with the paper around it; Undo removes the last
 * stroke. Every change re-renders the page from its photo in the scan worker; leaving keeps
 * the edits.
 */
import { type Point, placement, type Stroke, turn, unturn } from "@selis/scan";
import { Button, Chip, IconButton } from "@selis/ui";
import { Camera, ChevronLeft, Crop, Eraser, RotateCw, Trash2, Undo2 } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Busy } from "../transfer/parts";
import { FILTER_KEYS, FILTER_ORDER, ID_SIDES, useScan } from "./scanStore";

/** Brush radius on screen (px); stored relative to the page's long side. */
const BRUSH_PX = 14;

export function ScanPageEditor() {
  const { t } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pages = useScan((s) => s.pages);
  const mode = useScan((s) => s.mode);
  const editPage = useScan((s) => s.editPage);
  const rotatePage = useScan((s) => s.rotatePage);
  const addStroke = useScan((s) => s.addStroke);
  const undoStroke = useScan((s) => s.undoStroke);
  const adjustPage = useScan((s) => s.adjustPage);
  const retakePage = useScan((s) => s.retakePage);
  const remove = useScan((s) => s.remove);
  const closePage = useScan((s) => s.closePage);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [touchUp, setTouchUp] = useState(false);
  /** The stroke being drawn, in page points (0–1 of the page as shown). */
  const [drawing, setDrawing] = useState<{ pointerId: number; points: Point[] } | null>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (phase.step !== "page") return null;
  const { page } = phase;
  const index = pages.findIndex((p) => p.id === page.id);
  const title =
    mode === "idcard" && index < ID_SIDES
      ? t(index === 0 ? "scan.sideFront" : "scan.sideBack")
      : t("scan.pageTitle", { number: index + 1, total: pages.length });
  const shownSize = page.previewSize ?? { width: 3, height: 4 };
  const at = placement(shownSize, { width: Math.max(0, size.width - 32), height: Math.max(0, size.height - 32) }, "contain");
  const shownWidth = shownSize.width * at.scale;
  const shownHeight = shownSize.height * at.scale;
  const left = 16 + at.left;
  const top = 16 + at.top;
  const busy = page.rendering;

  /** A pointer position as a 0–1 point of the page as shown. */
  const pagePoint = (e: PointerEvent<HTMLElement>): Point => {
    const rect = area.current?.getBoundingClientRect();
    const x = (e.clientX - (rect?.left ?? 0) - left) / Math.max(1, shownWidth);
    const y = (e.clientY - (rect?.top ?? 0) - top) / Math.max(1, shownHeight);
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!touchUp || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing({ pointerId: e.pointerId, points: [pagePoint(e)] });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    const next = pagePoint(e);
    const last = drawing.points[drawing.points.length - 1];
    // A point every few screen pixels is plenty.
    if (last && Math.hypot((next[0] - last[0]) * shownWidth, (next[1] - last[1]) * shownHeight) < 4) return;
    setDrawing({ ...drawing, points: [...drawing.points, next] });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    setDrawing(null);
    if (e.type !== "pointerup") return;
    // Stored on the page before its turns, the radius relative to its long side.
    const stroke: Stroke = {
      radius: BRUSH_PX / Math.max(1, shownWidth, shownHeight),
      points: drawing.points.map((p) => unturn(p, page.edits.turns)),
    };
    addStroke(stroke);
  };

  // Strokes kept so far, drawn over the page until the render with them arrives.
  const strokes = [...page.edits.strokes.map((s) => s.points.map((p) => turn(p, page.edits.turns))), ...(drawing ? [drawing.points] : [])];
  const toScreen = ([x, y]: Point) => `${String(left + x * shownWidth)},${String(top + y * shownHeight)}`;

  return (
    <div className="flex h-full flex-col bg-surface-app text-neutral-12" data-testid="scan-page-editor">
      <header
        className="flex shrink-0 items-center gap-1 border-b border-neutral-5 px-1"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        <IconButton label={t("scan.backToPages")} icon={<ChevronLeft size={22} strokeWidth={1.75} />} onClick={() => void closePage()} disabled={busy && !page.preview} data-testid="scan-page-back" />
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold" data-testid="scan-page-title">
          {title}
        </h1>
        <IconButton label={t("scan.deletePage")} icon={<Trash2 size={22} strokeWidth={1.75} />} onClick={() => remove(page.id)} data-testid="scan-page-delete" />
      </header>
      <div
        ref={area}
        className={`relative min-h-0 flex-1 overflow-hidden bg-neutral-3 ${touchUp ? "touch-none cursor-crosshair" : ""}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        data-testid="scan-page-area"
      >
        {page.preview && size.width > 0 ? (
          <img
            src={page.preview}
            alt={t("scan.pagePreview")}
            className="pointer-events-none absolute max-w-none bg-white shadow-1 select-none"
            style={{ left, top, width: shownWidth, height: shownHeight }}
            draggable={false}
            data-testid="scan-page-preview"
            data-turns={page.edits.turns}
            data-strokes={page.edits.strokes.length}
          />
        ) : null}
        {strokes.length > 0 && size.width > 0 ? (
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
            {strokes.map((points, i) => (
              <polyline
                key={i}
                points={points.map(toScreen).join(" ")}
                fill="none"
                stroke="var(--accent-9)"
                strokeOpacity={0.45}
                strokeWidth={BRUSH_PX * 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        ) : null}
        {busy ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-surface-raised px-4 py-2 shadow-2">
            <Busy label={t("scan.rendering")} testId="scan-page-rendering" />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-neutral-5 px-5 pt-3" style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}>
        {touchUp ? (
          <>
            <p className="text-[13px] text-neutral-11">{t("scan.touchUpHint")}</p>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" icon={<Undo2 size={20} strokeWidth={1.75} />} onClick={undoStroke} disabled={page.edits.strokes.length === 0} data-testid="scan-undo">
                {t("scan.undo")}
              </Button>
              <Button onClick={() => setTouchUp(false)} data-testid="scan-touchup-done">
                {t("scan.done")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div role="radiogroup" aria-label={t("scan.filter")} className="-mx-5 flex gap-2 overflow-x-auto px-5" data-testid="scan-filters">
              {FILTER_ORDER.map((filter) => (
                <Chip key={filter} kind="radio" selected={page.edits.filter === filter} onClick={() => editPage({ filter })} data-testid={`scan-filter-${filter}`}>
                  {t(FILTER_KEYS[filter])}
                </Chip>
              ))}
            </div>
            <div className="grid grid-cols-4 gap-1">
              <ToolButton icon={<Crop size={22} strokeWidth={1.75} />} label={t("scan.corners")} onClick={adjustPage} testId="scan-page-corners" />
              <ToolButton icon={<RotateCw size={22} strokeWidth={1.75} />} label={t("scan.rotate")} onClick={rotatePage} testId="scan-page-rotate" />
              <ToolButton icon={<Eraser size={22} strokeWidth={1.75} />} label={t("scan.touchUp")} onClick={() => setTouchUp(true)} testId="scan-page-touchup" />
              <ToolButton icon={<Camera size={22} strokeWidth={1.75} />} label={t("scan.retakePage")} onClick={() => retakePage(page.id)} testId="scan-page-retake" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ToolButton({ icon, label, onClick, testId }: { icon: ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="selis-focus flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[12px] text-[12px] font-medium text-neutral-12 hover:bg-neutral-3 active:bg-neutral-4"
      data-testid={testId}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="max-w-full truncate px-1">{label}</span>
    </button>
  );
}
