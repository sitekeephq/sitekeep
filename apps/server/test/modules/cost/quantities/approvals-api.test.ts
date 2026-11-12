/** Metraj onayı over HTTP: approving a model inventory and a 2D take-off, binding groups to contract items, filling a payment, revoking. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { modelGroupKey } from "@7dimensions-project/sitekeep-ee-cost/shared/approvals.js";
import { buildApp } from "../../../../src/app/build-app.js";
import { hashPassword } from "../../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../../src/db/index.js";
import {
  auditLog,
  users,
} from "../../../../src/db/schema.js";
import { pozMappings } from "@7dimensions-project/sitekeep-ee-cost/internal/schema/index.js";
import { JobQueue } from "../../../../src/jobs/queue.js";
import { LocalStorage } from "../../../../src/core/platform/storage.js";
import { compactFold } from "../../../../src/model/model-index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC = readFileSync(path.join(here, "../../../fixtures/openings.ifc"));
const PW = "Sifre-1234567";
const WALLS = modelGroupKey("IfcWall", null, null);
const SLABS = modelGroupKey("IfcSlab", null, null);
const DOORS = modelGroupKey("IfcDoor", null, null);

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-qa-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 7) });
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
    put: (u: string, p: unknown) => call("PUT", u, p),
    upload: async (url: string, name: string, data: Buffer) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie, "content-type": req.headers.get("content-type")! }, payload: body });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

describe("metraj onayı API", () => {
  let admin: Api;
  let viewer: Api;
  let outsider: Api;
  let pid: string;
  let ifcVid: string;
  let pdfVid: string;
  let cid: string;
  const items: Record<string, string> = {};
  let approvalId: string;
  let p1: string;
  let p2: string;
  const P = () => `/projects/${pid}`;
  const C = () => `${P()}/contracts/${cid}`;

  beforeAll(async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "QAP", name: "Onay Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    const folderId = (await admin.post(`${P()}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    const ids: Record<string, string> = {};
    for (const key of ["izleyici", "disari"]) {
      ids[key] = (await admin.post("/users", { email: `${key}@7d.test`, name: key, password: PW })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    }
    await admin.put(`${P()}/folders/${folderId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.izleyici, level: "view" }] });
    viewer = api(await login("izleyici@7d.test"));
    outsider = api(await login("disari@7d.test"));
    const version = async (name: string, data: Buffer) => {
      const up = await admin.upload(`${P()}/folders/${folderId}/files`, name, data);
      expect(up.status, JSON.stringify(up.body)).toBe(200);
      return (await admin.get(`${P()}/files/${up.body.results[0].fileId}`)).body.versions[0].id as string;
    };
    ifcVid = await version("Bosluklu.ifc", IFC);
    const doc = await PDFDocument.create();
    doc.addPage([842, 595]);
    pdfVid = await version("A-101 Plan.pdf", Buffer.from(await doc.save()));
    await jobs.drain();

    expect((await admin.post(`${P()}/cost-items`, { code: "SIVA", description: "İç sıva", unit: "m²", unitPrice: 200 })).status).toBe(200);
    const siva = (await admin.get(`${P()}/cost-items`)).body.find((c: { code: string }) => c.code === "SIVA").id;
    const c = await admin.post(`${P()}/contracts`, { code: "SZ-01", title: "Kaba İnşaat", employerName: "İşveren", contractorName: "Yüklenici" });
    expect(c.status, c.body?.message).toBe(201);
    cid = c.body.id;
    for (const it of [
      { code: "SIVA-01", pozCode: "04.613", description: "Duvar sıvası", unit: "m²", unitPrice: 100, contractQuantity: 100 },
      { code: "BETON-01", pozCode: "15.150.1005", description: "C30 beton", unit: "m³", unitPrice: 2500, contractQuantity: 50 },
      { code: "KAPI-01", description: "Ahşap kapı", unit: "adet", unitPrice: 5000, contractQuantity: 10 },
      { code: "SIVA-2B", description: "Çizimden sıva", unit: "m²", unitPrice: 90, contractQuantity: 500, costItemId: siva },
    ]) {
      const r = await admin.post(`${C()}/items`, it);
      expect(r.status, r.body?.message).toBe(201);
      items[it.code] = r.body.items.find((x: { code: string }) => x.code === it.code).id;
    }
    // A pair learned in Poz Öner: slabs → 15.150.1005.
    await handle.db.insert(pozMappings).values({ ifcClass: "IfcSlab", pozCode: "15.150.1005", pozKey: compactFold("15.150.1005"), description: "C30 beton", unit: "m³", quantity: "NetVolume" });
  });

  it("lets only an administrator approve a model inventory and freezes it with openings deducted", async () => {
    expect((await viewer.post(`${P()}/quantity-approvals`, { versionId: ifcVid })).status).toBe(403);
    const r = await admin.post(`${P()}/quantity-approvals`, { versionId: ifcVid, note: "Kaba yapı metrajı" });
    expect(r.status, r.body?.message).toBe(201);
    expect(r.body).toMatchObject({ number: 1, source: "model", fileName: "Bosluklu.ifc", version: 1, status: "approved", note: "Kaba yapı metrajı", approvedByName: "Admin", usedBy: [] });
    expect(r.body.openings).toMatchObject({ source: "geometry", hosts: 3 });
    const walls = r.body.groups.find((g: { key: string }) => g.key === WALLS);
    expect(walls).toMatchObject({ label: "Duvar · Tipsiz · Malzemesiz", count: 3, values: { netArea: 27.31, length: 7 } });
    expect(r.body.groups.find((g: { key: string }) => g.key === SLABS).values).toMatchObject({ netArea: 23.5, netVolume: 4.8 });
    approvalId = r.body.id;
    const [log] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "quantity.approved"), eq(auditLog.targetId, approvalId)));
    expect(log!.details).toMatchObject({ number: 1, source: "model" });
  });

  it("shows approvals to those who can see the file", async () => {
    expect((await viewer.get(`${P()}/quantity-approvals`)).body.map((a: { number: number }) => a.number)).toEqual([1]);
    expect((await viewer.get(`${P()}/quantity-approvals/${approvalId}`)).status).toBe(200);
    expect((await outsider.get(`${P()}/quantity-approvals`)).body).toEqual([]);
    expect((await outsider.get(`${P()}/quantity-approvals/${approvalId}`)).status).toBe(404);
    expect((await admin.get(`${P()}/quantity-approvals?versionId=${pdfVid}`)).body).toEqual([]);
  });

  it("refuses to fill a payment before groups are bound", async () => {
    const pay = await admin.post(`${C()}/payments`, { periodEnd: "2026-11-30" });
    expect(pay.status, pay.body?.message).toBe(201);
    p1 = pay.body.id;
    const r = await admin.post(`${C()}/payments/${p1}/fill-from-quantities`, { approvalId });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("Metraj Bağları");
  });

  it("suggests bindings from learned poz pairs and validates measures against item units", async () => {
    const s = await viewer.get(`${C()}/quantity-bindings/suggest?approvalId=${approvalId}`);
    expect(s.status, s.body?.message).toBe(200);
    expect(s.body).toEqual([{ groupKey: SLABS, contractItemId: items["BETON-01"], measure: "netVolume", reason: "memory" }]);

    const bind = (list: unknown[]) => admin.put(`${C()}/quantity-bindings`, { bindings: list });
    const b = (groupKey: string, label: string, code: string, measure: string) => ({ groupKey, label, source: "model", contractItemId: items[code], measure });
    expect((await viewer.put(`${C()}/quantity-bindings`, { bindings: [] })).status).toBe(403);
    const wrong = await bind([b(WALLS, "Duvar", "SIVA-01", "netVolume")]);
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain("m²");
    expect((await bind([b(WALLS, "Duvar", "SIVA-01", "netArea"), b(WALLS, "Duvar", "KAPI-01", "count")])).status).toBe(400);
    const ok = await bind([b(WALLS, "Duvar", "SIVA-01", "netArea"), b(SLABS, "Döşeme", "BETON-01", "netVolume"), b(DOORS, "Kapı", "KAPI-01", "count")]);
    expect(ok.status, ok.body?.message).toBe(200);
    expect(ok.body).toHaveLength(3);
    expect((await viewer.get(`${C()}/quantity-bindings`)).body).toHaveLength(3);
    expect((await viewer.get(`${C()}/quantity-bindings/suggest?approvalId=${approvalId}`)).body).toEqual([]);
  });

  it("fills a draft payment with the approved quantities and records the approval", async () => {
    const r = await admin.post(`${C()}/payments/${p1}/fill-from-quantities`, { approvalId });
    expect(r.status, r.body?.message).toBe(200);
    const line = (code: string) => r.body.lines.find((l: { code: string }) => l.code === code);
    expect(line("SIVA-01")).toMatchObject({ periodQuantity: 27.31, modelElementCount: 3, sourceNote: "Metraj Onayı #1 · Bosluklu.ifc V1 · 3 eleman" });
    expect(line("BETON-01")).toMatchObject({ periodQuantity: 4.8 });
    expect(line("KAPI-01")).toMatchObject({ periodQuantity: 1 });
    expect(line("SIVA-2B").periodQuantity).toBe(0);
    expect(r.body.quantityApproval).toEqual({ id: approvalId, number: 1, fileName: "Bosluklu.ifc", version: 1, status: "approved" });
  });

  it("transfers only the increase into the next payment", async () => {
    expect((await admin.post(`${C()}/payments/${p1}/submit`)).status).toBe(200);
    expect((await admin.post(`${C()}/payments/${p1}/approve`)).status).toBe(200);
    expect((await admin.post(`${C()}/payments/${p1}/fill-from-quantities`, { approvalId })).status).toBe(400);
    p2 = (await admin.post(`${C()}/payments`, { periodEnd: "2026-12-31" })).body.id;
    const r = await admin.post(`${C()}/payments/${p2}/fill-from-quantities`, { approvalId });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body.lines.find((l: { code: string }) => l.code === "SIVA-01")).toMatchObject({ previousQuantity: 27.31, periodQuantity: 0 });
  });

  it("revokes an approval with a reason; it can no longer fill payments but keeps its history", async () => {
    expect((await viewer.post(`${P()}/quantity-approvals/${approvalId}/revoke`, { reason: "Hatalı" })).status).toBe(403);
    expect((await admin.post(`${P()}/quantity-approvals/${approvalId}/revoke`, {})).status).toBe(400);
    const r = await admin.post(`${P()}/quantity-approvals/${approvalId}/revoke`, { reason: "Model güncellendi" });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ status: "revoked", revokeReason: "Model güncellendi", revokedByName: "Admin" });
    expect(r.body.usedBy.map((u: { number: number }) => u.number).sort()).toEqual([1, 2]);
    const fill = await admin.post(`${C()}/payments/${p2}/fill-from-quantities`, { approvalId });
    expect(fill.status).toBe(400);
    expect(fill.body.message).toContain("geri alınmış");
    expect((await admin.post(`${P()}/quantity-approvals/${approvalId}/revoke`, { reason: "Tekrar" })).status).toBe(400);
    expect((await admin.get(`${C()}/payments/${p1}`)).body.quantityApproval.status).toBe("revoked");
  });

  it("approves a calibrated 2D take-off and suggests the item with the same unit price", async () => {
    const T = `${P()}/versions/${pdfVid}/takeoff`;
    const siva = (await admin.get(`${P()}/cost-items`)).body.find((c: { code: string }) => c.code === "SIVA").id;
    const area = await admin.post(`${T}/items`, { page: 1, kind: "area", points: [[0, 0], [200, 0], [200, 200], [0, 200]], group: "Sıva", costItemId: siva });
    expect(area.status, area.body?.message).toBe(200);
    const unscaled = await admin.post(`${P()}/quantity-approvals`, { versionId: pdfVid });
    expect(unscaled.status).toBe(400);
    expect(unscaled.body.message).toContain("kalibre");
    expect((await admin.put(`${T}/scales/1`, { points: [[0, 0], [100, 0]], realLength: 5 })).status).toBe(200);
    const r = await admin.post(`${P()}/quantity-approvals`, { versionId: pdfVid });
    expect(r.status, r.body?.message).toBe(201);
    expect(r.body).toMatchObject({ number: 2, source: "drawing", fileName: "A-101 Plan.pdf" });
    expect(r.body.groups).toEqual([
      expect.objectContaining({ label: "Sıva · Alan", group: "Sıva", kind: "area", count: 1, costItemIds: [siva], values: expect.objectContaining({ netArea: 100 }) }),
    ]);
    const s = await admin.get(`${C()}/quantity-bindings/suggest?approvalId=${r.body.id}`);
    expect(s.body).toEqual([{ groupKey: r.body.groups[0].key, contractItemId: items["SIVA-2B"], measure: "netArea", reason: "costItem" }]);
  });
});
