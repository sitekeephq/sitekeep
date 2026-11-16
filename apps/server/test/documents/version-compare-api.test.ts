/**
 * DWG / IFC version comparison over HTTP (FP-1): the background job, the cached result per pair,
 * the filtered list of differences, CSV / XLSX export, the audit rows, and access: folder
 * permissions and the task-team WIP rule (FolderTree) hide the comparison like the files.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { dxf, line, text, type FixtureDrawing } from "./dxf-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../fixtures/model-query.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../fixtures/model-query-v2.ifc"));

const DWG_V1: FixtureDrawing = {
  layers: [{ name: "0" }, { name: "WALL", color: 7 }, { name: "TEXT", color: 2 }],
  entities: [line("1A", "WALL", 0, 0, 10, 0), line("1B", "WALL", 0, 0, 0, 10), text("1C", "TEXT", "KOLON S12 40x60")],
};
const DWG_V2: FixtureDrawing = {
  layers: [{ name: "0" }, { name: "WALL", color: 1 }, { name: "TEXT", color: 2 }, { name: "NEW", color: 5 }],
  entities: [line("1A", "WALL", 0, 0, 12, 0), text("1C", "TEXT", "KOLON S12 50x60"), line("20", "NEW", 1, 1, 2, 2)],
};

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-fp1-api-"));
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
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    upload: async (url: string, name: string, data: Buffer | string) => {
      const form = new FormData();
      form.append("file", new Blob([typeof data === "string" ? data : new Uint8Array(data)]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = res.json().results[0];
      expect(row.ok, JSON.stringify(row)).toBe(true);
      return row.fileId as string;
    },
  };
}
type Api = ReturnType<typeof api>;

describe("FP-1 DWG / IFC version comparison API", () => {
  let admin: Api, ua: Api, ub: Api, viewer: Api;
  let pid: string;
  let wipA: string;
  let dwg: { v1: string; v2: string };
  let ifc: { v1: string; v2: string };
  let cid: string;
  const P = () => `/projects/${pid}`;

  it("sets up an ISO project: team A's WIP folder holds two versions of a drawing and of a model", async () => {
    admin = api(await login("admin@7d.test"));
    const a = (await admin.post("/companies", { name: "Alfa Tasarım", code: "ALF" })).body.id;
    const b = (await admin.post("/companies", { name: "Beta Yapı", code: "BET" })).body.id;
    const r = await admin.post("/projects/from-template", { code: "FP1", name: "Karşılaştırma", templateId: "iso19650-temel", slotCompanies: { tasarimci: a, yuklenici: b } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pid = r.body.id;
    const root = await admin.get(`${P()}/folders/${r.body.rootFolderId}/contents`);
    const wipId = root.body.folders.find((f: { state: string }) => f.state === "wip").id;
    wipA = (await admin.get(`${P()}/folders/${wipId}/contents`)).body.folders.find((f: { name: string }) => f.name === "Tasarımcı").id;
    for (const [key, company] of [["ua", a], ["ub", b], ["viewer", null]] as const) {
      await admin.post("/users", { email: `${key}@fp1.test`, name: key, password: PW, companyId: company });
      expect((await admin.post(`${P()}/members`, { email: `${key}@fp1.test` })).status).toBe(200);
    }
    ua = api(await login("ua@fp1.test"));
    ub = api(await login("ub@fp1.test"));
    viewer = api(await login("viewer@fp1.test"));

    const versions = async (name: string, d1: Buffer | string, d2: Buffer | string) => {
      const fileId = await ua.upload(`${P()}/folders/${wipA}/files`, name, d1);
      await ua.upload(`${P()}/folders/${wipA}/files`, name, d2);
      const file = (await ua.get(`${P()}/files/${fileId}`)).body;
      return { v1: file.versions.find((v: any) => v.version === 1).id, v2: file.versions.find((v: any) => v.version === 2).id };
    };
    dwg = await versions("ALF-PLAN-001.dxf", dxf(DWG_V1), dxf(DWG_V2));
    ifc = await versions("ALF-MODEL-001.ifc", IFC_V1, IFC_V2);
  });

  it("runs a DWG comparison as a background job, cached per version pair", async () => {
    const started = await ua.get(`${P()}/doc-compare?from=${dwg.v1}&to=${dwg.v2}`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: "running", result: null });
    cid = started.body.id;
    await jobs.drain();
    const done = await ua.get(`${P()}/doc-compare/${cid}`);
    expect(done.body.status, done.body.error).toBe("done");
    const result = done.body.result;
    expect(result.kind).toBe("dwg");
    expect(result.detailKey).toBeUndefined();
    expect(result.cad).toMatchObject({ matchedBy: "handle", added: 1, removed: 1, changed: 2, unchanged: 0 });
    expect(result.cad.layers.find((l: any) => l.layer === "WALL")).toMatchObject({ status: "changed", props: [{ prop: "color", from: "7", to: "1" }] });
    expect(result.cad.layers.find((l: any) => l.layer === "NEW")).toMatchObject({ status: "added", added: 1 });
    expect(done.body.summary.map((s: any) => s.text)).toEqual(expect.arrayContaining(["Nesneler: 1 eklendi, 1 silindi, 2 değişti, 0 aynı.", "NEW katmanı eklendi (1 nesne)."]));
    // The same pair: the cached comparison, no new job.
    const again = await ua.get(`${P()}/doc-compare?from=${dwg.v1}&to=${dwg.v2}`);
    expect(again.body).toMatchObject({ id: cid, status: "done" });
    // Drawings have no AI summary and no PDF report: the differences are exported.
    expect((await ua.post(`${P()}/doc-compare/${cid}/summary`)).status).toBe(400);
    expect((await ua.post(`${P()}/doc-compare/${cid}/report`)).status).toBe(400);
  });

  it("lists the differences with filters and pages", async () => {
    const all = await ua.get(`${P()}/doc-compare/${cid}/differences`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    expect(all.body.rows.map((r: any) => [r.kind, r.id, r.group])).toEqual([
      ["added", "20", "NEW"],
      ["changed", "1C", "TEXT"],
      ["removed", "1B", "WALL"],
      ["changed", "1A", "WALL"],
    ]);
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences?kind=changed`)).body.total).toBe(2);
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences?group=WALL`)).body.total).toBe(2);
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences?aspect=text`)).body.rows.map((r: any) => r.id)).toEqual(["1C"]);
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences?q=50x60`)).body.rows.map((r: any) => r.id)).toEqual(["1C"]);
    const page = await ua.get(`${P()}/doc-compare/${cid}/differences?offset=1&limit=2`);
    expect(page.body).toMatchObject({ total: 4, offset: 1, limit: 2 });
    expect(page.body.rows.map((r: any) => r.id)).toEqual(["1C", "1B"]);
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences?limit=5000`)).status).toBe(400);
  });

  it("exports the differences as CSV and Excel and records runs and exports in the audit log", async () => {
    const csv = await ua.get(`${P()}/doc-compare/${cid}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.raw.headers["content-type"]).toContain("text/csv");
    expect(csv.raw.headers["content-disposition"]).toContain("ALF-PLAN-001_V1-V2_farklar.csv");
    const lines = csv.raw.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Değişiklik;Katman;Nesne tipi;Tanıtıcı (handle);Metin / blok;Ne değişti;Ayrıntılar");
    expect(lines).toHaveLength(5);
    expect(lines).toContain("Değişen;TEXT;TEXT;1C;KOLON S12 50x60;Metin;Metin: KOLON S12 40x60 → KOLON S12 50x60");
    const filtered = await ua.get(`${P()}/doc-compare/${cid}/export?format=csv&kind=added`);
    expect(filtered.raw.body.trim().split("\r\n")).toHaveLength(2);
    const xlsx = await ua.get(`${P()}/doc-compare/${cid}/export?format=xlsx`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.raw.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.raw.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid)));
    const actions = rows.map((r) => r.action);
    expect(actions.filter((x) => x === "doc_compare.run")).toHaveLength(1);
    expect(actions.filter((x) => x === "doc_compare.export")).toHaveLength(3);
    expect(rows.find((r) => r.action === "doc_compare.run")!.details).toMatchObject({ comparisonId: cid, from: 1, to: 2 });
  });

  it("hides the comparison from people who cannot see the files (task-team WIP rule, folder grants)", async () => {
    for (const outsider of [ub, viewer]) {
      expect((await outsider.get(`${P()}/doc-compare?from=${dwg.v1}&to=${dwg.v2}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/doc-compare/${cid}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/doc-compare/${cid}/differences`)).status).toBe(404);
      expect((await outsider.get(`${P()}/doc-compare/${cid}/export?format=csv`)).status).toBe(404);
    }
    // A user who is no project member does not even get the project.
    await admin.post("/users", { email: "stranger@fp1.test", name: "stranger", password: PW });
    const stranger = api(await login("stranger@fp1.test"));
    expect([403, 404]).toContain((await stranger.get(`${P()}/doc-compare/${cid}/differences`)).status);
  });

  it("compares two IFC versions per GlobalId by class and storey", async () => {
    const started = await ua.get(`${P()}/doc-compare?from=${ifc.v1}&to=${ifc.v2}`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await jobs.drain();
    const done = (await ua.get(`${P()}/doc-compare/${started.body.id}`)).body;
    expect(done.status, done.error).toBe("done");
    expect(done.result.model).toMatchObject({ added: 1, removed: 1, changed: 1, unchanged: 5, detailed: true, geometry: true });
    expect(done.result.model.byClass.IfcDoor).toMatchObject({ changed: 1 });
    expect(done.result.model.byStorey["Kat 1"]).toEqual({ added: 1, removed: 1, changed: 0 });
    const doors = await ua.get(`${P()}/doc-compare/${done.id}/differences?group=IfcDoor`);
    expect(doors.body.rows).toEqual([
      expect.objectContaining({ id: "0MqDoor000000000000001", kind: "changed", aspects: ["property"], changes: [{ prop: "Pset_DoorCommon.FireRating", from: "EI30", to: "EI60" }] }),
    ]);
    const csv = await ua.get(`${P()}/doc-compare/${done.id}/export?format=csv&kind=changed`);
    expect(csv.raw.body).toContain("0MqDoor000000000000001");
    expect(csv.raw.body.split("\r\n")[0]).toContain("GlobalId");
    expect((await ub.get(`${P()}/doc-compare/${done.id}/differences`)).status).toBe(404);
  });

  it("rebuilds a comparison on request", async () => {
    const r = await ua.get(`${P()}/doc-compare?from=${dwg.v1}&to=${dwg.v2}&rebuild=1`);
    expect(r.body).toMatchObject({ id: cid, status: "running" });
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences`)).status).toBe(409);
    await jobs.drain();
    expect((await ua.get(`${P()}/doc-compare/${cid}`)).body.status).toBe("done");
    expect((await ua.get(`${P()}/doc-compare/${cid}/differences`)).body.total).toBe(4);
  });
});
