/**
 * Annotate chrome per docs/design/p1-ui-brief.md §3: top bar (close, title,
 * undo, redo, "Done" pill) and the docked tool sheet (tool row, color row,
 * thickness / size).
 */
import { IconButton } from "@selis/ui";
import {
  ArrowUpRight,
  BrushCleaning,
  Circle,
  Eraser,
  Highlighter,
  type LucideIcon,
  Minus,
  PenLine,
  Redo2,
  Shapes,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { forwardRef, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import {
  COLORS,
  type ColorName,
  colorsFor,
  FONT_SIZE_RANGE,
  type Shape,
  SHAPES,
  THICKNESS_RANGE,
  type Tool,
  TOOLS,
  useTools,
} from "./tools";

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  pen: PenLine,
  shapes: Shapes,
  text: Type,
  note: StickyNote,
  eraser: Eraser,
  erase: BrushCleaning,
};

const TOOL_LABELS: Record<Tool, string> = {
  highlight: "annotate.toolHighlight",
  underline: "annotate.toolUnderline",
  strikeout: "annotate.toolStrikeout",
  pen: "annotate.toolPen",
  shapes: "annotate.toolShapes",
  text: "annotate.toolText",
  note: "annotate.toolNote",
  eraser: "annotate.toolEraser",
  erase: "annotate.toolErase",
};

const SHAPE_ICONS: Record<Shape, LucideIcon> = { square: Square, circle: Circle, line: Minus, arrow: ArrowUpRight };
const SHAPE_LABELS: Record<Shape, string> = {
  square: "annotate.shapeSquare",
  circle: "annotate.shapeCircle",
  line: "annotate.shapeLine",
  arrow: "annotate.shapeArrow",
};

const COLOR_LABELS: Record<ColorName, string> = {
  black: "annotate.colorBlack",
  yellow: "annotate.colorYellow",
  green: "annotate.colorGreen",
  pink: "annotate.colorPink",
  blue: "annotate.colorBlue",
  orange: "annotate.colorOrange",
};

const HINTS: Record<Tool, string> = {
  highlight: "annotate.hintMarkup",
  underline: "annotate.hintMarkup",
  strikeout: "annotate.hintMarkup",
  pen: "annotate.hintDraw",
  shapes: "annotate.hintDraw",
  text: "annotate.hintTap",
  note: "annotate.hintTap",
  eraser: "annotate.hintEraser",
  erase: "erase.hintBrush",
};

type BarProps = {
  /** Save state ("αποθηκεύτηκε" / "αποθήκευση…"); the page is on the chip. */
  status: string;
  canUndo: boolean;
  canRedo: boolean;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
  /** Mode title and close label (annotate, sign, form share this bar). */
  title?: string | undefined;
  closeLabel?: string | undefined;
};

/** safe-top + 52 px: close · title (+ save status) · undo · redo · "Done". */
export const AnnotateBar = forwardRef<HTMLElement, BarProps>(function AnnotateBar(
  { status, canUndo, canRedo, onClose, onUndo, onRedo, onDone, title, closeLabel },
  ref,
) {
  const { t } = useTranslation();
  return (
    <header
      ref={ref}
      className="absolute inset-x-0 top-0 z-10 border-b border-neutral-5 bg-surface-app"
      style={{ paddingTop: "var(--safe-top)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="annotate-bar"
    >
      <div className="flex h-13 items-center gap-1 pr-3 pl-1">
        <IconButton
          label={closeLabel ?? t("annotate.close")}
          icon={<X size={22} strokeWidth={1.75} />}
          onClick={onClose}
          data-testid="annotate-close"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-md leading-tight font-semibold text-neutral-12">{title ?? t("annotate.title")}</h1>
          <p className="truncate text-xs text-neutral-11" data-testid="save-status" aria-live="polite">
            {status}
          </p>
        </div>
        <IconButton
          label={t("annotate.undo")}
          icon={<Undo2 size={22} strokeWidth={1.75} />}
          onClick={onUndo}
          disabled={!canUndo}
          className="disabled:opacity-45"
          data-testid="annotate-undo"
        />
        <IconButton
          label={t("annotate.redo")}
          icon={<Redo2 size={22} strokeWidth={1.75} />}
          onClick={onRedo}
          disabled={!canRedo}
          className="disabled:opacity-45"
          data-testid="annotate-redo"
        />
        <button
          type="button"
          onClick={onDone}
          className="selis-focus ml-1 h-10 shrink-0 rounded-full bg-accent-9 px-4 text-sm font-semibold text-accent-contrast active:bg-accent-10"
          data-testid="annotate-done"
        >
          {t("annotate.done")}
        </button>
      </div>
    </header>
  );
});

/**
 * Docked bottom sheet: radius 20 20 0 0, raised surface, grab handle 36×4.
 * The Erase tool brings its own rows (`eraseOptions`).
 */
export const ToolSheet = forwardRef<HTMLElement, { eraseOptions?: ReactNode }>(function ToolSheet({ eraseOptions }, ref) {
  const { t } = useTranslation();
  const tool = useTools((s) => s.tool);
  const collapsed = useTools((s) => s.collapsed);
  const setTool = useTools((s) => s.setTool);
  const toggleCollapsed = useTools((s) => s.toggleCollapsed);
  const showThickness = tool === "pen" || tool === "shapes";
  return (
    <section
      ref={ref}
      aria-label={t("annotate.tools")}
      className="absolute inset-x-0 bottom-0 z-10 rounded-t-sheet border-t border-neutral-5 bg-surface-raised shadow-3"
      style={{ paddingBottom: "calc(var(--safe-bottom) + 8px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="annotate-sheet"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("annotate.expand") : t("annotate.collapse")}
        className="selis-focus flex h-5 w-full items-start justify-center pt-2"
      >
        <span className="h-1 w-9 rounded-full bg-control-line" aria-hidden="true" />
      </button>
      <div className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]" role="radiogroup" aria-label={t("annotate.tools")}>
        {TOOLS.map((name) => {
          const Icon = TOOL_ICONS[name];
          const selected = name === tool;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={(e) => {
                setTool(name);
                // The row scrolls sideways: bring the chosen tool fully into view.
                e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
              }}
              className={`selis-focus flex h-[60px] w-[76px] shrink-0 flex-col items-center justify-center gap-1 rounded-[12px] ${
                selected ? "bg-accent-3 font-semibold text-accent-selected" : "font-medium text-neutral-11 active:bg-neutral-3"
              }`}
              data-testid={`tool-${name}`}
            >
              <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
              <span className="max-w-full truncate px-0.5 text-[11px]">{t(TOOL_LABELS[name])}</span>
            </button>
          );
        })}
      </div>
      {collapsed ? null : tool === "erase" ? (
        eraseOptions
      ) : (
        <div className="flex flex-col gap-1 px-4 pb-1">
          {tool === "shapes" ? <ShapeRow /> : null}
          <ColorRow />
          {showThickness ? (
            <RangeRow
              label={t("annotate.thickness")}
              range={THICKNESS_RANGE}
              valueSelector={(s) => s.thickness}
              onChange={(v) => useTools.getState().setThickness(v)}
              testId="thickness"
            />
          ) : null}
          {tool === "text" ? (
            <RangeRow
              label={t("annotate.fontSize")}
              range={FONT_SIZE_RANGE}
              valueSelector={(s) => s.fontSize}
              onChange={(v) => useTools.getState().setFontSize(v)}
              testId="font-size"
            />
          ) : null}
          <p className="py-1 text-xs text-neutral-11" data-testid="annotate-hint">
            {t(HINTS[tool])}
          </p>
        </div>
      )}
    </section>
  );
});

function ShapeRow() {
  const { t } = useTranslation();
  const shape = useTools((s) => s.shape);
  const setShape = useTools((s) => s.setShape);
  return (
    <div role="radiogroup" aria-label={t("annotate.shapes")} className="flex gap-1">
      {SHAPES.map((name) => {
        const Icon = SHAPE_ICONS[name];
        const selected = name === shape;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(SHAPE_LABELS[name])}
            title={t(SHAPE_LABELS[name])}
            onClick={() => setShape(name)}
            className={`selis-focus flex size-11 items-center justify-center rounded-[12px] ${
              selected ? "bg-accent-3 text-accent-selected" : "text-neutral-11 active:bg-neutral-3"
            }`}
            data-testid={`shape-${name}`}
          >
            <Icon size={22} strokeWidth={selected ? 2.25 : 1.75} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/** Radiogroup of 28 px swatches in 44 px targets; the selected name on the right. */
function ColorRow() {
  const { t } = useTranslation();
  const tool = useTools((s) => s.tool);
  const selected = useTools((s) => s.colors[s.tool]);
  const setColor = useTools((s) => s.setColor);
  const names = colorsFor(tool);
  if (names.length === 0) return null;
  return (
    <div className="flex items-center">
      <div role="radiogroup" aria-label={t("annotate.color")} className="flex flex-1 items-center">
        {names.map((name) => {
          const checked = name === selected;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(COLOR_LABELS[name])}
              onClick={() => setColor(name)}
              className="selis-focus flex size-11 items-center justify-center rounded-full"
              data-testid={`color-${name}`}
            >
              <span
                className="block size-7 rounded-full"
                style={{
                  background: COLORS[name],
                  boxShadow: checked ? "0 0 0 2px var(--surface-raised), 0 0 0 4px var(--neutral-12)" : "inset 0 0 0 1px rgb(0 0 0 / 0.12)",
                }}
              />
            </button>
          );
        })}
      </div>
      <span className="pl-2 text-xs text-neutral-11" aria-hidden="true">
        {t(COLOR_LABELS[selected])}
      </span>
    </div>
  );
}

function RangeRow({
  label,
  range,
  valueSelector,
  onChange,
  testId,
}: {
  label: string;
  range: { min: number; max: number };
  valueSelector: (s: ReturnType<typeof useTools.getState>) => number;
  onChange: (value: number) => void;
  testId: string;
}) {
  const id = useId();
  const value = useTools(valueSelector);
  return (
    <div className="flex h-11 items-center gap-3">
      <label htmlFor={id} className="w-16 shrink-0 text-sm text-neutral-12">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="selis-focus h-11 min-w-0 flex-1 accent-accent-9"
        data-testid={testId}
      />
      <span className="w-6 text-right text-xs text-neutral-11 tabular-nums" aria-hidden="true">
        {value}
      </span>
    </div>
  );
}
