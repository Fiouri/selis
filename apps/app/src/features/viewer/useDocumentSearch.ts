import { type DocHandle, EngineError, type PageRect } from "@selis/engine";
import { useEffect, useMemo, useState } from "react";
import type { PageHighlights } from "./PdfViewer";

/** Typing pauses this long before a search starts (a 1000-page search is not free). */
const DEBOUNCE_MS = 250;

export type SearchMatch = { readonly page: number; readonly rects: readonly PageRect[] };

export type SearchState = {
  readonly matches: readonly SearchMatch[];
  /** False while pages are still being searched. */
  readonly done: boolean;
  readonly active: number;
};

type Stored = SearchState & { readonly query: string };

const IDLE: Stored = { query: "", matches: [], done: true, active: 0 };

/** Groups matches by page for the viewer, marking the active one. */
export function highlightsByPage(matches: readonly SearchMatch[], active: number): Map<number, PageHighlights> {
  const out = new Map<number, { rects: PageRect[]; active: PageRect[] }>();
  matches.forEach((m, i) => {
    let entry = out.get(m.page);
    if (!entry) {
      entry = { rects: [], active: [] };
      out.set(m.page, entry);
    }
    (i === active ? entry.active : entry.rects).push(...m.rects);
  });
  return out;
}

/**
 * Full-text search in the open document. Results stream in page by page;
 * a new query cancels the previous search in the worker.
 */
export function useDocumentSearch(doc: DocHandle | null, query: string) {
  const [stored, setState] = useState<Stored>(IDLE);
  const trimmed = query.trim();
  // Results belong to the query they were found for; anything else is "not searched yet".
  const state: SearchState =
    stored.query === trimmed ? stored : { matches: [], done: trimmed === "", active: 0 };

  useEffect(() => {
    if (!doc || trimmed === "") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ query: trimmed, matches: [], done: false, active: 0 });
      const found: SearchMatch[] = [];
      void (async () => {
        try {
          await doc.search(trimmed, {
            signal: controller.signal,
            onHits: (page, hits) => {
              for (const hit of hits) found.push({ page, rects: hit.rects });
              setState((s) => ({ ...s, matches: [...found] }));
            },
          });
          if (!controller.signal.aborted) setState((s) => ({ ...s, done: true }));
        } catch (err) {
          if (err instanceof EngineError && err.code === "cancelled") return;
          console.warn("selis: search failed", err);
          setState((s) => ({ ...s, done: true }));
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [doc, trimmed]);

  const highlights = useMemo(() => highlightsByPage(state.matches, state.active), [state.matches, state.active]);

  const step = (delta: number) =>
    setState((s) =>
      s.query !== trimmed || s.matches.length === 0
        ? s
        : { ...s, active: (s.active + delta + s.matches.length) % s.matches.length },
    );

  return {
    matches: state.matches,
    done: state.done,
    active: state.active,
    current: state.matches[state.active] ?? null,
    highlights,
    next: () => step(1),
    previous: () => step(-1),
  };
}
