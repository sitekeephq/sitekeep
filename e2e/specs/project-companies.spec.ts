/**
 * Companies on a project (docs/features/COMPANIES.md): Project Settings → Members lists only the
 * project's companies; a company is added from the registry, appears in the member company picker,
 * and is taken off again. A company used by a member cannot be taken off. Turkish interface.
 * Core only: passes with and without Enterprise modules.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

test("project settings: companies on the project, added and removed; pickers show only them", async ({ page, request, allowApiFailure }) => {
  test.setTimeout(90_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  const own = await ok<{ id: string; name: string }>(await request.post("/api/v1/companies", { data: { name: `PF Kendi ${s}` } }), "own company");
  const other = await ok<{ id: string; name: string }>(await request.post("/api/v1/companies", { data: { name: `PF Başka ${s}` } }), "other company");
  const project = await ok<{ id: string }>(await request.post("/api/v1/projects", { data: { code: `PF${s}`, name: `Proje Firmaları ${s}` } }), "project");
  await ok(await request.post(`/api/v1/projects/${project.id}/companies`, { data: { companyId: own.id } }), "own on project");
  const email = `pf-${s.toLowerCase()}@7d-cde.localhost`;
  await ok(await request.post("/api/v1/users", { data: { email, name: `PF Üye ${s}`, password: "Pf-Kullanici-2026", companyId: own.id } }), "user");
  await ok(await request.post(`/api/v1/projects/${project.id}/members`, { data: { email } }), "member");

  await page.goto(`/projects/${project.id}/settings?sekme=uyeler`);
  const section = page.getByTestId("project-companies");
  await expect(section.getByRole("heading", { name: "Bu Projedeki Firmalar" })).toBeVisible();
  await expect(section.getByRole("table")).toContainText(own.name);
  await expect(section.getByRole("table")).not.toContainText(other.name);
  const memberCompany = page.getByRole("row", { name: new RegExp(`PF Üye ${s}`) }).getByRole("combobox");
  await expect(memberCompany.locator("option", { hasText: other.name })).toHaveCount(0);

  // Add the other company: it appears in the list and in the member company picker.
  await section.getByLabel("Projeye eklenecek firma").selectOption({ label: other.name });
  await section.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(section.getByRole("row", { name: new RegExp(other.name) })).toBeVisible();
  await expect(memberCompany.locator("option", { hasText: other.name })).toHaveCount(1);

  // The member's company is in use: refused. The other one comes off.
  allowApiFailure(409, `/api/v1/projects/${project.id}/companies/${own.id}`);
  await section.getByRole("row", { name: new RegExp(own.name) }).getByRole("button", { name: "Kaldır" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Kaldır" }).click();
  await expect(section.getByText("Firma bu projede hâlâ kullanılıyor")).toBeVisible();
  await section.getByRole("row", { name: new RegExp(other.name) }).getByRole("button", { name: "Kaldır" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Kaldır" }).click();
  await expect(section.getByRole("row", { name: new RegExp(other.name) })).toHaveCount(0);
});
