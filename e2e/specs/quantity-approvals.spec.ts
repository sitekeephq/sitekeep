import { expect, runState, test } from "../support/project-features";
import { uploadServerIfc } from "../support/seed-files";
import { needsModules } from "../support/modules";

needsModules("cost");

test("metraj onayı: approve the inventory, bind groups to contract items, fill a payment and revoke", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36).toUpperCase();
  const fileName = `e2e-onay-${stamp}.ifc`;
  const v = await uploadServerIfc(request, project.id, project.rootFolderId, "openings.ifc", fileName);
  const api = `/api/v1/projects/${project.id}`;
  const created = await request.post(`${api}/contracts`, {
    data: { code: `MO-${stamp}`, title: "Metraj Onaylı Sözleşme", employerName: "İdare", contractorName: "Yüklenici" },
  });
  expect(created.status()).toBe(201);
  const cid = (await created.json()).id as string;

  try {
    for (const item of [
      { code: "SIVA-01", description: "Duvar Sıvası", unit: "m2", unitPrice: 100, contractQuantity: 100 },
      { code: "KAPI-01", description: "Ahşap Kapı", unit: "adet", unitPrice: 5000, contractQuantity: 10 },
    ])
      expect((await request.post(`${api}/contracts/${cid}/items`, { data: item })).status()).toBe(201);
    expect((await request.post(`${api}/contracts/${cid}/payments`, { data: { periodEnd: "2026-11-30" } })).status()).toBe(201);

    let number = "";
    await test.step("approve the model inventory on the Metraj page", async () => {
      await page.goto(`/projects/${project.id}/quantities?v=${v.versionId}`);
      await expect(page.getByTestId("qty-openings")).toBeVisible();
      await page.getByRole("button", { name: "Metrajı Onayla" }).click();
      const dialog = page.getByRole("dialog", { name: "Metrajı Onayla" });
      await expect(dialog).toContainText(`${fileName} V1 metrajı`);
      await dialog.getByRole("textbox").fill("Kaba yapı e2e");
      await dialog.getByRole("button", { name: "Onayla" }).click();
      const status = page.getByRole("status").filter({ hasText: /Metraj Onayı #\d+ kaydedildi\./ });
      await expect(status).toBeVisible();
      number = /#(\d+)/.exec((await status.textContent()) ?? "")![1]!;
      await status.getByRole("link", { name: "Onayları Gör" }).click();
      await expect(page.getByRole("tab", { name: "Onaylar" })).toHaveAttribute("aria-selected", "true");
      const row = page.locator("table.qty-approvals tbody > tr").filter({ has: page.getByRole("button", { name: new RegExp(`Metraj Onayı #${number}$`) }) });
      await expect(row).toContainText(fileName);
      await expect(row).toContainText("Kaba yapı e2e");
      await expect(row).toContainText("Onaylı");
      await row.getByRole("button", { name: new RegExp(`Metraj Onayı #${number}$`) }).click();
      const groups = page.locator("table.qty-approvals tr.pc-detail");
      await expect(groups.locator("tr").filter({ hasText: "Duvar · Tipsiz · Malzemesiz" })).toContainText("27,31");
    });

    await test.step("bind approved groups to contract items", async () => {
      await page.goto(`/projects/${project.id}/contracts/${cid}?tab=quantities`);
      await expect(page.getByRole("link", { name: "Metraj Bağları" })).toHaveClass(/active/);
      const approval = page.getByLabel("Metraj Onayı", { exact: true });
      const value = await approval.locator("option").filter({ hasText: `#${number} · ${fileName}` }).getAttribute("value");
      await approval.selectOption(value!);
      await page.getByLabel("Duvar · Tipsiz · Malzemesiz Kalem").selectOption({ label: "SIVA-01 — Duvar Sıvası (m²)" });
      await page.getByLabel("Kapı · Tipsiz · Malzemesiz Kalem").selectOption({ label: "KAPI-01 — Ahşap Kapı (adet)" });
      const wall = page.locator("table.qty-bindings tbody > tr").filter({ hasText: "Duvar · Tipsiz · Malzemesiz" });
      await expect(wall.getByLabel("Duvar · Tipsiz · Malzemesiz Ölçü")).toHaveValue("netArea");
      await expect(wall).toContainText("27,31 m²");
      await page.getByRole("button", { name: "Bağları Kaydet" }).click();
      await expect(page.getByText("2 bağ kaydedildi.")).toBeVisible();
      await expect(page.locator("table.qty-binding-totals tbody > tr").filter({ hasText: "SIVA-01" })).toContainText("27,31 m²");
    });

    await test.step("fill the draft payment from the approval", async () => {
      await page.getByRole("link", { name: "Dönem Hakedişleri" }).click();
      const pick = page.getByLabel("Metraj Onayı", { exact: true });
      const value = await pick.locator("option").filter({ hasText: `Onay #${number} · ${fileName}` }).getAttribute("value");
      await pick.selectOption(value!);
      await page.getByRole("button", { name: "Onaylı Metrajdan Doldur" }).click();
      await expect(page.getByText("Miktarlar onaylı metrajdan dolduruldu.")).toBeVisible();
      await expect(page.getByLabel("SIVA-01 Bu Dönem Miktar")).toHaveValue("27.31");
      await expect(page.getByLabel("KAPI-01 Bu Dönem Miktar")).toHaveValue("1");
      await expect(page.getByLabel("SIVA-01 Metraj Kaynağı / Ataşman")).toHaveValue(new RegExp(`^Metraj Onayı #${number} · ${fileName.replace(/\./g, "\\.")} V1`));
      await expect(page.getByTestId("payment-quantity-source")).toContainText(`Kaynak: Metraj Onayı #${number} · ${fileName} V1`);
    });

    await test.step("revoke the approval with a reason", async () => {
      await page.goto(`/projects/${project.id}/quantities?mode=approvals`);
      const row = page.locator("table.qty-approvals tbody > tr").filter({ has: page.getByRole("button", { name: new RegExp(`Metraj Onayı #${number}$`) }) });
      await expect(row).toContainText(`MO-${stamp} · #1`);
      await row.getByRole("button", { name: "Geri Al" }).click();
      const dialog = page.getByRole("dialog", { name: `Metraj Onayı #${number} Geri Alınsın mı?` });
      await dialog.getByRole("textbox").fill("Model güncellendi");
      await dialog.getByRole("button", { name: "Geri Al" }).click();
      await expect(page.getByText(`Metraj Onayı #${number} geri alındı.`)).toBeVisible();
      await expect(row).toContainText("Geri Alındı");
      await expect(row).toContainText("Model güncellendi");
      await expect(row.getByRole("button", { name: "Geri Al" })).toHaveCount(0);
    });
  } finally {
    await request.delete(`${api}/contracts/${cid}`);
  }
});
