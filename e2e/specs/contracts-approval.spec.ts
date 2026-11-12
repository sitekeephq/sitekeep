import { expect, runState, test } from "../fixtures/access";
import { needsModules } from "../support/modules";

needsModules("cost");

test("multi-step payment approval: flow picked on the contract, member answers from Görevlerim, admin finishes", async ({
  page,
  memberPage,
  memberRequest,
  allowMemberApiFailure,
}) => {
  test.setTimeout(90_000);
  const { project } = await runState();
  const api = `/api/v1/projects/${project.id}`;
  const stamp = Date.now().toString(36).toUpperCase();
  const code = `AK-${stamp}`;
  const flowName = `Hakediş Akışı ${stamp}`;

  const memberId = ((await (await memberRequest.get("/api/v1/auth/me")).json()) as { id: string }).id;
  const tpl = await page.request.post(`${api}/workflow-templates`, {
    data: {
      kind: "progress_payment",
      name: flowName,
      steps: [
        { name: "Teknik Ofis", assignees: [{ type: "user", id: memberId }], rule: "any", days: 3, outcomes: ["approved", "rejected"] },
        { name: "İşveren", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 3, outcomes: ["approved", "rejected"] },
      ],
    },
  });
  expect(tpl.status(), await tpl.text()).toBeLessThan(300);

  const created = await page.request.post(`${api}/contracts`, {
    data: { code, title: "Akışlı Hakediş", employerName: "E2E İdare", contractorName: "E2E Yapı" },
  });
  expect(created.status()).toBe(201);
  const contractId = (await created.json()).id as string;

  try {
    const item = await page.request.post(`${api}/contracts/${contractId}/items`, {
      data: { code: "P-01", description: "Beton", unit: "m3", unitPrice: 100, contractQuantity: 50 },
    });
    expect(item.status()).toBe(201);
    const itemId = (await item.json()).items[0].id as string;
    const pay = await page.request.post(`${api}/contracts/${contractId}/payments`, { data: { periodEnd: "2026-05-31" } });
    expect(pay.status()).toBe(201);
    const payId = (await pay.json()).id as string;
    expect(
      (await page.request.patch(`${api}/contracts/${contractId}/payments/${payId}`, { data: { lines: [{ contractItemId: itemId, periodQuantity: 5 }] } })).status(),
    ).toBe(200);

    await test.step("admin picks the approval flow on the contract card", async () => {
      await page.goto(`/projects/${project.id}/contracts/${contractId}`);
      await expect(page.getByRole("row", { name: "Hakediş Onay Akışı" })).toContainText("Tek Adım: Proje Yöneticisi Onayı");
      await page.getByRole("button", { name: "Düzenle" }).click();
      const dialog = page.getByRole("dialog", { name: "Sözleşmeyi Düzenle" });
      await dialog.getByLabel("Hakediş Onay Akışı").selectOption({ label: `${flowName} (2 adım)` });
      await dialog.getByRole("button", { name: "Kaydet" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("row", { name: "Hakediş Onay Akışı" })).toContainText(flowName);
    });

    await test.step("submitting starts step 1; the admin cannot decide alone", async () => {
      await page.getByRole("link", { name: "Dönem Hakedişleri" }).click();
      await page.getByRole("button", { name: "Onaya Sun" }).click();
      const flow = page.getByLabel("Onay Akışı");
      await expect(flow).toContainText("Adım 1/2: Teknik Ofis");
      await expect(flow).toContainText("İşveren · Sırada");
      await expect(page.getByRole("button", { name: "Onayla", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Reddet", exact: true })).toHaveCount(0);
    });

    await test.step("the member finds the task, a rejection without reason fails, then approves", async () => {
      await memberPage.goto(`/projects/${project.id}/today`);
      const task = memberPage.getByRole("link", { name: new RegExp(`${code} · Hakediş Onayı · 1\\. Teknik Ofis`) }).first();
      await expect(task).toBeVisible();
      await task.click();
      await expect(memberPage).toHaveURL(new RegExp(`/contracts/${contractId}\\?tab=payments&payment=${payId}`));
      const flow = memberPage.getByLabel("Onay Akışı");
      await expect(flow).toContainText("Adım 1/2: Teknik Ofis");
      // The member sees no admin-only actions.
      await expect(memberPage.getByRole("button", { name: "Onaya Sun" })).toHaveCount(0);

      allowMemberApiFailure(400, `${api}/contracts/${contractId}/payments/${payId}/answer`);
      await flow.getByRole("button", { name: "Reddet" }).click();
      await expect(memberPage.getByText("Reddederken gerekçe yazın.")).toBeVisible();
      await expect(flow).toContainText("Adım 1/2: Teknik Ofis");

      await memberPage.getByLabel("P-01 Satır Yorumu").fill("Ataşman uygun");
      await memberPage.getByRole("button", { name: "Yorumları Kaydet" }).click();
      await expect(memberPage.getByText("Hakediş kaydedildi.")).toBeVisible();

      await flow.getByLabel("Onay Notu").fill("Metraj kontrol edildi");
      await flow.getByRole("button", { name: "Onayla" }).click();
      await expect(flow).toContainText("Adım 2/2: İşveren");
      await expect(flow).toContainText("Metraj kontrol edildi");
      await expect(flow.getByRole("button", { name: "Onayla" })).toHaveCount(0);
    });

    await test.step("the admin answers the last step and the payment is approved", async () => {
      await page.reload();
      const flow = page.getByLabel("Onay Akışı");
      await expect(flow).toContainText("Adım 2/2: İşveren");
      await expect(page.getByLabel("P-01 Satır Yorumu")).toHaveValue("Ataşman uygun");
      await flow.getByRole("button", { name: "Onayla" }).click();
      await expect(flow).toContainText("Tamamlandı");
      await expect(page.getByRole("heading", { name: /#1 —/ })).toContainText("Onaylandı");
    });
  } finally {
    await page.request.patch(`${api}/contracts/${contractId}`, { data: { status: "cancelled" } });
    await page.request.delete(`${api}/contracts/${contractId}`);
  }
});
