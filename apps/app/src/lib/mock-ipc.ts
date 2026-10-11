/**
 * In-memory backend for the browser build (`vite --mode mock`): lets Playwright
 * and UI work run without Rust. Mirrors the command contract of the bindings,
 * including the per-request-id result store behind `take_result`, title search
 * folding (`selis_fold`), filters, sorts, tags and thumbnails.
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  CommandError,
  Document,
  DocumentFile,
  ImportOutcome,
  LibraryQuery,
  PendingOpen,
  Settings,
  SettingsPatch,
  StoredResult,
  Tag,
  TakeResult,
} from "./ipc";

const SETTINGS_KEY = "selis.mock.settings";

const DEFAULT_SETTINGS: Settings = { locale: "system", theme: "system", librarySort: "recent", libraryView: "grid" };

const files = new Map<string, File>();
const docs = new Map<string, { doc: Document; url: string }>();
const tags = new Map<string, { id: string; name: string; key: string }>();
const pendingOpens: PendingOpen[] = [];
let nextOpenId = 0;

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
};

function knobs(): MockKnobs {
  return (window as unknown as { __selisTest?: MockKnobs }).__selisTest ?? {};
}

/**
 * Playwright stand-in for an Android "Open with" intent: the file arrives in the
 * pending queue and the app is told it is in front again.
 */
function installTestOpenWith(): void {
  const target = window as unknown as {
    __selisTest?: MockKnobs & { openWith?: (files: Array<{ name: string; bytes: number[] }>) => void };
  };
  target.__selisTest ??= {};
  // One intent: a single "Open with", or several files from one share (SEND_MULTIPLE).
  target.__selisTest.openWith = (files) => {
    for (const { name, bytes } of files) {
      const source = registerMockFile(new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
      nextOpenId += 1;
      pendingOpens.push({ id: `open-${nextOpenId}`, source, name });
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function installMockIpc(): void {
  installTestOpenWith();
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    const id = String(args.id);
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
