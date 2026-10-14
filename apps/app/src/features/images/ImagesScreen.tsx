/**
 * "Images to PDF" (P4b; docs/design/p4-ui-brief.md §5): full screen over the library. A grid
 * of the picked photos (move earlier / later, remove), the page size, and "Create PDF". The new
 * document opens in the viewer. Back closes the screen (the photos are let go).
 */
import type { PageSizeOption } from "@selis/engine";
import { Button, IconButton, Segmented } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import { useNavigation, useOverlay, whenHistorySettled } from "../../state/navigation";
import { documentsKey } from "../library/queries";
import { Busy } from "../transfer/parts";
import { nativePicker, useImages } from "./imagesStore";

/** Opens the picker: the native one (Android) or the file input (iOS shows PHPicker, desktop a dialog). */
export function usePickImages(): { pick: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const pickNative = useImages((s) => s.pickNative);
  const addFiles = useImages((s) => s.addFiles);
  const input = nativePicker ? null : (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      multiple
      hidden
      data-testid="images-input"
      onChange={(event) => {
        addFiles([...(event.target.files ?? [])]);
        // The same photos can be picked again.
        event.target.value = "";
      }}
    />
  );
  return {
    pick: () => {
      if (nativePicker) void pickNative();
      else ref.current?.click();
    },
    input,
  };
}

function today(locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function ImagesScreen() {
  const { t, i18n } = useTranslation();
  const phase = useImages((s) => s.phase);
  const items = useImages((s) => s.items);
  const size = useImages((s) => s.size);
  const setSize = useImages((s) => s.setSize);
  const move = useImages((s) => s.move);
  const remove = useImages((s) => s.remove);
  const close = useImages((s) => s.close);
  const create = useImages((s) => s.create);
  const openDocument = useNavigation((s) => s.openDocument);
  const showToast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const { pick, input } = usePickImages();
  const open = phase.step === "edit" || phase.step === "creating" || (phase.step === "picking" && items.length > 0);
  const creating = phase.step === "creating";
  useOverlay(open, close);

  const sizes: { value: PageSizeOption; label: string }[] = [
    { value: "fit", label: t("images.sizeFit") },
    { value: "a4", label: t("images.sizeA4") },
    { value: "letter", label: t("images.sizeLetter") },
  ];

  const onCreate = async () => {
    const result = await create(t("images.documentTitle", { date: today(i18n.language) }));
    if (result.kind === "created") {
      void queryClient.invalidateQueries({ queryKey: documentsKey });
      if (result.skipped > 0) showToast(t("images.skipped", { count: result.skipped }), "error");
      // The screen just closed: its history entry must be gone before the viewer's is pushed.
      await whenHistorySettled();
      openDocument(result.document.id);
    } else if (result.kind === "noneReadable") {
      showToast(t("images.noneReadable"), "error");
    } else {
      showToast(t("images.failed"), "error");
    }
  };

  return (
    <>
      {input}
      {open ? (
        <div className="fixed inset-0 z-30 flex flex-col bg-surface-app" data-testid="images-screen">
          <header
            className="flex shrink-0 items-center gap-1 border-b border-neutral-5 px-1"
            style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
          >
            <IconButton label={t("images.close")} icon={<X size={22} strokeWidth={1.75} />} onClick={close} disabled={creating} />
            <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-neutral-12">{t("images.title")}</h1>
            <span className="px-2 text-sm text-neutral-11 tabular-nums" data-testid="images-count">
              {t("images.count", { count: items.length })}
            </span>
            <IconButton label={t("images.add")} icon={<ImagePlus size={22} strokeWidth={1.75} />} onClick={pick} disabled={creating} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <ul className="grid grid-cols-3 gap-3" data-testid="images-grid">
              {items.map((item, index) => (
                <li key={item.id} className="flex flex-col gap-1" data-testid="images-tile">
                  <div className="relative aspect-square overflow-hidden rounded-[12px] bg-neutral-3">
                    <img src={item.thumb} alt="" className="size-full object-contain" />
                    <button
                      type="button"
                      className="selis-focus absolute top-0 right-0 flex size-11 items-center justify-center"
                      aria-label={t("images.remove", { number: index + 1 })}
                      onClick={() => remove(item.id)}
                      disabled={creating}
                      data-testid="images-remove"
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
                      aria-label={t("images.earlier", { number: index + 1 })}
                      onClick={() => move(item.id, -1)}
                      disabled={creating || index === 0}
                    >
                      <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <span className="text-sm text-neutral-11 tabular-nums">{index + 1}</span>
                    <button
                      type="button"
                      className="selis-focus flex size-11 items-center justify-center rounded-full text-neutral-11 disabled:opacity-40"
                      aria-label={t("images.later", { number: index + 1 })}
                      onClick={() => move(item.id, 1)}
                      disabled={creating || index === items.length - 1}
                    >
                      <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <footer
            className="flex shrink-0 flex-col gap-3 border-t border-neutral-5 px-5 pt-3"
            style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}
          >
            <Segmented options={sizes} value={size} onChange={setSize} label={t("images.size")} idPrefix="images-size" testId="images-size" />
            <p className="text-[13px] text-neutral-11">{t("images.privacy")}</p>
            {creating ? (
              <div className="flex h-12 items-center justify-center">
                <Busy label={t("images.creating", { done: phase.done, total: phase.total })} testId="images-creating" />
              </div>
            ) : (
              <Button onClick={() => void onCreate()} disabled={items.length === 0} data-testid="images-create">
                {t("images.create")}
              </Button>
            )}
          </footer>
        </div>
      ) : null}
    </>
  );
}
