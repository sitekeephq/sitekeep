/** 2B metraj over HTTP: calibration, lengths / areas / counts, deductions, CAD units, permissions and the Excel export. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../../../../src/app/build-app.js";
import { hashPassword } from "../../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../../src/db/index.js";
import { auditLog, users } from "../../../../src/db/schema.js";
import { JobQueue } from "../../../../src/jobs/queue.js";
import { LocalStorage } from "../../../../src/core/platform/storage.js";
import { readXlsx, unzipEntries } from "../../../../src/core/formats/xlsx.js";

const PW = "Sifre-1234567";
const DXF = Buffer.from("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nEOF\n");

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-takeoff-api-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 6) });
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
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
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

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([842, 595]);
  doc.addPage([842, 595]);
  return Buffer.from(await doc.save());
}

describe("2B metraj API", () => {
  let admin: Api;
  let viewer: Api;
  let marker: Api;
  let other: Api;
  let pid: string;
  let pdfVid: string;
  let dxfVid: string;
  let ifcVid: string;
  let wallItem: string;
  const T = () => `/projects/${pid}/versions/${pdfVid}/takeoff`;

  beforeAll(async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "TKO", name: "Takeoff Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    const folderId = (await admin.post(`/projects/${pid}/folders`, { parentId: contents.body.folders[0].id, name: "Çizimler" })).body.id;
    const ids: Record<string, string> = {};
    for (const [email, name] of [["izleyici@7d.test", "İzleyici"], ["olcen@7d.test", "Ölçen"], ["diger@7d.test", "Diğer"]]) {
      ids[email!] = (await admin.post("/users", { email, name, password: PW })).body.id;
      expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    }
    await admin.put(`/projects/${pid}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids["izleyici@7d.test"], level: "view" },
        { subjectType: "user", subjectId: ids["olcen@7d.test"], level: "view_download_markup" },
        { subjectType: "user", subjectId: ids["diger@7d.test"], level: "view_download_markup" },
      ],
    });
    viewer = api(await login("izleyici@7d.test"));
    marker = api(await login("olcen@7d.test"));
    other = api(await login("diger@7d.test"));
    const version = async (name: string, data: Buffer) => {
      const up = await admin.upload(`/projects/${pid}/folders/${folderId}/files`, name, data);
      expect(up.status, JSON.stringify(up.body)).toBe(200);
      const f = await admin.get(`/projects/${pid}/files/${up.body.results[0].fileId}`);
      return f.body.versions[0].id as string;
    };
    pdfVid = await version("A-101 Kat Planı.pdf", await pdf());
    dxfVid = await version("A-102 Kesit.dxf", DXF);
    ifcVid = await version("Model.ifc", Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n"));
    await jobs.drain();
    expect((await admin.post(`/projects/${pid}/cost-items`, { code: "SIVA", description: "İç sıva", unit: "m²", unitPrice: 200 })).status).toBe(200);
  });

  it("starts empty and refuses non-drawings", async () => {
    const s = await viewer.get(T());
    expect(s.status, s.body?.message).toBe(200);
    expect(s.body).toMatchObject({ fileName: "A-101 Kat Planı.pdf", extension: "pdf", canEdit: false, scales: [], items: [], groups: [] });
    expect((await marker.get(T())).body.canEdit).toBe(true);
    const ifc = await admin.get(`/projects/${pid}/versions/${ifcVid}/takeoff`);
    expect(ifc.status).toBe(400);
    expect(ifc.body.message).toMatch(/PDF, DWG ve DXF/);
  });

  it("counts without a scale and leaves lengths unscaled until the page is calibrated", async () => {
    const count = await marker.post(`${T()}/items`, { page: 1, kind: "count", points: [[10, 10], [20, 20], [30, 30]], group: "Prizler" });
    expect(count.status, count.body?.message).toBe(200);
    expect(count.body.item).toMatchObject({ quantity: 3, unit: "adet", authorName: "Ölçen" });
    const len = await marker.post(`${T()}/items`, { page: 1, kind: "length", points: [[0, 0], [100, 0], [100, 50]], group: "Süpürgelik" });
    expect(len.body.item.quantity).toBeNull();
    expect(len.body.state.groups.find((g: { group: string }) => g.group === "Süpürgelik")).toMatchObject({ unscaled: 1, quantity: 0 });
  });

  it("calibrates a page from a line and its real length", async () => {
    expect((await viewer.put(`${T()}/scales/1`, { points: [[0, 0], [100, 0]], realLength: 5 })).status).toBe(403);
    expect((await marker.put(`${T()}/scales/1`, { points: [[3, 3], [3, 3]], realLength: 5 })).status).toBe(400);
    const s = await marker.put(`${T()}/scales/1`, { points: [[0, 0], [100, 0]], realLength: 5 });
    expect(s.status, s.body?.message).toBe(200);
    expect(s.body.scales).toEqual([expect.objectContaining({ page: 1, metresPerUnit: 0.05, method: "calibration", realLength: 5 })]);
    // 150 units × 0.05 m.
    expect(s.body.items.find((i: { kind: string }) => i.kind === "length").quantity).toBe(7.5);
    const [log] = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "takeoff.scale_set")));
    expect(log!.details).toMatchObject({ page: 1, method: "calibration" });
  });

  it("measures areas, subtracts deductions and prices linked items", async () => {
    const siva = (await admin.get(`/projects/${pid}/cost-items`)).body.find((c: { code: string }) => c.code === "SIVA").id;
    const wall = await marker.post(`${T()}/items`, { page: 1, kind: "area", points: [[0, 0], [200, 0], [200, 100], [0, 100]], group: "Duvar Sıvası", label: "Salon", costItemId: siva });
    expect(wall.status, wall.body?.message).toBe(200);
    // 20000 units² × 0.0025 = 50 m².
    expect(wall.body.item).toMatchObject({ quantity: 50, unit: "m²", costItemCode: "SIVA", amount: 10000 });
    wallItem = wall.body.item.id;
    const hole = await marker.post(`${T()}/items`, { page: 1, kind: "area", points: [[0, 0], [40, 0], [40, 40], [0, 40]], group: "Duvar Sıvası", label: "Pencere", deduct: true, costItemId: siva });
    expect(hole.body.item).toMatchObject({ quantity: -4, deduct: true, amount: -800 });
    expect(hole.body.state.groups.find((g: { group: string }) => g.group === "Duvar Sıvası")).toMatchObject({ kind: "area", items: 2, quantity: 46, amount: 9200 });
    // A unit price in another unit is not multiplied.
    const len = hole.body.state.items.find((i: { kind: string }) => i.kind === "length");
    const p = await marker.patch(`/projects/${pid}/takeoff/items/${len.id}`, { costItemId: siva, label: "Salon süpürgelik" });
    expect(p.body.items.find((i: { id: string }) => i.id === len.id)).toMatchObject({ costItemCode: "SIVA", amount: null, label: "Salon süpürgelik" });
    // Page 2 has no scale of its own.
    const p2 = await marker.post(`${T()}/items`, { page: 2, kind: "area", points: [[0, 0], [10, 0], [10, 10]] });
    expect(p2.body.item.quantity).toBeNull();
  });

  it("validates points", async () => {
    expect((await marker.post(`${T()}/items`, { page: 1, kind: "area", points: [[0, 0], [1, 1]] })).status).toBe(400);
    expect((await marker.post(`${T()}/items`, { page: 1, kind: "length", points: [[0, 0]] })).status).toBe(400);
    expect((await marker.post(`${T()}/items`, { page: 0, kind: "count", points: [[0, 0]] })).status).toBe(400);
    expect((await viewer.post(`${T()}/items`, { page: 1, kind: "count", points: [[0, 0]] })).status).toBe(403);
  });

  it("lets only the author or a project admin change a measurement", async () => {
    expect((await other.patch(`/projects/${pid}/takeoff/items/${wallItem}`, { group: "Başka" })).status).toBe(403);
    expect((await other.del(`/projects/${pid}/takeoff/items/${wallItem}`)).status).toBe(403);
    expect((await viewer.del(`/projects/${pid}/takeoff/items/${wallItem}`)).status).toBe(403);
    const mine = await other.post(`${T()}/items`, { page: 1, kind: "count", points: [[1, 1]], group: "Prizler" });
    const d = await admin.del(`/projects/${pid}/takeoff/items/${mine.body.item.id}`);
    expect(d.status).toBe(200);
    expect(d.body.groups.find((g: { group: string }) => g.group === "Prizler").quantity).toBe(3);
    const [log] = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "takeoff.item_removed")));
    expect(log!.details).toMatchObject({ kind: "count", group: "Prizler" });
  });

  it("uses the CAD file's units as the scale unless a calibration exists", async () => {
    const C = `/projects/${pid}/versions/${dxfVid}/takeoff`;
    const a = await marker.post(`${C}/items`, { page: 1, kind: "length", points: [[0, 0], [3000, 0], [3000, 4000]], drawingUnits: 0.001, group: "Kesit" });
    expect(a.status, a.body?.message).toBe(200);
    expect(a.body.item.quantity).toBe(7);
    expect(a.body.state.scales[0]).toMatchObject({ method: "drawing_units", metresPerUnit: 0.001 });
    // A PDF calibration is not overwritten by drawing units.
    const b = await marker.post(`${T()}/items`, { page: 1, kind: "length", points: [[0, 0], [10, 0]], drawingUnits: 1 });
    expect(b.body.item.quantity).toBe(0.5);
    expect(b.body.state.scales.find((s: { page: number }) => s.page === 1).method).toBe("calibration");
    const cleared = await marker.del(`${C}/scales/1`);
    expect(cleared.body.items[0].quantity).toBeNull();
  });

  it("lists the project's drawings with their totals", async () => {
    const list = await viewer.get(`/projects/${pid}/takeoff`);
    expect(list.status, list.body?.message).toBe(200);
    expect(list.body.map((d: { fileName: string }) => d.fileName)).toEqual(["A-101 Kat Planı.pdf", "A-102 Kesit.dxf"]);
    expect(list.body[0]).toMatchObject({ folderPath: expect.stringContaining("Çizimler"), extension: "pdf", items: 6 });
    expect(list.body[0].groups.map((g: { group: string; kind: string }) => `${g.group}/${g.kind}`)).toEqual(["/length", "/area", "Duvar Sıvası/area", "Prizler/count", "Süpürgelik/length"]);
  });

  it("exports groups and measurements to Excel", async () => {
    const r = await viewer.get(`${T()}/export`);
    expect(r.status).toBe(200);
    expect(r.raw.headers["content-disposition"]).toMatch(/A-101-Kat-Plan-V1-2b-metraj\.xlsx/);
    const buf = r.raw.rawPayload;
    const entries = unzipEntries(buf);
    expect(entries.get("xl/workbook.xml")!.toString("utf8")).toMatch(/2B Metraj Özeti[\s\S]*Ölçümler/);
    const summary = readXlsx(buf);
    expect(summary[0]).toEqual(["Grup", "Tür", "Birim", "Ölçüm", "Miktar", "Ölçeksiz", "Tutar"]);
    expect(summary).toContainEqual(["Duvar Sıvası", "Alan", "m²", "2", "46", "", "9200"]);
    const sheet2 = entries.get("xl/worksheets/sheet2.xml")!.toString("utf8") + entries.get("xl/sharedStrings.xml")?.toString("utf8");
    expect(sheet2).toContain("Alan (düşülen)");
    expect(sheet2).toContain("Pencere");
  });
});
