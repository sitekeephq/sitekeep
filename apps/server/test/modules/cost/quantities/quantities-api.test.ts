/** Metraj envanteri over HTTP: inventory, group elements, version difference, Excel and the MCP tool. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cdeParseArgs, cdeToolDefinitions } from "@sitekeep/cde-tools";
import { buildApp } from "../../../../src/app/build-app.js";
import { hashPassword } from "../../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../../src/db/index.js";
import { eq } from "drizzle-orm";
import { users, versionIndexes } from "../../../../src/db/schema.js";
import { loadIndexFile, saveVersionIndex } from "../../../../src/jobs/version-index.js";
import { JobQueue } from "../../../../src/jobs/queue.js";
import { LocalStorage } from "../../../../src/core/platform/storage.js";
import { readXlsx, unzipEntries } from "../../../../src/core/formats/xlsx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../../../fixtures/quantities.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../../../fixtures/quantities-v2.ifc"));
const IFC_OPENINGS = readFileSync(path.join(here, "../../../fixtures/openings.ifc"));
const W1 = "0QtWall000000000000001";
const W2 = "0QtWall000000000000002";
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
let storage: LocalStorage;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-qty-api-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
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
    return { status: res.statusCode, body, raw: res };
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

describe("metraj envanteri API", () => {
  let admin: ReturnType<typeof api>;
  let viewer: ReturnType<typeof api>;
  let outsider: ReturnType<typeof api>;
  let pid: string;
  let v1: string;
  let v2: string;
  const P = () => `/projects/${pid}`;

  let folder: string;

  it("sets up a model with two versions", async () => {
    admin = api(await login("admin@7d.test"));
    const ids: Record<string, string> = {};
    for (const key of ["izleyici", "disari"]) ids[key] = (await admin.post("/users", { email: `${key}@7d.test`, name: key, password: PW })).body.id;
    const p = await admin.post("/projects", { code: "QTY", name: "Metraj Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    const folderId = (await admin.post(`${P()}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    folder = folderId;
    for (const key of ["izleyici", "disari"]) expect((await admin.post(`${P()}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    await admin.put(`${P()}/folders/${folderId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.izleyici, level: "view" }] });
    viewer = api(await login("izleyici@7d.test"));
    outsider = api(await login("disari@7d.test"));
    await admin.upload(`${P()}/folders/${folderId}/files`, "Kaba.ifc", IFC_V1);
    await jobs.drain();
    const up = await admin.upload(`${P()}/folders/${folderId}/files`, "Kaba.ifc", IFC_V2);
    await jobs.drain();
    const file = await admin.get(`${P()}/files/${up.body.results[0].fileId}`);
    [v2, v1] = file.body.versions.map((v: { id: string }) => v.id);
  });

  it("returns the inventory to anyone who can see the model", async () => {
    const r = await viewer.get(`${P()}/versions/${v1}/quantities?groupBy=class,storey`);
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body).toMatchObject({ versionId: v1, fileName: "Kaba.ifc", version: 1, groupBy: ["class", "storey"] });
    expect(r.body.totals).toMatchObject({ count: 8, withQuantities: 7, netVolume: 14.56, grossArea: 52, openingArea: 4, netArea: 70.39 });
    expect(r.body.groups.map((g: { label: string }) => g.label).slice(0, 2)).toEqual(["Döşeme · Zemin Kat", "Döşeme · Kat 1"]);
    expect(r.body.groups.find((g: { label: string }) => g.label === "Duvar · Zemin Kat")).toMatchObject({ netArea: 12, openingArea: 3, guids: [W1] });
    expect((await outsider.get(`${P()}/versions/${v1}/quantities`)).status).toBe(404);
  });

  it("speaks the reader's language and lists a group's elements", async () => {
    const en = await app.inject({ method: "GET", url: `/api/v1${P()}/versions/${v1}/quantities?groupBy=class`, headers: { cookie: (await login("admin@7d.test")), "accept-language": "en" } });
    expect(en.json().groups.map((g: { label: string }) => g.label)).toContain("Wall");

    const inv = await viewer.get(`${P()}/versions/${v1}/quantities?groupBy=storey`);
    const kat1 = inv.body.groups.find((g: { label: string }) => g.label === "Kat 1");
    const els = await viewer.get(`${P()}/versions/${v1}/quantities/elements?groupBy=storey&group=${encodeURIComponent(kat1.key)}`);
    expect(els.status).toBe(200);
    expect(els.body).toMatchObject({ total: 4, truncated: false });
    expect(els.body.elements.find((e: { guid: string }) => e.guid === W2)).toMatchObject({ values: { netArea: 12 }, sources: { netArea: "Qto_WallBaseQuantities.NetSideArea" } });
    const two = await viewer.get(`${P()}/versions/${v1}/quantities/elements?limit=2`);
    expect(two.body).toMatchObject({ total: 8, truncated: true });
  });

  it("compares two versions", async () => {
    const d = await viewer.get(`${P()}/versions/${v2}/quantities/diff?from=${v1}`);
    expect(d.status, d.body?.message).toBe(200);
    expect(d.body.from).toMatchObject({ versionId: v1, version: 1 });
    expect(d.body.to).toMatchObject({ versionId: v2, version: 2 });
    expect(d.body.totals.delta).toMatchObject({ count: 0, netVolume: -2.34, netArea: -13.5, openingArea: 3 });
    expect(d.body.groups[0]).toMatchObject({ label: "Duvar · Kat 1", removed: 1 });
    expect(d.body.elementCount).toBe(4);
    expect((await viewer.get(`${P()}/versions/${v2}/quantities/diff?from=${v2}`)).status).toBe(400);
    expect((await viewer.get(`${P()}/versions/${v2}/quantities/diff`)).status).toBe(400);
    expect((await outsider.get(`${P()}/versions/${v2}/quantities/diff?from=${v1}`)).status).toBe(404);
  });

  it("exports the inventory and the difference to Excel", async () => {
    const inv = await viewer.get(`${P()}/versions/${v1}/quantities/export?groupBy=class`);
    expect(inv.status).toBe(200);
    expect(inv.raw.headers["content-disposition"]).toContain("Kaba-V1-metraj.xlsx");
    const buf = inv.raw.rawPayload;
    const summary = readXlsx(buf);
    expect(summary[0]).toEqual(["Grup", "Adet", "Miktarı Olan", "Net Hacim (m³)", "Brüt Hacim (m³)", "Brüt Alan (m²)", "Boşluk (m²)", "Net Alan (m²)", "Uzunluk (m)", "Ağırlık (kg)"]);
    expect(summary.find((r) => r[0] === "Duvar")).toEqual(["Duvar", "2", "2", "4.8", "3", "27", "3", "24", "9"]);
    // Second sheet: one row per element with the source property.
    const sheet2 = unzipEntries(buf).get("xl/worksheets/sheet2.xml")!.toString("utf8");
    expect(sheet2).toContain(W1);
    expect(sheet2).toContain("Qto_WallBaseQuantities.NetSideArea");

    const diff = await viewer.get(`${P()}/versions/${v2}/quantities/export?from=${v1}`);
    expect(diff.status).toBe(200);
    expect(diff.raw.headers["content-disposition"]).toContain("Kaba-V1-V2-metraj.xlsx");
    const rows = readXlsx(diff.raw.rawPayload);
    expect(rows[0]!.slice(0, 4)).toEqual(["Grup", "Adet · Eski", "Adet · Yeni", "Adet · Fark"]);
    expect(rows[1]!.slice(0, 4)).toEqual(["Duvar · Kat 1", "1", "0", "-1"]);
  });

  it("answers through cde_quantity_inventory (MCP / Sor)", async () => {
    const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
      const r = method === "GET" ? await viewer.get(url) : await viewer.post(url, body);
      if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body?.message}`);
      return r.body as T;
    };
    const def = cdeToolDefinitions(call, { readOnly: true }).find((x) => x.name === "cde_quantity_inventory")!;
    expect(def.write).toBe(false);
    const run = (args: Record<string, unknown>) => def.run(cdeParseArgs(def, args)) as Promise<any>;
    const inv = await run({ projectId: pid, versionId: v1, groupBy: ["class"] });
    expect(inv).toMatchObject({ model: "Kaba.ifc V1", totals: { count: 8, netVolume: 14.56 } });
    expect(inv.groups.find((g: { group: string }) => g.group === "Duvar")).toEqual({ group: "Duvar", count: 2, netVolume: 4.8, grossVolume: 3, grossArea: 27, openingArea: 3, netArea: 24, length: 9 });
    const diff = await run({ projectId: pid, versionId: v2, compareWithPrevious: true, limit: 2 });
    expect(diff).toMatchObject({ model: "Kaba.ifc V1 → V2", totals: { delta: { count: 0, netArea: -13.5 } }, moreElements: 2 });
    expect(diff.elements).toHaveLength(2);
    await expect(run({ projectId: pid, versionId: v1, compareWithPrevious: true })).rejects.toThrow("önceki");
  });

  describe("openings from the geometry", () => {
    let vid: string;

    it("deducts openings measured in the model and reports where the opening area came from", async () => {
      const up = await admin.upload(`${P()}/folders/${folder}/files`, "Bosluklu.ifc", IFC_OPENINGS);
      await jobs.drain();
      vid = (await admin.get(`${P()}/files/${up.body.results[0].fileId}`)).body.versions[0].id;
      const r = await viewer.get(`${P()}/versions/${vid}/quantities?groupBy=class`);
      expect(r.status, r.body?.message).toBe(200);
      expect(r.body.openings).toEqual({ source: "geometry", hosts: 3, openings: 5, unmeasured: 1, area: 5.473, differs: 2 });
      const walls = r.body.groups.find((g: { class: string }) => g.class === "IfcWall");
      expect(walls).toMatchObject({ netArea: 27.31, openingArea: 3.973, length: 7 });
      const els = await viewer.get(`${P()}/versions/${vid}/quantities/elements?groupBy=class&group=${encodeURIComponent(walls.key)}`);
      expect(els.body.elements.find((e: { name: string }) => e.name === "Duvar-A").openings).toMatchObject({ count: 2, area: 3.69, modelArea: 0, fillers: ["Kapi-A", "Pencere-A"] });
    });

    it("rebuilds an index written before openings were read (409 until it is ready)", async () => {
      const [row] = await handle.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, vid));
      const { units: _u, openings: _o, openingsV: _v, ...older } = await loadIndexFile(storage, vid, row!.storageKey);
      const tmp = path.join(dataDir, "old-index.json");
      writeFileSync(tmp, JSON.stringify(older));
      await saveVersionIndex(handle.db, storage, vid, pid, tmp, row!.elementCount);

      const waiting = await viewer.get(`${P()}/versions/${vid}/quantities`);
      expect(waiting.status).toBe(409);
      expect(waiting.body).toMatchObject({ error: "preparing", details: { pending: [vid] } });
      expect(waiting.body.message).toContain("boşluk");
      await jobs.drain();
      const ready = await viewer.get(`${P()}/versions/${vid}/quantities`);
      expect(ready.status, ready.body?.message).toBe(200);
      expect(ready.body.openings.source).toBe("geometry");
    });

    it("lists the opening count, the model's own opening area and geometric sources in Excel", async () => {
      const x = await viewer.get(`${P()}/versions/${vid}/quantities/export?groupBy=class`);
      expect(x.status).toBe(200);
      const sheet2 = unzipEntries(x.raw.rawPayload).get("xl/worksheets/sheet2.xml")!.toString("utf8");
      expect(sheet2).toContain("Boşluk Adedi");
      expect(sheet2).toContain("Model Boşluk Alanı (m²)");
      expect(sheet2).toContain("Brüt − Geometrik Boşluk");
      expect(sheet2).not.toContain("geometry:");
    });
  });
});
