import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone poz suggestions show as cards and accept into cost rules", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(150_000);
  const s = Date.now().toString(36).toUpperCase();
  const res = await request.post("/api/v1/projects", { data: { code: `PZM-${s}`, name: `PZM-${s} Poz Projesi`, template: "iso19650" } });
  expect(res.ok(), await res.text()).toBe(true);
  const project = (await res.json()) as { id: string; rootFolderId: string };
  await uploadServerIfc(request, project.id, project.rootFolderId, "poz.ifc", "Kaba.ifc");
  for (const data of [
    { code: "M-BET", description: "C30 hazır beton dökülmesi", unit: "m³", unitPrice: 2500, pozCode: `M.BET.${s}` },
    { code: "M-KAPI", description: "Ahşap iç kapı", unit: "adet", unitPrice: 6000, pozCode: `M.KAPI.${s}` },
  ])
    expect((await request.post(`/api/v1/projects/${project.id}/cost-items`, { data })).ok()).toBe(true);

  await page.goto(`/projects/${project.id}/quantities`);
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Poz Öner", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Poz Öner" });
  const door = dialog.getByTestId("poz-row").filter({ hasText: "Kapı · KP-90" });
  await expect(door).toBeVisible({ timeout: 30_000 });
  // Cards on a phone: the column name is printed in front of the value.
  const before = await door.locator('td[data-label="Tutar"]').evaluate((el) => getComputedStyle(el, "::before").content);
  expect(before).toContain("Tutar");
  await expect(door.locator('td[data-label="Tutar"]')).toContainText("12.000 ₺");
  await assertNoSidewaysScroll(page);

  for (const label of await dialog.getByRole("checkbox", { name: / Seç$/ }).all()) await label.uncheck();
  await door.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Seçilenleri Kurala Çevir (1)" }).click();
  await expect(page.getByText("1 maliyet kuralı eklendi.")).toBeVisible();
  await assertNoSidewaysScroll(page);
});
