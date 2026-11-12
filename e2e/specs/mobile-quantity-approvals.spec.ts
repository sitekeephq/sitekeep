import type { Page } from "@playwright/test";
import { expect, runState, test } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone metraj onayı: approve, bind on the contract and fill the payment by touch", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(150_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36).toUpperCase();
  const fileName = `e2e-onay-m-${stamp}.ifc`;
  const v = await uploadServerIfc(request, project.id, project.rootFolderId, "openings.ifc", fileName);
  const api = `/api/v1/projects/${project.id}`;
  const created = await request.post(`${api}/contracts`, {
    data: { code: `MOM-${stamp}`, title: "Mobil Metraj Onayı", employerName: "İdare", contractorName: "Yüklenici" },
  });
  expect(created.status()).toBe(201);
  const cid = (await created.json()).id as string;

  try {
    expect(
      (await request.post(`${api}/contracts/${cid}/items`, { data: { code: "BETON-01", description: "C30 Beton", unit: "m3", unitPrice: 2500, contractQuantity: 50 } })).status(),
    ).toBe(201);
    expect((await request.post(`${api}/contracts/${cid}/payments`, { data: { periodEnd: "2026-11-30" } })).status()).toBe(201);

    await page.goto(`/projects/${project.id}/quantities?v=${v.versionId}`);
    await expect(page.getByTestId("qty-openings")).toBeVisible();
    await page.getByRole("button", { name: "Metrajı Onayla" }).tap();
    const dialog = page.getByRole("dialog", { name: "Metrajı Onayla" });
    await expect(dialog).toBeVisible();
    await assertNoSidewaysScroll(page);
    await dialog.getByRole("button", { name: "Onayla" }).tap();
    const status = page.getByRole("status").filter({ hasText: /Metraj Onayı #\d+ kaydedildi\./ });
    await expect(status).toBeVisible();
    const number = /#(\d+)/.exec((await status.textContent()) ?? "")![1]!;

    await page.goto(`/projects/${project.id}/quantities?mode=approvals`);
    await expect(page.locator("table.qty-approvals tbody > tr").filter({ hasText: fileName })).toContainText("Onaylı");
    await assertNoSidewaysScroll(page);

    await page.goto(`/projects/${project.id}/contracts/${cid}?tab=quantities`);
    const approval = page.getByLabel("Metraj Onayı", { exact: true });
    await approval.selectOption((await approval.locator("option").filter({ hasText: `#${number} · ${fileName}` }).getAttribute("value"))!);
    await page.getByLabel("Döşeme · Tipsiz · Malzemesiz Kalem").selectOption({ label: "BETON-01 — C30 Beton (m³)" });
    await expect(page.locator("table.qty-bindings tbody > tr").filter({ hasText: "Döşeme" })).toContainText("4,8 m³");
    await assertNoSidewaysScroll(page);
    await page.getByRole("button", { name: "Bağları Kaydet" }).tap();
    await expect(page.getByText("1 bağ kaydedildi.")).toBeVisible();

    await page.goto(`/projects/${project.id}/contracts/${cid}?tab=payments`);
    const pick = page.getByLabel("Metraj Onayı", { exact: true });
    await pick.selectOption((await pick.locator("option").filter({ hasText: `Onay #${number} · ${fileName}` }).getAttribute("value"))!);
    await page.getByRole("button", { name: "Onaylı Metrajdan Doldur" }).tap();
    await expect(page.getByLabel("BETON-01 Bu Dönem Miktar")).toHaveValue("4.8");
    await expect(page.getByTestId("payment-quantity-source")).toContainText(`Metraj Onayı #${number}`);
    await assertNoSidewaysScroll(page);
  } finally {
    await request.delete(`${api}/contracts/${cid}`);
  }
});
