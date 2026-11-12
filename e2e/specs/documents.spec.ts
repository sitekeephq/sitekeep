import path from "node:path";
import { test, expect, runState } from "../support/fixtures";

test("creates a document folder and edits its description", async ({ page }) => {
  const { project } = await runState();
  const folderName = `E2E Folder ${Date.now().toString(36)}`;
  const description = "Created and described through the browser";
  await page.goto(`/projects/${project.id}/files`);

  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Yeni Klasör" }).click();
  await page.getByRole("dialog", { name: "Yeni Klasör" }).locator("input").fill(folderName);
  await page.getByRole("dialog", { name: "Yeni Klasör" }).getByRole("button", { name: "Oluştur" }).click();

  let row = page.getByRole("row").filter({ hasText: folderName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Açıklamayı düzenle" }).click();
  await row.getByLabel("Açıklama").fill(description);
  await row.getByLabel("Açıklama").press("Enter");

  row = page.getByRole("row").filter({ hasText: folderName });
  await expect(row).toContainText(description);
});

test("uploads, deletes, and restores a tiny text document", async ({ page }) => {
  const { project } = await runState();
  const fileName = "critical-path.txt";
  const fixture = path.resolve(__dirname, "../fixtures/critical-path.txt");
  await page.goto(`/projects/${project.id}/files`);

  await page.locator(".docs-toolbar input[type=file]").setInputFiles(fixture);
  const upload = page.getByRole("dialog", { name: /Yükle/ });
  await expect(upload).toBeVisible();
  await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
  await expect(upload.getByText(/Yüklendi · V1/)).toBeVisible();
  await upload.locator(".dialog-actions").getByRole("button", { name: "Kapat" }).click();

  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: `${fileName} seç` }).check();
  await page.getByRole("button", { name: "Sil (1)" }).click();
  await page.getByRole("dialog", { name: "Dosyaları sil" }).getByRole("button", { name: "1 dosyayı sil" }).click();
  await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/deleted`);
  const deletedRow = page.getByRole("row").filter({ hasText: fileName });
  await expect(deletedRow).toBeVisible();
  await deletedRow.getByRole("button", { name: "Geri Yükle" }).click();
  await expect(page.getByRole("row").filter({ hasText: fileName })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
});
