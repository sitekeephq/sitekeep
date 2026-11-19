/**
 * Converted models (Revit .rvt through a module's ModelFormat) over time: the converted IFC is kept and downloadable,
 * a new converter version converts again at start-up, failed versions are retried once per converter version, and
 * project administrators can "Convert again" (docs/features/MODEL_FORMATS.md). A stand-in converter copies an IFC
 * fixture and reports a version the test changes.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, files, fileVersions, jobs as jobRows, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { setModelFormats, type ModelFormat } from "../../src/files/model-formats.js";
import { queueModelBackfill, queueModelReconversion } from "../../src/files/model-backfill.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WALL = path.join(here, "../fixtures/sample-wall.ifc");
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
let admin: string;
let member: string;
let memberId: string;
let pid: string;
let folderId: string;

/** The converter "installed" now; files named "*bozuk*" fail, "*sonra*" fail only before version 3. */
let installed: string | null = "test-converter 1.0";
let conversions = 0;
const fakeRevit: ModelFormat = {
  extensions: ["rvt"],
  label: "Revit",
  async toIfc(input, output) {
    conversions++;
    const text = readFileSync(input, "utf8");
    if (text.includes("bozuk") || (text.includes("sonra") && installed !== "test-converter 3.0")) throw new Error("Revit dosyası okunamadı.");
    copyFileSync(WALL, output);
    return { format: "rvt", tool: installed ?? "test-converter ?", sourceVersion: "2024" };
  },
  version: async () => installed,
};

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

async function call(cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
}

async function upload(name: string, data: string) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(data)]), name);
  const req = new Request("http://x", { method: "POST", body: form });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/folders/${folderId}/files`,
    headers: { cookie: admin, "content-type": req.headers.get("content-type")! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function versionsOf(name: string) {
  const rows = await handle.db
    .select({ v: fileVersions })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(files.name, name))
    .orderBy(desc(fileVersions.version));
  return rows.map((r) => r.v);
}

const latestOf = async (name: string) => (await versionsOf(name))[0]!;

/** Version numbers (with file names) of the queued jobs, in queue order. */
async function queuedVersions() {
  const rows = await handle.db
    .select({ name: files.name, version: fileVersions.version, payload: jobRows.payload })
    .from(jobRows)
    .innerJoin(fileVersions, eq(fileVersions.id, sql`(${jobRows.payload}->>'versionId')::uuid`))
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(jobRows.status, "queued"))
    .orderBy(asc(jobRows.createdAt));
  return rows.map((r) => `${r.name} V${r.version}`);
}

beforeAll(async () => {
  setModelFormats(() => [fakeRevit]);
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-model-reconvert-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 7) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  admin = await login("admin@7d.test");
  memberId = JSON.parse((await call(admin, "POST", "/users", { email: "uye@7d.test", name: "Üye", password: PW })).body).id;
  member = await login("uye@7d.test");
  const p = JSON.parse((await call(admin, "POST", "/projects", { code: "RVC", name: "Revit again" })).body);
  pid = p.id;
  folderId = JSON.parse((await call(admin, "GET", `/projects/${pid}/folders/${p.rootFolderId}/contents`)).body).folders[0].id;
  expect((await call(admin, "POST", `/projects/${pid}/members`, { email: "uye@7d.test" })).statusCode).toBe(200);
});

afterAll(async () => {
  setModelFormats(() => []);
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("converted models: kept IFC, converting again", () => {
  it("keeps the converted IFC and records the converter", async () => {
    await upload("RVC-MIM.rvt", "revit v1");
    await upload("RVC-MIM.rvt", "revit v2");
    await upload("RVC-BOZUK.rvt", "bozuk");
    await upload("RVC-SONRA.rvt", "sonra");
    await jobs.drain();
    const [v2, v1] = await versionsOf("RVC-MIM.rvt");
    for (const v of [v1!, v2!]) {
      expect(v.derivativeStatus, v.derivativeError ?? "").toBe("ready");
      expect(v.ifcKey).toBeTruthy();
      expect(v.converter).toBe("test-converter 1.0");
    }
    const failed = await latestOf("RVC-BOZUK.rvt");
    expect(failed).toMatchObject({ derivativeStatus: "failed", converter: "test-converter 1.0", ifcKey: null });
    // Nothing to do while the same converter is installed.
    expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
  });

  it("downloads the converted IFC with download permission, audited like a download", async () => {
    const v = await latestOf("RVC-MIM.rvt");
    const file = JSON.parse((await call(admin, "GET", `/projects/${pid}/files/${v.fileId}`)).body);
    expect(file.latest.ifcAvailable).toBe(true);
    expect(JSON.stringify(file)).not.toContain(v.ifcKey!);
    const res = await call(admin, "GET", `/projects/${pid}/versions/${v.id}/ifc`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="RVC-MIM.ifc"');
    expect(res.body).toBe(readFileSync(WALL, "utf8"));
    const [entry] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "file.downloaded"), eq(auditLog.targetId, v.fileId)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry?.details).toMatchObject({ version: 2, format: "ifc" });

    // View only: 403; no access: 404; view + download: 200.
    const perms = (level: string) => call(admin, "PUT", `/projects/${pid}/folders/${folderId}/permissions`, { mode: "replace", entries: [{ subjectType: "user", subjectId: memberId, level }] });
    expect((await perms("view")).statusCode).toBe(200);
    expect((await call(member, "GET", `/projects/${pid}/versions/${v.id}/ifc`)).statusCode).toBe(403);
    expect((await perms("none")).statusCode).toBe(200);
    expect((await call(member, "GET", `/projects/${pid}/versions/${v.id}/ifc`)).statusCode).toBe(404);
    expect((await perms("view_download")).statusCode).toBe(200);
    expect((await call(member, "GET", `/projects/${pid}/versions/${v.id}/ifc`)).statusCode).toBe(200);

    // A failed version has no IFC.
    const failed = await latestOf("RVC-BOZUK.rvt");
    expect((await call(admin, "GET", `/projects/${pid}/versions/${failed.id}/ifc`)).statusCode).toBe(404);
  });

  it("rebuilds from the kept IFC without converting again", async () => {
    const v = await latestOf("RVC-MIM.rvt");
    const before = conversions;
    await jobs.enqueue("ifc_to_frag", { versionId: v.id, upgrade: true });
    await jobs.drain();
    expect(conversions).toBe(before);
    expect((await latestOf("RVC-MIM.rvt")).derivativeStatus).toBe("ready");
  });

  it("converts again after a converter update, current versions first, and retries failed ones once", async () => {
    installed = "test-converter 2.0";
    expect(await queueModelReconversion(handle.db, jobs)).toBe(4);
    const order = await queuedVersions();
    // Current versions before older ones.
    expect(order.slice(0, 3).sort()).toEqual(["RVC-BOZUK.rvt V1", "RVC-MIM.rvt V2", "RVC-SONRA.rvt V1"]);
    expect(order[3]).toBe("RVC-MIM.rvt V1");
    // Claimed: a restart before the queue ran does not queue them again.
    expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
    // A ready model stays open while it is converted again; a failed one waits as "pending".
    expect((await latestOf("RVC-MIM.rvt")).derivativeStatus).toBe("ready");
    expect((await latestOf("RVC-BOZUK.rvt")).derivativeStatus).toBe("pending");
    const oldKey = (await latestOf("RVC-MIM.rvt")).ifcKey;
    await jobs.drain();
    const v = await latestOf("RVC-MIM.rvt");
    expect(v).toMatchObject({ derivativeStatus: "ready", converter: "test-converter 2.0" });
    expect(v.ifcSummary?.source?.tool).toBe("test-converter 2.0");
    expect(v.ifcKey).not.toBe(oldKey);
    // Failed again with 2.0: not retried while 2.0 is installed.
    expect(await latestOf("RVC-BOZUK.rvt")).toMatchObject({ derivativeStatus: "failed", converter: "test-converter 2.0" });
    expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
    // The next converter version tries again, and this time one of them converts.
    installed = "test-converter 3.0";
    expect(await queueModelReconversion(handle.db, jobs)).toBe(4);
    await jobs.drain();
    expect(await latestOf("RVC-SONRA.rvt")).toMatchObject({ derivativeStatus: "ready", converter: "test-converter 3.0" });
    expect((await latestOf("RVC-BOZUK.rvt")).derivativeStatus).toBe("failed");
    expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
  });

  it("retries failed versions from before the converter was recorded once", async () => {
    const failed = await latestOf("RVC-BOZUK.rvt");
    await handle.db.update(fileVersions).set({ converter: null }).where(eq(fileVersions.id, failed.id));
    expect(await queueModelReconversion(handle.db, jobs)).toBe(1);
    await jobs.drain();
    expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
  });

  it("leaves formats alone whose module does not report its converter", async () => {
    setModelFormats(() => [{ ...fakeRevit, version: undefined }]);
    try {
      installed = "test-converter 4.0";
      expect(await queueModelReconversion(handle.db, jobs)).toBe(0);
      expect(await queueModelBackfill(handle.db, jobs)).toBe(0);
    } finally {
      setModelFormats(() => [fakeRevit]);
      installed = "test-converter 3.0";
    }
  });

  it("lets project administrators convert a version again, audited", async () => {
    const v = await latestOf("RVC-MIM.rvt");
    const url = `/projects/${pid}/versions/${v.id}/convert-again`;
    expect((await call(member, "POST", url)).statusCode).toBe(403);
    const res = await call(admin, "POST", url);
    expect(res.statusCode, res.body).toBe(200);
    expect(await queuedVersions()).toEqual(["RVC-MIM.rvt V2"]);
    // Not twice while it is on its way.
    expect((await call(admin, "POST", url)).statusCode).toBe(409);
    const before = conversions;
    await jobs.drain();
    expect(conversions).toBe(before + 1);
    const [entry] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "file.model_reconverted"));
    expect(entry).toMatchObject({ targetId: v.fileId, userId: expect.any(String) });
    expect(entry?.details).toMatchObject({ version: 2 });

    // Only for files a module converts.
    await upload("RVC-NOT.txt", "text");
    const txt = await latestOf("RVC-NOT.txt");
    expect((await call(admin, "POST", `/projects/${pid}/versions/${txt.id}/convert-again`)).statusCode).toBe(400);
  });

  it("lets project administrators retry every failed version of the project", async () => {
    const url = `/projects/${pid}/model-conversions/retry-failed`;
    expect((await call(member, "POST", url)).statusCode).toBe(403);
    const res = await call(admin, "POST", url);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ queued: 1 });
    expect((await latestOf("RVC-BOZUK.rvt")).derivativeStatus).toBe("pending");
    await jobs.drain();
    expect((await latestOf("RVC-BOZUK.rvt")).derivativeStatus).toBe("failed");
    const [entry] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "file.model_retry_failed"));
    expect(entry?.details).toMatchObject({ queued: 1 });
  });
});
