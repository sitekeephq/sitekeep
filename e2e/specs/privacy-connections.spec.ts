/**
 * Gizlilik Merkezi → Dış Bağlantılar lists every outbound connection with its own switch
 * (docs/features/PRIVACY.md): Google sign-in always, Autodesk when the Connect module is installed.
 * Switching Google off removes the Google button from the sign-in page. The e2e server has dummy
 * Google credentials (e2e/support/launch.mjs); nothing here calls Google.
 */
import type { Browser, Page } from "@playwright/test";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect } from "../support/fixtures";
import { moduleInstalled } from "../support/modules";

async function openConnections(page: Page) {
  await page.goto("/administration");
  await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tüm Dış Bağlantıları Kapat", exact: true })).toBeVisible();
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy/connections" && r.request().method() === "GET");
  await page.getByRole("button", { name: "Dış Bağlantılar", exact: true }).click();
  expect((await loaded).ok()).toBe(true);
}

const row = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });

async function setGoogle(page: Page, on: boolean) {
  const box = row(page, "Google ile Giriş").getByRole("checkbox");
  if ((await box.isChecked()) === on) return;
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy/connections/google" && r.request().method() === "PUT");
  await box.click();
  expect((await saved).ok()).toBe(true);
  await expect(box).toBeChecked({ checked: on });
}

/** The sign-in page in a signed-out browser, after it asked which methods are on. */
async function loginPage(browser: Browser) {
  const context = await browser.newContext({ storageState: signedOutState(E2E_BASE_URL) });
  const page = await context.newPage();
  const methods = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/methods");
  await page.goto("/login");
  await methods;
  await expect(page.getByRole("button", { name: "Giriş yap" })).toBeVisible();
  return { page, context };
}

test("the Privacy Centre lists Google sign-in and, with Connect, Autodesk, each with its own switch", async ({ page }) => {
  await openConnections(page);
  const google = row(page, "Google ile Giriş");
  await expect(google).toBeVisible();
  await expect(google.getByText("oauth2.googleapis.com, openidconnect.googleapis.com")).toBeVisible();
  await expect(google.getByRole("checkbox")).toBeVisible();

  const autodesk = row(page, "Autodesk (APS / ACC)");
  if (moduleInstalled("connect")) {
    await expect(autodesk).toBeVisible();
    await expect(autodesk.getByText(/developer\.api\.autodesk\.com/)).toBeVisible();
    await expect(autodesk.getByRole("checkbox")).toBeChecked();
  } else {
    await expect(autodesk).toHaveCount(0);
  }
});

test("switching Google sign-in off removes the Google button from the sign-in page", async ({ page, browser }) => {
  await openConnections(page);
  await setGoogle(page, true);
  const before = await loginPage(browser);
  await expect(before.page.getByRole("link", { name: "Google ile devam et" })).toBeVisible();
  await before.context.close();

  try {
    await setGoogle(page, false);
    const after = await loginPage(browser);
    await expect(after.page.getByRole("link", { name: "Google ile devam et" })).toHaveCount(0);
    // The flow itself is refused too, with a clear message on the sign-in page.
    await after.page.goto("/api/v1/auth/google");
    await expect(after.page).toHaveURL(/\/login$/);
    await expect(after.page.getByRole("alert")).toContainText("Google ile giriş bu sunucuda kapalı");
    await after.context.close();
  } finally {
    await setGoogle(page, true);
  }
});
