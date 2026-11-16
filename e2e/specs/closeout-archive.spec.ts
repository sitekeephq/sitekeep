/**
 * ISO19650-2 5.8.1 close-out archive (docs/features/CLOSEOUT_ARCHIVE.md): Proje Ayarları → Kapanış
 * builds the archive in the background, offers the ZIP (manifest, audit log, SHA256SUMS) and closes the
 * project; the closed project refuses uploads and a system administrator reopens it. Core only: passes
 * with and without Enterprise modules. Uses its own project, so closing it does not touch the other specs.
 */
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { APIResponse } from "@playwright/test";
import { test, expect } from "../support/fixtures";

async function json<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) throw new Error(`${what} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

test("ISO19650-2 5.8.1 close-out archive: the ZIP is built in the background with its manifest, the project is closed (read-only) and reopened", async ({
  page,
  allowApiFailure,
}) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36).toUpperCase();
  const project = await json<{ id: string; rootFolderId: string }>(
    await page.request.post("/api/v1/projects", { data: { code: `CLS-${suffix}`, name: `Close-out ${suffix}`, template: "iso19650" } }),
    "project creation",
  );
  const contents = await json<{ folders: { id: string; state: string | null }[] }>(
    await page.request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`),
    "root contents",
  );
  const folder = (state: string) => contents.folders.find((f) => f.state === state)!.id;
  // Not enforced: a file can be written straight into Published for the test.
  const name = `CLS-${suffix}.txt`;
  await json(
    await page.request.post(`/api/v1/projects/${project.id}/folders/${folder("published")}/files`, {
      multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from("as-built record\n") } },
    }),
    "upload into Published",
  );

  await page.goto(`/projects/${project.id}/settings?sekme=kapanis`);
  await expect(page.getByRole("tab", { name: "Kapanış", exact: true })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("closeout");
  await expect(panel.getByTestId("closeout-estimate")).toContainText("1 dosya, 1 versiyon");
  await panel.getByLabel("Arşiv Eksiksiz Tamamlanınca Projeyi Kapat (Salt Okunur)", { exact: true }).check();
  await panel.getByRole("button", { name: "Kapanış Arşivi Oluştur", exact: true }).click();

  // The job runs in the background; the row shows its progress, then the download link.
  const row = panel.getByTestId("closeout-archive").first();
  await expect(row).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(row.getByText("Hazır", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await row.getByRole("link", { name: "İndir", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^CLS-.+-closeout-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await JSZip.loadAsync(await readFile((await file.path())!));
  for (const entry of ["README.txt", "manifest.json", "manifest.csv", "audit/audit-log.csv", "audit/audit-verify.json", "SHA256SUMS"])
    expect(zip.file(entry), entry).toBeTruthy();
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { entries: { name: string; cdeState: string; integrity: string; sha256: string }[] };
  expect(manifest.entries).toEqual([expect.objectContaining({ name, cdeState: "published", integrity: "ok" })]);
  expect(await zip.file("SHA256SUMS")!.async("string")).toContain(`${manifest.entries[0]!.sha256}  files/`);
  expect(await zip.file("README.txt")!.async("string")).toContain("ISO 19650-2:2018, 5.8.1");

  // Closed: the banner shows on every page of the project and uploads are refused.
  await expect(page.getByTestId("project-closed-banner")).toBeVisible();
  await expect(panel.getByTestId("closeout-closed")).toBeVisible();
  allowApiFailure(403, `/api/v1/projects/${project.id}/folders/${folder("wip")}/files`);
  const refused = await page.request.post(`/api/v1/projects/${project.id}/folders/${folder("wip")}/files`, {
    multipart: { file: { name: `late-${name}`, mimeType: "text/plain", buffer: Buffer.from("late") } },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { message: string }).message).toMatch(/salt okunur/);
  await page.goto(`/projects/${project.id}/files/${folder("published")}`);
  await expect(page.getByTestId("project-closed-banner")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();

  // The e2e user is a system administrator: it reopens the project with a reason.
  await page.goto(`/projects/${project.id}/settings?sekme=kapanis`);
  await page.getByTestId("closeout-closed").getByRole("button", { name: "Projeyi Yeniden Aç", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Proje yeniden açılsın mı?" });
  await dialog.getByRole("textbox").fill("As-built corrections");
  await dialog.getByRole("button", { name: "Projeyi Yeniden Aç", exact: true }).click();
  await expect(page.getByTestId("closeout-closed")).toHaveCount(0);
  await expect(page.getByTestId("project-closed-banner")).toHaveCount(0);
  const log = await json<{ entries: { action: string; details: Record<string, unknown> | null }[] }>(
    await page.request.get(`/api/v1/projects/${project.id}/audit?action=project.*`),
    "audit log",
  );
  const actions = log.entries.map((e) => e.action);
  expect(actions).toEqual(expect.arrayContaining(["project.closeout_archive_created", "project.closeout_archive_downloaded", "project.closed", "project.reopened"]));
});
