/**
 * Project templates, format v2 (docs/features/PROJECT_TEMPLATES.md): a project created from the
 * English ISO 19650 construction template opens with its ISO 19650 folders, rules and core parts.
 * Core spec: passes with and without Enterprise modules; the module parts (RFI, submittals, meetings:
 * Manage; forms: Field) are skipped and reported when the module is not installed.
 */
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { moduleInstalled } from "../support/modules";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

async function englishContext(browser: Browser, baseURL: string, storageState: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("cde.productTour.v1", "done");
      localStorage.setItem("cde.language", "en");
    } catch {
      // Storage may be unavailable; the spec then fails visibly.
    }
  });
  return context;
}

type Part = { part: string; module: string | null; status: string; reason?: string };
type Folder = { id: string; name: string; state: string | null };

test("project templates: a project from the English ISO 19650 construction template", async ({ request, browser, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("E2E baseURL is not configured.");
  const s = randomUUID().slice(0, 6);
  const company = async (name: string) => (await ok<{ id: string }>(await request.post("/api/v1/companies", { data: { name: `${name} ${s}` } }), name)).id;
  const slotCompanies = {
    idare: await company("E2E Client"),
    musavir: await company("E2E Consultant"),
    tasarimci: await company("E2E Designer"),
    yuklenici: await company("E2E Contractor"),
  };

  // The template list offers it with its English name and its v2 parts.
  const list = await ok<{ id: string; name: string; parts: string[] }[]>(await request.get("/api/v1/templates?language=en"), "templates");
  const listed = list.find((t) => t.id === "iso19650-yapim-en");
  expect(listed?.name).toBe("ISO 19650 Construction Project (multi-party, English names)");
  expect(listed?.parts).toEqual(["roles", "issues", "transmittal", "rfi", "submittals", "meetings", "forms"]);

  const project = await ok<{ id: string; rootFolderId: string; parts: Part[]; issueTypes?: { category: string }[] }>(
    await request.post("/api/v1/projects/from-template", {
      data: { code: `ISO${s}`.toUpperCase(), name: `E2E Construction ${s}`, templateId: "iso19650-yapim-en", slotCompanies, language: "en" },
    }),
    "project from the construction template",
  );

  // Core parts applied; module parts applied by the module or skipped without it, never failed.
  const parts = Object.fromEntries(project.parts.map((p) => [p.part, p]));
  expect(parts.roles?.status).toBe("applied");
  expect(["applied", "partial"]).toContain(parts.issues?.status);
  expect(["applied", "partial"]).toContain(parts.transmittal?.status);
  for (const [part, module] of [["rfi", "manage"], ["submittals", "manage"], ["meetings", "manage"], ["forms", "field"]] as const) {
    const p = parts[part]!;
    expect(p.module).toBe(module);
    expect(p.status, part).not.toBe("failed");
    if (!moduleInstalled(module)) expect(p, part).toMatchObject({ status: "skipped", reason: "module_not_installed" });
  }
  expect(project.issueTypes?.map((g) => g.category)).toContain("Design coordination");

  // ISO 19650 rules are on.
  const cde = await ok<{ enforceTransitions: boolean; wipPolicy: string; containerStandardId: string | null }>(
    await request.get(`/api/v1/projects/${project.id}/cde/settings`),
    "CDE settings",
  );
  expect(cde).toMatchObject({ enforceTransitions: true, wipPolicy: "team_only" });
  expect(cde.containerStandardId).not.toBeNull();

  // The administrator sees the four state areas and the general folder, in English.
  const context = await englishContext(browser, baseURL, testInfo.project.use.storageState as string);
  try {
    const page = await context.newPage();
    await page.goto(`/projects/${project.id}/files/${project.rootFolderId}`);
    for (const name of ["00-GENERAL", "10-WORK IN PROGRESS (WIP)", "20-SHARED", "30-PUBLISHED", "40-ARCHIVED"]) {
      await expect(page.getByRole("row").filter({ hasText: name }).first()).toBeVisible();
    }
    const root = await ok<{ folders: Folder[] }>(await request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`), "root");
    const general = root.folders.find((f) => f.name === "00-GENERAL")!;
    await page.goto(`/projects/${project.id}/files/${general.id}`);
    await expect(page.getByRole("row").filter({ hasText: "03-BIM Execution Plan and Delivery Plans (BEP, MIDP, TIDP)" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "02-Information Requirements (OIR, AIR, PIR, EIR)" })).toBeVisible();
  } finally {
    await context.close();
  }
});
