/**
 * CDE foundation over the API: settings (GET for members, PUT for project administrators, audit),
 * the template "cde" block (ISO template, export, import), and the new file DTO fields with
 * information containers on upload, copy and approved review copy.
 * ISO 19650-1 §12, ISO 19650-2 §5.6 (docs/features/CDE_STATES.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { DEFAULT_CDE_SETTINGS, type CdeSettingsDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, fileVersions, files, folders, projects, reviewFiles, reviews, users, workflowTemplates } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { copyApprovedFiles } from "../../src/workflow/review-finalization.js";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-cde-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

describe("CDE settings API", () => {
  let admin: Api;
  let member: Api;
  let pid: string;
  let rootId: string;

  it("gives a new project a settings row with enforcement off", async () => {
    admin = api(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    member = api(await login("uye@7d.test"));
    const p = await admin.post("/projects", { code: "CDE1", name: "CDE", template: "iso19650" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);

    const r = await member.get(`/projects/${pid}/cde/settings`);
    expect(r.status).toBe(200);
    const s = r.body as CdeSettingsDto;
    expect({ ...s, updatedAt: null }).toEqual({ projectId: pid, ...DEFAULT_CDE_SETTINGS, updatedAt: null });
    expect(s.updatedAt).not.toBeNull();
  });

  it("hides the settings from non-members and refuses changes by non-admins", async () => {
    await admin.post("/users", { email: "dis@7d.test", name: "Dış", password: PW });
    const outsider = api(await login("dis@7d.test"));
    expect((await outsider.get(`/projects/${pid}/cde/settings`)).status).toBe(404);
    expect((await member.put(`/projects/${pid}/cde/settings`, { enforceTransitions: true })).status).toBe(403);
  });

  it("saves fields and replaces the transition table; audits cde.settings_updated", async () => {
    const [archive] = await handle.db.select().from(folders).where(and(eq(folders.projectId, pid), eq(folders.state, "archived")));
    const r = await admin.put(`/projects/${pid}/cde/settings`, {
      codeScheme: "legacy_r",
      wipPolicy: "team_only",
      archiveFolderId: archive!.id,
      transitions: [
        { fromState: "wip", toState: "shared", mode: "review", requireReason: true },
        { fromState: null, toState: "wip", mode: "direct" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body as CdeSettingsDto;
    expect(s.codeScheme).toBe("legacy_r");
    expect(s.wipPolicy).toBe("team_only");
    expect(s.enforceTransitions).toBe(false);
    expect(s.archiveFolderId).toBe(archive!.id);
    // Direct uploads first.
    expect(s.transitions).toEqual([
      { fromState: null, toState: "wip", mode: "direct", workflowTemplateId: null, requireReason: false },
      { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: null, requireReason: true },
    ]);
    expect((await member.get(`/projects/${pid}/cde/settings`)).body).toEqual(s);

    const [entry] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "cde.settings_updated")))
      .orderBy(desc(auditLog.id));
    expect(((entry!.details as { changed: string[] }).changed).sort()).toEqual(["archiveFolderId", "codeScheme", "transitions", "wipPolicy"]);

    // A field left out keeps its value; an empty table clears it.
    const cleared = await admin.put(`/projects/${pid}/cde/settings`, { transitions: [] });
    expect(cleared.body.transitions).toEqual([]);
    expect(cleared.body.codeScheme).toBe("legacy_r");
  });

  it("validates the body", async () => {
    const put = (body: unknown) => admin.put(`/projects/${pid}/cde/settings`, body);
    const twice = { fromState: "wip", toState: "shared", mode: "review" };
    expect((await put({ transitions: [twice, twice] })).status).toBe(400);
    expect((await put({ transitions: [{ fromState: "wip", toState: "wip", mode: "direct" }] })).status).toBe(400);
    expect((await put({ codeScheme: "s7" })).status).toBe(400);
    expect((await put({ wat: true })).status).toBe(400);
    expect((await put({ transitions: [{ fromState: "wip", toState: "draft", mode: "direct" }] })).status).toBe(400);
    expect((await put({ archiveFolderId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    const [wf] = await handle.db.insert(workflowTemplates).values({ projectId: pid, kind: "review", name: "W", steps: [] }).returning();
    expect((await put({ transitions: [{ ...twice, mode: "direct", workflowTemplateId: wf!.id }] })).status).toBe(400);
    const ok = await put({ transitions: [{ ...twice, workflowTemplateId: wf!.id }] });
    expect(ok.status).toBe(200);
    expect(ok.body.transitions[0].workflowTemplateId).toBe(wf!.id);
    // Another project's folder is refused.
    const other = await admin.post("/projects", { code: "CDE2", name: "Other", template: "empty" });
    expect((await put({ archiveFolderId: other.body.rootFolderId })).status).toBe(400);
    expect(rootId).toBeTruthy();
  });
});

describe("project template \"cde\" block", () => {
  let admin: Api;
  let pid: string;

  it("applies the ISO template's defaults (D-7, D-8, D-10)", async () => {
    admin = api(await login("admin@7d.test"));
    const r = await admin.post("/projects/from-template", { code: "ISO1", name: "ISO", templateId: "iso19650-temel" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pid = r.body.id;
    const s = (await admin.get(`/projects/${pid}/cde/settings`)).body as CdeSettingsDto;
    expect(s.enforceTransitions).toBe(true);
    expect(s.codeScheme).toBe("iso_uk_na");
    const wfs = await handle.db.select().from(workflowTemplates).where(eq(workflowTemplates.projectId, pid));
    const wf = (name: string) => wfs.find((w) => w.name === name)!.id;
    expect(s.transitions).toEqual([
      { fromState: null, toState: "wip", mode: "direct", workflowTemplateId: null, requireReason: false },
      { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: wf("Ekip İçi Kontrol"), requireReason: false },
      { fromState: "shared", toState: "wip", mode: "auto", workflowTemplateId: null, requireReason: false },
      { fromState: "shared", toState: "published", mode: "review", workflowTemplateId: wf("Tasarımcı → Müşavir → İdare"), requireReason: false },
      { fromState: "published", toState: "archived", mode: "auto", workflowTemplateId: null, requireReason: false },
    ]);
    const [archive] = await handle.db.select().from(folders).where(eq(folders.id, s.archiveFolderId!));
    expect(archive!.name).toBe("04-ARCHIVED (Arşiv)");
  });

  it("exports the block and creates the same settings from the export", async () => {
    const t = (await admin.get(`/projects/${pid}/export-template`)).body;
    expect(t.cde).toEqual({
      codeScheme: "iso_uk_na",
      enforceTransitions: true,
      wipPolicy: "team_only",
      adminSeesWip: true,
      archiveFolder: "04-ARCHIVED (Arşiv)",
      transitions: [
        { from: null, to: "wip", mode: "direct" },
        { from: "wip", to: "shared", mode: "review", workflow: "Ekip İçi Kontrol" },
        { from: "shared", to: "wip", mode: "auto" },
        { from: "shared", to: "published", mode: "review", workflow: "Tasarımcı → Müşavir → İdare" },
        { from: "published", to: "archived", mode: "auto" },
      ],
    });
    const r = await admin.post("/projects/from-template", { code: "ISO2", name: "ISO 2", template: t });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await admin.get(`/projects/${r.body.id}/export-template`)).body.cde).toEqual(t.cde);
  });

  it("leaves the block out for projects on the defaults, and refuses unknown workflows", async () => {
    const plain = await admin.post("/projects", { code: "PLN", name: "Plain", template: "empty" });
    expect((await admin.get(`/projects/${plain.body.id}/export-template`)).body.cde).toBeUndefined();
    const t = (await admin.get(`/projects/${pid}/export-template`)).body;
    t.cde.transitions[1].workflow = "Yok";
    const bad = await admin.post("/projects/from-template", { code: "ISO3", name: "ISO 3", template: t });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("Yok");
  });

  it("creates projects without a block with the defaults", async () => {
    const r = await admin.post("/projects/from-template", { code: "BVM", name: "BVM", templateId: "bina-veri-merkezi" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = (await admin.get(`/projects/${r.body.id}/cde/settings`)).body as CdeSettingsDto;
    expect(s.enforceTransitions).toBe(false);
    expect(s.transitions).toEqual([]);
    expect(s.updatedAt).not.toBeNull();
  });
});

describe("file DTO fields and information containers", () => {
  let admin: Api;
  let pid: string;
  let wip: string;
  let shared: string;

  it("an upload starts its own container; new fields are in the DTO", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "DTO", name: "DTO", template: "iso19650" });
    pid = p.body.id;
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    wip = fs.find((f) => f.state === "wip")!.id;
    shared = fs.find((f) => f.state === "shared")!.id;
    const up = await admin.upload(`/projects/${pid}/folders/${wip}/files`, "A-101.pdf", "%PDF-1.4 a");
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const id = up.body.results[0].fileId;
    const f = (await admin.get(`/projects/${pid}/files/${id}`)).body;
    expect(f.containerId).toBe(id);
    expect(f.documentCode).toBeNull();
    expect(f.cdeStatus).toBeNull();
    expect(f.latest.suitabilityCode).toBeNull();
    expect(f.latest.revisionCode).toBeNull();
    expect(f.versions[0]).toMatchObject({ suitabilityCode: null, revisionCode: null });
    // A new version stays in the container.
    await admin.upload(`/projects/${pid}/folders/${wip}/files`, "A-101.pdf", "%PDF-1.4 b");
    const v2 = (await admin.get(`/projects/${pid}/files/${id}`)).body;
    expect(v2.currentVersion).toBe(2);
    expect(v2.containerId).toBe(id);
    // The folder listing carries them too.
    const list = (await admin.get(`/projects/${pid}/folders/${wip}/contents`)).body;
    expect(list.files[0]).toMatchObject({ containerId: id, documentCode: null, cdeStatus: null });
  });

  it("a manual copy is a new document; a move keeps the container", async () => {
    const [src] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "A-101.pdf")));
    const copy = await admin.post(`/projects/${pid}/files/${src!.id}/copy`, { folderId: shared });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body.containerId).toBe(copy.body.id);
    expect(copy.body.containerId).not.toBe(src!.containerId);
    const moved = await admin.patch(`/projects/${pid}/files/${copy.body.id}`, { name: "A-102.pdf" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.containerId).toBe(copy.body.id);
  });

  it("an approved review copy joins the source's container", async () => {
    const [src] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "A-101.pdf"), eq(files.folderId, wip)));
    const [version] = await handle.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, src!.id), eq(fileVersions.version, 2)));
    const [admin1] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    const [review] = await handle.db
      .insert(reviews)
      .values({ projectId: pid, number: 1, name: "R1", targetFolderId: shared, createdBy: admin1!.id })
      .returning();
    await handle.db
      .insert(reviewFiles)
      .values({ reviewId: review!.id, fileId: src!.id, fileVersionId: version!.id, sourceFolderId: wip, finalStatus: "approved" });
    const report = await copyApprovedFiles({ db: handle.db, jobs }, review!, admin1!.id);
    expect(report).toMatchObject({ approved: 1, copied: 1, failed: 0 });
    const [copy] = await handle.db.select().from(files).where(eq(files.id, report.results[0]!.fileId!));
    expect(copy!.folderId).toBe(shared);
    expect(copy!.containerId).toBe(src!.containerId);
    expect(copy!.id).not.toBe(src!.id);
    const [project] = await handle.db.select().from(projects).where(eq(projects.id, pid));
    expect(project).toBeTruthy();
  });
});
