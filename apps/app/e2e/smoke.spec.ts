import { expect, type Page, test } from "@playwright/test";
import { fixturePath } from "@selis/fixtures";

const SCREENSHOTS = "test-results/screenshots";

async function importFixture(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Import PDF|Εισαγωγή PDF/ }).first().click();
  await (await chooser).setFiles(fixturePath(file));
}

async function firstPageRendered(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-page="1"] canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
}

test("startup is local-only and shows the empty library", async ({ page }, info) => {
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(page.locator("[data-shell='phone']")).toBeVisible();
  await page.waitForLoadState("networkidle");

  const origin = new URL(page.url()).origin;
  const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
  expect(external, "no request may leave the app at startup").toEqual([]);
  // The PDF engine (WASM) is not loaded until a document is opened.
  expect(requests.some((u) => u.endsWith(".wasm"))).toBe(false);

  // Touch targets are at least 44×44 CSS px.
  for (const button of await nav.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-library-empty.png` });
});

test("import → full-bleed viewer → scroll 1000 pages → back", async ({ page }, info) => {
  await page.goto("/");
  await importFixture(page, "large-1000.pdf");

  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
  const firstPageMs = await page.evaluate(() => (window as unknown as { __selisFirstPageMs?: number }).__selisFirstPageMs);
  console.log(`[${info.project.name}] first page visible after ${Math.round(firstPageMs ?? -1)} ms`);
  await expect(page.getByTestId("page-indicator")).toHaveText("Page 1 of 1000");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-viewer.png` });

  // Scroll top → bottom in steps; only a handful of pages may be mounted at any time.
  const viewer = page.getByTestId("pdf-viewer");
  let maxMounted = 0;
  for (let step = 1; step <= 10; step++) {
    await viewer.evaluate((el, s) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * (s / 10);
    }, step);
    await page.waitForTimeout(60);
    maxMounted = Math.max(maxMounted, await page.locator("[data-page]").count());
  }
  await expect(page.getByTestId("page-indicator")).toHaveText("Page 1000 of 1000");
  await expect.poll(() => page.locator('[data-page="1000"] canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
  expect(maxMounted).toBeLessThanOrEqual(5);

  // System back returns to the library, which now knows the page count.
  await page.goBack();
  await expect(page.getByTestId("viewer-screen")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Open Selis 1000-page fixture|Open large-1000/ })).toContainText("1,000 pages");
});

test("opening renders only the visible pages plus one buffer page, visible first", async ({ page }) => {
  await page.addInitScript(() => {
    const requests: Array<{ page: number; prefetch: boolean }> = [];
    (window as unknown as { __renderRequests: typeof requests }).__renderRequests = requests;
    // Called below with .call(this), so the unbound reference is intended.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Worker.prototype.postMessage as (this: Worker, message: unknown, transfer?: Transferable[]) => void;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const m = message as { type?: string; index?: number; prefetch?: boolean };
      if (m.type === "render") requests.push({ page: (m.index ?? 0) + 1, prefetch: m.prefetch ?? false });
      original.call(this, message, transfer ?? []);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/");
  await importFixture(page, "large-1000.pdf");
  await firstPageRendered(page);
  await page.waitForTimeout(500);
  const requests = await page.evaluate(
    () => (window as unknown as { __renderRequests: Array<{ page: number; prefetch: boolean }> }).__renderRequests,
  );
  expect(requests.length).toBeLessThanOrEqual(4);
  expect(requests[0]).toEqual({ page: 1, prefetch: false });
  expect(requests.filter((r) => !r.prefetch).map((r) => r.page)).toEqual([1, 2].slice(0, requests.filter((r) => !r.prefetch).length));
});

test("pinch zoom scales only the document", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "multi-touch is driven through the Chrome DevTools Protocol");
  await page.goto("/");
  await importFixture(page, "mixed-sizes.pdf");
  await firstPageRendered(page);
  const viewer = page.getByTestId("pdf-viewer");
  const box = await viewer.boundingBox();
  if (!box) throw new Error("viewer not laid out");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", spread: number) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd"
          ? []
          : [
              { x: cx - spread, y: cy, id: 1 },
              { x: cx + spread, y: cy, id: 2 },
            ],
    });
  };
  await touch("touchStart", 40);
  for (let s = 50; s <= 120; s += 10) await touch("touchMove", s);
  await touch("touchEnd", 0);

  await expect.poll(async () => Number(await viewer.getAttribute("data-zoom"))).toBeGreaterThan(2);
  // The page itself must not zoom: the visual viewport scale stays 1.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-zoomed.png` });
});

test("language and theme switches apply and persist", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("setting-language").click();
  await page.getByTestId("language-sheet").getByRole("radio", { name: "Ελληνικά" }).click();
  await expect(page.getByRole("heading", { name: "Ρυθμίσεις" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "el");

  for (const [label, theme] of [
    ["Σκούρο", "dark"],
    ["Σέπια", "sepia"],
    ["Φωτεινό", "light"],
  ] as const) {
    await page.getByRole("radio", { name: label }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(300); // let colour transitions settle
    await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-settings-${theme}.png` });
  }

  await page.getByRole("radio", { name: "Σέπια" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  await expect(page.getByRole("button", { name: "Ρυθμίσεις" })).toBeVisible();
});

test("cancelling the picker returns to idle without an error", async ({ page }) => {
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PDF" }).click();
  await chooser;
  // The browser stand-in for the OS picker fires "cancel" when the user backs out.
  await page.locator("[data-testid=file-input]").dispatchEvent("cancel");
  await expect(page.getByRole("button", { name: "Import PDF" })).toBeEnabled();
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
});

test("a hanging import times out with a retry that succeeds", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __selisTest: object }).__selisTest = { importDelayMs: 3_000, importTimeoutMs: 400 };
  });
  await page.goto("/");
  await importFixture(page, "mixed-sizes.pdf");
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Importing took too long");
  await expect(page.getByRole("button", { name: "Import PDF" })).toBeEnabled();

  // The backend recovers; retry re-imports the same file without reopening the picker.
  await page.evaluate(() => {
    (window as unknown as { __selisTest: { importDelayMs: number; importTimeoutMs: number } }).__selisTest = {
      importDelayMs: 0,
      importTimeoutMs: 30_000,
    };
  });
  await toast.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
});

test("a lost import reply is recovered from the result store when the app resumes", async ({ page }) => {
  // The backend finishes the import, but its reply never reaches the page (the Android bug).
  await page.addInitScript(() => {
    (window as unknown as { __selisTest: object }).__selisTest = { dropReplies: ["import_document"] };
  });
  await page.goto("/");
  await importFixture(page, "mixed-sizes.pdf");
  await expect(page.getByText("Importing…")).toBeVisible();
  // App back in front: the IPC layer asks take_result instead of waiting forever.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("viewer-screen")).toBeVisible({ timeout: 4_000 });
  await firstPageRendered(page);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("back navigates within the app before leaving it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Recent" }).click();
  await expect(page.getByRole("heading", { name: "Nothing opened yet" })).toBeVisible();
  await page.getByRole("button", { name: "Transfer" }).click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");
});
