import type { Page } from "@playwright/test";
import { expect, runState, test } from "../support/fixtures";
import { needsModules } from "../support/modules";

needsModules("cost");

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone contract tabs, payment green book and dialogs fit the screen", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const base = `/api/v1/projects/${project.id}/contracts`;

  // Prerequisites through the API; the phone journey below is what is under test.
  const created = await request.post(base, {
    data: {
      code: `MOB-${Date.now().toString(36).toUpperCase()}`,
      title: "Mobil Sözleşme",
      employerName: "Mobil İdare",
      contractorName: "Mobil Yüklenici",
    },
  });
  expect(created.status()).toBe(201);
  const cid = (await created.json()).id as string;

  try {
    expect(
      (
        await request.post(`${base}/${cid}/items`, {
          data: { code: "M-01", description: "Duvar Örülmesi", unit: "m2", unitPrice: 450, contractQuantity: 800 },
        })
      ).status(),
    ).toBe(201);
    expect((await request.post(`${base}/${cid}/payments`, { data: { periodEnd: "2026-03-31" } })).status()).toBe(201);

    await page.goto(`/projects/${project.id}/contracts`);
    await expect(page.getByRole("heading", { name: "Sözleşme ve Hakediş Yönetimi" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sözleşme Panosu" })).toBeVisible();
    await assertNoSidewaysScroll(page);
    await page.getByRole("button", { name: "+ Yeni Sözleşme" }).click();
    const dialog = page.getByRole("dialog", { name: "Yeni Sözleşme" });
    await expect(dialog).toBeVisible();
    await assertNoSidewaysScroll(page);
    await dialog.getByRole("button", { name: "Kapat" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: /MOB-/ }).click();
    await expect(page.getByRole("heading", { name: /Mobil Sözleşme/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sözleşme Belgeleri" })).toBeVisible();
    await assertNoSidewaysScroll(page);

    for (const tab of ["Birim Fiyat Cetveli", "Dönem Hakedişleri", "Zeyilname ve Değişiklikler", "Teminat ve Sigortalar"]) {
      await test.step(tab, async () => {
        await page.getByRole("link", { name: tab }).click();
        await expect(page.getByRole("link", { name: tab })).toHaveClass(/active/);
        await assertNoSidewaysScroll(page);
      });
    }

    await page.getByRole("link", { name: "Dönem Hakedişleri" }).click();
    const qty = page.getByLabel("M-01 Bu Dönem Miktar");
    await qty.fill("120");
    await expect(page.getByRole("row").filter({ hasText: "M-01" })).toContainText("120 × 450,00 TRY");
    await page.getByRole("button", { name: "Miktar ve Kesintileri Kaydet" }).click();
    await expect(page.getByText("Hakediş kaydedildi.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Bu Dönem İmalat" }).last()).toContainText("54.000,00 TRY");
    await assertNoSidewaysScroll(page);
  } finally {
    await request.patch(`${base}/${cid}`, { data: { status: "cancelled" } });
    await request.delete(`${base}/${cid}`);
  }
});

test("iPhone approval flow panel fits and its buttons approve the payment", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const api = `/api/v1/projects/${project.id}`;
  const stamp = Date.now().toString(36).toUpperCase();

  const tpl = await request.post(`${api}/workflow-templates`, {
    data: {
      kind: "progress_payment",
      name: `Mobil Akış ${stamp}`,
      steps: [{ name: "Şantiye Şefi", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 2, outcomes: ["approved", "rejected"] }],
    },
  });
  expect(tpl.status(), await tpl.text()).toBeLessThan(300);
  const created = await request.post(`${api}/contracts`, {
    data: {
      code: `MAK-${stamp}`,
      title: "Mobil Akışlı Sözleşme",
      employerName: "Mobil İdare",
      contractorName: "Mobil Yüklenici",
      approvalTemplateId: (await tpl.json()).id,
    },
  });
  expect(created.status()).toBe(201);
  const cid = (await created.json()).id as string;

  try {
    expect(
      (
        await request.post(`${api}/contracts/${cid}/items`, {
          data: { code: "M-02", description: "Sıva", unit: "m2", unitPrice: 200, contractQuantity: 100 },
        })
      ).status(),
    ).toBe(201);
    expect((await request.post(`${api}/contracts/${cid}/payments`, { data: { periodEnd: "2026-03-31" } })).status()).toBe(201);

    await page.goto(`/projects/${project.id}/contracts/${cid}?tab=payments`);
    await page.getByLabel("M-02 Bu Dönem Miktar").fill("10");
    await page.getByRole("button", { name: "Miktar ve Kesintileri Kaydet" }).click();
    await expect(page.getByText("Hakediş kaydedildi.")).toBeVisible();
    await page.getByRole("button", { name: "Onaya Sun" }).click();
    const flow = page.getByLabel("Onay Akışı");
    await expect(flow).toContainText("Adım 1/1: Şantiye Şefi");
    await flow.scrollIntoViewIfNeeded();
    await assertNoSidewaysScroll(page);
    await flow.getByLabel("Onay Notu").fill("Uygun");
    await flow.getByRole("button", { name: "Onayla" }).click();
    await expect(flow).toContainText("Tamamlandı");
    await expect(page.getByRole("heading", { name: /#1 —/ })).toContainText("Onaylandı");
    await assertNoSidewaysScroll(page);
  } finally {
    await request.patch(`${api}/contracts/${cid}`, { data: { status: "cancelled" } });
    await request.delete(`${api}/contracts/${cid}`);
  }
});
