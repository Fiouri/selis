/**
 * The Erase tool's part of the annotate sheet (ADR 0033): mode (brush,
 * rectangle, object), brush size and fill colour, a hint, and the action
 * ("Apply" with the stroke count, or "Delete object"). Every mode has the same
 * rows, so switching between them does not move the page.
 */
import { BoxSelect, Brush, type LucideIcon, MousePointerClick, Pipette, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BRUSH_SIZES, ERASE_MODES, type EraseMode, FILL_MODES, type FillMode, selectedObject, useEraseState, WHITE } from "./eraseState";
import type { BrushSize } from "./geometry";

const MODE_ICONS: Record<EraseMode, LucideIcon> = { brush: Brush, rect: BoxSelect, object: MousePointerClick };
const MODE_LABELS: Record<EraseMode, string> = { brush: "erase.modeBrush", rect: "erase.modeRect", object: "erase.modeObject" };
const SIZE_LABELS: Record<BrushSize, string> = { s: "erase.sizeSmall", m: "erase.sizeMedium", l: "erase.sizeLarge" };
const SIZE_DOTS: Record<BrushSize, number> = { s: 8, m: 14, l: 22 };
const FILL_LABELS: Record<FillMode, string> = { white: "erase.fillWhite", match: "erase.fillMatch", pick: "erase.fillPick" };
const KIND_LABELS = {
  text: "erase.kindText",
  path: "erase.kindPath",
  image: "erase.kindImage",
  shading: "erase.kindShading",
  form: "erase.kindForm",
} as const;

type Props = { busy: boolean; onApply: () => void; onDelete: () => void };

const radioClass = (selected: boolean) =>
  `selis-focus flex size-11 shrink-0 items-center justify-center rounded-[12px] ${selected ? "bg-accent-3 text-accent-selected" : "text-neutral-11 active:bg-neutral-3"}`;

export function EraseOptions({ busy, onApply, onDelete }: Props) {
  const { t } = useTranslation();
  const mode = useEraseState((s) => s.mode);
  const brush = useEraseState((s) => s.brush);
  const fill = useEraseState((s) => s.fill);
  const picked = useEraseState((s) => s.picked);
  const picking = useEraseState((s) => s.picking);
  const count = useEraseState((s) => s.strokes.length);
  const selection = useEraseState((s) => s.selection);
  const chosen = selectedObject(selection);
  const store = useEraseState.getState;

  let hint: string;
  if (picking) hint = t("erase.hintPick");
  else if (mode === "object") {
    hint = chosen
      ? t("erase.hintSelected", { kind: t(KIND_LABELS[chosen.kind]), at: (selection?.at ?? 0) + 1, count: selection?.candidates.length ?? 1 })
      : t("erase.hintObject");
  } else hint = t(mode === "brush" ? "erase.hintBrush" : "erase.hintRect");

  return (
    <div className="flex flex-col gap-1 px-4 pb-1" data-testid="erase-options">
      <div role="radiogroup" aria-label={t("erase.modes")} className="flex gap-1">
        {ERASE_MODES.map((name) => {
          const Icon = MODE_ICONS[name];
          const selected = name === mode;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => store().setMode(name)}
              className={`selis-focus flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[12px] text-sm ${
                selected ? "bg-accent-3 font-semibold text-accent-selected" : "font-medium text-neutral-11 active:bg-neutral-3"
              }`}
              data-testid={`erase-mode-${name}`}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{t(MODE_LABELS[name])}</span>
            </button>
          );
        })}
      </div>
      <div className="flex h-11 items-center gap-1">
        {mode === "object" ? (
          <p className="min-w-0 flex-1 truncate text-sm text-neutral-12" data-testid="erase-selection-label">
            {chosen ? t(KIND_LABELS[chosen.kind]) : t("erase.nothingSelected")}
          </p>
        ) : (
          <>
            {mode === "brush" ? (
              <div role="radiogroup" aria-label={t("erase.size")} className="flex">
                {BRUSH_SIZES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={name === brush}
                    aria-label={t(SIZE_LABELS[name])}
                    title={t(SIZE_LABELS[name])}
                    onClick={() => store().setBrush(name)}
                    className={radioClass(name === brush)}
                    data-testid={`erase-size-${name}`}
                  >
                    <span className="block rounded-full bg-current" style={{ width: SIZE_DOTS[name], height: SIZE_DOTS[name] }} />
                  </button>
                ))}
              </div>
            ) : null}
            <div role="radiogroup" aria-label={t("erase.fill")} className={`flex ${mode === "brush" ? "border-l border-neutral-5 pl-1" : ""}`}>
              {FILL_MODES.map((name) => {
                const selected = name === fill;
                return (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t(FILL_LABELS[name])}
                    title={t(FILL_LABELS[name])}
                    onClick={() => (name === "pick" && selected ? store().setPicking(!picking) : store().setFill(name))}
                    className={radioClass(selected)}
                    data-testid={`erase-fill-${name}`}
                  >
                    {name === "white" ? (
                      <span className="block size-6 rounded-full border border-control-line" style={{ background: WHITE }} />
                    ) : name === "match" ? (
                      <WandSparkles size={20} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <span className="relative flex size-6 items-center justify-center">
                        {picked ? <span className="absolute inset-0 rounded-full border border-control-line" style={{ background: picked }} /> : null}
                        <Pipette size={picked ? 14 : 20} strokeWidth={1.75} aria-hidden="true" className={picked ? "relative text-neutral-12 mix-blend-difference" : ""} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <span className="min-w-0 flex-1 truncate pl-1 text-right text-xs text-neutral-11" aria-hidden="true">
              {t(FILL_LABELS[fill])}
            </span>
          </>
        )}
      </div>
      <p className="h-5 truncate text-xs leading-5 text-neutral-11" data-testid="erase-hint" aria-live="polite">
        {hint}
      </p>
      {mode === "object" ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={!chosen || busy}
          className="selis-focus h-11 w-full rounded-full bg-danger-3 text-sm font-semibold text-danger-11 active:opacity-80 disabled:opacity-45"
          data-testid="erase-delete"
        >
          {busy ? t("erase.working") : t("erase.deleteObject")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onApply}
          disabled={count === 0 || busy}
          className="selis-focus h-11 w-full rounded-full bg-danger-3 text-sm font-semibold text-danger-11 active:opacity-80 disabled:opacity-45"
          data-testid="erase-apply"
        >
          {busy ? t("erase.working") : count === 0 ? t("erase.applyNone") : t("erase.apply", { count })}
        </button>
      )}
    </div>
  );
}
