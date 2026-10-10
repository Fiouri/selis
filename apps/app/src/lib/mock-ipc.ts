/**
 * In-memory backend for the browser build (`vite --mode mock`): lets Playwright
 * and UI work run without Rust. Mirrors the command contract of the bindings,
 * including the per-request-id result store behind `take_result`.
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  CommandError,
  Document,
  DocumentFile,
  ImportOutcome,
  Settings,
  SettingsPatch,
  StoredResult,
  TakeResult,
} from "./ipc";

const SETTINGS_KEY = "selis.mock.settings";

const files = new Map<string, File>();
const docs = new Map<string, { doc: Document; url: string }>();

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

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { locale: "system", theme: "system", ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Storage unavailable: defaults.
  }
  return { locale: "system", theme: "system" };
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

async function importDocument(source: string): Promise<ImportOutcome> {
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
  const now = Date.now();
  const doc: Document = {
    id: crypto.randomUUID(),
    title: file.name.replace(/\.pdf$/i, ""),
    kind: "imported",
    blake3: hash,
    sizeBytes: bytes.byteLength,
    pageCount: null,
    createdAt: now,
    modifiedAt: now,
    lastOpenedAt: null,
    favorite: false,
  };
  docs.set(doc.id, { doc, url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) });
  return { document: doc, duplicate: false };
}

function sortedDocs(): Document[] {
  return [...docs.values()]
    .map((e) => e.doc)
    .sort((a, b) => {
      if (a.lastOpenedAt !== b.lastOpenedAt) return (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1);
      return b.createdAt - a.createdAt;
    });
}

function readDocument(id: string): DocumentFile {
  const entry = docs.get(id) ?? fail("notFound", id);
  entry.doc = { ...entry.doc, lastOpenedAt: Date.now() };
  return { document: entry.doc, path: entry.url };
}

function recordDocumentInfo(id: string, pageCount: number, pdfTitle: string | null): Document {
  const entry = docs.get(id) ?? fail("notFound", id);
  entry.doc = { ...entry.doc, pageCount, title: entry.doc.title || (pdfTitle ?? "") };
  return entry.doc;
}

function updateSettings(patch: SettingsPatch): Settings {
  const next = { ...loadSettings() };
  if (patch.locale) next.locale = patch.locale;
  if (patch.theme) next.theme = patch.theme;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function installMockIpc(): void {
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "import_document":
        return runOnce(cmd, String(args.requestId), () => importDocument(String(args.source)));
      case "take_result":
        return takeResult(String(args.requestId));
      case "list_documents":
        return sortedDocs();
      case "read_document":
        return readDocument(String(args.id));
      case "record_document_info":
        return recordDocumentInfo(String(args.id), Number(args.pageCount), (args.pdfTitle as string | null) ?? null);
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
