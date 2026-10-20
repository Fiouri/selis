/**
 * Content erase (P7b, ADR 0033) against the mock backend with the real PDFium
 * worker: rectangle and brush strokes are a preview (undo / redo one by one),
 * a signed document warns once, Apply writes a version labelled "erase" whose
 * text no longer has the erased line (search, pdf.js, bytes), the earlier
 * version is kept; delete object removes one object, a long press steps
 * through overlapping ones; Match background and the eyedropper pick the page's
 * colours; a key Greek does not have yet shows in English.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { findInFile, pdfjsRender, pdfjsText } from "@selis/fixtures/oracle";
import el from "../src/i18n/el.json" with { type: "json" };
import en from "../src/i18n/en.json" with { type: "json" };
import { firstPageRendered, importFixture, presetSettings, SCREENSHOTS } from "./helpers";

type Inspect = { ids: () => string[]; versionLabels: (id: string) => string[]; documentBytes: (id: string) => Promise<number[]> };
type TestWindow = { __selisTest: { inspect: Inspect } };

/** A4 in points: the layer's CSS px per point is its width over this. */
const PAGE_PT = 595.28;
const PAGE_H = 841.89;

async function open(page: Page, fixture = "erase.pdf"): Promise<void> {
  await page.goto("/");
  await importFixture(page, fixture);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

async function startErase(page: Page): Promise<Locator> {
  await page.getByTestId("dock-annotate").click();
  await page.getByTestId("tool-erase").click();
  await expect(page.getByTestId("erase-options")).toBeVisible();
  return page.getByTestId("erase-layer-1");
}

async function scaleOf(layer: Locator): Promise<{ x: number; y: number; s: number }> {
  const box = await layer.boundingBox();
  if (!box) throw new Error("layer not laid out");
  return { x: box.x, y: box.y, s: box.width / PAGE_PT };
}

/** Drags between two points given in page points (top-left origin). */
async function drag(page: Page, layer: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const { x, y, s } = await scaleOf(layer);
  await page.mouse.move(x + from[0] * s, y + from[1] * s);
  await page.mouse.down();
  await page.mouse.move(x + to[0] * s, y + to[1] * s, { steps: 8 });
  await page.mouse.up();
}

async function tap(page: Page, layer: Locator, at: [number, number], holdMs = 0): Promise<void> {
  const { x, y, s } = await scaleOf(layer);
  await page.mouse.move(x + at[0] * s, y + at[1] * s);
  await page.mouse.down();
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

async function expectSearch(page: Page, query: string, expected: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill(query);
  await expect(page.getByTestId("search-status")).toHaveText(expected, { timeout: 10_000 });
  await page.goBack();
  await expect(page.getByTestId("viewer-search")).toHaveCount(0);
}

async function labels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const inspect = (window as unknown as TestWindow).__selisTest.inspect;
    return inspect.versionLabels(inspect.ids()[0] as string);
  });
}

async function savedBytes(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(() => {
    const inspect = (window as unknown as TestWindow).__selisTest.inspect;
    return inspect.documentBytes(inspect.ids()[0] as string);
  });
  return new Uint8Array(bytes);
}

const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));

test("erase: rectangle and brush, undo / redo, signed warning once, an 'erase' version without the line", async ({ page }, info) => {
  test.slow();
  await open(page);
  await expectSearch(page, "Wolfram", "1 / 1");
  const layer = await startErase(page);
  await expect(page.getByTestId("erase-apply")).toBeDisabled();

  // A rectangle over the secret line (baseline 700 pt from the bottom).
  await page.getByTestId("erase-mode-rect").click();
  await drag(page, layer, [50, PAGE_H - 712], [200, PAGE_H - 694]);
  await expect(page.getByTestId("erase-stroke")).toHaveCount(1);
  await expect(page.getByTestId("erase-apply")).toHaveText("Erase 1 area");

  // A brush stroke across the blue rectangle; undo takes it away, redo brings it back.
  await page.getByTestId("erase-mode-brush").click();
  await page.getByTestId("erase-size-l").click();
  await drag(page, layer, [150, PAGE_H - 560], [240, PAGE_H - 560]);
  await expect(page.getByTestId("erase-apply")).toHaveText("Erase 2 areas");
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("erase-apply")).toHaveText("Erase 1 area");
  await page.getByTestId("annotate-redo").click();
  await expect(page.getByTestId("erase-apply")).toHaveText("Erase 2 areas");
  // Strokes are a preview: nothing to save yet.
  await expect(page.getByTestId("save-status")).toHaveText("saved");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-erase-strokes.png` });

  // The document has a signature field: a warning first; Cancel keeps the strokes.
  await page.getByTestId("erase-apply").click();
  await expect(page.getByTestId("erase-signed-dialog")).toContainText("This document is signed");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-erase-signed.png` });
  await page.getByTestId("erase-signed-dialog-cancel").click();
  await expect(page.getByTestId("erase-stroke")).toHaveCount(2);
  await page.getByTestId("erase-apply").click();
  await page.getByTestId("erase-signed-dialog-confirm").click();
  await expect(page.getByText("Erased. A new version was saved; the earlier ones are kept.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("erase-stroke")).toHaveCount(0);
  await expect.poll(() => labels(page)).toEqual(["erase"]);

  // Once per document: the next apply does not ask again.
  await page.getByTestId("erase-mode-rect").click();
  await drag(page, layer, [60, PAGE_H - 590], [100, PAGE_H - 570]);
  await page.getByTestId("erase-apply").click();
  await expect(page.getByTestId("erase-signed-dialog")).toHaveCount(0);
  await expect.poll(() => labels(page), { timeout: 20_000 }).toEqual(["erase", "erase"]);

  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("annotate-bar")).toHaveCount(0);
  await expectSearch(page, "Wolfram", "None");
  await expectSearch(page, "Public line two", "1 / 1");

  // The saved version, read by pdf.js and as bytes: the line is gone, its neighbours stay.
  const saved = await savedBytes(page);
  const text = (await pdfjsText(saved)).pages[0] ?? "";
  expect(text).not.toContain("Wolfram");
  expect(text).toContain("Public line one.");
  expect(findInFile(saved, ["Wolfram", "Quartz"])).toEqual([]);
  // The brush went over the blue rectangle: white there now, blue next to it.
  const img = await pdfjsRender(saved, 0, 1, false);
  const at = (x: number, y: number) => {
    const o = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  };
  expect(at(200, PAGE_H - 560)).toEqual([255, 255, 255]);
  expect(at(80, PAGE_H - 530)).not.toEqual([255, 255, 255]);
});

test("erase: delete object removes the one picked; a long press steps to the next one", async ({ page }) => {
  test.slow();
  await open(page, "mixed-sizes.pdf");
  const layer = await startErase(page);
  await page.getByTestId("erase-mode-object").click();
  await expect(page.getByTestId("erase-delete")).toBeDisabled();
  // On the page label ("A4 portrait"): the text run is on top of the frame and the two
  // diagonals (whose bounds are the whole page); the size line below is only near.
  await tap(page, layer, [40, 34]);
  await expect(page.getByTestId("erase-selection")).toHaveAttribute("data-kind", "text");
  const hint = page.getByTestId("erase-hint");
  await expect(hint).toHaveText(/^Text 1 of \d+ here/);
  const count = Number(/of (\d+)/.exec((await hint.textContent()) ?? "")?.[1]);
  expect(count).toBeGreaterThanOrEqual(4);
  await tap(page, layer, [40, 34], 800);
  await expect(page.getByTestId("erase-selection")).toHaveAttribute("data-kind", "path");
  await expect(hint).toHaveText(new RegExp(`^Drawing 2 of ${count} here`));
  // Round the cycle back to the label, and delete it.
  for (let i = 1; i < count; i++) await tap(page, layer, [40, 34], 800);
  await expect(hint).toHaveText(new RegExp(`^Text 1 of ${count} here`));
  await page.getByTestId("erase-delete").click();
  await expect(page.getByText("Object deleted. A new version was saved; the earlier ones are kept.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("erase-selection")).toHaveCount(0);
  await expect.poll(() => labels(page)).toEqual(["erase"]);
  const pages = (await pdfjsText(await savedBytes(page))).pages;
  expect(pages[0]).not.toContain("A4 portrait");
  expect(pages[0]).toContain("595.28 x 841.89 pt");
  expect(pages[1]).toContain("US Letter");
});

test("erase: Match background and the eyedropper take the page's colours", async ({ page }) => {
  await open(page);
  const layer = await startErase(page);
  await page.getByTestId("erase-mode-rect").click();
  // Inside the blue rectangle (0.2 0.4 0.8 = #3366cc): the ring around is blue too.
  await page.getByTestId("erase-fill-match").click();
  await drag(page, layer, [100, PAGE_H - 580], [140, PAGE_H - 540]);
  const fill = (await page.getByTestId("erase-stroke").last().getAttribute("data-fill")) ?? "";
  hex(fill).forEach((v, i) => expect(Math.abs(v - [0x33, 0x66, 0xcc][i]!)).toBeLessThanOrEqual(2));
  // The eyedropper arms itself; a tap on the green rectangle (0.1 0.6 0.2) picks it.
  await page.getByTestId("erase-fill-pick").click();
  await expect(layer).toHaveAttribute("data-picking", "true");
  await expect(page.getByTestId("erase-hint")).toHaveText("Tap the page to pick the fill color.");
  await tap(page, layer, [360, PAGE_H - 645]);
  await expect(layer).not.toHaveAttribute("data-picking", "true");
  await drag(page, layer, [400, PAGE_H - 300], [440, PAGE_H - 260]);
  const picked = (await page.getByTestId("erase-stroke").last().getAttribute("data-fill")) ?? "";
  hex(picked).forEach((v, i) => expect(Math.abs(v - [0x1a, 0x99, 0x33][i]!)).toBeLessThanOrEqual(2));
  // Leaving without applying takes the strokes away and says so.
  await page.getByTestId("annotate-done").click();
  await expect(page.getByText("2 erase areas were not applied and were removed.")).toBeVisible();
  await expect.poll(() => labels(page)).toEqual([]);
});

test("erase: in Greek, a string not translated yet shows in English", async ({ page }) => {
  await presetSettings(page, { locale: "el", theme: "light" });
  await open(page);
  await page.getByTestId("dock-annotate").click();
  type Messages = { annotate: Record<string, string>; erase: Record<string, string> };
  const greek = el as unknown as Partial<Messages>;
  const english = en as unknown as Messages;
  const expected = (group: "annotate" | "erase", key: string) => greek[group]?.[key] ?? english[group][key];
  await expect(page.getByTestId("tool-erase")).toContainText(expected("annotate", "toolErase") ?? "");
  await page.getByTestId("tool-erase").click();
  await expect(page.getByTestId("erase-mode-brush")).toHaveText(expected("erase", "modeBrush") ?? "");
});
