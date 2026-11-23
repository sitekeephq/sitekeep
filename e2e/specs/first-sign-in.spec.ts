import { request } from "@playwright/test";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect } from "../support/fixtures";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../support/global-setup";

test.use({ storageState: signedOutState(E2E_BASE_URL) });

test("a person with a temporary password must change it before anything else works", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  allowApiFailure(403, "/api/v1/projects");

  const suffix = Date.now().toString(36);
  const email = `first-${suffix}@7d-cde.localhost`;
  const temporary = "Gecici-Anahtar-4417";
  const own = "Kendi-Sifrem-Guclu-2026!";

  const admin = await request.newContext({ baseURL: E2E_BASE_URL });
  try {
    const login = await admin.post("/api/v1/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(login.ok()).toBe(true);
    const created = await admin.post("/api/v1/users", {
      data: { email, name: "Ilk Giris", password: temporary, mustChangePassword: true },
    });
    expect(created.ok()).toBe(true);
  } finally {
    await admin.dispose();
  }

  await page.goto("/login");
  await page.getByLabel("E-posta adresi").fill(email);
  await page.getByLabel("Şifre", { exact: true }).fill(temporary);
  await page.getByRole("button", { name: "Giriş yap" }).click();

  const dialog = page.getByRole("dialog", { name: "Şifrenizi değiştirin" });
  await expect(dialog).toBeVisible();

  // The server refuses everything else while the temporary password stands.
  const blocked = await page.request.get("/api/v1/projects");
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error).toBe("password_change_required");

  await dialog.getByLabel("Yeni şifre", { exact: true }).fill(own);
  await dialog.getByLabel("Yeni şifre (tekrar)").fill(own);
  await dialog.getByRole("button", { name: "Şifreyi kaydet" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Projeler" })).toBeVisible();
  expect((await page.request.get("/api/v1/projects")).status()).toBe(200);
});
