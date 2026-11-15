/**
 * ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition (ISO-1, docs/features/CDE_STATES.md "Transitions"):
 * the transition table enforced per project (D-8), review start checks, the approved copy with codes
 * and revision, archive on publication (D-10), returned / withdrawn on rejection (D-2), the
 * administrator override and the module paths (assertDirectWriteAllowed, folderGate).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, fileVersions, files, folders, memberRoles, notifications, projectRoles, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { FolderTree } from "../../src/core/security/access.js";
import { assertDirectWriteAllowed, folderGate } from "../../src/workflow/service.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-transitions-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash, isAdmin: true },
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, name: string, fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("file", new Blob([`%PDF-1.4 ${name} ${Math.random()}`]), name);
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

async function latest(fileId: string) {
  const [f] = await handle.db.select().from(files).where(eq(files.id, fileId));
  const [v] = await handle.db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, f!.currentVersion)));
  return { file: f!, version: v! };
}

async function fileIn(folderId: string, name: string) {
  const [f] = await handle.db.select().from(files).where(and(eq(files.folderId, folderId), eq(files.name, name)));
  return f;
}

let admin: Api;
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

/** Starts a review and decides it in one step (the admin is the assignee). */
async function review(templateId: string, versionIds: string[], targetFolderId: string, outcome: string, extra: Record<string, unknown> = {}) {
  const r = await admin.post(`${P()}/reviews`, { templateId, versionIds, targetFolderId, name: `R ${Math.random()}`, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const done = await admin.post(`${P()}/reviews/${r.body.id}/submit`, {
    files: r.body.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome })),
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body;
}

async function enforce(on: boolean) {
  const r = await admin.put(`${P()}/cde/settings`, {
    enforceTransitions: on,
    archiveFolderId: F.archived,
    transitions: [
      { fromState: null, toState: "wip", mode: "direct" },
      { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: teamCheck },
      { fromState: "shared", toState: "wip", mode: "auto" },
      { fromState: "shared", toState: "published", mode: "review", workflowTemplateId: publication },
      { fromState: "published", toState: "archived", mode: "auto" },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe("ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition: enforcement switch (D-8)", () => {
  it("sets up a project with the four states and two review workflows", async () => {
    admin = api(await login("admin@7d.test"));
    pid = (await admin.post("/projects", { code: "TRN", name: "Transitions", template: "iso19650" })).body.id;
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    const of = (s: string) => fs.find((f) => f.state === s)!.id;
    F = { wip: of("wip"), shared: of("shared"), published: of("published"), archived: of("archived") };
    teamCheck = (await admin.post(`${P()}/workflow-templates`, oneStep("Team check"))).body.id;
    publication = (await admin.post(`${P()}/workflow-templates`, oneStep("Publication"))).body.id;
    expect(teamCheck).toBeTruthy();
    expect(publication).toBeTruthy();
    expect((await admin.post(`${P()}/members`, { email: "eda@7d.test" })).status).toBe(200);
    const [e] = await handle.db.select().from(users).where(eq(users.email, "eda@7d.test"));
    for (const folder of [F.wip, F.shared, F.published])
      expect((await admin.put(`${P()}/folders/${folder}/permissions`, { entries: [{ subjectType: "user", subjectId: e!.id, level: "edit" }] })).status).toBe(200);
    eda = api(await login("eda@7d.test"));
  });

  it("allows a direct WIP → Published upload and move when the project does not enforce the rules", async () => {
    await enforce(false);
    expect((await admin.upload(`${P()}/folders/${F.published}/files`, "OFF-1.pdf")).status).toBe(200);
    const w = await admin.upload(`${P()}/folders/${F.wip}/files`, "OFF-2.pdf");
    const moved = await admin.patch(`${P()}/files/${w.body.results[0].fileId}`, { folderId: F.published });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const tree = await FolderTree.load(handle.db, pid);
    await expect(assertDirectWriteAllowed(handle.db, tree, F.published)).resolves.toBeUndefined();
    expect((await folderGate(handle.db, tree, F.shared)).gated).toBe(false);
  });

  it("refuses a direct WIP → Published upload, move and copy with enforcement, for administrators too", async () => {
    await enforce(true);
    const up = await admin.upload(`${P()}/folders/${F.published}/files`, "ON-1.pdf");
    expect(up.status).toBe(403);
    expect(up.body.message).toBe(
      'Files cannot be written directly into Published: under the project\'s ISO 19650 rules they arrive from Shared through the review workflow "Publication". Upload into Work in Progress and send the file for review.',
    );
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "ON-2.pdf");
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const id = w.body.results[0].fileId;
    for (const who of [admin, eda]) {
      const toShared = await who.patch(`${P()}/files/${id}`, { folderId: F.shared });
      expect(toShared.status).toBe(403);
      expect(toShared.body.message).toBe('A document goes from Work in Progress to Shared only through the review workflow "Team check", not by moving it.');
    }
    const toPublished = await admin.patch(`${P()}/files/${id}`, { folderId: F.published });
    expect(toPublished.status).toBe(403);
    expect(toPublished.body.message).toBe("The project's ISO 19650 rules do not allow a document to go from Work in Progress to Published.");
    expect((await admin.post(`${P()}/files/${id}/copy`, { folderId: F.shared })).status).toBe(403);
    // A new version of a file already in Published is a direct write as well.
    expect((await admin.upload(`${P()}/folders/${F.published}/files`, "OFF-1.pdf")).status).toBe(403);
    // Inside one state a move is no transition.
    const sub = await admin.post(`${P()}/folders`, { parentId: F.wip, name: "Sub" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect((await eda.patch(`${P()}/files/${id}`, { folderId: sub.body.id })).status).toBe(200);
  });

  it("applies the same rules on the module paths (assertDirectWriteAllowed, folderGate)", async () => {
    const tree = await FolderTree.load(handle.db, pid);
    await expect(assertDirectWriteAllowed(handle.db, tree, F.wip)).resolves.toBeUndefined();
    await expect(assertDirectWriteAllowed(handle.db, tree, F.shared)).rejects.toMatchObject({ status: 403 });
    await expect(assertDirectWriteAllowed(handle.db, tree, F.published)).rejects.toMatchObject({ status: 403 });
    await expect(assertDirectWriteAllowed(handle.db, tree, F.archived)).rejects.toMatchObject({ status: 403 });
    const gate = await folderGate(handle.db, tree, F.shared);
    expect(gate).toMatchObject({ gated: true, byFolderId: F.shared });
    expect(gate.message?.key).toBe("cde:transitions.uploadNeedsReview");
    expect((await folderGate(handle.db, tree, F.wip)).gated).toBe(false);
    // The folder settings show the gate.
    expect((await admin.get(`${P()}/folders/${F.published}/settings`)).body).toMatchObject({ gated: true });
  });
});

describe("ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition: review start, approval, archive", () => {
  let wipFile: string;
  let wipVersion: string;
  let sharedFile: string;

  it("reports review start problems: wrong workflow, a forbidden pair, a suitability that does not fit", async () => {
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf");
    wipFile = w.body.results[0].fileId;
    wipVersion = (await latest(wipFile)).version.id;
    expect((await latest(wipFile)).version).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });

    const wrong = await admin.post(`${P()}/reviews/preview`, { templateId: publication, versionIds: [wipVersion], targetFolderId: F.shared, name: "x" });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.problems).toContain('From Work in Progress to Shared the project\'s ISO 19650 rules ask for the review workflow "Team check"; choose that workflow.');
    const skip = await admin.post(`${P()}/reviews/preview`, { templateId: teamCheck, versionIds: [wipVersion], targetFolderId: F.published, name: "x" });
    expect(skip.body.problems).toContain("The project's ISO 19650 rules do not allow a review from Work in Progress to Published.");
    const code = await admin.post(`${P()}/reviews/preview`, { templateId: teamCheck, versionIds: [wipVersion], targetFolderId: F.shared, name: "x", targetSuitability: "A1" });
    expect(code.body.problems[0]).toMatch(/A1 cannot be used in Shared/);
    expect((await admin.post(`${P()}/reviews`, { templateId: publication, versionIds: [wipVersion], targetFolderId: F.shared, name: "x" })).status).toBe(400);

    const ok = await admin.post(`${P()}/reviews/preview`, { templateId: teamCheck, versionIds: [wipVersion], targetFolderId: F.shared, name: "x", targetSuitability: "s3" });
    expect(ok.body.ok, JSON.stringify(ok.body.problems)).toBe(true);
    expect(ok.body.cde).toMatchObject({
      enforce: true,
      toState: "shared",
      requiredWorkflowTemplateId: teamCheck,
      suitabilityCode: "S3",
      allowedSuitability: ["S1", "S2", "S3", "S4"],
      files: [{ versionId: wipVersion, fromState: "wip", mode: "review", currentRevision: "P01.01", proposedRevision: "P01" }],
    });
  });

  it("copies an approved WIP file to Shared with the chosen suitability and the next revision", async () => {
    const done = await review(teamCheck, [wipVersion], F.shared, "approved", { targetSuitability: "S3" });
    expect(done.files[0].copyError).toBeNull();
    const copy = await fileIn(F.shared, "DOC-1.pdf");
    sharedFile = copy!.id;
    const { file, version } = await latest(sharedFile);
    const [source] = await handle.db.select().from(files).where(eq(files.id, wipFile));
    expect(file.containerId).toBe(source!.containerId);
    expect(version).toMatchObject({ suitabilityCode: "S3", revisionCode: "P01" });
    const [t] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cde.transition"), eq(auditLog.targetId, sharedFile)));
    expect(t!.details).toMatchObject({ fromState: "wip", toState: "shared", mode: "review" });
  });

  it("publishes C01; a second publication archives the first as superseded (D-10)", async () => {
    const sharedVersion = (await latest(sharedFile)).version.id;
    await review(publication, [sharedVersion], F.published, "approved", { targetSuitability: "A1" });
    const pub = (await fileIn(F.published, "DOC-1.pdf"))!;
    const first = await latest(pub.id);
    expect(first.version).toMatchObject({ suitabilityCode: "A1", revisionCode: "C01" });

    // A new WIP version goes through Shared (P02) and is published again (C02).
    await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-1.pdf");
    const v2 = await latest(wipFile);
    expect(v2.version.revisionCode).toBe("P01.02");
    await review(teamCheck, [v2.version.id], F.shared, "approved", { targetSuitability: "S2" });
    const shared2 = await latest(sharedFile);
    expect(shared2.version).toMatchObject({ suitabilityCode: "S2", revisionCode: "P02" });
    await review(publication, [shared2.version.id], F.published, "approved", { targetSuitability: "A2" });
    const second = await latest(pub.id);
    expect(second.version).toMatchObject({ version: 2, suitabilityCode: "A2", revisionCode: "C02" });
    expect(second.file.cdeStatus).toBeNull();

    const archived = (await fileIn(F.archived, "DOC-1.pdf"))!;
    expect(archived).toMatchObject({ cdeStatus: "superseded", containerId: pub.containerId });
    const old = await latest(archived.id);
    expect(old.version).toMatchObject({ storageKey: first.version.storageKey, suitabilityCode: "A1", revisionCode: "C01" });
    const audits = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, archived.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["cde.superseded", "cde.transition"]));
    expect(audits.find((a) => a.action === "cde.transition")!.details).toMatchObject({ fromState: "published", toState: "archived", mode: "auto" });
  });

  it("mirrors the Published path below the archive", async () => {
    const sub = await admin.post(`${P()}/folders`, { parentId: F.published, name: "Mimari" });
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-2.pdf");
    const wv = (await latest(w.body.results[0].fileId)).version.id;
    await review(teamCheck, [wv], F.shared, "approved");
    const s = (await fileIn(F.shared, "DOC-2.pdf"))!;
    await review(publication, [(await latest(s.id)).version.id], sub.body.id, "approved");
    await eda.upload(`${P()}/folders/${F.wip}/files`, "DOC-2.pdf");
    await review(teamCheck, [(await latest(w.body.results[0].fileId)).version.id], F.shared, "approved");
    await review(publication, [(await latest(s.id)).version.id], sub.body.id, "approved");
    const [mirror] = await handle.db.select().from(folders).where(and(eq(folders.parentId, F.archived), eq(folders.name, "Mimari")));
    expect(mirror).toBeTruthy();
    expect((await fileIn(mirror!.id, "DOC-2.pdf"))?.cdeStatus).toBe("superseded");
  });
});

describe("ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition: rejection (D-2) and the administrator override", () => {
  it("returns a rejected WIP document (returned, S0, its uploader notified); a new version clears it", async () => {
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "REJ-1.pdf");
    const id = w.body.results[0].fileId;
    // An earlier code that is not S0 (data from before the rules were enforced).
    await handle.db.update(fileVersions).set({ suitabilityCode: "S2" }).where(eq(fileVersions.fileId, id));
    await review(teamCheck, [(await latest(id)).version.id], F.shared, "rejected");
    const after = await latest(id);
    expect(after.file.cdeStatus).toBe("returned");
    expect(after.version.suitabilityCode).toBe("S0");
    const [e] = await handle.db.select().from(users).where(eq(users.email, "eda@7d.test"));
    const notes = await handle.db.select().from(notifications).where(and(eq(notifications.userId, e!.id), eq(notifications.kind, "cde.returned")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("REJ-1.pdf");
    expect(await fileIn(F.shared, "REJ-1.pdf")).toBeUndefined();
    await eda.upload(`${P()}/folders/${F.wip}/files`, "REJ-1.pdf");
    expect((await latest(id)).file.cdeStatus).toBeNull();
  });

  it("notifies the task team owning the WIP folder", async () => {
    const [team] = await handle.db.insert(projectRoles).values({ projectId: pid, name: "ARC team", kind: "task_team", code: "ARC" }).returning();
    const [me] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    await handle.db.insert(memberRoles).values({ projectId: pid, userId: me!.id, roleId: team!.id });
    const teamFolder = (await admin.post(`${P()}/folders`, { parentId: F.wip, name: "ARC" })).body.id;
    await handle.db.update(folders).set({ ownerTeamId: team!.id }).where(eq(folders.id, teamFolder));
    const w = await eda.upload(`${P()}/folders/${teamFolder}/files`, "REJ-T.pdf");
    await review(teamCheck, [(await latest(w.body.results[0].fileId)).version.id], F.shared, "revise_resubmit");
    const notes = await handle.db.select().from(notifications).where(and(eq(notifications.userId, me!.id), eq(notifications.kind, "cde.returned")));
    expect(notes.map((n) => n.title).join()).toContain("REJ-T.pdf");
  });

  it("withdraws a Shared copy refused for publication and returns its WIP original", async () => {
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "REJ-2.pdf");
    const id = w.body.results[0].fileId;
    await review(teamCheck, [(await latest(id)).version.id], F.shared, "approved");
    const shared = (await fileIn(F.shared, "REJ-2.pdf"))!;
    await review(publication, [(await latest(shared.id)).version.id], F.published, "revise_resubmit");
    expect((await latest(shared.id)).file.cdeStatus).toBe("withdrawn");
    expect((await latest(id)).file.cdeStatus).toBe("returned");
    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.projectId, pid))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["cde.withdrawn", "cde.returned"]));
    const [back] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cde.transition"), eq(auditLog.targetId, id)));
    expect(back!.details).toMatchObject({ fromState: "shared", toState: "wip", mode: "auto" });
    // Approved again later: the Shared copy is current again.
    await eda.upload(`${P()}/folders/${F.wip}/files`, "REJ-2.pdf");
    await review(teamCheck, [(await latest(id)).version.id], F.shared, "approved");
    expect((await latest(shared.id)).file.cdeStatus).toBeNull();
  });

  it("does not flag anything when the project does not enforce the rules", async () => {
    await enforce(false);
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "REJ-3.pdf");
    const id = w.body.results[0].fileId;
    await review(teamCheck, [(await latest(id)).version.id], F.shared, "rejected");
    expect((await latest(id)).file.cdeStatus).toBeNull();
    await enforce(true);
  });

  it("lets a project administrator override a transition with a reason (audit cde.override)", async () => {
    const w = await eda.upload(`${P()}/folders/${F.wip}/files`, "OVR-1.pdf");
    const id = w.body.results[0].fileId;
    expect((await eda.post(`${P()}/files/${id}/transition`, { toFolderId: F.published, reason: "x" })).status).toBe(403);
    const noReason = await admin.post(`${P()}/files/${id}/transition`, { toFolderId: F.published });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toBe("An override needs a reason.");
    const ok = await admin.post(`${P()}/files/${id}/transition`, { toFolderId: F.published, reason: "Client signed off on paper" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.folderId).toBe(F.published);
    const [o] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cde.override"), eq(auditLog.targetId, id)));
    expect(o!.details).toMatchObject({ what: "transition", fromState: "wip", toState: "published", reason: "Client signed off on paper" });
    const [t] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cde.transition"), eq(auditLog.targetId, id)));
    expect(t!.details).toMatchObject({ fromState: "wip", toState: "published", reason: "Client signed off on paper" });
  });
});
