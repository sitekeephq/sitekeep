/**
 * Curve tessellation of viewer derivatives: web-ifc's default of 12 pieces per circle drew round
 * eaves as polygons, so the pre-faceted frame behind them showed through. New conversions use
 * DEFAULT_CIRCLE_SEGMENTS; derivatives built before are rebuilt in place when a model is opened.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { fileVersions, jobs as jobRows, users } from "../../src/db/schema.js";
import { DEFAULT_CIRCLE_SEGMENTS, GEOMETRY_REVISION, JobQueue, runIfcWorker } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EAVE = path.join(here, "../fixtures/round-eave.ifc");
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;
let cookie: string;

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers } });
}

async function upload(pid: string, folderId: string, name: string, data: Buffer) {
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

async function version(id: string) {
  const [row] = await handle.db.select().from(fileVersions).where(eq(fileVersions.id, id));
  return row!;
}

/** Pretends the version was converted before the tessellation setting (web-ifc's 12, no marker). */
async function makeOld(id: string) {
  const v = await version(id);
  const { geometry: _geometry, ...summary } = v.ifcSummary!;
  await handle.db.update(fileVersions).set({ ifcSummary: summary }).where(eq(fileVersions.id, id));
}

async function upgradeJobs(id: string) {
  return (await handle.db.select().from(jobRows).where(eq(jobRows.kind, "ifc_to_frag"))).filter(
    (j) => (j.payload as { versionId?: string }).versionId === id && (j.payload as { upgrade?: boolean }).upgrade,
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-curves-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 7) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("IFC curve tessellation", () => {
  let pid: string;
  let folderId: string;
  let eaveId: string;
  let otherId: string;

  it("hands CIRCLE_SEGMENTS to web-ifc: the round eave gets more geometry at 48 than at 12", async () => {
    const out12 = path.join(dataDir, "eave-12.frag");
    const out48 = path.join(dataDir, "eave-48.frag");
    await runIfcWorker(EAVE, out12, 60_000, undefined, 12);
    await runIfcWorker(EAVE, out48, 60_000, undefined, 48);
    expect(statSync(out48).size).toBeGreaterThan(statSync(out12).size);
  });

  it("converts new uploads with the default and records it in the summary", async () => {
    const p = JSON.parse((await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie }, payload: { code: "EAV", name: "Saçak" } })).body);
    pid = p.id;
    const contents = JSON.parse((await call("GET", `/projects/${pid}/folders/${p.rootFolderId}/contents`)).body);
    folderId = contents.folders[0].id;
    await upload(pid, folderId, "EAV-DNS.ifc", readFileSync(EAVE));
    await upload(pid, folderId, "EAV-KAFE.ifc", readFileSync(EAVE));
    await jobs.drain();
    const models = JSON.parse((await call("GET", `/projects/${pid}/models`)).body) as { id: string; ifcSummary: { geometry?: { circleSegments: number; revision?: number } } }[];
    expect(models).toHaveLength(2);
    for (const m of models) expect(m.ifcSummary.geometry).toEqual({ circleSegments: DEFAULT_CIRCLE_SEGMENTS, revision: GEOMETRY_REVISION });
    [eaveId, otherId] = models.map((m) => m.id) as [string, string];
    expect(DEFAULT_CIRCLE_SEGMENTS).toBeGreaterThanOrEqual(24);
  });

  it("serves an old derivative while it is rebuilt in place, then swaps it and drops the old file", async () => {
    await makeOld(eaveId);
    const before = await version(eaveId);
    const first = await call("GET", `/projects/${pid}/versions/${eaveId}/model`);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const oldEtag = first.headers.etag as string;
    expect(oldEtag).toBeTruthy();
    // Queued once; the model stays ready (no "processing" gap) until the job ran.
    expect(await upgradeJobs(eaveId)).toHaveLength(1);
    expect((await version(eaveId)).derivativeStatus).toBe("ready");
    expect((await call("GET", `/projects/${pid}/versions/${eaveId}/model`, { "if-none-match": oldEtag })).statusCode).toBe(304);
    expect(await upgradeJobs(eaveId)).toHaveLength(1);

    await jobs.drain();
    const after = await version(eaveId);
    expect(after.derivativeStatus).toBe("ready");
    expect(after.derivativeKey).not.toBe(before.derivativeKey);
    expect(after.ifcSummary?.geometry).toEqual({ circleSegments: DEFAULT_CIRCLE_SEGMENTS, revision: GEOMETRY_REVISION });
    expect(after.ifcSummary).toMatchObject({ schema: before.ifcSummary!.schema, elementCount: before.ifcSummary!.elementCount });
    await expect(storage.size(before.derivativeKey!)).rejects.toThrow();
    const fresh = await call("GET", `/projects/${pid}/versions/${eaveId}/model`, { "if-none-match": oldEtag });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers.etag).not.toBe(oldEtag);
    // Up to date now: opening it again queues nothing.
    await call("GET", `/projects/${pid}/versions/${eaveId}/model`);
    expect(await upgradeJobs(eaveId)).toHaveLength(1);
  });

  it("rebuilds a 48-segment derivative from before the winding repair (no revision)", async () => {
    const v = await version(eaveId);
    await handle.db
      .update(fileVersions)
      .set({ ifcSummary: { ...v.ifcSummary!, geometry: { circleSegments: DEFAULT_CIRCLE_SEGMENTS } } })
      .where(eq(fileVersions.id, eaveId));
    const before = (await upgradeJobs(eaveId)).length;
    await call("GET", `/projects/${pid}/versions/${eaveId}/model`);
    expect(await upgradeJobs(eaveId)).toHaveLength(before + 1);
    await jobs.drain();
    expect((await version(eaveId)).ifcSummary?.geometry).toEqual({ circleSegments: DEFAULT_CIRCLE_SEGMENTS, revision: GEOMETRY_REVISION });
  });

  it("keeps a derivative another version still uses (finished reviews share it)", async () => {
    const shared = (await version(eaveId)).derivativeKey!;
    await handle.db.update(fileVersions).set({ derivativeKey: shared }).where(eq(fileVersions.id, otherId));
    await makeOld(eaveId);
    await call("GET", `/projects/${pid}/versions/${eaveId}/model`);
    await jobs.drain();
    expect((await version(eaveId)).derivativeKey).not.toBe(shared);
    expect(await storage.size(shared)).toBeGreaterThan(0);
    expect((await call("GET", `/projects/${pid}/versions/${otherId}/model`)).statusCode).toBe(200);
  });

  it("leaves the model as it was when the rebuild fails, and does not retry it on every open", async () => {
    await makeOld(otherId);
    const before = await version(otherId);
    writeFileSync(storage.localPath(before.storageKey), "not an ifc");
    await call("GET", `/projects/${pid}/versions/${otherId}/model`);
    await jobs.drain();
    const failed = await handle.db.select().from(jobRows).where(and(eq(jobRows.kind, "ifc_to_frag"), eq(jobRows.status, "failed")));
    expect(failed.some((j) => (j.payload as { versionId?: string }).versionId === otherId)).toBe(true);
    const after = await version(otherId);
    expect(after.derivativeStatus).toBe("ready");
    expect(after.derivativeKey).toBe(before.derivativeKey);
    expect((await call("GET", `/projects/${pid}/versions/${otherId}/model`)).statusCode).toBe(200);
    const queued = await handle.db.select().from(jobRows).where(and(eq(jobRows.kind, "ifc_to_frag"), eq(jobRows.status, "queued")));
    expect(queued.filter((j) => (j.payload as { versionId?: string }).versionId === otherId)).toHaveLength(0);
  });
});
