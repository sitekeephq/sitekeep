import { expect, runState, test } from "../support/project-features";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { moduleInstalled } from "../support/modules";
import { E2E_FIXTURES, uploadProjectFile } from "../support/seed-files";

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

test("creates an issue without a model, with a linked document, and deletes it", async ({ page }) => {
  const { project } = await runState();
  const docName = `e2e-issue-doc-${Date.now()}.pdf`;
  await uploadProjectFile(page.request, project.id, project.rootFolderId, docName, await readFile(path.join(E2E_FIXTURES, "tiny.pdf")), "application/pdf");
  await page.goto(`/projects/${project.id}/issues`);

  await page.getByRole("button", { name: "+ Yeni Sorun", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Sorun" });
  await expect(dialog.getByRole("button", { name: "Oluştur" })).toBeDisabled();
  await dialog.getByLabel("Başlık").fill("E2E dokümandan sorun");
  await dialog.getByLabel("Açıklama").fill("Kesit ile plan uyuşmuyor.");
  await dialog.getByLabel("Öncelik").selectOption("high");
  await dialog.getByLabel("Termin").fill("2027-01-15");

  await dialog.getByRole("button", { name: "Doküman Bağla" }).click();
  const picker = page.getByRole("dialog", { name: "Dosya Versiyonu Ekle" });
  await picker.getByPlaceholder("Dosya adı veya öznitelik ara…").fill(docName);
  await picker.getByRole("row", { name: new RegExp(docName.replace(/\./g, "\\.")) }).click();
  await picker.getByRole("button", { name: "Ekle" }).click();
  await expect(dialog.getByTestId("new-issue-doc")).toContainText(docName);

  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/issues/[0-9a-f-]{36}`));
  const detail = page.locator("aside.panel.right");
  await expect(detail.getByRole("heading", { name: "E2E dokümandan sorun" })).toBeVisible();
  await expect(detail.getByRole("link", { name: docName })).toBeVisible();
  await expect(page.getByRole("row", { name: /E2E dokümandan sorun/ })).toBeVisible();

  await detail.getByRole("button", { name: "Sorunu Sil" }).click();
  const confirm = page.getByRole("dialog", { name: "Sorunu Sil" });
  await confirm.getByRole("button", { name: "Sil" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/issues$`));
  await expect(page.getByRole("row", { name: /E2E dokümandan sorun/ })).toHaveCount(0);
});
