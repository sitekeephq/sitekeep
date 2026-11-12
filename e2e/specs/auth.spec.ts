import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect } from "../support/fixtures";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../support/global-setup";

test.use({ storageState: signedOutState(E2E_BASE_URL) });

test("unauthenticated users are redirected to login", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  await page.goto("/projects/not-accessible/files");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Hesabınıza giriş yapın" })).toBeVisible();
});

test("UI login rejects invalid credentials", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  allowApiFailure(401, "/api/v1/auth/login");
  await page.goto("/login");

  await page.getByLabel("E-posta adresi").fill(ADMIN_EMAIL);
  await page.getByLabel("Şifre", { exact: true }).fill("definitely-wrong");
  await page.getByRole("button", { name: "Giriş yap" }).click();

  await expect(page.getByRole("alert")).toContainText("E-posta veya şifre hatalı");
  await expect(page).toHaveURL(/\/login$/);
});

test("UI login and logout complete a real session", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  await page.goto("/login");

  await page.getByLabel("E-posta adresi").fill(ADMIN_EMAIL);
  await page.getByLabel("Şifre", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "Projeler" })).toBeVisible();

  await page.getByRole("button", { name: "Y", exact: true }).click();
  await page.getByRole("menuitem", { name: "Oturumu kapat" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
