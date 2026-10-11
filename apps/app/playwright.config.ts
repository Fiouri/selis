import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

/**
 * Smoke tests of the real UI bundle in mobile viewports, with the in-memory
 * mock backend (`vite build --mode mock`) instead of Rust. The mock build
 * carries the same strict CSP as the Tauri app.
 *
 * `visual-390` compares each screen with the approved phone design
 * (docs/design/p1-ui-brief.md: 390×844, light / dark / sepia). Baselines are per
 * OS (`*-win32.png`, `*-linux.png`); a missing one is written on first run
 * (CI uploads it with the report, so a new Linux baseline can be committed).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  updateSnapshots: "missing",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "pixel-7", use: { ...devices["Pixel 7"] }, testIgnore: "**/visual.spec.ts" },
    { name: "iphone-15", use: { ...devices["iPhone 15"] }, testIgnore: "**/visual.spec.ts" },
    {
      name: "visual-390",
      testMatch: "**/visual.spec.ts",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: `npm run build:mock && npm run preview:mock`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
