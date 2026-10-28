/**
 * File conversion (P7c, ADR 0035) in the mock backend. Printing HTML to PDF is the platform's
 * job, so the browser build asks `window.__selisPrint(html)` (Playwright exposes it and prints
 * with Chromium's `page.pdf()`, the engine of the Android WebView); without it the command
 * reports `unsupported`, like desktop. Tests use `window.__selisTest.convert`:
 *
 * - `lastHtml()`: the last HTML sent to the printer (or null);
 * - `staged()`: how many converted PDFs are waiting for Save / Cancel.
 */
import type { CommandError, ImportOutcome, PickOutcome } from "./ipc";

type Deps = {
  fail: (code: CommandError["code"], message: string) => never;
  runOnce: <T>(command: string, requestId: string, work: () => Promise<T>) => Promise<T>;
  file: (token: string) => File | undefined;
  register: (file: File) => string;
  takeUpload: (uploadId: string) => Uint8Array;
  importDocument: (source: string, name: string) => Promise<ImportOutcome>;
};

type Printer = (html: string, widthPt: number, heightPt: number) => Promise<number[]>;

export const CONVERT_COMMANDS = new Set(["convert_available", "pick_document", "stage_source", "convert_html_to_pdf", "import_staged"]);

export function createMockConvert(deps: Deps) {
  let lastHtml: string | null = null;
  let nextPick: string | null = null;
  const staged = new Set<string>();

  const printer = () => (window as unknown as { __selisPrint?: Printer }).__selisPrint;

  const hooks = {
    lastHtml: () => lastHtml,
    staged: () => staged.size,
    /** The next "Convert to PDF" pick (`{ name, bytes }`), instead of the file input. */
    pickNext: (file: { name: string; bytes: number[] } | null) => {
      nextPick = file ? deps.register(new File([new Uint8Array(file.bytes)], file.name)) : null;
    },
  };

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "convert_available":
        return Boolean(printer());
      case "pick_document":
        return deps.runOnce(cmd, String(args.requestId), () => {
          const pick: PickOutcome = nextPick ? { status: "picked", source: nextPick } : { status: "cancelled" };
          nextPick = null;
          return Promise.resolve(pick);
        });
      case "stage_source":
        return deps.runOnce(cmd, String(args.requestId), () => {
          const file = deps.file(String(args.source)) ?? deps.fail("io", "unknown mock source");
          if (file.size === 0) deps.fail("emptyFile", "empty file");
          // The browser build "stages" by handing out a blob URL (as stage_pdf does).
          return Promise.resolve(URL.createObjectURL(file));
        });
      case "convert_html_to_pdf":
        return deps.runOnce(cmd, String(args.requestId), async () => {
          const html = new TextDecoder().decode(deps.takeUpload(String(args.uploadId)));
          lastHtml = html;
          const print = printer() ?? deps.fail("unsupported", "no print engine in this browser build");
          const bytes = new Uint8Array(await print(html, Number(args.widthPt), Number(args.heightPt)));
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          staged.add(url);
          return url;
        });
      case "import_staged":
        return deps.runOnce(cmd, String(args.requestId), async () => {
          const path = String(args.path);
          if (!staged.has(path)) deps.fail("invalidArgument", "not a staged file");
          const blob = await (await fetch(path)).blob();
          staged.delete(path);
          URL.revokeObjectURL(path);
          const title = String(args.title);
          return deps.importDocument(deps.register(new File([blob], `${title}.pdf`, { type: "application/pdf" })), `${title}.pdf`);
        });
      default:
        return deps.fail("invalidArgument", `unknown command ${cmd}`);
    }
  };

  /** `unstage` of a converted PDF (Cancel): forget it. */
  const unstage = (path: string) => staged.delete(path);

  return { handle, hooks, unstage };
}
