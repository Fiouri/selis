import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api, type Document, type ImportOutcome } from "../../lib/api";

export const documentsKey = ["documents"] as const;

export function useDocuments() {
  return useQuery({ queryKey: documentsKey, queryFn: api.listDocuments });
}

/** Opened documents, most recent first. */
export function selectRecent(docs: readonly Document[]): Document[] {
  return docs
    .filter((d) => d.lastOpenedAt !== null)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
}

/** Optimistic library update after an import, then reconcile with the backend. */
export function addImportedDocument(queryClient: QueryClient, outcome: ImportOutcome): void {
  queryClient.setQueryData<Document[]>(documentsKey, (old) => {
    if (!old) return [outcome.document];
    if (old.some((d) => d.id === outcome.document.id)) return old;
    return [outcome.document, ...old];
  });
  void queryClient.invalidateQueries({ queryKey: documentsKey });
}
