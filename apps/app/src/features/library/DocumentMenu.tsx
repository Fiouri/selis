import { IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Pencil, Star, Tag as TagIcon, Trash2, Wrench, X } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import type { Document } from "../../lib/api";
import { documentTitle } from "./importFeedback";
import { useTools } from "../tools/toolsStore";
import { deleteDocument, documentsKey, patchCachedDocument, renameDocument, setFavorite } from "./queries";
import { TagPicker } from "./TagPicker";

type Mode = "menu" | "tags" | "rename" | "delete";

/** Same limit as the backend (`MAX_TITLE_CHARS`). */
const MAX_TITLE_CHARS = 512;

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
  trailing,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className={`selis-focus flex min-h-14 w-full items-center gap-4 px-5 text-left text-md active:bg-neutral-3 ${
          danger ? "text-danger-11" : "text-neutral-12"
        }`}
      >
        {icon}
        <span className="flex-1">{label}</span>
        {trailing}
      </button>
    </li>
  );
}

function RenameForm({ doc, onDone }: { doc: Document; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const inputId = useId();
  const [title, setTitle] = useState(doc.title);
  const clean = title.trim();

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    onDone();
    if (!clean || clean === doc.title) return;
    const previous = doc;
    if (!(await renameDocument(queryClient, doc, clean))) {
      showToast(t("errors.generic"), "error");
      return;
    }
    showToast(t("library.renamed", { title: clean }), "info", {
      action: {
        label: t("library.undo"),
        onClick: () => {
          void (async () => {
            const ok = await renameDocument(queryClient, { ...previous, title: clean }, previous.title);
            if (!ok) showToast(t("errors.generic"), "error");
          })();
        },
      },
    });
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex items-center gap-2 px-5 pb-4">
      <label htmlFor={inputId} className="sr-only">
        {t("library.renameLabel")}
      </label>
      <input
        id={inputId}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        maxLength={MAX_TITLE_CHARS}
        autoFocus
        enterKeyHint="done"
        autoComplete="off"
        data-testid="rename-input"
        className="selis-focus h-11 min-w-0 flex-1 rounded-full border border-neutral-6 bg-surface-app px-4 text-md text-neutral-12"
      />
      <IconButton
        type="submit"
        label={t("library.renameSave")}
        icon={<Check size={22} strokeWidth={1.75} />}
        disabled={!clean}
        className="text-accent-selected disabled:opacity-45"
        data-testid="rename-save"
      />
      <IconButton label={t("library.renameCancel")} icon={<X size={22} strokeWidth={1.75} />} onClick={onDone} />
    </form>
  );
}

/** Long-press menu of a library document: favorite, tags, rename, delete. */
export function DocumentMenu({ doc, onClose }: { doc: Document | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const [mode, setMode] = useState<Mode>("menu");
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

  const remove = async () => {
    close();
    const ok = await deleteDocument(queryClient, doc);
    showToast(ok ? t("library.deleted", { title }) : t("errors.generic"), ok ? "info" : "error");
  };

  const sheetTitle =
    mode === "tags" ? t("tags.assignTitle", { title }) : mode === "rename" ? t("library.rename") : title;

  return (
    <>
      <Sheet open={mode !== "delete"} onClose={close} title={sheetTitle} testId="document-menu">
        {mode === "menu" ? (
          <ul className="flex flex-col pb-2">
            <MenuItem
              icon={<Star size={22} strokeWidth={1.75} className={doc.favorite ? "fill-warning-9 text-warning-9" : "text-neutral-11"} aria-hidden="true" />}
              label={doc.favorite ? t("library.removeFavorite") : t("library.addFavorite")}
              onClick={() => void toggleFavorite()}
            />
            <MenuItem
              icon={<TagIcon size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />}
              label={t("library.editTags")}
              onClick={() => setMode("tags")}
              trailing={<ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />}
            />
            <MenuItem
              icon={<Wrench size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />}
              label={t("tools.open")}
              onClick={() => {
                close();
                void useTools.getState().open(doc.id, (document) => {
                  patchCachedDocument(queryClient, document);
                  void queryClient.invalidateQueries({ queryKey: documentsKey });
                });
              }}
              trailing={<ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />}
              testId="menu-tools"
            />
            <MenuItem
              icon={<Pencil size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />}
              label={t("library.rename")}
              onClick={() => setMode("rename")}
              testId="menu-rename"
            />
            <MenuItem
              icon={<Trash2 size={22} strokeWidth={1.75} aria-hidden="true" />}
              label={t("library.delete")}
              onClick={() => setMode("delete")}
              danger
              testId="menu-delete"
            />
          </ul>
        ) : mode === "rename" ? (
          <RenameForm doc={doc} onDone={close} />
        ) : mode === "tags" ? (
          <div className="flex flex-col">
            <button type="button" onClick={() => setMode("menu")} className="selis-focus mx-3 mb-1 flex min-h-11 items-center gap-1 self-start rounded-full px-2 text-sm font-medium text-accent-selected">
              <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
              {t("tags.back")}
            </button>
            <TagPicker doc={doc} onDone={close} />
          </div>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={mode === "delete"}
        title={t("library.deleteTitle", { title })}
        message={doc.kind === "linked" ? t("library.deleteLinked") : t("library.deleteImported")}
        confirmLabel={t("library.deleteConfirm")}
        cancelLabel={t("library.deleteCancel")}
        danger
        onConfirm={() => void remove()}
        onCancel={close}
        testId="delete-dialog"
      />
    </>
  );
}
