import { type DocHandle, EngineError, type EngineErrorCode } from "@selis/engine";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Document, type SavedVersion } from "../../lib/api";
import { getEngine, warmUpEngine } from "../../lib/engine";
import { readDocumentBytes } from "../../lib/files";
import { markStep, markViewerStart } from "../../lib/perf";
import { EditSession } from "../annotate/session";
import { documentsKey, patchCachedDocument } from "../library/queries";
import { refreshThumbnail, thumbnailFromOpenDocument } from "../library/thumbnails";

export type RecoveryChoice = "restore" | "discard";

export type OpenState =
  | { status: "loading" }
  /** A working copy from a session that never became a version (crash, kill). */
  | { status: "recovery"; choose: (choice: RecoveryChoice) => void }
  /** The document needs its password (asked again after a wrong one). */
  | { status: "locked"; wrong: boolean; unlock: (password: string) => void }
  | {
      status: "ready";
      doc: DocHandle;
      meta: Document;
      /** Library copy (sharing). */
      path: string;
      session: EditSession;
      /** The document was opened from recovered edits. */
      recovered: boolean;
      /** Opened with a password: editing is off, no thumbnail is made (P4a). */
      locked: boolean;
    }
  | { status: "error"; code: EngineErrorCode | "io" };

/**
 * Asks about unsaved edits left by an earlier session. Restore turns them into
 * a version (the document then opens with them); discard throws them away.
 * Returns whether edits were restored.
 */
async function recoverWorkingCopy(
  docId: string,
  ask: () => Promise<RecoveryChoice>,
): Promise<boolean> {
  const copy = await api.workingCopy(docId);
  if (!copy) return false;
  const current = (await api.documentFile(docId)).document;
  if (copy.baseBlake3 !== current.blake3) {
    // Edits of a version that is no longer current cannot be applied: drop them.
    await api.discardWorkingCopy(docId);
    return false;
  }
  if ((await ask()) === "discard") {
    await api.discardWorkingCopy(docId);
    return false;
  }
  await api.saveVersion(docId, "auto");
  return true;
}

/**
 * Loads a library document into the engine with its edit session. On unmount
 * the session's edits become a version first, then the document is closed
 * (freeing WASM memory). A new `reloadKey` opens the document again (a tool
 * saved a new version). A password-protected document waits in "locked" for
 * its password, which lives only in this effect.
 */
export function useOpenDocument(docId: string, reloadKey = 0): OpenState {
  const [state, setState] = useState<OpenState>({ status: "loading" });
  const queryClient = useQueryClient();

  useEffect(() => {
    const lifetime = new AbortController();
    // A function, not the property: the flag changes across the awaits below.
    const aborted = () => lifetime.signal.aborted;
    let handle: DocHandle | null = null;
    let session: EditSession | null = null;
    // Callers key the viewer by document id, so state starts as "loading" for each document.
    markViewerStart();
    warmUpEngine(); // WASM compile overlaps the IPC call and the file read below

    void (async () => {
      try {
        const recovered = await recoverWorkingCopy(
          docId,
          () =>
            new Promise<RecoveryChoice>((resolve) => {
              if (aborted()) return;
              setState({
                status: "recovery",
                choose: (choice) => {
                  setState({ status: "loading" });
                  resolve(choice);
                },
              });
            }),
        ).catch((err: unknown) => {
          // Recovery is best effort: never block opening the current version.
          console.warn("selis: working copy check failed", err);
          return false;
        });
        if (aborted()) return;
        const file = await api.readDocument(docId);
        let password: string | undefined;
        let doc: DocHandle;
        for (;;) {
          // Read for every attempt: the engine takes the buffer.
          const bytes = await readDocumentBytes(file.path);
          markStep("read");
          try {
            doc = await getEngine().open(bytes, password === undefined ? {} : { password });
            break;
          } catch (err) {
            if (!(err instanceof EngineError && err.code === "password") || aborted()) throw err;
            const wrong = password !== undefined;
            password = await new Promise<string>((resolve) => {
              setState({
                status: "locked",
                wrong,
                unlock: (value) => {
                  setState({ status: "loading" });
                  resolve(value);
                },
              });
            });
            if (aborted()) return;
          }
        }
        const locked = password !== undefined;
        password = undefined;
        markStep(`open pages=${doc.pageCount}`);
        if (aborted()) {
          void doc.close();
          return;
        }
        handle = doc;
        const onVersion = (saved: SavedVersion) => {
          patchCachedDocument(queryClient, saved.document);
          void queryClient.invalidateQueries({ queryKey: documentsKey });
          refreshThumbnail(queryClient, docId, doc);
        };
        session = new EditSession(doc, docId, file.document.blake3, undefined, onVersion);
        setState({ status: "ready", doc, meta: file.document, path: file.path, session, recovered, locked });
        // Queued behind the visible pages in the worker, so it never delays them. A protected
        // document gets none: its first page would sit unencrypted in the thumbnail cache.
        if (!locked) {
          if (recovered) refreshThumbnail(queryClient, docId, doc);
          else thumbnailFromOpenDocument(queryClient, file.document, doc);
        }

        const needsInfo = file.document.pageCount !== doc.pageCount || (!file.document.title && doc.title);
        if (needsInfo) {
          await api.recordDocumentInfo(docId, doc.pageCount, doc.title);
        }
        void queryClient.invalidateQueries({ queryKey: documentsKey });
      } catch (err) {
        if (aborted()) return;
        console.warn("selis: failed to open document", err);
        setState({ status: "error", code: err instanceof EngineError ? err.code : "io" });
      }
    })();

    return () => {
      lifetime.abort();
      const closing = handle;
      const editing = session;
      if (!closing) return;
      // Edits become a version before the document leaves the engine. If that
      // fails, the autosaved working copy is recovered on the next open.
      void (async () => {
        try {
          await editing?.commit();
        } catch (err) {
          console.warn("selis: saving on close failed; the working copy stays for recovery", err);
        } finally {
          editing?.dispose();
          await closing.close();
        }
      })();
    };
  }, [docId, queryClient, reloadKey]);

  return state;
}
