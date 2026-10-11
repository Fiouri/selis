import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { fixturePath } from "@selis/fixtures";

export const SCREENSHOTS = "test-results/screenshots";

export async function firstPageRendered(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator('[data-page="1"] canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(0);
}

/** Picks a fixture through the browser stand-in for the OS picker, under any file name. */
export async function importFixture(page: Page, file: string, name = file): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^(Import PDF|Εισαγωγή PDF)$/ }).first().click();
  await (await chooser).setFiles({ name, mimeType: "application/pdf", buffer: readFileSync(fixturePath(file)) });
}

/** Imports, waits for the viewer (which also makes the thumbnail), returns to the library. */
export async function addToLibrary(page: Page, file: string, name = file): Promise<void> {
  await importFixture(page, file, name);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
  await page.goBack();
  await expect(page.getByTestId("viewer-screen")).toHaveCount(0);
}

/** Every card thumbnail has loaded. */
export async function thumbnailsLoaded(page: Page, count: number): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('[data-testid="document-collection"] img')
        .evaluateAll((imgs: HTMLImageElement[]) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length),
    )
    .toBe(count);
}

/** Simulates one Android "Open with" / share intent (one or several files) arriving (mock backend). */
export async function openWith(page: Page, files: ReadonlyArray<{ file: string; name: string }>): Promise<void> {
  const payload = files.map(({ file, name }) => ({ name, bytes: [...readFileSync(fixturePath(file))] }));
  await page.evaluate((items) => {
    type Hook = { openWith: (f: Array<{ name: string; bytes: number[] }>) => void };
    (window as unknown as { __selisTest: Hook }).__selisTest.openWith(items);
  }, payload);
}

/** Theme + language before the first frame (boot settings and the mock database). */
export async function presetSettings(page: Page, settings: { theme?: string; locale?: string }): Promise<void> {
  await page.addInitScript((s) => {
    const merged = { locale: "system", theme: "system", librarySort: "recent", libraryView: "grid", ...s };
    localStorage.setItem("selis.mock.settings", JSON.stringify(merged));
    localStorage.setItem("selis.boot-settings", JSON.stringify(merged));
  }, settings);
}
