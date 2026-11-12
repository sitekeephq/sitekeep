import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.E2E_PORT ?? 4177);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: path.join(import.meta.dirname, "specs"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  outputDir: path.join(root, "test-results/playwright"),
  reporter: [
    ["line"],
    ["html", { outputFolder: path.join(root, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL,
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
    // Same rule as the 7D CDE harness: Playwright's WebKit is unreliable on macOS 14 ARM, so the
    // Safari project runs in CI (Ubuntu) and locally only with E2E_SAFARI=1.
    ...(process.env.CI || process.env.E2E_SAFARI === "1"
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
    command: "npm run playground",
    cwd: root,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
