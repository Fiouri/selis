/**
 * Redaction (P2d) against the mock backend with the real PDFium worker: mark
 * an area and a whiteout, erase a mark, undo / redo, apply after the confirm,
 * and prove the text is gone (full-text search no longer finds it, and pdf.js
 * reading the saved version finds neither the text nor the boxes anywhere but
 * where the UI drew them). Leaving with marks not applied removes them.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { greekGlyphHex } from "@selis/fixtures";
import { type Box, boxDistance, findInFile, isDark, pdfjsAnnotations, pdfjsRender, pdfjsText, solidBox } from "@selis/fixtures/oracle";
import { firstPageRendered, importFixture, SCREENSHOTS } from "./helpers";

type Inspect = { ids: () => string[]; versions: (id: string) => number; documentBytes: (id: string) => Promise<number[]> };
type TestWindow = { __selisTest: { inspect: Inspect } };

/** A4 width in points: the layer's CSS px per point. */
const PAGE_PT = 595;

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await importFixture(page, "greek.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

async function startRedact(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("more-redact").click();
  await expect(page.getByTestId("redact-sheet")).toBeVisible();
  return page.getByTestId("redact-layer-1");
}

/** Drags a box between two points given in page points. */
async function dragBox(page: Page, layer: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await layer.boundingBox();
  if (!box) throw new Error("layer not laid out");
  const s = box.width / PAGE_PT;
  await page.mouse.move(box.x + from[0] * s, box.y + from[1] * s);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * s, box.y + to[1] * s, { steps: 8 });
  await page.mouse.up();
}

/** Searches the document and waits for the status to settle on `expected`. */
async function expectSearch(page: Page, query: string, expected: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill(query);
  await expect(page.getByTestId("search-status")).toHaveText(expected, { timeout: 10_000 });
  await page.goBack();
  await expect(page.getByTestId("viewer-search")).toHaveCount(0);
}

test("redact: area + whiteout, erase, undo/redo, confirm, apply removes the text", async ({ page }, info) => {
  // Long flow (import, four searches, apply twice): 60 s is tight on a loaded runner.
  test.slow();
  await open(page);
  await expectSearch(page, "σύννεφο", "1 / 1");

  const layer = await startRedact(page);
  await expect(page.getByTestId("redact-apply")).toBeDisabled();

  // Area over body line 2 ("Χωρίς λογαριασμό, χωρίς σύννεφο, …", baseline y = 158 from the top).
  await page.getByTestId("redact-tool-area").click();
  await dragBox(page, layer, [50, 143], [545, 163]);
  await expect(page.getByTestId("redact-mark")).toHaveCount(1);
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (1)");

  // Whiteout over line 3 ("Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.") with new text.
  await page.getByTestId("redact-tool-whiteout").click();
  await dragBox(page, layer, [50, 169], [400, 189]);
  await page.getByTestId("text-editor-input").fill("Διορθωμένη γραμμή");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("redact-mark")).toHaveCount(2);

  // A stray mark, erased; undo brings it back, redo erases it again.
  await page.getByTestId("redact-tool-area").click();
  await dragBox(page, layer, [60, 400], [200, 440]);
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (3)");
  await page.getByTestId("redact-tool-eraser").click();
  await dragBox(page, layer, [100, 420], [101, 421]);
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (2)");
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (3)");
  await page.getByTestId("annotate-redo").click();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (2)");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-redact-marks.png` });

  // Apply: confirm first (cancel keeps the marks).
  await page.getByTestId("redact-apply").click();
  await expect(page.getByTestId("redact-dialog")).toContainText("Remove content under 2 marks for good?");
  await page.getByTestId("redact-dialog-cancel").click();
  await expect(page.getByTestId("redact-mark")).toHaveCount(2);
  await page.getByTestId("redact-apply").click();
  await page.getByTestId("redact-dialog-confirm").click();
  await expect(page.getByText("Applied 2 marks.")).toBeVisible();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-redact-applied.png` });

  // Undo restores the content and the marks while the document is open; redo applies again.
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (2)");
  await page.getByTestId("annotate-redo").click();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply");

  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("redact-sheet")).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toHaveText(/saved$/, { timeout: 10_000 });
  // The earlier version (the import) still has the content: the sheet says so; kept here.
  await expect(page.getByTestId("redact-earlier-sheet")).toContainText("Earlier versions still have it");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-redact-earlier.png` });
  await page.getByTestId("redact-earlier-keep").click();
  await expect(page.getByTestId("redact-earlier-sheet")).toHaveCount(0);
  expect(await versionCount(page)).toBe(2);

  // The removed lines are gone from the text; the rest is still there.
  await expectSearch(page, "σύννεφο", "None");
  await expectSearch(page, "ψυχοφθόρα", "None");
  await expectSearch(page, "Αριθμοί", "1 / 1");

  // The saved version itself, read by pdf.js: the boxes sit where the UI drew them (±2 pt).
  const saved = await savedVersion(page);
  const gone = ["σύννεφο", "παρακολούθηση", "ψυχοφθόρα", "βδελυγμία"];
  const text = (await pdfjsText(saved)).pages.join("\n");
  for (const w of gone) expect(text).not.toContain(w);
  expect(text).toContain("Αριθμοί");
  expect(findInFile(saved, gone, gone.flatMap((w) => greekGlyphHex(w)))).toEqual([]);
  const area: Box = { x: 50, y: 143, width: 495, height: 20 };
  const whiteout: Box = { x: 50, y: 169, width: 350, height: 20 };
  const stamps = (await pdfjsAnnotations(saved)).filter((a) => a.subtype === "Stamp");
  expect(stamps.map((a) => [a.page, a.contents])).toEqual([[0, "Διορθωμένη γραμμή"]]);
  expect(boxDistance(stamps[0]?.rect ?? area, whiteout)).toBeLessThanOrEqual(2);
  const painted = solidBox(await pdfjsRender(saved, 0, 2, false), { x: 40, y: 133, width: 515, height: 40 }, isDark);
  expect(boxDistance(painted ?? whiteout, area)).toBeLessThanOrEqual(2);
});

async function versionCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const inspect = (window as unknown as TestWindow).__selisTest.inspect;
    return inspect.versions(inspect.ids()[0] as string);
  });
}

test("redact: after the redacted version is saved, the earlier versions can be deleted", async ({ page }) => {
  await open(page);
  const layer = await startRedact(page);
  await page.getByTestId("redact-tool-area").click();
  await dragBox(page, layer, [50, 143], [545, 163]);
  await page.getByTestId("redact-apply").click();
  await page.getByTestId("redact-dialog-confirm").click();
  await expect(page.getByText("Applied 1 mark.")).toBeVisible();
  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("redact-earlier-sheet")).toBeVisible({ timeout: 10_000 });
  expect(await versionCount(page)).toBe(2);
  await page.getByTestId("redact-earlier-delete").click();
  await expect(page.getByText("Deleted 1 earlier version.")).toBeVisible();
  await expect(page.getByTestId("redact-earlier-sheet")).toHaveCount(0);
  expect(await versionCount(page)).toBe(1);
  // The current version is the redacted one.
  await expectSearch(page, "σύννεφο", "None");
});

test("redact: undoing the redaction before Done offers nothing to delete", async ({ page }) => {
  await open(page);
  const layer = await startRedact(page);
  await page.getByTestId("redact-tool-area").click();
  await dragBox(page, layer, [50, 143], [545, 163]);
  await page.getByTestId("redact-apply").click();
  await page.getByTestId("redact-dialog-confirm").click();
  await expect(page.getByText("Applied 1 mark.")).toBeVisible();
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (1)");
  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("save-status")).toHaveText(/saved$/, { timeout: 10_000 });
  await expect(page.getByTestId("redact-earlier-sheet")).toHaveCount(0);
});

/** The document's current bytes in the mock backend (the version written on Done). */
async function savedVersion(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(() => {
    const inspect = (window as unknown as TestWindow).__selisTest.inspect;
    return inspect.documentBytes(inspect.ids()[0] as string);
  });
  return new Uint8Array(bytes);
}

test("redact: leaving without applying removes the marks, the text stays", async ({ page }) => {
  await open(page);
  const layer = await startRedact(page);
  await page.getByTestId("redact-tool-area").click();
  await dragBox(page, layer, [50, 143], [545, 163]);
  await expect(page.getByTestId("redact-apply")).toHaveText("Apply (1)");
  await page.getByTestId("annotate-close").click();
  await expect(page.getByText("The mark that was not applied was removed.")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText(/saved$/, { timeout: 10_000 });
  await expectSearch(page, "σύννεφο", "1 / 1");
  // Back in the mode: nothing pending.
  await startRedact(page);
  await expect(page.getByTestId("redact-mark")).toHaveCount(0);
  await expect(page.getByTestId("redact-apply")).toBeDisabled();
});
