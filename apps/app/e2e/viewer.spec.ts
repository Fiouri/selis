import { expect, type Page, test } from "@playwright/test";
import { addToLibrary, firstPageRendered, importFixture, SCREENSHOTS } from "./helpers";

async function openFixture(page: Page, file: string, name = file): Promise<void> {
  await page.goto("/");
  await importFixture(page, file, name);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

const indicator = (page: Page) => page.getByTestId("page-indicator");

async function more(page: Page, item: string, role: "button" | "switch" = "button"): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("viewer-more").getByRole(role, { name: item }).click();
}

/** The mock backend titles a picked file by its name. */
const LARGE = /^Open (Selis 1000-page fixture|large-1000)$/;

test("top bar, dock with coming-soon tools, page chip while scrolling", async ({ page }, info) => {
  await openFixture(page, "large-1000.pdf");
  await expect(page.getByRole("heading", { name: "large-1000" })).toBeVisible();
  await expect(indicator(page)).toHaveText("Page 1 of 1000");
  const dock = page.getByTestId("viewer-dock");
  for (const name of ["Annotate", "Sign", "Pages", "Send", "Share"]) await expect(dock.getByRole("button", { name })).toBeVisible();
  // aria-disabled (not available yet), but a tap still explains why.
  await dock.getByRole("button", { name: "Annotate" }).click({ force: true });
  await expect(page.getByTestId("toast")).toContainText("Coming soon");
  await dock.getByRole("button", { name: "Share" }).click();
  await expect(page.getByTestId("toast")).toContainText("Sharing is not available here.");

  await page.getByTestId("pdf-viewer").evaluate((el) => {
    el.scrollTop = 20_000;
  });
  await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("page-chip")).toContainText("/ 1000");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-viewer-scrolling.png` });
  // Fades out 1.5 s after scrolling stops.
  await expect(page.getByTestId("page-chip")).toHaveCSS("opacity", "0", { timeout: 4_000 });
});

test("full-text search finds Greek text, highlights it, steps through matches", async ({ page }, info) => {
  await openFixture(page, "greek.pdf");
  await page.getByRole("button", { name: "Search in document" }).click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("ΣΕΛΊΔΑ");
  await expect(page.getByTestId("search-status")).toHaveText(/^1 \/ [1-9]\d*$/);
  await expect(page.locator('[data-page="2"] [data-testid="search-hit-active"]')).toHaveCount(1);
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-viewer-search.png` });
  // Page 2 says «σελίδα» twice: the second match is next.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("search-status")).toHaveText("2 / 2");
  await page.getByRole("searchbox", { name: "Search the text" }).fill("ζζζ");
  await expect(page.getByTestId("search-status")).toHaveText("None");
  // Back closes the search, then the viewer.
  await page.goBack();
  await expect(page.getByTestId("viewer-search")).toHaveCount(0);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
});

test("outline jumps to its page; thumbnails sheet jumps too", async ({ page }) => {
  await openFixture(page, "large-1000.pdf");
  await more(page, "Contents");
  const outline = page.getByTestId("outline-sheet");
  await outline.getByRole("button", { name: /^Part 4: pages 301-400/ }).click();
  await expect(outline).toHaveCount(0);
  await expect(indicator(page)).toHaveText("Page 301 of 1000");

  await more(page, "Contents");
  await outline.getByRole("button", { name: "Expand “Part 2: pages 101-200”" }).click();
  await outline.getByRole("button", { name: /^Section 2\.2/ }).click();
  await expect(indicator(page)).toHaveText("Page 151 of 1000");

  await more(page, "Thumbnails");
  const grid = page.getByTestId("thumbnail-grid");
  await expect(grid.getByRole("button", { name: "Page 151" })).toHaveAttribute("aria-current", "page");
  await grid.getByRole("button", { name: "Page 152" }).click();
  await expect(indicator(page)).toHaveText("Page 152 of 1000");
});

test("selectable text layer, rotate view, double-tap zoom", async ({ page }) => {
  await openFixture(page, "greek.pdf");
  await expect(page.locator('[data-page="1"] [data-testid="text-layer"]')).toContainText("Ελληνικό");

  const box = async () => (await page.locator('[data-page="1"]').boundingBox()) ?? { width: 0, height: 0 };
  const portrait = await box();
  expect(portrait.height).toBeGreaterThan(portrait.width);
  await more(page, "Rotate view");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await box()).width > (await box()).height).toBe(true);

  const viewer = page.getByTestId("pdf-viewer");
  const area = await viewer.boundingBox();
  if (!area) throw new Error("viewer not laid out");
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await expect(viewer).toHaveAttribute("data-zoom", "2.50");
});

test("night mode darkens pages, keeps images, and persists", async ({ page }) => {
  await openFixture(page, "greek.pdf");
  const corner = () =>
    page.locator('[data-page="1"] canvas').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")?.getImageData(4, 4, 1, 1).data;
      return d ? d[0] : -1;
    });
  expect(await corner()).toBeGreaterThan(200);
  await more(page, "Night mode", "switch");
  await expect(page.getByTestId("viewer-more").getByRole("switch", { name: "Night mode" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect.poll(corner).toBeLessThan(60);

  await page.goBack();
  await page.getByRole("button", { name: /Open greek/ }).click();
  await firstPageRendered(page);
  await expect.poll(corner).toBeLessThan(60);
});

test("reopening a document returns to the last page read", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "large-1000.pdf");
  await page.getByRole("button", { name: LARGE }).click();
  await firstPageRendered(page);
  await more(page, "Contents");
  await page.getByTestId("outline-sheet").getByRole("button", { name: /^Part 5: pages 401-500/ }).click();
  await expect(indicator(page)).toHaveText("Page 401 of 1000");
  await page.waitForTimeout(1_000); // saved after the reader settles
  await page.goBack();
  await page.getByRole("button", { name: LARGE }).click();
  await expect(indicator(page)).toHaveText("Page 401 of 1000");
});
