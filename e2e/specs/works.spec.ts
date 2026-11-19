import { test, expect, runState } from "../support/fixtures";
import { needsModules } from "../support/modules";

needsModules("manage");

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

test("hides cancelled works until 'Show cancelled' is on", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const create = async (title: string) => {
    const r = await page.request.post(`/api/v1/projects/${project.id}/works`, { data: { typeKey: "aksiyon", title } });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()) as { id: string };
  };
  const open = `E2E open action ${stamp}`;
  const cancelled = `E2E cancelled action ${stamp}`;
  await create(open);
  const c = await create(cancelled);
  const patch = await page.request.patch(`/api/v1/projects/${project.id}/works/${c.id}`, { data: { status: "iptal" } });
  expect(patch.ok(), await patch.text()).toBe(true);

  await page.goto(`/projects/${project.id}/works?q=${encodeURIComponent(stamp)}`);
  await expect(page.getByRole("row").filter({ hasText: open })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: cancelled })).toHaveCount(0);

  await page.getByRole("button", { name: "Filtreler" }).click();
  await page.getByRole("dialog", { name: "Filtreler" }).getByLabel("İptalleri göster").click();
  await expect(page).toHaveURL(/iptal=1/);
  await expect(page.getByRole("row").filter({ hasText: cancelled })).toBeVisible();
});
