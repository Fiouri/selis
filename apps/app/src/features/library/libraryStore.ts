/**
 * What the Library screen shows: filter chip, tag, title search. Not persisted
 * (sort and grid/list are settings; see state/settings.ts).
 */
import { create } from "zustand";
import type { LibraryQuery, LibrarySort } from "../../lib/api";

export type ChipFilter = "all" | "favorites" | "received";

type LibraryViewState = {
  filter: ChipFilter;
  /** Set by the "Tags" chip; combines with nothing else. */
  tagId: string | null;
  search: string;
  searching: boolean;
  setFilter: (filter: ChipFilter) => void;
  setTag: (tagId: string | null) => void;
  setSearch: (search: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
};

export const useLibraryView = create<LibraryViewState>()((set) => ({
  filter: "all",
  tagId: null,
  search: "",
  searching: false,
  setFilter: (filter) => set({ filter, tagId: null }),
  setTag: (tagId) => set({ tagId, filter: "all" }),
  setSearch: (search) => set({ search }),
  openSearch: () => set({ searching: true }),
  closeSearch: () => set({ searching: false, search: "" }),
}));

export function libraryQuery(
  state: Pick<LibraryViewState, "filter" | "tagId" | "search">,
  sort: LibrarySort,
): LibraryQuery {
  return { search: state.search.trim(), filter: state.filter, tagId: state.tagId, sort };
}

/** Everything, newest activity first: tells "empty library" apart from "empty filter". */
export const ALL_DOCUMENTS: LibraryQuery = { search: "", filter: "all", tagId: null, sort: "recent" };

/** The Recent tab. */
export const RECENT_DOCUMENTS: LibraryQuery = { search: "", filter: "opened", tagId: null, sort: "lastOpened" };
