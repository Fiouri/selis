import { Button } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { type SyntheticEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import { type Document, errorMessageKey } from "../../lib/api";
import { createTag, setDocumentTags, useTags } from "./queries";

/** Text field + add button that creates a tag (and hands it back). */
export function NewTagField({ onCreated }: { onCreated: (tagId: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const inputId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const tag = await createTag(queryClient, clean);
      setName("");
      onCreated(tag.id);
    } catch (err) {
      showToast(t(errorMessageKey(err)), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex items-center gap-2 px-5 pt-2">
      <label htmlFor={inputId} className="sr-only">
        {t("tags.newTag")}
      </label>
      <input
        id={inputId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("tags.newTag")}
        maxLength={48}
        enterKeyHint="done"
        autoComplete="off"
        className="selis-focus h-11 min-w-0 flex-1 rounded-full border border-neutral-6 bg-surface-app px-4 text-md text-neutral-12 placeholder:text-neutral-9"
      />
      <Button type="submit" variant="secondary" disabled={!name.trim() || busy} icon={<Plus size={20} strokeWidth={1.75} />} className="rounded-full">
        {t("tags.add")}
      </Button>
    </form>
  );
}

/** Check list of tags for one document; changes apply at once. */
export function TagPicker({ doc, onDone }: { doc: Document; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const tags = useTags();
  // Local: in a tag-filtered view the document may leave the list while it is edited.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(doc.tagIds));

  const apply = async (next: Set<string>) => {
    const previous = selected;
    setSelected(next);
    const ok = await setDocumentTags(queryClient, { ...doc, tagIds: [...previous] }, [...next].sort());
    if (!ok) {
      setSelected(previous);
      showToast(t("errors.generic"), "error");
    }
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void apply(next);
  };

  const list = tags.data ?? [];
  return (
    <div className="flex flex-col pb-2" data-testid="tag-picker">
      {list.length === 0 ? (
        <p className="px-5 py-3 text-sm text-neutral-11">{t("tags.none")}</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((tag) => {
            const on = selected.has(tag.id);
            return (
              <li key={tag.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(tag.id)}
                  className="selis-focus flex min-h-12 w-full items-center gap-3 px-5 text-left text-md text-neutral-12 active:bg-neutral-3"
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors duration-150 ease-standard ${
                      on ? "border-accent-9 bg-accent-9 text-accent-contrast" : "border-neutral-7"
                    }`}
                    aria-hidden="true"
                  >
                    {on ? <Check size={16} strokeWidth={2.5} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <NewTagField onCreated={(id) => void apply(new Set(selected).add(id))} />
      <div className="flex justify-end px-5 pt-3">
        <Button onClick={onDone} className="rounded-full">
          {t("tags.done")}
        </Button>
      </div>
    </div>
  );
}
