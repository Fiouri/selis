import type { Annotation, DocHandle } from "@selis/engine";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** Annotations of one page, re-read after every change to the page (`enabled` = load at all). */
export function usePageAnnotations(doc: DocHandle, index: number, enabled: boolean): readonly Annotation[] {
  const revision = useSyncExternalStore(
    useCallback((notify: () => void) => doc.onPageChange((page) => page === index && notify()), [doc, index]),
    () => doc.pageRevision(index),
  );
  const [items, setItems] = useState<readonly Annotation[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const request = { live: true };
    void (async () => {
      try {
        const list = await doc.annotations(index);
        if (request.live) setItems(list);
      } catch {
        // The page is gone (document closed); nothing to show.
      }
    })();
    return () => {
      request.live = false;
    };
  }, [doc, index, enabled, revision]);
  return items;
}
