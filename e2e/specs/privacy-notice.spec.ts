/**
 * Privacy notice ("aydınlatma metni", docs/features/PRIVACY_NOTICE.md): a system administrator writes it
 * in Privacy Centre → Aydınlatma Metni and requires "I have read it"; the sign-in page shows the text and
 * keeps the sign-in button off until the box is ticked; the acceptance is counted. The interface is
 * Turkish. The notice is switched off again at the end, so other specs sign in as before.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect } from "../support/fixtures";

const ADMIN_STATE = path.resolve(__dirname, "../.auth/admin.json");
const PASSWORD = "Mavi-Kule-Yapi-71";

async function adminApi(playwright: { request: { newContext(o: object): Promise<APIRequestContext> } }) {
  return playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: ADMIN_STATE });
}

test("an administrator requires the privacy notice; the sign-in page shows it and waits for the tick", async ({ page, browser, playwright }) => {
  const admin = await adminApi(playwright);
  const email = `e2e-notice-${randomUUID().slice(0, 6)}@7d-cde.localhost`;
  expect((await admin.post("/api/v1/users", { data: { email, name: "Kisi Aydinlatma", password: PASSWORD } })).ok()).toBe(true);
  const marker = `Kişisel verileriniz ${randomUUID().slice(0, 8)} amacıyla işlenir.`;

  try {
    await page.goto("/administration");
    await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
    await page.getByRole("button", { name: "Aydınlatma Metni", exact: true }).click();
    const form = page.getByTestId("privacy-notice-settings");
    await form.getByLabel("Metin (Türkçe)").fill(`# Aydınlatma\n\n${marker}\n\n- **Veri sorumlusu:** Örnek A.Ş.`);
    await form.getByLabel("Metin (İngilizce)").fill("# Privacy notice\n\nYour personal data is processed.");
    await form.getByLabel("Giriş ve Davet Sayfalarında Göster").check();
    await form.getByLabel("Girişten Önce “Aydınlatma Metnini Okudum” Onayı İste").check();
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy/notice" && r.request().method() === "PUT");
    await form.getByRole("button", { name: "Kaydet" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByTestId("privacy-notice-version")).toContainText("Sürüm");

    const context = await browser.newContext({ storageState: signedOutState(E2E_BASE_URL) });
    const login = await context.newPage();
    const loaded = login.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/privacy-notice");
    await login.goto("/login");
    await loaded;
    const notice = login.getByTestId("privacy-notice");
    await expect(notice.getByText(marker)).toBeVisible();
    await expect(notice.getByText("Veri sorumlusu:")).toBeVisible();
    await login.getByLabel("E-posta adresi").fill(email);
    await login.getByLabel("Şifre", { exact: true }).fill(PASSWORD);
    const signIn = login.getByRole("button", { name: "Giriş yap" });
    await expect(signIn).toBeDisabled();
    await notice.getByLabel("Aydınlatma Metnini Okudum").check();
    await expect(signIn).toBeEnabled();
    const signedIn = login.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/login");
    await signIn.click();
    expect((await signedIn).ok()).toBe(true);
    await expect(login).not.toHaveURL(/\/login/);
    await context.close();

    const after = await admin.get("/api/v1/admin/privacy/notice");
    expect((await after.json()).acceptedCurrent).toBeGreaterThanOrEqual(1);
  } finally {
    expect((await admin.put("/api/v1/admin/privacy/notice", { data: { enabled: false, requireAck: false } })).ok()).toBe(true);
    await admin.dispose();
  }
});
