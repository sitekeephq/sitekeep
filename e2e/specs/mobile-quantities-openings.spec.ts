import type { Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone metraj shows geometric openings on group cards and element rows", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(120_000);
  const { project } = await runState();
  const v = await uploadServerIfc(request, project.id, project.rootFolderId, "openings.ifc", `e2e-bosluk-m-${Date.now().toString(36)}.ifc`);

  await page.goto(`/projects/${project.id}/quantities?v=${v.versionId}`);
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible();
  await expect(page.getByTestId("qty-openings")).toContainText("3 elemanda 5 boşluk");
  const walls = page.locator("table.qty-table tbody > tr").filter({ has: page.getByRole("button", { name: /Duvar · Zemin Kat$/ }) });
  await expect(walls.locator('td[data-label="Net Alan (m²)"]')).toHaveText("27,31");
  await expect(walls.locator('td[data-label="Boşluk (m²)"]')).toHaveText("3,973");
  await assertNoSidewaysScroll(page);

  await walls.getByRole("button").click();
  const a = page.locator("tr.pc-detail tbody > tr").filter({ has: page.getByRole("link", { name: "Duvar-A" }) });
  await expect(a.locator(".qty-opening-cell")).toContainText("2 Boşluk");
  await expect(a.locator(".qty-opening-cell")).toContainText("Model: 0 m²");
  await assertNoSidewaysScroll(page);
});
