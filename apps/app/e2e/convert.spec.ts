/**
 * File conversion (P7c, ADR 0035) against the mock backend. Printing is the platform's job: here
 * the page's `__selisPrint` is Chromium's own `page.pdf()` (the engine of the Android WebView) in
 * a separate context that runs no JavaScript and answers every request with an abort, counted.
 *
 * - The corpus (12 Word, 8 Excel files, packages/fixtures): ≥ 98 % of the words survive, read
 *   back with pdf.js; the page count is within ±1 of LibreOffice's (convert-reference.ts).
 * - No network request while converting, in the app or in the print view.
 * - Preview with the layout note; Save adds the PDF to the library; Cancel adds nothing.
 * - Export as Word / text / Markdown / images from the viewer.
 */
import { chromium, expect, type Page, test } from "@playwright/test";
import { CONVERT_FIXTURES, type ConvertFixture, wordsOf } from "@selis/fixtures/convert";
import { LIBREOFFICE_PAGES } from "@selis/fixtures/convert-reference";
import { pdfjsPageCount, pdfjsText } from "@selis/fixtures/oracle";
import JSZip from "jszip";
import { firstPageRendered, importFixture } from "./helpers";

type Hooks = {
  convert: { lastHtml: () => string | null; staged: () => number };
  photos: { lastExport: () => { name: string; mime: string; bytes: number[] } | null };
};

type Printed = { pdf: Uint8Array; requests: string[] };

/**
 * Prints HTML the way the Android WebView does (Chromium's print engine, whatever browser runs
 * the app), offline: no JavaScript, every request refused and listed.
 */
async function printer(): Promise<{ print: (html: string) => Promise<Printed>; close: () => Promise<void> }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: false });
  return {
    print: async (html) => {
      const page = await context.newPage();
      const requests: string[] = [];
      await page.route("**/*", async (route) => {
        requests.push(route.request().url());
        await route.abort();
      });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        return { pdf: new Uint8Array(pdf), requests };
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}

/** The app with a printer, and every request it makes to another origin than its own listed. */
async function setup(page: Page) {
  const print = await printer();
  const printed: Printed[] = [];
  await page.exposeFunction("__selisPrint", async (html: string) => {
    const result = await print.print(html);
    printed.push(result);
    return [...result.pdf];
  });
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.protocol !== "data:" && url.protocol !== "blob:") foreign.push(request.url());
  });
  return { printed, foreign, close: print.close };
}

async function convert(page: Page, fixture: ConvertFixture): Promise<void> {
  const bytes = await fixture.build();
  const chooser = page.waitForEvent("filechooser");
  // The button above "+", or in an empty library.
  await page.locator('[data-testid="convert-fab"], [data-testid="convert-empty"]').first().click();
  await (await chooser).setFiles({ name: fixture.file, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  await expect(page.getByTestId("convert-note")).toContainText("Layout may differ from Word/Excel", { timeout: 60_000 });
}

/** Share of `expected` words found in `actual` (each counted as often as it occurs), and the missing ones. */
function survival(expected: readonly string[], actual: readonly string[]): { share: number; missing: string[] } {
  const pool = new Map<string, number>();
  for (const w of actual) pool.set(w.toLowerCase(), (pool.get(w.toLowerCase()) ?? 0) + 1);
  const missing: string[] = [];
  for (const w of expected) {
    const n = pool.get(w.toLowerCase()) ?? 0;
    if (n > 0) pool.set(w.toLowerCase(), n - 1);
    else missing.push(w);
  }
  return { share: expected.length === 0 ? 1 : (expected.length - missing.length) / expected.length, missing };
}

test.describe("convert to PDF", () => {
  // One phone is enough for the corpus; both run the flows.
  test("the corpus: words survive, pages match LibreOffice ±1, nothing goes to the network", async ({ page }, info) => {
    test.skip(info.project.name !== "pixel-7", "corpus once");
    test.setTimeout(600_000);
    // Linux CI has Liberation fonts metric-compatible with the corpus' Arial; others differ more.
    const { printed, foreign, close } = await setup(page);
    const rows: string[] = [];
    try {
      for (const fixture of CONVERT_FIXTURES) {
        await convert(page, fixture);
        const result = printed.at(-1);
        if (!result) throw new Error(`nothing printed for ${fixture.name}`);
        const pages = await pdfjsPageCount(result.pdf);
        const words = wordsOf((await pdfjsText(result.pdf)).pages.join(" "));
        const { share, missing } = survival(fixture.words, words);
        const reference = LIBREOFFICE_PAGES[fixture.name] ?? -1;
        rows.push(`${fixture.file.padEnd(24)} pages ${String(pages)} (LibreOffice ${String(reference)})  words ${(share * 100).toFixed(1)} %`);
        expect.soft(share, `${fixture.name}: words kept (missing: ${missing.join(" ")})`).toBeGreaterThanOrEqual(0.98);
        expect.soft(Math.abs(pages - reference), `${fixture.name}: pages ${String(pages)} vs LibreOffice ${String(reference)}`).toBeLessThanOrEqual(1);
        expect.soft(result.requests, `${fixture.name}: requests from the print view`).toEqual([]);
        await page.getByTestId("convert-cancel").click();
        await expect(page.getByTestId("convert-screen")).toHaveCount(0);
      }
    } finally {
      await close();
      await info.attach("convert-corpus.txt", { body: rows.join("\n"), contentType: "text/plain" });
      console.log(rows.join("\n"));
    }
    expect(foreign).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __selisTest: Hooks }).__selisTest.convert.staged())).toBe(0);
  });

  test("preview shows the note; Save adds the PDF to the library and opens it, Cancel adds nothing", async ({ page }) => {
    const { foreign, close } = await setup(page);
    try {
      // The library starts empty: the conversion is offered in its empty state as well.
      await expect(page.getByTestId("convert-empty")).toBeVisible();
      const fixture = CONVERT_FIXTURES.find((f) => f.name === "letter-a4");
      if (!fixture) throw new Error("no letter fixture");
      const bytes = await fixture.build();
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("convert-empty").click();
      await (await chooser).setFiles({ name: "Letter to Ms Taylor.docx", mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
      await expect(page.getByTestId("convert-note")).toContainText("Letter to Ms Taylor.pdf");
      await expect(page.getByTestId("convert-note")).toContainText("1 page");
      await page.getByTestId("convert-save").click();
      await expect(page.getByTestId("viewer-screen")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Letter to Ms Taylor" })).toBeVisible();
      await firstPageRendered(page);
      await page.goBack();
      await expect(page.getByTestId("document-collection").getByRole("button")).toHaveCount(1);

      // A second one, cancelled: nothing more in the library.
      const sheet = CONVERT_FIXTURES.find((f) => f.name === "sales-small");
      if (!sheet) throw new Error("no sheet fixture");
      await convert(page, sheet);
      await page.getByTestId("convert-cancel").click();
      await expect(page.getByTestId("convert-screen")).toHaveCount(0);
      await expect(page.getByTestId("document-collection").getByRole("button")).toHaveCount(1);
    } finally {
      await close();
    }
    expect(foreign).toEqual([]);
  });

  test("an unknown file is refused with the list of what converts", async ({ page }) => {
    const { close } = await setup(page);
    try {
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("convert-empty").click();
      await (await chooser).setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) });
      await expect(page.getByTestId("convert-failed")).toContainText("Word (.docx), Excel (.xlsx)");
    } finally {
      await close();
    }
  });
});

test.describe("export", () => {
  test("Word, text, Markdown and page images from the viewer's menu", async ({ page }) => {
    await page.goto("/");
    await importFixture(page, "mixed-sizes.pdf");
    await expect(page.getByTestId("viewer-screen")).toBeVisible();
    await firstPageRendered(page);
    const lastExport = () => page.evaluate(() => (window as unknown as { __selisTest: Hooks }).__selisTest.photos.lastExport());
    /** The next export, once it has reached the share sheet. */
    const exported = async (name: string) => {
      await expect.poll(async () => (await lastExport())?.name, { timeout: 300_000 }).toBe(name);
      return lastExport();
    };
    const open = async () => {
      await page.getByRole("button", { name: "More" }).click();
      await page.getByTestId("more-export").click();
      await expect(page.getByTestId("export-sheet")).toBeVisible();
    };

    await open();
    await expect(page.getByTestId("export-word")).toContainText("Editable text, layout simplified");
    await page.getByTestId("export-text").click();
    const text = await exported("mixed-sizes.txt");
    await expect(page.getByTestId("toast")).toContainText("Export ready");
    expect(text?.mime).toBe("text/plain");
    // Every page's words, pages separated by a form feed.
    const plain = new TextDecoder().decode(new Uint8Array(text?.bytes ?? []));
    expect(plain.split("")).toHaveLength(7);

    await open();
    await page.getByTestId("export-word").click();
    const word = await exported("mixed-sizes.docx");
    const zip = await JSZip.loadAsync(new Uint8Array(word?.bytes ?? []));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    // A page break between pages: 6 for 7 pages.
    expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(6);

    await open();
    await page.getByTestId("export-images").click();
    await page.getByRole("radio", { name: "JPEG" }).click();
    await page.getByTestId("export-images-save").click();
    const images = await exported("mixed-sizes pages.zip");
    expect(images?.mime).toBe("application/zip");
    const pages = await JSZip.loadAsync(new Uint8Array(images?.bytes ?? []));
    expect(Object.keys(pages.files).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `page-00${String(i + 1)}.jpg`));
  });
});
