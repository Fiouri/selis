import { type DocHandle, EngineError, type EngineErrorCode } from "@selis/engine";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Document } from "../../lib/api";
import { getEngine } from "../../lib/engine";
import { readDocumentBytes } from "../../lib/files";
import { markStep, markViewerStart } from "../../lib/perf";
import { documentsKey } from "../library/queries";

export type OpenState =
  | { status: "loading" }
  | { status: "ready"; doc: DocHandle; meta: Document }
  | { status: "error"; code: EngineErrorCode | "io" };

/** Loads a library document into the engine; closes it (freeing WASM memory) on unmount. */
export function useOpenDocument(docId: string): OpenState {
  const [state, setState] = useState<OpenState>({ status: "loading" });
  const queryClient = useQueryClient();

  useEffect(() => {
    const lifetime = new AbortController();
    let handle: DocHandle | null = null;
    // Callers key the viewer by document id, so state starts as "loading" for each document.
    markViewerStart();

    void (async () => {
      try {
        const file = await api.readDocument(docId);
        const bytes = await readDocumentBytes(file.path);
        markStep("read");
        const doc = await getEngine().open(bytes);
        markStep(`open pages=${doc.pageCount}`);
        if (lifetime.signal.aborted) {
          void doc.close();
          return;
        }
        handle = doc;
        setState({ status: "ready", doc, meta: file.document });

        const needsInfo = file.document.pageCount !== doc.pageCount || (!file.document.title && doc.title);
        if (needsInfo) {
          await api.recordDocumentInfo(docId, doc.pageCount, doc.title);
        }
        void queryClient.invalidateQueries({ queryKey: documentsKey });
      } catch (err) {
        if (lifetime.signal.aborted) return;
        console.warn("selis: failed to open document", err);
        setState({ status: "error", code: err instanceof EngineError ? err.code : "io" });
      }
    })();

    return () => {
      lifetime.abort();
      if (handle) void handle.close();
    };
  }, [docId, queryClient]);

  return state;
}
