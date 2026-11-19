/**
 * Full project export and restore (docs/features/PROJECT_EXPORT.md): the ZIP built in the job queue
 * (folders, every version with its codes and SHA-256, issues as BCF 3.0, reviews, members, roles,
 * task teams, permissions, the audit log, manifest.json and SHA256SUMS), the scope of a project
 * administrator's export (what they can see) against a system administrator's (everything), the
 * audit rows and the notification; and the restore into ANOTHER installation as a new project
 * (people matched by e-mail, unknown ones reported), refused when a checksum does not match.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";
import type { ExportFileEntry, ExportFolderEntry, ProjectExportManifest, ProjectImportDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import {
  auditLog,
  documentCodes,
  fileVersions,
  files,
  folders,
  issues,
  memberRoles,
  notifications,
  projectCdeSettings,
  projectMembers,
  projectRoles,
  projects,
  users,
} from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

interface Install {
  handle: DbHandle;
  app: FastifyInstance;
  jobs: JobQueue;
  dir: string;
}

async function install(people: { email: string; name: string; isAdmin?: boolean }[]): Promise<Install> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-portability-"));
  const handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  const app = await buildApp({ db: handle.db, storage, jobs, closeout: { minFreeBytes: 0, maxBytes: null, retentionDays: 7 } });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values(people.map((p) => ({ ...p, passwordHash, isAdmin: !!p.isAdmin })));
  return { handle, app, jobs, dir };
}

async function client(inst: Install, email: string) {
  const res = await inst.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await inst.app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    let body: any = null;
    try {
      body = r.body ? r.json() : null;
    } catch {
      body = r.body;
    }
    return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
  };
  const multipart = async (url: string, parts: { name: string; value: string | Uint8Array; fileName?: string }[]) => {
    const form = new FormData();
    for (const p of parts) {
      if (p.fileName) form.append(p.name, new Blob([p.value as BlobPart]), p.fileName);
      else form.append(p.name, p.value as string);
    }
    const req = new Request("http://x", { method: "POST", body: form });
    const r = await inst.app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: { cookie, "accept-language": "en", "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    return { status: r.statusCode, body: r.json() };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: (url: string, name: string, content: string) => multipart(url, [{ name: "file", value: content, fileName: name }]),
    multipart,
  };
}
type Client = Awaited<ReturnType<typeof client>>;

let A: Install;
let B: Install;
let admin: Client;
let pa: Client;
let eda: Client;
let pid: string;
let F: { root: string; wip: string; teamWip: string; published: string };
const P = () => `/projects/${pid}`;
/** The system administrator's export, restored in the second installation. */
let fullZip: Buffer;

beforeAll(async () => {
  A = await install([
    { email: "admin@7d.test", name: "Admin", isAdmin: true },
    { email: "pa@7d.test", name: "Pelin Project Admin" },
    { email: "eda@7d.test", name: "Eda Editor" },
  ]);
  // Another installation: its own administrator and Pelin; Eda has no account there.
  B = await install([
    { email: "root@other.test", name: "Other Admin", isAdmin: true },
    { email: "PA@7d.test", name: "Pelin" },
    { email: "member@other.test", name: "Plain Member" },
  ]);
});

afterAll(async () => {
  for (const i of [A, B]) {
    await i.app.close();
    await i.handle.close();
    rmSync(i.dir, { recursive: true, force: true });
  }
});

async function exportAs(who: Client) {
  const r = await who.post(`${P()}/exports`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.status).toBe("queued");
  await A.jobs.drain();
  const done = await who.get(`${P()}/exports/${r.body.id}`);
  expect(done.status).toBe(200);
  expect(done.body.status, done.body.error).toBe("done");
  return done.body;
}

async function download(who: Client, id: string) {
  const res = await who.get(`${P()}/exports/${id}/download`);
  expect(res.status, String(res.body).slice(0, 300)).toBe(200);
  expect(res.headers["content-type"]).toBe("application/zip");
  return { zip: await JSZip.loadAsync(res.raw), raw: res.raw as Buffer };
}

const text = (zip: JSZip, name: string) => zip.file(name)!.async("string");
const json = async <T,>(zip: JSZip, name: string) => JSON.parse(await text(zip, name)) as T;

describe("full project export", () => {
  it("sets up a project: versions with codes, a task team's WIP, an issue, roles and permissions", async () => {
    admin = await client(A, "admin@7d.test");
    pid = (await admin.post("/projects", { code: "EXP", name: "Export", template: "iso19650" })).body.id;
    for (const email of ["pa@7d.test", "eda@7d.test"]) expect((await admin.post(`${P()}/members`, { email, isProjectAdmin: email === "pa@7d.test" })).status).toBe(200);
    pa = await client(A, "pa@7d.test");
    eda = await client(A, "eda@7d.test");
    const fs = await A.handle.db.select().from(folders).where(eq(folders.projectId, pid));
    const of = (s: string) => fs.find((f) => f.state === s)!.id;
    F = { root: fs.find((f) => f.parentId === null)!.id, wip: of("wip"), teamWip: "", published: of("published") };
    F.teamWip = (await admin.post(`${P()}/folders`, { parentId: F.wip, name: "ARC team" })).body.id;
    expect(F.teamWip).toBeTruthy();

    // DOC-1: two versions in WIP with codes and a document code; DOC-P in Published.
    expect((await admin.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf", "%PDF-1.4 one")).status).toBe(200);
    expect((await admin.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf", "%PDF-1.4 one, second version")).status).toBe(200);
    expect((await admin.upload(`${P()}/folders/${F.published}/files`, "DOC-P.txt", "published text")).status).toBe(200);
    expect((await admin.upload(`${P()}/folders/${F.teamWip}/files`, "TEAM-SECRET.txt", "only the team")).status).toBe(200);
    const [doc1] = await A.handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "DOC-1.pdf")));
    await A.handle.db.update(files).set({ documentCode: "DOC-1" }).where(eq(files.id, doc1!.id));
    await A.handle.db.update(fileVersions).set({ suitabilityCode: "S2", revisionCode: "P01.02" }).where(and(eq(fileVersions.fileId, doc1!.id), eq(fileVersions.version, 2)));

    // A task team owns its WIP folder; the team-only rule hides it from project administrators.
    const [team] = await A.handle.db.insert(projectRoles).values({ projectId: pid, name: "ARC", kind: "task_team", code: "ARC" }).returning();
    const [e] = await A.handle.db.select().from(users).where(eq(users.email, "eda@7d.test"));
    await A.handle.db.insert(memberRoles).values({ projectId: pid, userId: e!.id, roleId: team!.id });
    await A.handle.db.update(folders).set({ ownerTeamId: team!.id }).where(eq(folders.id, F.teamWip));
    await A.handle.db.update(projectCdeSettings).set({ wipPolicy: "team_only", adminSeesWip: false }).where(eq(projectCdeSettings.projectId, pid));
    expect((await admin.put(`${P()}/folders/${F.published}/permissions`, { entries: [{ subjectType: "user", subjectId: e!.id, level: "edit" }] })).status).toBe(200);

    expect((await eda.post(`${P()}/issues`, { title: "Clash at grid A-3", description: "Duct through beam" })).status).toBe(200);
  });

  it("is for project administrators only", async () => {
    expect((await eda.get(`${P()}/exports`)).status).toBe(403);
    expect((await eda.post(`${P()}/exports`)).status).toBe(403);
  });

  let paExport: string;
  it("a project administrator's export holds what they can see, with a checksum list that matches every entry", async () => {
    const state = (await pa.get(`${P()}/exports`)).body;
    expect(state.scope).toBe("visible");
    // DOC-1 (2 versions) and DOC-P; the team's WIP file is not visible to Pelin.
    expect(state.estimate).toMatchObject({ files: 2, versions: 3 });
    const done = await exportAs(pa);
    paExport = done.id;
    expect(done).toMatchObject({ scope: "visible", counts: { files: 2, versions: 3, issues: 1, problems: 0 } });
    const { zip, raw } = await download(pa, done.id);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(done.sha256);

    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "SHA256SUMS",
        "README.txt",
        "project.json",
        "folders.json",
        "files.json",
        "members.json",
        "reviews.json",
        "transmittals.json",
        "supersessions.json",
        "issues/issues-0001.bcfzip",
        "audit/audit-log.csv",
        "audit/audit-log.json",
      ]),
    );
    expect(names.some((n) => n.includes("TEAM-SECRET"))).toBe(false);
    // Older versions keep their bytes under "name (V1).ext".
    expect(names.filter((n) => n.startsWith("files/")).sort()).toHaveLength(3);
    expect(names.some((n) => /DOC-1 \(V1\)\.pdf$/.test(n))).toBe(true);

    // SHA256SUMS: every entry but itself; manifest.json lists the same for all but itself.
    const sums = new Map(
      (await text(zip, "SHA256SUMS"))
        .trim()
        .split("\n")
        .map((l) => [l.slice(66), l.slice(0, 64)] as const),
    );
    expect([...sums.keys()].sort()).toEqual(names.filter((n) => n !== "SHA256SUMS").sort());
    for (const [name, hash] of sums) expect(createHash("sha256").update(await zip.file(name)!.async("nodebuffer")).digest("hex"), name).toBe(hash);
    const manifest = await json<ProjectExportManifest>(zip, "manifest.json");
    expect(manifest).toMatchObject({ schema: "sitekeep.project-export/1", scope: "visible", project: { code: "EXP" }, exportedBy: { email: "pa@7d.test" } });
    expect(manifest.checksums.map((c) => c.path).sort()).toEqual([...sums.keys()].filter((n) => n !== "manifest.json").sort());
    for (const c of manifest.checksums) expect(sums.get(c.path)).toBe(c.sha256);

    // files.json: all versions, codes, document code, state, SHA-256 and integrity.
    const { files: list } = await json<{ files: ExportFileEntry[] }>(zip, "files.json");
    const doc1 = list.find((f) => f.name === "DOC-1.pdf")!;
    expect(doc1).toMatchObject({ documentCode: "DOC-1", cdeState: "wip", currentVersion: 2 });
    expect(doc1.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(doc1.versions[1]).toMatchObject({ suitability: "S2", revision: "P01.02", integrity: "ok", uploadedByEmail: "admin@7d.test" });
    expect(doc1.versions[1]!.sha256).toBe(createHash("sha256").update("%PDF-1.4 one, second version").digest("hex"));

    // Folders with states and permissions; members, roles and task teams.
    const { folders: fl } = await json<{ folders: ExportFolderEntry[] }>(zip, "folders.json");
    expect(fl.find((f) => f.id === F.published)!.grants).toEqual([expect.objectContaining({ subjectType: "user", level: "edit" })]);
    expect(fl.find((f) => f.id === F.wip)).toMatchObject({ state: "wip", cdeState: "wip" });
    const members = await json<{ members: { email: string; roleIds: string[] }[]; roles: { name: string; kind: string }[] }>(zip, "members.json");
    expect(members.members.map((m) => m.email).sort()).toEqual(["admin@7d.test", "eda@7d.test", "pa@7d.test"]);
    expect(members.roles).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ARC", kind: "task_team" })]));

    // Issues: a BCF 3.0 package; the audit log as CSV and JSON.
    const bcf = await JSZip.loadAsync(await zip.file("issues/issues-0001.bcfzip")!.async("nodebuffer"));
    expect(await bcf.file("bcf.version")!.async("string")).toContain('VersionId="3.0"');
    const markup = Object.keys(bcf.files).find((n) => n.endsWith("markup.bcf"))!;
    expect(await bcf.file(markup)!.async("string")).toContain("Clash at grid A-3");
    const auditJson = await json<{ action: string; ip?: string }[]>(zip, "audit/audit-log.json");
    expect(auditJson.map((r) => r.action)).toEqual(expect.arrayContaining(["file.uploaded", "file.version_added"]));
    expect(auditJson.every((r) => !r.ip)).toBe(true);
    expect(await text(zip, "audit/audit-log.csv")).toContain("file.uploaded");
    expect(await text(zip, "README.txt")).toContain("sitekeep.project-export/1");
  });

  it("records project.exported and notifies the person who asked", async () => {
    const rows = await A.handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "project.exported")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ scope: "visible", counts: { files: 2, versions: 3 } });
    expect(await A.handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "project.export_downloaded")))).toHaveLength(1);
    const [p] = await A.handle.db.select().from(users).where(eq(users.email, "pa@7d.test"));
    const n = await A.handle.db.select().from(notifications).where(and(eq(notifications.userId, p!.id), eq(notifications.kind, "project_export")));
    expect(n).toHaveLength(1);
    expect(n[0]!.link).toBe(`/projects/${pid}/settings?sekme=disa-aktarma`);
  });

  it("a system administrator's export holds everything, and only system administrators get it", async () => {
    const state = (await admin.get(`${P()}/exports`)).body;
    expect(state.scope).toBe("full");
    const done = await exportAs(admin);
    expect(done).toMatchObject({ scope: "full", counts: { files: 3, versions: 4 } });
    const { zip, raw } = await download(admin, done.id);
    fullZip = raw;
    expect(Object.keys(zip.files).some((n) => n.endsWith("TEAM-SECRET.txt"))).toBe(true);
    expect((await pa.get(`${P()}/exports/${done.id}/download`)).status).toBe(403);
    // Pelin's own export stays hers to download.
    expect((await pa.get(`${P()}/exports/${paExport}/download`)).status).toBe(200);
  });

  it("deletes an export before its download period ends", async () => {
    expect((await pa.del(`${P()}/exports/${paExport}`)).status).toBe(200);
    expect((await pa.get(`${P()}/exports/${paExport}/download`)).status).toBe(410);
  });
});

describe("restore into another installation", () => {
  let root: Client;

  async function restore(zip: Buffer, code: string, who?: Client) {
    const r = await (who ?? root).multipart("/project-imports", [
      { name: "code", value: code },
      { name: "file", value: zip, fileName: "EXP-export.zip" },
    ]);
    if (r.status !== 200) return { status: r.status, body: r.body as ProjectImportDto };
    await B.jobs.drain();
    const done = await (who ?? root).get(`/project-imports/${r.body.id}`);
    return { status: 200, body: done.body as ProjectImportDto };
  }

  it("is for system administrators only", async () => {
    root = await client(B, "root@other.test");
    const member = await client(B, "member@other.test");
    expect((await member.get("/project-imports")).status).toBe(403);
    expect((await restore(fullZip, "X1", member)).status).toBe(403);
  });

  it("creates a new project with the files, versions, codes, folders, members and issues of the package", async () => {
    const r = await restore(fullZip, "EXP-R");
    expect(r.body.status, r.body.error ?? "").toBe("done");
    const newPid = r.body.projectId!;
    const db = B.handle.db;
    const [p] = await db.select().from(projects).where(eq(projects.id, newPid));
    expect(p).toMatchObject({ code: "EXP-R", name: "Export", archived: false });

    // Files and every version with the same bytes and codes; document code registered.
    const fl = await db.select().from(files).where(eq(files.projectId, newPid));
    expect(fl.map((f) => f.name).sort()).toEqual(["DOC-1.pdf", "DOC-P.txt", "TEAM-SECRET.txt"]);
    const doc1 = fl.find((f) => f.name === "DOC-1.pdf")!;
    expect(doc1).toMatchObject({ documentCode: "DOC-1", currentVersion: 2 });
    const vs = await db.select().from(fileVersions).where(eq(fileVersions.fileId, doc1.id));
    expect(vs.map((v) => v.version).sort()).toEqual([1, 2]);
    const v2 = vs.find((v) => v.version === 2)!;
    expect(v2).toMatchObject({ suitabilityCode: "S2", revisionCode: "P01.02", sha256: createHash("sha256").update("%PDF-1.4 one, second version").digest("hex") });
    // Nobody named admin@7d.test here: the uploader stays empty (listed in the report).
    expect(v2.uploadedBy).toBeNull();
    expect(await db.select().from(documentCodes).where(eq(documentCodes.projectId, newPid))).toEqual([expect.objectContaining({ codeNorm: "DOC-1", containerId: doc1.containerId })]);

    // Folders with their states; the team's folder keeps its owning team.
    const fs = await db.select().from(folders).where(eq(folders.projectId, newPid));
    expect(fs.filter((f) => f.state).map((f) => f.state).sort()).toEqual(["archived", "published", "shared", "wip"]);
    const teamFolder = fs.find((f) => f.name === "ARC team")!;
    const [team] = await db.select().from(projectRoles).where(and(eq(projectRoles.projectId, newPid), eq(projectRoles.name, "ARC")));
    expect(teamFolder.ownerTeamId).toBe(team!.id);
    const [cde] = await db.select().from(projectCdeSettings).where(eq(projectCdeSettings.projectId, newPid));
    expect(cde).toMatchObject({ wipPolicy: "team_only", adminSeesWip: false });

    // Members by e-mail (case-insensitive): Pelin as project administrator; Eda and the source admin are reported.
    const [pel] = await db.select().from(users).where(eq(users.email, "PA@7d.test"));
    const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, newPid));
    expect(members.find((m) => m.userId === pel!.id)).toMatchObject({ isProjectAdmin: true });
    expect(members).toHaveLength(2);
    expect(r.body.report!.unknownUsers.map((u) => u.email).sort()).toEqual(["admin@7d.test", "eda@7d.test"]);
    expect(await db.select().from(users).where(eq(users.email, "eda@7d.test"))).toHaveLength(0);
    // Eda's permission on Published has nobody to go to.
    expect(r.body.report!.skippedGrants).toBeGreaterThanOrEqual(1);

    // The issue, through the BCF import.
    const is = await db.select().from(issues).where(eq(issues.projectId, newPid));
    expect(is.map((i) => i.title)).toEqual(["Clash at grid A-3"]);
    expect(r.body.report!.counts).toMatchObject({ files: 3, versions: 4, issues: 1 });

    // Audit and notification.
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.projectId, newPid), eq(auditLog.action, "project.imported")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ source: { code: "EXP", scope: "full" }, unknownUsers: 2 });
    const [rootUser] = await db.select().from(users).where(eq(users.email, "root@other.test"));
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, rootUser!.id), eq(notifications.kind, "project_import")))).toHaveLength(1);
  });

  it("never overwrites: a code in use is refused", async () => {
    const r = await restore(fullZip, "EXP-R");
    expect(r.status).toBe(409);
  });

  it("refuses a package whose content no longer matches its checksums, before anything is written", async () => {
    const zip = await JSZip.loadAsync(fullZip);
    const victim = Object.keys(zip.files).find((n) => n.endsWith("DOC-P.txt"))!;
    zip.file(victim, "tampered");
    const tampered = await zip.generateAsync({ type: "nodebuffer" });
    const r = await restore(tampered, "EXP-T");
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain("Checksum mismatch");
    expect(r.body.error).toContain(victim);
    expect(r.body.projectId).toBeNull();
    expect(await B.handle.db.select().from(projects).where(eq(projects.code, "EXP-T"))).toHaveLength(0);

    // A file added to the package without a checksum is refused as well.
    const extra = await JSZip.loadAsync(fullZip);
    extra.file("files/extra.txt", "smuggled");
    const r2 = await restore(await extra.generateAsync({ type: "nodebuffer" }), "EXP-U");
    expect(r2.body.status).toBe("failed");
    expect(r2.body.error).toContain("files/extra.txt");
  });
});
