import { expect, runState, test } from "../support/project-features";

test("creates a blank dashboard and keeps it in the reports list", async ({ page }) => {
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
