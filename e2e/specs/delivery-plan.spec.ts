/**
 * ISO19650-2 5.4.4 / 5.4.5 delivery plan (ISO-7, docs/features/DELIVERY_PLAN.md): in a project from
 * the ISO 19650 template, the administrator sees the template's milestones, plans a deliverable
 * for task team A, sees its status follow the CDE (not started, then WIP once the document is
 * uploaded) and the late flag, filters the MIDP and downloads it; a member of task team B does not
 * see team A's TIDP. Core only: passes with and without Enterprise modules.
 */
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "@playwright/test";
import { test, expect } from "../support/fixtures";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

async function userContext(browser: Browser, baseURL: string, email: string, password: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("cde.productTour.v1", "done");
    } catch {
      // Storage may be unavailable; the spec then fails visibly.
    }
  });
  await ok(await context.request.post("/api/v1/auth/login", { data: { email, password } }), `login ${email}`);
  return context;
}

type Folder = { id: string; name: string; state: string | null };

test("ISO19650-2 5.4.4 / 5.4.5 delivery plan: plan a deliverable per task team, follow its status, filter and export the MIDP", async ({ page, request, browser, baseURL }) => {
  if (!baseURL) throw new Error("E2E baseURL is not configured.");
  const s = randomUUID().slice(0, 4).toUpperCase();
  const codeA = `A${s}`;
  const companyA = await ok<{ id: string; name: string }>(await request.post("/api/v1/companies", { data: { name: `E2E Plan Alfa ${s}`, code: codeA } }), "company A");
  const companyB = await ok<{ id: string }>(await request.post("/api/v1/companies", { data: { name: `E2E Plan Beta ${s}`, code: `B${s}` } }), "company B");
  const projectCode = `DP${s}`;
  const project = await ok<{ id: string; rootFolderId: string }>(
    await request.post("/api/v1/projects/from-template", {
      data: { code: projectCode, name: `E2E Delivery Plan ${s}`, templateId: "iso19650-temel", slotCompanies: { tasarimci: companyA.id, yuklenici: companyB.id } },
    }),
    "project from the ISO template",
  );
  const userB = { email: `e2e-plan-b-${s.toLowerCase()}@7d-cde.localhost`, password: `Copper-Lantern!${Math.random().toString(36).slice(2, 10)}#2026` };
  await ok(await request.post("/api/v1/users", { data: { email: userB.email, name: `E2E Plan B ${s}`, password: userB.password, companyId: companyB.id } }), "user B");
  await ok(await request.post(`/api/v1/projects/${project.id}/members`, { data: { email: userB.email } }), "membership B");
  const root = await ok<{ folders: Folder[] }>(await request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`), "root");
  const wip = root.folders.find((f) => f.state === "wip")!;
  const wipA = (await ok<{ folders: Folder[] }>(await request.get(`/api/v1/projects/${project.id}/folders/${wip.id}/contents`), "wip")).folders.find((f) => f.name === "Tasarımcı")!;
  const docCode = `${projectCode}-${codeA}-ZZ-ZZ-DR-A-0001`;

  // The MIDP with the template's milestones.
  await page.goto(`/projects/${project.id}/delivery-plan`);
  await expect(page.getByTestId("delivery-milestones")).toContainText("M1");
  await expect(page.getByTestId("delivery-milestones")).toContainText("M4");

  // Plan a deliverable for team A, due for Shared in the past.
  await page.getByTestId("delivery-add").click();
  const form = page.getByTestId("delivery-form");
  await form.locator("#dl-team").selectOption({ label: companyA.name });
  await form.locator("#dl-code").fill(docCode);
  await form.locator("#dl-title").fill("Ground floor plan");
  await form.locator("#dl-shared").fill("2020-01-31");
  await form.getByRole("textbox", { name: /M1 .* (Suitability|Uygunluk)/ }).fill("S2");
  await form.getByRole("button", { name: /^(Save|Kaydet)$/ }).click();
  const row = page.locator(`[data-testid="delivery-row"][data-code="${docCode}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("delivery-status")).toHaveText(/Not Started|Başlamadı/);
  await expect(row.getByTestId("delivery-late")).toBeVisible();
  await expect(row).toContainText("S2");

  // The document arrives in team A's WIP: the status follows.
  const upload = { file: { name: `${docCode}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 plan") } };
  await ok(await request.post(`/api/v1/projects/${project.id}/folders/${wipA.id}/files`, { multipart: upload }), "upload the planned document");
  await page.reload();
  await expect(row.getByTestId("delivery-status")).toHaveText(/Work in Progress|Çalışma/);
  await expect(row.getByTestId("delivery-document")).toHaveText(`${docCode}.pdf`);

  // Filters: late only keeps it, Published hides it.
  await page.getByTestId("delivery-filter-late").check();
  await expect(row).toBeVisible();
  await page.getByTestId("delivery-filter-status").selectOption("published");
  await expect(row).toHaveCount(0);
  await page.getByTestId("delivery-filter-status").selectOption("");

  // Team A's TIDP tab, and the export.
  await page.getByTestId("delivery-tab-team").filter({ hasText: codeA }).click();
  await expect(page.getByTestId("delivery-team")).toContainText(companyA.name);
  await expect(row).toBeVisible();
  const href = await page.getByTestId("delivery-export-xlsx").getAttribute("href");
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("spreadsheetml");

  // A member of team B does not see team A's TIDP.
  const b = await userContext(browser, baseURL, userB.email, userB.password);
  try {
    const pageB = await b.newPage();
    await pageB.goto(`/projects/${project.id}/delivery-plan`);
    await expect(pageB.getByTestId("delivery-tab-team")).toHaveCount(1);
    await expect(pageB.getByTestId("delivery-tab-team")).toContainText(`B${s}`);
    await expect(pageB.locator(`[data-testid="delivery-row"][data-code="${docCode}"]`)).toHaveCount(0);
    await expect(pageB.getByTestId("delivery-add")).toHaveCount(0);
  } finally {
    await b.close();
  }
});
