import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(__dirname, "..");
const port = Number(process.env.E2E_PORT ?? 18080);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  globalSetup: path.join(__dirname, "support/global-setup.ts"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  outputDir: path.join(root, "test-results/playwright"),
  reporter: [
    ["line"],
    ["html", { outputFolder: path.join(root, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL,
    storageState: path.join(__dirname, ".auth/admin.json"),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-.*\.spec\.ts/,
    },
    {
      name: "iphone",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testMatch: /mobile-.*\.spec\.ts/,
      testIgnore: /mobile-safari\.spec\.ts/,
    },
    // Playwright's WebKit on macOS 14 ARM is frozen and often never finishes launching.
    // CI (Ubuntu) runs this project; locally set E2E_SAFARI=1 to opt in.
    ...((process.env.CI || process.env.E2E_SAFARI === "1")
      ? [
          {
            name: "safari",
            use: { ...devices["iPhone 13"] },
            testMatch: /mobile-safari\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: {
    command: "node e2e/support/launch.mjs",
    cwd: root,
    url: `${baseURL}/api/v1/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: { E2E_PORT: String(port) },
  },
});
