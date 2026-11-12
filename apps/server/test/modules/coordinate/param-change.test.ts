/**
 * "Değişiklik Talebi" over HTTP / MCP: preview (selection, query, sentence with a fake local model),
 * approval rules, apply → new IFC version (upload rules, verified from the new index), type-level
 * values, rebase, re-checks of later versions ("Değerler Kayboldu", Revit verification), the AI task
 * queue kind and the MCP tools. Synthetic IFCs only (test/param-change-fixtures.ts).
 */
import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type * as WebIFC from "web-ifc";
import { paramChangeLostMessage } from "@7dimensions-project/sitekeep-ee-coordinate/shared/param-change.js";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, fileVersions, files, notifications, users } from "../../../src/db/schema.js";
import { paramChangeChecks } from "@7dimensions-project/sitekeep-ee-coordinate/internal/schema-tables.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { applyParamChanges } from "../../../src/jobs/param-change-worker.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { D1, W1, W2, W3, ifcApi, paramIfc, readModel } from "../../coordination/param-change-fixtures.js";

const PW = "Sifre-1234567";
const IFC = paramIfc("IFC4");

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;
let ifc: WebIFC.IfcAPI;
let stub: Server;
let stubUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-param-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 9), devTools: false });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  ifc = await ifcApi();
  // Fake local model: answers by the sentence (never a real LLM).
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const user: string = body.messages?.[1]?.content ?? "";
      const sentence = user.slice(user.lastIndexOf("Cümle:"));
      let answer = '{"query":{"classes":["IfcWall"],"filters":[{"field":"FireRating","op":"=","value":"EI30"}]},"set":{"property":"FireRating","value":"EI60"}}';
      if (sentence.includes("uydurma")) answer = '{"query":{"classes":["IfcWall"]},"set":{"property":"YanginSinifiUydurma","value":"EI60"}}';
      if (sentence.includes("yükselt")) answer = '{"query":{"classes":["IfcWall"],"filters":[{"field":"FireRating","op":"=","value":"EI30"}]},"set":{"property":"FireRating","value":"EI180"}}';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "```json\n" + answer + "\n```" } }] }));
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

function client(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
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
    upload: async (url: string, name: string, data: string | Uint8Array) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie, "content-type": req.headers.get("content-type")! }, payload: Buffer.from(await req.arrayBuffer()) });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

let rpcId = 0;
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  return res.json() as any;
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text: string = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { isError: !!(r.error ?? r.result?.isError), text, json };
}

describe("Değişiklik Talebi (parameter change requests)", () => {
  let admin: ReturnType<typeof client>;
  let ayse: ReturnType<typeof client>; // member, edit on the folder (creates requests)
  let onur: ReturnType<typeof client>; // approver role, edit on the folder
  let veli: ReturnType<typeof client>; // view only
  let osman: ReturnType<typeof client>; // member without folder rights
  const ids: Record<string, string> = {};
  let pid: string;
  let folderId: string;
  let fileId: string;
  let roleId: string;
  let v1: string;
  let r1: string;
  const P = () => `/projects/${pid}`;

  const latest = async () => {
    const f = (await admin.get(`${P()}/files/${fileId}`)).body;
    return { id: f.versions[0].id as string, version: f.versions[0].version as number, count: f.versions.length as number };
  };
  const bytesOf = async (versionId: string) => {
    const [v] = await handle.db.select().from(fileVersions).where(eq(fileVersions.id, versionId));
    return new Uint8Array(readFileSync(storage.localPath(v!.storageKey)));
  };
  const spec = (globalIds: string[], set: Record<string, unknown>) => ({ source: "selection", globalIds, set });
  const wallsEi30 = { source: "query", query: { classes: ["IfcWall"], filters: [{ field: "FireRating", op: "=", value: "EI30" }] }, set: { property: "FireRating", value: "EI60" } };
  const lostNotes = async () => handle.db.select().from(notifications).where(eq(notifications.kind, "param_change.values_lost"));

  it("sets up a project with an IFC model, an approver role and members", async () => {
    admin = client(await login("admin@7d.test"));
    for (const key of ["ayse", "onur", "veli", "osman"]) ids[key] = (await admin.post("/users", { email: `${key}@7d.test`, name: key, password: PW })).body.id;
    const p = await admin.post("/projects", { code: "PRM", name: "Parametre Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    folderId = (await admin.post(`${P()}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    for (const key of ["ayse", "onur", "veli", "osman"]) expect((await admin.post(`${P()}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    roleId = (await admin.post(`${P()}/roles`, { name: "BIM Koordinatör" })).body.id;
    expect((await admin.post(`${P()}/roles/${roleId}/members/${ids.onur}`)).status).toBe(200);
    const perms = await admin.put(`${P()}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids.ayse, level: "edit" },
        { subjectType: "role", subjectId: roleId, level: "edit" },
        { subjectType: "user", subjectId: ids.veli, level: "view" },
      ],
    });
    expect(perms.status, JSON.stringify(perms.body)).toBe(200);
    ayse = client(await login("ayse@7d.test"));
    onur = client(await login("onur@7d.test"));
    veli = client(await login("veli@7d.test"));
    osman = client(await login("osman@7d.test"));
    const up = await ayse.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", IFC);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    fileId = up.body.results[0].fileId;
    await jobs.drain();
    v1 = (await latest()).id;
  });

  it("previews from a selection and a query; names match case- and Turkish-insensitively", async () => {
    const sel = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1, D1], { property: "firerating", value: "EI60" }) });
    expect(sel.status, sel.body?.message).toBe(200);
    expect(sel.body).toMatchObject({ total: 2, changes: 2, missing: 1, unchanged: 0, suggestedOwnership: "revit" });
    expect(sel.body.items.find((i: any) => i.globalId === W1)).toMatchObject({ pset: "Pset_WallCommon", property: "FireRating", oldValue: "EI30", newValue: "EI60", source: "instance" });
    expect(sel.body.items.find((i: any) => i.globalId === D1)).toMatchObject({ pset: "Pset_DoorCommon", oldValue: null, source: "missing" });

    const q = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: wallsEi30 });
    expect(q.body).toMatchObject({ total: 3, changes: 3, byStorey: [{ storey: "Zemin Kat", count: 1 }, { storey: "Kat 1", count: 2 }] });
    expect(q.body.guids.sort()).toEqual([W1, W2, W3]);

    const tr = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1], { pset: "cde_bilgi", property: "KONTROL DURUMU", value: "Kapalı" }) });
    expect(tr.body.items[0]).toMatchObject({ pset: "CDE_Bilgi", property: "Kontrol Durumu", oldValue: "Açık", newValue: "Kapalı" });

    const type = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1], { property: "acousticrating", value: "R50" }) });
    expect(type.body).toMatchObject({ typeLevel: 1, typeImpact: [{ typeName: "Duvar 20", instances: 3, othersCount: 2 }] });
    expect(type.body.items[0].source).toBe("type");

    const same = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1], { property: "FireRating", value: "ei 30" }) });
    expect(same.body).toMatchObject({ changes: 0, unchanged: 1 });

    expect((await osman.post(`${P()}/param-changes/preview`, { versionId: v1, spec: wallsEi30 })).status).toBe(404);
    const qto = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1], { pset: "Qto_WallBaseQuantities", property: "NetSideArea", value: 20 }) });
    expect(qto.status).toBe(400);
    const unknown = await veli.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W1], { property: "Yepyeni", value: "x" }) });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("özellik seti");
  });

  it("creates drafts and follows the approval rules", async () => {
    expect((await ayse.get(`${P()}/param-changes/settings`)).body).toMatchObject({ approvalRequired: true, approverRoleId: null, isApprover: false });
    // Model / Koordinasyon module off → no new requests.
    await admin.put(`${P()}/modules`, { modules: { coordination: false } });
    const off = await ayse.post(`${P()}/param-changes`, { versionId: v1, title: "Kapalı modül", spec: wallsEi30 });
    expect(off.status).toBe(403);
    expect(off.body.error).toBe("module_disabled");
    await admin.put(`${P()}/modules`, { modules: { coordination: true } });

    const c = await ayse.post(`${P()}/param-changes`, { versionId: v1, title: "Duvar yangın dayanımı EI60", reason: "Yangın raporu", spec: wallsEi30 });
    expect(c.status, c.body?.message).toBe(200);
    r1 = c.body.id;
    expect(c.body).toMatchObject({ code: "PD-001", status: "draft", statusLabel: "Taslak", ownership: "revit", itemCount: 3, baseVersion: 1, stale: false });
    expect(c.body.can).toMatchObject({ submit: true, approve: false, apply: false });
    expect((await veli.get(`${P()}/param-changes/${r1}`)).status).toBe(200);
    expect((await veli.post(`${P()}/param-changes/${r1}/submit`)).status).toBe(403);
    expect((await osman.get(`${P()}/param-changes/${r1}`)).status).toBe(404);
    expect((await osman.get(`${P()}/param-changes`)).body).toEqual([]);
    expect((await ayse.post(`${P()}/param-changes/${r1}/apply`)).status).toBe(403);

    // Approver role, then submit → approve.
    expect((await ayse.put(`${P()}/param-changes/settings`, { approverRoleId: roleId })).status).toBe(403);
    expect((await admin.put(`${P()}/param-changes/settings`, { approverRoleId: roleId })).body).toMatchObject({ approvalRequired: true, approverRoleId: roleId });
    expect((await onur.post(`${P()}/param-changes/${r1}/apply`)).status).toBe(409); // not approved yet
    const sub = await ayse.post(`${P()}/param-changes/${r1}/submit`);
    expect(sub.body).toMatchObject({ status: "pending", statusLabel: "Onay Bekliyor" });
    const pending = await handle.db.select().from(notifications).where(eq(notifications.kind, "param_change.pending"));
    expect(pending.map((n) => n.userId)).toEqual(expect.arrayContaining([ids.onur]));
    expect(pending.map((n) => n.userId)).not.toContain(ids.ayse);
    expect((await ayse.post(`${P()}/param-changes/${r1}/approve`)).status).toBe(403);
    const ok = await onur.post(`${P()}/param-changes/${r1}/approve`, { note: "Uygun" });
    expect(ok.body).toMatchObject({ status: "approved", decidedByName: "onur", decisionNote: "Uygun" });
    expect((await ayse.get(`${P()}/param-changes/${r1}`)).body.can).toMatchObject({ apply: false, cancel: true });
    expect((await onur.get(`${P()}/param-changes/${r1}`)).body.can).toMatchObject({ apply: true, authoring: true });

    // Adding properties the model does not have is CDE enrichment by default.
    const enrich = await ayse.post(`${P()}/param-changes/preview`, { versionId: v1, spec: spec([W2], { pset: "CDE_Bilgi", property: "Kontrol Notu", value: "Kontrol edildi" }) });
    expect(enrich.body).toMatchObject({ missing: 1, suggestedOwnership: "cde_only" });
  });

  it("refuses to apply into a gated folder (the upload rules)", async () => {
    expect((await admin.put(`${P()}/folders/${folderId}/settings`, { requireApprovedReview: true })).status).toBe(200);
    const r = await onur.post(`${P()}/param-changes/${r1}/apply`);
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("onaylanmış bir inceleme");
    await admin.put(`${P()}/folders/${folderId}/settings`, { requireApprovedReview: false });
  });

  it("applies an approved request as a new version and verifies it from the new index", async () => {
    await handle.db.update(files).set({ attributes: { Disiplin: "Mimari" } }).where(eq(files.id, fileId));
    const start = await onur.post(`${P()}/param-changes/${r1}/apply`);
    expect(start.status, start.body?.message).toBe(200);
    expect(start.body.status).toBe("applying");
    await jobs.drain();
    const r = (await onur.get(`${P()}/param-changes/${r1}`)).body;
    expect(r).toMatchObject({ status: "applied", statusLabel: "Uygulandı", appliedVersion: 2, counts: { ok: 3, failed: 0, lost: 0 } });
    expect(r.verifiedVersionId).toBe(r.appliedVersionId);
    const f = (await admin.get(`${P()}/files/${fileId}`)).body;
    expect(f).toMatchObject({ currentVersion: 2, attributes: { Disiplin: "Mimari" } });
    expect(f.versions[0]).toMatchObject({ comment: "Parametre değişikliği: Duvar yangın dayanımı EI60 (3 eleman)", uploadedBy: ids.onur, derivativeStatus: "ready" });

    // Read back with web-ifc: values changed, elements, GlobalIds, placements and geometry the same.
    const before = readModel(ifc, await bytesOf(v1));
    const after = readModel(ifc, await bytesOf(r.appliedVersionId));
    for (const w of [W1, W2, W3]) expect(after.props.get(w)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI60");
    expect(after.elements).toEqual(before.elements);
    // …and through the new version's index ("Modele sor").
    const q = await veli.post(`${P()}/versions/${r.appliedVersionId}/model-query`, { query: { filters: [{ field: "FireRating", op: "=", value: "EI60" }] } });
    expect(q.body.count).toBe(3);
    const cmp = await veli.get(`${P()}/compare?from=${v1}&to=${r.appliedVersionId}`);
    expect(cmp.body.changed.sort()).toEqual([W1, W2, W3]);
    expect(cmp.body.added).toEqual([]);

    const audits = await handle.db.select().from(auditLog).where(and(eq(auditLog.targetId, r1), eq(auditLog.action, "param_change.applied")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: ids.onur });
    const today = (await ayse.get(`${P()}/today?ai=0`)).body;
    const texts = today.changes.flatMap((d: any) => d.changes.map((c: any) => `${c.userName} ${c.text}: ${c.items.map((i: any) => i.label).join(", ")}`));
    expect(texts).toContain("onur parametre değişikliğini uyguladı (yeni versiyon): PD-001 Duvar yangın dayanımı EI60");
  });

  it("changes type-level values on the element (default) or on the type", async () => {
    const make = async (title: string, globalIds: string[], value: string, typeMode: string) => {
      const l = await latest();
      const c = await ayse.post(`${P()}/param-changes`, { versionId: l.id, title, spec: spec(globalIds, { property: "AcousticRating", value }), typeMode });
      expect(c.status, c.body?.message).toBe(200);
      expect((await admin.post(`${P()}/param-changes/${c.body.id}/approve`)).status).toBe(200);
      expect((await admin.post(`${P()}/param-changes/${c.body.id}/apply`)).status).toBe(200);
      await jobs.drain();
      const r = (await admin.get(`${P()}/param-changes/${c.body.id}`)).body;
      expect(r.status, r.error).toBe("applied");
      return readModel(ifc, await bytesOf(r.appliedVersionId));
    };
    const inst = await make("Akustik W1", [W1], "R50", "instance");
    expect(inst.props.get(W1)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R50", from: "instance" });
    expect(inst.props.get(W2)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R40", from: "type" });
    const type = await make("Akustik tip", [W2], "R55", "type");
    expect(type.props.get(W2)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R55", from: "type" });
    expect(type.props.get(W3)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R55", from: "type" });
    expect(type.props.get(W1)!.get("Pset_WallCommon.AcousticRating")!.value).toBe("R50"); // its own override stays
    // r1 was re-checked against both new versions: values still there, no warning.
    expect((await admin.get(`${P()}/param-changes/${r1}`)).body.status).toBe("applied");
    expect(await lostNotes()).toHaveLength(0);
  });

  it("lets a project admin apply a draft when approval is off; others still need approval", async () => {
    await admin.put(`${P()}/param-changes/settings`, { approvalRequired: false });
    const l = await latest();
    const c = (await ayse.post(`${P()}/param-changes`, { versionId: l.id, title: "Kapı yangın dayanımı", spec: spec([D1], { pset: "Pset_DoorCommon", property: "FireRating", value: "EI30" }) })).body;
    expect(c.ownership).toBe("cde_only");
    expect((await ayse.post(`${P()}/param-changes/${c.id}/apply`)).status).toBe(403);
    expect((await onur.post(`${P()}/param-changes/${c.id}/apply`)).status).toBe(409); // approver role, not project admin
    expect((await admin.post(`${P()}/param-changes/${c.id}/apply`)).status).toBe(200);
    await jobs.drain();
    expect((await admin.get(`${P()}/param-changes/${c.id}`)).body.status).toBe("applied");
    await admin.put(`${P()}/param-changes/settings`, { approvalRequired: true });
  });

  it("re-checks applied requests on every new version: kept values, lost values (reopened, notified), idempotent", async () => {
    // A request approved now, applied after the file moved on (needs a rebase).
    let l = await latest();
    const r5 = (await ayse.post(`${P()}/param-changes`, { versionId: l.id, title: "W3 kontrol notu", spec: spec([W3], { pset: "CDE_Bilgi", property: "Kontrol Notu", value: "Tamam" }) })).body;
    await onur.post(`${P()}/param-changes/${r5.id}/approve`);

    // Re-upload that keeps the values (e.g. a re-export with the change): no warning.
    const kept = new Uint8Array([...(await bytesOf(l.id)), 10]);
    await ayse.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", kept);
    await jobs.drain();
    const keptV = await latest();
    expect((await admin.get(`${P()}/param-changes/${r1}`)).body.status).toBe("applied");
    expect(await lostNotes()).toHaveLength(0);
    const [keptCheck] = await handle.db.select().from(paramChangeChecks).where(and(eq(paramChangeChecks.requestId, r1), eq(paramChangeChecks.versionId, keptV.id)));
    expect(keptCheck).toMatchObject({ ok: true, present: 3, lost: 0 });

    // Re-upload of the old model (a Revit re-export without the change): values lost.
    await ayse.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", IFC);
    await jobs.drain();
    const lostV = await latest();
    const r = (await ayse.get(`${P()}/param-changes/${r1}`)).body;
    expect(r).toMatchObject({ status: "values_lost", statusLabel: "Değerler Kayboldu", lostVersionId: lostV.id, lostVersion: lostV.version, counts: { lost: 3 } });
    expect(r.items.every((i: any) => i.result === "lost" && i.resultMessage === `V${lostV.version}'de yok.`)).toBe(true);
    expect(r.can).toMatchObject({ cancel: true });
    const notes = (await lostNotes()).filter((n) => n.link === `/projects/${pid}/param-changes/${r1}`);
    expect(notes.map((n) => n.title)).toEqual([paramChangeLostMessage("Duvar yangın dayanımı EI60", 3), paramChangeLostMessage("Duvar yangın dayanımı EI60", 3)]);
    expect(notes.map((n) => n.userId).sort()).toEqual([ids.ayse, (await adminId())].sort());
    const status = (await ayse.get(`${P()}/files/${fileId}/param-change-status`)).body;
    expect(status.lost).toBeGreaterThanOrEqual(1);
    expect(status.versionWarnings[lostV.id].requests).toContain("PD-001");
    expect((await ayse.get(`${P()}/param-changes?status=values_lost`)).body.map((x: any) => x.id)).toContain(r1);

    // Idempotent: the same version is never checked twice (again by job or by a re-index).
    const notesBefore = (await lostNotes()).length;
    const checksBefore = (await handle.db.select().from(paramChangeChecks)).length;
    await jobs.enqueue("param_change_check", { versionId: lostV.id, ok: true });
    await jobs.enqueue("ifc_index", { versionId: lostV.id });
    await jobs.drain();
    expect((await lostNotes()).length).toBe(notesBefore);
    expect((await handle.db.select().from(paramChangeChecks)).length).toBe(checksBefore);

    // Stale base: apply refuses, rebase moves the items, then it applies.
    const stale = await onur.post(`${P()}/param-changes/${r5.id}/apply`);
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain("güncel versiyona");
    const moved = await onur.post(`${P()}/param-changes/${r5.id}/rebase`);
    expect(moved.body).toMatchObject({ baseVersionId: lostV.id, stale: false });
    expect((await onur.post(`${P()}/param-changes/${r5.id}/apply`)).status).toBe(200);
    await jobs.drain();
    expect((await onur.get(`${P()}/param-changes/${r5.id}`)).body.status).toBe("applied");

    // The lost request is re-applied on the latest version (rebased automatically).
    expect((await onur.post(`${P()}/param-changes/${r1}/apply`)).status).toBe(200);
    await jobs.drain();
    l = await latest();
    const again = (await onur.get(`${P()}/param-changes/${r1}`)).body;
    expect(again).toMatchObject({ status: "applied", appliedVersionId: l.id, lostVersionId: null, counts: { lost: 0 } });
  });

  it("Revit'te uygulanacak: the next version with the values marks the request applied", async () => {
    let l = await latest();
    const c = (await ayse.post(`${P()}/param-changes`, { versionId: l.id, title: "W3 yangın EI90", spec: spec([W3], { property: "FireRating", value: "EI90" }) })).body;
    expect(c.ownership).toBe("revit");
    await onur.post(`${P()}/param-changes/${c.id}/approve`);
    const a = await onur.post(`${P()}/param-changes/${c.id}/authoring`, { note: "Mimari ekip Revit'te yapacak" });
    expect(a.body).toMatchObject({ status: "authoring", statusLabel: "Revit'te Uygulanacak" });

    // An unrelated version without the value: still waiting, no warning.
    await ayse.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", new Uint8Array([...(await bytesOf(l.id)), 10]));
    await jobs.drain();
    expect((await ayse.get(`${P()}/param-changes/${c.id}`)).body.status).toBe("authoring");

    // The Revit re-export (simulated with web-ifc) arrives with the value.
    l = await latest();
    const m = ifc.OpenModel(await bytesOf(l.id));
    applyParamChanges(ifc, m, [{ key: "x", globalId: W3, pset: "Pset_WallCommon", property: "FireRating", value: "EI90", valueType: "text", target: "instance" }]);
    const revit = ifc.SaveModel(m);
    ifc.CloseModel(m);
    await admin.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", revit);
    await jobs.drain();
    const revitV = await latest();
    const done = (await ayse.get(`${P()}/param-changes/${c.id}`)).body;
    expect(done).toMatchObject({ status: "applied", appliedVersionId: revitV.id, verifiedVersionId: revitV.id, counts: { ok: 1 } });
    const verified = await handle.db.select().from(notifications).where(and(eq(notifications.kind, "param_change.verified"), eq(notifications.userId, ids.ayse)));
    expect(verified).toHaveLength(1);
    // "Doğrula" by hand gives the same answer.
    const v = await ayse.post(`${P()}/param-changes/${c.id}/verify`, { versionId: revitV.id });
    expect(v.body).toMatchObject({ status: "applied", check: { ok: true, present: 1, lost: [] } });
  });

  it.skipIf(!hasAi)("plans a change from a sentence (mocked model) and rejects invented properties and values", async () => {
    const l = await latest();
    const none = await ayse.post(`${P()}/param-changes/ai-plan`, { versionId: l.id, sentence: "EI30 olan duvarları EI60 yap" });
    expect(none.status).toBe(409); // no provider configured
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    const ok = await ayse.post(`${P()}/param-changes/ai-plan`, { versionId: l.id, sentence: "EI30 olan duvarları EI60 yap" });
    expect(ok.status, ok.body?.message).toBe(200);
    expect(ok.body).toMatchObject({ model: "qwen3:8b", query: { classes: ["IfcWall"] }, set: [{ property: "FireRating", value: "EI60" }] });
    expect(ok.body.preview.total).toBeGreaterThanOrEqual(0);
    const invented = await ayse.post(`${P()}/param-changes/ai-plan`, { versionId: l.id, sentence: "duvarlara uydurma bir özellik ekle EI60" });
    expect(invented.status).toBe(422);
    expect(invented.body.details.errors.join(" ")).toContain("uydurma özellik");
    const value = await ayse.post(`${P()}/param-changes/ai-plan`, { versionId: l.id, sentence: "EI30 olan duvarları yükselt" });
    expect(value.status).toBe(422);
    expect(value.body.details.errors.join(" ")).toContain("cümlede yok");
  });

  it.skipIf(!hasAi)("queues the sentence for a connected AI client (task kind param_change)", async () => {
    await admin.put("/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    await admin.put("/admin/settings/ai", { taskQueue: { enabled: true, allowExternalClients: true } });
    const claimer = (await onur.post("/auth/tokens", { name: "Claude Code", scope: "write" })).body.token;
    const l = await latest();
    const t = await ayse.post(`${P()}/ai-tasks`, { kind: "param_change", input: { versionId: l.id, sentence: "EI60 olan duvarları EI90 yap" } });
    expect(t.status, t.body?.message).toBe(200);
    expect(t.body).toMatchObject({ kind: "param_change", label: "Parametre Değişikliği (Cümleden)", summary: "EI60 olan duvarları EI90 yap" });
    const claim = await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId: t.body.id });
    expect(claim.isError, claim.text).toBe(false);
    expect(claim.json.prompt.messages.at(-1).content).toContain("Cümle: EI60 olan duvarları EI90 yap");
    expect(claim.json.prompt.messages.at(-1).content).toContain("Pset_WallCommon.FireRating");
    expect(claim.json.answer.schema.properties.set).toBeDefined();
    const bad = await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId: t.body.id, result: { query: { classes: ["IfcWall"] }, set: { property: "Uydurma", value: "EI90" } } });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors.join(" ")).toContain("uydurma");
    const good = await tool(claimer, "cde_ai_task_complete", {
      projectId: pid,
      taskId: t.body.id,
      result: { query: { classes: ["IfcWall"], filters: [{ field: "FireRating", op: "=", value: "EI60" }] }, set: { property: "FireRating", value: "EI90" } },
    });
    expect(good.json.ok, good.text).toBe(true);
    const done = (await ayse.get(`${P()}/ai-tasks/${t.body.id}`)).body;
    expect(done.status).toBe("done");
    expect(done.result.preview.changes).toBeGreaterThan(0);
    // Module off → the kind is refused.
    await admin.put(`${P()}/modules`, { modules: { coordination: false } });
    const off = await ayse.post(`${P()}/ai-tasks`, { kind: "param_change", input: { versionId: l.id, sentence: "EI60 olan duvarları EI90 yap" } });
    expect(off.status).toBe(403);
    await admin.put(`${P()}/modules`, { modules: { coordination: true } });
  });

  it.skipIf(!hasAi)("offers the change request tools over MCP with the token's scope and the caller's rights", async () => {
    const read = (await veli.post("/auth/tokens", { name: "okuma" })).body.token;
    const aw = (await ayse.post("/auth/tokens", { name: "Ayşe Claude", scope: "write" })).body.token;
    const ow = (await onur.post("/auth/tokens", { name: "Onur Claude", scope: "write" })).body.token;
    const names = (r: any): string[] => r.result.tools.map((x: { name: string }) => x.name);
    const ro = names(await mcp(read, "tools/list"));
    expect(ro).toEqual(expect.arrayContaining(["cde_change_requests_list", "cde_change_request_get"]));
    for (const n of ["cde_change_request_create", "cde_change_request_verify", "cde_change_request_apply"]) expect(ro).not.toContain(n);
    expect(names(await mcp(aw, "tools/list"))).toEqual(expect.arrayContaining(["cde_change_request_create", "cde_change_request_verify", "cde_change_request_apply"]));

    const list = await tool(read, "cde_change_requests_list", { projectId: pid, status: "all" });
    expect(list.isError, list.text).toBe(false);
    expect(list.json.requests.some((x: any) => x.code === "PD-001")).toBe(true);
    const got = await tool(read, "cde_change_request_get", { projectId: pid, requestId: r1 });
    expect(got.json.items[0]).toMatchObject({ property: "Pset_WallCommon.FireRating", new: "EI60" });

    const preview = await tool(aw, "cde_change_request_create", { projectId: pid, model: "mimari", globalIds: [W2], set: { property: "IsExternal", pset: "Pset_WallCommon", value: true, valueType: "boolean" }, preview: true });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json).toMatchObject({ total: 1, added: 1 });
    const created = await tool(aw, "cde_change_request_create", { projectId: pid, model: "mimari", title: "W2 dış duvar", globalIds: [W2], set: { property: "IsExternal", pset: "Pset_WallCommon", value: true, valueType: "boolean" } });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({ status: "draft", itemCount: 1 });
    const rid = created.json.id;
    // Applying needs an approved request and approver rights.
    expect((await tool(aw, "cde_change_request_apply", { projectId: pid, requestId: rid, waitSeconds: 0 })).isError).toBe(true);
    await onur.post(`${P()}/param-changes/${rid}/approve`);
    expect((await tool(aw, "cde_change_request_apply", { projectId: pid, requestId: rid, waitSeconds: 0 })).isError).toBe(true);
    const applied = await tool(ow, "cde_change_request_apply", { projectId: pid, requestId: rid, waitSeconds: 0 });
    expect(applied.isError, applied.text).toBe(false);
    expect(applied.json.status).toBe("applying");
    await jobs.drain();
    const verify = await tool(aw, "cde_change_request_verify", { projectId: pid, requestId: rid });
    expect(verify.isError, verify.text).toBe(false);
    expect(verify.json).toMatchObject({ status: "applied", check: { ok: true, present: 1 } });
    expect((await tool(read, "cde_change_request_verify", { projectId: pid, requestId: rid })).isError).toBe(true);
  });

  async function adminId(): Promise<string> {
    const [u] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    return u!.id;
  }
});
