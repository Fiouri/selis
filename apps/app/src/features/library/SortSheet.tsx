import { Check, LayoutGrid, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import type { LibrarySort, LibraryView } from "../../lib/api";
import { useSettings } from "../../state/settings";

const SORTS: ReadonlyArray<{ value: LibrarySort; key: string }> = [
  { value: "recent", key: "library.sortRecent" },
  { value: "name", key: "library.sortName" },
  { value: "size", key: "library.sortSize" },
];

const VIEWS: ReadonlyArray<{ value: LibraryView; key: string; Icon: typeof LayoutGrid }> = [
  { value: "grid", key: "library.viewGrid", Icon: LayoutGrid },
  { value: "list", key: "library.viewList", Icon: List },
];

/** Sort order and grid/list; both persist (settings) and apply at once. */
export function SortSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const sort = useSettings((s) => s.librarySort);
  const view = useSettings((s) => s.libraryView);
  const setSort = useSettings((s) => s.setLibrarySort);
  const setView = useSettings((s) => s.setLibraryView);

  return (
    <Sheet open={open} onClose={onClose} title={t("library.sortTitle")} testId="sort-sheet">
      <div role="radiogroup" aria-label={t("library.sortTitle")} className="flex flex-col">
        {SORTS.map(({ value, key }) => {
          const selected = sort === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                void setSort(value);
                onClose();
              }}
              className={`selis-focus flex min-h-12 items-center justify-between px-5 text-left text-md active:bg-neutral-3 ${
                selected ? "font-semibold text-accent-selected" : "text-neutral-12"
              }`}
            >
              {t(key)}
              {selected ? <Check size={20} strokeWidth={2} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <h3 className="mt-5 mb-2 px-5 text-[13px] font-semibold text-neutral-11">{t("library.view")}</h3>
      <div role="radiogroup" aria-label={t("library.view")} className="grid grid-cols-2 gap-2 px-5 pb-2">
        {VIEWS.map(({ value, key, Icon }) => {
          const selected = view === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                void setView(value);
                onClose();
              }}
              className={`selis-focus flex h-13 items-center justify-center gap-2 rounded-card text-sm transition-colors duration-150 ease-standard ${
                selected
                  ? "bg-accent-3 font-semibold text-accent-selected shadow-[inset_0_0_0_2px_var(--accent-9)]"
                  : "border border-neutral-6 font-medium text-neutral-11 active:bg-neutral-3"
              }`}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              {t(key)}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
