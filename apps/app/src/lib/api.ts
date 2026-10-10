/**
 * The UI's only door to the backend: typed commands from the generated
 * `ipc.ts`, with `Result` unwrapped into exceptions for TanStack Query.
 */
import { type CommandError, commands, type ErrorCode } from "./ipc";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(error: CommandError) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
  }
}

async function unwrap<T>(call: Promise<Result<T, CommandError>>): Promise<T> {
  const result = await call;
  if (result.status === "error") throw new ApiError(result.error);
  return result.data;
}

export const api = {
  importDocument: (source: string) => unwrap(commands.importDocument(source)),
  listDocuments: () => unwrap(commands.listDocuments()),
  readDocument: (id: string) => unwrap(commands.readDocument(id)),
  recordDocumentInfo: (id: string, pageCount: number, pdfTitle: string | null) =>
    unwrap(commands.recordDocumentInfo(id, pageCount, pdfTitle)),
  getSettings: () => unwrap(commands.getSettings()),
  updateSettings: (patch: Parameters<typeof commands.updateSettings>[0]) => unwrap(commands.updateSettings(patch)),
  deviceMemory: () => unwrap(commands.deviceMemory()),
  pickPdf: (requestId: number) => unwrap(commands.pickPdf(requestId)),
  takePickResult: (requestId: number) => unwrap(commands.takePickResult(requestId)),
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
      case "invalidArgument":
      case "internal":
        return "errors.generic";
    }
  }
  return "errors.generic";
}

export type { Document, DocumentFile, ImportOutcome, LocalePref, Settings, ThemePref } from "./ipc";
