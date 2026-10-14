/**
 * OCR (P4d) in the real bundle under the app's CSP, with the mock backend: tesseract.js in its
 * worker with the bundled core and models, the PDFium engine writing the invisible text layer.
 * A scanned page becomes searchable; the new version's text is read back with pdf.js; cancel
 * keeps the finished pages and Resume goes on.
 */
import { expect, type Page, test } from "@playwright/test";
import { scannedWords } from "@selis/fixtures";
import { pdfjsText } from "@selis/fixtures/oracle";
import { firstPageRendered, importFixture, presetSettings } from "./helpers";

type Hooks = { inspect: { ids: () => string[]; documentBytes: (id: string) => Promise<number[]> } };

async function newestDocumentBytes(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const t = (window as unknown as { __selisTest: Hooks }).__selisTest;
    return t.inspect.documentBytes(t.inspect.ids()[0] ?? "");
  });
  return new Uint8Array(bytes);
}

async function openOcr(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("more-tools").click();
  await page.getByTestId("tool-ocr").click();
  await expect(page.getByTestId("ocr-sheet")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("a scanned document becomes searchable and is saved as a new version", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto("/");
  await importFixture(page, "scanned-english.pdf", "Scan.pdf");
  await firstPageRendered(page);
  // No text yet: the search finds nothing.
  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("passport");
  await expect(page.getByTestId("search-status")).toHaveText("None");
  await page.getByRole("button", { name: "Close search" }).click();

  await openOcr(page);
  await expect(page.getByTestId("ocr-languages-ell+eng")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("ocr-languages-eng").click();
  await page.getByTestId("ocr-start").click();
  await expect(page.getByTestId("ocr-card")).toBeVisible();
  await expect(page.getByTestId("ocr-label")).toHaveText(/Reading page [12] of 2…/, { timeout: 60_000 });
  await expect(page.getByText("Text is now searchable — saved as a new version.")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId("ocr-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("passport");
  await expect(page.getByTestId("search-status")).toHaveText("1 / 1");

  const pdf = await newestDocumentBytes(page);
  const text = await pdfjsText(pdf);
  const found = new Set(text.pages.join(" ").split(/\s+/));
  const expected = [...scannedWords("english", 0), ...scannedWords("english", 1)].map((w) => w.replace(/[.,:]$/, ""));
  const hits = expected.filter((w) => found.has(w) || found.has(`${w}.`) || found.has(`${w},`) || found.has(`${w}:`)).length;
  expect(hits / expected.length).toBeGreaterThanOrEqual(0.9);
  // Nothing was fetched from a CDN, nothing broke the CSP.
  expect(errors.filter((e) => /Content Security Policy|cdn\.|Failed to fetch/i.test(e))).toEqual([]);
});

test("cancel keeps the pages read so far; resume reads the rest", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await importFixture(page, "scanned-greek.pdf", "Σάρωση.pdf");
  await firstPageRendered(page);
  await openOcr(page);
  await page.getByTestId("ocr-start").click();
  await expect(page.getByTestId("ocr-label")).toHaveText("Reading page 2 of 2…", { timeout: 120_000 });
  await page.getByTestId("ocr-cancel").click();
  await expect(page.getByTestId("ocr-label")).toHaveText("Stopped at page 2 of 2");
  await expect(page.getByTestId("ocr-card")).toHaveAttribute("data-step", "stopped");
  await page.getByTestId("ocr-resume").click();
  await expect(page.getByText("Text is now searchable — saved as a new version.")).toBeVisible({ timeout: 150_000 });
  // Greek with accents is found by the viewer's search.
  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("Ευρωπαϊκή");
  await expect(page.getByTestId("search-status")).toHaveText("1 / 1");
});
