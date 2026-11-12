import { test, expect, runState } from "../support/fixtures";

test("phone tour walks Bugün, Dokümanlar and Viewer with the hamburger open", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/today?tur=1`);
  const tour = page.getByRole("dialog", { name: "Ürün turu" });
  await expect(tour).toBeVisible();
  await expect(tour).toHaveClass(/tour-card-phone/);
  await expect(tour.getByRole("heading", { name: "Bugün" })).toBeVisible();
  await expect(page.locator(".sidenav.menu-open")).toBeVisible();
  await expect(page.getByRole("link", { name: "Bugün" })).toBeVisible();

  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(tour.getByRole("heading", { name: "Günlük özet" })).toBeVisible();
  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/files`));
  await expect(tour.getByRole("heading", { name: "Dokümanlar" })).toBeVisible();
  await expect(page.locator(".sidenav.menu-open")).toBeVisible();

  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(tour.getByRole("heading", { name: "Klasörler" })).toBeVisible();
  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(tour.getByRole("heading", { name: "Yükle" })).toBeVisible();
  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/viewer`));
  await expect(tour.getByRole("heading", { name: "Model görüntüleyici" })).toBeVisible({ timeout: 8_000 });
  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(tour.getByRole("heading", { name: "Modeller" })).toBeVisible();
  await tour.getByRole("button", { name: "İleri" }).click();
  await expect(tour.getByRole("heading", { name: "Sahne araçları" })).toBeVisible();
  await tour.getByRole("button", { name: "Bitir" }).click();
  await expect(tour).toHaveCount(0);
});
