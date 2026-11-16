/**
 * Drawing sheets and sheet sets (FP-2, docs/features/SHEETS.md): extraction from multi-page PDFs,
 * numbering, set snapshots, permissions and exports.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { compareSheetNumbers, disciplineFrom, isSheetFile, numberSheets, sheetKey } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, projectRoles, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { extractPdfText } from "../../src/docintel/extract.js";
import { readZip } from "../../src/core/formats/zip.js";
import { sheetFromCad, sheetsFromPdf } from "../../src/sheets/extract.js";

// ---------------------------------------------------------------------------
// Fixtures: A3 sheets with a title block bottom-right (pdf-lib Helvetica: WinAnsi letters only)
// ---------------------------------------------------------------------------

interface PageSpec {
  no?: string;
  title?: string;
  rev?: string;
  discipline?: string;
}

async function drawingSet(pages: PageSpec[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([1190, 842]);
    const put = (text: string, x: number, y: number, size = 8) => page.drawText(text, { x, y, size, font });
    put(p.title ?? "KAPAK", 80, 780, 18);
    if (!p.no) continue; // a cover page without a title block
    put("DISIPLIN", 860, 230, 6);
    put(p.discipline ?? "MIMARI", 860, 218, 9);
    put("PAFTA ADI", 860, 196, 6);
    put(p.title ?? "PLAN", 860, 184, 10);
    put(`PAFTA NO: ${p.no}`, 1040, 140, 7);
    put("OLCEK", 860, 100, 6);
    put("1/50", 905, 100, 9);
    put("REV", 1000, 100, 6);
    put(p.rev ?? "P01", 1000, 88, 10);
    put("TARIH", 1060, 60, 6);
    put("15.03.2026", 1060, 48, 9);
  }
  return Buffer.from(await doc.save());
}

const SET_V1: PageSpec[] = [
  { title: "KAPAK" },
  { no: "A-101", title: "ZEMIN KAT PLANI", rev: "P01", discipline: "MIMARI" },
  { no: "A-102", title: "BIRINCI KAT PLANI", rev: "P01", discipline: "MIMARI" },
  { no: "S-201", title: "TEMEL PLANI", rev: "P02", discipline: "STATIK" },
];

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("sheet numbering (FP-2)", () => {
  it("keeps title-block numbers and numbers the other pages after the code or name", () => {
    const r = numberSheets(
      [
        { page: 1, titleBlockNumber: null },
        { page: 2, titleBlockNumber: "A-101" },
        { page: 3, titleBlockNumber: " A-101 " },
      ],
      "Mimari Set.pdf",
      null,
    );
    expect(r).toEqual([
      { page: 1, number: "Mimari Set-01", source: "filename" },
      { page: 2, number: "A-101", source: "titleblock" },
      { page: 3, number: "A-101 (2)", source: "titleblock" },
    ]);
    expect(numberSheets([{ page: 1, titleBlockNumber: null }], "x.dwg", "PRJ-ORG-ZZ-00-DR-A-0001")).toEqual([
      { page: 1, number: "PRJ-ORG-ZZ-00-DR-A-0001", source: "code" },
    ]);
  });

  it("keys, sorts and recognises drawing files", () => {
    expect(sheetKey(" a-101 ")).toBe("A-101");
    expect(sheetKey("i-1")).toBe(sheetKey("I-1"));
    expect(["A-1001", "A-102", "A-101"].sort(compareSheetNumbers)).toEqual(["A-101", "A-102", "A-1001"]);
    expect(isSheetFile("plan.PDF") && isSheetFile("plan.dwg") && isSheetFile("plan.dxf")).toBe(true);
    expect(isSheetFile("model.ifc")).toBe(false);
    expect(disciplineFrom({ Proje: "ZAVM", Rol: "A" })).toBe("A");
    expect(disciplineFrom({ "Bölüm": "Mekanik" })).toBe("Mekanik");
    expect(disciplineFrom({ Numara: "1" })).toBeNull();
  });
});

describe("sheet extraction from a multi-page PDF (FP-2)", () => {
  it("splits pages into sheets with number, title, discipline, revision and date", async () => {
    const out = await extractPdfText({ data: new Uint8Array(await drawingSet(SET_V1)) }, { maxPages: 50 });
    const sheets = sheetsFromPdf(out, { fileName: "ZAVM-SET.pdf", documentCode: null, description: null, nameFields: null, attributes: {} });
    expect(sheets).toHaveLength(4);
    expect(sheets.map((s) => s.number)).toEqual(["ZAVM-SET-01", "A-101", "A-102", "S-201"]);
    expect(sheets[0]).toMatchObject({ numberSource: "filename", title: null, revision: null });
    expect(sheets[1]).toMatchObject({ page: 2, pageCount: 4, numberSource: "titleblock", revision: "P01", discipline: "MIMARI", date: "2026-03-15" });
    expect(sheets[1]!.title).toContain("ZEMIN KAT PLANI");
    expect(sheets[3]).toMatchObject({ number: "S-201", revision: "P02", discipline: "STATIK" });
  });

  it("makes one sheet of a single-page PDF without a title block and of a DWG", async () => {
    const out = await extractPdfText({ data: new Uint8Array(await drawingSet([{ title: "SKETCH" }])) }, { maxPages: 50 });
    const ctx = { fileName: "Kroki.pdf", documentCode: "ZAVM-PAS-A-0007", description: "Site sketch", nameFields: { Rol: "A" }, attributes: {} };
    expect(sheetsFromPdf(out, ctx)).toEqual([
      { page: 1, pageCount: 1, number: "ZAVM-PAS-A-0007", numberSource: "code", title: "Site sketch", discipline: "A", revision: null, date: null },
    ]);
    expect(sheetFromCad({ ...ctx, fileName: "plan.dwg", documentCode: null })).toMatchObject({ number: "plan", numberSource: "filename", discipline: "A" });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-sheets-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
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
  const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, ...headers }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string, headers?: Record<string, string>) => call("GET", u, undefined, headers),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: Buffer) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(data)]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

describe("sheets API (FP-2)", () => {
  let admin: Api;
  let member: Api;
  let memberId: string;
  let pid: string;
  let shared: string;
  let secret: string;
  let wip: string;
  let rootId: string;
  let setId: string;
  let firstIssueVersion: string;

  it("extracts sheets of PDFs uploaded into Shared folders, not WIP", async () => {
    admin = api(await login("admin@7d.test"));
    memberId = (await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW })).body.id;
    member = api(await login("uye@7d.test"));
    const p = await admin.post("/projects", { code: "SHT", name: "Sheets", template: "empty" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    const folder = async (name: string, state: string) => {
      const id = (await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name })).body.id;
      expect((await admin.patch(`/projects/${pid}/folders/${id}`, { state })).status).toBe(200);
      return id as string;
    };
    shared = await folder("Shared", "shared");
    secret = await folder("Gizli", "shared");
    wip = await folder("WIP", "wip");
    await admin.put(`/projects/${pid}/folders/${shared}/permissions`, { entries: [{ subjectType: "user", subjectId: memberId, level: "view_download" }] });

    expect((await admin.upload(`/projects/${pid}/folders/${shared}/files`, "Mimari Set.pdf", await drawingSet(SET_V1))).status).toBe(200);
    expect((await admin.upload(`/projects/${pid}/folders/${secret}/files`, "Gizli.pdf", await drawingSet([{ no: "X-900", title: "GIZLI" }]))).status).toBe(200);
    expect((await admin.upload(`/projects/${pid}/folders/${wip}/files`, "Taslak.pdf", await drawingSet([{ no: "W-1", title: "TASLAK" }]))).status).toBe(200);
    await jobs.drain();

    const list = await admin.get(`/projects/${pid}/sheets`);
    expect(list.status).toBe(200);
    expect(list.body.sheets.map((s: any) => s.number)).toEqual(["A-101", "A-102", "Mimari Set-01", "S-201", "X-900"]);
    expect(list.body.disciplines).toEqual(["MIMARI", "STATIK"]);
    const a101 = list.body.sheets[0];
    expect(a101).toMatchObject({ page: 2, pageCount: 4, revision: "P01", state: "shared", current: true, format: "pdf", folderPath: expect.stringContaining("Shared") });

    // Filters.
    expect((await admin.get(`/projects/${pid}/sheets?discipline=STATIK`)).body.sheets.map((s: any) => s.number)).toEqual(["S-201"]);
    expect((await admin.get(`/projects/${pid}/sheets?q=birinci`)).body.sheets.map((s: any) => s.number)).toEqual(["A-102"]);
    expect((await admin.get(`/projects/${pid}/sheets?revision=P02`)).body.total).toBe(1);
    expect((await admin.get(`/projects/${pid}/sheets?state=wip`)).body.total).toBe(0);
  });

  it("follows the settings: WIP folders when chosen, after a rescan", async () => {
    expect((await member.put(`/projects/${pid}/sheet-settings`, { states: ["wip"] })).status).toBe(403);
    const s = await admin.put(`/projects/${pid}/sheet-settings`, { states: ["wip", "shared", "published"] });
    expect(s.body).toMatchObject({ states: ["wip", "shared", "published"], folderIds: [], canEdit: true });
    expect((await member.post(`/projects/${pid}/sheets/rescan`)).status).toBe(403);
    expect((await admin.post(`/projects/${pid}/sheets/rescan`)).body.queued).toBe(3);
    await jobs.drain();
    expect((await admin.get(`/projects/${pid}/sheets?state=wip`)).body.sheets.map((x: any) => x.number)).toEqual(["W-1"]);
    // Re-reading keeps one row per page.
    expect((await admin.get(`/projects/${pid}/sheets`)).body.total).toBe(6);
  });

  it("shows members only the sheets of folders they can see", async () => {
    const list = await member.get(`/projects/${pid}/sheets`);
    expect(list.body.sheets.map((s: any) => s.number)).toEqual(["A-101", "A-102", "Mimari Set-01", "S-201"]);
    const hidden = (await admin.get(`/projects/${pid}/sheets?q=X-900`)).body.sheets[0];
    expect((await member.get(`/projects/${pid}/sheets/${hidden.id}`)).status).toBe(404);
  });

  it("applies the task-team WIP rule (ISO 19650 team_only)", async () => {
    // View inherited from the project root shows the WIP sheet …
    await admin.put(`/projects/${pid}/folders/${rootId}/permissions`, { entries: [{ subjectType: "user", subjectId: memberId, level: "view" }] });
    await admin.put(`/projects/${pid}/folders/${secret}/permissions`, { mode: "replace", entries: [{ subjectType: "user", subjectId: memberId, level: "none" }] });
    const wipSheet = (await member.get(`/projects/${pid}/sheets?state=wip`)).body.sheets;
    expect(wipSheet.map((x: any) => x.number)).toEqual(["W-1"]);
    // … until the folder belongs to a team the member is not in and the project closes team WIP.
    const [team] = await handle.db.insert(projectRoles).values({ projectId: pid, name: "Alfa", kind: "task_team" }).returning();
    expect((await admin.put(`/projects/${pid}/folders/${wip}/owner-team`, { teamId: team!.id })).status).toBe(200);
    expect((await admin.put(`/projects/${pid}/cde/settings`, { wipPolicy: "team_only" })).status).toBe(200);
    expect((await member.get(`/projects/${pid}/sheets?state=wip`)).body.total).toBe(0);
    expect((await member.get(`/projects/${pid}/sheets/${wipSheet[0].id}`)).status).toBe(404);
    expect((await admin.get(`/projects/${pid}/sheets?state=wip`)).body.total).toBe(1);
    await admin.put(`/projects/${pid}/cde/settings`, { wipPolicy: "grants" });
    await admin.put(`/projects/${pid}/folders/${rootId}/permissions`, { mode: "replace", entries: [{ subjectType: "user", subjectId: memberId, level: "none" }] });
  });

  it("edits sheet metadata with edit permission and keeps it on re-extraction", async () => {
    const a102 = (await admin.get(`/projects/${pid}/sheets?q=A-102`)).body.sheets[0];
    // Download permission is not edit permission.
    expect((await member.patch(`/projects/${pid}/sheets/${a102.id}`, { title: "X" })).status).toBe(403);
    const r = await admin.patch(`/projects/${pid}/sheets/${a102.id}`, { title: "1. Kat Planı", discipline: "Mimari" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ title: "1. Kat Planı", discipline: "Mimari", edited: true });
    expect((await admin.post(`/projects/${pid}/versions/${a102.versionId}/sheets/extract`)).status).toBe(200);
    await jobs.drain();
    expect((await admin.get(`/projects/${pid}/sheets/${a102.id}`)).body.sheet).toMatchObject({ title: "1. Kat Planı", edited: true });
    const [row] = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "sheet.updated")));
    expect(row?.details).toMatchObject({ after: { title: "1. Kat Planı" } });
  });

  it("creates a set, publishes it as a snapshot and follows new versions", async () => {
    const all = (await admin.get(`/projects/${pid}/sheets`)).body.sheets;
    const ids = all.filter((s: any) => ["A-101", "S-201"].includes(s.number)).map((s: any) => s.id);
    const created = await member.post(`/projects/${pid}/sheet-sets`, { name: "Tender set", sheetIds: ids });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    setId = created.body.id;
    expect(created.body.items.map((i: any) => i.number)).toEqual(["A-101", "S-201"]);
    expect((await admin.post(`/projects/${pid}/sheet-sets`, { name: "tender SET" })).status).toBe(409);
    // A sheet the member cannot see cannot be added.
    const x900 = all.find((s: any) => s.number === "X-900");
    expect((await member.post(`/projects/${pid}/sheet-sets/${setId}/items`, { sheetIds: [x900.id] })).status).toBe(404);
    const a102 = all.find((s: any) => s.number === "A-102");
    expect((await member.post(`/projects/${pid}/sheet-sets/${setId}/items`, { sheetIds: [a102.id] })).body.added).toBe(1);
    expect((await member.post(`/projects/${pid}/sheet-sets/${setId}/items/remove`, { keys: ["A-102"] })).body.removed).toBe(1);

    const issue1 = await member.post(`/projects/${pid}/sheet-sets/${setId}/publish`, { note: "Ihale" });
    expect(issue1.status, JSON.stringify(issue1.body)).toBe(200);
    expect(issue1.body).toMatchObject({ issue: 1, note: "Ihale" });
    expect(issue1.body.items.map((i: any) => [i.number, i.revision, i.page])).toEqual([
      ["A-101", "P01", 2],
      ["S-201", "P02", 4],
    ]);
    firstIssueVersion = issue1.body.items[0].versionId;

    // A new version of the drawing set: A-101 goes to P02.
    const v2 = [...SET_V1];
    v2[1] = { ...v2[1]!, rev: "P02" };
    expect((await admin.upload(`/projects/${pid}/folders/${shared}/files`, "Mimari Set.pdf", await drawingSet(v2))).status).toBe(200);
    await jobs.drain();

    const set = (await member.get(`/projects/${pid}/sheet-sets/${setId}`)).body;
    expect(set.items.find((i: any) => i.number === "A-101").sheet).toMatchObject({ revision: "P02", version: 2 });
    expect(set.publications).toHaveLength(1);
    // The published issue still holds version 1.
    const kept = (await member.get(`/projects/${pid}/sheet-sets/${setId}/issues/1`)).body;
    expect(kept.items[0]).toMatchObject({ number: "A-101", revision: "P01", versionId: firstIssueVersion });
    const issue2 = await member.post(`/projects/${pid}/sheet-sets/${setId}/publish`, {});
    expect(issue2.body.issue).toBe(2);
    expect(issue2.body.items[0]).toMatchObject({ revision: "P02", version: 2 });

    // History across versions.
    const a101 = set.items.find((i: any) => i.number === "A-101").sheet;
    const detail = (await member.get(`/projects/${pid}/sheets/${a101.id}`)).body;
    expect(detail.history.map((h: any) => [h.version, h.revision])).toEqual([
      [2, "P02"],
      [1, "P01"],
    ]);
    expect(detail.sets).toEqual([{ id: setId, name: "Tender set" }]);

    const audits = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.targetId, setId)));
    expect(audits.map((r) => r.action)).toEqual(
      expect.arrayContaining(["sheet_set.created", "sheet_set.items_added", "sheet_set.items_removed", "sheet_set.published"]),
    );
  });

  it("lets only the creator or a project administrator change a set", async () => {
    const other = await admin.post("/users", { email: "diger@7d.test", name: "Diğer", password: PW });
    await admin.post(`/projects/${pid}/members`, { email: "diger@7d.test" });
    await admin.put(`/projects/${pid}/folders/${shared}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: memberId, level: "view_download" },
        { subjectType: "user", subjectId: other.body.id, level: "view" },
      ],
    });
    const diger = api(await login("diger@7d.test"));
    const set = (await diger.get(`/projects/${pid}/sheet-sets/${setId}`)).body;
    expect(set).toMatchObject({ canManage: false, issue: 2 });
    expect((await diger.post(`/projects/${pid}/sheet-sets/${setId}/publish`, {})).status).toBe(403);
    expect((await diger.patch(`/projects/${pid}/sheet-sets/${setId}`, { name: "Y" })).status).toBe(403);
    expect((await admin.patch(`/projects/${pid}/sheet-sets/${setId}`, { description: "Ihale paftalari" })).status).toBe(200);
  });

  it("exports the sheet list as CSV and XLSX and a set as a zip of PDFs", async () => {
    const csv = await member.get(`/projects/${pid}/sheets/export?format=csv`, { "accept-language": "en" });
    expect(csv.status).toBe(200);
    expect(csv.raw.headers["content-type"]).toContain("text/csv");
    const lines = String(csv.raw.body).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("No.;Sheet Number;Title;Discipline;Revision;Suitability;Date;Status;File;Page");
    expect(lines[1]).toMatch(/^1;A-101;ZEMIN KAT PLANI;MIMARI;P02;;2026-03-15;Shared;Mimari Set.pdf;2$/);
    expect(lines).toHaveLength(5);

    const tr = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/sheet-sets/${setId}/export?format=xlsx&issue=1`,
      headers: { cookie: await login("uye@7d.test"), "accept-language": "tr" },
    });
    expect(tr.statusCode).toBe(200);
    expect(tr.headers["content-type"]).toContain("spreadsheetml");
    expect(tr.headers["content-disposition"]).toContain("SHT-Tender%20set-issue-01.xlsx");
    const sheetXml = readZip(tr.rawPayload).get("xl/worksheets/sheet1.xml")!().toString("utf8");
    expect(sheetXml).toContain("Pafta No");
    expect(sheetXml).toContain("A-101");
    expect(sheetXml).toContain("P01");

    expect((await member.get(`/projects/${pid}/sheets/export?format=pdf`)).status).toBe(400);

    const zip = await member.get(`/projects/${pid}/sheet-sets/${setId}/zip?issue=1`);
    expect(zip.status).toBe(200);
    expect(zip.raw.headers["content-type"]).toBe("application/zip");
    const entries = [...readZip(zip.raw.rawPayload).keys()];
    // Both sheets of issue 1 are pages of one PDF version: one file in the zip.
    expect(entries).toEqual(["Mimari Set (V1).pdf"]);
  });

  it("hides sets' sheets the caller cannot see and deletes a set", async () => {
    const all = (await admin.get(`/projects/${pid}/sheets`)).body.sheets;
    const x900 = all.find((s: any) => s.number === "X-900");
    const own = await admin.post(`/projects/${pid}/sheet-sets`, { name: "Construction issue 03", sheetIds: [x900.id] });
    expect(own.status).toBe(201);
    const seen = (await member.get(`/projects/${pid}/sheet-sets/${own.body.id}`)).body;
    expect(seen).toMatchObject({ items: [], hidden: 1 });
    expect((await member.get(`/projects/${pid}/sheets?setId=${own.body.id}`)).body.total).toBe(0);
    expect((await member.del(`/projects/${pid}/sheet-sets/${own.body.id}`)).status).toBe(403);
    expect((await admin.del(`/projects/${pid}/sheet-sets/${own.body.id}`)).status).toBe(200);
    expect((await admin.get(`/projects/${pid}/sheet-sets`)).body.sets.map((s: any) => s.name)).toEqual(["Tender set"]);
  });
});
