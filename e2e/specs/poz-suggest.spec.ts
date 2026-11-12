import path from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../support/project-features";
import { uploadServerIfc } from "../support/seed-files";
import { needsModules } from "../support/modules";

needsModules("cost", "planning");

/** A project of its own: other specs' unit prices and rules stay out of the suggestions. */
async function seedProject(request: APIRequestContext, code: string, items: object[]) {
  const res = await request.post("/api/v1/projects", { data: { code, name: `${code} Poz Projesi`, template: "iso19650" } });
  expect(res.ok(), await res.text()).toBe(true);
  const project = (await res.json()) as { id: string; rootFolderId: string };
  await uploadServerIfc(request, project.id, project.rootFolderId, "poz.ifc", "Kaba.ifc");
  for (const data of items) {
    const r = await request.post(`/api/v1/projects/${project.id}/cost-items`, { data });
    expect(r.ok(), await r.text()).toBe(true);
  }
  return project;
}

async function openSuggestions(page: Page, pid: string): Promise<Locator> {
  await page.goto(`/projects/${pid}/quantities`);
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Poz Öner", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Poz Öner" });
  await expect(dialog.getByTestId("poz-row").first()).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test("poz suggestions: review, change, reject, accept into cost rules, learned in the next project", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = Date.now().toString(36).toUpperCase();
  const gazPoz = `18.071.${s}`;
  const A = await seedProject(request, `PZA-${s}`, [
    { code: "BET-C30", description: "C30 hazır beton dökülmesi", unit: "m³", unitPrice: 2500, pozCode: `15.150.${s}` },
    { code: "GAZ-20", description: "20 cm gazbeton duvar yapılması", unit: "m²", unitPrice: 450, pozCode: gazPoz },
    { code: "KAPI-90", description: "Ahşap iç kapı 90x210", unit: "adet", unitPrice: 6000, pozCode: `KAPI.${s}` },
  ]);

  const dialog = await openSuggestions(page, A.id);
  const row = (group: string) => dialog.getByTestId("poz-row").filter({ hasText: group });

  await test.step("keyword suggestions with model quantities", async () => {
    await dialog.getByLabel("Yapay Zekâ ile").uncheck();
    await dialog.getByRole("button", { name: "Yeniden Öner" }).click();
    await expect(dialog.getByText("Yapay zekâ kullanılmadı.")).toBeVisible();
    await expect(dialog.getByTestId("poz-row")).toHaveCount(6);
    const gaz = row("Duvar · Gazbeton Duvar 20");
    await expect(gaz.getByLabel("Duvar · Gazbeton Duvar 20 Pozu")).toHaveValue(/.+/);
    await expect(gaz.locator('td[data-label="Önerilen Poz"] select option:checked')).toHaveText(/GAZ-20/);
    await expect(gaz.locator('td[data-label="Miktar"]')).toContainText("18 m²");
    await expect(gaz.locator('td[data-label="Tutar"]')).toHaveText("8.100 ₺");
    await expect(gaz.getByText("Öneri", { exact: true })).toBeVisible();
    await expect(gaz.getByText("Anahtar Sözcük")).toBeVisible();
    await expect(gaz.getByText(/Tanımda eşleşen sözcükler: .*gazbeton/)).toBeVisible();
    await expect(row("Kapı · KP-90").locator('td[data-label="Tutar"]')).toHaveText("12.000 ₺");
    await dialog.getByText("Önerisiz Gruplar (3)").click();
    await expect(dialog.getByText(/tek bir kuralla ayrılamıyor/)).toBeVisible();
  });

  await test.step("change a poz, reject one, untick two", async () => {
    const perde = row("Duvar · Perde 25");
    await expect(perde.locator('td[data-label="Tutar"]')).toHaveText("12.000 ₺");
    const select = perde.getByLabel("Duvar · Perde 25 Pozu");
    const gazValue = await select.locator("option", { hasText: "GAZ-20" }).getAttribute("value");
    await select.selectOption(gazValue!);
    await expect(perde.getByText("Poz değiştirildi; onaylarsanız bu seçim öğrenilir.")).toBeVisible();
    await expect(perde.locator('td[data-label="Tutar"]')).toHaveText("10.800 ₺");

    await dialog.getByRole("button", { name: "Döşeme · Beton C30 Önerisini Reddet" }).click();
    await expect(dialog.getByText("BET-C30 bu grup için bir daha önerilmeyecek.")).toBeVisible();
    await expect(row("Döşeme · Beton C30")).toHaveCount(0);

    await dialog.getByLabel("Kiriş · Beton C30 Seç").uncheck();
    await dialog.getByLabel("Kolon · Beton C30 Seç").uncheck();
    await expect(dialog.getByText("Seçilenlerin tutarı: 30.900 ₺")).toBeVisible();
  });

  await test.step("accepted rows become cost rules", async () => {
    await dialog.getByRole("button", { name: "Seçilenleri Kurala Çevir (3)" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("3 maliyet kuralı eklendi.")).toBeVisible();
    const again = await openSuggestions(page, A.id);
    await expect(again.getByText("3 grup zaten bir maliyet kuralıyla fiyatlanıyor.")).toBeVisible();
    await expect(again.getByTestId("poz-row").filter({ hasText: "Döşeme" })).toHaveCount(0);
    await again.getByRole("button", { name: "Kapat", exact: true }).last().click();
  });

  const B = await seedProject(request, `PZB-${s}`, [
    { code: "B-DUV", description: "Duvar işleri", unit: "m²", unitPrice: 500, pozCode: gazPoz },
    { code: "B-BET", description: "Beton", unit: "m³", unitPrice: 2600 },
  ]);

  await test.step("the next project gets the learned pairs first", async () => {
    const d = await openSuggestions(page, B.id);
    const first = d.getByTestId("poz-row").first();
    await expect(first.getByText("Öğrenilmiş")).toBeVisible();
    const gaz = d.getByTestId("poz-row").filter({ hasText: "Duvar · Gazbeton Duvar 20" });
    await expect(gaz.getByText("Öğrenilmiş")).toBeVisible();
    await expect(gaz.getByText("Daha önce aynı sınıf, tip ve malzeme için 1 kez onaylandı.")).toBeVisible();
    await expect(gaz.locator('td[data-label="Tutar"]')).toHaveText("9.000 ₺");
    // The changed choice was learned too: Perde 25 → the gazbeton poz, not the keyword match.
    await expect(d.getByTestId("poz-row").filter({ hasText: "Duvar · Perde 25" }).getByText("Öğrenilmiş")).toBeVisible();
    await d.getByRole("button", { name: /^Seçilenleri Kurala Çevir/ }).click();
    await expect(page.getByText(/maliyet kuralı eklendi\./)).toBeVisible();
  });

  await test.step("5D dialog: rules, Poz Öner button and learned mappings", async () => {
    await page.goto(`/projects/${B.id}/schedule`);
    await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
    const imp = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
    await imp.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, "../fixtures/tiny-schedule.csv"));
    await expect(imp.getByText("2 faaliyet")).toBeVisible();
    await imp.getByRole("button", { name: "İçe Aktar", exact: true }).click();
    await expect(imp).toHaveCount(0);
    await page.getByRole("button", { name: "Diğer", exact: true }).click();
    await page.getByRole("menuitem", { name: "Maliyet (5D)" }).click();
    const cost = page.getByRole("dialog", { name: "Maliyet (5D)" });
    await cost.getByRole("tab", { name: "Maliyet Kuralları" }).click();
    await expect(cost.locator(".sim-rule-row").filter({ hasText: "Gazbeton Duvar 20" })).toContainText("B-DUV");
    await expect(cost.getByRole("button", { name: "Poz Öner" })).toBeEnabled();

    await cost.getByRole("tab", { name: "Öğrenilen Eşlemeler" }).click();
    const learned = cost.locator("table tbody tr");
    const gazRow = learned.filter({ hasText: "Gazbeton Duvar 20" }).filter({ hasText: gazPoz });
    await expect(gazRow.locator('td[data-label="Onay Sayısı"]')).toHaveText("2");
    await expect(gazRow.getByText("Onaylandı")).toBeVisible();
    await expect(learned.filter({ hasText: "Döşeme" }).filter({ hasText: `15.150.${s}` }).getByText("Reddedildi")).toBeVisible();
    await gazRow.getByRole("button", { name: `${gazPoz} Eşlemesini Sil` }).click();
    const confirm = page.getByRole("dialog", { name: "Eşlemeyi Sil" });
    await confirm.getByRole("button", { name: "Sil", exact: true }).click();
    await expect(gazRow).toHaveCount(0);
  });
});
