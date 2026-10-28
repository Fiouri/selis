/**
 * Viewer → ⋮ → Export (P7c, ADR 0035): Word (editable text, layout simplified), text, Markdown,
 * or every page as an image in a ZIP. Mounted once; its outcomes show as toasts.
 */
import { Button } from "@selis/ui";
import { ChevronRight, FileText, FileType, Images, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { Busy } from "../transfer/parts";
import { type ExportKind, type ImageFormat, useExport } from "./exportStore";

const row = "selis-focus flex min-h-16 w-full items-center gap-4 px-5 py-2 text-left active:bg-neutral-3";

function MenuRow({ icon, title, note, onClick, testId }: { icon: React.ReactNode; title: string; note: string; onClick: () => void; testId: string }) {
  return (
    <li>
      <button type="button" className={row} onClick={onClick} data-testid={testId}>
        <span className="text-neutral-11" aria-hidden="true">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-md text-neutral-12">{title}</span>
          <span className="text-[13px] text-neutral-11">{note}</span>
        </span>
        <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />
      </button>
    </li>
  );
}

export function ExportSheets() {
  const { t } = useTranslation();
  const doc = useExport((s) => s.doc);
  const view = useExport((s) => s.view);
  const close = useExport((s) => s.close);
  const show = useExport((s) => s.show);
  const run = useExport((s) => s.run);
  const notice = useExport((s) => s.notice);
  const [format, setFormat] = useState<ImageFormat>("png");

  // Each notice once (`seq` grows with every one).
  const shown = useRef(0);
  useEffect(() => {
    if (!notice || notice.seq === shown.current) return;
    shown.current = notice.seq;
    useToast.getState().show(t(`export.notice.${notice.key}`), notice.error ? "error" : "info");
  }, [notice, t]);

  const start = (kind: ExportKind) => void run(kind, format);
  const running = view.step === "running";
  const icons = { docx: <FileType size={22} strokeWidth={1.75} />, txt: <FileText size={22} strokeWidth={1.75} />, md: <Type size={22} strokeWidth={1.75} /> };

  return (
    <>
      <Sheet open={doc !== null && view.step === "menu"} onClose={close} title={t("export.title")} testId="export-sheet">
        <ul className="flex flex-col pt-1 pb-2">
          <MenuRow icon={icons.docx} title={t("export.word")} note={t("export.wordNote")} onClick={() => start("docx")} testId="export-word" />
          <MenuRow icon={icons.txt} title={t("export.text")} note={t("export.textNote")} onClick={() => start("txt")} testId="export-text" />
          <MenuRow icon={icons.md} title={t("export.markdown")} note={t("export.markdownNote")} onClick={() => start("md")} testId="export-markdown" />
          <MenuRow
            icon={<Images size={22} strokeWidth={1.75} />}
            title={t("export.images")}
            note={t("export.imagesNote")}
            onClick={() => show({ step: "images" })}
            testId="export-images"
          />
        </ul>
      </Sheet>
      <Sheet open={doc !== null && view.step === "images"} onClose={() => show({ step: "menu" })} title={t("export.imagesTitle")} testId="export-images-sheet">
        <div className="flex flex-col gap-3 px-5 pb-5">
          <div role="radiogroup" aria-label={t("export.format")} className="flex gap-2">
            {(["png", "jpeg"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={format === value}
                onClick={() => setFormat(value)}
                className={`selis-focus h-11 flex-1 rounded-[12px] border text-md ${format === value ? "border-accent-9 bg-accent-3 text-neutral-12" : "border-control-line text-neutral-11"}`}
              >
                {t(value === "png" ? "export.png" : "export.jpeg")}
              </button>
            ))}
          </div>
          <p className="text-[13px] text-neutral-11">{t("export.imagesHint", { count: doc?.pageCount ?? 0 })}</p>
          <Button onClick={() => start("images")} data-testid="export-images-save">
            {t("export.save")}
          </Button>
        </div>
      </Sheet>
      <Sheet open={doc !== null && running} onClose={close} title={t("export.title")} testId="export-running">
        <div className="flex h-24 items-center justify-center px-5 pb-5">
          {view.step === "running" ? <Busy label={t("export.running", { done: view.done, total: view.total })} testId="export-busy" /> : null}
        </div>
      </Sheet>
    </>
  );
}
