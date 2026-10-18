/**
 * "Adjust corners" (P4c; docs/design/p4-ui-brief.md §7): the still with the page outline and
 * four handles (44 px targets, 20 px dots; a magnifier while dragging; arrow keys nudge),
 * the filter chips, and Retake / Keep. Keep straightens the page in the scan worker.
 */
import { clampPoint, fromBox, isConvex, placement, type Point, type ScanFilter, svgPoints, toBox, withCorner } from "@selis/scan";
import { Button, Chip } from "@selis/ui";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Busy } from "../transfer/parts";
import { useScan } from "./scanStore";

const CORNERS = ["scan.cornerTopLeft", "scan.cornerTopRight", "scan.cornerBottomRight", "scan.cornerBottomLeft"] as const;
const FILTER_KEYS: Record<Exclude<ScanFilter, "enhance">, string> = { original: "scan.filterOriginal", grey: "scan.filterGrey", bw: "scan.filterBw" };
/** Magnifier: diameter (px) and zoom. */
const LOUPE = 112;
const ZOOM = 2.5;

export function AdjustCorners() {
  const { t } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pageNumber = useScan((s) => s.pages.length + 1);
  const setQuad = useScan((s) => s.setQuad);
  const setFilter = useScan((s) => s.setFilter);
  const retake = useScan((s) => s.retake);
  const keep = useScan((s) => s.keep);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (phase.step !== "adjust" && phase.step !== "keeping") return null;
  const { still } = phase;
  const keeping = phase.step === "keeping";
  const picture = { width: still.width, height: still.height };
  const at = placement(picture, size, "contain");
  const shown = toBox(still.quad, at);
  const convex = isConvex(still.quad);
  const preview = still.previews[still.filter] ?? still.previews.original;

  const moveTo = (index: number, clientX: number, clientY: number) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return;
    setQuad(withCorner(still.quad, index, clampPoint(fromBox([clientX - rect.left, clientY - rect.top], at), picture)));
  };

  const onPointerDown = (index: number) => (event: PointerEvent<HTMLButtonElement>) => {
    if (keeping) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(index);
  };
  const onPointerMove = (index: number) => (event: PointerEvent<HTMLButtonElement>) => {
    if (dragging === index) moveTo(index, event.clientX, event.clientY);
  };
  const onPointerUp = () => setDragging(null);
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = Math.max(picture.width, picture.height) * 0.005;
    const delta: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[event.key];
    if (!d || keeping) return;
    event.preventDefault();
    const [x, y] = still.quad[index] ?? still.quad[0];
    setQuad(withCorner(still.quad, index, clampPoint([x + d[0], y + d[1]], picture)));
  };

  const loupe = (() => {
    if (dragging === null || !preview) return null;
    const [cx, cy] = shown[dragging] ?? shown[0];
    const imageWidth = picture.width * at.scale;
    const imageHeight = picture.height * at.scale;
    // Opposite corner of the area from the finger, so the finger never covers it.
    const left = cx < size.width / 2 ? size.width - LOUPE - 12 : 12;
    return (
      <div
        className="pointer-events-none absolute top-3 overflow-hidden rounded-full border-2 border-accent-9 bg-neutral-3 shadow-3"
        style={{
          left,
          width: LOUPE,
          height: LOUPE,
          backgroundImage: `url(${preview})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${String(imageWidth * ZOOM)}px ${String(imageHeight * ZOOM)}px`,
          backgroundPosition: `${String(LOUPE / 2 - (cx - at.left) * ZOOM)}px ${String(LOUPE / 2 - (cy - at.top) * ZOOM)}px`,
        }}
        aria-hidden="true"
        data-testid="scan-loupe"
      >
        <span className="absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-full border-2 border-accent-9" />
      </div>
    );
  })();

  return (
    <div className="flex h-full flex-col bg-surface-app text-neutral-12" data-testid="scan-adjust">
      <header
        className="flex shrink-0 items-center gap-2 border-b border-neutral-5 px-5"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{t("scan.adjustTitle")}</h1>
        <span className="text-sm text-neutral-11 tabular-nums">{t("scan.pageNumber", { number: pageNumber })}</span>
      </header>
      <div ref={area} className="relative min-h-0 flex-1 touch-none overflow-hidden bg-neutral-3" data-testid="scan-adjust-area">
        {preview && size.width > 0 ? (
          <img
            src={preview}
            alt={t("scan.stillLabel")}
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: at.left, top: at.top, width: picture.width * at.scale, height: picture.height * at.scale }}
            draggable={false}
            data-testid="scan-still"
          />
        ) : null}
        {size.width > 0 ? (
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
            <polygon
              points={svgPoints(shown)}
              fill={convex ? "var(--accent-9)" : "var(--danger-9)"}
              fillOpacity={0.2}
              stroke={convex ? "var(--accent-9)" : "var(--danger-9)"}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
        {size.width > 0
          ? shown.map(([x, y], index) => (
              <button
                key={CORNERS[index]}
                type="button"
                className="selis-focus absolute flex size-11 -translate-1/2 cursor-grab items-center justify-center rounded-full"
                style={{ left: x, top: y }}
                aria-label={t(CORNERS[index] ?? CORNERS[0])}
                onPointerDown={onPointerDown(index)}
                onPointerMove={onPointerMove(index)}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown(index)}
                disabled={keeping}
                data-testid={`scan-corner-${String(index)}`}
              >
                <span className="size-5 rounded-full border-2 border-[#ffffff] bg-accent-9 shadow-2" aria-hidden="true" />
              </button>
            ))
          : null}
        {loupe}
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-neutral-5 px-5 pt-3" style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}>
        <p className={`text-[13px] ${convex ? "text-neutral-11" : "text-danger-11"}`} role={convex ? undefined : "alert"} data-testid="scan-adjust-hint">
          {!convex ? t("scan.outlineInvalid") : still.detected ? t("scan.adjustHint") : t("scan.notFound")}
        </p>
        <div role="radiogroup" aria-label={t("scan.filter")} className="flex gap-2" data-testid="scan-filters">
          {(Object.keys(FILTER_KEYS) as Array<keyof typeof FILTER_KEYS>).map((filter) => (
            <Chip key={filter} kind="radio" selected={still.filter === filter} onClick={() => void setFilter(filter)} disabled={keeping} data-testid={`scan-filter-${filter}`}>
              {t(FILTER_KEYS[filter])}
            </Chip>
          ))}
        </div>
        {keeping ? (
          <div className="flex h-12 items-center justify-center">
            <Busy label={t("scan.straightening")} testId="scan-keeping" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={retake} data-testid="scan-retake">
              {t("scan.retake")}
            </Button>
            <Button onClick={() => void keep()} disabled={!convex} data-testid="scan-keep">
              {t("scan.keep")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
