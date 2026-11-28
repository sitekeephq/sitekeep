import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, fileVersions, jobs, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";
const READER = "The model could not be read (IFC reader error).";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let admin: string;
let member: string;
let projectId: string;
let versions: { a: string; b: string; fileA: string };

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}
const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};
async function upload(name: string, folderId: string): Promise<{ fileId: string; versionId: string }> {
  const form = new FormData();
  form.append("file", new Blob([`ISO-10303-21; ${name}`]), name);
  const req = new Request("http://x", { method: "POST", body: form });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/folders/${folderId}/files`,
    headers: { cookie: admin, "content-type": req.headers.get("content-type")! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  const fileId = res.json().results[0].fileId as string;
  const [v] = await handle.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
  return { fileId, versionId: v!.id };
}
const failedJob = (kind: string, payload: Record<string, unknown>, error: string) =>
  handle.db.insert(jobs).values({ kind, payload, status: "failed", error, attempts: 1, finishedAt: new Date() }).returning({ id: jobs.id }).then((r) => r[0]!.id);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-failed-jobs-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values([
    { email: "admin@fj.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
    { email: "uye@fj.test", name: "Üye", passwordHash: await hashPassword(PW), isAdmin: false },
  ]);
  admin = await login("admin@fj.test");
  member = await login("uye@fj.test");
  const p = await call(admin, "POST", "/projects", { code: "FJ1", name: "Failed Jobs" });
  projectId = p.body.id;
  const root = (await call(admin, "GET", `/projects/${projectId}/folders/${p.body.rootFolderId}/contents`)).body;
  const folderId = root.folders[0].id as string;
  const a = await upload("a.ifc", folderId);
  const b = await upload("b.ifc", folderId);
  versions = { a: a.versionId, b: b.versionId, fileA: a.fileId };
  await handle.db.delete(jobs); // the uploads' own conversion jobs
  await handle.db.update(fileVersions).set({ derivativeStatus: "failed", derivativeError: READER });
});
afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("failed jobs (admin)", () => {
  let ja: string, jb: string, gone: string, imp: string, sync: string;
  beforeAll(async () => {
    ja = await failedJob("ifc_to_frag", { versionId: versions.a }, READER);
    jb = await failedJob("ifc_to_frag", { versionId: versions.b }, READER);
    gone = await failedJob("ifc_to_frag", { versionId: randomUUID() }, READER);
    imp = await failedJob("project_import", { projectId }, "Archive is corrupt");
    sync = await failedJob("autodesk_sync", { connectionId: randomUUID(), runId: randomUUID() }, "Autodesk request failed (HTTP 400)");
  });

  it("is for system administrators only", async () => {
    for (const [m, u, b] of [
      ["GET", "/admin/failed-jobs/groups"],
      ["GET", "/admin/failed-jobs"],
      ["POST", "/admin/failed-jobs/retry", { ids: [ja] }],
      ["POST", "/admin/failed-jobs/clear", { ids: [ja] }],
    ] as const) {
      expect((await call(member, m, u, b)).status, u).toBe(403);
    }
    expect(await handle.db.select().from(jobs).where(eq(jobs.id, ja))).toHaveLength(1);
  });

  it("groups by kind and error with counts, and lists a group paged with project, file and version", async () => {
    const groups = (await call(admin, "GET", "/admin/failed-jobs/groups")).body;
    const g = groups.find((x: any) => x.kind === "ifc_to_frag");
    expect(g).toMatchObject({ error: READER, count: 3, retryable: true });
    expect(groups.find((x: any) => x.kind === "project_import")).toMatchObject({ count: 1, retryable: false });
    expect(groups).toHaveLength(3);

    const page = (await call(admin, "GET", `/admin/failed-jobs?kind=ifc_to_frag&error=${encodeURIComponent(READER)}&pageSize=2&page=1`)).body;
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page.items).toHaveLength(2);
    const item = page.items.find((i: any) => i.id === ja) ?? (await call(admin, "GET", `/admin/failed-jobs?kind=ifc_to_frag&error=${encodeURIComponent(READER)}&pageSize=2&page=2`)).body.items.find((i: any) => i.id === ja);
    expect(item.project).toMatchObject({ id: projectId, code: "FJ1", name: "Failed Jobs" });
    expect(item.file).toMatchObject({ name: "a.ifc", versionId: versions.a, version: 1 });
    expect(item).toMatchObject({ attempts: 1, error: READER, retryable: true });
    const orphan = (await call(admin, "GET", "/admin/failed-jobs?kind=ifc_to_frag&pageSize=100")).body.items.find((i: any) => i.id === gone);
    expect(orphan.file).toBeNull();
    expect((await call(admin, "GET", "/admin/failed-jobs?pageSize=101")).status).toBe(400);
  });

  it("reports the most recent failure on the status", async () => {
    const s = (await call(admin, "GET", "/admin/status")).body;
    expect(s.jobs.failed).toBe(5);
    expect(new Date(s.jobs.lastFailedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("retries one job: the version is converted again, the old record goes, an audit entry is written", async () => {
    const r = await call(admin, "POST", "/admin/failed-jobs/retry", { ids: [ja] });
    expect(r.body).toEqual({ queued: 1, skipped: 0 });
    const queued = await handle.db.select().from(jobs).where(and(eq(jobs.kind, "ifc_to_frag"), eq(jobs.status, "queued")));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.versionId).toBe(versions.a);
    expect((await handle.db.select().from(jobs).where(eq(jobs.id, ja)))).toHaveLength(0);
    const [v] = await handle.db.select().from(fileVersions).where(eq(fileVersions.id, versions.a));
    expect(v!.derivativeStatus).toBe("pending");
    const [a] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "jobs.failed_retried"));
    expect(a!.details).toMatchObject({ queued: 1, skipped: 0 });
    // a version that is waiting already is not queued twice
    expect((await call(admin, "POST", "/admin/failed-jobs/retry", { ids: [ja] })).body).toEqual({ queued: 0, skipped: 0 });
  });

  it("retries a group: repeatable kinds queue, the rest are skipped", async () => {
    const r = await call(admin, "POST", "/admin/failed-jobs/retry", { kind: "ifc_to_frag", error: READER });
    // jb is queued; `gone` points at a version that no longer exists
    expect(r.body).toEqual({ queued: 1, skipped: 1 });
    expect((await call(admin, "POST", "/admin/failed-jobs/retry", { kind: "project_import", error: "Archive is corrupt" })).body).toEqual({ queued: 0, skipped: 1 });
    expect((await call(admin, "POST", "/admin/failed-jobs/retry", { ids: [sync] })).body).toEqual({ queued: 1, skipped: 0 });
    const [s] = await handle.db.select().from(jobs).where(eq(jobs.id, sync));
    expect(s).toMatchObject({ status: "queued", attempts: 0, error: null });
    expect((await handle.db.select().from(jobs).where(eq(jobs.id, jb)))).toHaveLength(0);
  });

  it("clears failed records one or by group, audited, and never touches other jobs", async () => {
    const queuedBefore = await handle.db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(queuedBefore.length).toBeGreaterThan(0);
    expect((await call(admin, "POST", "/admin/failed-jobs/clear", { ids: [queuedBefore[0]!.id] })).body).toEqual({ deleted: 0 });
    expect((await call(admin, "POST", "/admin/failed-jobs/clear", { ids: [imp] })).body).toEqual({ deleted: 1 });
    expect((await call(admin, "POST", "/admin/failed-jobs/clear", { kind: "ifc_to_frag", error: READER })).body).toEqual({ deleted: 1 });
    expect(await handle.db.select().from(jobs).where(eq(jobs.status, "failed"))).toHaveLength(0);
    expect(await handle.db.select().from(jobs).where(eq(jobs.status, "queued"))).toHaveLength(queuedBefore.length);
    const entries = await handle.db.select().from(auditLog).where(eq(auditLog.action, "jobs.failed_cleared"));
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.details).some((d: any) => d.kind === "ifc_to_frag" && d.deleted === 1)).toBe(true);
    expect((await call(admin, "POST", "/admin/failed-jobs/clear", {})).status).toBe(400);
  });
});
