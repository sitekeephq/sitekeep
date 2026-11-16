/**
 * ISO19650-2 5.8.1 close-out archive (docs/features/CLOSEOUT_ARCHIVE.md): the ZIP of the Published
 * and Archived information built in the job queue, its manifest (codes, state, SHA-256, approvals,
 * ISO-12 supersession links, naming check), the audit log and chain check, SHA256SUMS, the limits
 * and the download period; the closed (read-only) project and its reopening.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";
import type { CloseoutManifestEntry } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, closeoutArchives, fileVersions, files, folders, projects, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { checkUpload } from "../../src/cde/guards.js";
import { closeoutLimits } from "../../src/closeout/config.js";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-closeout-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, closeout: { minFreeBytes: 0, maxBytes: null, retentionDays: 7 } });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash, isAdmin: true },
    { email: "pa@7d.test", name: "Pelin Project Admin", passwordHash },
    { email: "eda@7d.test", name: "Eda Editor", passwordHash },
  ]);
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
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, content = `%PDF-1.4 ${name} ${Math.random()}`) => {
      const form = new FormData();
      form.append("file", new Blob([content]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "accept-language": "en", "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

let admin: Api;
let pa: Api;
let eda: Api;
let pid: string;
let F: { wip: string; shared: string; published: string; archived: string };
let teamCheck: string;
let publication: string;
const P = () => `/projects/${pid}`;

const oneStep = (name: string) => ({
  name,
  steps: [{ name: "Check", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 0, outcomes: ["approved", "revise_resubmit", "rejected"] }],
});

async function latest(fileId: string) {
  const [f] = await handle.db.select().from(files).where(eq(files.id, fileId));
  const [v] = await handle.db.select().from(fileVersions).where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, f!.currentVersion)));
  return { file: f!, version: v! };
}

async function fileIn(folderId: string, name: string) {
  const [f] = await handle.db.select().from(files).where(and(eq(files.folderId, folderId), eq(files.name, name)));
  return f;
}

async function review(templateId: string, versionIds: string[], targetFolderId: string, extra: Record<string, unknown> = {}) {
  const r = await admin.post(`${P()}/reviews`, { templateId, versionIds, targetFolderId, name: `R ${Math.random()}`, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const done = await admin.post(`${P()}/reviews/${r.body.id}/submit`, { files: r.body.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" })) });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

/** Queues an archive, runs the job queue and returns the finished archive. */
async function archive(who: Api, options: Record<string, unknown> = {}) {
  const r = await who.post(`${P()}/closeout/archives`, options);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.status).toBe("queued");
  await jobs.drain();
  const done = await who.get(`${P()}/closeout/archives/${r.body.id}`);
  expect(done.status).toBe(200);
  return done.body;
}

async function unzip(who: Api, id: string) {
  const res = await who.get(`${P()}/closeout/archives/${id}/download`);
  expect(res.status, String(res.body).slice(0, 300)).toBe(200);
  expect(res.headers["content-type"]).toBe("application/zip");
  return { zip: await JSZip.loadAsync(res.raw), raw: res.raw };
}

describe("ISO19650-2 5.8.1 close-out archive: package contents", () => {
  it("sets up a project with a publication, its superseded archive copy and a Shared document", async () => {
    admin = api(await login("admin@7d.test"));
    pid = (await admin.post("/projects", { code: "CLS", name: "Close-out", template: "iso19650" })).body.id;
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    const of = (s: string) => fs.find((f) => f.state === s)!.id;
    F = { wip: of("wip"), shared: of("shared"), published: of("published"), archived: of("archived") };
    teamCheck = (await admin.post(`${P()}/workflow-templates`, oneStep("Team check"))).body.id;
    publication = (await admin.post(`${P()}/workflow-templates`, oneStep("Publication"))).body.id;
    const put = await admin.put(`${P()}/cde/settings`, {
      enforceTransitions: true,
      archiveFolderId: F.archived,
      transitions: [
        { fromState: null, toState: "wip", mode: "direct" },
        { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: teamCheck },
        { fromState: "shared", toState: "wip", mode: "auto" },
        { fromState: "shared", toState: "published", mode: "review", workflowTemplateId: publication },
        { fromState: "published", toState: "archived", mode: "auto" },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    for (const email of ["pa@7d.test", "eda@7d.test"])
      expect((await admin.post(`${P()}/members`, { email, isProjectAdmin: email === "pa@7d.test" })).status).toBe(200);
    const [e] = await handle.db.select().from(users).where(eq(users.email, "eda@7d.test"));
    for (const folder of [F.wip, F.shared, F.published])
      expect((await admin.put(`${P()}/folders/${folder}/permissions`, { entries: [{ subjectType: "user", subjectId: e!.id, level: "edit" }] })).status).toBe(200);
    pa = api(await login("pa@7d.test"));
    eda = api(await login("eda@7d.test"));

    // DOC-1: published twice (C01 archived as superseded by C02).
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf");
    const wip = w.body.results[0].fileId;
    await review(teamCheck, [(await latest(wip)).version.id], F.shared, { targetSuitability: "S2" });
    const shared = (await fileIn(F.shared, "DOC-1.pdf"))!;
    await review(publication, [(await latest(shared.id)).version.id], F.published, { targetSuitability: "A1" });
    await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf");
    await review(teamCheck, [(await latest(wip)).version.id], F.shared, { targetSuitability: "S2" });
    await review(publication, [(await latest(shared.id)).version.id], F.published, { targetSuitability: "A2" });
    expect(await fileIn(F.archived, "DOC-1.pdf")).toBeTruthy();
    // DOC-2: only shared.
    const w2 = await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-2.pdf");
    await review(teamCheck, [(await latest(w2.body.results[0].fileId)).version.id], F.shared, { targetSuitability: "S1" });
  });

  it("refuses the archive to members who are not project administrators", async () => {
    expect((await eda.get(`${P()}/closeout`)).status).toBe(403);
    expect((await eda.post(`${P()}/closeout/archives`, {})).status).toBe(403);
  });

  it("estimates the archive for each choice of options", async () => {
    const s = (await pa.get(`${P()}/closeout`)).body;
    expect(s.closed).toBe(false);
    expect(s.limits).toEqual({ maxBytes: null, retentionDays: 7 });
    // Published DOC-1 and its archive copy; with Shared also the Shared DOC-1 and DOC-2.
    expect(s.estimate.latest.files).toBe(2);
    expect(s.estimate.sharedLatest.files).toBe(4);
    expect(s.estimate.all.versions).toBeGreaterThan(s.estimate.latest.versions);
  });

  let archiveId: string;
  let manifest: { entries: CloseoutManifestEntry[]; auditChain: { ok: boolean; head: { id: number; hash: string } }; schema: string; counts: { files: number; versions: number; problems: number } };

  it("builds the ZIP in the job queue: Published and Archived files in their folders, manifest, audit log, chain check, README and SHA256SUMS", async () => {
    // A naming standard on Published that DOC-1 does not meet (the manifest records the check).
    const std = await admin.post(`${P()}/naming-standards`, { name: "Drawing Naming", delimiter: "-", fields: [{ name: "Type", type: "list", values: [{ code: "DWG" }] }, { name: "No", type: "number", digits: 1 }] });
    expect(std.status, JSON.stringify(std.body)).toBe(200);
    await handle.db.update(folders).set({ namingStandardId: std.body.id }).where(eq(folders.id, F.published));
    const a = await archive(pa);
    archiveId = a.id;
    expect(a).toMatchObject({ status: "done", problems: 0, filesTotal: 2, filesDone: 2, options: { includeShared: false, versions: "latest", closeProject: false } });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(a.expiresAt).getTime() - new Date(a.finishedAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    const { zip, raw } = await unzip(pa, a.id);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(a.sha256);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir).sort();
    const pubName = (await handle.db.select().from(folders).where(eq(folders.id, F.published)))[0]!.name;
    const arcName = (await handle.db.select().from(folders).where(eq(folders.id, F.archived)))[0]!.name;
    expect(names).toEqual(
      [
        "README.txt",
        "SHA256SUMS",
        "audit/audit-log.csv",
        "audit/audit-verify.json",
        `files/${arcName}/DOC-1.pdf`,
        `files/${pubName}/DOC-1.pdf`,
        "manifest.csv",
        "manifest.json",
      ].sort(),
    );

    // SHA256SUMS covers every other file of the package and matches it.
    const sums = (await zip.file("SHA256SUMS")!.async("string")).trim().split("\n");
    expect(sums).toHaveLength(names.length - 1);
    for (const line of sums) {
      const [hash, name] = line.split(/ {2}/);
      expect(createHash("sha256").update(await zip.file(name!)!.async("nodebuffer")).digest("hex"), name).toBe(hash);
    }

    manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.schema).toBe("sitekeep.closeout-manifest/1");
    expect(manifest.counts).toMatchObject({ files: 2, versions: 2, problems: 0 });
    const pub = manifest.entries.find((e) => e.path === `files/${pubName}/DOC-1.pdf`)!;
    const arc = manifest.entries.find((e) => e.path === `files/${arcName}/DOC-1.pdf`)!;
    const pubFile = (await fileIn(F.published, "DOC-1.pdf"))!;
    const pubV = await latest(pubFile.id);
    expect(pub).toMatchObject({
      fileId: pubFile.id,
      versionId: pubV.version.id,
      containerId: pubFile.containerId,
      documentCode: pubFile.documentCode,
      revision: "C02",
      suitability: "A2",
      cdeState: "published",
      size: pubV.version.size,
      sha256: pubV.version.sha256,
      integrity: "ok",
      uploadedAt: pubV.version.uploadedAt.toISOString(),
      latest: true,
    });
    // The approved copy names its review, workflow and approver.
    expect(pub.approvals).toEqual([
      expect.objectContaining({ role: "result", workflow: "Publication", outcome: "approved", steps: [expect.objectContaining({ step: 1, by: "Admin", outcome: "approved" })] }),
    ]);
    // ISO-12 both ways, with the path of the other side inside the ZIP.
    expect(pub.supersedes).toEqual([expect.objectContaining({ path: arc.path, revision: "C01" })]);
    expect(arc).toMatchObject({ cdeState: "archived", cdeStatus: "superseded", revision: "C01", suitability: "A1" });
    expect(arc.supersededBy).toEqual([expect.objectContaining({ path: pub.path, versionId: pub.versionId, revision: "C02" })]);
    // The naming standard of the folder.
    expect(pub.naming).toMatchObject({ standard: "Drawing Naming", ok: false });
    expect(arc.naming).toBeNull();
    expect(pub.naming!.errors.length).toBeGreaterThan(0);

    const csv = await zip.file("manifest.csv")!.async("string");
    expect(csv.startsWith("﻿Path;Document Code;Container ID")).toBe(true);
    expect(csv).toContain(`files/${pubName}/DOC-1.pdf;`);
    expect(csv).toContain(pubV.version.sha256);

    // The chain check at the time of the archive; the audit CSV ends at its head and holds no IP address.
    const verify = JSON.parse(await zip.file("audit/audit-verify.json")!.async("string"));
    expect(verify).toMatchObject({ ok: true, head: { id: manifest.auditChain.head.id, hash: manifest.auditChain.head.hash } });
    expect(a.auditChain).toMatchObject({ ok: true, head: { hash: verify.head.hash } });
    const auditCsv = await zip.file("audit/audit-log.csv")!.async("string");
    const header = auditCsv.split("\r\n")[0]!;
    expect(header).toContain("Action");
    expect(header).not.toContain("IP Address");
    expect(auditCsv).toContain("cde.superseded");
    expect(Number(auditCsv.split("\r\n")[1]!.split(";")[0])).toBeLessThanOrEqual(verify.head.id);
    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("ISO 19650-2:2018, 5.8.1");
    expect(readme).toContain(verify.head.hash);
  });

  it("records the archive and its download in the audit log", async () => {
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.targetId, archiveId)));
    const created = rows.find((r) => r.action === "project.closeout_archive_created")!;
    expect(created.details).toMatchObject({ versions: 2, problems: 0, auditChainOk: true, auditHead: { hash: manifest.auditChain.head.hash } });
    expect(rows.some((r) => r.action === "project.closeout_archive_downloaded")).toBe(true);
  });

  it("includes Shared and every version when asked, older versions as \"name (Vn)\"", async () => {
    const a = await archive(pa, { includeShared: true, versions: "all" });
    expect(a.status).toBe("done");
    const { zip } = await unzip(pa, a.id);
    const m = JSON.parse(await zip.file("manifest.json")!.async("string")) as { entries: CloseoutManifestEntry[] };
    const states = new Set(m.entries.map((e) => e.cdeState));
    expect(states).toEqual(new Set(["shared", "published", "archived"]));
    expect(m.entries.some((e) => e.name === "DOC-2.pdf" && e.cdeState === "shared")).toBe(true);
    const older = m.entries.filter((e) => !e.latest);
    expect(older.length).toBeGreaterThan(0);
    for (const e of older) expect(e.path).toMatch(new RegExp(`\\(V${e.version}\\)\\.pdf$`));
    expect(m.entries.every((e) => e.integrity === "ok")).toBe(true);
  });

  it("refuses an archive over the size limit or without disk space (the same checks run in the job)", async () => {
    const small = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), closeout: { maxBytes: 10, minFreeBytes: 0 } });
    try {
      const cookie = await login("pa@7d.test");
      const r = await small.inject({ method: "POST", url: `/api/v1${P()}/closeout/archives`, headers: { cookie, "accept-language": "en" }, payload: {} });
      expect(r.statusCode).toBe(400);
      expect(r.json().message).toMatch(/more than the limit/);
    } finally {
      await small.close();
    }
    const full = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), closeout: { maxBytes: null, minFreeBytes: Number.MAX_SAFE_INTEGER } });
    try {
      const cookie = await login("pa@7d.test");
      const r = await full.inject({ method: "POST", url: `/api/v1${P()}/closeout/archives`, headers: { cookie, "accept-language": "en" }, payload: {} });
      expect(r.statusCode).toBe(400);
      expect(r.json().message).toMatch(/Not enough disk space/);
    } finally {
      await full.close();
    }
    expect(closeoutLimits(undefined, { CDE_CLOSEOUT_MAX_GB: "2", CDE_CLOSEOUT_RETENTION_DAYS: "30", CDE_CLOSEOUT_MIN_FREE_GB: "0" })).toEqual({ maxBytes: 2 * 1024 ** 3, retentionDays: 30, minFreeBytes: 0 });
    expect(closeoutLimits(undefined, {})).toEqual({ maxBytes: null, retentionDays: 14, minFreeBytes: 2 * 1024 ** 3 });
  });

  it("deletes the ZIP after the download period; the link then answers 410", async () => {
    const [row] = await handle.db.select().from(closeoutArchives).where(eq(closeoutArchives.id, archiveId));
    await handle.db.update(closeoutArchives).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(closeoutArchives.id, archiveId));
    const s = (await pa.get(`${P()}/closeout`)).body;
    expect(s.archives.find((x: { id: string }) => x.id === archiveId).status).toBe("expired");
    await expect(storage.size(row!.storageKey!)).rejects.toThrow();
    expect((await pa.get(`${P()}/closeout/archives/${archiveId}/download`)).status).toBe(410);
  });

  it("lists a file missing from the storage or with changed bytes as a problem and does not close the project", async () => {
    const pubFile = (await fileIn(F.published, "DOC-1.pdf"))!;
    const v = await latest(pubFile.id);
    await storage.remove(v.version.storageKey);
    const arc = await latest((await fileIn(F.archived, "DOC-1.pdf"))!.id);
    writeFileSync(storage.localPath(arc.version.storageKey), "changed on disk, a different length");
    const a = await archive(pa, { closeProject: true });
    expect(a).toMatchObject({ status: "done", problems: 2 });
    const { zip } = await unzip(pa, a.id);
    const m = JSON.parse(await zip.file("manifest.json")!.async("string")) as { entries: CloseoutManifestEntry[] };
    expect(m.entries.find((e) => e.versionId === v.version.id)!.integrity).toBe("missing");
    const changed = m.entries.find((e) => e.versionId === arc.version.id)!;
    expect(changed.integrity).toBe("mismatch");
    // The changed bytes are archived as they are; SHA256SUMS holds their real hash.
    expect(await zip.file(changed.path)!.async("string")).toBe("changed on disk, a different length");
    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("missing from the storage");
    expect(readme).toContain("content does not match the stored SHA-256");
    await handle.db
      .update(fileVersions)
      .set({ sha256: createHash("sha256").update("changed on disk, a different length").digest("hex"), size: 35 })
      .where(eq(fileVersions.id, arc.version.id));
    expect((await handle.db.select().from(projects).where(eq(projects.id, pid)))[0]!.closedAt).toBeNull();
    // Put the bytes back for the next tests.
    const stored = await storage.putBytes(Buffer.from("%PDF-1.4 restored"), `projects/${pid}`);
    await handle.db.update(fileVersions).set({ storageKey: stored.key, sha256: stored.sha256, size: stored.size }).where(eq(fileVersions.id, v.version.id));
  });
});

describe("ISO19650-2 5.8.1 close-out archive: closed project (read-only)", () => {
  it("closes the project after a complete archive when asked, and records project.closed", async () => {
    const a = await archive(pa, { closeProject: true });
    expect(a).toMatchObject({ status: "done", problems: 0 });
    const s = (await pa.get(`${P()}/closeout`)).body;
    expect(s).toMatchObject({ closed: true, closedBy: { name: "Pelin Project Admin" } });
    expect((await pa.get(`/projects/${pid}`)).body.closedAt).toBeTruthy();
    const closed = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "project.closed")));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.details).toMatchObject({ archiveId: a.id });
  });

  it("refuses uploads and edits, keeps viewing and downloading", async () => {
    const up = await eda.upload(`${P()}/folders/${F.wip}/files`, "NEW-1.pdf");
    expect(up.status).toBe(403);
    expect(up.body).toMatchObject({ error: "project_closed" });
    expect(up.body.message).toMatch(/closed \(read-only\)/);
    const pubFile = (await fileIn(F.published, "DOC-1.pdf"))!;
    expect((await pa.patch(`${P()}/files/${pubFile.id}`, { description: "x" })).body.error).toBe("project_closed");
    expect((await admin.post(`${P()}/folders`, { parentId: F.wip, name: "New" })).body.error).toBe("project_closed");
    expect((await pa.post(`${P()}/close`)).body.error).toBe("project_closed");
    // Paths outside /projects/:pid (OpenCDE, modules) meet the same refusal in the CDE guard.
    await expect(checkUpload(handle.db, { projectId: pid, access: null, source: "opencde", folderId: F.wip, name: "X.pdf" })).rejects.toMatchObject({ status: 403, code: "project_closed" });
    // Viewing and downloading go on.
    expect((await eda.get(`${P()}/files/${pubFile.id}`)).status).toBe(200);
    expect((await eda.get(`${P()}/versions/${(await latest(pubFile.id)).version.id}/download`)).status).toBe(200);
    expect((await eda.post(`${P()}/download-zip`, { fileIds: [pubFile.id] })).status).toBe(200);
    // A new archive of the closed project can still be made and downloaded.
    expect((await archive(pa)).status).toBe("done");
  });

  it("is reopened only by a system administrator, recorded as project.reopened", async () => {
    const no = await pa.post(`${P()}/reopen`, {});
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/system administrator/);
    const yes = await admin.post(`${P()}/reopen`, { reason: "As-built corrections" });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "project.reopened")));
    expect(rows[0]!.details).toMatchObject({ reason: "As-built corrections" });
    expect((await eda.upload(`${P()}/folders/${F.wip}/files`, "NEW-1.pdf")).status).toBe(200);
    expect((await admin.post(`${P()}/reopen`, {})).status).toBe(409);
  });

  it("closes from the button after an earlier complete archive", async () => {
    expect((await eda.post(`${P()}/close`)).status).toBe(403);
    expect((await pa.post(`${P()}/close`)).status).toBe(200);
    expect((await eda.upload(`${P()}/folders/${F.wip}/files`, "NEW-2.pdf")).status).toBe(403);
    expect((await admin.post(`${P()}/reopen`, {})).status).toBe(200);
  });

  it("does not reveal a closed project to people outside it", async () => {
    expect((await pa.post(`${P()}/close`)).status).toBe(200);
    await handle.db.insert(users).values({ email: "out@7d.test", name: "Outsider", passwordHash: await hashPassword(PW) });
    const out = api(await login("out@7d.test"));
    expect((await out.post(`${P()}/folders`, { parentId: F.wip, name: "X" })).status).toBe(404);
    expect((await admin.post(`${P()}/reopen`, {})).status).toBe(200);
  });
});
