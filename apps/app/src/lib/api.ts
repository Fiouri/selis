/**
 * The UI's only door to the backend: typed commands from the generated
 * bindings (`lib/ipc`), sent through the reliability layer (timeouts, lost-reply
 * recovery; docs/adr/0005-ipc-reliability.md), with `Result` unwrapped into
 * exceptions for TanStack Query.
 */
import {
  type CallResult,
  type CommandError,
  commands,
  type ErrorCode,
  type LibraryQuery,
  type LongCallOptions,
  reliableIpc,
  type ShortCallOptions,
} from "./ipc";

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(error: CommandError) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
  }
}

async function unwrap<T>(call: Promise<CallResult<T>>): Promise<T> {
  const result = await call;
  if (result.status === "error") throw new ApiError(result.error);
  return result.data;
}

/** Short read-only (or idempotent) commands: a lost reply is simply asked for again. */
const READ: ShortCallOptions = { timeoutMs: 10_000, retry: true };
/** Short writes: time out, never repeat automatically. */
const WRITE: ShortCallOptions = { timeoutMs: 10_000, retry: false };
/** Rust cancels an import after 30 s; check for a lost reply well before that. */
const IMPORT: LongCallOptions = { checkAfterMs: 5_000, pollMs: 2_000 };
/** The picker may stay open for minutes: check only once the app is back in front. */
const PICK: LongCallOptions = { checkAfterMs: null, pollMs: 2_000 };

const ipc = reliableIpc;

export const api = {
  /** `name`: the sender's file name ("Open with" / share), used as the title. */
  importDocument: (source: string, name: string | null = null) =>
    unwrap(ipc().long("import_document", (requestId) => commands.importDocument(requestId, source, name), IMPORT)),
  pickPdf: () => unwrap(ipc().long("pick_pdf", (requestId) => commands.pickPdf(requestId), PICK)),
  listDocuments: (query: LibraryQuery) =>
    unwrap(ipc().short("list_documents", () => commands.listDocuments(query), READ)),
  // Sets (never toggles) the flag, so a retry is harmless.
  setFavorite: (id: string, favorite: boolean) =>
    unwrap(ipc().short("set_favorite", () => commands.setFavorite(id, favorite), READ)),
  // Sets the position (never increments): safe to repeat.
  setLastPage: (id: string, page: number) =>
    unwrap(ipc().short("set_last_page", () => commands.setLastPage(id, page), READ)),
  documentFile: (id: string) => unwrap(ipc().short("document_file", () => commands.documentFile(id), READ)),
  // Idempotent per document (same bytes, same file).
  saveThumbnail: (id: string, image: Uint8Array) =>
    unwrap(ipc().short("save_thumbnail", () => commands.saveThumbnail(id, Array.from(image)), READ)),
  listTags: () => unwrap(ipc().short("list_tags", () => commands.listTags(), READ)),
  // Returns the existing tag for the same name: safe to repeat.
  createTag: (name: string) => unwrap(ipc().short("create_tag", () => commands.createTag(name), READ)),
  renameTag: (id: string, name: string) => unwrap(ipc().short("rename_tag", () => commands.renameTag(id, name), WRITE)),
  deleteTag: (id: string) => unwrap(ipc().short("delete_tag", () => commands.deleteTag(id), READ)),
  // Replaces the whole set: safe to repeat.
  setDocumentTags: (documentId: string, tagIds: string[]) =>
    unwrap(ipc().short("set_document_tags", () => commands.setDocumentTags(documentId, tagIds), READ)),
  // Opens a share sheet: never repeated automatically (it would open twice).
  shareDocument: (id: string) => unwrap(ipc().short("share_document", () => commands.shareDocument(id), WRITE)),
  pendingOpens: () => unwrap(ipc().short("pending_opens", () => commands.pendingOpens(), READ)),
  dismissOpen: (id: string) => unwrap(ipc().short("dismiss_open", () => commands.dismissOpen(id), READ)),
  // Also stamps "last opened", which is safe to repeat.
  readDocument: (id: string) => unwrap(ipc().short("read_document", () => commands.readDocument(id), READ)),
  recordDocumentInfo: (id: string, pageCount: number, pdfTitle: string | null) =>
    unwrap(
      ipc().short("record_document_info", () => commands.recordDocumentInfo(id, pageCount, pdfTitle), WRITE),
    ),
  getSettings: () => unwrap(ipc().short("get_settings", () => commands.getSettings(), READ)),
  updateSettings: (patch: Parameters<typeof commands.updateSettings>[0]) =>
    unwrap(ipc().short("update_settings", () => commands.updateSettings(patch), WRITE)),
  deviceMemory: () => unwrap(ipc().short("device_memory", () => commands.deviceMemory(), READ)),
};

/** i18n key for a user-facing error message. */
export function errorMessageKey(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "notPdf":
        return "errors.notPdf";
      case "emptyFile":
        return "errors.emptyFile";
      case "io":
        return "errors.io";
      case "notFound":
        return "errors.notFound";
      case "timeout":
        return "errors.importTimeout";
      case "conflict":
        return "errors.conflict";
      case "unsupported":
        return "errors.unsupported";
      case "invalidArgument":
      case "internal":
        return "errors.generic";
    }
  }
  return "errors.generic";
}

export { IpcTimeoutError, LostResponseError } from "./ipc";
export type {
  Document,
  DocumentFile,
  ImportOutcome,
  LibraryFilter,
  LibraryQuery,
  LibrarySort,
  LibraryView,
  LocalePref,
  PendingOpen,
  Settings,
  Tag,
  ThemePref,
} from "./ipc";
