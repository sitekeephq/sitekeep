import path from "node:path";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { moduleInstalled, needsModules } from "../support/modules";

async function expectJson<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

async function closeDialog(page: Page, name: string | RegExp, closeName = "Kapat") {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await assertNoSidewaysScroll(page);
  const inActions = dialog.locator(".dialog-actions").getByRole("button", { name: closeName });
  await (await inActions.count() ? inActions : dialog.getByLabel("Kapat")).click();
  await expect(dialog).toBeHidden();
}

async function seedTemplate(request: APIRequestContext, projectId: string, name: string) {
  return expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/form-templates`, {
      data: {
        code: `E2E${Date.now().toString(36).toUpperCase()}`,
        name,
        schema: {
          sections: [
            {
              id: "details",
              title: "Kontrol Bilgileri",
              items: [{ id: "note", type: "text", label: "Saha notu", required: true }],
            },
          ],
        },
      },
    }),
    "form template seed",
  );
}

async function seedReview(request: APIRequestContext, projectId: string, rootFolderId: string, name: string) {
  const me = await expectJson<{ id: string }>(await request.get("/api/v1/auth/me"), "current-user lookup");
  const fileName = `e2e-mobile-review-${Date.now().toString(36)}.txt`;
  await expectJson(
    await request.post(`/api/v1/projects/${projectId}/folders/${rootFolderId}/files`, {
      multipart: {
        file: { name: fileName, mimeType: "text/plain", buffer: Buffer.from("E2E mobile review\n", "utf8") },
      },
    }),
    "review document upload",
  );
  const contents = await expectJson<{ files: Array<{ name: string; latest: { id: string } }> }>(
    await request.get(`/api/v1/projects/${projectId}/folders/${rootFolderId}/contents`),
    "uploaded document lookup",
  );
  const versionId = contents.files.find((file) => file.name === fileName)?.latest.id;
  if (!versionId) throw new Error(`Uploaded review document ${fileName} was not listed.`);

  const workflow = await expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/workflow-templates`, {
      data: {
        kind: "review",
        name: `${name} workflow`,
        steps: [
          {
            name: "E2E approval",
            assignees: [{ type: "user", id: me.id }],
            rule: "any",
            days: 3,
            outcomes: ["approved", "approved_with_comments", "revise_resubmit"],
          },
        ],
      },
    }),
    "review workflow seed",
  );

  return expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/reviews`, {
      data: { name, templateId: workflow.id, versionIds: [versionId], note: "Mobile filled smoke." },
    }),
    "review seed",
  );
}

test("iPhone form create dialog and filled form stay usable", async ({ page, request, diagnostics }) => {
  needsModules("field");
  void diagnostics;
  const { project } = await runState();
  const templateName = `E2E Mobile Form ${Date.now().toString(36)}`;
  const value = `Mobil saha notu ${Date.now().toString(36)}`;
  const template = await seedTemplate(request, project.id, templateName);

  await page.goto(`/projects/${project.id}/forms`);
  await expect(page.getByRole("button", { name: "+ Yeni Form" })).toBeEnabled();
  await page.getByRole("button", { name: "Şablonlar" }).click();
  // The template card; "Benzer Şablonlar" may list the name too (earlier runs' similar templates).
  await expect(page.locator(".grid-cards .card").getByText(templateName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Formlar", exact: true }).click();

  await page.getByRole("button", { name: "+ Yeni Form" }).click();
  const create = page.getByRole("dialog", { name: "Yeni Form" });
  await expect(create).toBeVisible();
  await create.locator("select").first().selectOption(template.id);
  await assertNoSidewaysScroll(page);
  await create.getByRole("button", { name: "Oluştur" }).click();

  await expect(page.getByRole("heading", { name: templateName })).toBeVisible();
  const field = page.locator(".form-item").filter({ hasText: "Saha notu" }).locator("input");
  await field.fill(value);
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(page.getByText("Kaydedildi.", { exact: true })).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone seeded review card opens its actions", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(45_000);
  const { project } = await runState();
  const name = `E2E Mobile Review ${Date.now().toString(36)}`;
  const review = await seedReview(request, project.id, project.rootFolderId, name);

  await page.goto(`/projects/${project.id}/reviews`);
  const card = page.getByRole("list", { name: "İncelemeler" }).getByRole("button").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByText("Sıra Sizde", { exact: true })).toBeVisible();
  await card.click();

  await expect(page).toHaveURL(`/projects/${project.id}/reviews/${review.id}`);
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adımı Gönder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "İptal Et" })).toBeVisible();
  await page.getByRole("button", { name: "Atananları Değiştir" }).click();
  await closeDialog(page, /Atananları Değiştir/);
});

test("iPhone BCF export opens from Diğer with a seeded issue", async ({ page, request, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const title = `E2E Mobile BCF ${Date.now().toString(36)}`;
  const created = await request.post(`/api/v1/projects/${project.id}/issues`, { data: { title, priority: "normal" } });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/projects/${project.id}/issues`);
  await expect(page.getByRole("list", { name: "Sorunlar" }).getByText(title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "BCF Olarak Dışa Aktar" }).click();
  const dialog = page.getByRole("dialog", { name: "BCF Olarak Dışa Aktar" });
  await expect(dialog.getByRole("radio", { name: "BCF 2.1 (En Uyumlu)" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Dışa Aktar" })).toBeEnabled();
  await closeDialog(page, "BCF Olarak Dışa Aktar", "Vazgeç");
});

test("iPhone correspondence create and letter dialog stay tappable", async ({ page, diagnostics }) => {
  needsModules("manage");
  void diagnostics;
  const { project } = await runState();
  const title = `E2E Mobile yazı ${Date.now().toString(36)}`;

  await page.goto(`/projects/${project.id}/works`);
  await expect(page.getByRole("combobox", { name: "Görünümler" })).toBeVisible();
  await page.getByRole("button", { name: "Görünümü Kaydet" }).click();
  await closeDialog(page, "Görünümü Kaydet", "Vazgeç");

  await page.getByRole("button", { name: "+ Yeni" }).click();
  await page.getByRole("dialog", { name: "Ne Yapmak İstiyorsunuz?" }).getByText("Giden Yazı", { exact: true }).click();
  const create = page.getByRole("dialog", { name: "Yeni Giden Yazı" });
  await create.locator("input").first().fill(title);
  await assertNoSidewaysScroll(page);
  await create.getByRole("button", { name: "Kaydet" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "Yazıyı Düzenle" }).click();
  await closeDialog(page, /Yazı$/, "Vazgeç");
  await page.getByRole("button", { name: "Kapat" }).click();
  await expect(page.getByRole("list", { name: "İşler" }).getByText(title, { exact: true })).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone schedule Özet, S-eğrisi and 5D dialogs open after CSV import", async ({ page, diagnostics }) => {
  needsModules("planning", "cost");
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const fixture = path.resolve(__dirname, "../fixtures/tiny-schedule.csv");

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
  await importDialog.locator('input[type="file"]').setInputFiles(fixture);
  await expect(importDialog.getByText("2 faaliyet")).toBeVisible();
  await importDialog.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  await expect(importDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "İşlemler" })).toBeVisible();

  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Özet" }).click();
  const summary = page.getByRole("dialog", { name: /Durum Özeti/ });
  await expect(summary.getByRole("heading", { name: "Hesaplanan Bulgular" })).toBeVisible({ timeout: 20_000 });
  await closeDialog(page, /Durum Özeti/);

  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "S-eğrisi" }).click();
  await expect(page.getByRole("dialog", { name: /S-eğrisi/ }).locator("svg")).toBeVisible();
  await closeDialog(page, /S-eğrisi/);

  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Maliyet (5D)" }).click();
  const cost = page.getByRole("dialog", { name: "Maliyet (5D)" });
  await expect(cost.getByRole("tab", { name: "Özet" })).toBeVisible();
  await cost.getByRole("tab", { name: "Birim Fiyatlar" }).click();
  await cost.getByRole("button", { name: "Birim Fiyat Listesi İçe Aktar" }).click();
  await closeDialog(page, "Birim Fiyat Listesi İçe Aktar");
  await closeDialog(page, "Maliyet (5D)");
});

test("iPhone folder permissions and who-can-see dialogs stay usable", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/files`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Yetkiler" }).click();
  const perms = page.getByRole("dialog", { name: /Yetkiler/ });
  await expect(perms.getByRole("heading", { name: "Yetki Ekle" })).toBeVisible();
  await expect(perms.getByRole("button", { name: "Ekle" })).toBeDisabled();
  await assertNoSidewaysScroll(page);
  await perms.getByRole("button", { name: "Kim Görebilir?" }).click();
  await closeDialog(page, /Kim Görebilir/);
  await closeDialog(page, /Yetkiler/);
});

test("iPhone start-review, folder settings, BCF import and location CSV stay usable", async ({ page, request, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const me = await expectJson<{ id: string }>(await request.get("/api/v1/auth/me"), "me");
  await expectJson(
    await request.post(`/api/v1/projects/${project.id}/workflow-templates`, {
      data: {
        kind: "review",
        name: `E2E mobile flow ${Date.now().toString(36)}`,
        steps: [
          {
            name: "Onay",
            assignees: [{ type: "user", id: me.id }],
            rule: "any",
            days: 3,
            outcomes: ["approved", "revise_resubmit"],
          },
        ],
      },
    }),
    "review template",
  );
  const fileName = `e2e-review-start-${Date.now().toString(36)}.txt`;
  await expectJson(
    await request.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
      multipart: {
        file: { name: fileName, mimeType: "text/plain", buffer: Buffer.from("review start\n", "utf8") },
      },
    }),
    "review file",
  );

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.getByRole("button", { name: fileName })).toBeVisible();
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Seç" }).click();
  await page.getByRole("checkbox", { name: `${fileName} seç` }).check();
  await page.getByRole("button", { name: "İnceleme Başlat (1)" }).click();
  const review = page.getByRole("dialog", { name: "İnceleme Başlat" });
  await expect(review.getByText(fileName, { exact: false })).toBeVisible();
  await expect(review.getByRole("button", { name: "Başlat" })).toBeEnabled();
  await closeDialog(page, "İnceleme Başlat", "Vazgeç");

  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Klasör Ayarları" }).click();
  const settings = page.getByRole("dialog", { name: "Klasör Ayarları" });
  await expect(settings.locator("input").first()).toBeVisible();
  await closeDialog(page, "Klasör Ayarları", "Vazgeç");

  await page.goto(`/projects/${project.id}/issues`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "BCF İçe Aktar" }).click();
  await expect(page.getByRole("dialog", { name: "BCF İçe Aktar" }).locator('input[type="file"]')).toBeVisible();
  await closeDialog(page, "BCF İçe Aktar", "Vazgeç");

  await page.goto(`/projects/${project.id}/locations`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "CSV İçe Aktar" }).click();
  const locStamp = Date.now().toString(36);
  const locName = `E2E Saha ${locStamp}`;
  const csv = page.getByRole("dialog", { name: "CSV'den Konum İçe Aktar" });
  await csv.locator("textarea").fill(`Kod;Ad;Tip;Üst kod;Km başlangıç;Km bitiş\nE2E-${locStamp};${locName};Saha;;;\n`);
  await csv.getByRole("button", { name: "İçe Aktar" }).click();
  await expect(csv.getByText(/konum eklendi/)).toBeVisible();
  await closeDialog(page, "CSV'den Konum İçe Aktar");
  await expect(page.getByText(locName)).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone project-settings create dialogs stay usable", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const base = `/projects/${project.id}/settings`;

  await page.goto(`${base}?sekme=roller`);
  await page.getByRole("checkbox", { name: "Gelişmiş Ayarları Göster" }).check();
  await page.getByRole("button", { name: "+ Rol" }).click();
  await closeDialog(page, "Yeni Rol", "Vazgeç");
  await page.getByRole("button", { name: "Firmaya Rol Paketi Uygula" }).click();
  await closeDialog(page, "Firmaya Rol Paketi Uygula", "Vazgeç");

  await page.goto(`${base}?sekme=is-akislari`);
  await page.getByRole("button", { name: "+ Şablon" }).click();
  await closeDialog(page, "Yeni Onay Akışı Şablonu", "Vazgeç");

  await page.goto(`${base}?sekme=is-tipleri`);
  await page.getByRole("button", { name: "+ Yeni Tip" }).click();
  await closeDialog(page, "Yeni İş Tipi", "Vazgeç");

  await page.goto(`${base}?sekme=isimlendirme`);
  await page.getByRole("button", { name: "+ Standart" }).click();
  await closeDialog(page, "Yeni İsimlendirme Standardı", "Vazgeç");

  await page.goto(`${base}?sekme=oznitelikler`);
  await page.getByRole("button", { name: "+ Öznitelik" }).click();
  await closeDialog(page, "Yeni Öznitelik", "Vazgeç");

  // The Yapay Zekâ tab is the AI module's.
  if (moduleInstalled("ai")) {
    await page.goto(`${base}?sekme=yapay-zeka`);
    await expect(page.getByRole("heading", { name: "Kendi API Anahtarlarım" })).toBeVisible();
    await assertNoSidewaysScroll(page);
  }

  // The old Autodesk tab opens Forma Eşitleme, the Connect module's page.
  if (moduleInstalled("connect")) {
    await page.goto(`${base}?sekme=autodesk`);
    await expect(page.getByText(/AUTODESK_CLIENT_ID ve AUTODESK_CALLBACK_URL/)).toBeVisible();
    await assertNoSidewaysScroll(page);
  }

  await page.goto(`${base}?sekme=moduller`);
  await expect(page.getByText("Dokümanlar her zaman açıktır.", { exact: false })).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone admin OAuth and AI provider dialogs stay usable", async ({ page, diagnostics }) => {
  void diagnostics;
  await page.goto("/administration");
  await page.getByRole("button", { name: "OAuth Uygulamaları", exact: true }).click();
  await page.getByRole("button", { name: "+ Uygulama" }).click();
  const oauth = page.getByRole("dialog", { name: "Yeni OAuth Uygulaması" });
  await expect(oauth.getByText("Yönlendirme Adresleri", { exact: false })).toBeVisible();
  await closeDialog(page, "Yeni OAuth Uygulaması", "Vazgeç");

  // "Yapay Zekâ ve MCP" is the AI module's tab.
  if (moduleInstalled("ai")) {
    await page.getByRole("button", { name: "Yapay Zekâ ve MCP", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Yapay Zekâ Modu" })).toBeVisible();
    await page.locator("select").filter({ has: page.getByRole("option", { name: "Ollama" }) }).selectOption({ label: "Ollama" });
    const provider = page.getByRole("dialog", { name: /Yeni Sağlayıcı: Ollama/ });
    await expect(provider.getByText("Veri nerede işlenir", { exact: false })).toBeVisible();
    await closeDialog(page, /Yeni Sağlayıcı: Ollama/, "Vazgeç");
  }
});

test("iPhone form-template and reports AI boundary stay usable", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();

  // Form templates are the Field module's.
  if (moduleInstalled("field")) {
    await page.goto(`/projects/${project.id}/forms`);
    await page.getByRole("button", { name: "Şablonlar" }).click();
    await page.getByRole("button", { name: "Hazır Şablonlar" }).click();
    await closeDialog(page, "Hazır Şablonlar");
    await page.getByRole("button", { name: "+ Boş Şablon" }).click();
    await closeDialog(page, "Yeni Form Şablonu", "Vazgeç");
  }

  await page.goto(`/projects/${project.id}/reports`);
  await expect(page.getByRole("button", { name: "Yapay Zekâ ile Oluştur" })).toBeDisabled();
  await expect(page.getByText(/Yapay zekâ yapılandırılmamış/)).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone new-user dialog stays submittable", async ({ page, diagnostics }) => {
  void diagnostics;
  await page.goto("/administration");
  await page.getByRole("button", { name: "+ Kullanıcı" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Kullanıcı" });
  await expect(dialog.getByText("Ad Soyad")).toBeVisible();
  await expect(dialog.locator('input[type="email"]')).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Oluştur" })).toBeEnabled();
  await closeDialog(page, "Yeni Kullanıcı", "Vazgeç");
});
