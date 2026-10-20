/**
 * Document scan (P4c; Scan 2.0, ADR 0032) against the mock backend with the real scan and
 * PDFium workers, and a fake camera (scan-camera.ts): live outline → Adjust corners → filters
 * → review → PDF; automatic capture; editing a page (rotate, touch up, retake, delete, drag);
 * an ID card. The PDF is read back with pdf.js. Pixel 7 only (Chromium): Playwright's WebKit
 * has no MediaStream to fake a camera with; scan-denied.spec.ts runs on both phones.
 */
import { expect, type Page, test } from "@playwright/test";
import { pdfjsPageCount, pdfjsRender } from "@selis/fixtures/oracle";
import { firstPageRendered, presetSettings } from "./helpers";
import { UI_LANGS } from "./langs";
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

/** The fake camera shows one steady, sharp page: manual tests switch automatic capture off. */
test.beforeEach(async ({ page }, info) => {
  await presetSettings(page, { locale: "en", theme: "light", scanAuto: info.title.startsWith("auto") });
});

async function keep(page: Page, count: string): Promise<void> {
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-count")).toHaveText(count, { timeout: 20_000 });
}

/** The pages in the review, by the order their thumbnails were kept (their object URLs). */
async function thumbs(page: Page): Promise<string[]> {
  return page.locator('[data-testid="scan-pages"] img').evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => i.src));
}

test("scans two pages, reorders them and saves one PDF", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  // No count before the first page.
  await expect(page.getByTestId("scan-count")).toHaveCount(0);

  await capture(page);
  await expect(page.getByTestId("scan-adjust-hint")).toHaveText("Drag the corners to the page's edges if needed.");
  // Enhance is the default.
  await expect(page.getByTestId("scan-filter-enhance")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("scan-filter-bw").click();
  await expect(page.getByTestId("scan-filter-bw")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-camera")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("scan-count")).toHaveText("1 page");

  await capture(page);
  await page.getByTestId("scan-filter-original").click();
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-count")).toHaveText("2 pages", { timeout: 20_000 });
  await expect(page.getByTestId("scan-strip").locator("img")).toHaveCount(2);

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
  // No count before the first page.
  await expect(page.getByTestId("scan-count")).toHaveCount(0);
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

test("auto: a steady page is captured by itself, once; later pages of a batch are kept by themselves; Auto off is remembered", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  await expect(page.getByRole("switch", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  // The ring fills while the page holds still, then the Adjust step opens without the shutter.
  await expect(page.getByTestId("scan-progress")).toBeVisible();
  await expect(page.getByTestId("scan-adjust")).toBeVisible({ timeout: 20_000 });
  await keep(page, "1 page");
  // The same page under the camera is not captured again.
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("scan-camera")).toBeVisible();
  await expect(page.getByTestId("scan-count")).toHaveText("1 page");
  await expect(page.getByTestId("scan-progress")).toHaveCount(0);
  // After Retake the same framing is not taken again by itself; the shutter still works.
  await page.getByTestId("scan-shutter").click();
  await page.getByTestId("scan-retake").click();
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("scan-camera")).toBeVisible();

  // A batch (a page kept): Auto off and on again, and the confident page is kept by itself —
  // no Adjust step, "Page 2 added", its thumbnail in the strip.
  const auto = page.getByRole("switch", { name: "Auto" });
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await auto.click();
  await expect(page.getByTestId("scan-page-added")).toHaveText("Page 2 added", { timeout: 20_000 });
  await expect(page.getByTestId("scan-count")).toHaveText("2 pages");
  await expect(page.getByTestId("scan-adjust")).toHaveCount(0);
  await expect(page.getByTestId("scan-strip").locator("img")).toHaveCount(2);
  await expect(page.getByTestId("scan-page-added")).toHaveCount(0, { timeout: 3000 });

  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("scan-camera")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByTestId("scan-empty").click();
  await expect(page.getByRole("switch", { name: "Auto" })).toHaveAttribute("aria-checked", "false");
});

test("review: open a page, rotate it, touch it up, delete one, retake one, drag one", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  for (const count of ["1 page", "2 pages", "3 pages"]) {
    await capture(page);
    await keep(page, count);
  }
  await page.getByTestId("scan-strip").click();
  await expect(page.getByTestId("scan-page")).toHaveCount(3);
  const [first, second, third] = await thumbs(page);

  // Page 2: rotate, one touch-up stroke, undo it, another one; back keeps the edits.
  await page.getByRole("button", { name: "Edit page 2" }).click();
  const preview = page.getByTestId("scan-page-preview");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  const before = await preview.boundingBox();
  await page.getByTestId("scan-page-rotate").click();
  await expect(preview).toHaveAttribute("data-turns", "1");
  await expect(page.getByTestId("scan-page-rendering")).toHaveCount(0, { timeout: 20_000 });
  const after = await preview.boundingBox();
  if (!before || !after) throw new Error("no layout");
  // Portrait → landscape.
  expect(before.height).toBeGreaterThan(before.width);
  expect(after.width).toBeGreaterThan(after.height);
  await page.getByTestId("scan-page-touchup").click();
  const stroke = async () => {
    await page.mouse.move(after.x + after.width * 0.3, after.y + after.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(after.x + after.width * 0.7, after.y + after.height * 0.45, { steps: 10 });
    await page.mouse.up();
  };
  await stroke();
  await expect(preview).toHaveAttribute("data-strokes", "1");
  await page.getByTestId("scan-undo").click();
  await expect(preview).toHaveAttribute("data-strokes", "0");
  await stroke();
  await expect(preview).toHaveAttribute("data-strokes", "1");
  await page.getByTestId("scan-touchup-done").click();
  await page.getByTestId("scan-page-back").click();
  await expect(page.getByTestId("scan-queue")).toBeVisible({ timeout: 20_000 });
  const edited = (await thumbs(page))[1];
  expect(edited).not.toBe(second);

  // Page 1 retaken: it keeps its place.
  await page.getByRole("button", { name: "Edit page 1" }).click();
  await page.getByTestId("scan-page-retake").click();
  await expect(page.getByTestId("scan-camera")).toHaveAttribute("data-camera", "live");
  await expect(page.getByRole("heading", { name: "Retake page 1" })).toBeVisible();
  await capture(page);
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-queue")).toBeVisible({ timeout: 20_000 });
  const retaken = await thumbs(page);
  expect(retaken).toHaveLength(3);
  expect(retaken[0]).not.toBe(first);
  expect(retaken.slice(1)).toEqual([edited, third]);

  // Page 3 dragged to the front (long press, then move).
  const tiles = page.getByTestId("scan-page-open");
  const from = await tiles.nth(2).boundingBox();
  const to = await tiles.nth(0).boundingBox();
  if (!from || !to) throw new Error("no layout");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("scan-drag-ghost")).toBeVisible();
  await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 10 });
  await expect(page.getByTestId("scan-drop-marker")).toBeVisible();
  await page.mouse.up();
  expect(await thumbs(page)).toEqual([third, retaken[0], edited]);

  // Page 2 deleted from its page screen.
  await page.getByRole("button", { name: "Edit page 2" }).click();
  await page.getByTestId("scan-page-delete").click();
  await expect(page.getByTestId("scan-page")).toHaveCount(2);
  expect(await thumbs(page)).toEqual([third, edited]);

  await page.getByTestId("scan-save").click();
  await expect(page.getByTestId("viewer-screen")).toBeVisible({ timeout: 30_000 });
  await firstPageRendered(page);
  const pdf = await newestDocumentBytes(page);
  expect(await pdfjsPageCount(pdf)).toBe(2);
  // The rotated page is landscape, the other portrait.
  const one = await pdfjsRender(pdf, 0, 0.25);
  const two = await pdfjsRender(pdf, 1, 0.25);
  expect(one.height).toBeGreaterThan(one.width);
  expect(two.width).toBeGreaterThan(two.height);
});

test("an ID card: front and back on one A4 page at the ID-1 size", async ({ page }) => {
  await useFakeScanCamera(page);
  await openCamera(page);
  await page.getByRole("tab", { name: "ID card" }).click();
  await expect(page.getByTestId("scan-id-side")).toHaveText("Front of the card");
  await capture(page);
  await expect(page.getByTestId("scan-adjust-page")).toHaveText("Front");
  await expect(page.getByTestId("scan-filter-original")).toHaveAttribute("aria-checked", "true");
  await keep(page, "1 page");
  await expect(page.getByTestId("scan-id-side")).toHaveText("Back of the card");
  await expect(page.getByTestId("scan-mode")).toHaveCount(0);
  await capture(page);
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-queue")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Edit the Front" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit the Back" })).toBeVisible();
  await page.getByTestId("scan-save").click();
  await expect(page.getByTestId("viewer-screen")).toBeVisible({ timeout: 30_000 });
  await firstPageRendered(page);
  const pdf = await newestDocumentBytes(page);
  expect(await pdfjsPageCount(pdf)).toBe(1);
  const img = await pdfjsRender(pdf, 0, 2);
  const mm = (px: number) => (px / img.scale) * (25.4 / 72);
  expect(mm(img.width)).toBeCloseTo(210, 0);
  expect(mm(img.height)).toBeCloseTo(297, 0);
  // Each half of the page holds one side: its non-white extent.
  const extent = (fromY: number, toY: number) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    for (let y = Math.round(fromY * img.height); y < Math.round(toY * img.height); y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        if ((img.data[o] ?? 255) < 250 || (img.data[o + 1] ?? 255) < 250 || (img.data[o + 2] ?? 255) < 250) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    return [mm(x1 + 1 - x0), mm(y1 + 1 - y0)].sort((a, b) => b - a);
  };
  for (const [long, short] of [extent(0, 0.5), extent(0.5, 1)]) {
    expect(Math.abs((long ?? 0) - 85.6)).toBeLessThanOrEqual(1);
    expect(Math.abs((short ?? 0) - 54)).toBeLessThanOrEqual(1);
  }
});

test("auto: with reduced motion the kept page does not fly into the strip", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useFakeScanCamera(page);
  await openCamera(page);
  await expect(page.getByTestId("scan-adjust")).toBeVisible({ timeout: 20_000 });
  await keep(page, "1 page");
  const auto = page.getByRole("switch", { name: "Auto" });
  await auto.click();
  await auto.click();
  await expect(page.getByTestId("scan-page-added")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("scan-fly-in")).toBeHidden();
  await expect(page.getByTestId("scan-count")).toHaveText("2 pages");
});

for (const locale of UI_LANGS) {
  test(`header at 360 dp (${locale}): no text reaches the screen edges`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await presetSettings(page, { locale, theme: "light", scanAuto: false });
    await useFakeScanCamera(page);
    await openCamera(page);
    /** Every text run in the header: its box (text, not element) and whether it is cut by an ellipsis. */
    const runs = () =>
      page.getByTestId("scan-header").evaluate((header) => {
        const out: { text: string; left: number; right: number }[] = [];
        const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!node.textContent?.trim() || !parent || parent.closest(".sr-only")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          // A truncated run ends at its element's padding box, with an ellipsis.
          const clip = parent.getBoundingClientRect();
          out.push({ text: node.textContent.trim(), left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right) });
        }
        return out;
      });
    const check = async () => {
      const found = await runs();
      expect(found.length).toBeGreaterThan(0);
      for (const run of found) {
        expect(run.left, run.text).toBeGreaterThanOrEqual(16);
        expect(run.right, run.text).toBeLessThanOrEqual(360 - 16);
      }
    };
    await check();
    await capture(page);
    await page.getByTestId("scan-keep").click();
    await expect(page.getByTestId("scan-count")).toBeVisible({ timeout: 20_000 });
    await check();
  });
}
