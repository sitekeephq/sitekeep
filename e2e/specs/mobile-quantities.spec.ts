import type { Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";
import { needsModules } from "../support/modules";

needsModules("cost");

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone metraj shows group cards, element details and the version difference", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(150_000);
  const { project } = await runState();
  const name = `e2e-metraj-m-${Date.now().toString(36)}.ifc`;
  const v1 = await uploadServerIfc(request, project.id, project.rootFolderId, "quantities.ifc", name);
  const v2 = await uploadServerIfc(request, project.id, project.rootFolderId, "quantities-v2.ifc", name);

  await page.goto(`/projects/${project.id}/quantities?v=${v2.versionId}`);
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible();
  const wall = page.locator("table.qty-table tbody > tr").filter({ has: page.getByRole("button", { name: /Duvar · Zemin Kat$/ }) });
  await expect(wall.locator('td[data-label="Net Alan (m²)"]')).toHaveText("9");
  // Cards on a phone: the column name is printed in front of the value.
  const before = await wall.locator('td[data-label="Net Alan (m²)"]').evaluate((el) => getComputedStyle(el, "::before").content);
  expect(before).toContain("Net Alan");
  await assertNoSidewaysScroll(page);

  await wall.getByRole("button").click();
  await expect(page.locator("tr.pc-detail").getByRole("link", { name: "Duvar-01" })).toBeVisible();
  await assertNoSidewaysScroll(page);

  await page.getByRole("button", { name: "V1 İle Karşılaştır" }).click();
  await expect(page).toHaveURL(new RegExp(`from=${v1.versionId}`));
  await expect(page.getByRole("heading", { name: "Değişen Gruplar" })).toBeVisible();
  await expect(page.locator("table.qty-table tbody > tr").filter({ hasText: "Duvar · Kat 1" })).toContainText("−1 silindi");
  await expect(page.getByRole("heading", { name: "Değişen Elemanlar (4)" })).toBeVisible();
  await assertNoSidewaysScroll(page);
});
