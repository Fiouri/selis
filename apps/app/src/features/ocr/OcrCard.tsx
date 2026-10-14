/**
 * The OCR job's card under the viewer's top bar (P4d; docs/design/p4-ui-brief.md §8): fixed
 * 88 px (no layout shift): "Reading page 3 of 12…" over a progress bar with Cancel; once stopped
 * "Stopped at page 3 of 12" with Resume (finished pages are kept) and a close button.
 */
import { Button, IconButton } from "@selis/ui";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import { useOcr } from "./ocrStore";

export function OcrCard({ docId, top }: { docId: string; top: number }) {
  const { t } = useTranslation();
  const phase = useOcr((s) => s.phase);
  const owner = useOcr((s) => s.docId);
  if (owner !== docId || phase.step === "idle") return null;

  const preparing = phase.step === "preparing";
  const finishing = phase.step === "finishing";
  const stopped = phase.step === "stopped";
  const done = phase.step === "running" || phase.step === "stopped" ? phase.done : finishing ? phase.total : 0;
  const total = phase.step === "running" || phase.step === "stopped" || finishing ? phase.total : 0;
  // The page being read counts from 1 in what the user sees.
  const label = preparing
    ? t("ocr.preparing")
    : finishing
      ? t("ocr.finishing")
      : stopped
        ? phase.reason === "failed"
          ? t("ocr.failedAt", { page: done + 1, total })
          : t("ocr.stoppedAt", { page: done + 1, total })
        : t("ocr.reading", { page: done + 1, total });
  const fraction = total > 0 ? done / total : 0;

  const resume = async () => {
    const outcome = await useOcr.getState().resume();
    if (outcome.kind === "saved") useToast.getState().show(t("ocr.saved"));
    else if (outcome.kind === "failed") useToast.getState().show(t("ocr.failed"), "error");
  };

  return (
    <div
      className="absolute z-10 flex h-[88px] flex-col justify-center gap-1 rounded-[12px] border border-neutral-5 bg-surface-raised px-4 shadow-2"
      style={{ top: top + 8, left: "calc(var(--safe-left) + 12px)", right: "calc(var(--safe-right) + 12px)" }}
      role="status"
      data-testid="ocr-card"
      data-step={phase.step}
    >
      <span className="truncate text-md font-semibold text-neutral-12" data-testid="ocr-label">
        {label}
      </span>
      <div className="flex h-9 items-center gap-2">
        <div
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-4"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, total)}
          aria-valuenow={done}
          aria-valuetext={t("ocr.progressText", { done, total })}
        >
          <div
            className={`h-full rounded-full ${stopped ? "bg-neutral-8" : "bg-accent-9"} transition-[width] duration-200 ease-standard motion-reduce:transition-none`}
            style={{ width: `${String(Math.round((preparing ? 0 : fraction) * 100))}%` }}
          />
        </div>
        {phase.step === "running" ? (
          <Button variant="ghost" className="h-9 min-h-9 px-3" onClick={() => useOcr.getState().cancel()} data-testid="ocr-cancel">
            {t("ocr.cancel")}
          </Button>
        ) : stopped ? (
          <>
            <Button variant="secondary" className="h-9 min-h-9 px-3" onClick={() => void resume()} data-testid="ocr-resume">
              {t("ocr.resume")}
            </Button>
            <IconButton label={t("ocr.dismiss")} icon={<X size={20} strokeWidth={1.75} />} onClick={() => useOcr.getState().reset()} data-testid="ocr-dismiss" />
          </>
        ) : null}
      </div>
    </div>
  );
}
