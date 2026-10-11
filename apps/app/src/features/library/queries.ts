import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, api, type Document, type ImportOutcome, type LibraryQuery, type Tag } from "../../lib/api";
import { ALL_DOCUMENTS } from "./libraryStore";

/** Every library listing is cached under ["documents", query]. */
export const documentsKey = ["documents"] as const;
export const tagsKey = ["tags"] as const;

export function useDocuments(query: LibraryQuery) {
  return useQuery({
    queryKey: [...documentsKey, query],
    queryFn: () => api.listDocuments(query),
    // Typing in search keeps the previous results on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

export function useTags() {
  return useQuery({ queryKey: tagsKey, queryFn: api.listTags });
}

/** Replaces one document in every cached listing (optimistic UI). */
export function patchCachedDocument(queryClient: QueryClient, doc: Document): void {
  queryClient.setQueriesData<Document[]>({ queryKey: documentsKey }, (old) =>
    old?.map((d) => (d.id === doc.id ? doc : d)),
  );
}

function refreshLibrary(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: documentsKey });
}

/** Optimistic library update after an import, then reconcile with the backend. */
export function addImportedDocument(queryClient: QueryClient, outcome: ImportOutcome): void {
  queryClient.setQueryData<Document[]>([...documentsKey, ALL_DOCUMENTS], (old) => {
    if (!old) return [outcome.document];
    if (old.some((d) => d.id === outcome.document.id)) return old;
    return [outcome.document, ...old];
  });
  refreshLibrary(queryClient);
}

/**
 * Sets the favorite flag: applied at once, rolled back if the backend refuses.
 * Resolves to false on failure (the caller shows the error).
 */
export async function setFavorite(queryClient: QueryClient, doc: Document, favorite: boolean): Promise<boolean> {
  patchCachedDocument(queryClient, { ...doc, favorite });
  try {
    patchCachedDocument(queryClient, await api.setFavorite(doc.id, favorite));
    return true;
  } catch {
    patchCachedDocument(queryClient, doc);
    return false;
  } finally {
    // Filtered views (Favorites) must gain or lose the document.
    refreshLibrary(queryClient);
  }
}

/** Sets a document's title, optimistically. Resolves to false on failure. */
export async function renameDocument(queryClient: QueryClient, doc: Document, title: string): Promise<boolean> {
  patchCachedDocument(queryClient, { ...doc, title });
  try {
    patchCachedDocument(queryClient, await api.renameDocument(doc.id, title));
    return true;
  } catch {
    patchCachedDocument(queryClient, doc);
    return false;
  } finally {
    // Name sort and title search depend on it.
    refreshLibrary(queryClient);
  }
}

/**
 * Deletes a document: it leaves every listing at once and comes back if the
 * backend refuses. "Not found" counts as done (e.g. the reply to a first try
 * was lost and the retry found nothing left). Resolves to false on failure.
 */
export async function deleteDocument(queryClient: QueryClient, doc: Document): Promise<boolean> {
  queryClient.setQueriesData<Document[]>({ queryKey: documentsKey }, (old) => old?.filter((d) => d.id !== doc.id));
  try {
    await api.deleteDocument(doc.id);
    return true;
  } catch (err) {
    return err instanceof ApiError && err.code === "notFound";
  } finally {
    refreshLibrary(queryClient);
    // Tag counts change.
    void queryClient.invalidateQueries({ queryKey: tagsKey });
  }
}

/** Replaces a document's tags, optimistically. */
export async function setDocumentTags(queryClient: QueryClient, doc: Document, tagIds: string[]): Promise<boolean> {
  patchCachedDocument(queryClient, { ...doc, tagIds });
  try {
    patchCachedDocument(queryClient, await api.setDocumentTags(doc.id, tagIds));
    return true;
  } catch {
    patchCachedDocument(queryClient, doc);
    return false;
  } finally {
    refreshLibrary(queryClient);
    void queryClient.invalidateQueries({ queryKey: tagsKey });
  }
}

export async function createTag(queryClient: QueryClient, name: string): Promise<Tag> {
  const tag = await api.createTag(name);
  queryClient.setQueryData<Tag[]>(tagsKey, (old) => (old?.some((t) => t.id === tag.id) ? old : [...(old ?? []), tag]));
  void queryClient.invalidateQueries({ queryKey: tagsKey });
  return tag;
}

export async function renameTag(queryClient: QueryClient, id: string, name: string): Promise<Tag> {
  const tag = await api.renameTag(id, name);
  queryClient.setQueryData<Tag[]>(tagsKey, (old) => old?.map((t) => (t.id === id ? tag : t)));
  void queryClient.invalidateQueries({ queryKey: tagsKey });
  return tag;
}

export async function deleteTag(queryClient: QueryClient, id: string): Promise<void> {
  queryClient.setQueryData<Tag[]>(tagsKey, (old) => old?.filter((t) => t.id !== id));
  try {
    await api.deleteTag(id);
  } finally {
    void queryClient.invalidateQueries({ queryKey: tagsKey });
    refreshLibrary(queryClient);
  }
}
