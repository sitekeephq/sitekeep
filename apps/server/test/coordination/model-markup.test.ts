/**
 * Model markups (FP-3, docs/features/MODEL_MARKUP.md): pins and drawings on IFC model views,
 * private / project visibility, folder permissions including the task-team WIP rule, comments,
 * carrying over to a newer version by GlobalId, issues from markups (BCF export) and audit.
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
import { auditLog, modelMarkupComments, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { readBcfZip } from "../../src/bcf/unzip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../fixtures/sample-wall.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../fixtures/sample-wall-v2.ifc"));
const PDF = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";
const WALL = "3vB2YO$MX4xv5uCqZZG05x";
const SLAB = "1pPHnf7cXCpPsNEnQf8_6B";
// 1×1 PNG.
const SNAPSHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-mmarkup-"));
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: Buffer | string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
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

const viewpoint = (versionIds: string[]) => ({
  camera: { position: [10, 8, 10], target: [0, 1, 0], projection: "perspective", up: [0, 1, 0], fov: 50, aspect: 1.6 },
  sceneOffset: [1, 2, 3],
  fileVersionIds: versionIds,
  snapshot: SNAPSHOT,
});
const pen = { type: "pen", color: "#d92d20", width: 3, points: [[-100, -50], [0, 20], [120, 40]] };

describe("Model markups", () => {
  let admin: Api, murat: Api, semih: Api, osman: Api;
  let pid: string, folderId: string, fileId: string, v1: string, v2: string, pdfVersion: string;
  let pinId: string, drawingId: string;
  const P = () => `/projects/${pid}`;

  it("sets up a project, folder permissions and an IFC model", async () => {
    admin = api(await login("admin@7d.test"));
    const ids: Record<string, string> = {};
    for (const key of ["murat", "semih", "osman"]) {
      const u = await admin.post("/users", { email: `${key}@mm.test`, name: key[0]!.toUpperCase() + key.slice(1), password: PW });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      ids[key] = u.body.id;
    }
    const p = await admin.post("/projects", { code: "MMK", name: "Model İşaretleme" });
    pid = p.body.id;
    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    folderId = (await admin.post(`${P()}/folders`, { parentId: root.body.folders[0].id, name: "Modeller" })).body.id;
    for (const key of ["murat", "semih", "osman"]) expect((await admin.post(`${P()}/members`, { email: `${key}@mm.test` })).status).toBe(200);
    const perms = await admin.put(`${P()}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids.murat, level: "view_download_markup" },
        { subjectType: "user", subjectId: ids.semih, level: "view" },
      ],
    });
    expect(perms.status, JSON.stringify(perms.body)).toBe(200);
    murat = api(await login("murat@mm.test"));
    semih = api(await login("semih@mm.test"));
    osman = api(await login("osman@mm.test"));

    const up = await admin.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", IFC_V1);
    expect(up.status).toBe(200);
    fileId = up.body.results[0].fileId;
    await jobs.drain();
    v1 = (await admin.get(`${P()}/files/${fileId}`)).body.latest.id;
    const pdf = await admin.upload(`${P()}/folders/${folderId}/files`, "Plan.pdf", PDF);
    pdfVersion = (await admin.get(`${P()}/files/${pdf.body.results[0].fileId}`)).body.latest.id;
  });

  it("creates a private pin and a project drawing; viewers and outsiders cannot", async () => {
    const pin = {
      kind: "pin",
      versionId: v1,
      title: "Döşeme kotu kontrol",
      color: "#d92d20",
      viewpoint: viewpoint([v1]),
      anchor: { point: [1.5, 0.2, -2], globalId: SLAB, fileVersionId: v1 },
    };
    expect((await semih.post(`${P()}/model-markups`, pin)).status).toBe(403);
    expect((await osman.post(`${P()}/model-markups`, pin)).status).toBe(404);
    expect((await murat.post(`${P()}/model-markups`, { ...pin, anchor: null })).status).toBe(400);
    expect((await murat.post(`${P()}/model-markups`, { ...pin, versionId: pdfVersion })).status).toBe(400);
    expect((await murat.post(`${P()}/model-markups`, { ...pin, viewpoint: viewpoint([pdfVersion]), versionId: pdfVersion })).status).toBe(400);
    expect((await murat.post(`${P()}/model-markups`, { ...pin, color: "red" })).status).toBe(400);

    const created = await murat.post(`${P()}/model-markups`, pin);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ kind: "pin", visibility: "private", status: "open", version: 1, fileName: "Mimari.ifc", authorName: "Murat" });
    expect(created.body.viewpoint.guid).toBeTruthy();
    pinId = created.body.id;

    expect((await murat.post(`${P()}/model-markups`, { kind: "drawing", versionId: v1, color: "#2e90fa", viewpoint: viewpoint([v1]) })).status).toBe(400);
    const drawing = await murat.post(`${P()}/model-markups`, {
      kind: "drawing",
      versionId: v1,
      title: "Cephe bulutu",
      color: "#2e90fa",
      visibility: "project",
      viewpoint: viewpoint([v1]),
      shapes: [pen, { type: "cloud", color: "#2e90fa", width: 3, from: [-200, -200], to: [-50, -100] }],
    });
    expect(drawing.status, JSON.stringify(drawing.body)).toBe(200);
    drawingId = drawing.body.id;
  });

  it("lists markups by visibility, without snapshots", async () => {
    const mine = await murat.get(`${P()}/model-markups?versions=${v1}`);
    expect(mine.body.current.map((m: { id: string }) => m.id)).toEqual([pinId, drawingId]);
    expect(mine.body.current[0].viewpoint.snapshot).toBeUndefined();
    expect(mine.body.older).toEqual([]);
    const theirs = await semih.get(`${P()}/model-markups?versions=${v1}`);
    expect(theirs.body.current.map((m: { id: string }) => m.id)).toEqual([drawingId]);
    expect((await osman.get(`${P()}/model-markups?versions=${v1}`)).body).toEqual({ current: [], older: [] });
    expect((await semih.get(`${P()}/model-markups/${pinId}`)).status).toBe(404);
    expect((await osman.get(`${P()}/model-markups/${drawingId}`)).status).toBe(404);
    const detail = await semih.get(`${P()}/model-markups/${drawingId}`);
    expect(detail.body.viewpoint.snapshot).toBe(SNAPSHOT);
    expect(detail.body).toMatchObject({ canEdit: false, canComment: false, comments: [] });
  });

  it("keeps a comment thread; commenting needs markup permission", async () => {
    expect((await semih.post(`${P()}/model-markups/${drawingId}/comments`, { body: "Görüldü" })).status).toBe(403);
    const c = await murat.post(`${P()}/model-markups/${drawingId}/comments`, { body: "Cephe paneli hizası kontrol edilecek." });
    expect(c.status).toBe(200);
    expect((await admin.post(`${P()}/model-markups/${drawingId}/comments`, { body: "Tamam." })).status).toBe(200);
    const detail = await semih.get(`${P()}/model-markups/${drawingId}`);
    expect(detail.body.comments.map((x: { body: string; authorName: string }) => [x.authorName, x.body])).toEqual([
      ["Murat", "Cephe paneli hizası kontrol edilecek."],
      ["Admin", "Tamam."],
    ]);
    expect((await semih.get(`${P()}/model-markups?versions=${v1}`)).body.current[0].commentCount).toBe(2);
  });

  it("lets the author edit; the author or a project administrator opens and closes", async () => {
    expect((await semih.patch(`${P()}/model-markups/${drawingId}`, { status: "closed" })).status).toBe(403);
    expect((await admin.patch(`${P()}/model-markups/${drawingId}`, { title: "Değişti" })).status).toBe(403);
    const closed = await admin.patch(`${P()}/model-markups/${drawingId}`, { status: "closed" });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
    const edited = await murat.patch(`${P()}/model-markups/${drawingId}`, { title: "Cephe bulutu (rev)", status: "open", shapes: [pen] });
    expect(edited.body).toMatchObject({ title: "Cephe bulutu (rev)", status: "open", shapes: [pen] });
    expect((await murat.patch(`${P()}/model-markups/${pinId}`, { shapes: [pen] })).status).toBe(400);
  });

  it("shows markups of older versions and carries them over by GlobalId", async () => {
    const up = await admin.upload(`${P()}/folders/${folderId}/files`, "Mimari.ifc", IFC_V2);
    expect(up.body.results[0].version).toBe(2);
    await jobs.drain();
    v2 = (await admin.get(`${P()}/files/${fileId}`)).body.latest.id;

    const list = await murat.get(`${P()}/model-markups?versions=${v2}`);
    expect(list.body.current).toEqual([]);
    expect(list.body.older.map((m: { id: string; version: number }) => [m.id, m.version])).toEqual([
      [pinId, 1],
      [drawingId, 1],
    ]);
    // The older version itself shows no "older" markups.
    expect((await murat.get(`${P()}/model-markups?versions=${v1}`)).body.older).toEqual([]);

    expect((await semih.post(`${P()}/model-markups/${drawingId}/carry-over`, { versionId: v2 })).status).toBe(403);
    expect((await murat.post(`${P()}/model-markups/${drawingId}/carry-over`, { versionId: v1 })).status).toBe(400);
    expect((await murat.post(`${P()}/model-markups/${drawingId}/carry-over`, { versionId: pdfVersion })).status).toBe(400);

    // The slab is not in version 2: the pin keeps its point and is marked missing.
    const pin = await murat.post(`${P()}/model-markups/${pinId}/carry-over`, { versionId: v2 });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    expect(pin.body.existing).toBe(false);
    expect(pin.body.markup).toMatchObject({ versionId: v2, version: 2, versionIds: [v2], carriedFromId: pinId, visibility: "private" });
    expect(pin.body.markup.anchor).toEqual({ point: [1.5, 0.2, -2], globalId: SLAB, fileVersionId: v2, missing: true });
    expect(pin.body.markup.viewpoint.fileVersionIds).toEqual([v2]);

    const drawing = await murat.post(`${P()}/model-markups/${drawingId}/carry-over`, { versionId: v2 });
    expect(drawing.body.markup).toMatchObject({ kind: "drawing", shapes: [pen], carriedFromId: drawingId });
    const again = await murat.post(`${P()}/model-markups/${drawingId}/carry-over`, { versionId: v2 });
    expect(again.body).toMatchObject({ existing: true, markup: { id: drawing.body.markup.id } });

    const after = await murat.get(`${P()}/model-markups?versions=${v2}`);
    expect(after.body.current).toHaveLength(2);
    expect(after.body.older).toEqual([]);
    // Semih does not see Murat's private pin, so its copy and the original stay hidden from him.
    const semihList = await semih.get(`${P()}/model-markups?versions=${v2}`);
    expect(semihList.body.current.map((m: { carriedFromId: string }) => m.carriedFromId)).toEqual([drawingId]);
  });

  it("carries a pin on an element that still exists without the missing flag", async () => {
    const wall = await murat.post(`${P()}/model-markups`, {
      kind: "pin",
      versionId: v1,
      color: "#12b76a",
      viewpoint: viewpoint([v1]),
      anchor: { point: [0, 1, 0], globalId: WALL, fileVersionId: v1 },
    });
    const carried = await murat.post(`${P()}/model-markups/${wall.body.id}/carry-over`, { versionId: v2 });
    expect(carried.body.markup.anchor).toEqual({ point: [0, 1, 0], globalId: WALL, fileVersionId: v2 });
  });

  it("turns a markup into an issue with its viewpoint, which the BCF export carries", async () => {
    const res = await murat.post(`${P()}/model-markups/${pinId}/issue`, { title: "Döşeme kotu", priority: "high" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.markup).toMatchObject({ issueId: res.body.issue.id, issueNumber: res.body.issue.number, visibility: "project" });
    const issue = await semih.get(`${P()}/issues/${res.body.issue.id}`);
    expect(issue.body).toMatchObject({ title: "Döşeme kotu", priority: "high" });
    expect(issue.body.viewpoint).toMatchObject({ fileVersionIds: [v1], sceneOffset: [1, 2, 3], snapshot: SNAPSHOT });
    expect(issue.body.pin).toEqual({ position: [1.5, 0.2, -2], fileVersionId: v1, globalId: SLAB });
    // Published by the issue: Semih sees the pin now.
    expect((await semih.get(`${P()}/model-markups/${pinId}`)).status).toBe(200);
    const twice = await murat.post(`${P()}/model-markups/${pinId}/issue`, { title: "Yine" });
    expect(twice.status).toBe(409);

    const exp = await semih.post(`${P()}/bcf/export`, { version: "2.1", ids: [res.body.issue.id] });
    expect(exp.status, JSON.stringify(exp.body)).toBe(200);
    const zip = await readBcfZip(Buffer.from(exp.body.base64, "base64"));
    const names = [...zip.files.keys()];
    const topic = res.body.issue.id.toLowerCase();
    expect(names).toEqual(expect.arrayContaining([`${topic}/markup.bcf`, `${topic}/viewpoint.bcfv`, `${topic}/snapshot.png`]));
    expect(zip.files.get(`${topic}/viewpoint.bcfv`)!.toString()).toContain("<Lines>");
  });

  it("deletes with the author or a project administrator; comments go with it", async () => {
    expect((await semih.del(`${P()}/model-markups/${drawingId}`)).status).toBe(403);
    expect((await murat.del(`${P()}/model-markups/${drawingId}`)).status).toBe(200);
    expect((await murat.get(`${P()}/model-markups/${drawingId}`)).status).toBe(404);
    expect(await handle.db.select().from(modelMarkupComments).where(eq(modelMarkupComments.markupId, drawingId))).toEqual([]);
  });

  it("writes audit events against the model file", async () => {
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.targetId, fileId)));
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      "model_markup.created",
      "model_markup.commented",
      "model_markup.closed",
      "model_markup.reopened",
      "model_markup.carried_over",
      "model_markup.issue_created",
      "model_markup.deleted",
    ])
      expect(actions, a).toContain(a);
  });
});

describe("ISO19650-2 5.1.7(e) model markups follow the task-team WIP rule", () => {
  it("hides a project markup on team A's WIP model from team B", async () => {
    const admin = api(await login("admin@7d.test"));
    const A = (await admin.post("/companies", { name: "Alfa Mimarlık", code: "ALM" })).body.id;
    const B = (await admin.post("/companies", { name: "Beta İnşaat", code: "BTI" })).body.id;
    const r = await admin.post("/projects/from-template", {
      code: "MMW",
      name: "Markup WIP",
      templateId: "iso19650-temel",
      slotCompanies: { tasarimci: A, yuklenici: B },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pid = r.body.id;
    for (const [key, company] of [
      ["wa", A],
      ["wb", B],
    ]) {
      expect((await admin.post("/users", { email: `${key}@mm.test`, name: key, password: PW, companyId: company })).status).toBe(200);
      expect((await admin.post(`/projects/${pid}/members`, { email: `${key}@mm.test` })).status).toBe(200);
    }
    const ua = api(await login("wa@mm.test"));
    const ub = api(await login("wb@mm.test"));
    const root = await admin.get(`/projects/${pid}/folders/${r.body.rootFolderId}/contents`);
    const wipId = root.body.folders.find((f: { state: string }) => f.state === "wip").id;
    const wip = await admin.get(`/projects/${pid}/folders/${wipId}/contents`);
    const wipA = wip.body.folders.find((f: { name: string }) => f.name === "Tasarımcı").id;

    const up = await ua.upload(`/projects/${pid}/folders/${wipA}/files`, "ALFA-model.ifc", IFC_V1);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    await jobs.drain();
    const vid = (await ua.get(`/projects/${pid}/files/${up.body.results[0].fileId}`)).body.latest.id;
    const m = await ua.post(`/projects/${pid}/model-markups`, {
      kind: "drawing",
      versionId: vid,
      color: "#d92d20",
      visibility: "project",
      viewpoint: viewpoint([vid]),
      shapes: [pen],
    });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await ua.get(`/projects/${pid}/model-markups?versions=${vid}`)).body.current).toHaveLength(1);
    expect((await ub.get(`/projects/${pid}/model-markups?versions=${vid}`)).body).toEqual({ current: [], older: [] });
    expect((await ub.get(`/projects/${pid}/model-markups/${m.body.id}`)).status).toBe(404);
    expect((await ub.post(`/projects/${pid}/model-markups/${m.body.id}/comments`, { body: "?" })).status).toBe(404);
    expect((await ub.post(`/projects/${pid}/model-markups/${m.body.id}/issue`, { title: "?" })).status).toBe(404);
  });
});
