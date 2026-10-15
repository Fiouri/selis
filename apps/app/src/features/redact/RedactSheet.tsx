/**
 * Redaction sheet, in the system of the annotate tool sheet (brief §3): tool
 * row (text, area, whiteout, eraser), a hint, and "Apply" with the number of
 * marks. Applying asks first: the content under the marks leaves the saved
 * version for good.
 */
import { BoxSelect, Eraser, type LucideIcon, PaintBucket, TextSelect } from "lucide-react";
import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { REDACT_TOOLS, type RedactTool, useRedactState } from "./redactState";

const ICONS: Record<RedactTool, LucideIcon> = { text: TextSelect, area: BoxSelect, whiteout: PaintBucket, eraser: Eraser };
const LABELS: Record<RedactTool, string> = {
  text: "redact.toolText",
  area: "redact.toolArea",
  whiteout: "redact.toolWhiteout",
  eraser: "redact.toolEraser",
};
const HINTS: Record<RedactTool, string> = {
  text: "redact.hintText",
  area: "redact.hintArea",
  whiteout: "redact.hintWhiteout",
  eraser: "redact.hintEraser",
};

export const RedactSheet = forwardRef<HTMLElement, { busy: boolean; onApply: () => void }>(function RedactSheet({ busy, onApply }, ref) {
  const { t } = useTranslation();
  const tool = useRedactState((s) => s.tool);
  const setTool = useRedactState((s) => s.setTool);
  const count = useRedactState((s) => s.marks.size);
  return (
    <section
      ref={ref}
      aria-label={t("redact.tools")}
      className="absolute inset-x-0 bottom-0 z-10 rounded-t-sheet border-t border-neutral-5 bg-surface-raised shadow-3"
      style={{ paddingBottom: "calc(var(--safe-bottom) + 8px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="redact-sheet"
    >
      <div className="flex h-5 w-full items-start justify-center pt-2" aria-hidden="true">
        <span className="h-1 w-9 rounded-full bg-control-line" />
      </div>
      <div className="flex justify-center gap-1 px-3 pb-2" role="toolbar" aria-label={t("redact.tools")}>
        {REDACT_TOOLS.map((name) => {
          const Icon = ICONS[name];
          const selected = name === tool;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={selected}
              onClick={() => setTool(name)}
              className={`selis-focus flex h-[60px] w-[76px] shrink-0 flex-col items-center justify-center gap-1 rounded-[12px] ${
                selected ? "bg-accent-3 font-semibold text-accent-selected" : "font-medium text-neutral-11 active:bg-neutral-3"
              }`}
              data-testid={`redact-tool-${name}`}
            >
              <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
              <span className="max-w-full truncate px-0.5 text-[11px]">{t(LABELS[name])}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 px-4 pb-1">
        <p className="text-xs text-neutral-11" data-testid="redact-hint">
          {t(HINTS[tool])}
        </p>
        <button
          type="button"
          onClick={onApply}
          disabled={count === 0 || busy}
          className="selis-focus h-11 w-full rounded-full bg-danger-3 text-sm font-semibold text-danger-11 active:opacity-80 disabled:opacity-45"
          data-testid="redact-apply"
        >
          {busy ? t("redact.applying") : count === 0 ? t("redact.applyNone") : t("redact.apply", { count })}
        </button>
      </div>
    </section>
  );
});
