import { Button, IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { errorMessageKey, type Tag } from "../../lib/api";
import { useLibraryView } from "./libraryStore";
import { deleteTag, renameTag, useTags } from "./queries";
import { NewTagField } from "./TagPicker";

const CONFIRM_MS = 3_000;

function EditTagRow({ tag, onDone }: { tag: Tag; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const inputId = useId();
  const [name, setName] = useState(tag.name);
  const [confirming, setConfirming] = useState(false);
  const tagId = useLibraryView((s) => s.tagId);
  const setTag = useLibraryView((s) => s.setTag);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || clean === tag.name) {
      onDone();
      return;
    }
    try {
      await renameTag(queryClient, tag.id, clean);
      onDone();
    } catch (err) {
      showToast(t(errorMessageKey(err)), "error");
    }
  };

  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (tagId === tag.id) setTag(null);
    onDone();
    try {
      await deleteTag(queryClient, tag.id);
    } catch {
      showToast(t("errors.generic"), "error");
    }
  };

  return (
    <li className="flex flex-col gap-2 border-y border-neutral-5 bg-neutral-2 px-5 py-3">
      <form onSubmit={(e) => void save(e)} className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t("tags.rename")}
        </label>
        <input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={48}
          autoFocus
          enterKeyHint="done"
          autoComplete="off"
          className="selis-focus h-11 min-w-0 flex-1 rounded-full border border-neutral-6 bg-surface-app px-4 text-md text-neutral-12"
        />
        <IconButton type="submit" label={t("tags.save")} icon={<Check size={22} strokeWidth={1.75} />} className="text-accent-selected" />
        <IconButton label={t("tags.cancel")} icon={<X size={22} strokeWidth={1.75} />} onClick={onDone} />
      </form>
      <Button
        variant="ghost"
        onClick={() => void remove()}
        icon={<Trash2 size={20} strokeWidth={1.75} />}
        className="self-start rounded-full text-danger-11"
      >
        {confirming ? t("tags.confirmDelete") : t("tags.delete")}
      </Button>
    </li>
  );
}

/** "Tags" chip: filter by one tag, rename / delete / create tags. */
export function TagsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const tags = useTags();
  const tagId = useLibraryView((s) => s.tagId);
  const setTag = useLibraryView((s) => s.setTag);
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => {
    setEditing(null);
    onClose();
  };

  const list = tags.data ?? [];
  return (
    <Sheet open={open} onClose={close} title={t("tags.title")} testId="tags-sheet">
      <div className="flex flex-col pb-2">
        {list.length === 0 ? <p className="px-5 py-3 text-sm text-neutral-11">{t("tags.none")}</p> : null}
        <ul className="flex flex-col">
          {list.map((tag) =>
            editing === tag.id ? (
              <EditTagRow key={tag.id} tag={tag} onDone={() => setEditing(null)} />
            ) : (
              <li key={tag.id} className="flex items-center pr-2">
                <button
                  type="button"
                  aria-pressed={tagId === tag.id}
                  onClick={() => {
                    setTag(tagId === tag.id ? null : tag.id);
                    close();
                  }}
                  className="selis-focus flex min-h-12 min-w-0 flex-1 items-center gap-3 pl-5 text-left active:bg-neutral-3"
                >
                  <span className={`min-w-0 flex-1 truncate text-md ${tagId === tag.id ? "font-semibold text-accent-selected" : "text-neutral-12"}`}>
                    {tag.name}
                  </span>
                  <span className="text-sm text-neutral-11 tabular-nums">{tag.documentCount}</span>
                  {tagId === tag.id ? <Check size={20} strokeWidth={2} className="text-accent-selected" aria-hidden="true" /> : <span className="w-5" />}
                </button>
                <IconButton
                  label={t("tags.edit", { name: tag.name })}
                  icon={<Pencil size={20} strokeWidth={1.75} />}
                  onClick={() => setEditing(tag.id)}
                  className="text-neutral-11"
                />
              </li>
            ),
          )}
        </ul>
        <NewTagField onCreated={() => undefined} />
      </div>
    </Sheet>
  );
}
