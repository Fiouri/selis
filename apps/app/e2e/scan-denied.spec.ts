/** Document scan (P4c) with the camera permission denied: a way on, on both phones. */
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
