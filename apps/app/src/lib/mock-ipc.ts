/**
 * In-memory backend for the browser build (`vite --mode mock`): lets Playwright
 * and UI work run without Rust. Mirrors the command contract of the bindings,
 * including the per-request-id result store behind `take_result`, title search
 * folding (`selis_fold`), filters, sorts, tags, thumbnails and saving
 * (chunked uploads → working copy → versions).
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { createMockPack, PACK_COMMANDS } from "./mock-pack";
import { createMockPhotos, PHOTO_COMMANDS } from "./mock-photos";
import { createMockTools, TOOL_COMMANDS } from "./mock-tools";
import { createMockTransfer, TRANSFER_COMMANDS } from "./mock-transfer";
import type {
  CommandError,
  DeleteReport,
  Document,
  DocumentFile,
  ImportOutcome,
  LibraryQuery,
  PendingOpen,
  SavedVersion,
  Settings,
  Signature,
  SignatureKind,
  SettingsPatch,
  StoredResult,
  Tag,
  TakeResult,
  VersionLabel,
  WorkingCopy,
} from "./ipc";

const SETTINGS_KEY = "selis.mock.settings";

const DEFAULT_SETTINGS: Settings = {
  locale: "en",
  theme: "system",
  librarySort: "recent",
  libraryView: "grid",
  nightMode: false,
  localOnly: false,
  relayUrl: null,
  versionsPerDocument: 10,
  historyLimitMb: 200,
  appLock: false,
  scanAuto: true,
};

const files = new Map<string, File>();
const docs = new Map<string, { doc: Document; url: string }>();
const tags = new Map<string, { id: string; name: string; key: string }>();
const pendingOpens: PendingOpen[] = [];
let nextOpenId = 0;
/** Uploads in progress: chunks in order. */
const uploads = new Map<string, Uint8Array[]>();
const workingCopies = new Map<string, { copy: WorkingCopy; bytes: Uint8Array }>();
/** Saved versions per document (v1 = the import), labels in order. */
const versions = new Map<string, VersionLabel[]>();
const versionNotes = new Map<string, (string | null)[]>();
/** Versions removed by "Delete earlier versions", per document. */
const dropped = new Map<string, number>();
const versionCount = (id: string) => (versions.get(id) ?? []).length + 1 - (dropped.get(id) ?? 0);
const signatures = new Map<string, Signature>();

/** Registers a picked browser File and returns a source token for import. */
export function registerMockFile(file: File): string {
  const token = `mock-file:${crypto.randomUUID()}`;
  files.set(token, file);
  return token;
}

function fail(code: CommandError["code"], message: string): never {
  const error: CommandError = { code, message };
  // Tauri rejects command errors with the serialized value (not an Error); mirror that.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}

/** Same as Rust's `selis_core::fold`: lowercase, no diacritics, ς → σ, single spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .trim()
    .replace(/\s+/g, " ");
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Storage unavailable: defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

async function hashHex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type MockKnobs = {
  /** Simulate a slow import (e.g. a stuck SAF descriptor). */
  importDelayMs?: number;
  /** Commands whose reply is dropped (the Android lost-reply bug); Rust still finishes. */
  dropReplies?: string[];
  /** Commands that fail with an I/O error (e.g. a save interrupted by the app dying). */
  failCommands?: string[];
};

function knobs(): MockKnobs {
  return (window as unknown as { __selisTest?: MockKnobs }).__selisTest ?? {};
}

type MockInspect = {
  /** Ids of the documents in the library, newest first. */
  ids: () => string[];
  /** Number of versions of a document (1 after import). */
  versions: (id: string) => number;
  versionLabels: (id: string) => VersionLabel[];
  /** The note of each saved version (null: none). */
  versionNotes: (id: string) => (string | null)[];
  hasWorkingCopy: (id: string) => boolean;
  /** Current bytes of a document, as latin1 text (PDF structure checks). */
  documentText: (id: string) => Promise<string>;
  /** Current bytes of a document, exact (for reading it with another PDF reader). */
  documentBytes: (id: string) => Promise<number[]>;
};

/**
 * Playwright stand-in for an Android "Open with" intent: the file arrives in the
 * pending queue and the app is told it is in front again.
 */
function installTestOpenWith(): void {
  const target = window as unknown as {
    __selisTest?: MockKnobs & { openWith?: (files: Array<{ name: string; bytes: number[] }>) => void; inspect?: MockInspect };
  };
  target.__selisTest ??= {};
  target.__selisTest.inspect = {
    ids: () => listDocuments({ search: "", filter: "all", tagId: null, sort: "recent" }).map((d) => d.id),
    versions: (id) => versionCount(id),
    versionLabels: (id) => [...(versions.get(id) ?? [])],
    versionNotes: (id) => [...(versionNotes.get(id) ?? [])],
    hasWorkingCopy: (id) => workingCopies.has(id),
    documentText: async (id) => {
      const response = await fetch(entryOf(id).url);
      return new TextDecoder("latin1").decode(await response.arrayBuffer());
    },
    documentBytes: async (id) => {
      const response = await fetch(entryOf(id).url);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    },
  };
  // One intent: a single "Open with", or several files from one share (SEND_MULTIPLE).
  target.__selisTest.openWith = (files) => {
    for (const { name, bytes } of files) {
      const source = registerMockFile(new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
      nextOpenId += 1;
      pendingOpens.push({ id: `open-${nextOpenId}`, source, name, pack: name.endsWith(".selispack") });
    }
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

/** Like Rust's `RequestResults`: run once per request id, keep the result. */
const requests = new Map<string, { promise: Promise<unknown>; result: StoredResult | null }>();

function runOnce<T>(command: string, requestId: string, work: () => Promise<T>): Promise<T> {
  let entry = requests.get(requestId);
  if (!entry) {
    const promise = work();
    const created = { promise: promise as Promise<unknown>, result: null as StoredResult | null };
    void (async () => {
      try {
        created.result = { status: "ok", data: await promise };
      } catch (error) {
        created.result = { status: "error", error: error as CommandError };
      }
    })();
    requests.set(requestId, created);
    entry = created;
  }
  const reply = entry.promise as Promise<T>;
  if (knobs().dropReplies?.includes(command)) {
    console.info(`[mock-ipc] dropping the reply of ${command}`);
    return new Promise<T>(() => undefined);
  }
  return reply;
}

function takeResult(requestId: string): TakeResult {
  const entry = requests.get(requestId);
  if (!entry) return { status: "unknown" };
  return entry.result ? { status: "done", result: entry.result } : { status: "pending" };
}

function titleFrom(name: string): string {
  return name.trim().replace(/\.pdf$/i, "").trim();
}

async function importDocument(source: string, name: string | null): Promise<ImportOutcome> {
  const delay = knobs().importDelayMs ?? 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const file = files.get(source) ?? fail("io", "unknown mock source");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) fail("emptyFile", "empty");
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
  if (!head.includes("%PDF-")) fail("notPdf", "not a pdf");
  const hash = await hashHex(bytes);
  for (const entry of docs.values()) {
    if (entry.doc.blake3 === hash) return { document: entry.doc, duplicate: true };
  }
  // Keeps creation order strict even within one millisecond (sorting relies on it).
  const now = Math.max(Date.now(), ...[...docs.values()].map((e) => e.doc.createdAt + 1));
  const doc: Document = {
    id: crypto.randomUUID(),
    title: titleFrom(name ?? file.name),
    kind: "imported",
    blake3: hash,
    sizeBytes: bytes.byteLength,
    pageCount: null,
    createdAt: now,
    modifiedAt: now,
    lastOpenedAt: null,
    favorite: false,
    received: false,
    tagIds: [],
    thumbnailPath: null,
    lastPage: null,
  };
  docs.set(doc.id, { doc, url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) });
  return { document: doc, duplicate: false };
}

function compare(sort: LibraryQuery["sort"] = "recent"): (a: Document, b: Document) => number {
  const created = (a: Document, b: Document) => b.createdAt - a.createdAt;
  switch (sort) {
    case "name":
      return (a, b) => {
        if ((a.title === "") !== (b.title === "")) return a.title === "" ? 1 : -1;
        const fa = fold(a.title);
        const fb = fold(b.title);
        return fa < fb ? -1 : fa > fb ? 1 : created(a, b);
      };
    case "size":
      return (a, b) => b.sizeBytes - a.sizeBytes || created(a, b);
    case "lastOpened":
      return (a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1) || created(a, b);
    case "recent":
      return (a, b) =>
        Math.max(b.lastOpenedAt ?? 0, b.createdAt) - Math.max(a.lastOpenedAt ?? 0, a.createdAt) || created(a, b);
  }
}

function listDocuments(query: LibraryQuery): Document[] {
  const search = fold(query.search ?? "");
  return [...docs.values()]
    .map((e) => e.doc)
    .filter((d) => search === "" || fold(d.title).includes(search))
    .filter((d) => {
      const filter = query.filter ?? "all";
      if (filter === "favorites") return d.favorite;
      if (filter === "received") return d.received;
      if (filter === "opened") return d.lastOpenedAt !== null;
      return true;
    })
    .filter((d) => !query.tagId || d.tagIds.includes(query.tagId))
    .sort(compare(query.sort));
}

function entryOf(id: string): { doc: Document; url: string } {
  return docs.get(id) ?? fail("notFound", id);
}

function update(id: string, patch: Partial<Document>): Document {
  const entry = entryOf(id);
  entry.doc = { ...entry.doc, ...patch };
  return entry.doc;
}

function readDocument(id: string, stamp: boolean): DocumentFile {
  const entry = entryOf(id);
  if (stamp) entry.doc = { ...entry.doc, lastOpenedAt: Date.now() };
  return { document: entry.doc, path: entry.url };
}

function recordDocumentInfo(id: string, pageCount: number, pdfTitle: string | null): Document {
  const doc = entryOf(id).doc;
  return update(id, { pageCount, title: doc.title || (pdfTitle ?? "") });
}

function saveThumbnail(id: string, image: number[]): Document {
  entryOf(id);
  const bytes = new Uint8Array(image);
  const riff = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF";
  const type = riff ? "image/webp" : bytes[0] === 0xff ? "image/jpeg" : "image/png";
  return update(id, { thumbnailPath: URL.createObjectURL(new Blob([bytes], { type })) });
}

function renameDocument(id: string, title: string): Document {
  // Same as Rust's `sanitize_title`: no control characters, trimmed, at most 512 chars.
  const clean = Array.from(title.replace(/\p{Cc}/gu, "")).slice(0, 512).join("").trim();
  return update(id, { title: clean });
}

function uploadChunk(uploadId: string, offset: number, data: string): number {
  const chunks = uploads.get(uploadId) ?? [];
  uploads.set(uploadId, chunks);
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  if (offset + bytes.length <= length) return length;
  if (offset !== length) fail("conflict", "upload chunk out of order");
  chunks.push(bytes);
  return length + bytes.length;
}

function commitWorkingCopy(uploadId: string, documentId: string, baseBlake3: string, sizeBytes: number): WorkingCopy {
  const doc = entryOf(documentId).doc;
  if (doc.blake3 !== baseBlake3) fail("conflict", "document changed since the edit started");
  const chunks = uploads.get(uploadId);
  if (!chunks) {
    const existing = workingCopies.get(documentId);
    if (existing?.copy.sizeBytes === sizeBytes) return existing.copy;
    return fail("notFound", uploadId);
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  if (bytes.length !== sizeBytes) fail("conflict", "upload is incomplete");
  if (!new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-")) fail("notPdf", "not a pdf");
  uploads.delete(uploadId);
  const copy: WorkingCopy = { documentId, baseBlake3, sizeBytes, savedAt: Date.now() };
  workingCopies.set(documentId, { copy, bytes });
  return copy;
}

async function saveVersion(documentId: string, label: VersionLabel, note: string | null): Promise<SavedVersion> {
  const working = workingCopies.get(documentId) ?? fail("notFound", `working copy of ${documentId}`);
  const entry = entryOf(documentId);
  if (entry.doc.blake3 !== working.copy.baseBlake3) fail("conflict", "document changed since the edit started");
  workingCopies.delete(documentId);
  const hash = await hashHex(working.bytes.slice().buffer);
  const list = versions.get(documentId) ?? [];
  versions.set(documentId, list);
  if (hash === entry.doc.blake3) return { document: entry.doc, seq: list.length + 1, created: false };
  list.push(label);
  const notes = versionNotes.get(documentId) ?? [];
  notes.push(note);
  versionNotes.set(documentId, notes);
  entry.url = URL.createObjectURL(new Blob([working.bytes.slice()], { type: "application/pdf" }));
  const document = update(documentId, { blake3: hash, sizeBytes: working.bytes.length, modifiedAt: Date.now() });
  return { document, seq: list.length + 1, created: true };
}

/** New library document from an upload (pages extracted in the UI). */
async function importUpload(uploadId: string, title: string): Promise<ImportOutcome> {
  const chunks = uploads.get(uploadId) ?? fail("notFound", uploadId);
  uploads.delete(uploadId);
  const file = new File(chunks.map((c) => c.slice()), `${title}.pdf`, { type: "application/pdf" });
  return importDocument(registerMockFile(file), `${title}.pdf`);
}

/** The browser build "stages" a picked file by handing out a blob URL to it. */
async function stagePdf(source: string): Promise<string> {
  const file = files.get(source) ?? fail("io", "unknown mock source");
  const head = new TextDecoder("latin1").decode((await file.arrayBuffer()).slice(0, 1024));
  if (!head.includes("%PDF-")) fail("notPdf", "not a pdf");
  return URL.createObjectURL(file);
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function saveSignature(id: string, kind: SignatureKind, png: string): Signature {
  const existing = signatures.get(id);
  if (existing) return existing;
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const size = pngSize(bytes) ?? fail("invalidArgument", "signature image must be a PNG");
  const signature: Signature = {
    id,
    kind,
    path: URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
    width: size.width,
    height: size.height,
    createdAt: Date.now(),
  };
  signatures.set(id, signature);
  return signature;
}

/** Keeps only the current version (the original import included in what goes). */
function deleteEarlierVersions(id: string): number {
  entryOf(id);
  const removed = versionCount(id) - 1;
  dropped.set(id, (dropped.get(id) ?? 0) + removed);
  return removed;
}

function deleteDocument(id: string): DeleteReport {
  const entry = entryOf(id);
  docs.delete(id);
  workingCopies.delete(id);
  versions.delete(id);
  versionNotes.delete(id);
  dropped.delete(id);
  if (entry.doc.thumbnailPath?.startsWith("blob:")) URL.revokeObjectURL(entry.doc.thumbnailPath);
  return { removedFiles: entry.doc.kind === "imported" ? 1 + (entry.doc.thumbnailPath ? 1 : 0) : 0 };
}

function listTags(): Tag[] {
  return [...tags.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((t) => ({
      id: t.id,
      name: t.name,
      documentCount: [...docs.values()].filter((e) => e.doc.tagIds.includes(t.id)).length,
    }));
}

function tagById(id: string): Tag {
  return listTags().find((t) => t.id === id) ?? fail("notFound", id);
}

function cleanTagName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 48);
  return clean || fail("invalidArgument", "tag name is empty");
}

function createTag(name: string): Tag {
  const clean = cleanTagName(name);
  const key = fold(clean);
  const existing = [...tags.values()].find((t) => t.key === key);
  if (existing) return tagById(existing.id);
  const id = crypto.randomUUID();
  tags.set(id, { id, name: clean, key });
  return tagById(id);
}

function renameTag(id: string, name: string): Tag {
  const tag = tags.get(id) ?? fail("notFound", id);
  const clean = cleanTagName(name);
  const key = fold(clean);
  if ([...tags.values()].some((t) => t.key === key && t.id !== id)) fail("conflict", "tag exists");
  tags.set(id, { ...tag, name: clean, key });
  return tagById(id);
}

function deleteTag(id: string): null {
  tags.delete(id);
  for (const entry of docs.values()) {
    if (entry.doc.tagIds.includes(id)) entry.doc = { ...entry.doc, tagIds: entry.doc.tagIds.filter((t) => t !== id) };
  }
  return null;
}

function setDocumentTags(documentId: string, tagIds: string[]): Document {
  entryOf(documentId);
  for (const id of tagIds) if (!tags.has(id)) fail("notFound", id);
  return update(documentId, { tagIds: [...new Set(tagIds)].sort() });
}

function updateSettings(patch: SettingsPatch): Settings {
  const next = { ...loadSettings() };
  if (patch.locale) next.locale = patch.locale;
  if (patch.theme) next.theme = patch.theme;
  if (patch.librarySort) next.librarySort = patch.librarySort;
  if (patch.libraryView) next.libraryView = patch.libraryView;
  if (patch.nightMode !== null) next.nightMode = patch.nightMode;
  if (patch.localOnly !== null) next.localOnly = patch.localOnly;
  if (patch.relayUrl !== null) {
    const url = patch.relayUrl.trim();
    if (url && !/^https:\/\/[^/\s]+/.test(url)) fail("invalidArgument", "relayUrl must be an https:// URL");
    next.relayUrl = url ? new URL(url).toString() : null;
  }
  if (patch.appLock !== null) next.appLock = patch.appLock;
  if (patch.scanAuto !== null) next.scanAuto = patch.scanAuto;
  if (patch.versionsPerDocument !== null) next.versionsPerDocument = patch.versionsPerDocument;
  if (patch.historyLimitMb !== null) next.historyLimitMb = patch.historyLimitMb;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function installMockIpc(): void {
  installTestOpenWith();
  const transfer = createMockTransfer({
    fail,
    runOnce,
    documentSizes: (ids) => ids.map((docId) => entryOf(docId).doc.sizeBytes),
    importBytes: (name, bytes) =>
      importDocument(registerMockFile(new File([new Uint8Array(bytes)], name, { type: "application/pdf" })), name),
    localOnly: () => loadSettings().localOnly,
    allDocumentIds: () => listDocuments({ search: "", filter: "all", tagId: null, sort: "recent" }).map((d) => d.id),
    summary: () => {
      const all = listDocuments({ search: "", filter: "all", tagId: null, sort: "recent" });
      return {
        documents: all.length,
        versions: all.reduce((n, d) => n + Math.max(0, versionCount(d.id) - 1), 0),
        tags: tags.size,
        signatures: signatures.size,
        bytes: all.reduce((n, d) => n + d.sizeBytes, 0),
      };
    },
  });
  (window as unknown as { __selisTest: Record<string, unknown> }).__selisTest.transfer = transfer.hooks;
  const pack = createMockPack({
    fail,
    runOnce,
    register: registerMockFile,
    file: (token) => files.get(token),
    documentBytes: async (docId) => new Uint8Array(await (await fetch(entryOf(docId).url)).arrayBuffer()),
    allDocumentIds: () => listDocuments({ search: "", filter: "all", tagId: null, sort: "recent" }).map((d) => d.id),
    title: (docId) => entryOf(docId).doc.title,
    importBytes: (name, bytes) =>
      importDocument(registerMockFile(new File([new Uint8Array(bytes)], name, { type: "application/pdf" })), name),
  });
  (window as unknown as { __selisTest: Record<string, unknown> }).__selisTest.pack = pack.hooks;
  const tools = createMockTools({
    fail,
    runOnce,
    documentBytes: async (docId) => new Uint8Array(await (await fetch(entryOf(docId).url)).arrayBuffer()),
    saveSameBytes: (docId) => {
      const list = versions.get(docId) ?? [];
      versions.set(docId, list);
      list.push("manual");
      return update(docId, { modifiedAt: Date.now(), thumbnailPath: null });
    },
  });
  (window as unknown as { __selisTest: Record<string, unknown> }).__selisTest.tools = tools.hooks;
  const photos = createMockPhotos({
    fail,
    runOnce,
    file: (token) => files.get(token),
    register: registerMockFile,
    takeUpload: (uploadId) => {
      const chunks = uploads.get(uploadId) ?? fail("notFound", uploadId);
      uploads.delete(uploadId);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  });
  (window as unknown as { __selisTest: Record<string, unknown> }).__selisTest.photos = photos.hooks;
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    const id = String(args.id);
    if (knobs().failCommands?.includes(cmd)) fail("io", `${cmd} failed (test knob)`);
    if (TRANSFER_COMMANDS.has(cmd)) return transfer.handle(cmd, args);
    if (PACK_COMMANDS.has(cmd)) return pack.handle(cmd, args);
    if (TOOL_COMMANDS.has(cmd)) return tools.handle(cmd, args);
    if (PHOTO_COMMANDS.has(cmd)) return photos.handle(cmd, args);
    switch (cmd) {
      case "import_document":
        return runOnce(cmd, String(args.requestId), () =>
          importDocument(String(args.source), (args.name as string | null | undefined) ?? null),
        );
      case "take_result":
        return takeResult(String(args.requestId));
      case "list_documents":
        return listDocuments(args.query as LibraryQuery);
      case "read_document":
        return readDocument(id, true);
      case "document_file":
        return readDocument(id, false);
      case "record_document_info":
        return recordDocumentInfo(id, Number(args.pageCount), (args.pdfTitle as string | null) ?? null);
      case "set_last_page": {
        const doc = entryOf(id).doc;
        const page = Number(args.page);
        return update(id, { lastPage: doc.pageCount === null ? page : Math.min(page, doc.pageCount - 1) });
      }
      case "rename_document":
        return renameDocument(id, String(args.title));
      case "delete_document":
        return deleteDocument(id);
      case "delete_earlier_versions":
        return deleteEarlierVersions(id);
      case "set_favorite":
        return update(id, { favorite: Boolean(args.favorite) });
      case "save_thumbnail":
        return saveThumbnail(id, args.image as number[]);
      case "list_tags":
        return listTags();
      case "create_tag":
        return createTag(String(args.name));
      case "rename_tag":
        return renameTag(id, String(args.name));
      case "delete_tag":
        return deleteTag(id);
      case "set_document_tags":
        return setDocumentTags(String(args.documentId), args.tagIds as string[]);
      case "share_document":
        return fail("unsupported", "no native share sheet in the browser");
      case "scan_haptic":
        return null;
      case "open_app_settings":
        return fail("unsupported", "no app settings in the browser");
      case "pending_opens":
        return [...pendingOpens];
      case "dismiss_open": {
        const index = pendingOpens.findIndex((p) => p.id === id);
        if (index >= 0) pendingOpens.splice(index, 1);
        return null;
      }
      case "get_settings":
        return loadSettings();
      case "update_settings":
        return updateSettings(args.patch as SettingsPatch);
      case "upload_chunk":
        return uploadChunk(String(args.uploadId), Number(args.offset), String(args.data));
      case "abort_upload":
        uploads.delete(String(args.uploadId));
        return null;
      case "commit_working_copy":
        return commitWorkingCopy(
          String(args.uploadId),
          String(args.documentId),
          String(args.baseBlake3),
          Number(args.sizeBytes),
        );
      case "working_copy":
        return workingCopies.get(String(args.documentId))?.copy ?? null;
      case "discard_working_copy":
        workingCopies.delete(String(args.documentId));
        return null;
      case "save_version":
        return runOnce(cmd, String(args.requestId), () =>
          saveVersion(String(args.documentId), args.label as VersionLabel, typeof args.note === "string" ? args.note : null),
        );
      case "import_upload":
        return runOnce(cmd, String(args.requestId), () => importUpload(String(args.uploadId), String(args.title)));
      case "stage_pdf":
        return runOnce(cmd, String(args.requestId), () => stagePdf(String(args.source)));
      case "unstage":
        if (String(args.path).startsWith("blob:")) URL.revokeObjectURL(String(args.path));
        return null;
      case "list_signatures":
        return [...signatures.values()].sort((a, b) => b.createdAt - a.createdAt);
      case "save_signature":
        return saveSignature(id, args.kind as SignatureKind, String(args.png));
      case "delete_signature":
        signatures.delete(id);
        return null;
      case "device_memory": {
        // navigator.deviceMemory is Chromium-only and capped at 8 (GiB).
        const gib = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
        return { totalBytes: gib * 1024 ** 3, source: "sysinfo" };
      }
      default:
        return fail("invalidArgument", `unknown command ${cmd}`);
    }
  });
}
