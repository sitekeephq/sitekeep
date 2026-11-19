/**
 * Model formats a module converts to IFC (ServerModule.modelFormats; Connect: Revit .rvt). A version of such
 * a file is converted first and then takes the IFC path unchanged: viewer derivative, element index, model
 * list. A stand-in converter copies an IFC fixture, so the test needs no converter program.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, desc, eq, sql } from "drizzle-orm";
import { docCompareKind, modelExtensions, registerModelExtension, viewerFor } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { files, fileVersions, jobs as jobRows, users, versionIndexes } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { isModelFile, modelFormatExtensions, modelFormatFor, registerModelViewerExtensions, setModelFormats, type ModelFormat } from "../../src/files/model-formats.js";
import { queueModelBackfill } from "../../src/files/model-backfill.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WALL = path.join(here, "../fixtures/sample-wall.ifc");
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
let cookie: string;
let pid: string;
let folderId: string;

/** Stand-in for a module's converter: ".rvt" → the wall fixture; files named "*bozuk*" fail. */
const calls: { input: string; output: string }[] = [];
const fakeRevit: ModelFormat = {
  extensions: ["rvt"],
  label: "Revit",
  async toIfc(input, output) {
    calls.push({ input, output });
    if (readFileSync(input, "utf8").includes("bozuk")) throw new Error("Revit dosyası okunamadı.");
    copyFileSync(WALL, output);
    return { format: "rvt", tool: "test-converter 1.0", sourceVersion: "2024", approximated: 2, hidden: 1, support: "partial" };
  },
};

async function call(method: "GET" | "POST", url: string) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie } });
}

async function upload(name: string, data: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([data]), name);
  const req = new Request("http://x", { method: "POST", body: form });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/folders/${folderId}/files`,
    headers: { cookie, "content-type": req.headers.get("content-type")! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function latestOf(name: string) {
  const [row] = await handle.db
    .select({ v: fileVersions })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(files.name, name))
    .orderBy(desc(fileVersions.version))
    .limit(1);
  return row!.v;
}

beforeAll(async () => {
  setModelFormats(() => [fakeRevit]);
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-model-formats-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 7) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  const p = JSON.parse((await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie }, payload: { code: "RVT", name: "Revit" } })).body);
  pid = p.id;
  folderId = JSON.parse((await call("GET", `/projects/${pid}/folders/${p.rootFolderId}/contents`)).body).folders[0].id;
});

afterAll(async () => {
  setModelFormats(() => []);
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("model formats", () => {
  it("knows IFC and the formats of the modules that are on", () => {
    expect(isModelFile("Blok A.ifc")).toBe(true);
    expect(isModelFile("Blok A.RVT")).toBe(true);
    expect(modelFormatFor("Blok A.rvt")?.label).toBe("Revit");
    expect(modelFormatFor("Blok A.ifc")).toBeNull();
    expect(isModelFile("Blok A.nwd")).toBe(false);
    setModelFormats(() => []);
    expect(isModelFile("Blok A.rvt")).toBe(false);
    setModelFormats(() => [fakeRevit]);
  });

  it("opens the registered extensions with the model viewer and never remaps a known one", () => {
    // (Already "ifc" when the installed Connect registered it at start-up.)
    registerModelViewerExtensions();
    expect(viewerFor("Blok A.rvt").kind).toBe("ifc");
    expect(modelExtensions()).toEqual(expect.arrayContaining(["ifc", "rvt"]));
    // Versions compare like IFC (through the element index).
    expect(docCompareKind("rvt")).toBe("ifc");
    expect(docCompareKind("nwd")).toBeNull();
    registerModelExtension("pdf");
    expect(viewerFor("plan.pdf").kind).toBe("pdf");
  });

  it("converts an uploaded .rvt to IFC and builds the viewer derivative and the element index from it", async () => {
    await upload("RVT-MIM.rvt", Buffer.from("revit bytes"));
    expect((await latestOf("RVT-MIM.rvt")).derivativeStatus).toBe("pending");
    await jobs.drain();
    const v = await latestOf("RVT-MIM.rvt");
    expect(v.derivativeStatus, v.derivativeError ?? "").toBe("ready");
    expect(v.derivativeKey).toBeTruthy();
    expect(v.ifcSummary?.elementCount).toBeGreaterThan(0);
    expect(v.ifcSummary?.source).toEqual({ format: "rvt", tool: "test-converter 1.0", sourceVersion: "2024", approximated: 2, hidden: 1, support: "partial" });
    const [index] = await handle.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, v.id));
    expect(index?.elementCount).toBeGreaterThan(0);
    // The converter read the stored file and wrote a temporary IFC, which is gone after the job.
    const last = calls.at(-1)!;
    expect(readFileSync(last.input, "utf8")).toBe("revit bytes");
    expect(() => readFileSync(last.output)).toThrow();
    // Listed with the project's models like an IFC upload.
    const models = JSON.parse((await call("GET", `/projects/${pid}/models`)).body) as { id: string }[];
    expect(models.map((m) => m.id)).toContain(v.id);
    // The model itself is served, and model queries read the converted model's elements.
    expect((await call("GET", `/projects/${pid}/versions/${v.id}/model`)).statusCode).toBe(200);
    const q = await app.inject({ method: "POST", url: `/api/v1/projects/${pid}/versions/${v.id}/model-query`, headers: { cookie }, payload: { query: { classes: ["IfcWall"] } } });
    expect(q.statusCode, q.body).toBe(200);
    expect(JSON.parse(q.body).count).toBeGreaterThan(0);
  });

  it("shows the converter's message when a file cannot be converted", async () => {
    await upload("RVT-BOZUK.rvt", Buffer.from("bozuk"));
    await jobs.drain().catch(() => undefined);
    const v = await latestOf("RVT-BOZUK.rvt");
    expect(v.derivativeStatus).toBe("failed");
    expect(v.derivativeError).toContain("Revit dosyası okunamadı.");
  });

  it("keeps other files as plain files: no derivative, no job", async () => {
    await upload("RVT-KOORD.nwd", Buffer.from("navisworks"));
    expect((await latestOf("RVT-KOORD.nwd")).derivativeStatus).toBe("none");
  });

  it("leaves .rvt as a plain file when no module converts it", async () => {
    setModelFormats(() => []);
    try {
      await upload("RVT-STA.rvt", Buffer.from("revit bytes"));
      await upload("RVT-STA.rvt", Buffer.from("revit bytes v2"));
      expect((await latestOf("RVT-STA.rvt")).derivativeStatus).toBe("none");
      expect(modelFormatExtensions()).toEqual([]);
      expect(await queueModelBackfill(handle.db, jobs)).toBe(0);
    } finally {
      setModelFormats(() => [fakeRevit]);
    }
  });

  it("converts stored versions once a module converts their format (start-up backfill), and only once", async () => {
    expect(modelFormatExtensions()).toEqual(["rvt"]);
    // RVT-STA.rvt (two versions) was stored while no module converted .rvt; RVT-BOZUK.rvt failed and is left alone.
    expect(await queueModelBackfill(handle.db, jobs)).toBe(2);
    expect((await latestOf("RVT-STA.rvt")).derivativeStatus).toBe("pending");
    // The current version is queued first, so the file opens before its history is converted.
    const queued = await handle.db
      .select({ versionId: jobRows.payload, version: fileVersions.version })
      .from(jobRows)
      .innerJoin(fileVersions, eq(fileVersions.id, sql`(${jobRows.payload}->>'versionId')::uuid`))
      .where(eq(jobRows.status, "queued"))
      .orderBy(asc(jobRows.createdAt));
    expect(queued.map((q) => q.version)).toEqual([2, 1]);
    expect(await queueModelBackfill(handle.db, jobs)).toBe(0);
    await jobs.drain();
    const v = await latestOf("RVT-STA.rvt");
    expect(v.derivativeStatus, v.derivativeError ?? "").toBe("ready");
    expect(v.ifcSummary?.source?.format).toBe("rvt");
    expect((await latestOf("RVT-BOZUK.rvt")).derivativeStatus).toBe("failed");
    // Plain files stay plain.
    expect((await latestOf("RVT-KOORD.nwd")).derivativeStatus).toBe("none");
  });
});
