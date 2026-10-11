import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Star, Tag as TagIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import type { Document } from "../../lib/api";
import { documentTitle } from "./importFeedback";
import { setFavorite } from "./queries";
import { TagPicker } from "./TagPicker";

/** Long-press menu of a library document: favorite, tags. */
export function DocumentMenu({ doc, onClose }: { doc: Document | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const [mode, setMode] = useState<"menu" | "tags">("menu");
  const close = () => {
    setMode("menu");
    onClose();
  };

  if (!doc) return <Sheet open={false} onClose={close} title="">{null}</Sheet>;
  const title = documentTitle(doc, t("library.untitled"));

  const toggleFavorite = async () => {
    close();
    const ok = await setFavorite(queryClient, doc, !doc.favorite);
    if (!ok) showToast(t("errors.generic"), "error");
  };

  return (
    <Sheet
      open
      onClose={close}
      title={mode === "menu" ? title : t("tags.assignTitle", { title })}
      testId="document-menu"
    >
      {mode === "menu" ? (
        <ul className="flex flex-col pb-2">
          <li>
            <button type="button" onClick={() => void toggleFavorite()} className="selis-focus flex min-h-14 w-full items-center gap-4 px-5 text-left text-md text-neutral-12 active:bg-neutral-3">
              <Star size={22} strokeWidth={1.75} className={doc.favorite ? "fill-warning-9 text-warning-9" : "text-neutral-11"} aria-hidden="true" />
              {doc.favorite ? t("library.removeFavorite") : t("library.addFavorite")}
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setMode("tags")} className="selis-focus flex min-h-14 w-full items-center gap-4 px-5 text-left text-md text-neutral-12 active:bg-neutral-3">
              <TagIcon size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
              <span className="flex-1">{t("library.editTags")}</span>
              <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />
            </button>
          </li>
        </ul>
      ) : (
        <div className="flex flex-col">
          <button type="button" onClick={() => setMode("menu")} className="selis-focus mx-3 mb-1 flex min-h-11 items-center gap-1 self-start rounded-full px-2 text-sm font-medium text-accent-selected">
            <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
            {t("tags.back")}
          </button>
          <TagPicker doc={doc} onDone={close} />
        </div>
      )}
    </Sheet>
  );
}
