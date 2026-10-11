import { expect, type Locator, type Page, test } from "@playwright/test";
import { firstPageRendered, importFixture, SCREENSHOTS } from "./helpers";

type Inspect = {
  ids: () => string[];
  versions: (id: string) => number;
  versionLabels: (id: string) => string[];
  hasWorkingCopy: (id: string) => boolean;
  documentText: (id: string) => Promise<string>;
};
type TestWindow = { __selisTest: { inspect: Inspect; failCommands?: string[] } };
type Query = Exclude<keyof Inspect, "ids">;

/** Asks the mock backend about the newest document. */
async function ask(page: Page, query: Query): Promise<unknown> {
  return page.evaluate(async (name) => {
    const api = (window as unknown as TestWindow).__selisTest.inspect;
    const id = api.ids()[0] as string;
    return await (api[name] as (id: string) => unknown)(id);
  }, query);
}
const versions = async (page: Page) => Number(await ask(page, "versions"));
const versionLabels = async (page: Page) => (await ask(page, "versionLabels")) as string[];
const hasWorkingCopy = async (page: Page) => (await ask(page, "hasWorkingCopy")) === true;
const documentText = async (page: Page) => String(await ask(page, "documentText"));

async function setFailing(page: Page, commands: string[]): Promise<void> {
  await page.evaluate((list) => {
    (window as unknown as TestWindow).__selisTest.failCommands = list;
  }, commands);
}

async function openGreek(page: Page): Promise<void> {
  await page.goto("/");
  await importFixture(page, "greek.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

/** A point on page 1 at fractions of its width/height (A4: text lines start at x ≈ 0.1). */
async function at(layer: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await layer.boundingBox();
  if (!box) throw new Error("page not laid out");
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function drag(page: Page, layer: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const a = await at(layer, ...from);
  const b = await at(layer, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  await page.mouse.up();
}

test("annotate: markup, pen, shapes, text, note, eraser with undo/redo; Done makes one version", async ({ page }, info) => {
  await openGreek(page);
  await page.getByTestId("dock-annotate").click();
  await expect(page.getByTestId("annotate-bar")).toBeVisible();
  await expect(page.getByTestId("annotate-sheet")).toBeVisible();
  await expect(page.getByTestId("viewer-dock")).toHaveCount(0);
  await expect(page.getByTestId("annotate-undo")).toBeDisabled();
  await expect(page.getByTestId("tool-highlight")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-annotate-sheet.png` });

  const layer = page.getByTestId("annotation-layer-1");
  // Highlight across the first text line (baseline y = 710 pt of 842).
  await drag(page, layer, [0.11, 0.152], [0.45, 0.152]);
  await expect(page.getByTestId("annotate-undo")).toBeEnabled();

  await page.getByTestId("tool-underline").click();
  await drag(page, layer, [0.11, 0.183], [0.4, 0.183]);
  await page.getByTestId("tool-strikeout").click();
  await drag(page, layer, [0.11, 0.214], [0.35, 0.214]);

  await page.getByTestId("tool-pen").click();
  await page.getByTestId("color-blue").click();
  await expect(page.getByTestId("color-blue")).toHaveAttribute("aria-checked", "true");
  await drag(page, layer, [0.2, 0.5], [0.6, 0.6]);

  await page.getByTestId("tool-shapes").click();
  await page.getByTestId("shape-circle").click();
  // Kept high on the page: on short screens (iPhone) the tool sheet covers the bottom.
  await drag(page, layer, [0.58, 0.31], [0.78, 0.4]);

  // Undo the circle, redo it.
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("annotate-redo")).toBeEnabled();
  await page.getByTestId("annotate-redo").click();
  await expect(page.getByTestId("annotate-redo")).toBeDisabled();

  await page.getByTestId("tool-text").click();
  const textAt = await at(layer, 0.15, 0.4);
  await page.mouse.click(textAt.x, textAt.y);
  await page.getByTestId("text-editor-input").fill("Καλημέρα από τη Σελίδα");
  await page.getByTestId("text-editor-add").click();
  await expect(page.getByTestId("text-editor")).toHaveCount(0);

  await page.getByTestId("tool-note").click();
  const noteAt = await at(layer, 0.88, 0.5);
  await page.mouse.click(noteAt.x, noteAt.y);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-annotate-note.png` });
  await page.getByTestId("note-editor-input").fill("Έλεγχος σημείωσης");
  await page.getByTestId("note-editor-save").click();

  // Eraser across the pen stroke.
  await page.getByTestId("tool-eraser").click();
  await expect(page.getByTestId("annotate-hint")).toContainText("erase");
  await drag(page, layer, [0.39, 0.52], [0.41, 0.58]);
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-annotate-edited.png` });

  // Autosave writes the working copy once the edits pause (3 s), not a version.
  await expect.poll(() => hasWorkingCopy(page), { timeout: 10_000 }).toBe(true);
  expect(await versions(page)).toBe(1);

  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("annotate-bar")).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toHaveText(" · saved");
  await expect.poll(() => versions(page)).toBe(2);
  const pdf = await documentText(page);
  for (const subtype of ["/Highlight", "/Underline", "/StrikeOut", "/Circle", "/Stamp", "/Text"]) expect(pdf).toContain(subtype);
  // The pen stroke was erased.
  expect(pdf).not.toContain("/Ink");
});

test("annotate: system back leaves annotate mode and saves", async ({ page }) => {
  await openGreek(page);
  await page.getByTestId("dock-annotate").click();
  await page.getByTestId("tool-pen").click();
  await drag(page, page.getByTestId("annotation-layer-1"), [0.2, 0.5], [0.5, 0.55]);
  await expect(page.getByTestId("annotate-undo")).toBeEnabled();
  await page.goBack();
  await expect(page.getByTestId("annotate-bar")).toHaveCount(0);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await expect.poll(() => versions(page)).toBe(2);
});

test("crash recovery: unsaved edits come back as a version on the next open", async ({ page }) => {
  await openGreek(page);
  await page.getByTestId("dock-annotate").click();
  await page.getByTestId("tool-pen").click();
  await drag(page, page.getByTestId("annotation-layer-1"), [0.2, 0.5], [0.5, 0.55]);
  await expect.poll(() => hasWorkingCopy(page), { timeout: 10_000 }).toBe(true);
  // The app "dies" before the version is written: saving fails, the working copy stays.
  await setFailing(page, ["save_version"]);
  await page.goBack();
  await page.goBack();
  await expect(page.getByTestId("viewer-screen")).toHaveCount(0);
  expect(await versions(page)).toBe(1);
  await setFailing(page, []);

  await page.getByTestId("document-card").first().click();
  await expect(page.getByTestId("recovery-dialog")).toBeVisible();
  await page.getByTestId("recovery-dialog-confirm").click();
  await expect(page.getByTestId("toast")).toContainText("recovered");
  await firstPageRendered(page);
  expect(await versionLabels(page)).toEqual(["auto"]);
  expect(await hasWorkingCopy(page)).toBe(false);
  expect(await documentText(page)).toContain("/Ink");
});
