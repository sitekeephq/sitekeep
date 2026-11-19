/**
 * Full project export and restore (docs/features/PROJECT_EXPORT.md): Proje Ayarları → Dışa Aktarma
 * builds the export in the background and offers the ZIP (manifest, checksums, files, BCF issues);
 * Projeler → Projeyi Geri Yükle restores that ZIP as a new project. Core only: passes with and without
 * Enterprise modules. The e2e user is a system administrator, so the export holds the whole project.
 */
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { APIResponse } from "@playwright/test";
import { test, expect } from "../support/fixtures";

async function json<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) throw new Error(`${what} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

test("full project export from the settings page, and its restore as a new project", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36).toUpperCase();
  const project = await json<{ id: string; rootFolderId: string }>(
    await page.request.post("/api/v1/projects", { data: { code: `EXP-${suffix}`, name: `Export ${suffix}`, template: "iso19650" } }),
    "project creation",
  );
  const contents = await json<{ folders: { id: string; state: string | null }[] }>(
    await page.request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`),
    "root contents",
  );
  const wip = contents.folders.find((f) => f.state === "wip")!.id;
  const name = `EXP-${suffix}.txt`;
  for (const body of ["first\n", "second\n"])
    await json(
      await page.request.post(`/api/v1/projects/${project.id}/folders/${wip}/files`, { multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(body) } } }),
      "upload",
    );
  await json(await page.request.post(`/api/v1/projects/${project.id}/issues`, { data: { title: `Issue ${suffix}` } }), "issue");

  await page.goto(`/projects/${project.id}/settings?sekme=disa-aktarma`);
  await expect(page.getByRole("tab", { name: "Dışa Aktarma", exact: true })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("project-export");
  await expect(panel.getByTestId("project-export-scope")).toHaveAttribute("data-scope", "full");
  await expect(panel.getByTestId("project-export-estimate")).toContainText("1 (2 versiyon");
  await panel.getByRole("button", { name: "Dışa Aktarım Oluştur", exact: true }).click();

  // The job runs in the background; the row shows the download link when it is ready.
  const row = panel.getByTestId("project-export-row").first();
  await expect(row).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(row.getByText("Hazır", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await row.getByTestId("project-export-download").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^EXP-.+-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipPath = (await file.path())!;
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  for (const entry of ["manifest.json", "SHA256SUMS", "files.json", "folders.json", "members.json", "issues/issues-0001.bcfzip", "audit/audit-log.json"])
    expect(zip.file(entry), entry).toBeTruthy();
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { schema: string; scope: string; counts: { files: number; versions: number; issues: number } };
  expect(manifest).toMatchObject({ schema: "sitekeep.project-export/1", scope: "full", counts: { files: 1, versions: 2, issues: 1 } });

  // The bell: the export is ready.
  const notes = await json<{ kind: string }[]>(await page.request.get("/api/v1/notifications"), "notifications");
  expect(notes.some((n) => n.kind === "project_export")).toBe(true);

  // Restore it as a new project from the projects page.
  await page.goto("/projects");
  await page.getByRole("button", { name: "Projeyi Geri Yükle", exact: true }).click();
  const dialog = page.getByTestId("restore-project");
  await dialog.locator('input[type="file"]').setInputFiles(zipPath);
  await dialog.getByLabel("Yeni projenin proje kodu", { exact: true }).fill(`RST-${suffix}`);
  await dialog.getByRole("button", { name: "Yükle ve Geri Yükle", exact: true }).click();
  await expect(dialog.getByTestId("restore-done")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByTestId("restore-done")).toContainText(`RST-${suffix}`);
  await dialog.getByRole("button", { name: "Projeyi Aç", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/files/);
});
