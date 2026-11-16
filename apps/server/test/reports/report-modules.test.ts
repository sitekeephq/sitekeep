/**
 * Module report datasets (works, reviews, forms, locations, schedule, clashes, comparisons, spec
 * registers), change stamps and the MCP tools over them (Community). The report builder's side
 * (router, prompt, templates, dashboards, repair) is in test/modules/platform.
 */
import { hasCoordinate, hasField, hasManage, hasPlanning } from "../helpers/modules.js"; // these steps use Field (forms), Coordinate (clashes) and Planning (schedule)

const hasModules = hasField && hasCoordinate && hasPlanning;
import { moduleTable } from "../../src/app/modules.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { REPORT_MODULES, isTitleCaseTr, type ReportRow } from "@sitekeep/shared";
import { cdeParseArgs, cdeResult, cdeToolDefinitions, type CdeCall } from "@sitekeep/cde-tools";
// The AI module's internals load only when it is installed (a Community install has none).
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import {
  docComparisons,
  fileVersions,
  files,
  modelSets,
  reportChangeStamps,
  specRegisters,
  users,
} from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { reportDatasets } from "../../src/reports/all.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(path.join(here, "../fixtures", n));
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-repmod-"));
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

function api(cookie: string, target: () => FastifyInstance = () => app) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await target().inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, name: string, data: string | Buffer, fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await target().inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Client = ReturnType<typeof api>;

const RFI_FIELDS = { soru: "Kolon ölçüsü nedir?", kategori: "Tasarım Koordinasyonu", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Var" };

// ---- Pure: router and prompt ----------------------------------------------------------------------

describe("module datasets", () => {
  const catalog = reportDatasets.describe();
  const names = catalog.map((d) => d.name);

  it.skipIf(!hasModules || !hasManage)("registers a dataset for every module family, with Turkish Title Case labels", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "works", "correspondence", "rfis", "submittals", "meetings", "actions", "transmittals",
        "reviews", "review_files", "workflow_steps", "forms", "locations", "schedule_activities",
        "clash_results", "doc_comparisons", "spec_registers",
      ]),
    );
    for (const m of REPORT_MODULES) expect(catalog.some((d) => d.module === m), m).toBe(true);
    const labels = catalog.flatMap((d) => [d.label, ...d.fields.map((f) => f.label)]);
    expect(labels.filter((l) => !isTitleCaseTr(l))).toEqual([]);
  });

});

// ---- API with seeded module data -------------------------------------------------------------------

describe.skipIf(!hasModules)("module datasets and live refresh", () => {
  // Field's forms table (the suite runs only with Field installed).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forms = moduleTable<any>("field", "forms")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clashTests = moduleTable<any>("coordinate", "clashTests")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clashes = moduleTable<any>("coordinate", "clashes")!;
  let admin: Client, semih: Client, aytug: Client, zeynep: Client, murat: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let semihCookie: string;
  let wipId: string;
  let cnsFolder: string;
  let versionId: string;
  const P = () => `/projects/${pid}`;
  const q = (c: Client, queries: unknown[], extra: object = {}) => c.post(`${P()}/reports/query`, { queries, strict: false, ...extra });
  const rows = async (c: Client, dataset: string, extra: object = {}) => {
    const r = await q(c, [{ id: "x", dataset, ...extra }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.errors, dataset).toEqual({});
    return r.body.results.x as ReportRow[];
  };

  it.skipIf(!hasManage)("sets up a project with works, a review, forms, locations, a schedule, clashes and comparisons", async () => {
    admin = api(await login("admin@7d.test"));
    for (const c of ["CNS", "HLL", "ZRT", "DIS"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects", { code: "RPM", name: "Rapor Modülleri" });
    pid = p.body.id;
    for (const [key, company, name] of [
      ["semih", "CNS", "Semih"],
      ["aytug", "HLL", "Aytuğ"],
      ["zeynep", "ZRT", "Zeynep"],
      ["murat", "DIS", "Murat"],
    ] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@r.test`, name, password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@r.test` })).status).toBe(200);
    }
    semihCookie = await login("semih@r.test");
    semih = api(semihCookie);
    aytug = api(await login("aytug@r.test"));
    zeynep = api(await login("zeynep@r.test"));
    murat = api(await login("murat@r.test"));
    const root = (await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`)).body;
    wipId = root.folders[0].id;
    cnsFolder = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "CNS" })).body.id;
    await admin.put(`${P()}/folders/${cnsFolder}/permissions`, { entries: [{ subjectType: "company", subjectId: ids.CNS, level: "edit" }] });
    expect((await semih.upload(`${P()}/folders/${cnsFolder}/files`, "M-101.pdf", "pafta")).status).toBe(200);
    versionId = (await semih.get(`${P()}/folders/${cnsFolder}/contents`)).body.files[0].latest.id;

    // Correspondence: an overdue letter awaiting a reply from HLL, and a draft.
    const letter = await semih.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Şaft ölçüleri", toCompanyIds: [ids.HLL], replyRequired: true, dueDate: "2020-01-15" });
    expect(letter.status, JSON.stringify(letter.body)).toBe(200);
    expect((await semih.post(`${P()}/works/${letter.body.id}/send`, { channel: "cde" })).status).toBe(200);
    expect((await semih.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Taslak yazı", toCompanyIds: [ids.HLL] })).status).toBe(200);

    // RFI with a workflow: ball in court HLL.
    const tpl = await admin.post(`${P()}/workflow-templates`, {
      kind: "rfi",
      name: "RFI: Müşavir",
      steps: [{ name: "Müşavir", assignees: [{ type: "company", id: ids.HLL }], rule: "any", days: 3, outcomes: ["reviewed", "revise_resubmit"] }],
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const rfiType = (await admin.get(`${P()}/work-types`)).body.find((t: any) => t.key === "rfi");
    expect((await admin.put(`${P()}/work-types/${rfiType.id}`, { defaultWorkflowTemplateId: tpl.body.id })).status).toBe(200);
    const rfi = await semih.post(`${P()}/works`, { typeKey: "rfi", title: "Kolon ölçüsü", fields: { ...RFI_FIELDS, disiplin: "S - Statik" }, toCompanyIds: [ids.HLL] });
    expect(rfi.status, JSON.stringify(rfi.body)).toBe(200);
    expect((await semih.post(`${P()}/works/${rfi.body.id}/submit`, {})).status).toBe(200);

    // Submittal item: submitted, revise → rev 1.
    const sub = await semih.post(`${P()}/works`, {
      typeKey: "submittal-kalemi",
      title: "Klima santrali",
      fields: { tur: "MOS - Malzeme Onay", disiplin: "M - Mekanik", bolum_kodu: "23 73 00" },
      toCompanyIds: [ids.HLL],
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect((await semih.post(`${P()}/works/${sub.body.id}/submit`, {})).status).toBe(200);
    expect((await aytug.post(`${P()}/works/${sub.body.id}/respond`, { outcome: "revise_resubmit", comment: "Eksik" })).status).toBe(200);

    // Meeting with minutes → two actions (one overdue, responsible HLL).
    const mt = await semih.post(`${P()}/works`, { typeKey: "toplanti", title: "Koordinasyon 1", fields: { tur: "Koordinasyon", tarih: "2026-09-01" } });
    expect(mt.status, JSON.stringify(mt.body)).toBe(200);
    const min = await semih.put(`${P()}/works/${mt.body.id}/minutes`, {
      items: [
        { konu: "Şaft detayı gönderilecek", sorumluCompanyId: ids.HLL, termin: "2020-02-01" },
        { konu: "İSG eğitimi", sorumluUserId: ids.semih, termin: "2099-01-01" },
      ],
    });
    expect(min.status, JSON.stringify(min.body)).toBe(200);

    // Transmittal draft with one file.
    const tr = await semih.post(`${P()}/works`, {
      typeKey: "transmittal",
      title: "Pafta gönderimi",
      fields: { amac: "onay" },
      toCompanyIds: [ids.HLL],
      links: [{ kind: "file_version", targetId: versionId, role: "ek" }],
    });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);

    // Review of the CNS drawing (HLL step).
    const rt = await admin.post(`${P()}/workflow-templates`, {
      kind: "review",
      name: "CNS → HLL",
      steps: [{ name: "Müşavir İncelemesi", assignees: [{ type: "company", id: ids.HLL }], rule: "any", days: 2, outcomes: ["approved", "rejected"] }],
    });
    expect(rt.status, JSON.stringify(rt.body)).toBe(200);
    const rv = await semih.post(`${P()}/reviews`, { name: "Mekanik set", templateId: rt.body.id, versionIds: [versionId] });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);

    // Locations and forms.
    const block = await admin.post(`${P()}/locations`, { name: "A Blok", code: "A", type: "Blok" });
    const floor = await admin.post(`${P()}/locations`, { parentId: block.body.id, name: "Kat 2", code: "A2", type: "Kat" });
    expect(floor.status, JSON.stringify(floor.body)).toBe(200);
    const ft = await admin.post(`${P()}/form-templates/from-library`, { key: "beton-dokum-onay" });
    expect(ft.status, JSON.stringify(ft.body)).toBe(200);
    const f1 = await semih.post(`${P()}/forms`, { templateId: ft.body.id, locationId: floor.body.id, formDate: "2026-10-01" });
    expect(f1.status, JSON.stringify(f1.body)).toBe(200);
    expect((await semih.post(`${P()}/forms`, { templateId: ft.body.id, formDate: "2026-10-02" })).status).toBe(200);
    await handle.db.update(forms).set({ failedCount: 2 }).where(eq(forms.id, f1.body.id));

    // Schedule (CSV) – the importer is project-admin only.
    const sch = await admin.upload(`${P()}/schedules`, "program.csv", fx("schedule.csv"));
    expect(sch.status, JSON.stringify(sch.body)).toBe(200);

    // Clash test over an IFC file only CNS can see (rows written directly).
    const ifc = await semih.upload(`${P()}/folders/${cnsFolder}/files`, "MEP.ifc", fx("coord-mep.ifc"));
    expect(ifc.status).toBe(200);
    const ifcFile = (await semih.get(`${P()}/folders/${cnsFolder}/contents`)).body.files.find((f: any) => f.name === "MEP.ifc");
    const [set] = await handle.db.insert(modelSets).values({ projectId: pid, name: "Koordinasyon", items: [{ fileId: ifcFile.id, versionId: null }] }).returning();
    const [test] = await handle.db
      .insert(clashTests)
      .values({ projectId: pid, modelSetId: set!.id, name: "Mekanik × Yapı", selectionA: { fileIds: [], classes: [] }, selectionB: { fileIds: [], classes: [] } })
      .returning();
    const clash = (id: string, status: "new" | "active" | "resolved", classB: string) => ({
      id, testId: test!.id, fileA: ifcFile.id, versionA: ifcFile.latest.id, guidA: `g${id}a`, classA: "IfcDuctSegment", storeyA: "Kat 2",
      fileB: ifcFile.id, versionB: ifcFile.latest.id, guidB: `g${id}b`, classB, point: [0, 0, 0] as [number, number, number], distance: 0.05, status,
    });
    await handle.db.insert(clashes).values([clash("c1", "new", "IfcBeam"), clash("c2", "active", "IfcBeam"), clash("c3", "resolved", "IfcWall")]);

    // A document comparison with a revision warning, and a spec register (written directly).
    expect((await semih.upload(`${P()}/folders/${cnsFolder}/files`, "M-101.pdf", "pafta v2")).status).toBe(200);
    const pdf = (await semih.get(`${P()}/folders/${cnsFolder}/contents`)).body.files.find((f: any) => f.name === "M-101.pdf");
    const [v1] = await handle.db.select().from(fileVersions).where(and(eq(fileVersions.fileId, pdf.id), eq(fileVersions.version, 1)));
    await handle.db.insert(docComparisons).values({
      projectId: pid,
      fromVersionId: v1!.id,
      toVersionId: pdf.latest.id,
      status: "done",
      result: {
        kind: "pdf", hasText: true, identical: false, pageCountA: 1, pageCountB: 1, pages: [], totals: { added: 3, removed: 1, changed: 2, pages: 1 },
        antet: [{ key: null, label: "Tarih", old: "01.09.2026", new: "01.10.2026" }], revisionA: "A", revisionB: "A",
        revisionTableA: null, revisionTableB: null, antetRegion: null, contentChanged: true,
      },
    });
    await handle.db.insert(specRegisters).values({
      projectId: pid,
      versionId: pdf.latest.id,
      items: [
        { id: "S001", sectionCode: "23 73 00", sectionTitle: "Klima Santralleri", page: 4, description: "Teknik föy – Klima santrali", excerpt: "…", type: "MOS", typeConfidence: 1, discipline: "MEK", keywords: [] },
        { id: "S002", sectionCode: "23 73 00", sectionTitle: "Klima Santralleri", page: 5, description: "Numune – Filtre", excerpt: "…", type: "NUM", typeConfidence: 1, discipline: "MEK", keywords: [] },
      ],
      sectionCount: 1,
      pageCount: 10,
    });
  });

  it.skipIf(!hasManage)("works datasets: sıradaki taraf, overdue, letters, RFIs, submittals, meetings and actions", async () => {
    const corr = await rows(semih, "correspondence", { sort: [{ field: "title" }] });
    expect(corr.map((r) => r.title)).toEqual(["Şaft ölçüleri", "Taslak yazı"]);
    expect(corr[0]).toMatchObject({ direction: "giden", toCompany: "HLL", counterparty: "HLL", awaitingReply: true, overdue: true, ballInCourt: "HLL", deliveryChannel: "cde", isOpen: true });
    expect(typeof corr[0]!.daysOverdue).toBe("number");
    // The addressee sees the sent letter but not the draft; an outsider sees neither.
    expect((await rows(aytug, "correspondence")).map((r) => r.title)).toEqual(["Şaft ölçüleri"]);
    expect(await rows(murat, "correspondence")).toEqual([]);

    const rfis = await rows(semih, "rfis");
    expect(rfis).toHaveLength(1);
    expect(rfis[0]).toMatchObject({ ballInCourt: "HLL", discipline: "S - Statik", rfiCategory: "Tasarım Koordinasyonu", isOpen: true, answered: false, revisionCount: 1 });
    expect(rfis[0]!.daysOpen).toBe(0);
    expect(await rows(murat, "rfis")).toEqual([]);

    const subs = await rows(semih, "submittals");
    expect(subs[0]).toMatchObject({ kind: "MOS", sectionCode: "23 73 00", outcome: "revise_resubmit", decided: true, ballInCourt: "CNS", rev: 0 });

    const meetings = await rows(semih, "meetings");
    expect(meetings[0]).toMatchObject({ title: "Koordinasyon 1", kind: "Koordinasyon", date: "2026-09-01", actionCount: 2, openActionCount: 2, minutesItemCount: 2 });
    const actions = await rows(semih, "actions", { sort: [{ field: "dueDate" }] });
    expect(actions.map((a) => [a.title, a.responsibleCompany, a.overdue, a.meeting])).toEqual([
      ["Şaft detayı gönderilecek", "HLL", true, meetings[0]!.number],
      ["İSG eğitimi", "CNS", false, meetings[0]!.number],
    ]);

    const tr = await rows(semih, "transmittals");
    expect(tr[0]).toMatchObject({ purpose: "onay", fileCount: 1, received: false, toCompany: "HLL" });

    const all = await rows(admin, "works", { groupBy: ["category"], sort: [{ field: "category" }] });
    expect(Object.fromEntries(all.map((r) => [r.category, r.count]))).toMatchObject({ correspondence: 2, rfi: 1, submittal: 1, meeting: 1, action: 2, transmittal: 1 });
    // Works visibility: the outsider sees nothing of these.
    for (const ds of ["works", "submittals", "meetings", "actions", "transmittals"]) expect(await rows(murat, ds), ds).toEqual([]);
    // The addressee (HLL) sees the submitted RFI and submittal, not CNS's draft letter or meeting.
    expect((await rows(aytug, "rfis")).length).toBe(1);
    expect((await rows(aytug, "submittals")).length).toBe(1);
    // Not a project member: no data at all.
    const stranger = (await admin.post("/users", { email: "yabanci@r.test", name: "Yabancı", password: PW })).body.id;
    expect(stranger).toBeTruthy();
    const out = api(await login("yabanci@r.test"));
    expect((await q(out, [{ id: "x", dataset: "forms" }])).status).toBe(404);
  });

  it.skipIf(!hasManage)("reviews, review files and workflow steps (kim ne kadar bekletti)", async () => {
    const r = await rows(semih, "reviews");
    expect(r[0]).toMatchObject({ name: "Mekanik set", status: "running", isOpen: true, currentStep: "Müşavir İncelemesi", stepNo: 1, fileCount: 1, startedByCompany: "CNS" });
    expect(await rows(murat, "reviews")).toEqual([]);
    expect((await rows(aytug, "reviews")).length).toBe(1); // step assignee
    const rf = await rows(semih, "review_files");
    expect(rf[0]).toMatchObject({ review: r[0]!.number, file: "M-101.pdf", decided: false, outcome: null });

    const steps = await rows(admin, "workflow_steps", { sort: [{ field: "subjectType" }, { field: "startedAt" }] });
    expect(steps.map((s) => [s.subjectType, s.stepName, s.status, s.responsibleCompany])).toEqual(
      expect.arrayContaining([
        ["review", "Müşavir İncelemesi", "running", "HLL"],
        ["rfi", "Müşavir", "running", "HLL"],
        ["submittal", expect.any(String), "done", expect.anything()],
      ]),
    );
    expect(steps.every((s) => typeof s.days === "number")).toBe(true);
    // Semih sees his RFI / submittal / review steps; the outsider sees none.
    expect((await rows(semih, "workflow_steps")).length).toBe(steps.length);
    expect(await rows(murat, "workflow_steps")).toEqual([]);
  });

  it.skipIf(!hasManage)("forms, locations, schedule, clashes, comparisons and spec registers", async () => {
    const fr = await rows(murat, "forms", { sort: [{ field: "formDate" }] });
    expect(fr.map((f) => [f.location, f.locationTop, f.failedCount, f.hasFailures, f.status])).toEqual([
      ["A A Blok / A2 Kat 2", "A A Blok", 2, true, "draft"],
      [null, null, 0, false, "draft"],
    ]);
    const loc = await rows(semih, "locations", { sort: [{ field: "level" }] });
    expect(loc.map((l) => [l.name, l.level, l.parent, l.formCount, l.failedItemCount])).toEqual([
      ["A Blok", 1, null, 0, 0],
      ["Kat 2", 2, "A Blok", 1, 2],
    ]);

    const acts = await rows(semih, "schedule_activities", { filters: [{ field: "summary", op: "eq", value: false }] });
    expect(acts.length).toBeGreaterThan(2);
    expect(acts[0]).toMatchObject({ schedule: expect.any(String), version: 1, code: expect.any(String) });
    expect(acts.some((a) => a.critical === true)).toBe(true);
    expect(acts.every((a) => ["not_started", "in_progress", "complete", "late"].includes(String(a.status)))).toBe(true);

    const cl = await rows(semih, "clash_results", { groupBy: ["classPair", "isOpen"], sort: [{ field: "classPair" }] });
    expect(cl).toEqual([
      { classPair: "IfcDuctSegment × IfcBeam", isOpen: true, count: 2 },
      { classPair: "IfcDuctSegment × IfcWall", isOpen: false, count: 1 },
    ]);
    // The IFC file is in a CNS-only folder: the test is hidden from others.
    expect(await rows(murat, "clash_results")).toEqual([]);

    const dc = await rows(semih, "doc_comparisons");
    expect(dc[0]).toMatchObject({ file: "M-101.pdf", fromVersion: 1, toVersion: 2, antetChanges: 1, pagesChanged: 1, contentChanged: true });
    expect(dc[0]!.warningCount).toBeGreaterThan(0);
    expect(await rows(murat, "doc_comparisons")).toEqual([]);

    const sr = await rows(semih, "spec_registers");
    expect(sr.map((s) => [s.sectionCode, s.kind, s.page])).toEqual([
      ["23 73 00", "MOS", 4],
      ["23 73 00", "NUM", 5],
    ]);
    expect(await rows(murat, "spec_registers")).toEqual([]);
  });

  it.skipIf(!hasManage)("bumps the change stamp on writes, not on reads", async () => {
    const stampRows = async () =>
      Object.fromEntries(
        (await handle.db.select().from(reportChangeStamps).where(eq(reportChangeStamps.projectId, pid))).map((r) => [r.scope, r.counter]),
      );
    const stamp = async () => (await semih.get(`${P()}/reports/stamp?datasets=correspondence`)).body;
    const s0 = await stamp();
    expect(s0.stamp).toMatch(/^members:\d+,works:\d+\|\d{4}-\d{2}-\d{2}$/);
    expect(s0.changedAt).toBeTruthy();

    // Reads (lists, details, report data, other datasets) change nothing.
    const before = await stampRows();
    await semih.get(`${P()}/works`);
    await semih.get(`${P()}/reviews`);
    await semih.get(`${P()}/forms`);
    await q(admin, [{ id: "a", dataset: "workflow_steps" }, { id: "b", dataset: "schedule_activities" }, { id: "c", dataset: "clash_results" }]);
    expect(await stampRows()).toEqual(before);
    expect((await stamp()).stamp).toBe(s0.stamp);

    // A write to an unrelated scope (forms) leaves the stamp alone…
    await handle.db.update(forms).set({ failedCount: 3 }).where(eq(forms.projectId, pid));
    expect((await stampRows()).forms).toBe(before.forms! + 1);
    expect((await stamp()).stamp).toBe(s0.stamp);

    // …a new letter changes it, and the list shows the new row.
    const count = async () => (await q(semih, [{ id: "n", dataset: "correspondence", metrics: [{ op: "count" }] }])).body.results.n[0].count;
    const n0 = await count();
    const w = await semih.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Yeni yazı", toCompanyIds: [ids.ZRT] });
    expect(w.status).toBe(200);
    expect((await stamp()).stamp).not.toBe(s0.stamp);
    expect(await count()).toBe(n0 + 1);

    // Statements that change no rows do not bump (INSERT … ON CONFLICT DO NOTHING, UPDATE of nothing).
    const mid = await stampRows();
    await handle.db.execute(sql`UPDATE works SET title = title WHERE id = '00000000-0000-0000-0000-000000000000'`);
    expect(await stampRows()).toEqual(mid);
    expect((await semih.get(`${P()}/reports/stamp?datasets=forms,clash_results`)).body.stamp).toMatch(/^coordination:\d+,files:\d+,forms:\d+,locations:\d+,members:\d+,workflow:\d+\|/);
  });

  it.skipIf(!hasManage)("MCP tools list the module datasets and run ad-hoc queries", async () => {
    const call: CdeCall = async <T,>(method: string, url: string, body?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie: semihCookie }, payload: body as object });
      return cdeResult<T>(res.statusCode, res.body, false);
    };
    const defs = new Map(cdeToolDefinitions(call, { readOnly: true, modules: [] }).map((d) => [d.name, d]));
    // Without the Platform module there are no saved dashboards or templates to list.
    expect(defs.has("cde_reports_list")).toBe(false);
    const tool = (name: string) => defs.get(name)!;
    const run = (name: string, args: Record<string, unknown>) => tool(name).run(cdeParseArgs(tool(name), { projectId: pid, ...args })) as Promise<any>;
    const ds = await run("cde_report_datasets", {});
    expect(ds.map((d: any) => d.name)).toEqual(expect.arrayContaining(["correspondence", "rfis", "workflow_steps", "clash_results"]));
    expect((await run("cde_report_datasets", { dataset: "rfis" })).fields.map((f: any) => f.name)).toContain("ballInCourt");
    const r = await run("cde_report_run", { queries: [{ id: "byBic", spec: { dataset: "rfis", groupBy: ["ballInCourt"] } }], maxRows: 5 });
    expect(r.results.byBic.rows).toEqual([{ ballInCourt: "HLL", count: 1 }]);
  });
});
