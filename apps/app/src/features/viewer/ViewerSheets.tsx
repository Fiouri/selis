import type { DocHandle, OutlineItem } from "@selis/engine";
import { ChevronRight, LayoutGrid, ListTree, Moon, RotateCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { PageView } from "./PageView";

type MoreProps = {
  open: boolean;
  onClose: () => void;
  rotation: number;
  night: boolean;
  onOutline: () => void;
  onThumbnails: () => void;
  onRotate: () => void;
  onNight: (on: boolean) => void;
};

const row = "selis-focus flex min-h-14 w-full items-center gap-4 px-5 text-left text-md text-neutral-12 active:bg-neutral-3";

/** ⋮ in the top bar: contents, pages, rotate view, night mode. */
export function ViewerMoreSheet({ open, onClose, rotation, night, onOutline, onThumbnails, onRotate, onNight }: MoreProps) {
  const { t } = useTranslation();
  const nightLabel = useId();
  return (
    <Sheet open={open} onClose={onClose} title={t("viewer.more")} hideTitle testId="viewer-more">
      <ul className="flex flex-col pt-1 pb-2">
        <li>
          <button type="button" className={row} onClick={onOutline}>
            <ListTree size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
            <span className="flex-1">{t("viewer.outline")}</span>
            <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />
          </button>
        </li>
        <li>
          <button type="button" className={row} onClick={onThumbnails}>
            <LayoutGrid size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
            <span className="flex-1">{t("viewer.thumbnails")}</span>
            <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />
          </button>
        </li>
        <li>
          <button type="button" className={row} onClick={onRotate}>
            <RotateCw size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
            <span className="flex-1">{t("viewer.rotate")}</span>
            <span className="text-sm text-neutral-11 tabular-nums">{t("viewer.rotation", { degrees: rotation * 90 })}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            role="switch"
            aria-checked={night}
            aria-labelledby={nightLabel}
            className={row}
            onClick={() => onNight(!night)}
          >
            <Moon size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
            <span id={nightLabel} className="flex-1">
              {t("viewer.night")}
            </span>
            <span
              aria-hidden="true"
              className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ease-standard ${night ? "bg-accent-9" : "bg-neutral-6"}`}
            >
              <span
                className="absolute top-[3px] size-[22px] rounded-full bg-white shadow-1 transition-transform duration-200 ease-standard"
                style={{ transform: night ? "translateX(23px)" : "translateX(3px)" }}
              />
            </span>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

function OutlineList({ items, depth, onJump }: { items: readonly OutlineItem[]; depth: number; onJump: (page: number) => void }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        const expanded = open.has(i);
        const toggle = () => {
          const next = new Set(open);
          if (expanded) next.delete(i);
          else next.add(i);
          setOpen(next);
        };
        return (
          <li key={i}>
            <div className="flex items-center" style={{ paddingLeft: 8 + depth * 20 }}>
              {item.children.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? t("viewer.collapse", { title: item.title }) : t("viewer.expand", { title: item.title })}
                  onClick={toggle}
                  className="selis-focus flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-11 active:bg-neutral-3"
                >
                  <ChevronRight
                    size={18}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="transition-transform duration-150 ease-standard"
                    style={{ transform: expanded ? "rotate(90deg)" : "none" }}
                  />
                </button>
              ) : (
                <span className="w-11 shrink-0" />
              )}
              <button
                type="button"
                disabled={item.page === null}
                onClick={() => item.page !== null && onJump(item.page)}
                className="selis-focus flex min-h-12 min-w-0 flex-1 items-center gap-3 pr-5 text-left active:bg-neutral-3 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-md text-neutral-12">{item.title || t("viewer.untitledEntry")}</span>
                {item.page !== null ? <span className="text-sm text-neutral-11 tabular-nums">{item.page + 1}</span> : null}
              </button>
            </div>
            {expanded ? <OutlineList items={item.children} depth={depth + 1} onJump={onJump} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The document outline (bookmarks); tapping an entry jumps there. */
export function OutlineSheet({
  open,
  onClose,
  doc,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  doc: DocHandle;
  onJump: (page: number) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<readonly OutlineItem[] | null>(null);

  useEffect(() => {
    if (!open || items !== null) return;
    const life = { alive: true };
    void (async () => {
      try {
        const outline = await doc.outline();
        if (life.alive) setItems(outline);
      } catch (err) {
        console.warn("selis: no outline", err);
        if (life.alive) setItems([]);
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [open, doc, items]);

  return (
    <Sheet open={open} onClose={onClose} title={t("viewer.outline")} testId="outline-sheet">
      <div className="pb-2">
        {items === null ? (
          <p className="px-5 py-3 text-sm text-neutral-11">{t("viewer.loading")}</p>
        ) : items.length === 0 ? (
          <p className="px-5 py-3 text-sm text-neutral-11">{t("viewer.noOutline")}</p>
        ) : (
          <OutlineList items={items} depth={0} onJump={onJump} />
        )}
      </div>
    </Sheet>
  );
}

const COLUMNS = 3;
const GAP = 12;
const PAD = 16;
const LABEL = 22;
const THUMB_PIXELS = 160_000;

/** Grid of page thumbnails (virtualized by rows); tapping one jumps there. */
export function ThumbnailsSheet({
  open,
  onClose,
  doc,
  current,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  doc: DocHandle;
  current: number;
  onJump: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t("viewer.thumbnails")} testId="thumbnails-sheet">
      {open ? <ThumbnailGrid doc={doc} current={current} onJump={onJump} /> : null}
    </Sheet>
  );
}

function ThumbnailGrid({ doc, current, onJump }: { doc: DocHandle; current: number; onJump: (page: number) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0, top: 0 });

  useEffect(() => {
    const el = ref.current;
    // The sheet body scrolls; this grid measures itself inside it.
    const scroller = el?.parentElement;
    if (!el || !scroller) return;
    const measure = () => setBox({ width: el.clientWidth, height: scroller.clientHeight, top: scroller.scrollTop });
    // Open at the current page.
    const width = (el.clientWidth - 2 * PAD - (COLUMNS - 1) * GAP) / COLUMNS;
    const row = width * 1.414 + LABEL + GAP;
    scroller.scrollTop = Math.max(0, Math.floor(current / COLUMNS) * row - row);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
    // The starting page is read once, when the grid opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cell = box.width > 0 ? (box.width - 2 * PAD - (COLUMNS - 1) * GAP) / COLUMNS : 0;
  const cellHeight = cell * 1.414;
  const rowHeight = cellHeight + LABEL + GAP;
  const rows = Math.ceil(doc.pageCount / COLUMNS);
  const firstRow = rowHeight > 0 ? Math.max(0, Math.floor(box.top / rowHeight) - 1) : 0;
  const lastRow = rowHeight > 0 ? Math.min(rows - 1, Math.ceil((box.top + box.height) / rowHeight) + 1) : -1;

  const cells = [];
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 0; c < COLUMNS; c++) {
      const index = r * COLUMNS + c;
      const page = doc.pages[index];
      if (!page) break;
      const fit = Math.min(cell / page.width, cellHeight / page.height);
      const w = page.width * fit;
      const h = page.height * fit;
      const x = PAD + c * (cell + GAP);
      const y = r * rowHeight;
      cells.push(
        <div key={index}>
          <PageView
            doc={doc}
            index={index}
            top={y + (cellHeight - h) / 2}
            left={x + (cell - w) / 2}
            width={w}
            height={h}
            maxPixels={THUMB_PIXELS}
            label={t("viewer.pageLabel", { page: index + 1 })}
            active={index === current}
            onClick={onJump}
          />
          <span
            className={`absolute text-center text-xs tabular-nums ${index === current ? "font-semibold text-accent-selected" : "text-neutral-11"}`}
            style={{ top: y + cellHeight + 4, left: x, width: cell }}
            aria-hidden="true"
          >
            {index + 1}
          </span>
        </div>,
      );
    }
  }

  return (
    <div ref={ref} className="relative" style={{ height: rows * rowHeight }} data-testid="thumbnail-grid">
      {cells}
    </div>
  );
}
