/**
 * ISO19650-2 5.1.7(d) audit (docs/features/AUDIT_LOG.md): the project's Denetim Kaydı tab
 * (filter, CSV download, chain check), a file's Denetim Geçmişi in the file drawer, and the retention
 * of the log's personal part in Gizlilik Merkezi (P1-5, AUDIT_LOG.md#personal-data). Core only:
 * passes with and without Enterprise modules.
 */
import { readFile } from "node:fs/promises";
import { test, expect, runState } from "../support/fixtures";

test("ISO19650-2 5.1.7(d) audit: file history, project log with filter, CSV download and chain check", async ({ page }) => {
  const { project } = await runState();
  const fileName = `e2e-audit-${Date.now().toString(36)}.txt`;
  const upload = await page.request.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
    multipart: { file: { name: fileName, mimeType: "text/plain", buffer: Buffer.from("audit trail\n", "utf8") } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const fileId = ((await upload.json()) as { results: { fileId: string }[] }).results[0]!.fileId;

  // The file's history in the drawer: loaded when opened.
  await page.goto(`/projects/${project.id}/files/${project.rootFolderId}?file=${fileId}`);
  const history = page.locator("details.file-audit-history");
  await history.getByText("Denetim Geçmişi", { exact: true }).click();
  await expect(history.getByText("Dosya yüklendi", { exact: true })).toBeVisible();

  // The project's audit log (Proje Ayarları → Denetim Kaydı).
  await page.goto(`/projects/${project.id}/settings?sekme=aktivite`);
  await expect(page.getByRole("tab", { name: "Denetim Kaydı", exact: true })).toHaveAttribute("aria-selected", "true");
  const row = page.getByRole("row").filter({ hasText: fileName }).filter({ hasText: "Dosya yüklendi" });
  await expect(row.first()).toBeVisible();

  const filtered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/audit") && new URL(r.url()).searchParams.get("action") === "file.*");
  await page.getByLabel("İşlem", { exact: true }).selectOption("file.*");
  expect((await filtered).ok()).toBe(true);
  await expect(row.first()).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "CSV İndir", exact: true }).click();
  const csv = await download;
  expect(csv.suggestedFilename()).toMatch(/^audit-.+-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile((await csv.path())!, "utf8");
  expect(text.replace(/^﻿/, "").split("\r\n")[0]).toContain("İşlem");
  expect(text).toContain(fileName);
  expect(text).toContain("file.uploaded");

  // The e2e user is a system administrator: the chain check is offered and passes.
  const chain = page.getByTestId("audit-chain");
  await chain.getByRole("button", { name: "Zinciri Denetle", exact: true }).click();
  await expect(chain.getByText(/^Sağlam: \d+ kayıt denetlendi$/)).toBeVisible();
});

test("ISO19650-2 5.1.7(d) audit: retention of the personal part is set in the Privacy Centre and the chain still verifies", async ({ page }) => {
  // The e2e user's own requests write their IP address outside the chain (P1-5).
  const own = await page.request.get(`/api/v1/admin/audit?limit=20`);
  expect(own.ok()).toBe(true);
  const entries = ((await own.json()) as { entries: { ip?: string | null; hash: string | null }[] }).entries;
  expect(entries.some((e) => !!e.ip && !!e.hash)).toBe(true);

  await page.goto("/administration");
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy" && r.request().method() === "GET");
  await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
  expect((await loaded).ok()).toBe(true);
  const months = page.getByLabel("Denetim Kaydı Kişisel Veri Saklama Süresi (ay)", { exact: true });
  const before = await months.inputValue();
  await expect(page.getByText(/bu süre dolunca silinir \(1–120 ay\)/)).toBeVisible();

  try {
    await months.fill("18");
    const card = page.locator(".card").filter({ has: months });
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy/settings" && r.request().method() === "PUT");
    await card.getByRole("button", { name: "Kaydet", exact: true }).click();
    const res = await saved;
    expect(res.ok(), await res.text()).toBe(true);
    expect(((await res.json()) as { settings: { auditPersonalRetentionMonths: number } }).settings.auditPersonalRetentionMonths).toBe(18);
    await expect(card.getByText("Kaydedildi.", { exact: true })).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
    await expect(page.getByLabel("Denetim Kaydı Kişisel Veri Saklama Süresi (ay)", { exact: true })).toHaveValue("18");
  } finally {
    const reset = await page.request.put(`/api/v1/admin/privacy/settings`, { data: { auditPersonalRetentionMonths: Number(before) || 12 } });
    expect(reset.ok()).toBe(true);
  }
  const verify = await page.request.get(`/api/v1/admin/audit/verify`);
  expect(((await verify.json()) as { ok: boolean }).ok).toBe(true);
});
