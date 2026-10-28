/**
 * "Convert to PDF" (P7c, ADR 0035): full screen over the library. Converting, then a preview
 * of the PDF's pages with the note that the layout may differ from Word/Excel; "Save" adds it
 * to the library and opens it, "Cancel" (or back) throws it away. The source file is untouched.
 */
import { Button, IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FullScreenLayer } from "../../components/FullScreenLayer";
import { useToast } from "../../components/Toast";
import { currentRenderLimits } from "../../lib/engine";
import { useNavigation, useOverlay, whenHistorySettled } from "../../state/navigation";
import { documentsKey } from "../library/queries";
import { Busy } from "../transfer/parts";
import { PdfViewer } from "../viewer/PdfViewer";
import { useConvert } from "./convertStore";

export function ConvertScreen() {
  const { t } = useTranslation();
  const view = useConvert((s) => s.view);
  const save = useConvert((s) => s.save);
  const close = useConvert((s) => s.close);
  const openDocument = useNavigation((s) => s.openDocument);
  const showToast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const open = view.step !== "idle";
  useOverlay(open, close);
  if (!open) return null;

  const saving = view.step === "saving";
  const onSave = async () => {
    try {
      const document = await save();
      if (!document) return;
      void queryClient.invalidateQueries({ queryKey: documentsKey });
      showToast(t("convert.saved"));
      // The screen just closed: its history entry must be gone before the viewer's is pushed.
      await whenHistorySettled();
      openDocument(document.id);
    } catch {
      showToast(t("convert.saveFailed"), "error");
    }
  };

  return (
    <FullScreenLayer label={t("convert.title")} className="bg-surface-app" testId="convert-screen">
      <header
        className="flex shrink-0 items-center gap-1 border-b border-neutral-5 px-1"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        <IconButton label={t("convert.close")} icon={<X size={22} strokeWidth={1.75} />} onClick={close} disabled={saving} />
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-neutral-12">{t("convert.title")}</h1>
      </header>
      {view.step === "converting" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Busy label={t("convert.converting", { name: view.name })} testId="convert-busy" />
        </div>
      ) : null}
      {view.step === "failed" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center" data-testid="convert-failed">
          <p className="text-md text-neutral-12">{t(`convert.problem.${view.problem}`, { name: view.name })}</p>
          <Button variant="secondary" onClick={close}>
            {t("convert.close")}
          </Button>
        </div>
      ) : null}
      {view.step === "preview" || view.step === "saving" ? (
        <>
          <p className="flex shrink-0 items-start gap-2 bg-neutral-2 px-5 py-3 text-[13px] text-neutral-11" data-testid="convert-note">
            <Info size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-semibold text-neutral-12">{t("convert.fileName", { title: view.title })}</span> ·{" "}
              {t("convert.pages", { count: view.doc.pageCount })} · {t("convert.layoutNote")}
            </span>
          </p>
          <div className="relative min-h-0 flex-1" data-testid="convert-preview">
            <PdfViewer doc={view.doc} maxPixels={currentRenderLimits().maxBitmapPixels} zoomable testId="convert-viewer" />
          </div>
          <footer
            className="flex shrink-0 gap-3 border-t border-neutral-5 px-5 pt-3"
            style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}
          >
            <Button variant="secondary" className="flex-1" onClick={close} disabled={saving} data-testid="convert-cancel">
              {t("convert.cancel")}
            </Button>
            <Button className="flex-1" onClick={() => void onSave()} disabled={saving} data-testid="convert-save">
              {saving ? t("convert.saving") : t("convert.save")}
            </Button>
          </footer>
        </>
      ) : null}
    </FullScreenLayer>
  );
}
