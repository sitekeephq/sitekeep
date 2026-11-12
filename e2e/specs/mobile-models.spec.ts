import { readFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { moduleInstalled, needsModules } from "../support/modules";
import { generateSiteIfc } from "../support/site-ifc";
import { E2E_FIXTURES, uploadIfcBuffer, uploadProjectFile, uploadServerIfc } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

async function selectOptionContaining(select: ReturnType<Page["locator"]>, text: string) {
  const option = select.locator("option").filter({ hasText: text }).first();
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`no select option containing ${text}`);
  await select.selectOption(value);
}

async function closeDialog(page: Page, name: string | RegExp, closeName = "Kapat") {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await assertNoSidewaysScroll(page);
  const inActions = dialog.locator(".dialog-actions").getByRole("button", { name: closeName });
  await ((await inActions.count()) ? inActions : dialog.getByLabel("Kapat")).click();
  await expect(dialog).toBeHidden();
}

async function importTinySchedule(page: Page, projectId: string) {
  const fixture = path.resolve(E2E_FIXTURES, "tiny-schedule.csv");
  await page.goto(`/projects/${projectId}/schedule`);
  await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
  await dialog.locator('input[type="file"]').setInputFiles(fixture);
  await dialog.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return page.getByRole("combobox", { name: "İş programı" }).inputValue();
}

async function createModelSet(
  request: APIRequestContext,
  projectId: string,
  name: string,
  fileIds: string[],
): Promise<{ id: string }> {
  const response = await request.post(`/api/v1/projects/${projectId}/model-sets`, {
    data: { name, items: fileIds.map((fileId) => ({ fileId, versionId: null })) },
  });
  if (!response.ok()) throw new Error(`model set failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

test("iPhone PDF viewer opens a page and the version-issue dialog", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(45_000);
  const { project } = await runState();
  const name = `e2e-mobile-${Date.now().toString(36)}.pdf`;
  const data = await readFile(path.join(E2E_FIXTURES, "tiny.pdf"));
  const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, name, data, "application/pdf");
  const file = await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json();
  const markup = await request.post(`/api/v1/projects/${project.id}/versions/${file.latest.id}/markups`, {
    data: { page: 1, shapes: [{ type: "rect", color: "#d92d20", width: 2, from: [20, 20], to: [80, 50] }] },
  });
  if (!markup.ok()) throw new Error(`markup seed failed (${markup.status()}): ${await markup.text()}`);

  await page.goto(`/projects/${project.id}/view/${file.latest.id}`);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Kalem/ })).toBeEnabled();
  await page.getByRole("button", { name: /Kalem/ }).click();
  await expect(page.locator(".pdf-toolbar .tool.active")).toContainText("Kalem");
  await expect(page.getByRole("button", { name: "Ayrıntılar" })).toBeVisible();
  await page.getByRole("button", { name: "Ayrıntılar" }).click();
  const sheet = page.getByRole("complementary", { name: "Ayrıntılar" });
  await expect(sheet.getByText(name, { exact: false })).toBeVisible();
  await sheet.locator(".model-item").filter({ hasText: "Dikdörtgen" }).click();
  await expect(sheet.getByText("Seçili İşaretleme")).toBeVisible();
  await sheet.getByRole("button", { name: /Sorun Oluştur/ }).click();
  await closeDialog(page, "İşaretlemeden Sorun Oluştur", "Vazgeç");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "+ Versiyona Sorun" }).click();
  await closeDialog(page, "Versiyona Sorun Oluştur", "Vazgeç");
  await assertNoSidewaysScroll(page);
});

test("iPhone DXF viewer loads the drawing tools", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const name = `e2e-mobile-${Date.now().toString(36)}.dxf`;
  const data = await readFile(path.join(E2E_FIXTURES, "tiny.dxf"));
  const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, name, data, "image/vnd.dxf");
  const file = await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json();

  await page.goto(`/projects/${project.id}/open/${file.latest.id}`);
  await expect(page.getByRole("button", { name: /Sığdır/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Çizim yükleniyor…")).toHaveCount(0);
  await page.getByRole("button", { name: "Diğer" }).click();
  await expect(page.getByRole("menuitem", { name: "Tümünü Göster" })).toBeVisible();
  await page.keyboard.press("Escape");
  await assertNoSidewaysScroll(page);
});

test("iPhone IFC viewer loads a fixture and opens the 4D bar", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(120_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const ifc = await uploadServerIfc(request, project.id, project.rootFolderId, "sample-wall.ifc", `e2e-wall-${stamp}.ifc`);
  // The programme and the viewer's 4D bar are the Planning module's.
  const fourD = moduleInstalled("planning");
  const scheduleId = fourD ? await importTinySchedule(page, project.id) : null;

  await page.goto(`/projects/${project.id}/files`);
  await page.getByRole("button", { name: ifc.name }).click();
  await expect(page.getByRole("heading", { name: "IFC Özeti" })).toBeVisible();
  await expect(page.getByText("Ornek Proje")).toBeVisible();

  await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}${fourD ? `&takvim=1&program=${scheduleId}` : ""}`);
  await expect(page.getByRole("button", { name: /Sığdır/ })).toBeEnabled({ timeout: 90_000 });
  if (fourD) {
    const panel = page.locator('[aria-label="4D / 5D simülasyon"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Bağlı eleman yok", { exact: false })).toBeVisible();
    // The panel starts collapsed; its tools are under Ayrıntılar.
    await panel.getByRole("button", { name: "Ayrıntıları Göster" }).click();
    await panel.getByRole("button", { name: "Bağlantı Kuralları" }).click();
    await closeDialog(page, "Bağlantı Kuralları");
  }
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: /Görünümden Sorun/ }).click();
  await closeDialog(page, "Yeni Sorun", "Vazgeç");
  const ask = page.getByRole("button", { name: /Modele Sor/ });
  await expect(ask).toBeEnabled();
  await ask.click();
  await expect(ask).toHaveCSS("background-color", "rgb(11, 107, 203)");
  await expect(ask).toHaveCSS("color", "rgb(255, 255, 255)");
  await ask.click();
  await assertNoSidewaysScroll(page);
});

test("iPhone clash test dialog and a fixture run stay usable", async ({ page, request, diagnostics }) => {
  needsModules("coordinate");
  void diagnostics;
  test.setTimeout(180_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const arch = await uploadServerIfc(request, project.id, project.rootFolderId, "coord-arch.ifc", `e2e-arch-${stamp}.ifc`);
  const mep = await uploadServerIfc(request, project.id, project.rootFolderId, "coord-mep.ifc", `e2e-mep-${stamp}.ifc`);
  await createModelSet(request, project.id, `E2E set ${stamp}`, [arch.fileId, mep.fileId]);

  await page.goto(`/projects/${project.id}/coordination/tests`);
  await expect(page.getByRole("button", { name: "+ Yeni Çakışma Testi" })).toBeEnabled();
  await page.getByRole("button", { name: "+ Yeni Çakışma Testi" }).click();
  const create = page.getByRole("dialog", { name: "Yeni Çakışma Testi" });
  await create.locator("input").first().fill(`E2E sert ${stamp}`);
  await expect(create.getByRole("button", { name: "Kaydet" })).toBeEnabled();
  await assertNoSidewaysScroll(page);
  await create.getByRole("button", { name: "Kaydet" }).click();
  await expect(create).toHaveCount(0);

  const row = page.getByRole("row").filter({ hasText: `E2E sert ${stamp}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "▶ Çalıştır" }).click();
  await expect(row.getByText("Tamamlandı")).toBeVisible({ timeout: 120_000 });
  await row.locator(".pc-title").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/coordination/tests/`));
  await assertNoSidewaysScroll(page);
});

test("iPhone IDS check, IFC locations and param-change dialogs stay usable", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(120_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const ifc = await uploadServerIfc(request, project.id, project.rootFolderId, "sample-wall.ifc", `e2e-ids-${stamp}.ifc`);
  const idsName = `e2e-req-${stamp}.ids`;
  const idsXml = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>E2E IDS</title></info>
  <specifications>
    <specification name="Duvar adı" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <attribute cardinality="required">
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>
`;
  await uploadProjectFile(
    request,
    project.id,
    project.rootFolderId,
    idsName,
    Buffer.from(idsXml, "utf8"),
    "application/xml",
  );

  await page.goto(`/projects/${project.id}/coordination/ids`);
  const idsForm = page.locator(".card.row.wrap").first();
  await selectOptionContaining(idsForm.locator("select").nth(0), idsName);
  await selectOptionContaining(idsForm.locator("select").nth(1), ifc.name);
  await expect(page.getByRole("button", { name: "Kontrol Et" })).toBeEnabled();
  await page.getByRole("button", { name: "Kontrol Et" }).click();
  await expect(page.getByText("Tamamlandı")).toBeVisible({ timeout: 60_000 });
  await assertNoSidewaysScroll(page);

  await page.goto(`/projects/${project.id}/locations`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "IFC'den Oluştur" }).click();
  const ifcLoc = page.getByRole("dialog", { name: "IFC'den Konum Oluştur" });
  await selectOptionContaining(ifcLoc.locator("select").first(), ifc.name);
  await expect(ifcLoc.getByRole("button", { name: "Oluştur" })).toBeEnabled();
  await ifcLoc.getByRole("button", { name: "Oluştur" }).click();
  await expect(ifcLoc.getByText(/Tamamlandı|IFC okunuyor|Sırada/)).toBeVisible({ timeout: 30_000 });
  await expect(ifcLoc.getByText(/Tamamlandı/)).toBeVisible({ timeout: 60_000 });
  await closeDialog(page, "IFC'den Konum Oluştur");

  // Parameter change requests are the Coordinate module's.
  if (!moduleInstalled("coordinate")) return;
  await page.goto(`/projects/${project.id}/param-changes`);
  await page.getByRole("button", { name: "+ Yeni Değişiklik Talebi" }).click();
  const param = page.getByRole("dialog", { name: "Yeni Değişiklik Talebi" });
  const modelSelect = param.locator("select").first();
  await expect(modelSelect.locator("option").filter({ hasText: ifc.name })).toHaveCount(1);
  await selectOptionContaining(modelSelect, ifc.name);
  await expect(param.getByRole("button", { name: "Sorgudan" })).toBeVisible();
  await expect(param.getByRole("button", { name: "Önizle" })).toBeVisible();
  await expect(param.getByText("Model sözlüğü yükleniyor…")).toHaveCount(0);
  await closeDialog(page, "Yeni Değişiklik Talebi");
});

test("iPhone site IFC converts and loads in the viewer", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(180_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const site = generateSiteIfc(12, 16);
  const ifc = await uploadIfcBuffer(
    request,
    project.id,
    project.rootFolderId,
    `e2e-site-${stamp}.ifc`,
    Buffer.from(site.text, "utf8"),
  );

  await page.goto(`/projects/${project.id}/files`);
  await page.getByRole("button", { name: ifc.name }).click();
  const summary = page.locator(".card").filter({ has: page.getByRole("heading", { name: "IFC Özeti" }) });
  await expect(summary.getByText("E2E Saha", { exact: false })).toBeVisible();
  await expect(summary.getByText(new RegExp(`(Wall|IFCWALL) ${site.walls}`))).toBeVisible();

  await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}`);
  await expect(page.getByRole("button", { name: /Sığdır/ })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: /Modeller/ }).click();
  const sheet = page.getByRole("complementary", { name: "Modeller" });
  await expect(sheet.getByText(ifc.name, { exact: false })).toBeVisible();
  await sheet.getByRole("button", { name: "Tamam" }).click();
  await assertNoSidewaysScroll(page);
});
