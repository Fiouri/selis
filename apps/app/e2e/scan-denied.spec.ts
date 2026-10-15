/** Document scan (P4c) with the camera permission denied: a way on (photos, or a photo scanned), on both phones. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { presetSettings } from "./helpers";
import { useFakeScanCamera } from "./scan-camera";

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("a denied camera offers photos instead", async ({ page }) => {
  await useFakeScanCamera(page, { denied: true });
  await page.goto("/");
  await page.getByTestId("scan-empty").click();
  await expect(page.getByTestId("scan-camera-problem")).toContainText("Selis needs the camera to scan.");
  const android = await page.evaluate(() => /Android/.test(navigator.userAgent));
  // Android opens the app's settings; elsewhere the user can try again after allowing it.
  await expect(page.getByTestId(android ? "scan-open-settings" : "scan-retry")).toBeVisible();
  await expect(page.getByTestId("scan-shutter")).toBeDisabled();
  await page.getByTestId("scan-choose-photos").click();
  await expect(page.getByTestId("scan-screen")).toHaveCount(0);
});

test("without the camera, a photo already taken goes through Adjust as a scanned page", async ({ page }) => {
  await useFakeScanCamera(page, { denied: true });
  await page.goto("/");
  await page.getByTestId("scan-empty").click();
  await expect(page.getByTestId("scan-problem-photo")).toBeVisible();
  const photo = { name: "desk.jpg", bytes: Array.from(readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "store", "scan-sample", "en.jpg"))) };
  // Android: the system photo picker (mocked); elsewhere a file input (PHPicker in WKWebView).
  if (await page.evaluate(() => /Android/.test(navigator.userAgent))) {
    await page.evaluate((p) => {
      (window as unknown as { __selisTest: { photos: { pickNext: (photos: (typeof p)[]) => void } } }).__selisTest.photos.pickNext([p]);
    }, photo);
    await page.getByTestId("scan-problem-photo").click();
  } else {
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("scan-problem-photo").click();
    await (await chooser).setFiles({ name: photo.name, mimeType: "image/jpeg", buffer: Buffer.from(photo.bytes) });
  }
  await expect(page.getByTestId("scan-adjust")).toBeVisible({ timeout: 20_000 });
  // The page on the desk is found: the hint is the "found" one, not "no page found".
  await expect(page.getByTestId("scan-adjust-hint")).toHaveText("Drag the corners to the page's edges if needed.");
  await page.getByTestId("scan-keep").click();
  await expect(page.getByTestId("scan-count")).toHaveText("1 page", { timeout: 20_000 });
});
