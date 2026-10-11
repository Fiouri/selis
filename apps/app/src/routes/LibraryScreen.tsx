import { Button, Chip, EmptyState, IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, ChevronDown, FilePlus2, Plus, Search, SearchX, X } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryIllustration } from "../components/Illustrations";
import { ScreenHeader } from "../components/ScreenHeader";
import { DocumentCollection, DocumentCollectionSkeleton } from "../features/library/DocumentCollection";
import { showImported, showImportError } from "../features/library/importFeedback";
import { isBusy } from "../features/library/importMachine";
import { ALL_DOCUMENTS, type ChipFilter, libraryQuery, useLibraryView } from "../features/library/libraryStore";
import { useDocuments, useTags } from "../features/library/queries";
import { SortSheet } from "../features/library/SortSheet";
import { TagsSheet } from "../features/library/TagsSheet";
import { importController, useImportState } from "../features/library/useImport";
import { errorMessageKey } from "../lib/api";
import { useOverlay } from "../state/navigation";
import { useSettings } from "../state/settings";

/** FAB height + its 20 px margin + breathing room, so the last row is never covered. */
const FAB_CLEARANCE = 56 + 20 + 20;

const CHIPS: ReadonlyArray<{ value: ChipFilter; key: string }> = [
  { value: "all", key: "library.filterAll" },
  { value: "favorites", key: "library.filterFavorites" },
  { value: "received", key: "library.filterReceived" },
];

function useStartImport() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return () =>
    importController().start({
      onDone: (outcome) => showImported(queryClient, t, outcome),
      onError: (state) => showImportError(t, state),
    });
}

function SearchField() {
  const { t } = useTranslation();
  const inputId = useId();
  const search = useLibraryView((s) => s.search);
  const setSearch = useLibraryView((s) => s.setSearch);
  const closeSearch = useLibraryView((s) => s.closeSearch);
  return (
    <header style={{ paddingTop: "var(--safe-top)" }}>
      <div className="flex h-13 items-center gap-1 pr-2 pl-4">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search size={20} strokeWidth={1.75} className="pointer-events-none absolute left-3 text-neutral-11" aria-hidden="true" />
          <label htmlFor={inputId} className="sr-only">
            {t("library.searchLabel")}
          </label>
          <input
            id={inputId}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("library.searchPlaceholder")}
            autoFocus
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            data-testid="library-search"
            className="selis-focus h-11 w-full rounded-full bg-neutral-3 pr-10 pl-10 text-md text-neutral-12 placeholder:text-neutral-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {search ? (
            <IconButton
              label={t("library.searchClear")}
              icon={<X size={18} strokeWidth={1.75} />}
              onClick={() => setSearch("")}
              className="absolute right-0 text-neutral-11"
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={closeSearch}
          className="selis-focus min-h-11 shrink-0 rounded-full px-3 text-md font-medium text-accent-selected"
        >
          {t("library.searchCancel")}
        </button>
      </div>
    </header>
  );
}

function FilterChips({ onTags }: { onTags: () => void }) {
  const { t } = useTranslation();
  const filter = useLibraryView((s) => s.filter);
  const tagId = useLibraryView((s) => s.tagId);
  const setFilter = useLibraryView((s) => s.setFilter);
  const tags = useTags();
  const activeTag = tagId ? tags.data?.find((tag) => tag.id === tagId) : undefined;
  return (
    <div role="group" aria-label={t("library.filters")} className="selis-scroll-x flex gap-2 px-5 pt-2 pb-4" data-testid="filter-chips">
      {CHIPS.map(({ value, key }) => (
        <Chip key={value} pressed={tagId === null && filter === value} onClick={() => setFilter(value)}>
          {t(key)}
        </Chip>
      ))}
      <Chip pressed={tagId !== null} onClick={onTags} aria-haspopup="dialog">
        {activeTag ? activeTag.name : t("library.filterTags")}
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </Chip>
    </div>
  );
}

function ImportFab({ busy, importing, onClick }: { busy: boolean; importing: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid="import-fab"
      className="selis-focus fixed z-10 inline-flex h-14 items-center gap-2 rounded-[18px] bg-accent-9 pr-5 pl-4 text-[15px] font-semibold text-accent-contrast shadow-3 transition-colors duration-150 ease-standard active:bg-accent-10 disabled:opacity-70"
      style={{ right: "calc(var(--safe-right) + 20px)", bottom: "var(--fab-bottom, calc(var(--safe-bottom) + 20px))" }}
    >
      <Plus size={22} strokeWidth={2} aria-hidden="true" />
      {importing ? t("library.importing") : t("library.import")}
    </button>
  );
}

export function LibraryScreen() {
  const { t } = useTranslation();
  const filter = useLibraryView((s) => s.filter);
  const tagId = useLibraryView((s) => s.tagId);
  const search = useLibraryView((s) => s.search);
  const searching = useLibraryView((s) => s.searching);
  const openSearch = useLibraryView((s) => s.openSearch);
  const closeSearch = useLibraryView((s) => s.closeSearch);
  const setFilter = useLibraryView((s) => s.setFilter);
  const setSearch = useLibraryView((s) => s.setSearch);
  const sort = useSettings((s) => s.librarySort);
  const view = useSettings((s) => s.libraryView);
  const tags = useTags();
  const [sheet, setSheet] = useState<"sort" | "tags" | null>(null);
  const importState = useImportState();
  const startImport = useStartImport();

  useOverlay(searching, closeSearch);

  const all = useDocuments(ALL_DOCUMENTS);
  const query = libraryQuery({ filter, tagId, search: searching ? search : "" }, sort);
  const documents = useDocuments(query);

  const busy = isBusy(importState);
  const libraryEmpty = all.data?.length === 0;
  const docs = documents.data ?? [];
  const activeTag = tagId ? tags.data?.find((tag) => tag.id === tagId) : undefined;

  let body;
  if (documents.isPending || all.isPending) {
    body = <DocumentCollectionSkeleton view={view} />;
  } else if (documents.isError) {
    body = (
      <EmptyState
        illustration={<LibraryIllustration />}
        title={t("errors.generic")}
        body={t(errorMessageKey(documents.error))}
        action={
          <Button variant="secondary" onClick={() => void documents.refetch()}>
            {t("errors.retry")}
          </Button>
        }
      />
    );
  } else if (libraryEmpty) {
    body = (
      <EmptyState
        illustration={<LibraryIllustration />}
        title={t("library.emptyTitle")}
        body={t("library.emptyBody")}
        action={
          <Button icon={<FilePlus2 size={20} strokeWidth={1.75} />} onClick={startImport} disabled={busy}>
            {importState.status === "importing" ? t("library.importing") : t("library.import")}
          </Button>
        }
      />
    );
  } else if (docs.length === 0) {
    const trimmed = query.search ?? "";
    const [title, text] =
      trimmed !== ""
        ? [t("library.noResultsTitle"), t("library.noResultsBody", { query: trimmed })]
        : tagId !== null
          ? [t("library.emptyTagTitle", { tag: activeTag?.name ?? "" }), t("library.emptyTagBody")]
          : filter === "favorites"
            ? [t("library.emptyFavoritesTitle"), t("library.emptyFavoritesBody")]
            : [t("library.emptyReceivedTitle"), t("library.emptyReceivedBody")];
    body = (
      <EmptyState
        illustration={<SearchX size={56} strokeWidth={1.25} />}
        title={title}
        body={text}
        action={
          <Button variant="secondary" onClick={() => (trimmed !== "" ? setSearch("") : setFilter("all"))}>
            {trimmed !== "" ? t("library.searchClear") : t("library.showAll")}
          </Button>
        }
      />
    );
  } else {
    body = <DocumentCollection documents={docs} view={view} bottomInset={FAB_CLEARANCE} />;
  }

  return (
    <section className="flex flex-col" data-testid="library-screen">
      {searching ? (
        <SearchField />
      ) : (
        <ScreenHeader
          title={t("library.title")}
          actions={
            libraryEmpty ? null : (
              <>
                <IconButton label={t("library.search")} icon={<Search size={22} strokeWidth={1.75} />} onClick={openSearch} />
                <IconButton
                  label={t("library.sort")}
                  icon={<ArrowDownUp size={22} strokeWidth={1.75} />}
                  onClick={() => setSheet("sort")}
                  aria-haspopup="dialog"
                />
              </>
            )
          }
        />
      )}
      {libraryEmpty ? <div className="h-4" /> : <FilterChips onTags={() => setSheet("tags")} />}
      {body}
      {libraryEmpty || searching ? null : (
        <ImportFab busy={busy} importing={importState.status === "importing"} onClick={startImport} />
      )}
      <SortSheet open={sheet === "sort"} onClose={() => setSheet(null)} />
      <TagsSheet open={sheet === "tags"} onClose={() => setSheet(null)} />
    </section>
  );
}
