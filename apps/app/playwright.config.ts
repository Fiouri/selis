import { defineConfig, devices } from "@playwright/test";
import { FAKE_CAMERA_FILE } from "./e2e/fake-camera";

const PORT = 4173;

/**
 * Smoke tests of the real UI bundle in mobile viewports, with the in-memory
 * mock backend (`vite build --mode mock`) instead of Rust. The mock build
 * carries the same strict CSP as the Tauri app.
 *
 * `visual-390` compares each screen with the approved phone design
 * (docs/design/p1-ui-brief.md: 390×844, light / dark / sepia). One baseline set, Linux, made by
 * CI (ubuntu-24.04): the project only exists on Linux (ADR 0019). Comparison is exact
 * (`maxDiffPixels: 0`): the same Chromium on the same OS renders the same pixels, and any
 * tolerance hides small components (pixelmatch skips anti-aliased pixels, so a new line of text
 * counts only a few hundred). In CI a missing baseline fails (`updateSnapshots: "none"`); its
 * render is in the report artifact to review and commit (CONTRIBUTING.md).
 */
const visual = process.platform === "linux";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  updateSnapshots: process.env.CI ? "none" : "missing",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "pixel-7", use: { ...devices["Pixel 7"] }, testIgnore: ["**/visual.spec.ts", "**/transfer-camera.spec.ts"] },
    {
      name: "iphone-15",
      use: { ...devices["iPhone 15"] },
      // Playwright's WebKit has no MediaStream: the fake scan camera needs Chromium.
      testIgnore: ["**/visual.spec.ts", "**/transfer-camera.spec.ts", "**/scan.spec.ts"],
    },
    {
      // QR scanning with a camera that films the fixture code (Chromium's fake capture).
      name: "camera",
      testMatch: "**/transfer-camera.spec.ts",
      use: {
        ...devices["Pixel 7"],
        permissions: ["camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${FAKE_CAMERA_FILE}`,
          ],
        },
      },
    },
    ...(visual
      ? [
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
        ]
      : []),
  ],
  webServer: {
    command: `npm run build:mock && npm run preview:mock`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
