import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Document, type ImportOutcome } from "../../lib/api";
import { pickPdf } from "../../lib/files";

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

/** Pick → import. Resolves to null when the user cancels the picker. */
export function useImportDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ImportOutcome | null> => {
      const source = await pickPdf();
      if (!source) return null;
      return api.importDocument(source);
    },
    onSuccess: (outcome) => {
      if (!outcome) return;
      // Optimistic list update, then reconcile with the backend.
      queryClient.setQueryData<Document[]>(documentsKey, (old) => {
        if (!old) return [outcome.document];
        if (old.some((d) => d.id === outcome.document.id)) return old;
        return [outcome.document, ...old];
      });
      void queryClient.invalidateQueries({ queryKey: documentsKey });
    },
  });
}
