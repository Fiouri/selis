/**
 * Document scan (P4c) against the mock backend with the real scan and PDFium workers, and a
 * fake camera (scan-camera.ts): live outline → Adjust corners → filters → queue → PDF. The
 * PDF is read back with pdf.js. Pixel 7 only (Chromium): Playwright's WebKit has no
 * MediaStream to fake a camera with; scan-denied.spec.ts runs on both phones.
 */
import { expect, type Page, test } from "@playwright/test";
import { pdfjsPageCount, pdfjsRender } from "@selis/fixtures/oracle";
import { firstPageRendered, presetSettings } from "./helpers";
import { useFakeScanCamera } from "./scan-camera";

type Hooks = { inspect: { ids: () => string[]; documentBytes: (id: string) => Promise<number[]> } };

async function newestDocumentBytes(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const t = (window as unknown as { __selisTest: Hooks }).__selisTest;
    return t.inspect.documentBytes(t.inspect.ids()[0] ?? "");
  });
  return new Uint8Array(bytes);
}

async function openCamera(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("scan-empty").click();
  await expect(page.getByTestId("scan-camera")).toHaveAttribute("data-camera", "live");
}

async function capture(page: Page): Promise<void> {
  await expect(page.getByTestId("scan-outline")).toBeVisible();
  await page.getByTestId("scan-shutter").click();
  await expect(page.getByTestId("scan-adjust")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("scan-still")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("scans two pages, reorders them and saves one PDF", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  await expect(page.getByTestId("scan-count")).toHaveText("No pages");

  await capture(page);
  await expect(page.getByTestId("scan-adjust-hint")).toHaveText("Drag the corners to the page's edges if needed.");
  await page.getByTestId("scan-filter-bw").click();
  await expect(page.getByTestId("scan-filter-bw")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-camera")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("scan-count")).toHaveText("1 page");

  await capture(page);
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-count")).toHaveText("2 pages", { timeout: 20_000 });

  await page.getByTestId("scan-queue-open").click();
  await expect(page.getByTestId("scan-page")).toHaveCount(2);
  await page.getByRole("button", { name: "Move page 2 earlier" }).click();
  await page.getByTestId("scan-save").click();
  await expect(page.getByTestId("viewer-screen")).toBeVisible({ timeout: 30_000 });
  await firstPageRendered(page);
  await expect(page.getByTestId("scan-screen")).toHaveCount(0);

  const pdf = await newestDocumentBytes(page);
  expect(await pdfjsPageCount(pdf)).toBe(2);
  // Straightened: the longer of each pair of the outline's opposite sides (544 × 713 in the
  // frame), not the frame's 3:4.
  const first = await pdfjsRender(pdf, 0, 0.5);
  expect(first.width / first.height).toBeCloseTo(544 / 713, 1);
  // Page 1 is the second capture (colour): its paper is not pure white; page 2 is black and white.
  const second = await pdfjsRender(pdf, 1, 0.5);
  const centre = (r: { width: number; height: number; data: Uint8ClampedArray }) => {
    const i = (Math.round(r.height * 0.02) * r.width + Math.round(r.width / 2)) * 4;
    return [r.data[i], r.data[i + 1], r.data[i + 2]];
  };
  expect(centre(second)).toEqual([255, 255, 255]);
  expect(centre(first)).not.toEqual([255, 255, 255]);
});

test("corners can be moved; crossed corners cannot be kept; retake goes back", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  await capture(page);
  const area = page.getByTestId("scan-adjust-area");
  const box = await area.boundingBox();
  const handle = page.getByTestId("scan-corner-0");
  const start = await handle.boundingBox();
  if (!box || !start) throw new Error("no layout");
  // Drag the top-left corner past the bottom-right one: the outline crosses.
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 8 });
  await expect(page.getByTestId("scan-loupe")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("scan-loupe")).toHaveCount(0);
  await expect(page.getByTestId("scan-adjust-hint")).toHaveText("The corners cross. Move them back to the page's edges.");
  await expect(page.getByTestId("scan-keep")).toBeDisabled();
  await page.getByTestId("scan-retake").click();
  await expect(page.getByTestId("scan-camera")).toHaveAttribute("data-camera", "live");
  await expect(page.getByTestId("scan-count")).toHaveText("No pages");
});

test("leaving with scanned pages asks first", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  await capture(page);
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-count")).toHaveText("1 page", { timeout: 20_000 });
  await page.goBack();
  await expect(page.getByTestId("scan-discard")).toBeVisible();
  await page.getByRole("button", { name: "Keep scanning" }).click();
  await expect(page.getByTestId("scan-camera")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("scan-screen")).toHaveCount(0);
  // The camera is off again.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.srcObject !== null))).toBe(false);
});
