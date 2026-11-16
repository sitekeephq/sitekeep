import { mkdtempSync, rmSync } from "node:fs";
import { installed } from "../helpers/modules.js";

const hasPlatform = installed("platform");
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ReportQuerySpec, ReportRow } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { bucketKey, checkSpec, executeSpec, type FieldSource } from "../../src/reports/engine.js";
import { DatasetRegistry, reportDatasets } from "../../src/reports/datasets.js";
import { extractJson } from "../../src/ai/json.js";

// ---- Pure engine ----------------------------------------------------------------------

const SRC: FieldSource = {
  fields: {
    name: { type: "string", label: "Ad" },
    company: { type: "string", label: "Firma" },
    size: { type: "number", label: "Boyut" },
    at: { type: "date", label: "Tarih" },
    due: { type: "date", label: "Termin" },
    open: { type: "boolean", label: "Açık" },
  },
  dynamicPrefix: "attributes.",
};
const ROWS: ReportRow[] = [
  { name: "A-İSTANBUL.pdf", company: "Poyraz", size: 100, at: "2026-10-05T09:00:00.000Z", due: "2026-10-01", open: true, "attributes.Durum": "S2" },
  { name: "B.ifc", company: "Poyraz", size: 300, at: "2026-10-06T09:00:00.000Z", due: "2026-10-20", open: false, "attributes.Durum": "S4" },
  { name: "C.pdf", company: "CNS", size: 50, at: "2026-09-28T09:00:00.000Z", due: null, open: true },
  { name: "D.dwg", company: null, size: 1000, at: "2026-08-15T09:00:00.000Z", due: "2026-10-09", open: true },
];
const OPTS = { now: new Date("2026-10-10T09:00:00.000Z"), timeZone: "Europe/Istanbul" };
const run = (spec: Omit<ReportQuerySpec, "dataset">) => {
  const full = { dataset: "t", ...spec };
  expect(checkSpec(full, SRC)).toEqual([]);
  return executeSpec(ROWS, full, SRC, OPTS);
};
const names = (rows: ReportRow[]) => rows.map((r) => r.name);

describe("report query engine", () => {
  it("filters with every operator", () => {
    expect(names(run({ filters: [{ field: "company", op: "eq", value: "Poyraz" }] }))).toEqual(["A-İSTANBUL.pdf", "B.ifc"]);
    expect(names(run({ filters: [{ field: "company", op: "neq", value: "Poyraz" }] }))).toEqual(["C.pdf", "D.dwg"]);
    expect(names(run({ filters: [{ field: "company", op: "in", value: ["CNS", null] }] }))).toEqual(["C.pdf", "D.dwg"]);
    // Turkish-aware, case-insensitive contains.
    expect(names(run({ filters: [{ field: "name", op: "contains", value: "istanbul" }] }))).toEqual(["A-İSTANBUL.pdf"]);
    expect(names(run({ filters: [{ field: "size", op: "gt", value: 100 }] }))).toEqual(["B.ifc", "D.dwg"]);
    expect(names(run({ filters: [{ field: "size", op: "lte", value: "100" }] }))).toEqual(["A-İSTANBUL.pdf", "C.pdf"]);
    expect(names(run({ filters: [{ field: "size", op: "between", value: [50, 300] }] }))).toEqual(["A-İSTANBUL.pdf", "B.ifc", "C.pdf"]);
    expect(names(run({ filters: [{ field: "company", op: "isNull", value: true }] }))).toEqual(["D.dwg"]);
    expect(names(run({ filters: [{ field: "due", op: "isNull", value: false }] }))).toHaveLength(3);
    expect(names(run({ filters: [{ field: "open", op: "eq", value: true }] }))).toEqual(["A-İSTANBUL.pdf", "C.pdf", "D.dwg"]);
    expect(names(run({ filters: [{ field: "attributes.Durum", op: "eq", value: "S4" }] }))).toEqual(["B.ifc"]);
  });

  it("compares dates by day, timestamp and relative values", () => {
    // Whole-day comparison: the event on 2026-10-05 counts for lte 2026-10-05.
    expect(names(run({ filters: [{ field: "at", op: "lte", value: "2026-10-05" }] }))).toEqual(["A-İSTANBUL.pdf", "C.pdf", "D.dwg"]);
    expect(names(run({ filters: [{ field: "at", op: "gte", value: "-7d" }] }))).toEqual(["A-İSTANBUL.pdf", "B.ifc"]);
    expect(names(run({ filters: [{ field: "at", op: "gte", value: "-1m" }] }))).toEqual(["A-İSTANBUL.pdf", "B.ifc", "C.pdf"]);
    expect(names(run({ filters: [{ field: "due", op: "lt", value: "today" }] }))).toEqual(["A-İSTANBUL.pdf", "D.dwg"]);
    expect(names(run({ filters: [{ field: "due", op: "between", value: ["today", "+2w"] }] }))).toEqual(["B.ifc"]);
    expect(names(run({ filters: [{ field: "at", op: "gt", value: "2026-10-05T10:00:00Z" }] }))).toEqual(["B.ifc"]);
  });

  it("groups with buckets and computes metrics", () => {
    expect(bucketKey("2026-10-05T09:00:00Z", "week", "Europe/Istanbul")).toBe("2026-10-05"); // Monday
    expect(bucketKey("2026-10-11T20:30:00Z", "week", "Europe/Istanbul")).toBe("2026-10-05"); // Sunday 23:30 local
    expect(bucketKey("2026-10-11T21:30:00Z", "week", "Europe/Istanbul")).toBe("2026-10-12"); // Monday 00:30 local
    expect(bucketKey("2026-10-11T12:00:00Z", "day", "Europe/Istanbul")).toBe("2026-10-11");

    const byCompany = run({
      groupBy: ["company"],
      metrics: [{ op: "count" }, { op: "sum", field: "size" }, { op: "avg", field: "size", as: "ort" }, { op: "max", field: "at" }],
    });
    expect(byCompany).toEqual([
      { company: "Poyraz", count: 2, sum_size: 400, ort: 200, max_at: "2026-10-06T09:00:00.000Z" },
      { company: "CNS", count: 1, sum_size: 50, ort: 50, max_at: "2026-09-28T09:00:00.000Z" },
      { company: null, count: 1, sum_size: 1000, ort: 1000, max_at: "2026-08-15T09:00:00.000Z" },
    ]);

    // Empty buckets between the first and last one are filled in.
    const weekly = run({ groupBy: [{ field: "at", bucket: "week" }] });
    expect(weekly.map((r) => r.at)).toEqual([
      "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05",
    ]);
    expect(weekly.map((r) => r.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 2]);
    // ... and widened to the filter range ("last 4 weeks" → up to this week).
    expect(
      run({ filters: [{ field: "at", op: "gte", value: "-4w" }], groupBy: [{ field: "at", bucket: "week" }], metrics: [{ op: "sum", field: "size" }] }),
    ).toEqual([
      { at: "2026-09-07", sum_size: 0 },
      { at: "2026-09-14", sum_size: 0 },
      { at: "2026-09-21", sum_size: 0 },
      { at: "2026-09-28", sum_size: 50 },
      { at: "2026-10-05", sum_size: 400 },
    ]);
    expect(run({ groupBy: [{ field: "at", bucket: "month" }], metrics: [{ op: "min", field: "size" }] })).toEqual([
      { at: "2026-08", min_size: 1000 },
      { at: "2026-09", min_size: 50 },
      { at: "2026-10", min_size: 100 },
    ]);
    // Metrics without groupBy give one row, also when nothing matches.
    expect(run({ metrics: [{ op: "count" }, { op: "count", field: "due", as: "withDue" }] })).toEqual([{ count: 4, withDue: 3 }]);
    expect(run({ filters: [{ field: "size", op: "gt", value: 99999 }], metrics: [{ op: "sum", field: "size" }] })).toEqual([{ sum_size: 0 }]);
  });

  it("sorts, projects and limits raw rows", () => {
    const rows = run({ fields: ["name", "size"], sort: [{ field: "size", dir: "desc" }], limit: 2 });
    expect(rows).toEqual([
      { name: "D.dwg", size: 1000 },
      { name: "B.ifc", size: 300 },
    ]);
    expect(names(run({ sort: [{ field: "company" }] })).at(-1)).toBe("D.dwg"); // nulls last
    expect(run({ groupBy: ["company"], sort: [{ field: "count", dir: "asc" }], limit: 1 })).toHaveLength(1);
  });

  it("rejects unknown fields and mismatched operators", () => {
    const errs = checkSpec(
      {
        dataset: "t",
        filters: [
          { field: "nope", op: "eq", value: 1 },
          { field: "company", op: "in", value: "x" },
          { field: "size", op: "contains", value: "1" },
        ],
        groupBy: [{ field: "company", bucket: "week" }],
        metrics: [{ op: "sum", field: "company" }, { op: "avg" }],
        sort: [{ field: "size" }],
      },
      SRC,
    );
    expect(errs.join("\n")).toMatch(/'nope' alanı yok/);
    expect(errs.join("\n")).toMatch(/'in' için value bir dizi/);
    expect(errs.join("\n")).toMatch(/'contains' yalnızca metin/);
    expect(errs.join("\n")).toMatch(/bucket yalnızca tarih/);
    expect(errs.join("\n")).toMatch(/'sum' yalnızca sayı/);
    expect(errs.join("\n")).toMatch(/'avg' için field gerekli/);
    expect(errs.join("\n")).toMatch(/sort\[0\]: 'size' çıktı sütunu değil/);
  });

  it("lets features register datasets", () => {
    const reg = new DatasetRegistry();
    reg.register("rfis", { label: "RFI", description: "", fields: { no: { type: "number", label: "No" } }, load: async () => [] });
    expect(reg.names()).toEqual(["rfis"]);
    expect(() => reg.register("rfis", { label: "", description: "", fields: {}, load: async () => [] })).toThrow();
    expect(reportDatasets.names()).toEqual(expect.arrayContaining(["files", "versions", "issues", "activity", "members", "models"]));
  });
});

describe("model answers", () => {
  it("strips qwen3 thinking and finds JSON in fenced answers", () => {
    expect(extractJson('<think>hmm {x}</think>\n{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('<think>plan</think>Here:\n```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });
});

// ---- API ------------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-reports-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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

function client(cookie: string, target: () => FastifyInstance = () => app) {
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
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, fileList: { name: string; data: string }[], fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
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

describe("reports API", () => {
  let admin: ReturnType<typeof client>;
  let murat: ReturnType<typeof client>;
  let ayse: ReturnType<typeof client>;
  let semih: ReturnType<typeof client>;
  let pid: string;
  let designId: string;
  let semihId: string;

  const query = (c: ReturnType<typeof client>, queries: unknown[], extra: object = {}) =>
    c.post(`/projects/${pid}/reports/query`, { queries, ...extra });

  it("sets up a project with folders, files and issues", async () => {
    admin = client(await login("admin@7d.test"));
    const pas = (await admin.post("/companies", { name: "Poyraz" })).body.id;
    const cns = (await admin.post("/companies", { name: "CNS" })).body.id;
    const muratId = (await admin.post("/users", { email: "murat@p.test", name: "Murat", password: PW, companyId: pas })).body.id;
    await admin.post("/users", { email: "ayse@p.test", name: "Ayşe", password: PW, companyId: pas });
    semihId = (await admin.post("/users", { email: "semih@c.test", name: "Semih", password: PW, companyId: cns })).body.id;
    const p = await admin.post("/projects", { code: "ZAVM", name: "Zirve Veri Merkezi" });
    pid = p.body.id;
    for (const email of ["murat@p.test", "ayse@p.test", "semih@c.test"])
      expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    const root = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    const wipId = root.body.folders[0].id;
    const sharedId = root.body.folders[1].id;
    designId = (await admin.post(`/projects/${pid}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;
    await admin.put(`/projects/${pid}/folders/${designId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: muratId, level: "edit" },
        { subjectType: "user", subjectId: semihId, level: "upload_only" },
      ],
    });
    murat = client(await login("murat@p.test"));
    ayse = client(await login("ayse@p.test"));
    semih = client(await login("semih@c.test"));

    const up = await murat.upload(`/projects/${pid}/folders/${designId}/files`, [
      { name: "A-101.pdf", data: "a".repeat(100) },
      { name: "A-102.pdf", data: "b".repeat(50) },
    ], { attributes: JSON.stringify({ Durum: "S2" }) });
    expect(up.status).toBe(200);
    await murat.upload(`/projects/${pid}/folders/${designId}/files`, [{ name: "A-101.pdf", data: "a2" }]);
    expect((await semih.upload(`/projects/${pid}/folders/${designId}/files`, [{ name: "CNS-1.pdf", data: "c" }])).status).toBe(200);
    expect((await admin.upload(`/projects/${pid}/folders/${sharedId}/files`, [{ name: "GIZLI.pdf", data: "x" }])).status).toBe(200);

    const issue = (body: object) => admin.post(`/projects/${pid}/issues`, body);
    await issue({ title: "Gecikmiş kritik", priority: "critical", assigneeUserId: muratId, dueDate: "2020-01-01" });
    await issue({ title: "Gecikmiş normal", assigneeUserId: semihId, dueDate: "2020-02-01" });
    await issue({ title: "İleride", priority: "high", assigneeUserId: semihId, dueDate: "2099-01-01" });
    const closed = await issue({ title: "Kapanan", assigneeUserId: muratId, dueDate: "2020-01-01" });
    await admin.patch(`/projects/${pid}/issues/${closed.body.id}`, { status: "closed" });
  });

  it("runs file queries with the caller's folder permissions", async () => {
    const q = [{ id: "files", dataset: "files", fields: ["name", "uploader", "folderState", "attributes.Durum", "currentVersion"], sort: [{ field: "name" }] }];
    const all = await query(admin, q);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.results.files.map((r: ReportRow) => r.name)).toEqual(["A-101.pdf", "A-102.pdf", "CNS-1.pdf", "GIZLI.pdf"]);
    expect(all.body.results.files[0]).toEqual({
      name: "A-101.pdf",
      uploader: "Murat",
      folderState: "wip",
      "attributes.Durum": "S2",
      currentVersion: 2,
    });
    expect((await query(murat, q)).body.results.files.map((r: ReportRow) => r.name)).toEqual(["A-101.pdf", "A-102.pdf", "CNS-1.pdf"]);
    // Upload-only: only own files. No folder access at all: nothing.
    expect((await query(semih, q)).body.results.files.map((r: ReportRow) => r.name)).toEqual(["CNS-1.pdf"]);
    expect((await query(ayse, q)).body.results.files).toEqual([]);

    const versions = await query(murat, [
      { id: "byUploader", dataset: "versions", groupBy: ["uploaderCompany", "uploader"], metrics: [{ op: "count" }, { op: "sum", field: "size" }] },
    ]);
    expect(versions.body.results.byUploader).toEqual([
      { uploaderCompany: "Poyraz", uploader: "Murat", count: 3, sum_size: 152 },
      { uploaderCompany: "CNS", uploader: "Semih", count: 1, sum_size: 1 },
    ]);
  });

  it("computes issue fields and accepts the {id, spec} shape", async () => {
    const r = await query(murat, [
      { id: "overdue", spec: { dataset: "issues", filters: [{ field: "overdue", op: "eq", value: true }], groupBy: ["assigneeCompany"], sort: [{ field: "assigneeCompany" }] } },
      { id: "open", dataset: "issues", filters: [{ field: "isOpen", op: "eq", value: true }], metrics: [{ op: "count" }] },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.overdue).toEqual([
      { assigneeCompany: "CNS", count: 1 },
      { assigneeCompany: "Poyraz", count: 1 },
    ]);
    expect(r.body.results.open).toEqual([{ count: 3 }]);
  });

  it("restricts the activity dataset to project admins", async () => {
    const q = [{ id: "act", dataset: "activity", groupBy: ["action"] }];
    const denied = await query(murat, q);
    expect(denied.status).toBe(403);
    const ok = await query(admin, q);
    expect(ok.status).toBe(200);
    expect(ok.body.results.act).toEqual(expect.arrayContaining([expect.objectContaining({ action: "file.uploaded" })]));
    // Non-strict mode reports per query instead of failing.
    const lenient = await query(murat, [...q, { id: "m", dataset: "members", metrics: [{ op: "count" }] }], { strict: false });
    expect(lenient.status).toBe(200);
    expect(lenient.body.errors.act).toMatch(/proje yöneticilerine/);
    expect(lenient.body.results.m).toEqual([{ count: 4 }]);
    expect((await murat.get(`/projects/${pid}/reports/catalog`)).body.datasets.map((d: { name: string }) => d.name)).not.toContain("activity");
  });

  it("rejects invalid queries with readable messages", async () => {
    const r = await query(murat, [{ id: "x", dataset: "files", filters: [{ field: "boyut", op: "gt", value: 1 }] }]);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/'boyut' alanı yok/);
    expect((await query(murat, [{ id: "x", dataset: "nope" }])).status).toBe(400);
    expect((await query(murat, [{ id: "x", dataset: "files", limit: 10_000 }])).status).toBe(400);
  });

  it("serves the catalog without builder parts and a CSV list per dataset (Community)", async () => {
    const cat = await murat.get(`/projects/${pid}/reports/catalog`);
    expect(cat.status).toBe(200);
    expect(cat.body.datasets.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(["files", "issues", "members"]));
    expect(cat.body.modules.find((m: { key: string }) => m.key === "issues")).toMatchObject({ datasets: ["issues"] });
    if (!hasPlatform) {
      expect(cat.body).toMatchObject({ aiAvailable: false, templates: [], examplePrompts: [] });
      // Dashboards are the Platform module's: no saved dashboards, no builder.
      expect((await murat.get(`/projects/${pid}/reports`)).status).toBe(404);
      expect((await murat.post(`/projects/${pid}/reports`, { name: "x" })).status).toBe(404);
      expect((await murat.post(`/projects/${pid}/reports/generate`, { prompt: "Açık sorunlar" })).status).toBe(404);
    }
    // The model dataset needs a model filter: no fixed list.
    expect(cat.body.datasets.find((d: { name: string }) => d.name === "model_elements")?.scoped ?? true).toBe(true);

    const csv = await murat.get(`/projects/${pid}/reports/datasets/issues/csv`);
    expect(csv.status).toBe(200);
    const lines = String(csv.body).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toContain("Başlık");
    expect(lines.slice(1).some((l) => l.includes("Gecikmiş kritik"))).toBe(true);
    // Coded values carry their label; booleans read Evet / Hayır.
    expect(lines.slice(1).find((l) => l.includes("Kapanan"))).toMatch(/Kapalı/);
    expect(lines.slice(1).join("\n")).toMatch(/Evet|Hayır/);
    // With the caller's permissions: Ayşe sees no file, Semih only his own.
    const files = async (c: ReturnType<typeof client>) => String((await c.get(`/projects/${pid}/reports/datasets/files/csv`)).body).trim().split("\r\n").length - 1;
    expect(await files(admin)).toBe(4);
    expect(await files(semih)).toBe(1);
    expect(await files(ayse)).toBe(0);
    expect((await murat.get(`/projects/${pid}/reports/datasets/activity/csv`)).status).toBe(404);
    expect((await admin.get(`/projects/${pid}/reports/datasets/activity/csv`)).status).toBe(200);
    expect((await murat.get(`/projects/${pid}/reports/datasets/nope/csv`)).status).toBe(404);
    // The stamp of unsaved queries.
    const st = await murat.get(`/projects/${pid}/reports/stamp?datasets=issues`);
    expect(st.body.stamp).toMatch(/^issues:\d+,members:\d+\|\d{4}-\d{2}-\d{2}$/);
  });
});
