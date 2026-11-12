import { mkdtempSync, rmSync } from "node:fs";
import { hasField, hasManage } from "../helpers/modules.js"; // these steps use Field (forms)
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  REPORT_CSP,
  REPORT_RUNTIME_JS,
  buildReportSrcdoc,
  cleanDashboardHtml,
  reportHtmlWarnings,
  type ReportQuerySpec,
  type ReportRow,
} from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { bucketKey, checkSpec, executeSpec, type FieldSource } from "../../src/reports/engine.js";
import { DatasetRegistry, reportDatasets } from "../../src/reports/datasets.js";
import { extractJson, reportLlmFromEnv, stripThinking, type ReportLlm, type ReportLlmMessage } from "../../src/reports/llm.js";
import { REPORT_TEMPLATES } from "../../src/reports/templates.js";

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

  it("every built-in template is valid against the registry", () => {
    for (const t of REPORT_TEMPLATES)
      for (const q of t.queries) expect(checkSpec(q.spec, reportDatasets.get(q.spec.dataset)!), `${t.id}/${q.id}`).toEqual([]);
  });
});

// ---- Frame builder --------------------------------------------------------------------

describe("dashboard srcdoc builder", () => {
  const evil = "</script><script>alert(document.cookie)</script>\u2028";
  const doc = buildReportSrcdoc({
    html: '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"></head><body><div id="x"></div></body></html>',
    data: { q: [{ name: evil, n: 1 }] },
    project: { id: "p1", code: "ZAVM", name: "Zirve <Veri> Merkezi" },
    generatedAt: "2026-10-10T09:00:00.000Z",
  });

  it("adds a strict CSP and the theme before the dashboard", () => {
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(REPORT_CSP).toContain("default-src 'none'");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf('<div id="x">'));
    expect(doc).toContain("--c1:");
  });

  it("cannot be broken out of with data, and carries no secrets or API URLs", () => {
    const script = doc.slice(doc.indexOf("window.CDE ="), doc.indexOf("</script>", doc.indexOf("window.CDE =")));
    expect(script).not.toMatch(/<\/script|<script|\u2028/i);
    expect(script).toContain("\\u003c/script\\u003e");
    // The boot object is plain data: parse it back.
    const boot = JSON.parse(script.slice("window.CDE = ".length).replace(/;\s*$/, ""));
    expect(boot.data.q[0].name).toBe(evil);
    expect(Object.keys(boot).sort()).toEqual(["data", "errors", "generatedAt", "labels", "locale", "project", "texts"]);
    expect(doc).not.toMatch(/cde_session|7dcde_|Bearer|\/api\/v1|document\.cookie\s*[^)]/);
    expect(doc).not.toMatch(/http-equiv="refresh"|<base /i);
  });

  it("ships a runtime that parses and strips wrapper tags", () => {
    expect(() => new Function(REPORT_RUNTIME_JS)).not.toThrow();
    expect(cleanDashboardHtml("<html><body><p>a</p></body></html>")).toBe("<p>a</p>");
    expect(reportHtmlWarnings("<script>fetch('/api/v1/x')</script>")).toHaveLength(1);
    expect(reportHtmlWarnings('<img src="https://x.test/a.png">')).toHaveLength(1);
    expect(reportHtmlWarnings("<script>location.href='https://x'</script>").join(" ")).toMatch(/yönlendirme/);
    expect(reportHtmlWarnings(REPORT_TEMPLATES[0]!.html)).toEqual([]);
  });
});

describe("LLM helpers", () => {
  it("strips qwen3 thinking and finds JSON in fenced answers", () => {
    expect(stripThinking("<think>hmm {x}</think>\n{\"a\":1}")).toBe('{"a":1}');
    expect(extractJson('<think>plan</think>Here:\n```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });

  it("is configured from the environment, with qwen3 defaults", () => {
    expect(reportLlmFromEnv({})).toBeUndefined();
    expect(reportLlmFromEnv({ AI_ENABLED: "1" })).toBeDefined();
    expect(reportLlmFromEnv({ AI_MODEL: "qwen3:8b", AI_ENABLED: "0" })).toBeUndefined();
  });

  it("appends /no_think for qwen3 on the OpenAI-compatible call", async () => {
    let sent: { model: string; messages: ReportLlmMessage[] } | null = null;
    const { OpenAiCompatibleReportLlm } = await import("../../src/reports/llm.js");
    const llm = new OpenAiCompatibleReportLlm({
      baseUrl: "http://127.0.0.1:1/v1/",
      model: "qwen3:8b",
      userSuffix: " /no_think",
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://127.0.0.1:1/v1/chat/completions");
        sent = JSON.parse(String(init.body));
        if (calls++ === 0) {
          // Streamed answer, split mid-line like a real socket.
          const sse =
            'data: {"choices":[{"delta":{"content":"<think></think>{\\"a\\":"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"1}"}}]}\n\ndata: [DONE]\n\n';
          const body = new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse.slice(0, 30)));
              c.enqueue(new TextEncoder().encode(sse.slice(30)));
              c.close();
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    let calls = 0;
    expect(await llm.complete([{ role: "system", content: "s" }, { role: "user", content: "panel" }])).toBe('<think></think>{"a":1}');
    expect(sent!.model).toBe("qwen3:8b");
    expect((sent as unknown as { stream: boolean }).stream).toBe(true);
    expect(sent!.messages[1]!.content).toBe("panel /no_think");
    // Servers that ignore `stream` answer with plain JSON.
    expect(await llm.complete([{ role: "user", content: "x" }])).toBe("{}");
  });
});

// ---- API ------------------------------------------------------------------------------

class FakeLlm implements ReportLlm {
  calls: ReportLlmMessage[][] = [];
  constructor(public answers: string[]) {}
  async complete(messages: ReportLlmMessage[]): Promise<string> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const a = this.answers.shift();
    if (a === undefined) throw new Error("no more answers");
    return a;
  }
}

let handle: DbHandle;
let app: FastifyInstance;
let aiApp: FastifyInstance;
let fake: FakeLlm;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-reports-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  fake = new FakeLlm([]);
  aiApp = await buildApp({ db: handle.db, storage, jobs, reportLlm: fake });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await aiApp.close();
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
    ai: () => client(cookie, () => aiApp),
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

  let dashId: string;

  it.skipIf(!hasField || !hasManage)("creates dashboards from templates, private by default", async () => {
    const cat = await murat.get(`/projects/${pid}/reports/catalog`);
    expect(cat.body.aiAvailable).toBe(false);
    expect(cat.body.templates.map((t: { name: string }) => t.name).slice(0, 4)).toEqual([
      "Sorun Durumu (firma ve öncelik)",
      "Termin Aşımları",
      "Doküman Yükleme Aktivitesi (haftalık)",
      "Model Eleman Dağılımı",
    ]);
    // Every module family has templates, grouped by module.
    expect(cat.body.templates.map((t: { module: string }) => t.module)).toEqual(
      expect.arrayContaining(["correspondence", "rfi", "submittals", "meetings", "reviews", "forms", "schedule", "coordination", "doccompare"]),
    );
    const d = await murat.post(`/projects/${pid}/reports`, { templateId: "overdue" });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ name: "Termin Aşımları", sharing: "private", version: 1, isMine: true, canEdit: true });
    const data = await murat.get(`/projects/${pid}/reports/${d.body.id}/data`);
    expect(data.body.results.overdue.map((r: ReportRow) => r.title)).toEqual(["Gecikmiş kritik", "Gecikmiş normal"]);
    expect(data.body.errors).toEqual({});

    // Every template runs without errors.
    for (const t of REPORT_TEMPLATES) {
      const c = await admin.post(`/projects/${pid}/reports`, { templateId: t.id });
      const r = await admin.get(`/projects/${pid}/reports/${c.body.id}/data`);
      expect(r.body.errors, t.id).toEqual({});
      await admin.del(`/projects/${pid}/reports/${c.body.id}`);
    }
  });

  it("shares dashboards and runs their data as the viewer", async () => {
    const d = await murat.post(`/projects/${pid}/reports`, {
      name: "Dosyalarım",
      queries: [{ id: "files", spec: { dataset: "files", metrics: [{ op: "count" }] } }],
      html: "<div id='k'></div><script>CDE.onData(function(d){CDE.kpi('#k',{label:'Dosya',value:CDE.sum(d.files)})})</script>",
    });
    dashId = d.body.id;
    const url = `/projects/${pid}/reports/${dashId}`;
    expect((await semih.get(url)).status).toBe(404);
    expect((await semih.get(`/projects/${pid}/reports`)).body).toEqual([]);

    // Company: Ayşe (Poyraz) yes, Semih (CNS) no.
    expect((await murat.patch(url, { sharing: "company" })).body.version).toBe(2);
    expect((await ayse.get(url)).status).toBe(200);
    expect((await semih.get(url)).status).toBe(404);
    // Admins only.
    await murat.patch(url, { sharing: "admins" });
    expect((await admin.get(url)).status).toBe(200);
    expect((await ayse.get(url)).status).toBe(404);
    // Whole project.
    await murat.patch(url, { sharing: "project" });
    const list = (await semih.get(`/projects/${pid}/reports`)).body;
    expect(list).toEqual([expect.objectContaining({ id: dashId, isMine: false, canEdit: false, ownerName: "Murat" })]);

    // Same dashboard, different numbers per viewer.
    const count = async (c: ReturnType<typeof client>) => (await c.get(`${url}/data`)).body.results.files[0].count;
    expect(await count(murat)).toBe(3);
    expect(await count(semih)).toBe(1);
    expect(await count(ayse)).toBe(0);
    expect(await count(admin)).toBe(4);
  });

  it("lets only the owner or a project admin edit, and keeps versions", async () => {
    const url = `/projects/${pid}/reports/${dashId}`;
    expect((await semih.patch(url, { name: "Benim" })).status).toBe(403);
    expect((await semih.del(url)).status).toBe(403);
    const byAdmin = await admin.patch(url, { name: "Dosya sayısı", baseVersion: 4 });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.version).toBe(5);
    expect((await admin.patch(url, { sharing: "private" })).status).toBe(403); // only the owner shares
    expect((await murat.patch(url, { name: "Eski", baseVersion: 4 })).status).toBe(409);

    const versions = await semih.get(`${url}/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([5, 4, 3, 2, 1]);
    expect(versions.body[0]).toMatchObject({ name: "Dosya sayısı", createdByName: "Admin" });
    expect((await murat.get(`${url}/versions/1`)).body.html).toContain("CDE.onData");
    const restored = await murat.post(`${url}/versions/1/restore`);
    expect(restored.body).toMatchObject({ name: "Dosyalarım", version: 6, sharing: "project" });
  });

  it("limits dashboard HTML to 500 KB and validates queries on save", async () => {
    const big = await murat.post(`/projects/${pid}/reports`, { name: "Büyük", html: "x".repeat(500 * 1024 + 1) });
    expect(big.status).toBe(413);
    const ok = await murat.post(`/projects/${pid}/reports`, { name: "Sınırda", html: "x".repeat(500 * 1024) });
    expect(ok.status).toBe(200);
    expect((await murat.patch(`/projects/${pid}/reports/${ok.body.id}`, { html: "ğ".repeat(256 * 1024) })).status).toBe(413);
    const badQ = await murat.post(`/projects/${pid}/reports`, {
      name: "Hatalı",
      queries: [{ id: "a", spec: { dataset: "activity" } }],
    });
    expect(badQ.status).toBe(400);
    expect(badQ.body.message).toMatch(/yöneticilerine/);
    await murat.del(`/projects/${pid}/reports/${ok.body.id}`);
  });

  it("answers 503 for generate when no model is configured", async () => {
    const r = await murat.post(`/projects/${pid}/reports/generate`, { prompt: "Firmalara göre açık issue'lar" });
    expect(r.status).toBe(503);
    expect(r.body.message).toBe("Yapay zekâ yapılandırılmamış.");
  });

  const goodAnswer = JSON.stringify({
    name: "Firmalara göre issue'lar",
    description: "Açık issue'lar firma bazında",
    queries: [
      { id: "byCompany", spec: { dataset: "issues", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["assigneeCompany"] } },
    ],
    html: "<div id='c'></div><script>CDE.onData(function(d){CDE.bar('#c', d.byCompany, {x:'assigneeCompany', y:'count'})})</script>",
  });

  it("fixes hyphenated query ids and asks for a repair when the HTML ignores a query", async () => {
    const spec = { dataset: "issues", groupBy: ["status"] };
    fake.answers = [
      JSON.stringify({
        name: "Durum",
        queries: [{ id: "open-by-status", spec }],
        html: "<script>CDE.onData(function(d){CDE.table('#t', d.openByStatus)})</script><div id='t'></div>",
      }),
      JSON.stringify({ name: "Durum", queries: [{ id: "unused", spec }, { id: "used", spec }], html: "<script>CDE.onData(function(d){d['used']})</script>" }),
      JSON.stringify({ name: "Durum", queries: [{ id: "used", spec }], html: "<script>CDE.onData(function(d){d['used']})</script>" }),
    ];
    fake.calls = [];
    const a = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "Duruma göre issue'lar" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.attempts).toBe(1);
    expect(Object.keys(a.body.results)).toEqual(["openByStatus"]);
    const b = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "Duruma göre issue'lar" });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.attempts).toBe(2);
    expect(fake.calls[2]!.at(-1)!.content).toContain("html does not use query 'unused'");
  });

  it("repairs an invalid model answer once and returns preview data", async () => {
    fake.answers = [
      // Wrong field name and an unknown dataset.
      JSON.stringify({
        name: "x",
        queries: [
          { id: "a", spec: { dataset: "issues", groupBy: ["firma"] } },
          { id: "b", spec: { dataset: "teklifler" } },
        ],
        html: "<div></div>",
      }),
      `<think>Düzeltiyorum.</think>\n\`\`\`json\n${goodAnswer}\n\`\`\``,
    ];
    fake.calls = [];
    const r = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "Firmalara göre açık issue sayısı" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.attempts).toBe(2);
    expect(r.body.draft.name).toBe("Firmalara göre issue'lar");
    expect(r.body.results.byCompany).toEqual(
      expect.arrayContaining([
        { assigneeCompany: "CNS", count: 2 },
        { assigneeCompany: "Poyraz", count: 1 },
      ]),
    );
    expect(fake.calls).toHaveLength(2);
    const system = fake.calls[0]![0]!.content;
    expect(system).toContain("### issues");
    expect(system).toContain("assigneeCompany (string)");
    expect(system).not.toContain("### activity"); // Murat is not a project admin
    const repair = fake.calls[1]!.at(-1)!.content;
    expect(repair).toContain("'firma' alanı yok");
    expect(repair).toContain("'teklifler' diye bir veri kümesi yok");
    // Nothing was saved.
    expect((await murat.get(`/projects/${pid}/reports`)).body.map((d: { name: string }) => d.name)).not.toContain("Firmalara göre issue'lar");
  });

  it("returns a valid answer directly and supports iterative edits", async () => {
    fake.answers = [goodAnswer];
    fake.calls = [];
    const r = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "Termini geçenleri göster", dashboardId: dashId });
    expect(r.status).toBe(200);
    expect(r.body.attempts).toBe(1);
    const userMsg = fake.calls[0]!.at(-1)!.content;
    expect(userMsg).toContain("Current dashboard");
    expect(userMsg).toContain("Dosyalarım");
    expect(userMsg).toContain("Termini geçenleri göster");

    // Unsaved draft as the current state.
    fake.answers = [goodAnswer];
    const draft = r.body.draft;
    const e = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "grafiği yatay yap", current: draft });
    expect(e.status).toBe(200);
    expect(fake.calls[1]!.at(-1)!.content).toContain("Firmalara göre issue'lar");
  });

  it("gives up after one repair and audits without the prompt text", async () => {
    fake.answers = ["bilmiyorum", "hâlâ bilmiyorum"];
    const r = await murat.ai().post(`/projects/${pid}/reports/generate`, { prompt: "gizli istek metni" });
    expect(r.status).toBe(422);
    expect(r.body.details.errors[0]).toMatch(/JSON/);
    const act = await admin.post(`/projects/${pid}/reports/query`, {
      queries: [{ id: "g", dataset: "activity", filters: [{ field: "action", op: "eq", value: "report.generated" }], metrics: [{ op: "count" }] }],
    });
    expect(act.body.results.g).toEqual([{ count: 6 }]);
    const log = await admin.get(`/projects/${pid}/activity`);
    const gen = log.body.filter((e: { action: string }) => e.action === "report.generated");
    expect(gen[0].details).toMatchObject({ promptLength: "gizli istek metni".length, attempts: 2, ok: false });
    expect(JSON.stringify(gen)).not.toContain("gizli istek");
    expect(log.body.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["report.created", "report.updated", "report.restored", "report.deleted"]),
    );
  });
});
