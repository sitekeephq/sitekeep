import { expect, runState, test } from "../support/project-features";
import { moduleInstalled } from "../support/modules";

test("coordination routes show their tabs and deterministic empty states", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/coordination/sets`);

  await expect(page.getByRole("heading", { name: "Koordinasyon" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Model Setleri", exact: true })).toBeVisible();
  // Çakışma Testleri is the Coordinate module's tab.
  const clash = moduleInstalled("coordinate");
  if (clash) await expect(page.getByRole("link", { name: "Çakışma Testleri", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bilgi Gereksinimi Kontrolleri", exact: true })).toBeVisible();
  await expect(page.getByText("Henüz model seti yok.")).toBeVisible();

  await page.getByRole("button", { name: "+ Yeni Model Seti", exact: true }).click();
  const modelSetDialog = page.getByRole("dialog", { name: "Yeni Model Seti" });
  await expect(modelSetDialog.getByText("Projede IFC dosyası yok.")).toBeVisible();
  await expect(modelSetDialog.getByRole("button", { name: "Kaydet" })).toBeDisabled();
  await modelSetDialog.getByRole("button", { name: "Vazgeç" }).click();

  if (clash) {
    await page.getByRole("link", { name: "Çakışma Testleri", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/coordination/tests$`));
    await expect(page.getByText("Henüz çakışma testi yok.")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Yeni Çakışma Testi", exact: true })).toBeDisabled();
  }

  await page.getByRole("link", { name: "Bilgi Gereksinimi Kontrolleri", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/coordination/ids$`));
  await expect(page.getByText("Henüz bilgi gereksinimi kontrolü yok.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kontrol Et" })).toBeDisabled();
});

test("issues page opens and cancels BCF export", async ({ page, seededIssue }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/issues`);

  await expect(page.getByRole("heading", { name: "Sorunlar" })).toBeVisible();
  await expect(page.getByText(seededIssue.title, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "BCF Olarak Dışa Aktar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "BCF Olarak Dışa Aktar" });
  await expect(dialog.getByRole("radio", { name: "BCF 2.1 (En Uyumlu)" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Dışa Aktar" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(dialog).toHaveCount(0);
});
