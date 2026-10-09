/**
 * In-app navigation backed by the History API.
 *
 * Android's back gesture calls WebView.goBack() while the page has history
 * (see MainActivity.kt / WryActivity), so every in-app step that "back" should
 * undo is a history entry:
 *   Library (root, depth 0) → other tab (depth 1) → viewer (depth +1).
 * Back from the root lets Android finish the activity.
 */
import { create } from "zustand";

export const TABS = ["library", "recent", "transfer", "settings"] as const;
export type Tab = (typeof TABS)[number];

export type Route = { readonly tab: Tab; readonly docId: string | null };

type HistoryEntry = { selis: 1; route: Route; depth: number };

type NavigationState = {
  route: Route;
  depth: number;
  selectTab: (tab: Tab) => void;
  openDocument: (docId: string) => void;
  /** Same as the system back gesture. */
  back: () => void;
};

const ROOT: Route = { tab: "library", docId: null };

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const route = v.route as Record<string, unknown> | null | undefined;
  return (
    v.selis === 1 &&
    typeof v.depth === "number" &&
    typeof route === "object" &&
    route !== null &&
    (TABS as readonly unknown[]).includes(route.tab) &&
    (route.docId === null || typeof route.docId === "string")
  );
}

export const useNavigation = create<NavigationState>()((set, get) => {
  const push = (route: Route, depth: number) => {
    history.pushState({ selis: 1, route, depth } satisfies HistoryEntry, "");
    set({ route, depth });
  };
  const replace = (route: Route, depth: number) => {
    history.replaceState({ selis: 1, route, depth } satisfies HistoryEntry, "");
    set({ route, depth });
  };

  return {
    route: ROOT,
    depth: 0,
    selectTab: (tab) => {
      const { route, depth } = get();
      if (route.docId === null && route.tab === tab) return;
      const atTabRoot = route.docId === null;
      if (tab === "library" && atTabRoot && depth === 1) {
        // The entry below is the Library root: go back to it instead of stacking.
        history.back();
        return;
      }
      const next: Route = { tab, docId: null };
      if (atTabRoot && route.tab === "library") push(next, depth + 1);
      else replace(next, depth);
    },
    openDocument: (docId) => {
      const { route, depth } = get();
      if (route.docId === docId) return;
      push({ tab: route.tab, docId }, depth + 1);
    },
    back: () => {
      const { route, depth } = get();
      if (depth > 0) history.back();
      else if (route.docId !== null) replace({ tab: route.tab, docId: null }, 0);
    },
  };
});

/** Seeds the root history entry and follows popstate. Call once at startup. */
export function installHistorySync(): () => void {
  const { route, depth } = useNavigation.getState();
  if (isEntry(history.state)) {
    useNavigation.setState({ route: history.state.route, depth: history.state.depth });
  } else {
    history.replaceState({ selis: 1, route, depth } satisfies HistoryEntry, "");
  }
  const onPop = (event: PopStateEvent) => {
    if (isEntry(event.state)) useNavigation.setState({ route: event.state.route, depth: event.state.depth });
    else useNavigation.setState({ route: ROOT, depth: 0 });
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
