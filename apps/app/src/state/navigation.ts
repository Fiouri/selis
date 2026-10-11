/**
 * In-app navigation backed by the History API.
 *
 * Android's back gesture calls WebView.goBack() while the page has history
 * (see MainActivity.kt / WryActivity), so every in-app step that "back" should
 * undo is a history entry:
 *   Library (root, depth 0) → other tab (depth 1) → viewer (depth +1).
 * Back from the root lets Android finish the activity.
 *
 * Overlays (bottom sheets, search) are history entries too (`useOverlay`), so
 * back closes them before it navigates.
 *
 * Android asks `window.__selisBack()` first (MainActivity.kt): it goes back in
 * the app and returns true, or returns false at the root so the system leaves the
 * app. (Relying on WebView history alone fails: Chromium skips entries pushed
 * without a user gesture, e.g. a viewer opened by "Open with".)
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";

export const TABS = ["library", "recent", "transfer", "settings"] as const;
export type Tab = (typeof TABS)[number];

export type Route = { readonly tab: Tab; readonly docId: string | null };

type HistoryEntry = { selis: 1; route: Route; depth: number; overlay?: string };

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

type Overlay = { token: string; depth: number; onPopped: () => void };

/** Open overlays, innermost last. */
const overlays: Overlay[] = [];
/** A just-released overlay entry, reused if another overlay opens right away (React StrictMode). */
let releasing: { token: string; timer: number } | null = null;
let overlaySeq = 0;

function pushOverlay(onPopped: () => void): string {
  const { route, depth } = useNavigation.getState();
  overlaySeq += 1;
  const token = `overlay-${overlaySeq}`;
  const reuse = releasing !== null && isEntry(history.state) && history.state.overlay === releasing.token;
  if (releasing) window.clearTimeout(releasing.timer);
  releasing = null;
  const entry: HistoryEntry = { selis: 1, route, depth: reuse ? depth : depth + 1, overlay: token };
  if (reuse) history.replaceState(entry, "");
  else history.pushState(entry, "");
  overlays.push({ token, depth: entry.depth, onPopped });
  useNavigation.setState({ depth: entry.depth });
  return token;
}

function releaseOverlay(token: string): void {
  const index = overlays.findIndex((o) => o.token === token);
  if (index < 0) return; // already closed by back
  overlays.splice(index, 1);
  if (!isEntry(history.state) || history.state.overlay !== token) return; // something was pushed on top
  // Drop our entry, unless another overlay opens in the same tick and takes it over.
  if (releasing) window.clearTimeout(releasing.timer);
  releasing = {
    token,
    timer: window.setTimeout(() => {
      releasing = null;
      history.back();
    }, 0),
  };
}

/**
 * While `open`, the overlay owns a history entry: system back calls `onClose`.
 * Closing it from the UI (or unmounting) removes the entry again.
 */
export function useOverlay(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const token = pushOverlay(() => onCloseRef.current());
    return () => releaseOverlay(token);
  }, [open]);
}

/** System back inside the app; false at the root (nothing to go back to). */
export function handleSystemBack(): boolean {
  const { route, depth } = useNavigation.getState();
  if (depth === 0 && route.docId === null) return false;
  useNavigation.getState().back();
  return true;
}

/** Seeds the root history entry and follows popstate. Call once at startup. */
export function installHistorySync(): () => void {
  (window as unknown as { __selisBack?: () => boolean }).__selisBack = handleSystemBack;
  const { route, depth } = useNavigation.getState();
  if (isEntry(history.state) && history.state.overlay === undefined) {
    useNavigation.setState({ route: history.state.route, depth: history.state.depth });
  } else if (isEntry(history.state)) {
    // Reloaded on an overlay entry: its owner is gone.
    useNavigation.setState({ route: history.state.route, depth: history.state.depth });
    history.back();
  } else {
    history.replaceState({ selis: 1, route, depth } satisfies HistoryEntry, "");
  }
  const onPop = (event: PopStateEvent) => {
    const state: unknown = event.state;
    const nextDepth = isEntry(state) ? state.depth : 0;
    // Overlays above the entry we landed on were closed by back.
    for (let i = overlays.length - 1; i >= 0; i--) {
      const overlay = overlays[i];
      if (overlay && overlay.depth > nextDepth) {
        overlays.splice(i, 1);
        overlay.onPopped();
      }
    }
    if (isEntry(state)) {
      useNavigation.setState({ route: state.route, depth: state.depth });
      // An overlay entry whose owner already closed (e.g. its screen unmounted): skip it.
      const owner = state.overlay;
      if (owner !== undefined && releasing?.token !== owner && !overlays.some((o) => o.token === owner)) {
        history.back();
      }
    } else {
      useNavigation.setState({ route: ROOT, depth: 0 });
    }
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
