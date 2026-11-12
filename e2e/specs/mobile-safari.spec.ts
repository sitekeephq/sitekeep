import type { Page } from "@playwright/test";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect, runState } from "../support/fixtures";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("Safari iPhone keeps hamburger, a create dialog and account tappable", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const base = `/projects/${project.id}`;

  for (const [route, label] of [
    ["today", "Bugün"],
    ["files", "Dokümanlar"],
    ["viewer", "Model Görüntüleyici"],
    ["settings", "Proje Ayarları"],
  ] as const) {
    await page.goto(`${base}/${route}`);
    await page.waitForLoadState("domcontentloaded");
    const menu = page.getByRole("button", { name: "Proje menüsü" });
    await expect(menu).toBeVisible();
    await expect(page.locator(".sidenav-current")).toHaveText(label);
    await assertNoSidewaysScroll(page);
  }

  await page.goto(`${base}/files`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Yeni Klasör" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Klasör" });
  await expect(dialog).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Kapat" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Projeler" })).toBeVisible();
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const wizard = page.getByRole("dialog", { name: "Yeni Proje" });
  await expect(wizard).toBeVisible();
  await wizard.getByRole("button", { name: "Kapat" }).click();
  await expect(wizard).toBeHidden();
});

test.describe("Safari iPhone login", () => {
  test.use({ storageState: signedOutState(E2E_BASE_URL) });

  test("login controls stay visible", async ({ page, allowApiFailure, diagnostics }) => {
    void diagnostics;
    allowApiFailure(401, "/api/v1/auth/me");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Hesabınıza giriş yapın" })).toBeVisible();
    await expect(page.getByLabel("E-posta adresi")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Giriş yap" })).toBeEnabled();
    await assertNoSidewaysScroll(page);
  });
});
