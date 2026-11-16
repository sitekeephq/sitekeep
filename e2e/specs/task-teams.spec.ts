/**
 * ISO19650-2 5.1.7(e) / -1 12.2 task team WIP (ISO-5, docs/features/TASK_TEAMS.md): in a project
 * from the ISO 19650 template, a member of task team B cannot see task team A's WIP folder.
 * Core only: passes with and without Enterprise modules.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
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
      if (!localStorage.getItem("cde.language")) localStorage.setItem("cde.language", "tr");
    } catch {
      // Storage may be unavailable; the spec then fails visibly.
    }
  });
  await ok(await context.request.post("/api/v1/auth/login", { data: { email, password } }), `login ${email}`);
  return context;
}

type Folder = { id: string; name: string; state: string | null };

async function setUp(request: APIRequestContext) {
  const s = randomUUID().slice(0, 6);
  const companyA = await ok<{ id: string }>(await request.post("/api/v1/companies", { data: { name: `E2E Alfa ${s}`, code: `A${s}` } }), "company A");
  const companyB = await ok<{ id: string }>(await request.post("/api/v1/companies", { data: { name: `E2E Beta ${s}`, code: `B${s}` } }), "company B");
  const project = await ok<{ id: string; rootFolderId: string }>(
    await request.post("/api/v1/projects/from-template", {
      data: {
        code: `TT${s}`.toUpperCase(),
        name: `E2E Task Teams ${s}`,
        templateId: "iso19650-temel",
        slotCompanies: { tasarimci: companyA.id, yuklenici: companyB.id },
      },
    }),
    "project from the ISO template",
  );
  const users: Record<"a" | "b", { email: string; password: string }> = {
    a: { email: `e2e-team-a-${s}@7d-cde.localhost`, password: "Ekip-Bir!Gizli#2026" },
    b: { email: `e2e-team-b-${s}@7d-cde.localhost`, password: "Ekip-Iki!Gizli#2026" },
  };
  for (const [key, company] of [["a", companyA.id], ["b", companyB.id]] as const) {
    const u = users[key];
    await ok(await request.post("/api/v1/users", { data: { email: u.email, name: `E2E Team ${key.toUpperCase()} ${s}`, password: u.password, companyId: company } }), "user");
    await ok(await request.post(`/api/v1/projects/${project.id}/members`, { data: { email: u.email } }), "membership");
  }
  const root = await ok<{ folders: Folder[] }>(await request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`), "root");
  const wip = root.folders.find((f) => f.state === "wip")!;
  const inWip = await ok<{ folders: Folder[] }>(await request.get(`/api/v1/projects/${project.id}/folders/${wip.id}/contents`), "wip");
  const wipA = inWip.folders.find((f) => f.name === "Tasarımcı")!;
  return { project, users, wip, wipA };
}

test("ISO19650-2 5.1.7(e) / -1 12.2 task team WIP: a member of task team B cannot see task team A's WIP folder", async ({ request, browser, baseURL }) => {
  if (!baseURL) throw new Error("E2E baseURL is not configured.");
  const { project, users, wip, wipA } = await setUp(request);

  const a = await userContext(browser, baseURL, users.a.email, users.a.password);
  const b = await userContext(browser, baseURL, users.b.email, users.b.password);
  try {
    // Team A works in its WIP folder.
    const form = { file: { name: "alfa-wip-taslak.txt", mimeType: "text/plain", buffer: Buffer.from("A") } };
    await ok(await a.request.post(`/api/v1/projects/${project.id}/folders/${wipA.id}/files`, { multipart: form }), "upload by team A");

    // Team B: the WIP folder lists its own area, not team A's; the folder itself is not found.
    const pageB = await b.newPage();
    await pageB.goto(`/projects/${project.id}/files/${wip.id}`);
    await expect(pageB.getByRole("row").filter({ hasText: "Yüklenici" })).toBeVisible();
    await expect(pageB.getByRole("row").filter({ hasText: "Tasarımcı" })).toHaveCount(0);
    expect((await b.request.get(`/api/v1/projects/${project.id}/folders/${wipA.id}`)).status()).toBe(404);
    const search = await ok<{ results: unknown[] }>(await b.request.get(`/api/v1/projects/${project.id}/search?q=alfa-wip`), "search by team B");
    expect(search.results).toHaveLength(0);

    // Team A sees its folder and file.
    const pageA = await a.newPage();
    await pageA.goto(`/projects/${project.id}/files/${wipA.id}`);
    await expect(pageA.getByText("alfa-wip-taslak.txt", { exact: true })).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
