/**
 * Form chrome: the banner offering "Συμπλήρωση" in the viewer, and form mode's
 * docked bar (previous / next field, "Πεδίο 2 από 4", Ισοπέδωση with a confirm).
 */
import { Button, IconButton } from "@selis/ui";
import { ChevronLeft, ChevronRight, ClipboardPen, Layers } from "lucide-react";
import { forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { fieldCount, useFormState } from "./formState";

/** Floating pill under the top bar when the document has a form. */
export function FormBanner({ top, hidden, onFill }: { top: number; hidden: boolean; onFill: () => void }) {
  const { t } = useTranslation();
  const fields = useFormState((s) => s.fields);
  if (!fields || fields.length === 0) return null;
  return (
    <div
      className="absolute z-10 flex items-center gap-1 rounded-full border border-neutral-5 bg-surface-raised py-1 pr-1 pl-3 shadow-2 transition-opacity duration-200 ease-standard"
      style={{ top: top + 12, left: "calc(var(--safe-left) + 16px)", opacity: hidden ? 0 : 1, pointerEvents: hidden ? "none" : "auto" }}
      data-testid="form-banner"
    >
      <ClipboardPen size={18} strokeWidth={1.75} className="text-accent-selected" aria-hidden="true" />
      <span className="px-1 text-sm text-neutral-12">{t("forms.banner", { count: fieldCount(fields) })}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onFill();
        }}
        className="selis-focus h-9 rounded-full bg-accent-9 px-4 text-sm font-semibold text-accent-contrast active:bg-accent-10"
        data-testid="form-fill"
      >
        {t("forms.fill")}
      </button>
    </div>
  );
}

type SheetProps = {
  /** Scrolls the viewer to a field (page, y in points). */
  onJump: (page: number, y: number) => void;
  onFlatten: () => void;
};

export const FormSheet = forwardRef<HTMLElement, SheetProps>(function FormSheet({ onJump, onFlatten }, ref) {
  const { t } = useTranslation();
  const fields = useFormState((s) => s.fields) ?? [];
  const cursor = useFormState((s) => s.cursor);
  const setActive = useFormState((s) => s.setActive);
  const [confirming, setConfirming] = useState(false);
  const index = fields.findIndex((f) => f.id === cursor);

  const go = (step: 1 | -1) => {
    if (fields.length === 0) return;
    // From the store, not the render: tapping "next" first blurs (and closes) the field being edited.
    const from = fields.findIndex((f) => f.id === useFormState.getState().cursor);
    const next = fields[from < 0 ? (step === 1 ? 0 : fields.length - 1) : (from + step + fields.length) % fields.length];
    if (!next) return;
    onJump(next.page, Math.max(0, next.rect.y - 48));
    setActive(next.id);
  };

  return (
    <section
      ref={ref}
      aria-label={t("forms.title")}
      className="absolute inset-x-0 bottom-0 z-10 rounded-t-sheet border-t border-neutral-5 bg-surface-raised shadow-3"
      style={{ paddingBottom: "calc(var(--safe-bottom) + 8px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="form-sheet"
    >
      <div className="flex justify-center pt-2 pb-1" aria-hidden="true">
        <span className="h-1 w-9 rounded-full bg-neutral-6" />
      </div>
      <div className="flex items-center gap-1 px-3">
        <IconButton
          label={t("forms.previous")}
          icon={<ChevronLeft size={22} strokeWidth={1.75} />}
          onClick={() => go(-1)}
          disabled={fields.length === 0}
          data-testid="form-previous"
        />
        <span className="min-w-0 flex-1 truncate text-center text-sm text-neutral-12 tabular-nums" aria-live="polite" data-testid="form-position">
          {fields.length === 0
            ? t("forms.noFields")
            : index >= 0
              ? t("forms.fieldCount", { index: index + 1, total: fields.length })
              : t("forms.hint")}
        </span>
        <IconButton
          label={t("forms.next")}
          icon={<ChevronRight size={22} strokeWidth={1.75} />}
          onClick={() => go(1)}
          disabled={fields.length === 0}
          data-testid="form-next"
        />
      </div>
      <div className="flex justify-end px-4 pt-1 pb-1">
        <Button variant="secondary" onClick={() => setConfirming(true)} disabled={fields.length === 0} data-testid="form-flatten">
          <Layers size={18} strokeWidth={1.75} aria-hidden="true" />
          {t("forms.flatten")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("forms.flattenTitle")}
        message={t("forms.flattenBody")}
        confirmLabel={t("forms.flattenConfirm")}
        cancelLabel={t("forms.flattenCancel")}
        onConfirm={() => {
          setConfirming(false);
          onFlatten();
        }}
        onCancel={() => setConfirming(false)}
        testId="flatten-dialog"
      />
    </section>
  );
});
