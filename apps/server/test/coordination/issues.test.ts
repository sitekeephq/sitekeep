// Issues without a model (document-only projects): create with document links, delete with
// permission checks and an audit entry.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, fileVersions, files, issueComments, issueLinks, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";
let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-issues-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
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

function client(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

describe("issues without a model", () => {
  let admin: ReturnType<typeof client>;
  let ayse: ReturnType<typeof client>;
  let bora: ReturnType<typeof client>;
  let outsider: ReturnType<typeof client>;
  let pid: string;
  let versionId: string;
  let boraId: string;
  let ayseId: string;

  beforeAll(async () => {
    admin = client(await login("admin@7d.test"));
    for (const [email, name] of [["ayse@7d.test", "Ayşe"], ["bora@7d.test", "Bora"], ["yabanci@7d.test", "Yabancı"]]) {
      const u = await admin.post("/users", { email, name, password: PW });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      if (email.startsWith("bora")) boraId = u.body.id;
      if (email.startsWith("ayse")) ayseId = u.body.id;
    }
    const p = await admin.post("/projects", { code: "ISS", name: "Sorunlar" });
    pid = p.body.id;
    for (const email of ["ayse@7d.test", "bora@7d.test"]) expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    ayse = client(await login("ayse@7d.test"));
    bora = client(await login("bora@7d.test"));
    outsider = client(await login("yabanci@7d.test"));
    // A PDF in the project's first folder, linked to the issue as a document.
    const adminId = (await handle.db.select().from(users).where(eq(users.email, "admin@7d.test")))[0]!.id;
    const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    const folderId = contents.body.folders[0].id as string;
    const perms = await admin.put(`/projects/${pid}/folders/${folderId}/permissions`, {
      entries: [ayseId, boraId].map((subjectId) => ({ subjectType: "user", subjectId, level: "view" })),
    });
    expect(perms.status, JSON.stringify(perms.body)).toBe(200);
    const [f] = await handle.db.insert(files).values({ projectId: pid, folderId, name: "Plan.pdf", createdBy: adminId }).returning();
    const [v] = await handle.db.insert(fileVersions).values({ fileId: f!.id, version: 1, storageKey: "none", size: 1, sha256: "0", uploadedBy: adminId }).returning();
    versionId = v!.id;
  });

  let iid: string;

  it("creates an issue without a viewpoint and links a document to it", async () => {
    const r = await ayse.post(`/projects/${pid}/issues`, {
      title: "Kapı ölçüsü uyuşmuyor",
      description: "Mimari plan ile kesit farklı.",
      priority: "high",
      assigneeUserId: boraId,
      dueDate: "2026-12-01",
      type: "Tasarım",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ number: 1, status: "open", priority: "high", assigneeUserId: boraId, dueDate: "2026-12-01", viewpoint: null });
    iid = r.body.id;
    const link = await ayse.post(`/projects/${pid}/issues/${iid}/links`, { kind: "version", targetId: versionId });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect((await bora.get(`/projects/${pid}/issues/${iid}/links`)).body).toEqual([expect.objectContaining({ kind: "version", target: expect.objectContaining({ fileName: "Plan.pdf" }) })]);
    expect((await bora.post(`/projects/${pid}/issues/${iid}/comments`, { body: "Bakıyorum." })).status).toBe(200);
  });

  it("lets only the creator or a project administrator delete it", async () => {
    // Bora is the assignee: he may edit, not delete.
    expect((await bora.del(`/projects/${pid}/issues/${iid}`)).status).toBe(403);
    expect((await outsider.del(`/projects/${pid}/issues/${iid}`)).status).toBe(404);
    expect((await ayse.del(`/projects/${pid}/issues/not-a-uuid`)).status).toBe(404);
    const r = await ayse.del(`/projects/${pid}/issues/${iid}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await ayse.get(`/projects/${pid}/issues/${iid}`)).status).toBe(404);
    expect((await ayse.get(`/projects/${pid}/issues`)).body).toEqual([]);
    expect(await handle.db.select().from(issueComments).where(eq(issueComments.issueId, iid))).toEqual([]);
    expect(await handle.db.select().from(issueLinks).where(eq(issueLinks.issueId, iid))).toEqual([]);
    expect((await ayse.del(`/projects/${pid}/issues/${iid}`)).status).toBe(404);
  });

  it("writes an audit entry with number, title and status", async () => {
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "issue.deleted"), eq(auditLog.targetId, iid)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ number: 1, title: "Kapı ölçüsü uyuşmuyor", status: "open", comments: 1, workLinks: 0 });
  });

  it("lets a project administrator delete someone else's issue; numbers are not reused", async () => {
    const r = await bora.post(`/projects/${pid}/issues`, { title: "İkinci" });
    expect(r.body.number).toBe(2); // #1 was deleted; its number is not given again
    expect((await admin.del(`/projects/${pid}/issues/${r.body.id}`)).status).toBe(200);
  });
});
