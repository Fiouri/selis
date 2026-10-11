/**
 * Screens at the reference phone size (390×844) in every theme, compared with
 * committed baselines (docs/design/p1-ui-brief.md). Greek UI, as in the brief.
 */
import { expect, type Page, test } from "@playwright/test";
import { addToLibrary, firstPageRendered, importFixture, presetSettings, thumbnailsLoaded } from "./helpers";

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

    test(`viewer, more sheet, search (${theme})`, async ({ page }) => {
      await page.goto("/");
      await importFixture(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
      await firstPageRendered(page);
      await expect(page.locator('[data-page="2"] canvas')).toHaveCount(1);
      await settle(page);
      await expect(page).toHaveScreenshot(`viewer-${theme}.png`);

      await page.getByRole("button", { name: "Περισσότερα" }).click();
      await expect(page.getByTestId("viewer-more")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`viewer-more-${theme}.png`);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Αναζήτηση στο έγγραφο" }).click();
      await page.getByRole("searchbox").fill("κείμενο");
      await expect(page.getByTestId("search-status")).toHaveText(/^1 \//);
      await page.locator("input").blur();
      await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
      await settle(page);
      await expect(page).toHaveScreenshot(`viewer-search-${theme}.png`);
    });

    test(`settings and transfer (${theme})`, async ({ page }) => {
      await page.goto("/");
      await page.getByRole("navigation").getByRole("button", { name: "Ρυθμίσεις" }).click();
      await expect(page.getByTestId("settings-screen")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`settings-${theme}.png`, { fullPage: true });
      await page.getByTestId("setting-language").click();
      await expect(page.getByTestId("language-sheet")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`settings-language-${theme}.png`);
      await page.keyboard.press("Escape");
      await page.getByRole("navigation").getByRole("button", { name: "Μεταφορά" }).click();
      await settle(page);
      await expect(page).toHaveScreenshot(`transfer-${theme}.png`);
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

test("viewer night mode keeps the image on page 2", async ({ page }) => {
  await presetSettings(page, { theme: "light", locale: "el", nightMode: true });
  await page.goto("/");
  await importFixture(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
  await firstPageRendered(page);
  await page.getByTestId("pdf-viewer").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
  await settle(page);
  await expect(page).toHaveScreenshot("viewer-night.png");
});
