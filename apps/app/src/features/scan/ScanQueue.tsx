/**
 * The scanned pages (P4c; docs/design/p4-ui-brief.md §7): a grid like Images → PDF (move
 * earlier / later, remove), "Add page" back to the camera, and "Save as PDF".
 */
import { Button, IconButton } from "@selis/ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Busy } from "../transfer/parts";
import { useScan } from "./scanStore";

export function ScanQueue({ onSave }: { onSave: () => void }) {
  const { t } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pages = useScan((s) => s.pages);
  const move = useScan((s) => s.move);
  const remove = useScan((s) => s.remove);
  const backToCamera = useScan((s) => s.backToCamera);
  const saving = phase.step === "saving";

  return (
    <div className="flex h-full flex-col bg-surface-app text-neutral-12" data-testid="scan-queue">
      <header
        className="flex shrink-0 items-center gap-1 border-b border-neutral-5 px-1"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        <IconButton label={t("scan.backToCamera")} icon={<ChevronLeft size={22} strokeWidth={1.75} />} onClick={backToCamera} disabled={saving} />
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{t("scan.queueTitle")}</h1>
        <span className="px-3 text-sm text-neutral-11 tabular-nums" data-testid="scan-queue-count">
          {t("scan.count", { count: pages.length })}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ul className="grid grid-cols-3 gap-3" data-testid="scan-pages">
          {pages.map((page, index) => (
            <li key={page.id} className="flex flex-col gap-1" data-testid="scan-page">
              <div className="relative aspect-[3/4] overflow-hidden rounded-[12px] border border-neutral-5 bg-neutral-3">
                <img src={page.thumb} alt={t("scan.pageNumber", { number: index + 1 })} className="size-full object-contain" />
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
                <span className="text-sm text-neutral-11 tabular-nums">{index + 1}</span>
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
          ))}
        </ul>
      </div>
      <footer className="flex shrink-0 flex-col gap-3 border-t border-neutral-5 px-5 pt-3" style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}>
        {saving ? (
          <div className="flex h-12 items-center justify-center">
            <Busy label={t("scan.saving", { done: phase.done, total: phase.total })} testId="scan-saving" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={backToCamera} data-testid="scan-add-page">
              {t("scan.addPage")}
            </Button>
            <Button onClick={onSave} disabled={pages.length === 0} data-testid="scan-save">
              {t("scan.save")}
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}
