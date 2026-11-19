/**
 * ÇŞB 2026 (EK-2) naming profile (docs/features/NAMING_CSB_2026.md): the set-up wizard with the
 * Turkish construction template takes the EK-1 project code, offers the profile as the document code
 * standard and checks a sample name against it; the project's Shared folder is then named by the
 * profile with the EK-1 code as Proje Kodu. The interface is Turkish (admin profile).
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";

const CSB = "ÇŞB 2026 (EK-2)";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

async function next(page: Page) {
  await page.getByRole("dialog", { name: "Yeni Proje" }).getByRole("button", { name: "İleri", exact: true }).click();
}

test("set-up wizard: the ÇŞB 2026 (EK-2) profile with the EK-1 project code", async ({ page, request }) => {
  test.setTimeout(120_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  const code = `CSB${s}`;

  await page.goto("/home");
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Proje" });
  await dialog.getByTestId("new-project-wizard").click();

  // 1 Language, 2 template: the Turkish construction template.
  await dialog.getByRole("radio", { name: /Türkçe/ }).check();
  await next(page);
  await dialog.locator('[data-template="iso19650-yapim-tr"]').click();
  await next(page);

  // 3 Basics: the EK-1 code is checked (six capital letters or digits).
  await dialog.getByLabel("Proje adı").fill(`ÇŞB Projesi ${s}`);
  await dialog.getByLabel("Proje kodu", { exact: true }).fill(code);
  const csbCode = dialog.getByLabel("ÇŞB Proje Kodu (EK-1)");
  await csbCode.fill("2700");
  await expect(dialog.getByRole("button", { name: "İleri", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/ÇŞB proje kodu \(EK-1\) altı büyük harf veya rakam olmalı/)).toBeVisible();
  await csbCode.fill("270001");
  await next(page);

  // 4 Parties, 5 people, 6 folders: the template's.
  await next(page);
  await next(page);
  await next(page);

  // 7 Document codes: the profile, with the EK-1 code as Proje Kodu and a sample name that follows it.
  await dialog.getByRole("radio", { name: new RegExp(CSB.replace(/[()]/g, "\\$&")) }).check();
  await expect(dialog.locator(".setup-naming")).toContainText("ÇŞB proje kodundan");
  await expect(dialog.getByTestId("setup-sample-result")).toContainText("standarda uyuyor");
  const sample = dialog.getByLabel("Örnek Ad");
  await sample.fill("270001_00_MM_DUVA_PL_MMC_K01_01_000");
  await expect(dialog.getByTestId("setup-sample-result")).toContainText("standarda uyuyor");
  await sample.fill("270001_00_MM_BETO_PL_MMC_K01_01_000");
  await expect(dialog.getByTestId("setup-sample-result")).toContainText('"BETO", Disiplin "MM" ile kullanılamaz');
  await sample.fill("270001_000_MM_DUVA_PL_MMC_K01_01_000");
  await expect(dialog.getByTestId("setup-sample-result")).toContainText("en fazla 35 karakter");
  await next(page);

  // 8–10 as the template sets them; 11 summary and create.
  await next(page);
  await next(page);
  await next(page);
  await expect(dialog.getByText("Her şey uygun. Proje oluşturulabilir.")).toBeVisible();
  await dialog.getByRole("button", { name: "Projeyi Oluştur" }).click();
  await dialog.getByTestId("setup-report").getByRole("button", { name: "Projeyi Aç" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/files/);
  const pid = /\/projects\/([0-9a-f-]+)\//.exec(page.url())![1]!;

  // The project: the EK-1 code in its details, the Shared folder named by the profile.
  const project = await ok<{ rootFolderId: string; details?: Record<string, string> }>(await request.get(`/api/v1/projects/${pid}`), "project");
  expect(project.details).toMatchObject({ csbProjectCode: "270001" });
  const root = await ok<{ folders: { id: string; name: string }[] }>(await request.get(`/api/v1/projects/${pid}/folders/${project.rootFolderId}/contents`), "root");
  const shared = root.folders.find((f) => f.name === "20-PAYLAŞILAN (Shared)")!;
  const check = await ok<{ standard: string; results: { ok: boolean }[] }>(
    await request.post(`/api/v1/projects/${pid}/naming/validate`, {
      data: { folderId: shared.id, names: ["270001_00_ST_BETO_HS_SHR_NNN_01_000.pdf", "270002_00_ST_BETO_HS_SHR_NNN_01_000.pdf"] },
    }),
    "validate",
  );
  expect(check.standard).toBe(CSB);
  expect(check.results.map((r) => r.ok)).toEqual([true, false]);
});
