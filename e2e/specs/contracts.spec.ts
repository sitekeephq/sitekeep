import { expect, runState, test } from "../support/project-features";

test("contract card, unit price schedule, period payment approval, exports, variation, guarantee and delete", async ({
  page,
  allowApiFailure,
}) => {
  test.setTimeout(90_000);
  const { project } = await runState();
  const code = `SZ-${Date.now().toString(36).toUpperCase()}`;

  await page.goto(`/projects/${project.id}/today`);
  await page.getByRole("link", { name: "Sözleşme ve Hakediş" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/contracts$`));
  await expect(page.getByRole("heading", { name: "Sözleşme ve Hakediş Yönetimi" })).toBeVisible();
  await expect(page.getByText("Bu projede henüz sözleşme oluşturulmamış.")).toBeVisible();

  await test.step("create the contract card", async () => {
    await page.getByRole("button", { name: "+ Yeni Sözleşme" }).click();
    const dialog = page.getByRole("dialog", { name: "Yeni Sözleşme" });
    await dialog.getByLabel("Sözleşme Kodu", { exact: true }).fill(code);
    await dialog.getByLabel("Sözleşme Adı", { exact: true }).fill("Kaba İnşaat Yapım İşi");
    await dialog.getByLabel("İşveren / İdare", { exact: true }).fill("E2E İdare");
    await dialog.getByLabel("Yüklenici Firma", { exact: true }).fill("E2E Yapı A.Ş.");
    await dialog.getByLabel("Danışman", { exact: true }).fill("E2E Müşavirlik");
    await dialog.getByLabel("Sorumlu Kişi", { exact: true }).fill("E2E Şefi");
    await expect(dialog.getByLabel("SGK Kesintisi (%)")).toHaveValue("0");
    await expect(dialog.getByLabel("KDV Tevkifatı (X/10)")).toHaveValue("4");
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: new RegExp(`${code} — Kaba İnşaat Yapım İşi`) })).toBeVisible();
    await expect(page.getByRole("row", { name: "Danışman" })).toContainText("E2E Müşavirlik");
    await expect(page.getByRole("row", { name: "Sorumlu Kişi" })).toContainText("E2E Şefi");
    await expect(page.getByRole("heading", { name: "Sözleşme Belgeleri" })).toBeVisible();
    await expect(page.getByLabel("Belge ara (en az 2 karakter)")).toBeVisible();
  });

  await test.step("add a unit price item", async () => {
    await page.getByRole("link", { name: "Birim Fiyat Cetveli" }).click();
    await expect(page.getByText(/Henüz birim fiyat kalemi yok/)).toBeVisible();
    await page.getByRole("button", { name: "+ Kalem Ekle" }).click();
    const dialog = page.getByRole("dialog", { name: "+ Kalem Ekle" });
    await dialog.getByLabel("Poz No").fill("B-01");
    await dialog.getByLabel("İmalat Tanımı").fill("C30/37 Hazır Beton");
    await dialog.getByLabel("Birim", { exact: true }).selectOption("m³");
    await dialog.getByLabel("Birim Fiyat").fill("2500");
    await dialog.getByLabel("Sözleşme Miktarı").fill("1000");
    await dialog.getByLabel("Götürü Ağırlık (%)").fill("25");
    await dialog.getByLabel("İş Programı Aktivitesi").fill("A-10");
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByRole("row").filter({ hasText: "B-01" });
    await expect(row).toContainText("C30/37 Hazır Beton");
    await expect(row).toContainText("Ağırlık %25");
    await expect(row).toContainText("A-10");
    await expect(row).toContainText("2.500.000,00 TRY");
    await expect(page.locator(".metric").filter({ hasText: "Güncel Sözleşme Bedeli" })).toContainText("2.500.000,00 TRY");
  });

  await test.step("create, fill, submit and approve progress payment #1", async () => {
    await page.getByRole("link", { name: "Dönem Hakedişleri" }).click();
    await page.getByRole("button", { name: "+ Yeni Hakediş Oluştur" }).click();
    const dialog = page.getByRole("dialog", { name: "+ Yeni Hakediş Oluştur" });
    await dialog.getByLabel("Dönem Başı").fill("2026-01-20");
    await dialog.getByLabel("Dönem Sonu").fill("2026-02-28");
    await dialog.getByRole("button", { name: "Oluştur" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByRole("heading", { name: /#1 — Hakediş #1/ })).toBeVisible();
    await page.getByLabel("B-01 Bu Dönem Miktar").fill("300");
    await page.getByLabel("B-01 Metraj Kaynağı / Ataşman").fill("A Blok Temel");
    await page.getByLabel("B-01 Satır Yorumu").fill("Ataşman kontrol");
    await expect(page.getByRole("row").filter({ hasText: "B-01" })).toContainText("300 × 2.500,00 TRY");
    await page.getByLabel("Ceza / Nefaset Kesintisi").fill("1000");
    await page.getByRole("button", { name: "Miktar ve Kesintileri Kaydet" }).click();
    await expect(page.getByText("Hakediş kaydedildi.")).toBeVisible();
    const totals = page.getByRole("row").filter({ hasText: "Bu Dönem İmalat" }).last();
    await expect(totals).toContainText("750.000,00 TRY");
    await expect(page.getByRole("row").filter({ hasText: "SGK Kesintisi" })).toContainText("0,00 TRY");

    await page.getByRole("button", { name: "Onaya Sun" }).click();
    await expect(page.getByRole("heading", { name: /#1 — Hakediş #1/ })).toContainText("Onaya Sunuldu");
    await expect(page.getByLabel("B-01 Bu Dönem Miktar")).toHaveCount(0);

    await page.getByRole("button", { name: "Hakedişi Onayla" }).click();
    const confirm = page.getByRole("dialog", { name: "Hakedişi Onayla" });
    await confirm.getByRole("button", { name: "Hakedişi Onayla" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /#1 — Hakediş #1/ })).toContainText("Onaylandı");
    await expect(page.locator(".metric").filter({ hasText: "Onaylı Kümülatif İmalat" })).toContainText("750.000,00 TRY");
    await expect(page.locator(".metric").filter({ hasText: "Finansal İlerleme" })).toContainText("30");
  });

  await test.step("download the payment as Excel and PDF", async () => {
    const xlsxHref = await page.getByRole("link", { name: "Excel İndir" }).getAttribute("href");
    const pdfHref = await page.getByRole("link", { name: "PDF İndir" }).getAttribute("href");
    const xlsx = await page.request.get(xlsxHref!);
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 2).toString("utf8")).toBe("PK");
    const pdf = await page.request.get(pdfHref!);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  await test.step("approve a variation with a time extension", async () => {
    await page.getByRole("link", { name: "Zeyilname ve Değişiklikler" }).click();
    await page.getByRole("button", { name: "+ Yeni Zeyilname / Değişiklik" }).click();
    const dialog = page.getByRole("dialog", { name: "+ Yeni Zeyilname / Değişiklik" });
    await dialog.getByLabel("Başlık").fill("Ek Beton ve Süre Uzatımı");
    await dialog.getByLabel("Süre Uzatımı (Gün)").fill("10");
    await dialog.getByRole("button", { name: "+ Kalem Satırı Ekle" }).click();
    await dialog.getByRole("row").nth(1).getByRole("combobox").first().selectOption({ label: "B-01 — C30/37 Hazır Beton" });
    await dialog.getByRole("row").nth(1).getByRole("textbox").last().fill("200");
    await expect(dialog.getByText("Tutar Etkisi: 500.000,00 TRY")).toBeVisible();
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(dialog).toHaveCount(0);

    const row = page.getByRole("row").filter({ hasText: "Ek Beton ve Süre Uzatımı" });
    await expect(row).toContainText("Onay Bekliyor");
    await row.getByRole("button", { name: "Onayla" }).click();
    await page.getByRole("dialog", { name: "Onayla" }).getByRole("button", { name: "Onayla" }).click();
    await expect(row).toContainText("Onaylandı");
    await expect(page.locator(".metric").filter({ hasText: "Güncel Sözleşme Bedeli" })).toContainText("3.000.000,00 TRY");
    await expect(page.locator(".metric").filter({ hasText: "İş Bitim Tarihi" })).toContainText("+10 gün süre uzatımı");
  });

  await test.step("record a guarantee letter", async () => {
    await page.getByRole("link", { name: "Teminat ve Sigortalar" }).click();
    await expect(page.getByText("Kayıtlı teminat mektubu veya sigorta poliçesi yok.")).toBeVisible();
    await page.getByRole("button", { name: "+ Teminat / Poliçe Ekle" }).click();
    const dialog = page.getByRole("dialog", { name: "+ Teminat / Poliçe Ekle" });
    await dialog.getByLabel("Banka / Sigorta Şirketi").fill("E2E Bankası");
    await dialog.getByLabel("Mektup / Poliçe No").fill("TM-1");
    await dialog.getByLabel("Tutar", { exact: true }).fill("150000");
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByRole("row").filter({ hasText: "E2E Bankası" });
    await expect(row).toContainText("Kesin Teminat Mektubu");
    await expect(row).toContainText("150.000,00 TRY");
  });

  await test.step("the contract board shows spent and remaining", async () => {
    await page.getByRole("link", { name: "← Tüm Sözleşmeler" }).click();
    await expect(page.getByRole("heading", { name: "Sözleşme Panosu" })).toBeVisible();
    await expect(page.locator(".metric").filter({ hasText: "Onaylı Kümülatif İmalat" })).toContainText("750.000,00 TRY");
    await expect(page.locator(".metric").filter({ hasText: "Kalan Tutar" })).toContainText("2.250.000,00 TRY");
    await page.getByRole("link", { name: code }).click();
    await expect(page.getByRole("heading", { name: new RegExp(code) })).toBeVisible();
  });

  await test.step("an approved payment keeps the contract until it is cancelled, then delete", async () => {
    allowApiFailure(409, /\/contracts\/[^/]+$/);
    await page.getByRole("link", { name: "Genel ve Mali Şartlar" }).click();
    await expect(page.getByRole("cell", { name: "E2E İdare" })).toBeVisible();
    await page.getByRole("button", { name: "Sil", exact: true }).click();
    let confirm = page.getByRole("dialog", { name: "Sözleşmeyi Sil" });
    await expect(confirm).toContainText(code);
    await confirm.getByRole("button", { name: "Sil" }).click();
    await expect(page.getByText("Onaylanmış hakedişi olan sözleşme silinemez", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/\/contracts\/[^/?]+/);

    const contractId = /\/contracts\/([^/?]+)/.exec(page.url())![1]!;
    expect((await page.request.patch(`/api/v1/projects/${project.id}/contracts/${contractId}`, { data: { status: "cancelled" } })).status()).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: "Sil", exact: true }).click();
    confirm = page.getByRole("dialog", { name: "Sözleşmeyi Sil" });
    await confirm.getByRole("button", { name: "Sil" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/contracts$`));
    await expect(page.getByText("Bu projede henüz sözleşme oluşturulmamış.")).toBeVisible();
  });
});

test("subcontract margin and a new revision of a rejected payment", async ({ page }) => {
  test.setTimeout(60_000);
  const { project } = await runState();
  const base = `/api/v1/projects/${project.id}/contracts`;
  const stamp = Date.now().toString(36).toUpperCase();

  const main = await page.request.post(base, {
    data: { code: `AN-${stamp}`, title: "Ana Sözleşme", employerName: "İdare", contractorName: "Ana Yüklenici" },
  });
  expect(main.status()).toBe(201);
  const mainId = (await main.json()).id as string;

  const mainItem = await page.request.post(`${base}/${mainId}/items`, {
    data: { code: "P-01", description: "Beton", unit: "m3", unitPrice: 1000, contractQuantity: 10 },
  });
  expect(mainItem.status()).toBe(201);
  const parentItemId = (await mainItem.json()).items[0].id as string;

  const sub = await page.request.post(base, {
    data: {
      code: `AL-${stamp}`,
      title: "Alt Yüklenici İşi",
      type: "subcontract",
      employerName: "Ana Yüklenici",
      contractorName: "Alt Yüklenici",
      parentContractId: mainId,
    },
  });
  expect(sub.status()).toBe(201);
  const subId = (await sub.json()).id as string;

  try {
    expect(
      (
        await page.request.post(`${base}/${subId}/items`, {
          data: {
            code: "P-01",
            description: "Beton Alt İmalat",
            unit: "m3",
            unitPrice: 400,
            contractQuantity: 10,
            parentItemId,
          },
        })
      ).status(),
    ).toBe(201);

    const pay = await page.request.post(`${base}/${subId}/payments`, { data: { periodEnd: "2026-04-30" } });
    expect(pay.status()).toBe(201);
    const payId = (await pay.json()).id as string;
    const loaded = await page.request.get(`${base}/${subId}`);
    expect(loaded.status()).toBe(200);
    const lineId = (await loaded.json()).items[0].id as string;
    expect(
      (
        await page.request.patch(`${base}/${subId}/payments/${payId}`, {
          data: { lines: [{ contractItemId: lineId, periodQuantity: 10, objectionNote: "Eksik ataşman" }] },
        })
      ).status(),
    ).toBe(200);
    expect((await page.request.post(`${base}/${subId}/payments/${payId}/submit`, { data: {} })).status()).toBe(200);
    expect((await page.request.post(`${base}/${subId}/payments/${payId}/reject`, { data: {} })).status()).toBe(200);

    await page.goto(`/projects/${project.id}/contracts/${subId}?tab=items`);
    const row = page.getByRole("row").filter({ hasText: "P-01" });
    await expect(row).toContainText("600,00 TRY");
    await expect(row).toContainText("6.000,00 TRY");

    await page.getByRole("link", { name: "Dönem Hakedişleri" }).click();
    await expect(page.getByLabel("P-01 Satır Yorumu")).toHaveValue("Eksik ataşman");
    await page.getByRole("button", { name: "Yeni Revizyon" }).click();
    await expect(page.getByRole("heading", { name: /#1\.2 —/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /#1\.2 —/ })).toContainText("Taslak");
    await expect(page.getByLabel("P-01 Bu Dönem Miktar")).toHaveValue("10");
  } finally {
    await page.request.patch(`${base}/${subId}`, { data: { status: "cancelled" } });
    await page.request.delete(`${base}/${subId}`);
    await page.request.patch(`${base}/${mainId}`, { data: { status: "cancelled" } });
    await page.request.delete(`${base}/${mainId}`);
  }
});
