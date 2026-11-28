/**
 * Yönetim → Sistem Durumu → Başarısız Arka Plan İşleri: a file the IFC reader cannot read fails its
 * conversion; the admin sees it grouped with a readable error, expands it to the project and file, retries it
 * and clears the record (confirmed).
 */
import { test, expect, runState } from "../support/fixtures";

test("failed jobs are listed with a readable error, retried and cleared by an administrator", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const api = page.request;
  const name = `kaputt-${Date.now().toString(36)}.ifc`;
  const up = await api.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
    multipart: { file: { name, mimeType: "application/octet-stream", buffer: Buffer.from("ISO-10303-21;\nDATA;\n#1=IFCWALL(;;;garbage\nENDSEC;\n", "utf8") } },
  });
  expect(up.ok(), await up.text()).toBe(true);

  type Page = { total: number; items: { id: string; error: string; attempts: number; file: { name: string } | null }[] };
  const mine = async () =>
    ((await (await api.get("/api/v1/admin/failed-jobs?kind=ifc_to_frag&pageSize=100")).json()) as Page).items.filter((j) => j.file?.name === name);
  await expect.poll(async () => (await mine()).length, { timeout: 60_000 }).toBe(1);
  const [job] = await mine();
  expect(job!.error).not.toContain("[object");

  await page.goto(`/projects/${project.id}/sistem-durumu`);
  const card = page.getByTestId("failed-jobs-card");
  await expect(card.getByRole("heading", { name: "Başarısız Arka Plan İşleri", exact: true })).toBeVisible();
  const group = card.getByRole("row").filter({ hasText: "IFC model dönüşümü" }).filter({ hasText: job!.error }).first();
  await expect(group).toBeVisible();
  await group.getByRole("button", { name: "İşleri Göster" }).click();
  const list = card.getByTestId("failed-jobs-list");
  const row = list.getByRole("row").filter({ hasText: name });
  await expect(row.getByRole("link", { name: new RegExp(project.code) })).toBeVisible();
  await expect(row.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", /\/files\/[0-9a-f-]+$/);

  // Retry: a new conversion runs and (the file is still unreadable) fails again, so the record is back.
  await row.getByRole("button", { name: "Yeniden Dene" }).click();
  await expect(card.getByText(/1 iş yeniden kuyruğa alındı/)).toBeVisible();
  await expect.poll(async () => (await mine()).length, { timeout: 60_000 }).toBe(1);

  await page.reload();
  await card.getByRole("row").filter({ hasText: "IFC model dönüşümü" }).filter({ hasText: job!.error }).first().getByRole("button", { name: "İşleri Göster" }).click();
  await card.getByTestId("failed-jobs-list").getByRole("row").filter({ hasText: name }).getByRole("button", { name: "Temizle" }).click();
  const dialog = page.getByRole("dialog", { name: "Başarısız İşleri Temizle" });
  await expect(dialog).toContainText("1 başarısız iş kaydı silinecek");
  await dialog.getByRole("button", { name: "Temizle" }).click();
  await expect(card.getByText("1 başarısız iş kaydı temizlendi.")).toBeVisible();
  expect(await mine()).toHaveLength(0);
});
