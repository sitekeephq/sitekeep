/**
 * The server on object storage, end to end (docs/onprem/object-storage.md): uploads, downloads with the
 * same permission checks, ranged media reads, and the workers that need a file on disk — IFC conversion
 * (viewer model), PDF text preview, CAD preview + 2D scene, document comparison — each through a local copy
 * that is cleaned up afterwards. Runs on an in-memory bucket always, on an S3 server and a GCS emulator when
 * they can be had (Docker or TEST_S3_ENDPOINT; skipped otherwise).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { ObjectStorage, type ObjectBackend } from "../../src/core/platform/object-storage.js";
import { StorageCache } from "../../src/core/platform/storage-cache.js";
import { dxf } from "../documents/dxf-fixture.js";
import { gcsEmulatorAvailable, MemoryBackend, s3Backend, startFakeGcs, tryStartS3 } from "../helpers/object-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WALL = readFileSync(path.join(here, "../fixtures/sample-wall.ifc"));
const PW = "Sifre-1234567";

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 20, size: 12, font }));
  return Buffer.from(await doc.save());
}

function drawing(): string {
  return dxf({
    layers: [{ name: "DUVAR" }],
    entities: [
      { type: "LINE", handle: "A1", layer: "DUVAR", codes: [[100, "AcDbLine"], [10, 0], [20, 0], [30, 0], [11, 100], [21, 0], [31, 0]] },
      { type: "LINE", handle: "A2", layer: "DUVAR", codes: [[100, "AcDbLine"], [10, 100], [20, 0], [30, 0], [11, 100], [21, 50], [31, 0]] },
    ],
  });
}

function serverSuite(name: string, enabled: boolean, makeBackend: () => Promise<{ backend: ObjectBackend; prefix: string; partSize?: number; stop?: () => void }>) {
  describe.skipIf(!enabled)(`server on object storage: ${name}`, () => {
    let dataDir: string;
    let handle: DbHandle;
    let app: FastifyInstance;
    let jobs: JobQueue;
    let storage: ObjectStorage;
    let stop: (() => void) | undefined;
    let admin: string;
    let outsider: string;
    let pid: string;
    let folderId: string;

    const login = async (email: string) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
      expect(res.statusCode, res.body).toBe(200);
      return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
    };
    const get = (cookie: string, url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie, ...headers } });
    const upload = async (name: string, data: Buffer | string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(Buffer.from(data))]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/folders/${folderId}/files`,
        headers: { cookie: admin, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      expect(res.statusCode, res.body).toBe(200);
      const fileId = res.json().results[0].fileId as string;
      const file = (await get(admin, `/projects/${pid}/files/${fileId}`)).json();
      return { fileId, vid: file.latest.id as string, versions: file.versions as { id: string; version: number }[] };
    };
    const scratchEmpty = () => expect(readdirSync(storage.scratchDir)).toEqual([]);

    beforeAll(async () => {
      dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-objsrv-"));
      const b = await makeBackend();
      stop = b.stop;
      storage = new ObjectStorage(b.backend, {
        prefix: b.prefix,
        workDir: path.join(dataDir, "tmp", "storage"),
        partSize: b.partSize,
        // Small cache, small entries: the IFC goes through a temporary copy, previews through the cache.
        cache: new StorageCache(path.join(dataDir, "cache"), 32 * 1024 * 1024, 2 * 1024 * 1024),
      });
      await storage.init({ clearScratch: true });
      await storage.check();
      handle = await openDb("memory://");
      jobs = new JobQueue(handle.db, storage);
      app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 9) });
      await handle.db.insert(users).values([
        { email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
        { email: "disari@7d.test", name: "Dışarıdan", passwordHash: await hashPassword(PW), isAdmin: false },
      ]);
      admin = await login("admin@7d.test");
      outsider = await login("disari@7d.test");
      const p = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie: admin }, payload: { code: "OBJ", name: "Nesne depolama", template: "empty" } });
      pid = p.json().id;
      const f = await app.inject({ method: "POST", url: `/api/v1/projects/${pid}/folders`, headers: { cookie: admin }, payload: { parentId: p.json().rootFolderId, name: "Dosyalar" } });
      folderId = f.json().id;
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await handle?.close();
      stop?.();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("downloads the stored bytes; someone without access gets nothing", async () => {
      const body = Buffer.from("Şantiye günlüğü\n".repeat(5000));
      const { vid } = await upload("Günlük.txt", body);
      const dl = await get(admin, `/projects/${pid}/versions/${vid}/download`);
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(body)).toBe(true);
      expect(dl.headers["content-length"]).toBe(String(body.length));
      const denied = await get(outsider, `/projects/${pid}/versions/${vid}/download`);
      expect([403, 404]).toContain(denied.statusCode);
      expect(denied.rawPayload.includes(body.subarray(0, 20))).toBe(false);
      // The bucket's address never reaches the browser.
      expect(JSON.stringify(dl.headers)).not.toMatch(/s3:|gs:|amazonaws|storage\.googleapis|127\.0\.0\.1:\d+\/sitekeep/);
    });

    it("serves byte ranges of media from the bucket", async () => {
      const body = Buffer.from(Array.from({ length: 100_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(""));
      const { vid } = await upload("Uzun.txt", body);
      const r = await get(admin, `/projects/${pid}/versions/${vid}/media`, { range: "bytes=1000-1999" });
      expect(r.statusCode).toBe(206);
      expect(r.headers["content-range"]).toBe(`bytes 1000-1999/${body.length}`);
      expect(r.rawPayload.equals(body.subarray(1000, 2000))).toBe(true);
      const tail = await get(admin, `/projects/${pid}/versions/${vid}/media`, { range: "bytes=-10" });
      expect(tail.rawPayload.equals(body.subarray(-10))).toBe(true);
      expect((await get(admin, `/projects/${pid}/versions/${vid}/media`, { range: "bytes=999999-" })).statusCode).toBe(416);
      expect((await get(outsider, `/projects/${pid}/versions/${vid}/media`, { range: "bytes=0-9" })).statusCode).not.toBe(206);
    });

    it("converts an IFC to the viewer model through a local copy and serves it", async () => {
      const { vid } = await upload("Duvar.ifc", WALL);
      await jobs.drain();
      const v = (await get(admin, `/projects/${pid}/files`)).json();
      expect(v).toBeTruthy();
      const model = await get(admin, `/projects/${pid}/versions/${vid}/model`);
      expect(model.statusCode, model.body.slice(0, 300)).toBe(200);
      expect(model.rawPayload.length).toBeGreaterThan(100);
      const again = await get(admin, `/projects/${pid}/versions/${vid}/model`);
      expect(again.rawPayload.equals(model.rawPayload)).toBe(true);
      expect((await get(outsider, `/projects/${pid}/versions/${vid}/model`)).statusCode).not.toBe(200);
      const ifc = await get(admin, `/projects/${pid}/versions/${vid}/download`);
      expect(ifc.rawPayload.equals(WALL)).toBe(true);
      scratchEmpty();
    });

    it("builds the PDF text preview and the CAD preview + 2D scene through local copies", async () => {
      const { vid: pdfVid } = await upload("Rapor.pdf", await pdf(["Zemin etudu raporu", "Yeralti suyu 4,5 m"]));
      const { vid: dxfVid } = await upload("Plan.dxf", drawing());
      await jobs.drain();
      const ps = (await get(admin, `/projects/${pid}/versions/${pdfVid}/preview`)).json();
      expect(ps.previews.find((p: { kind: string }) => p.kind === "text")).toMatchObject({ status: "ready" });
      const search = (await get(admin, `/projects/${pid}/search?q=${encodeURIComponent("Yeralti suyu")}`)).json();
      expect(search.results.map((r: { name: string }) => r.name)).toContain("Rapor.pdf");
      const pdfRes = await get(admin, `/projects/${pid}/versions/${pdfVid}/pdf`);
      expect(pdfRes.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
      const ds = (await get(admin, `/projects/${pid}/versions/${dxfVid}/preview`)).json();
      const dxfPrev = ds.previews.find((p: { kind: string }) => p.kind === "dxf");
      expect(dxfPrev, JSON.stringify(ds.previews)).toMatchObject({ status: "ready" });
      const scene = ds.previews.find((p: { kind: string }) => p.kind === "scene");
      if (scene) {
        expect(scene).toMatchObject({ status: "ready" });
        const s = await get(admin, `/projects/${pid}/versions/${dxfVid}/preview/scene`);
        expect(s.statusCode).toBe(200);
      }
      scratchEmpty();
    });

    it("compares two PDF revisions through local copies", async () => {
      await upload("A-101.pdf", await pdf(["PAFTA A-101", "KOLON S12 40x60", "REV B"]));
      const { versions } = await upload("A-101.pdf", await pdf(["PAFTA A-101", "KOLON S12 50x60", "REV C", "NOT 4: yeni"]));
      const v1 = versions.find((v) => v.version === 1)!.id;
      const v2 = versions.find((v) => v.version === 2)!.id;
      const r = await get(admin, `/projects/${pid}/doc-compare?from=${v1}&to=${v2}&wait=30000`);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(r.json()).toMatchObject({ status: "done", result: { kind: "pdf", hasText: true, identical: false } });
      const changes = r.json().result.pages.flatMap((p: { changes: { new?: string }[] }) => p.changes.map((c) => c.new));
      expect(changes).toContain("KOLON S12 50x60");
      scratchEmpty();
    });

    it("reports the bucket on System Status, without credentials", async () => {
      const s = (await get(admin, "/admin/status")).json();
      expect(s.storage).toMatchObject({ driver: storage.driver, ok: true });
      expect(s.storage.location).toMatch(/^(s3|gs):\/\//);
      expect(s.storage.cache.entries).toBeGreaterThan(0);
      expect(JSON.stringify(s)).not.toMatch(/secret|AccessKey/i);
    });
  });
}

serverSuite("in-memory bucket", true, async () => ({ backend: new MemoryBackend(), prefix: "app", partSize: 5 * 1024 * 1024 }));

const s3 = await tryStartS3();
serverSuite("S3 server", !!s3, async () => {
  if (!s3) throw new Error("no S3 server");
  return { backend: s3Backend(s3.settings), prefix: `srv-${Date.now()}`, partSize: s3.settings.partSize, stop: () => s3.stop() };
});

serverSuite("GCS (fake-gcs-server)", gcsEmulatorAvailable, async () => {
  const g = await startFakeGcs();
  return { backend: g.backend, prefix: "srv", stop: g.stop };
});
