/**
 * Pages (P2c) against the mock backend with the real PDFium worker: select,
 * rotate, duplicate, delete (confirm), reorder by long-press drag, undo / redo,
 * add a blank page and a PDF with a form, extract and split into new library
 * documents. Closing makes a version that still has its form.
 */
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { fixturePath } from "@selis/fixtures";
import { firstPageRendered, importFixture, SCREENSHOTS } from "./helpers";

type Inspect = { ids: () => string[]; versions: (id: string) => number; documentText: (id: string) => Promise<string> };
type TestWindow = { __selisTest: { inspect: Inspect } };

async function thumbsLoaded(page: Page, count: number): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId("pages-grid")
        .locator("img")
        .evaluateAll((imgs: HTMLImageElement[]) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length),
    )
    .toBeGreaterThanOrEqual(count);
}

/** Thumbnail image size ("w×h"), to tell portrait from landscape after a rotation. */
async function thumbShape(page: Page, n: number): Promise<"portrait" | "landscape"> {
  const img = page.getByTestId(`page-thumb-${n}`).locator("img");
  await expect(img).toHaveCount(1);
  return img.evaluate((i: HTMLImageElement) => (i.naturalWidth > i.naturalHeight ? "landscape" : "portrait"));
}

test("pages: select, rotate, duplicate, delete, reorder, undo/redo, add, extract, split", async ({ page }, info) => {
  await page.goto("/");
  await importFixture(page, "mixed-sizes.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);

  await page.getByTestId("dock-pages").click();
  await expect(page.getByTestId("pages-mode")).toBeVisible();
  await expect(page.getByTestId("pages-hint")).toContainText("7 pages");
  await expect(page.getByTestId("pages-selected")).toHaveText("0 selected");
  await thumbsLoaded(page, 7);

  // Actions need a selection.
  await page.getByTestId("pages-rotate").click();
  await expect(page.getByText("Select pages first.")).toBeVisible();

  // Select pages 1 and 3; rotate them.
  await page.getByTestId("page-thumb-1").click();
  await page.getByTestId("page-thumb-3").click();
  await expect(page.getByTestId("pages-selected")).toHaveText("2 selected");
  await expect(page.getByTestId("page-thumb-1")).toHaveAttribute("aria-pressed", "true");
  const before = await thumbShape(page, 1);
  await page.getByTestId("pages-rotate").click();
  await expect(page.getByTestId("pages-undo")).toBeEnabled();
  await expect.poll(() => thumbShape(page, 1)).not.toBe(before);
  await expect(page.getByTestId("pages-selected")).toHaveText("2 selected");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-pages-grid.png` });

  // Duplicate: 9 pages, the copies (2 and 5) selected.
  await page.getByTestId("pages-duplicate").click();
  await expect(page.getByTestId("pages-hint")).toContainText("9 pages");
  await expect(page.getByTestId("page-thumb-2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("page-thumb-5")).toHaveAttribute("aria-pressed", "true");

  // Undo / redo the duplicate.
  await page.getByTestId("pages-undo").click();
  await expect(page.getByTestId("pages-hint")).toContainText("7 pages");
  await page.getByTestId("pages-redo").click();
  await expect(page.getByTestId("pages-hint")).toContainText("9 pages");

  // Delete the two copies (confirm dialog first; cancel keeps them).
  await page.getByTestId("pages-delete").click();
  await expect(page.getByTestId("pages-delete-dialog")).toContainText("Delete 2 pages?");
  await page.getByTestId("pages-delete-dialog-cancel").click();
  await expect(page.getByTestId("pages-hint")).toContainText("9 pages");
  await page.getByTestId("pages-delete").click();
  await page.getByTestId("pages-delete-dialog-confirm").click();
  await expect(page.getByTestId("pages-hint")).toContainText("7 pages");
  await expect(page.getByTestId("pages-selected")).toHaveText("0 selected");

  // Select all, and a document keeps at least one page.
  await page.getByTestId("pages-select-all").click();
  await expect(page.getByTestId("pages-selected")).toHaveText("7 selected");
  await expect(page.getByTestId("pages-select-all")).toHaveText("None");
  await page.getByTestId("pages-delete").click();
  await expect(page.getByText("A document keeps at least one page.")).toBeVisible();
  await page.getByTestId("pages-select-all").click();
  await expect(page.getByTestId("pages-selected")).toHaveText("0 selected");

  // Long-press page 7 and drag it before page 1.
  const last = page.getByTestId("page-thumb-7");
  await last.scrollIntoViewIfNeeded();
  const lastShape = await thumbShape(page, 7);
  const from = await last.boundingBox();
  const to = await page.getByTestId("page-thumb-1").boundingBox();
  if (!from || !to) throw new Error("grid not laid out");
  await page.mouse.move(from.x + from.width / 2, from.y + 60);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await page.mouse.move(to.x + 4, to.y + 60, { steps: 12 });
  await expect(page.getByTestId("drop-marker")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByText("Page order changed.")).toBeVisible();
  await expect(page.getByTestId("page-thumb-1")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => thumbShape(page, 1)).toBe(lastShape);

  // Add a blank page after the selection, then a PDF with a form.
  await page.getByTestId("pages-add").click();
  await expect(page.getByTestId("pages-add-sheet")).toContainText("After page 1");
  await page.getByTestId("pages-add-blank").click();
  await expect(page.getByTestId("pages-hint")).toContainText("8 pages");
  await page.getByTestId("pages-select-all").click();
  await page.getByTestId("pages-select-all").click();
  await page.getByTestId("pages-add").click();
  await expect(page.getByTestId("pages-add-sheet")).toContainText("At the end");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("pages-add-file").click();
  await (await chooser).setFiles({ name: "form.pdf", mimeType: "application/pdf", buffer: readFileSync(fixturePath("acroform.pdf")) });
  // The form's field tooltips do not come along (ADR 0008): listed before the insert.
  await expect(page.getByTestId("pages-loss-list")).toHaveText("4 field tooltips");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-pages-loss.png` });
  await page.getByTestId("pages-loss-insert").click();
  await expect(page.getByTestId("pages-hint")).toContainText("9 pages");
  await expect(page.getByText("Added 1 page.")).toBeVisible();
  await expect(page.getByTestId("page-thumb-9")).toHaveAttribute("aria-pressed", "true");

  // Extract page 9 (the form) into a new document, then split before page 3.
  await page.getByTestId("pages-extract").click();
  await page.getByTestId("pages-extract-selected").click();
  await expect(page.getByText("Created 1 new document in the library.")).toBeVisible();
  await page.getByTestId("page-thumb-9").click();
  await page.getByTestId("page-thumb-3").scrollIntoViewIfNeeded();
  await page.getByTestId("page-thumb-3").click();
  await page.getByTestId("pages-extract").click();
  await expect(page.getByTestId("pages-split")).toContainText("Split before page 3");
  await page.getByTestId("pages-split").click();
  await expect(page.getByText("Created 2 new documents in the library.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as TestWindow).__selisTest.inspect.ids().length)).toBe(4);

  // Close: one version for the session; the document keeps the inserted form.
  await page.getByTestId("pages-close").click();
  await expect(page.getByTestId("pages-mode")).toHaveCount(0);
  await expect(page.getByTestId("viewer-dock")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText(/saved$/, { timeout: 10_000 });
  const versions = await page.evaluate(() => {
    const api = (window as unknown as TestWindow).__selisTest.inspect;
    const ids = api.ids();
    return ids.map((id) => api.versions(id));
  });
  expect(versions).toContain(2);
  const texts = await page.evaluate(async () => {
    const api = (window as unknown as TestWindow).__selisTest.inspect;
    return Promise.all(api.ids().map((id) => api.documentText(id)));
  });
  // The edited document and the extracted form page both carry a fillable form.
  expect(texts.filter((s) => s.includes("/AcroForm") && s.includes("full_name")).length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("form-banner")).toContainText("Form with 4 fields");
  // The viewer's top bar is measured again after the grid: the banner sits below it.
  const header = await page.getByTestId("save-status").evaluate((el) => el.closest("header")?.getBoundingClientRect().bottom ?? 0);
  const banner = await page.getByTestId("form-banner").boundingBox();
  expect(header).toBeGreaterThan(40);
  expect(banner?.y ?? 0).toBeGreaterThanOrEqual(header);
});
