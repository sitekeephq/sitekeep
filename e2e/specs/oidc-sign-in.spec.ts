/**
 * Sign-in with OpenID Connect (docs/features/OIDC_SIGN_IN.md) against a local test provider on
 * 127.0.0.1 (e2e/support/oidc-provider.ts; no network): an administrator adds the provider under
 * Administration → Sign-in Security, the sign-in page shows its button, the person signs in through it;
 * an unverified address is refused; switching the provider's connection off in the Privacy Centre
 * removes the button. The interface is Turkish.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { APIRequestContext, Browser } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { startOidcProvider } from "../support/oidc-provider";

test.use({ storageState: signedOutState(E2E_BASE_URL) });

const ADMIN_STATE = path.resolve(__dirname, "../.auth/admin.json");
const ID = "e2e-idp";
const BUTTON = "Test Kimlik ile giriş yap";

let idp: Awaited<ReturnType<typeof startOidcProvider>>;
let admin: APIRequestContext;
let email: string;

test.beforeAll(async ({ playwright }) => {
  idp = await startOidcProvider();
  admin = await playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: ADMIN_STATE });
  email = `e2e-oidc-${randomUUID().slice(0, 6)}@7d-cde.localhost`;
  const res = await admin.post("/api/v1/users", { data: { email, name: "OIDC Kişisi", password: "Mavi-Kule-Yapi-71" } });
  if (!res.ok()) throw new Error(`user creation failed (${res.status()}): ${await res.text()}`);
  idp.provider.user = { sub: "e2e-subject", email, email_verified: true, name: "OIDC Kişisi" };
});

test.afterAll(async () => {
  await admin.delete(`/api/v1/admin/oidc-providers/${ID}`);
  await admin.put(`/api/v1/admin/privacy/connections/oidc:${ID}`, { data: { enabled: true } });
  await admin.dispose();
  await idp.close();
});

/** The provider as the first test saves it (for a test run on its own, or after a retry). */
async function ensureProvider() {
  const data = {
    id: ID,
    name: "Test Kimlik",
    issuer: idp.provider.issuer,
    clientId: idp.provider.clientId,
    clientSecret: idp.provider.clientSecret,
    buttonLabel: BUTTON,
  };
  const created = await admin.post("/api/v1/admin/oidc-providers", { data });
  if (created.status() === 409) expect((await admin.put(`/api/v1/admin/oidc-providers/${ID}`, { data })).ok()).toBe(true);
  else expect(created.ok()).toBe(true);
}

/** The start and callback answer with redirects (302), which the fixture would count as failures. */
const REDIRECTS = /^\/api\/v1\/auth\/oidc\//;

async function adminPage(browser: Browser) {
  const context = await browser.newContext({ storageState: ADMIN_STATE });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("cde.productTour.v1", "done");
    } catch {
      // ignore
    }
  });
  return { context, page: await context.newPage() };
}

test("an administrator adds a provider and a person signs in with its button", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const a = await adminPage(browser);
  await a.page.goto("/administration?tab=security");
  const card = a.page.getByTestId("admin-oidc");
  await expect(card.getByRole("heading", { name: "OpenID Connect ile Giriş" })).toBeVisible();
  await card.getByRole("button", { name: "Sağlayıcı Ekle" }).click();
  const dialog = a.page.getByRole("dialog");
  await dialog.getByLabel("Kısa Kimlik").fill(ID);
  await dialog.getByLabel("Görünen Ad").fill("Test Kimlik");
  await dialog.getByLabel("Yayıncı Adresi (Issuer)").fill(idp.provider.issuer);
  await dialog.getByLabel("İstemci Kimliği").fill(idp.provider.clientId);
  await dialog.getByLabel("İstemci Sırrı").fill(idp.provider.clientSecret!);
  await dialog.getByLabel("Düğme Metni").fill(BUTTON);
  // Account creation stays off by default.
  await expect(dialog.getByRole("checkbox", { name: "İlk Girişte Hesap Oluştur" })).not.toBeChecked();
  const saved = a.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/oidc-providers" && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(card.getByText("Test Kimlik", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Dene" }).click();
  await expect(card.getByText(/Keşif çalışıyor/)).toBeVisible();
  await a.context.close();

  await page.goto("/login");
  await page.getByRole("link", { name: BUTTON }).click();
  await expect(page).toHaveURL(/\/home$/);
  const me = await page.request.get("/api/v1/auth/me");
  expect((await me.json()).email).toBe(email);
});

test("an address the provider has not verified is refused with a message", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  allowApiFailure(302, REDIRECTS);
  await ensureProvider();
  idp.provider.user = { ...idp.provider.user, email_verified: false };
  try {
    await page.goto("/login");
    await page.getByRole("link", { name: BUTTON }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toContainText("Kimlik sağlayıcısı e-posta adresinizi doğrulamamış");
  } finally {
    idp.provider.user = { ...idp.provider.user, email_verified: true };
  }
});

test("switching the provider's connection off in the Privacy Centre removes its button", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  allowApiFailure(302, REDIRECTS);
  await ensureProvider();
  const off = await admin.put(`/api/v1/admin/privacy/connections/oidc:${ID}`, { data: { enabled: false } });
  expect(off.ok()).toBe(true);
  try {
    const methods = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/methods");
    await page.goto("/login");
    await methods;
    await expect(page.getByRole("button", { name: "Giriş yap" })).toBeVisible();
    await expect(page.getByRole("link", { name: BUTTON })).toHaveCount(0);
    await page.goto(`/api/v1/auth/oidc/${ID}/start`);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toContainText("Bu giriş yöntemi bu sunucuda kapalı");
  } finally {
    await admin.put(`/api/v1/admin/privacy/connections/oidc:${ID}`, { data: { enabled: true } });
  }
});
