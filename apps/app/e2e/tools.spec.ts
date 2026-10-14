/**
 * Tools (P4a) against the mock backend (src/lib/mock-tools.ts: the qpdf work itself is covered
 * by Rust tests and the Maestro flow on devices): the Tools sheet from the viewer and from the
 * library, compress with sizes (once), protect with validation, remove the password (wrong,
 * then right), the unlock prompt of a protected document (the encrypted fixture, real PDFium)
 * with editing off, and the notices for the other outcomes.
 */
import { expect, type Page, test } from "@playwright/test";
import { addToLibrary, firstPageRendered, importFixture, presetSettings } from "./helpers";

type ToolsHooks = { unsavedEdits: (id: string) => void };
type Inspect = { ids: () => string[] };
type TestWindow = { __selisTest: { tools: ToolsHooks; inspect: Inspect } };

async function openViewer(page: Page): Promise<void> {
  await page.goto("/");
  await importFixture(page, "greek.pdf", "Contract.pdf");
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

async function openTools(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByTestId("more-tools").click();
  await expect(page.getByTestId("tools-rows")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await presetSettings(page, { locale: "en", theme: "light" });
});

test("compress shows the sizes once, then says there is nothing to gain", async ({ page }) => {
  await openViewer(page);
  await openTools(page);
  await page.getByTestId("tool-compress").click();
  await expect(page.getByTestId("tools-compressed")).toBeVisible();
  await expect(page.getByTestId("tools-sizes")).toHaveText(/ → .*\(−26%\)/);
  await page.getByTestId("tools-done").click();
  await expect(page.getByTestId("tools-sheet")).toHaveCount(0);
  // The viewer opened the new version.
  await firstPageRendered(page);

  await openTools(page);
  await page.getByTestId("tool-compress").click();
  await expect(page.getByTestId("tools-not-smaller")).toHaveText(/Already as small as it gets — nothing was changed\./);
});

test("protect checks the passwords, then the password can be removed with the right one only", async ({ page }) => {
  await openViewer(page);
  await openTools(page);
  await expect(page.getByTestId("tool-unprotect")).toBeDisabled();
  await expect(page.getByTestId("tool-unprotect")).toContainText("No password to remove");
  await page.getByTestId("tool-protect").click();
  const submit = page.getByTestId("tools-protect-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("tools-password").fill("short");
  await expect(page.getByTestId("tools-password-problem")).toHaveText("At least 8 characters.");
  await page.getByTestId("tools-password").fill("correct horse");
  await page.getByTestId("tools-password-again").fill("correct hors");
  await expect(page.getByTestId("tools-password-problem")).toHaveText("The two passwords are different.");
  await page.getByTestId("tools-password-again").fill("correct horse");
  await expect(submit).toBeEnabled();
  // Restrictions need an owner password that differs.
  await page.getByTestId("tools-restrictions").click();
  await page.getByTestId("tools-allow-print").click();
  await expect(submit).toBeDisabled();
  await page.getByTestId("tools-owner-password").fill("correct horse");
  await expect(page.getByTestId("tools-password-problem")).toHaveText("Use a different owner password.");
  await page.getByTestId("tools-owner-password").fill("owner battery");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText("Saved as a new version.")).toBeVisible();
  await expect(page.getByTestId("tools-protect-sheet")).toHaveCount(0);

  await firstPageRendered(page);
  await openTools(page);
  await expect(page.getByTestId("tool-protect")).toBeDisabled();
  await expect(page.getByTestId("tool-protect")).toContainText("Already protected");
  await expect(page.getByTestId("tool-compress")).toContainText("Remove the password first");
  await page.getByTestId("tool-unprotect").click();
  await page.getByTestId("tools-current-password").fill("wrong horse");
  await page.getByTestId("tools-unprotect-submit").click();
  await expect(page.getByTestId("tools-wrong-password")).toHaveText("Wrong password.");
  // The field was cleared; nothing typed stays.
  await expect(page.getByTestId("tools-current-password")).toHaveValue("");
  await page.getByTestId("tools-current-password").fill("correct horse");
  await page.getByTestId("tools-unprotect-submit").click();
  await expect(page.getByText("Saved as a new version.")).toBeVisible();

  await firstPageRendered(page);
  await openTools(page);
  await expect(page.getByTestId("tool-protect")).toBeEnabled();
});

test("a protected document asks for its password and cannot be edited", async ({ page }) => {
  await page.goto("/");
  await importFixture(page, "encrypted.pdf", "Locked.pdf");
  await expect(page.getByTestId("unlock-sheet")).toBeVisible();
  await expect(page.getByTestId("unlock-submit")).toBeDisabled();
  await page.getByTestId("unlock-password").fill("wrong");
  await page.getByTestId("unlock-submit").click();
  await expect(page.getByTestId("unlock-wrong")).toHaveText("Wrong password.", { timeout: 15_000 });
  await page.getByTestId("unlock-password").fill("selis");
  await page.getByTestId("unlock-submit").click();
  await expect(page.getByTestId("unlock-sheet")).toHaveCount(0);
  await firstPageRendered(page);

  await page.getByTestId("dock-annotate").click();
  await expect(page.getByText("Remove the password to edit.")).toBeVisible();
  await expect(page.getByTestId("annotate-bar")).toHaveCount(0);

  // Back in the library, its card shows a lock, not its first page.
  await page.goBack();
  await expect(page.getByTestId("thumbnail-locked")).toBeVisible({ timeout: 15_000 });
});

test("back from the password prompt leaves the document", async ({ page }) => {
  await page.goto("/");
  await importFixture(page, "encrypted.pdf", "Locked.pdf");
  await expect(page.getByTestId("unlock-sheet")).toBeVisible();
  await page.getByTestId("unlock-back").click();
  await expect(page.getByTestId("viewer-screen")).toHaveCount(0);
});

test("tools from the library menu: linearize once, repair finds nothing, unsaved edits refuse", async ({ page }) => {
  await page.goto("/");
  await addToLibrary(page, "greek.pdf", "Contract.pdf");
  const openMenuTools = async () => {
    await page.getByRole("button", { name: "Open Contract" }).click({ button: "right" });
    await page.getByTestId("menu-tools").click();
    await expect(page.getByTestId("tools-rows")).toBeVisible();
  };
  await openMenuTools();
  await page.getByTestId("tool-linearize").click();
  await expect(page.getByText("Saved as a new version.")).toBeVisible();
  await openMenuTools();
  await page.getByTestId("tool-linearize").click();
  await expect(page.getByText("Already optimised for fast web view.")).toBeVisible();
  await openMenuTools();
  await page.getByTestId("tool-repair").click();
  await expect(page.getByText("Nothing to repair — the file is sound.")).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    const id = w.__selisTest.inspect.ids()[0];
    if (id) w.__selisTest.tools.unsavedEdits(id);
  });
  await openMenuTools();
  await page.getByTestId("tool-compress").click();
  await expect(page.getByText("Save your edits first.")).toBeVisible();
});
