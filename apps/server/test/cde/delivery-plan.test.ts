/**
 * ISO19650-2 5.4.4 / 5.4.5 delivery plan (ISO-7, docs/features/DELIVERY_PLAN.md): milestones seeded
 * from the template, a TIDP per task team (planned codes checked against the naming standard), the
 * MIDP for project administrators, the status of each deliverable from the CDE (not started, WIP,
 * Shared, Published) and the late rule, the task-team rules for viewing and editing, XLSX / CSV
 * export and import, and the audit events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, like } from "drizzle-orm";
import type { DeliverableDto, DeliveryPlanDto, ProjectRoleDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { readXlsx, writeXlsx } from "../../src/core/formats/xlsx.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-midp-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string) => {
      const form = new FormData();
      form.append("file", new Blob([`%PDF-1.4 ${name} ${Math.random()}`]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "accept-language": "en", "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

describe("ISO19650-2 5.4.4 / 5.4.5 delivery plan (TIDP, MIDP)", () => {
  let admin: Api, ua: Api, ub: Api;
  const ids: Record<string, string> = {};
  let pid: string;
  let teamA: string, teamB: string;
  let wipA: string, sharedId: string, publishedId: string;
  let m1: string;
  const P = () => `/projects/${pid}/delivery-plan`;
  const CODE_A = "DP1-ALF-ZZ-ZZ-DR-A-0001";
  const CODE_B = "DP1-BET-ZZ-ZZ-RP-S-0001";
  const plan = async (who: Api, q = ""): Promise<DeliveryPlanDto> => {
    const r = await who.get(`${P()}${q}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const row = (p: DeliveryPlanDto, code: string): DeliverableDto | undefined => p.deliverables.find((d) => d.code === code);

  it("seeds the template's milestones into a new project (deliveryPlan block)", async () => {
    admin = api(await login("admin@7d.test"));
    ids.A = (await admin.post("/companies", { name: "Alfa Tasarım", code: "ALF" })).body.id;
    ids.B = (await admin.post("/companies", { name: "Beta Yapı", code: "BET" })).body.id;
    const r = await admin.post("/projects/from-template", { code: "DP1", name: "Delivery plan", templateId: "iso19650-temel", slotCompanies: { tasarimci: ids.A, yuklenici: ids.B } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pid = r.body.id;
    const p = await plan(admin);
    expect(p.canManage).toBe(true);
    expect(p.milestones.map((m) => m.code)).toEqual(["M1", "M2", "M3", "M4"]);
    // Dated from the project's creation: M1 90 days on.
    const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    expect(p.milestones[0]!.dueDate).toBe(in90);
    m1 = p.milestones[0]!.id;

    const teams = ((await admin.get(`/projects/${pid}/roles`)).body as ProjectRoleDto[]).filter((t) => t.kind === "task_team");
    teamA = teams.find((t) => t.companyId === ids.A)!.id;
    teamB = teams.find((t) => t.companyId === ids.B)!.id;
    expect(p.teams.map((t) => t.id).sort()).toEqual([teamA, teamB].sort());

    const root = await admin.get(`/projects/${pid}/folders/${r.body.rootFolderId}/contents`);
    const byState = (s: string) => root.body.folders.find((f: { state: string }) => f.state === s).id;
    sharedId = byState("shared");
    publishedId = byState("published");
    const wip = await admin.get(`/projects/${pid}/folders/${byState("wip")}/contents`);
    wipA = wip.body.folders.find((f: { name: string }) => f.name === "Tasarımcı").id;

    for (const [key, company] of [["ua", ids.A], ["ub", ids.B]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@dp.test`, name: key, password: PW, companyId: company })).body.id;
      expect((await admin.post(`/projects/${pid}/members`, { email: `${key}@dp.test` })).status).toBe(200);
    }
    ua = api(await login("ua@dp.test"));
    ub = api(await login("ub@dp.test"));
  });

  it("lets project administrators manage milestones; others may not", async () => {
    const c = await admin.post(`${P()}/milestones`, { code: "M0", name: "Mobilisation", dueDate: "2020-01-15" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await admin.post(`${P()}/milestones`, { name: "mobilisation" })).status).toBe(409);
    expect((await admin.patch(`${P()}/milestones/${c.body.id}`, { dueDate: "2020-02-01" })).body.dueDate).toBe("2020-02-01");
    expect((await admin.post(`${P()}/milestones`, { name: "Bad", dueDate: "2020-02-31" })).status).toBe(400);
    expect((await ua.post(`${P()}/milestones`, { name: "X" })).status).toBe(403);
    expect((await admin.del(`${P()}/milestones/${c.body.id}`)).status).toBe(200);
  });

  it("sets a team's lead among its members", async () => {
    expect((await admin.put(`${P()}/teams/${teamA}/lead`, { userId: ids.ub })).status).toBe(400);
    expect((await ua.put(`${P()}/teams/${teamA}/lead`, { userId: ids.ua })).status).toBe(403);
    expect((await admin.put(`${P()}/teams/${teamA}/lead`, { userId: ids.ua })).status).toBe(200);
    const t = (await plan(admin)).teams.find((x) => x.id === teamA)!;
    expect([t.leadUserId, t.leadName]).toEqual([ids.ua, "ua"]);
  });

  it("checks planned codes against the naming standard and keeps them unique (§5.4.3)", async () => {
    const bad = await ua.post(`${P()}/deliverables`, { teamId: teamA, code: "DP1-XXX-ZZ-ZZ-DR-A-0001", title: "Ground floor plan" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("ISO 19650 Kodlama");
    const ok = await ua.post(`${P()}/deliverables`, {
      teamId: teamA,
      code: CODE_A.toLowerCase(),
      title: "Ground floor plan",
      discipline: "A",
      docType: "DR",
      targets: [{ milestoneId: m1, suitabilityCode: "s2", revisionCode: "p1" }],
      dueShared: "2020-03-01",
      duePublished: "2020-04-01",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ teamId: teamA, status: "not_started", late: "published", canEdit: true, targets: [{ milestoneId: m1, suitabilityCode: "S2", revisionCode: "P01" }] });
    expect((await admin.post(`${P()}/deliverables`, { teamId: teamA, code: CODE_A, title: "Again" })).status).toBe(409);
    expect((await ua.post(`${P()}/deliverables`, { teamId: teamA, code: "DP1-ALF-ZZ-ZZ-DR-A-0002", title: "X", targets: [{ milestoneId: m1, suitabilityCode: "Q9" }] })).status).toBe(400);
    expect((await ua.post(`${P()}/deliverables`, { teamId: teamA, code: "DP1-ALF-ZZ-ZZ-DR-A-0002", title: "X", dueShared: "2020-05-01", duePublished: "2020-04-01" })).status).toBe(400);
  });

  it("lets the team's lead edit its TIDP only; members see their own team's TIDP, administrators the MIDP", async () => {
    // ua leads team A, not team B.
    expect((await ua.post(`${P()}/deliverables`, { teamId: teamB, code: CODE_B, title: "Structural report" })).status).toBe(403);
    const b = await admin.post(`${P()}/deliverables`, { teamId: teamB, code: CODE_B, title: "Structural report", dueShared: "2099-01-01" });
    expect(b.status).toBe(200);
    // ub is a member of team B but not its lead.
    expect((await ub.patch(`${P()}/deliverables/${b.body.id}`, { title: "Renamed" })).status).toBe(403);

    const asB = await plan(ub);
    expect(asB.canManage).toBe(false);
    expect(asB.deliverables.map((d) => d.code)).toEqual([CODE_B]);
    expect(asB.teams.map((t) => t.id)).toEqual([teamB]);
    expect(asB.deliverables[0]!.canEdit).toBe(false);
    const a = row(await plan(admin), CODE_A)!;
    expect((await ub.patch(`${P()}/deliverables/${a.id}`, { title: "Hijack" })).status).toBe(403);

    const asA = await plan(ua);
    expect(asA.deliverables.map((d) => d.code)).toEqual([CODE_A]);
    expect((await plan(admin)).deliverables.map((d) => d.code).sort()).toEqual([CODE_A, CODE_B].sort());
    expect((await plan(admin, `?teamId=${teamB}`)).deliverables.map((d) => d.code)).toEqual([CODE_B]);
    const patched = await ua.patch(`${P()}/deliverables/${a.id}`, { notes: "Coordinated with structure" });
    expect(patched.body.notes).toBe("Coordinated with structure");
  });

  it("computes the status from the CDE: WIP, Shared, Published; late when a due date passed (§5.4.4)", async () => {
    const up = await ua.upload(`/projects/${pid}/folders/${wipA}/files`, `${CODE_A}.pdf`);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const fileId = up.body.results[0].fileId;
    let d = row(await plan(ua), CODE_A)!;
    expect(d).toMatchObject({ status: "wip", late: "published", registered: true, document: { state: "wip", fileId, name: `${CODE_A}.pdf`, suitabilityCode: "S0" } });

    const toShared = await admin.post(`/projects/${pid}/files/${fileId}/transition`, { toFolderId: sharedId, reason: "Test" });
    expect(toShared.status, JSON.stringify(toShared.body)).toBe(200);
    d = row(await plan(ua), CODE_A)!;
    expect([d.status, d.late]).toEqual(["shared", "published"]);
    expect((await admin.post(`/projects/${pid}/files/${fileId}/transition`, { toFolderId: publishedId, reason: "Test" })).status).toBe(200);
    d = row(await plan(ua), CODE_A)!;
    expect([d.status, d.late, d.document?.state]).toEqual(["published", null, "published"]);

    const b = row(await plan(admin), CODE_B)!;
    expect([b.status, b.late, b.registered, b.document]).toEqual(["not_started", null, false, null]);
  });

  it("withholds the document of a team's WIP from callers the task-team rule keeps out (§5.1.7(e))", async () => {
    await ua.post(`${P()}/deliverables`, { teamId: teamA, code: "DP1-ALF-ZZ-ZZ-DR-A-0003", title: "Section" });
    const up = await ua.upload(`/projects/${pid}/folders/${wipA}/files`, "DP1-ALF-ZZ-ZZ-DR-A-0003.pdf");
    expect(up.status).toBe(200);
    expect((await admin.put(`/projects/${pid}/cde/settings`, { adminSeesWip: false })).status).toBe(200);
    const hidden = row(await plan(admin), "DP1-ALF-ZZ-ZZ-DR-A-0003")!;
    expect(hidden.status).toBe("wip");
    expect(hidden.document).toEqual({ state: "wip", suitabilityCode: "S0", revisionCode: expect.any(String) });
    expect(row(await plan(ua), "DP1-ALF-ZZ-ZZ-DR-A-0003")!.document?.fileId).toBe(up.body.results[0].fileId);
    expect((await admin.put(`/projects/${pid}/cde/settings`, { adminSeesWip: true })).status).toBe(200);
  });

  it("exports the plan as XLSX and CSV with a column per milestone", async () => {
    const x = await admin.get(`${P()}/export?format=xlsx`);
    expect(x.status).toBe(200);
    expect(String(x.headers["content-disposition"])).toContain("DP1-delivery-plan.xlsx");
    const table = readXlsx(x.raw);
    expect(table[0]!.slice(0, 6)).toEqual(["Document Code", "Title", "Task Team", "Discipline", "Type", "M1 · Concept Design"]);
    const a = table.find((r) => r[0] === CODE_A)!;
    expect(a[5]).toBe("S2 / P01");
    expect(a).toContain("Published");
    const csv = await ub.get(`${P()}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.raw)).toContain(CODE_B);
    expect(String(csv.raw)).not.toContain(CODE_A);
  });

  it("imports a plan: a dry run reports, a file with errors writes nothing, a clean file creates and updates", async () => {
    const sheet = async (rows: (string | number)[][]) =>
      (
        await writeXlsx([
          { name: "Plan", columns: ["Document Code", "Title", "Task Team", "M1", "Due Shared", "Due Published"].map((title) => ({ title })), rows },
        ])
      ).toString("base64");
    const rows = [
      [CODE_A, "Ground floor plan", "Alfa Tasarım", "S3 / P02", "", ""],
      ["DP1-ALF-ZZ-ZZ-DR-A-0010", "First floor plan", "ALF", "S2", "15.06.2027", 46600],
      ["DP1-BET-ZZ-ZZ-RP-S-0002", "Calculation", "Beta Yapı", "", "", ""],
    ];
    // ua leads team A, not team B: the third row is refused.
    const refused = await ua.post(`${P()}/import`, { fileName: "plan.xlsx", content: await sheet(rows) });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ applied: false, created: 1, updated: 1, errors: [{ row: 4 }] });
    expect(refused.body.errors[0].message).toContain("Beta Yapı");
    expect(row(await plan(admin), "DP1-ALF-ZZ-ZZ-DR-A-0010")).toBeUndefined();

    const dry = await admin.post(`${P()}/import`, { fileName: "plan.xlsx", content: await sheet(rows), dryRun: true });
    expect(dry.body).toMatchObject({ applied: false, created: 2, updated: 1, errors: [] });
    expect(row(await plan(admin), "DP1-ALF-ZZ-ZZ-DR-A-0010")).toBeUndefined();

    const bad = await admin.post(`${P()}/import`, { fileName: "plan.xlsx", content: await sheet([...rows, ["NOT-A-CODE", "x", "ALF", "", "", ""], ["DP1-ALF-ZZ-ZZ-DR-A-0011", "y", "ALF", "", "31.02.2027", ""]]) });
    expect(bad.body.applied).toBe(false);
    expect(bad.body.errors.map((e: { row: number }) => e.row)).toEqual([5, 6]);

    const done = await ua.post(`${P()}/import`, { fileName: "plan.xlsx", content: await sheet(rows.slice(0, 2)) });
    expect(done.body).toMatchObject({ applied: true, created: 1, updated: 1, errors: [] });
    const p = await plan(admin);
    expect(row(p, CODE_A)!.targets).toEqual([{ milestoneId: m1, suitabilityCode: "S3", revisionCode: "P02" }]);
    expect(row(p, "DP1-ALF-ZZ-ZZ-DR-A-0010")).toMatchObject({ teamId: teamA, dueShared: "2027-06-15", duePublished: "2027-08-01", targets: [{ milestoneId: m1, suitabilityCode: "S2", revisionCode: null }] });

    // CSV with Turkish headers, into team B's TIDP (no team column).
    const csv = "﻿Doküman Kodu;Başlık;Paylaşım Teslim Tarihi\r\nDP1-BET-ZZ-ZZ-RP-S-0002;Hesap raporu;2027-01-10\r\n";
    const r = await admin.post(`${P()}/import`, { fileName: "tidp.csv", content: Buffer.from(csv).toString("base64"), teamId: teamB });
    expect(r.body).toMatchObject({ applied: true, created: 1 });
    expect(row(await plan(ub), "DP1-BET-ZZ-ZZ-RP-S-0002")).toMatchObject({ title: "Hesap raporu", dueShared: "2027-01-10" });
    expect((await admin.post(`${P()}/import`, { fileName: "plan.pdf", content: "eA==" })).status).toBe(400);
  });

  it("records every change in the audit log (delivery_plan.*)", async () => {
    const del = row(await plan(admin), CODE_B)!;
    expect((await ub.del(`${P()}/deliverables/${del.id}`)).status).toBe(403);
    expect((await admin.del(`${P()}/deliverables/${del.id}`)).status).toBe(200);
    const actions = (await handle.db.select({ action: auditLog.action }).from(auditLog).where(and(eq(auditLog.projectId, pid), like(auditLog.action, "delivery_plan.%")))).map((r) => r.action);
    expect(new Set(actions)).toEqual(
      new Set([
        "delivery_plan.milestone_created",
        "delivery_plan.milestone_updated",
        "delivery_plan.milestone_deleted",
        "delivery_plan.lead_set",
        "delivery_plan.deliverable_created",
        "delivery_plan.deliverable_updated",
        "delivery_plan.deliverable_deleted",
        "delivery_plan.exported",
        "delivery_plan.imported",
      ]),
    );
  });

  it("carries the milestones in an exported template", async () => {
    const r = await admin.get(`/projects/${pid}/export-template`);
    expect(r.status).toBe(200);
    expect(r.body.deliveryPlan.milestones.map((m: { code: string }) => m.code)).toEqual(["M1", "M2", "M3", "M4"]);
    expect(r.body.deliveryPlan.milestones[0].offsetDays).toBe(90);
  });
});
