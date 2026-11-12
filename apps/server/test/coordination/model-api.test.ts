/** "Modele sor" and the AI comparison summary over HTTP, with a fake local model. */
import { hasAi } from "../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { cdeParseArgs, cdeToolDefinitions } from "@sitekeep/cde-tools";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users, versionIndexes } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { saveVersionIndex } from "../../src/jobs/version-index.js";
import { queryCache, summaryCache } from "../../src/model/ai.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../fixtures/model-query.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../fixtures/model-query-v2.ifc"));
const D1 = "0MqDoor000000000000001";
const D3 = "0MqDoor000000000000003";
const W2 = "0MqWall000000000000002";
const COL = "0MqColumn0000000000001";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;
let stub: Server;
let stubUrl: string;
let stubCalls = 0;
let stubBroken = false;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-model-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 7) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      stubCalls++;
      const body = raw ? JSON.parse(raw) : {};
      const system: string = body.messages?.[0]?.content ?? "";
      const user: string = body.messages?.[1]?.content ?? "";
      let answer: string;
      if (stubBroken) answer = "Bunu yapamam.";
      else if (system.includes("sorgu çevirmeni"))
        answer = user.includes("değişti")
          ? '{"classes":["IfcDoor"],"change":["changed"]}'
          : '<think>kapılar…</think>```json\n{"classes":["IfcDoor"],"filters":[{"field":"FireRating","op":"<>","value":"EI60"}],"storeys":null}\n```';
      else answer = '{"bullets":[{"text":"Zemin katta 1 kapının yangın dayanımı EI30 → EI60 oldu.","refs":["g1","g99"]},{"text":"Kat 1: 1 duvar silindi, 1 kolon eklendi.","refs":["g2","g3"]}]}';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await new Promise((r) => stub.close(r));
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
    put: (u: string, p: unknown) => call("PUT", u, p),
    upload: async (url: string, fileList: { name: string; data: Buffer | string }[]) => {
      const form = new FormData();
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

describe("Modele sor and comparison summary", () => {
  let admin: ReturnType<typeof api>;
  let semih: ReturnType<typeof api>; // view
  let osman: ReturnType<typeof api>; // member without folder permission
  let pid: string;
  let folderId: string;
  let fileId: string;
  let v1: string;
  let v2: string;
  const P = () => `/projects/${pid}`;

  it("sets up a project with two IFC versions", async () => {
    admin = api(await login("admin@7d.test"));
    const ids: Record<string, string> = {};
    for (const key of ["semih", "osman"]) {
      const u = await admin.post("/users", { email: `${key}@7d.test`, name: key, password: PW });
      ids[key] = u.body.id;
    }
    const p = await admin.post("/projects", { code: "MDL", name: "Model Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    folderId = (await admin.post(`/projects/${pid}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    for (const key of ["semih", "osman"]) expect((await admin.post(`/projects/${pid}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    await admin.put(`/projects/${pid}/folders/${folderId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.semih, level: "view" }] });
    semih = api(await login("semih@7d.test"));
    osman = api(await login("osman@7d.test"));
    await admin.upload(`${P()}/folders/${folderId}/files`, [{ name: "Mimari.ifc", data: IFC_V1 }]);
    await jobs.drain();
    const up = await admin.upload(`${P()}/folders/${folderId}/files`, [{ name: "Mimari.ifc", data: IFC_V2 }]);
    await jobs.drain();
    fileId = up.body.results[0].fileId;
    const file = await admin.get(`${P()}/files/${fileId}`);
    [v2, v1] = file.body.versions.map((v: { id: string }) => v.id);
    expect(file.body.versions.every((v: { derivativeStatus: string }) => v.derivativeStatus === "ready")).toBe(true);
  });

  it("returns the vocabulary for the filter builder", async () => {
    const r = await semih.get(`${P()}/versions/${v1}/model-vocab`);
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ versionId: v1, fileName: "Mimari.ifc", version: 1, elementCount: 7 });
    expect(r.body.storeys.map((s: { name: string }) => s.name)).toEqual(["Zemin Kat", "Kat 1"]);
    expect(r.body.properties.some((p: { key: string }) => p.key === "Pset_DoorCommon.FireRating")).toBe(true);
  });

  it("runs structured queries with the caller's permissions", async () => {
    const r = await semih.post(`${P()}/versions/${v1}/model-query`, { query: { classes: ["IfcSlab"], aggregate: { op: "sum", field: "NetArea" } } });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ count: 2, aggregate: { value: 44.5, unit: "m²" } });
    expect(r.body.answer).toContain("44,5 m²");
    expect((await semih.post(`${P()}/versions/${v1}/model-query`, { query: { code: "rm -rf" } })).status).toBe(400);
    expect((await osman.post(`${P()}/versions/${v1}/model-query`, { query: {} })).status).toBe(404);
  });

  it("answers with keyword rules when no model is configured (fallback)", async () => {
    const r = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "EI60 olmayan kapılar" });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ source: "rules", question: "EI60 olmayan kapılar", count: 2 });
    expect(r.body.aiError).toContain(hasAi ? "sağlayıcısı" : "kapatıldı"); // without the AI module AI is off
    expect(r.body.guids.sort()).toEqual([D1, D3]);
    const quick = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "kaç m² döşeme var", mode: "rules" });
    expect(quick.body).toMatchObject({ source: "rules", aggregate: { value: 44.5 } });
    expect(quick.body.aiError).toBeUndefined();
  });

  it.skipIf(!hasAi)("lets the (fake) local model write the query, then caches it", async () => {
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    queryCache.clear();
    stubCalls = 0;
    const r = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "Yangın dayanımı EI60 olmayan kapılar hangileri?" });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ source: "ai", model: "qwen3:8b", count: 2, query: { classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "!=", value: "EI60" }] } });
    expect(r.body.cached).toBeUndefined();
    const again = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "yangın dayanımı EI60 olmayan kapılar hangileri" });
    expect(again.body).toMatchObject({ source: "ai", cached: true, count: 2 });
    expect(stubCalls).toBe(1);

    // A broken answer falls back to the rules.
    stubBroken = true;
    const bad = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "kaç m² döşeme var" });
    stubBroken = false;
    expect(bad.body).toMatchObject({ source: "rules", aggregate: { value: 44.5 } });
    expect(bad.body.aiError).toContain("geçerli");
  });

  it("returns 403 / fallback when AI is switched off", async () => {
    await admin.put("/admin/settings/ai", { mode: "off" });
    queryCache.clear();
    const r = await semih.post(`${P()}/versions/${v1}/model-ask`, { question: "Kat 1'deki duvarları listele" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: "rules", count: 1, aiError: "Yapay zekâ sistem yöneticisi tarafından kapatıldı." });
    const s = await semih.post(`${P()}/compare/summary`, { from: v1, to: v2 });
    expect(s.body).toMatchObject({ source: "deterministic", ai: null });
    expect(s.body.aiError).toContain("kapatıldı");
    await admin.put("/admin/settings/ai", { mode: "local_only" });
  });

  it("enriches the comparison with property changes and groups", async () => {
    const c = await semih.get(`${P()}/compare?from=${v1}&to=${v2}`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ added: [COL], removed: [W2], changed: [D1], detailed: true });
    expect(c.body.changes[D1]).toEqual([{ prop: "Pset_DoorCommon.FireRating", from: "EI30", to: "EI60" }]);
    expect(c.body.storeys[W2]).toBe("Kat 1");
    expect(c.body.groups.map((g: { text: string }) => g.text)).toEqual([
      "Zemin Kat · Kapı: 1 elemanda FireRating EI30 → EI60",
      "Kat 1 · Duvar: 1 silindi",
      "Kat 1 · Kolon: 1 eklendi",
    ]);
  });

  it.skipIf(!hasAi)("summarises the comparison with AI, groups stay clickable", async () => {
    summaryCache.clear();
    const s = await semih.post(`${P()}/compare/summary`, { from: v1, to: v2 });
    expect(s.status, s.body?.message).toBe(200);
    expect(s.body).toMatchObject({ source: "ai", detailed: true, counts: { added: 1, changed: 1, removed: 1 } });
    expect(s.body.bullets[0]).toEqual({ text: "Zemin Kat · Kapı: 1 elemanda FireRating EI30 → EI60", groupIds: ["g1"] });
    expect(s.body.ai.bullets).toEqual([
      { text: "Zemin katta 1 kapının yangın dayanımı EI30 → EI60 oldu.", groupIds: ["g1"] },
      { text: "Kat 1: 1 duvar silindi, 1 kolon eklendi.", groupIds: ["g2", "g3"] },
    ]);
    const quick = await semih.post(`${P()}/compare/summary`, { from: v1, to: v2, ai: false });
    expect(quick.body).toMatchObject({ source: "deterministic", ai: null });
    expect((await semih.post(`${P()}/compare/summary`, { from: v1, to: v2 })).body.cached).toBe(true);

    const html = await semih.get(`${P()}/compare/report?from=${v1}&to=${v2}`);
    expect(html.status).toBe(200);
    expect(html.raw.headers["content-type"]).toContain("text/html");
    expect(html.raw.body).toContain("Zemin katta 1 kapının yangın dayanımı");
    expect(html.raw.body).toContain("Değişiklik grupları");
    expect((await osman.get(`${P()}/compare/report?from=${v1}&to=${v2}`)).status).toBe(404);
  });

  it.skipIf(!hasAi)("answers follow-up questions about the diff only", async () => {
    queryCache.clear();
    const r = await semih.post(`${P()}/versions/${v2}/model-ask`, { question: "hangi kapılar değişti?", compareFrom: v1 });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ source: "ai", compareFrom: v1, total: 3, count: 1, guids: [D1], query: { classes: ["IfcDoor"], change: ["changed"] } });
    const removed = await semih.post(`${P()}/versions/${v2}/model-query`, { query: { change: ["removed"] }, compareFrom: v1 });
    expect(removed.body).toMatchObject({ count: 1, guids: [], removedGuids: [W2] });
  });

  it("saves a query as a live personal report panel", async () => {
    const query = { classes: ["IfcSlab"], aggregate: { op: "sum", field: "NetArea" }, groupBy: ["storey"] };
    const draft = await semih.post(`${P()}/versions/${v1}/model-query/report-draft`, { query, question: "kaç m² döşeme var" });
    expect(draft.status, draft.body?.message).toBe(200);
    expect(draft.body.queries.map((q: { id: string }) => q.id)).toEqual(["items", "summary"]);
    const created = await semih.post(`${P()}/reports`, { ...draft.body, sharing: "private" });
    expect(created.status, created.body?.message).toBe(200);
    const data = await semih.get(`${P()}/reports/${created.body.id}/data`);
    expect(data.status).toBe(200);
    expect(data.body.errors).toEqual({});
    // Follows the newest version (V2 has the same two slabs).
    expect(data.body.results.items).toHaveLength(2);
    expect(data.body.results.items.map((r: { name: string }) => r.name).sort()).toEqual(["Doseme-01", "Doseme-02"]);
    expect(data.body.results.items[0]).toMatchObject({ classLabel: "Döşeme", value: expect.any(Number) });
    expect(data.body.results.summary).toEqual(
      expect.arrayContaining([
        { storey: "Zemin Kat", count: 1, value: 24 },
        { storey: "Kat 1", count: 1, value: 20.5 },
      ]),
    );
    expect(data.body.results.summary.reduce((a: number, r: { value: number }) => a + r.value, 0)).toBe(44.5);
  });

  it("offers cde_model_query and cde_model_compare_summary (MCP / Sor)", async () => {
    const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
      const r = method === "GET" ? await semih.get(url) : await semih.post(url, body);
      if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body?.message}`);
      return r.body as T;
    };
    const defs = cdeToolDefinitions(call, { readOnly: true });
    const tool = (name: string) => {
      const d = defs.find((x) => x.name === name)!;
      expect(d.write).toBe(false);
      return (args: Record<string, unknown>) => d.run(cdeParseArgs(d, args)) as Promise<any>;
    };
    const vocab = await tool("cde_model_query")({ projectId: pid, model: "mimari" });
    expect(vocab.storeys).toEqual(["Zemin Kat (3)", "Kat 1 (4)"]); // newest version (V2)
    expect(vocab.properties).toContain("Pset_DoorCommon.FireRating: EI60");
    const q = await tool("cde_model_query")({ projectId: pid, versionId: v1, query: { classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "!=", value: "EI60" }] } });
    expect(q).toMatchObject({ versionId: v1, count: 2 });
    expect(q.elements.map((e: { globalId: string }) => e.globalId).sort()).toEqual([D1, D3]);
    const fed = await tool("cde_model_query")({ projectId: pid, versionIds: [v1, v2], query: { classes: ["IfcColumn"] } });
    expect(fed).toMatchObject({ count: 1, inScope: 14 });
    expect(fed.elements[0]).toMatchObject({ globalId: COL, model: "Mimari" });
    // Every match in one of the models: the viewer still needs to know which one to paint.
    const raw = (await semih.post(`${P()}/versions/${v1}/model-query`, { query: { classes: ["IfcColumn"] }, versionIds: [v1, v2] })).body;
    expect(raw.byVersion).toEqual([{ versionId: raw.elements[0].versionId, guids: [COL] }]);
    const s = await tool("cde_model_compare_summary")({ projectId: pid, model: "Mimari" });
    expect(s).toMatchObject({ model: "Mimari.ifc V1 → V2", counts: { added: 1, removed: 1, changed: 1 } });
    expect(s.summary[0]).toBe("Zemin Kat · Kapı: 1 elemanda FireRating EI30 → EI60");
  });

  it("upgrades an old-format index in the background (409 meanwhile)", async () => {
    const [row] = await handle.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, v1));
    const chunks: Buffer[] = [];
    for await (const ch of storage.get(row!.storageKey)) chunks.push(ch as Buffer);
    const old = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tmp = path.join(dataDir, "old-index.json");
    writeFileSync(tmp, JSON.stringify({ v: 1, elements: old.elements }));
    await saveVersionIndex(handle.db, storage, v1, pid, tmp, 7);

    const first = await semih.post(`${P()}/versions/${v1}/model-query`, { query: {} });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ error: "preparing", details: { pending: [v1] } });
    // The plain comparison still works and says it is upgrading.
    const c = await semih.get(`${P()}/compare?from=${v1}&to=${v2}`);
    expect(c.body).toMatchObject({ detailed: false, upgrading: true, changed: [D1] });
    await jobs.drain();
    const after = await semih.post(`${P()}/versions/${v1}/model-query`, { query: { classes: ["IfcDoor"] } });
    expect(after.status).toBe(200);
    expect(after.body.count).toBe(3);
  });
});
