import { expect, runState, test } from "../support/project-features";
import { moduleInstalled, needsModules } from "../support/modules";

test("lists every area's records with CSV export (Community lists)", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/reports?view=lists&module=issues`);

  await expect(page.getByRole("heading", { name: "Raporlar", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Liste" })).toHaveValue("issues");
  await expect(page.getByRole("heading", { name: "Sorunlar", exact: true })).toBeVisible();
  const csv = page.getByRole("link", { name: "CSV İndir" });
  await expect(csv).toHaveAttribute("href", `/api/v1/projects/${project.id}/reports/datasets/issues/csv`);
  const res = await page.request.get(`/api/v1/projects/${project.id}/reports/datasets/issues/csv`);
  expect(res.status()).toBe(200);
  expect((await res.text()).split("\r\n")[0]).toContain("Başlık");
  if (!moduleInstalled("platform")) {
    // Without the report builder: no dashboards tab, no builder buttons, and the hint to Enterprise.
    await expect(page.getByRole("button", { name: "Boş Panel" })).toHaveCount(0);
    await expect(page.getByText(/Platform modülü/)).toBeVisible();
  }
});


test("creates a blank dashboard and keeps it in the reports list", async ({ page }) => {
  needsModules("platform");
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/reports`);

  await expect(page.getByRole("heading", { name: "Raporlar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Boş Panel", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/reports/[^?]+\\?edit=1$`));
  await expect(page.getByRole("heading", { name: "Yeni panel", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary").getByRole("heading", { name: "Paneli Düzenle" })).toBeVisible();

  await page.getByRole("link", { name: "Raporlar", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/reports$`));
  await expect(page.getByRole("link", { name: /Yeni panel/ })).toBeVisible();
});
