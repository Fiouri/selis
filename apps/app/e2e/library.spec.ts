import { expect, type Page, test } from "@playwright/test";
import { addToLibrary, firstPageRendered, openWith, SCREENSHOTS, thumbnailsLoaded } from "./helpers";

const cards = (page: Page) => page.getByTestId("document-collection").getByRole("button");

test("grid cards get page thumbnails; title search ignores case and accents", async ({ page }, info) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Ελληνικό δοκιμαστικό.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Mixed sizes.pdf");
  await addToLibrary(page, "acroform.pdf", "Αίτηση με φόρμα.pdf");

  await expect(cards(page)).toHaveCount(3);
  await thumbnailsLoaded(page, 3);
  await expect(page.getByRole("button", { name: "Open Ελληνικό δοκιμαστικό" })).toContainText("Today");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-library-grid.png` });

  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByTestId("library-search");
  await expect(search).toBeFocused();
  await search.fill("ΕΛΛΗΝΙΚΟ");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAccessibleName("Open Ελληνικό δοκιμαστικό");
  await search.fill("αιτηση");
  await expect(cards(page).first()).toHaveAccessibleName("Open Αίτηση με φόρμα");
  await search.fill("xyz");
  await expect(page.getByRole("heading", { name: "No results" })).toBeVisible();

  // System back closes the search first, then the library is whole again.
  await page.goBack();
  await expect(page.getByTestId("library-search")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
});

test("sort and grid/list apply at once and survive a restart", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "mixed-sizes.pdf", "beta.pdf");
  await addToLibrary(page, "greek.pdf", "alpha.pdf");
  // Newest activity first by default.
  await expect(cards(page).first()).toHaveAccessibleName("Open alpha");

  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("radio", { name: "Size" }).click();
  const sizes = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(sizes).toHaveLength(2);

  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("radio", { name: "Name" }).click();
  await expect(cards(page).first()).toHaveAccessibleName("Open alpha");
  await expect(cards(page).nth(1)).toHaveAccessibleName("Open beta");

  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("radio", { name: "List" }).click();
  await expect(page.getByTestId("document-collection")).toHaveAttribute("data-view", "list");

  await page.reload();
  // The mock backend keeps documents in memory only; the preferences come from the database.
  await addToLibrary(page, "greek.pdf", "gamma.pdf");
  await expect(page.getByTestId("document-collection")).toHaveAttribute("data-view", "list");
  await page.getByRole("button", { name: "Sort" }).click();
  await expect(page.getByRole("radio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
});

test("favorites from the long-press menu, with their own filter", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Συμβόλαιο.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Σημειώσεις.pdf");

  await page.getByRole("button", { name: "Open Συμβόλαιο" }).click({ button: "right" });
  const menu = page.getByTestId("document-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Add to favorites" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Συμβόλαιο" }).getByTestId("favorite-badge")).toBeVisible();

  await page.getByRole("button", { name: "Favorites" }).click();
  await expect(page.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Open Συμβόλαιο" }).click({ button: "right" });
  await page.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(page.getByRole("heading", { name: "No favorites yet" })).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(cards(page)).toHaveCount(2);
});

test("tags: create and assign from the menu, filter, rename, delete", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Τιμολόγιο.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Ταξίδι.pdf");

  await page.getByRole("button", { name: "Open Τιμολόγιο" }).click({ button: "right" });
  await page.getByRole("button", { name: "Tags…" }).click();
  const picker = page.getByTestId("tag-picker");
  await picker.getByPlaceholder("New tag").fill("Εργασία");
  await picker.getByRole("button", { name: "Add" }).click();
  await expect(picker.getByRole("checkbox", { name: "Εργασία" })).toHaveAttribute("aria-checked", "true");
  await picker.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Tags", exact: true }).click();
  const sheet = page.getByTestId("tags-sheet");
  await expect(sheet.getByRole("button", { name: /^Εργασία/ })).toContainText("1");
  await sheet.getByRole("button", { name: /^Εργασία/ }).click();
  await expect(page.getByRole("button", { name: "Εργασία" })).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAccessibleName("Open Τιμολόγιο");

  await page.getByRole("button", { name: "Εργασία" }).click();
  await sheet.getByRole("button", { name: "Edit the tag “Εργασία”" }).click();
  await sheet.getByLabel("Tag name").fill("Δουλειά");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByRole("button", { name: /^Δουλειά/ })).toBeVisible();

  await sheet.getByRole("button", { name: "Edit the tag “Δουλειά”" }).click();
  await sheet.getByRole("button", { name: "Delete tag" }).click();
  await sheet.getByRole("button", { name: /Tap again to delete/ }).click();
  await expect(sheet.getByText("No tags yet.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Tags", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(cards(page)).toHaveCount(2);
});

test("Recent lists opened documents, most recent first", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Πρώτο.pdf");
  await addToLibrary(page, "mixed-sizes.pdf", "Δεύτερο.pdf");
  await page.getByRole("button", { name: "Open Πρώτο" }).click();
  await firstPageRendered(page);
  await page.goBack();

  await page.getByRole("navigation").getByRole("button", { name: "Recent" }).click();
  await expect(page.getByTestId("recent-screen")).toBeVisible();
  await expect(cards(page).first()).toHaveAccessibleName("Open Πρώτο");
  await expect(cards(page).nth(1)).toHaveAccessibleName("Open Δεύτερο");
  await expect(page.getByTestId("import-fab")).toHaveCount(0);
});

test("Open with: a shared PDF is imported as a copy and opens in the viewer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  await openWith(page, [{ file: "mixed-sizes.pdf", name: "Shared from Gmail.pdf" }]);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Open Shared from Gmail" })).toBeVisible();

  // Several from one share stay in the library with a summary.
  await openWith(page, [
    { file: "greek.pdf", name: "One.pdf" },
    { file: "acroform.pdf", name: "Two.pdf" },
  ]);
  await expect(page.getByTestId("toast")).toContainText("Imported 2 documents");
  await expect(page.getByTestId("viewer-screen")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
});
