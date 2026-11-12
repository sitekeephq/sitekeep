import { expect, runState, test } from "../support/project-features";
import { uploadServerIfc } from "../support/seed-files";

test("metraj inventory, group elements, grouping, version difference and Excel export", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { project } = await runState();
  const name = `e2e-metraj-${Date.now().toString(36)}.ifc`;
  const v1 = await uploadServerIfc(request, project.id, project.rootFolderId, "quantities.ifc", name);
  const v2 = await uploadServerIfc(request, project.id, project.rootFolderId, "quantities-v2.ifc", name);
  expect(v2.fileId).toBe(v1.fileId);

  await page.goto(`/projects/${project.id}/today`);
  await page.getByRole("link", { name: "Metraj", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/quantities`));
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible();

  const model = page.getByLabel("Model", { exact: true });
  const value = await model.locator("option").filter({ hasText: name }).first().getAttribute("value");
  await model.selectOption(value!);
  await expect(page.getByLabel("Versiyon", { exact: true })).toHaveValue(v2.versionId);

  const table = page.locator("table.qty-table");
  const row = (label: string) => table.locator("tbody > tr").filter({ has: page.getByRole("button", { name: new RegExp(`${label}$`) }) });

  await test.step("inventory of the current version", async () => {
    const totals = page.getByLabel("Toplamlar");
    await expect(totals.locator(".metric").filter({ hasText: "Eleman" })).toContainText("8");
    await expect(totals.locator(".metric").filter({ hasText: "Net Alan" })).toContainText("56,89");
    await expect(page.getByText("1 miktarsız")).toBeVisible();
    const wall = row("Duvar · Zemin Kat");
    await expect(wall.locator('td[data-label="Brüt Alan (m²)"]')).toHaveText("15");
    await expect(wall.locator('td[data-label="Boşluk (m²)"]')).toHaveText("6");
    await expect(wall.locator('td[data-label="Net Alan (m²)"]')).toHaveText("9");
    await expect(wall.getByRole("link", { name: "Modelde Göster" })).toHaveAttribute("href", /select=0QtWall000000000000001/);
  });

  await test.step("elements behind a group with their source property", async () => {
    await row("Duvar · Zemin Kat").getByRole("button").click();
    const detail = table.locator("tr.pc-detail");
    await expect(detail.getByRole("link", { name: "Duvar-01" })).toBeVisible();
    await expect(detail.getByText("Qto_WallBaseQuantities.NetSideArea")).toBeVisible();
  });

  await test.step("grouping by material as well", async () => {
    await page.getByRole("button", { name: "Malzeme", exact: true }).click();
    await expect(page.getByRole("button", { name: "Malzeme", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row("Duvar · Zemin Kat · Beton C30")).toBeVisible();
    await expect(row("Kapı · Zemin Kat · Malzemesiz")).toBeVisible();
    await page.getByRole("button", { name: "Malzeme", exact: true }).click();
    await expect(row("Duvar · Zemin Kat")).toBeVisible();
  });

  await test.step("difference to the previous version", async () => {
    await page.getByRole("button", { name: "V1 İle Karşılaştır" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${v1.versionId}`));
    await expect(page.getByText("V1 → V2: 4 grupta metraj değişti, 5 grup aynı.")).toBeVisible();
    const totals = page.getByLabel("Fark Toplamları");
    await expect(totals.locator(".metric").filter({ hasText: "Net Alan" })).toContainText("70,39 → 56,89");
    await expect(totals.locator(".metric").filter({ hasText: "Net Alan" })).toContainText("-13,5");

    const groups = page.locator("table.qty-table").first();
    const removed = groups.locator("tbody > tr").filter({ hasText: "Duvar · Kat 1" });
    await expect(removed).toContainText("−1 silindi");
    await expect(removed.locator('td[data-label="Adet"]')).toHaveText("1 → 0");
    await expect(removed.locator('td[data-label="Net Alan (m²)"]')).toHaveText("-12");
    await expect(groups.locator("tbody > tr").filter({ hasText: "Kolon · Kat 1" })).toContainText("+1 eklendi");

    await expect(page.getByRole("heading", { name: "Değişen Elemanlar (4)" })).toBeVisible();
    const elements = page.locator("table.qty-table").nth(1);
    const wall = elements.locator("tbody > tr").filter({ hasText: "Duvar-01" });
    await expect(wall).toContainText("Değişti");
    await expect(wall.locator('td[data-label="Boşluk (m²)"]')).toHaveText("+3");
    await expect(elements.locator("tbody > tr").filter({ hasText: "Duvar-02" })).toContainText("Silindi");
    await expect(elements.getByRole("link", { name: "Duvar-02" })).toHaveAttribute("href", new RegExp(`v=${v1.versionId}`));
  });

  await test.step("Excel export of the difference", async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Excel'e Aktar" }).click();
    expect((await download).suggestedFilename()).toMatch(/-V1-V2-metraj\.xlsx$/);
  });

  await test.step("back to the inventory", async () => {
    await page.getByLabel("Karşılaştır", { exact: true }).selectOption("");
    await expect(page.getByLabel("Toplamlar")).toBeVisible();
  });
});
