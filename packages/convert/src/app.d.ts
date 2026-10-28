/**
 * What the app imports (`@selis/convert/app`, ADR 0035): the same module as `index.ts` at run
 * time, typed here without the docx writer's typings, which pull Node's globals (through JSZip)
 * into the app's browser type check. `app-check.ts` keeps this in step with `index.ts`.
 */
import type { PageSetup } from "./html";
import type { SourceKind } from "./kind";
import type { PageContent, StructuredPage } from "./structure";

export type { PageContent, PageSetup, SourceKind, StructuredPage };
export type PrintableHtml = { readonly html: string; readonly page: PageSetup };
export type PlacedImage = { readonly type: "png" | "jpg"; readonly data: Uint8Array };

export declare function detectKind(name: string, mime: string | null, bytes: Uint8Array): SourceKind | null;
export declare function sniffKind(bytes: Uint8Array): Promise<SourceKind | null>;
export declare function toPrintableHtml(kind: SourceKind, bytes: Uint8Array, title: string): Promise<PrintableHtml>;
export declare function structureDocument(pages: readonly PageContent[]): StructuredPage[];
export declare function toDocx(pages: readonly StructuredPage[], images: ReadonlyMap<string, PlacedImage>, title: string): Promise<Uint8Array>;
export declare function toPlainText(pages: readonly StructuredPage[]): string;
export declare function toMarkdown(pages: readonly StructuredPage[]): string;
export declare function zipFiles(files: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>): Promise<Uint8Array>;
export declare function pageFileName(index: number, count: number, extension: "png" | "jpg"): string;
