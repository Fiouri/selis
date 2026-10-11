/**
 * Screens at the reference phone size (390×844) in every theme, compared with
 * committed baselines (docs/design/p1-ui-brief.md). Greek UI, as in the brief.
 */
import { expect, type Page, test } from "@playwright/test";
import { addToLibrary, presetSettings, thumbnailsLoaded } from "./helpers";

const THEMES = ["light", "dark", "sepia"] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function stockLibrary(page: Page): Promise<void> {
  await addToLibrary(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Συμβόλαιο ενοικίασης 2026.pdf");
  await addToLibrary(page, "acroform.pdf", "Αίτηση.pdf");
  await thumbnailsLoaded(page, 3);
  await page.getByRole("button", { name: "Άνοιγμα Αίτηση" }).click({ button: "right" });
  await page.getByRole("button", { name: "Προσθήκη στα αγαπημένα" }).click();
  await expect(page.getByTestId("favorite-badge")).toHaveCount(1);
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await presetSettings(page, { theme, locale: "el" });
    });

    test(`library empty (${theme})`, async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Η βιβλιοθήκη σου είναι άδεια" })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`library-empty-${theme}.png`);
    });

    test(`library grid, list, sort sheet (${theme})`, async ({ page }) => {
      await page.goto("/");
      await stockLibrary(page);
      await settle(page);
      await expect(page).toHaveScreenshot(`library-grid-${theme}.png`);

      await page.getByRole("button", { name: "Ταξινόμηση" }).click();
      await expect(page.getByTestId("sort-sheet")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`library-sort-sheet-${theme}.png`);
      await page.getByRole("radio", { name: "Λίστα" }).click();
      await expect(page.getByTestId("document-collection")).toHaveAttribute("data-view", "list");
      await thumbnailsLoaded(page, 3);
      await settle(page);
      await expect(page).toHaveScreenshot(`library-list-${theme}.png`);
    });

    test(`recent (${theme})`, async ({ page }) => {
      await page.goto("/");
      await stockLibrary(page);
      await page.getByRole("navigation").getByRole("button", { name: "Πρόσφατα" }).click();
      await thumbnailsLoaded(page, 3);
      await settle(page);
      await expect(page).toHaveScreenshot(`recent-${theme}.png`);
    });
  });
}
