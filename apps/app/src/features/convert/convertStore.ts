/**
 * "Convert to PDF" (P7c, ADR 0035): a Word, Excel, CSV, text, Markdown or HTML file
 * becomes print HTML in the app (lazy chunk `@selis/convert`), the platform prints it to
 * a PDF without a dialog (Rust → ConvertPlugin), the PDF is previewed, and only "Save"
 * makes it a library document. The source file is only read.
 */
import type { DocHandle } from "@selis/engine";
import { create } from "zustand";
import { ApiError, api, type Document } from "../../lib/api";
import { getEngine } from "../../lib/engine";
import { readDocumentBytes } from "../../lib/files";
import { upload } from "../../lib/save";

/** One-line outcomes (i18n keys under `convert.`). */
export type ConvertProblem = "unsupportedFile" | "unsupported" | "damaged" | "tooLarge" | "failed";

export type ConvertView =
  | { step: "idle" }
  | { step: "converting"; name: string }
  | { step: "preview"; name: string; title: string; path: string; doc: DocHandle }
  | { step: "saving"; name: string; title: string; path: string; doc: DocHandle }
  | { step: "failed"; name: string; problem: ConvertProblem };

type ConvertState = {
  view: ConvertView;
  /** Converts the document at `source` (a picked or shared file) and shows the preview. */
  start: (source: string, name: string, mime?: string | null) => Promise<void>;
  /** Imports the previewed PDF; resolves to the new document (null if nothing was saved). */
  save: () => Promise<Document | null>;
  close: () => void;
};

const PT_PER_MM = 72 / 25.4;
const PT_PER_IN = 72;

/** A CSS length (`210mm`, `8.5in`, `612pt`, `2.54cm`, `816px`) in points. */
export function cssLengthToPoints(length: string): number {
  const m = length.trim().match(/^(\d+(?:\.\d+)?)(mm|cm|in|pt|px)$/);
  if (!m) return Number.NaN;
  const value = Number(m[1]);
  switch (m[2]) {
    case "mm":
      return value * PT_PER_MM;
    case "cm":
      return value * 10 * PT_PER_MM;
    case "in":
      return value * PT_PER_IN;
    case "px":
      return value * 0.75;
    default:
      return value;
  }
}

/** The title of the converted document: the source name without its extension. */
export function convertedTitle(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
  return base === "" ? "Converted document" : base;
}

function problemOf(err: unknown): ConvertProblem {
  if (err instanceof ApiError) {
    if (err.code === "unsupported") return "unsupported";
    if (err.code === "invalidArgument" && /too large/.test(err.message)) return "tooLarge";
    if (err.code === "emptyFile" || err.code === "notPdf") return "damaged";
  }
  if (err instanceof Error && /damaged|not an Excel|invalid XML|end of data|zip/i.test(err.message)) return "damaged";
  return "failed";
}

let generation = 0;

async function release(view: ConvertView): Promise<void> {
  if (view.step === "preview" || view.step === "saving") {
    await view.doc.close().catch(() => undefined);
    await api.unstage(view.path).catch(() => undefined);
  }
}

export const useConvert = create<ConvertState>()((set, get) => ({
  view: { step: "idle" },

  start: async (source, name, mime = null) => {
    const run = ++generation;
    await release(get().view);
    set({ view: { step: "converting", name } });
    const current = () => run === generation;
    let staged: string | null = null;
    let pdf: string | null = null;
    try {
      staged = await api.stageSource(source);
      const bytes = new Uint8Array(await readDocumentBytes(staged));
      void api.unstage(staged).catch(() => undefined);
      staged = null;
      // The converters load only now: they are not part of the startup bundle.
      const { detectKind, sniffKind, toPrintableHtml } = await import("@selis/convert/app");
      const kind = detectKind(name, mime, bytes) ?? (/\.[a-z0-9]{1,8}$/i.test(name) ? null : await sniffKind(bytes));
      if (!kind) {
        if (current()) set({ view: { step: "failed", name, problem: "unsupportedFile" } });
        return;
      }
      const title = convertedTitle(name);
      const { html, page } = await toPrintableHtml(kind, bytes, title);
      const uploadId = await upload(new TextEncoder().encode(html).buffer);
      pdf = await api.convertHtmlToPdf(uploadId, cssLengthToPoints(page.width), cssLengthToPoints(page.height));
      const doc = await getEngine().open(await readDocumentBytes(pdf));
      if (!current()) {
        await doc.close();
        await api.unstage(pdf).catch(() => undefined);
        return;
      }
      set({ view: { step: "preview", name, title, path: pdf, doc } });
    } catch (err) {
      console.warn("selis: conversion failed", err);
      if (staged) void api.unstage(staged).catch(() => undefined);
      if (pdf) void api.unstage(pdf).catch(() => undefined);
      if (current()) set({ view: { step: "failed", name, problem: problemOf(err) } });
    }
  },

  save: async () => {
    const view = get().view;
    if (view.step !== "preview") return null;
    set({ view: { ...view, step: "saving" } });
    try {
      const outcome = await api.importStaged(view.path, view.title);
      await view.doc.close().catch(() => undefined);
      set({ view: { step: "idle" } });
      return outcome.document;
    } catch (err) {
      console.warn("selis: saving the conversion failed", err);
      set({ view: { ...view, step: "preview" } });
      throw err;
    }
  },

  close: () => {
    generation++;
    const view = get().view;
    if (view.step === "saving") return;
    set({ view: { step: "idle" } });
    void release(view);
  },
}));
