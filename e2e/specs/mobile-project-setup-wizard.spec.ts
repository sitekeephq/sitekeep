/**
 * Project set-up wizard on an iPhone (docs/features/PROJECT_SETUP_WIZARD.md): every step fits the
 * screen without sideways scrolling, and a project is created from the ISO 19650 Basic template.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(() => {
    const dialog = document.querySelector(".dialog");
    const page = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    const inside = dialog ? dialog.scrollWidth - dialog.clientWidth : 0;
    return Math.max(page, inside);
  });
  expect(extra, "the wizard should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone: the set-up wizard fits every step and creates a project", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(90_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  await page.goto("/home");
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Proje" });
  await dialog.getByTestId("new-project-wizard").click();
  const next = () => dialog.getByRole("button", { name: "İleri", exact: true }).click();

  await dialog.getByRole("radio", { name: /Türkçe/ }).check();
  await assertNoSidewaysScroll(page);
  await next();
  await dialog.locator('[data-template="iso19650-temel"]').click();
  await expect(dialog.getByTestId("setup-template-parts")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await next();
  await dialog.getByLabel("Proje adı").fill(`Mobil Sihirbaz ${s}`);
  await dialog.getByLabel("Proje kodu").fill(`MS${s}`);
  await assertNoSidewaysScroll(page);
  for (let step = 4; step <= 10; step++) {
    await next();
    await expect(dialog.getByRole("heading", { name: new RegExp(`Adım ${step} / 11`) })).toBeVisible();
    await assertNoSidewaysScroll(page);
  }
  await next();
  await expect(dialog.getByText("Her şey uygun. Proje oluşturulabilir.")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Projeyi Oluştur" }).click();
  await expect(dialog.getByTestId("setup-report")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Projeyi Aç" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/files/);
});
