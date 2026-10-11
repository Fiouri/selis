import { expect, test } from "@playwright/test";

test("settings: theme tiles, transfer switch, storage pickers, app lock (coming soon) — all persist", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();

  // Theme: 2×2 radiogroup, applies at once.
  const themes = page.getByRole("radiogroup", { name: "Theme" });
  await expect(themes.getByRole("radio")).toHaveCount(4);
  await themes.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(themes.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  // Arrow keys move the choice too.
  await themes.getByRole("radio", { name: "Dark" }).press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");

  const localOnly = page.getByRole("switch", { name: "Local network only" });
  await expect(localOnly).toHaveAttribute("aria-checked", "false");
  await localOnly.click();
  await expect(localOnly).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("setting-versions").click();
  await page.getByTestId("versions-sheet").getByRole("radio", { name: "20" }).click();
  await expect(page.getByTestId("setting-versions")).toContainText("20");
  await page.getByTestId("setting-history").click();
  await page.getByTestId("history-sheet").getByRole("radio", { name: "500 MB" }).click();
  await expect(page.getByTestId("setting-history")).toContainText("500 MB");

  const appLock = page.getByRole("switch", { name: /App lock/ });
  await expect(appLock).toBeDisabled();
  await expect(page.getByText("Coming soon")).toBeVisible();
  await expect(page.getByText(/^Selis \d+\.\d+\.\d+ · Apache-2\.0 · No account, no tracking$/)).toBeVisible();

  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  await expect(page.getByRole("switch", { name: "Local network only" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("setting-versions")).toContainText("20");
  await expect(page.getByTestId("setting-history")).toContainText("500 MB");
});

test("settings: the language picker switches the whole UI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("setting-language").click();
  await page.getByTestId("language-sheet").getByRole("radio", { name: "Ελληνικά" }).click();
  await expect(page.getByTestId("language-sheet")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ρυθμίσεις" })).toBeVisible();
  await expect(page.getByTestId("setting-language")).toContainText("Ελληνικά");
  await expect(page.getByRole("navigation").getByRole("button", { name: "Βιβλιοθήκη" })).toBeVisible();
});
