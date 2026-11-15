/**
 * ISO19650-1 12.x / -2 5.1.7 audit (docs/features/AUDIT_LOG.md): the project's Denetim Kaydı tab
 * (filter, CSV download, chain check) and a file's Denetim Geçmişi in the file drawer. Core only:
 * passes with and without Enterprise modules.
 */
import { readFile } from "node:fs/promises";
import { test, expect, runState } from "../support/fixtures";

test("audit log: file history, project log with filter, CSV download and chain check", async ({ page }) => {
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
