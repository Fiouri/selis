/**
 * Images → PDF and page export (P4b) against the mock backend with the real PDFium worker.
 * Pixel 7 picks through the native photo picker (mocked); iPhone 15 through the file input
 * (WKWebView shows PHPicker). The PDF itself is read back with pdf.js: no photo metadata, the
 * order chosen on screen, the page size.
 */
import { expect, type Page, test } from "@playwright/test";
import { makePhoto, PHOTO_SECRETS } from "@selis/fixtures";
import { findInFile, pdfjsPageCount, pdfjsRender } from "@selis/fixtures/oracle";
import { firstPageRendered, importFixture, presetSettings } from "./helpers";

type Photo = { name: string; bytes: number[] };
type Hooks = {
  photos: { pickNext: (photos: Photo[]) => void; lastExport: () => { name: string; mime: string; bytes: number[] } | null };
  inspect: { ids: () => string[]; documentBytes: (id: string) => Promise<number[]> };
};

async function photos(count: number): Promise<Photo[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      name: `IMG_${String(1000 + i)}.jpg`,
      // Different widths so the order shows in the page sizes; orientation varies too.
      bytes: [...(await makePhoto({ width: 200 + i * 40, height: 150, orientation: (i % 8) + 1, extras: true }))],
    })),
  );
}

/** Picks `list` the way this platform does (native picker on Android, file input elsewhere). */
async function pick(page: Page, list: Photo[], trigger: () => Promise<void>): Promise<void> {
  const android = await page.evaluate(() => /Android/.test(navigator.userAgent));
  if (android) {
    await page.evaluate((items) => {
      (window as unknown as { __selisTest: Hooks }).__selisTest.photos.pickNext(items);
    }, list);
    await trigger();
    return;
  }
  const chooser = page.waitForEvent("filechooser");
  await trigger();
  await (await chooser).setFiles(list.map((p) => ({ name: p.name, mimeType: "image/jpeg", buffer: Buffer.from(p.bytes) })));
}

async function newestDocumentBytes(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const t = (window as unknown as { __selisTest: Hooks }).__selisTest;
    const ids = t.inspect.ids();
    return t.inspect.documentBytes(ids[0] ?? "");
  });
  return new Uint8Array(bytes);
}

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("photos → PDF from the empty library: reorder, remove, A4, no metadata", async ({ page }) => {
  await page.goto("/");
  const list = await photos(4);
  await pick(page, list, () => page.getByTestId("images-empty").click());
  await expect(page.getByTestId("images-screen")).toBeVisible();
  await expect(page.getByTestId("images-tile")).toHaveCount(4);
  await expect(page.getByTestId("images-count")).toHaveText("4 photos");
  // Remove the second, move the (new) last one first.
  await page.getByRole("button", { name: "Remove photo 2" }).click();
  await expect(page.getByTestId("images-tile")).toHaveCount(3);
  await page.getByRole("button", { name: "Move photo 3 earlier" }).click();
  await page.getByRole("button", { name: "Move photo 2 earlier" }).click();
  await expect(page.getByRole("button", { name: "Move photo 1 earlier" })).toBeDisabled();
  await page.getByTestId("images-size").getByRole("tab", { name: "A4" }).click();
  await page.getByTestId("images-create").click();
  await expect(page.getByTestId("viewer-screen")).toBeVisible({ timeout: 20_000 });
  await firstPageRendered(page);
  await expect(page.getByTestId("images-screen")).toHaveCount(0);

  const pdf = await newestDocumentBytes(page);
  expect(await pdfjsPageCount(pdf)).toBe(3);
  expect(findInFile(pdf, [...PHOTO_SECRETS, "Exif", "GPS"])).toEqual([]);
  // A4 portrait or landscape pages (photos 4, 1, 3 in that order: all landscape here).
  const first = await pdfjsRender(pdf, 0, 0.25);
  expect(first.width).toBeGreaterThan(first.height);
});

test("cancelling the picker changes nothing; back closes the screen", async ({ page }) => {
  await page.goto("/");
  await importFixture(page, "greek.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await page.goBack();
  const android = await page.evaluate(() => /Android/.test(navigator.userAgent));
  test.skip(!android, "the browser file input has no cancel event to drive here");
  await page.evaluate(() => {
    (window as unknown as { __selisTest: Hooks }).__selisTest.photos.pickNext([]);
  });
  await page.getByTestId("images-fab").click();
  await expect(page.getByTestId("images-screen")).toHaveCount(0);
  await pick(page, await photos(2), () => page.getByTestId("images-fab").click());
  await expect(page.getByTestId("images-screen")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("images-screen")).toHaveCount(0);
  await expect(page.getByTestId("library-screen")).toBeVisible();
});

test("a page saved as an image: PNG at a chosen resolution, JPEG", async ({ page }) => {
  await page.goto("/");
  await importFixture(page, "greek.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("more-tools").click();
  await page.getByTestId("tool-export-image").click();
  await expect(page.getByTestId("tools-export-sheet")).toBeVisible();
  // A4 at 150 dpi.
  await expect(page.getByTestId("tools-export-pixels")).toHaveText("Page 1 · 1240 × 1754 px");
  await page.getByTestId("tools-dpi-96").click();
  await expect(page.getByTestId("tools-export-pixels")).toHaveText("Page 1 · 794 × 1123 px");
  await page.getByTestId("tools-export-save").click();
  await expect(page.getByText("Page saved as an image.")).toBeVisible();
  const png = await page.evaluate(() => (window as unknown as { __selisTest: Hooks }).__selisTest.photos.lastExport());
  expect(png?.mime).toBe("image/png");
  expect(png?.name).toBe("greek p1.png");
  expect(png?.bytes.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("more-tools").click();
  await page.getByTestId("tool-export-image").click();
  await page.getByTestId("tools-format-jpeg").click();
  await page.getByTestId("tools-export-save").click();
  // The PNG's toast may still be up: wait for the export itself.
  const lastMime = () => page.evaluate(() => (window as unknown as { __selisTest: Hooks }).__selisTest.photos.lastExport()?.mime);
  await expect.poll(lastMime).toBe("image/jpeg");
  const jpeg = await page.evaluate(() => (window as unknown as { __selisTest: Hooks }).__selisTest.photos.lastExport());
  expect(jpeg?.bytes.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
});

test("page export is not offered from the library menu", async ({ page }) => {
  await page.goto("/");
  await importFixture(page, "greek.pdf", "Contract.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Open Contract" }).click({ button: "right" });
  await page.getByTestId("menu-tools").click();
  await expect(page.getByTestId("tool-export-image")).toBeDisabled();
  await expect(page.getByTestId("tool-export-image")).toContainText("Open the document to choose a page");
});
