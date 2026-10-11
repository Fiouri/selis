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

    test(`annotate: tool sheet, pen options, note (${theme})`, async ({ page }) => {
      await page.goto("/");
      await importFixture(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
      await firstPageRendered(page);
      await page.getByTestId("dock-annotate").click();
      const layer = page.getByTestId("annotation-layer-1");
      const box = await layer.boundingBox();
      if (!box) throw new Error("page not laid out");
      const y = box.y + box.height * 0.152;
      await page.mouse.move(box.x + box.width * 0.11, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId("annotate-undo")).toBeEnabled();
      // Wait for the autosave so the status reads "saved", not "saving…".
      await expect(page.getByTestId("save-status")).toHaveText("αποθηκεύτηκε", { timeout: 10_000 });
      await settle(page);
      await expect(page).toHaveScreenshot(`annotate-${theme}.png`);

      await page.getByTestId("tool-pen").click();
      await settle(page);
      await expect(page.getByTestId("annotate-sheet")).toHaveScreenshot(`annotate-pen-sheet-${theme}.png`);

      await page.getByTestId("tool-note").click();
      await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
      await expect(page.getByTestId("note-editor")).toBeVisible();
      await page.getByTestId("note-editor-input").fill("Να ελεγχθεί η παράγραφος");
      await page.getByTestId("note-editor-input").blur();
      await settle(page);
      await expect(page).toHaveScreenshot(`annotate-note-${theme}.png`);
    });

    test(`sign: sheet, new signature (draw, type), placed (${theme})`, async ({ page }) => {
      await page.goto("/");
      await importFixture(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
      await firstPageRendered(page);
      await page.getByTestId("dock-sign").click();
      await expect(page.getByTestId("sign-sheet")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`sign-empty-${theme}.png`);

      await page.getByTestId("signature-new").click();
      const pad = page.getByTestId("signature-pad");
      await expect(pad).toBeVisible();
      // Measure after the sheet has slid in.
      await settle(page);
      const box = await pad.boundingBox();
      if (!box) throw new Error("pad not laid out");
      const stroke = async (points: [number, number][]) => {
        const [first, ...rest] = points;
        if (!first) return;
        await page.mouse.move(box.x + box.width * first[0], box.y + box.height * first[1]);
        await page.mouse.down();
        for (const [x, y] of rest) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 6 });
        await page.mouse.up();
      };
      await stroke([
        [0.12, 0.62],
        [0.22, 0.3],
        [0.3, 0.64],
        [0.42, 0.34],
        [0.5, 0.6],
        [0.62, 0.42],
        [0.85, 0.5],
      ]);
      await settle(page);
      await expect(page).toHaveScreenshot(`sign-new-draw-${theme}.png`);

      await page.getByTestId("signature-mode-type").click();
      await page.getByTestId("signature-name").fill("Μαρία Παπαδοπούλου");
      await page.getByTestId("signature-name").blur();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await expect(page).toHaveScreenshot(`sign-new-type-${theme}.png`);

      await page.getByTestId("signature-mode-draw").click();
      await page.getByTestId("signature-save").click();
      await expect(page.getByTestId("signature-card")).toHaveCount(1);
      const layer = page.getByTestId("signature-layer-1");
      const pageBox = await layer.boundingBox();
      if (!pageBox) throw new Error("page not laid out");
      await page.mouse.click(pageBox.x + pageBox.width * 0.55, pageBox.y + pageBox.height * 0.5);
      await expect(page.getByTestId("signature-selection")).toBeVisible();
      await expect(page.getByTestId("annotate-undo")).toBeEnabled();
      await expect(page.getByTestId("save-status")).toHaveText("αποθηκεύτηκε", { timeout: 10_000 });
      await settle(page);
      await expect(page).toHaveScreenshot(`sign-placed-${theme}.png`);
    });

    test(`forms: banner and form mode (${theme})`, async ({ page }) => {
      await page.goto("/");
      await importFixture(page, "acroform.pdf", "Αίτηση.pdf");
      await firstPageRendered(page);
      await expect(page.getByTestId("form-banner")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`form-banner-${theme}.png`);

      await page.getByTestId("form-fill").click();
      await page.getByTestId("field-full_name").click();
      await page.getByTestId("field-input-full_name").fill("Γιάννης Παπαδόπουλος");
      await page.getByTestId("field-input-full_name").press("Enter");
      // The change lands asynchronously: wait for it, then for its autosave.
      await expect(page.getByTestId("annotate-undo")).toBeEnabled();
      await expect(page.getByTestId("save-status")).toHaveText("αποθηκεύτηκε", { timeout: 10_000 });
      await page.getByTestId("form-next").click();
      await expect(page.getByTestId("field-input-email")).toBeFocused();
      await settle(page);
      await expect(page).toHaveScreenshot(`form-mode-${theme}.png`);

      await page.getByTestId("field-input-email").press("Escape");
      await page.getByTestId("form-flatten").click();
      await expect(page.getByTestId("flatten-dialog")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`form-flatten-${theme}.png`);
    });

    test(`pages: grid with selection, extract sheet, delete dialog (${theme})`, async ({ page }) => {
      await page.goto("/");
      await importFixture(page, "mixed-sizes.pdf", "Συμβόλαιο ενοικίασης 2026.pdf");
      await firstPageRendered(page);
      await page.getByTestId("dock-pages").click();
      const grid = page.getByTestId("pages-grid");
      await expect
        .poll(() => grid.locator("img").evaluateAll((imgs: HTMLImageElement[]) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length))
        .toBe(7);
      await page.getByTestId("page-thumb-2").click();
      await page.getByTestId("page-thumb-3").click();
      await settle(page);
      // The Greek title fits next to undo / redo / "Επιλογή όλων" (no ellipsis).
      expect(await page.getByTestId("pages-selected").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`pages-grid-${theme}.png`);

      await page.getByTestId("pages-extract").click();
      await expect(page.getByTestId("pages-extract-sheet")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`pages-extract-${theme}.png`);
      await page.keyboard.press("Escape");

      await page.getByTestId("pages-delete").click();
      await expect(page.getByTestId("pages-delete-dialog")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`pages-delete-${theme}.png`);
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
