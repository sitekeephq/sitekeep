import { test, expect, runState } from "../support/fixtures";

test("opens the works hub and creates a correspondence through the UI", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const title = `E2E UI correspondence ${Date.now().toString(36)}`;

  await page.goto(`/projects/${project.id}/works`);

  await expect(page.getByRole("heading", { name: "Tüm İşler" })).toBeVisible();
  const views = page.getByRole("complementary", { name: "Görünümler" });
  await expect(views.getByRole("link", { name: "Yazışmalar" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Bilgi Talepleri" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Teknik Onaylar" })).toBeVisible();

  await page.getByRole("button", { name: "+ Yeni" }).click();
  await page.getByRole("dialog", { name: "Ne Yapmak İstiyorsunuz?" }).getByText("Giden Yazı", { exact: true }).click();

  const create = page.getByRole("dialog", { name: "Yeni Giden Yazı" });
  await create.locator("input").first().fill(title);
  await create.getByRole("button", { name: "Kaydet" }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/works/[^?]+\\?bolum=yazismalar$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.getByRole("button", { name: "Kapat" }).click();
  await expect(page.getByRole("row").filter({ hasText: title })).toBeVisible();
});
