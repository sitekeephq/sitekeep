/**
 * Project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md): the eleven steps with the English
 * ISO 19650 construction template create a project with the chosen task teams and lead, people,
 * folders, code profile, approvers and ISO 19650 rules; quick create still works. Core spec: with
 * Enterprise modules the module parts are applied, without them they are shown as "requires
 * SiteKeep Manage / Field" and reported as skipped. The interface is Turkish (admin profile).
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { moduleInstalled } from "../support/modules";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

async function next(page: Page) {
  await page.getByRole("dialog", { name: "Yeni Proje" }).getByRole("button", { name: "İleri", exact: true }).click();
}

async function openWizard(page: Page) {
  await page.goto("/home");
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Proje" });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-project-wizard").click();
  return dialog;
}

type Role = { id: string; name: string; kind: string; companyId: string | null; isLead: boolean };

test("set-up wizard: the English construction template with teams, lead, people, codes and ISO rules", async ({ page, request }) => {
  test.setTimeout(120_000);
  const s = randomUUID().slice(0, 6);
  const code = `WZ${s}`.toUpperCase();
  const company = async (name: string) => (await ok<{ id: string; name: string }>(await request.post("/api/v1/companies", { data: { name: `${name} ${s}` } }), name)).name;
  const names = {
    idare: await company("Wizard Client"),
    musavir: await company("Wizard Consultant"),
    tasarimci: await company("Wizard Designer"),
    yuklenici: await company("Wizard Contractor"),
  };
  const personEmail = `wizard-person-${s}@7d-cde.localhost`;
  await ok(await request.post("/api/v1/users", { data: { email: personEmail, name: `Wizard Person ${s}`, password: "Sihirbaz-12345678" } }), "user");

  const dialog = await openWizard(page);

  // 1 Language: the project's content in English (the interface stays Turkish).
  await dialog.getByRole("radio", { name: /English/ }).check();
  await next(page);

  // 2 Template: what it brings, and the parts of the Enterprise modules.
  await dialog.locator('[data-template="iso19650-yapim-en"]').click();
  const parts = dialog.getByTestId("setup-template-parts");
  await expect(parts.locator('[data-part="roles"]')).toContainText("SiteKeep Community");
  for (const [part, module] of [["rfi", "Manage"], ["forms", "Field"]] as const) {
    const row = parts.locator(`[data-part="${part}"]`);
    if (moduleInstalled(module.toLowerCase() as "manage" | "field")) await expect(row).toContainText(`SiteKeep ${module}`);
    else await expect(row).toContainText(`SiteKeep ${module} Gerekli`);
  }
  // Meetings switched off for this project.
  await parts.locator('[data-part="meetings"]').getByRole("checkbox").uncheck();
  await next(page);

  // 3 Basics.
  await dialog.getByLabel("Proje adı").fill(`Wizard Project ${s}`);
  await dialog.getByLabel("Proje kodu").fill(code);
  await dialog.getByLabel("Başlangıç Tarihi").fill("2026-12-01");
  await dialog.getByLabel("Bitiş Tarihi").fill("2028-06-30");
  await dialog.getByLabel("Konum").fill("Istanbul");
  await next(page);

  // 4 Parties → companies → task teams; the designer's team leads.
  const labels = { idare: "Client / Appointing party", musavir: "Consultant / Project manager", tasarimci: "Designer", yuklenici: "Contractor" };
  for (const [slot, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
    await dialog.getByLabel(`${label} firması`).selectOption({ label: names[slot] });
  }
  await dialog.locator('[data-slot="tasarimci"]').getByRole("radio").check();
  await next(page);

  // 5 People: an existing user into the contractor with a project role; an unknown address is listed.
  await dialog.getByLabel("E-posta Adresleri").fill(`${personEmail}, nobody-${s}@example.com`);
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  const row = dialog.locator(`[data-email="${personEmail}"]`);
  await row.getByLabel(`${personEmail} tarafı`).selectOption("yuklenici");
  await row.locator("summary").click();
  await row.getByRole("checkbox", { name: "Information Manager" }).check();
  // Invitations off (invitations.spec.ts covers them): the unknown address is only reported.
  await expect(dialog.locator(`[data-email="nobody-${s}@example.com"]`)).toContainText("davet edilecek");
  await dialog.getByRole("checkbox", { name: "Hesabı Olmayan Kişileri Davet Et" }).uncheck();
  await expect(dialog.locator(`[data-email="nobody-${s}@example.com"]`)).toContainText("SiteKeep hesabı yok");
  await next(page);

  // 6 Folders: one added below the general folder.
  await dialog.getByLabel("Altına").selectOption("00-GENERAL");
  await dialog.getByLabel("Klasör Adı").fill("09-Photographs");
  await dialog.getByRole("button", { name: "Klasör Ekle" }).click();
  await dialog.getByRole("button", { name: "Önizlemeyi Yenile" }).click();
  await expect(dialog.getByTestId("setup-folder-tree")).toContainText("00-GENERAL");
  await next(page);

  // 7 Document codes: the sample name follows the standard.
  await expect(dialog.getByTestId("setup-sample-result")).toContainText("standarda uyuyor");
  await dialog.getByLabel("Örnek Ad").fill("NOT-A-CODE");
  await expect(dialog.getByTestId("setup-sample-result").locator(".error")).toBeVisible();
  await next(page);

  // 8 Codes profile: legacy R00.
  await dialog.getByRole("radio", { name: /Eski Düzen \(R00\)/ }).check();
  await next(page);

  // 9 Workflows: the client acceptance also goes to the "Client - Acceptance" project role.
  await dialog.getByLabel("Client acceptance adımına onaycı ekle").first().selectOption({ label: "Rol: Client - Acceptance" });
  await next(page);

  // 10 ISO rules: enforcement stays on, administrators do not see the teams' WIP.
  await expect(dialog.getByRole("checkbox", { name: "Geçiş Tablosu Uygulansın" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Proje Yöneticileri Tüm Çalışma Alanını Görür" }).uncheck();
  await next(page);

  // 11 Summary: the server's dry run, then create.
  await expect(dialog.getByText("Her şey uygun. Proje oluşturulabilir.")).toBeVisible();
  await expect(dialog.getByTestId("setup-expected-parts").locator('[data-part="meetings"]')).toContainText("Kapalı");
  await dialog.getByRole("button", { name: "Projeyi Oluştur" }).click();

  // The per-part report.
  const report = dialog.getByTestId("setup-report");
  await expect(report).toBeVisible();
  await expect(report.locator('[data-part="roles"]')).toHaveAttribute("data-status", "applied");
  await expect(report.locator('[data-part="meetings"]')).toHaveAttribute("data-status", "skipped");
  for (const part of ["rfi", "submittals", "forms"]) {
    const status = report.locator(`[data-part="${part}"]`);
    await expect(status).not.toHaveAttribute("data-status", "failed");
    if (!moduleInstalled(part === "forms" ? "field" : "manage")) await expect(status).toHaveAttribute("data-status", "skipped");
  }
  await expect(report).toContainText("Hesap Yok");

  await report.getByRole("button", { name: "Projeyi Aç" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/files/);
  const pid = /\/projects\/([0-9a-f-]+)\//.exec(page.url())![1]!;

  // What the project got.
  const projects = await ok<{ id: string; code: string }[]>(await request.get("/api/v1/projects"), "projects");
  expect(projects.find((p) => p.id === pid)?.code).toBe(code);
  const roles = await ok<Role[]>(await request.get(`/api/v1/projects/${pid}/roles`), "roles");
  const companies = await ok<{ id: string; name: string }[]>(await request.get("/api/v1/companies"), "companies");
  const idOf = (name: string) => companies.find((c) => c.name === name)!.id;
  const teams = roles.filter((r) => r.kind === "task_team");
  for (const name of Object.values(names)) expect(teams.some((t) => t.companyId === idOf(name)), name).toBe(true);
  expect(teams.filter((t) => t.isLead).map((t) => t.companyId)).toEqual([idOf(names.tasarimci)]);
  const cde = await ok<{ codeScheme: string; enforceTransitions: boolean; wipPolicy: string; adminSeesWip: boolean }>(
    await request.get(`/api/v1/projects/${pid}/cde/settings`),
    "cde",
  );
  expect(cde).toMatchObject({ codeScheme: "legacy_r", enforceTransitions: true, wipPolicy: "team_only", adminSeesWip: false });
  const members = await ok<{ email: string; companyId: string; roleIds: string[] }[]>(await request.get(`/api/v1/projects/${pid}/members`), "members");
  const person = members.find((m) => m.email === personEmail)!;
  expect(person.companyId).toBe(idOf(names.yuklenici));
  expect(person.roleIds).toContain(roles.find((r) => r.name === "Information Manager")!.id);
  const project = await ok<{ rootFolderId: string; details?: Record<string, string> }>(await request.get(`/api/v1/projects/${pid}`), "project");
  expect(project.details).toMatchObject({ startDate: "2026-12-01", endDate: "2028-06-30", location: "Istanbul" });
  const root = await ok<{ folders: { id: string; name: string }[] }>(await request.get(`/api/v1/projects/${pid}/folders/${project.rootFolderId}/contents`), "root");
  const general = root.folders.find((f) => f.name === "00-GENERAL")!;
  const inGeneral = await ok<{ folders: { name: string }[] }>(await request.get(`/api/v1/projects/${pid}/folders/${general.id}/contents`), "general");
  expect(inGeneral.folders.map((f) => f.name)).toContain("09-Photographs");
});

test("set-up wizard: the draft survives a reload and can be started over", async ({ page }) => {
  const dialog = await openWizard(page);
  await dialog.getByRole("radio", { name: /English/ }).check();
  await next(page);
  await dialog.locator('[data-template="iso19650-temel"]').click();
  await next(page);
  await dialog.getByLabel("Proje adı").fill("Draft Project");
  await page.reload();
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const again = page.getByRole("dialog", { name: "Yeni Proje" });
  await expect(again.getByText("Yarım kalan kurulumunuz bu tarayıcıdan geri yüklendi.")).toBeVisible();
  await expect(again.getByLabel("Proje adı")).toHaveValue("Draft Project");
  await again.getByRole("button", { name: "Baştan Başla" }).click();
  await expect(again.getByRole("heading", { name: /Adım 1 \/ 11/ })).toBeVisible();
  // Keyboard: the step heading takes the focus, Next is reachable.
  await expect(again.getByRole("heading", { name: /Adım 1 \/ 11/ })).toBeFocused();
});

test("quick create: a template, a name and a code", async ({ page }) => {
  const s = randomUUID().slice(0, 6).toUpperCase();
  await page.goto("/home");
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Proje" });
  await dialog.getByTestId("new-project-quick").click();
  await dialog.getByLabel("Şablon").selectOption("iso19650-temel");
  await dialog.getByLabel("Proje adı").fill(`Quick ${s}`);
  await dialog.getByLabel("Proje kodu").fill(`QC${s}`);
  await dialog.getByRole("button", { name: "Projeyi Oluştur" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/files/);
  await expect(page.getByText("Proje Dosyaları", { exact: true }).first()).toBeVisible();
});
