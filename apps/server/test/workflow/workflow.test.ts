import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkflowStep } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import {
  addBusinessDays,
  advance,
  assigneeMatches,
  checkTemplate,
  combineStepOutcomes,
  finalOutcomes,
  isAssignee,
  isStepComplete,
  pendingAssignees,
  stepDueDate,
  worstOutcome,
  type ActorContext,
} from "../../src/workflow/engine.js";

// ---- Engine (pure) --------------------------------------------------------------------------

const actor = (o: Partial<ActorContext> & { userId: string }): ActorContext => ({
  companyId: null,
  isProjectAdmin: false,
  isStarter: false,
  ...o,
});

const step = (o: Partial<WorkflowStep>): WorkflowStep => ({
  name: "Adım",
  assignees: [],
  rule: "any",
  days: 0,
  outcomes: ["approved", "rejected"],
  ...o,
});

describe("workflow engine", () => {
  it("matches users, companies and built-in roles", () => {
    const a = actor({ userId: "u1", companyId: "c1", isProjectAdmin: true, isStarter: true });
    expect(assigneeMatches({ type: "user", id: "u1" }, a)).toBe(true);
    expect(assigneeMatches({ type: "user", id: "u2" }, a)).toBe(false);
    expect(assigneeMatches({ type: "company", id: "c1" }, a)).toBe(true);
    expect(assigneeMatches({ type: "company", id: "c1" }, actor({ userId: "u3" }))).toBe(false);
    expect(assigneeMatches({ type: "role", id: "project_admin" }, a)).toBe(true);
    expect(assigneeMatches({ type: "role", id: "starter" }, actor({ userId: "u3" }))).toBe(false);
    expect(isAssignee(step({ assignees: [{ type: "company", id: "c9" }, { type: "user", id: "u1" }] }), a)).toBe(true);
  });

  it("completes an 'any' step with the first answer and an 'all' step when every entry answered", () => {
    const any = step({ rule: "any", assignees: [{ type: "user", id: "u1" }, { type: "user", id: "u2" }] });
    expect(isStepComplete(any, [])).toBe(false);
    expect(isStepComplete(any, [{ actor: actor({ userId: "u2" }), outcomes: {} }])).toBe(true);

    const all = step({ rule: "all", assignees: [{ type: "user", id: "u1" }, { type: "company", id: "c1" }] });
    const u1 = { actor: actor({ userId: "u1" }), outcomes: {} };
    const c1member = { actor: actor({ userId: "u7", companyId: "c1" }), outcomes: {} };
    expect(isStepComplete(all, [u1])).toBe(false);
    expect(pendingAssignees(all, [u1])).toEqual([{ type: "company", id: "c1" }]);
    expect(isStepComplete(all, [u1, c1member])).toBe(true);
    expect(pendingAssignees(all, [u1, c1member])).toEqual([]);
  });

  it("combines outcomes: first answer for 'any', worst answer for 'all'", () => {
    const subs = [
      { actor: actor({ userId: "u1" }), outcomes: { f1: "approved" as const, f2: "approved" as const } },
      { actor: actor({ userId: "u2" }), outcomes: { f1: "approved_with_comments" as const, f2: "rejected" as const } },
    ];
    expect(combineStepOutcomes(step({ rule: "any" }), subs)).toEqual({ f1: "approved", f2: "approved" });
    expect(combineStepOutcomes(step({ rule: "all" }), subs)).toEqual({ f1: "approved_with_comments", f2: "rejected" });
    expect(worstOutcome(["reviewed", "approved", "revise_resubmit"])).toBe("revise_resubmit");
    expect(worstOutcome([])).toBeNull();
  });

  it("derives final outcomes from the latest step and the template mapping", () => {
    const results = { "0": { f1: "rejected" as const, f2: "approved" as const }, "1": { f1: "reviewed" as const } };
    expect(finalOutcomes(results, ["f1", "f2", "f3"], {})).toEqual({ f1: "reviewed", f2: "approved", f3: null });
    expect(finalOutcomes(results, ["f1"], { reviewed: "approved" })).toEqual({ f1: "approved" });
  });

  it("advances, finishes and computes due dates", () => {
    const steps = [step({}), step({})];
    expect(advance(steps, 0, false)).toEqual({ status: "running", stepIndex: 0, moved: false });
    expect(advance(steps, 0, true)).toEqual({ status: "running", stepIndex: 1, moved: true });
    expect(advance(steps, 1, true)).toEqual({ status: "completed", stepIndex: 1, moved: true });
    const fri = new Date("2026-10-09T09:00:00Z");
    expect(stepDueDate(fri, 0)).toBeNull();
    expect(stepDueDate(fri, 3)?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
    expect(addBusinessDays(fri, 1)?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
    expect(addBusinessDays(fri, 6)?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  it("validates templates", () => {
    expect(checkTemplate([])).toHaveLength(1);
    expect(checkTemplate([step({ name: " ", assignees: [], outcomes: [] })])).toHaveLength(3);
    expect(
      checkTemplate([step({ assignees: [{ type: "user", id: "u1" }, { type: "user", id: "u1" }] })])[0],
    ).toContain("iki kez");
  });
});

// ---- API ----------------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-wf-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string, password = PW): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "cde_session");
  return `cde_session=${cookie!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      headers: { cookie },
      payload: payload as object,
    });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, fileList: { name: string; data: Buffer | string }[], fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

type Client = ReturnType<typeof api>;

describe("document reviews", () => {
  let admin: Client, murat: Client, semih: Client, aytug: Client, hamza: Client, eve: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let wipId: string, sharedId: string, publishedId: string, designId: string;
  let templateId: string;
  let reviewId: string;
  let versionA: string, versionB: string, versionC: string;

  const P = () => `/projects/${pid}`;

  it("sets up a project with three companies and a gated SHARED folder", async () => {
    admin = api(await login("admin@7d.test"));
    for (const c of ["PAS", "CNS", "HLL"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const people: [string, string, string][] = [
      ["murat", "PAS", "Murat"],
      ["semih", "CNS", "Semih"],
      ["aytug", "HLL", "Aytuğ"],
      ["hamza", "HLL", "Hamza"],
      ["eve", "PAS", "Eve"],
    ];
    const p = await admin.post("/projects", { code: "WF", name: "Akış testi" });
    pid = p.body.id;
    for (const [key, company, name] of people) {
      ids[key] = (
        await admin.post("/users", { email: `${key}@wf.test`, name, password: PW, companyId: ids[company] })
      ).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@wf.test` })).status).toBe(200);
    }
    murat = api(await login("murat@wf.test"));
    semih = api(await login("semih@wf.test"));
    aytug = api(await login("aytug@wf.test"));
    hamza = api(await login("hamza@wf.test"));
    eve = api(await login("eve@wf.test"));

    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    [wipId, sharedId, publishedId] = root.body.folders.map((f: { id: string }) => f.id);
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: ids.murat, level: "edit" }],
    });
    for (const f of [sharedId, publishedId])
      await admin.put(`${P()}/folders/${f}/permissions`, {
        entries: [{ subjectType: "company", subjectId: ids.PAS, level: "edit" }],
      });

    const up = await murat.upload(`${P()}/folders/${designId}/files`, [
      { name: "A.pdf", data: "A içerik" },
      { name: "B.pdf", data: "B içerik" },
      { name: "C.pdf", data: "C içerik" },
    ]);
    expect(up.status).toBe(200);
    const contents = (await murat.get(`${P()}/folders/${designId}/contents`)).body.files;
    [versionA, versionB, versionC] = contents.map((f: { latest: { id: string } }) => f.latest.id);
  });

  it("gates direct uploads into a folder that only accepts approved reviews", async () => {
    expect((await murat.put(`${P()}/folders/${sharedId}/settings`, { requireApprovedReview: true })).status).toBe(403);
    expect((await admin.put(`${P()}/folders/${sharedId}/settings`, { requireApprovedReview: true })).status).toBe(200);
    const sub = (await admin.post(`${P()}/folders`, { parentId: sharedId, name: "Alt" })).body.id;
    const s = await murat.get(`${P()}/folders/${sub}/settings`);
    expect(s.body).toMatchObject({ requireApprovedReview: false, gated: true, gatedBy: "02-SHARED (Paylaşılan)" });

    for (const folder of [sharedId, sub]) {
      const res = await murat.upload(`${P()}/folders/${folder}/files`, [{ name: "direkt.pdf", data: "x" }]);
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("onaylanmış bir inceleme");
    }
    // Moving a file into the gated folder is blocked too.
    const fileA = (await murat.get(`${P()}/folders/${designId}/contents`)).body.files[0].id;
    expect((await murat.patch(`${P()}/files/${fileA}`, { folderId: sharedId })).status).toBe(403);
    // Only folder managers change the setting.
    expect((await eve.put(`${P()}/folders/${wipId}/settings`, { requireApprovedReview: true })).status).toBe(404);
  });

  it("manages review templates (project admins only)", async () => {
    const steps = [
      {
        name: "CNS inceleme",
        assignees: [{ type: "company", id: ids.CNS }],
        rule: "any",
        days: 5,
        outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected", "reviewed"],
      },
      {
        name: "HLL onay",
        assignees: [
          { type: "user", id: ids.aytug },
          { type: "user", id: ids.hamza },
        ],
        rule: "all",
        days: 3,
        outcomes: ["approved", "approved_with_comments", "rejected"],
      },
    ];
    expect((await murat.post(`${P()}/workflow-templates`, { name: "X", steps })).status).toBe(403);
    const outsider = await admin.post("/users", { email: "out@wf.test", name: "Out", password: PW });
    const bad = await admin.post(`${P()}/workflow-templates`, {
      name: "Kötü",
      steps: [{ ...steps[0], assignees: [{ type: "user", id: outsider.body.id }] }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("proje üyesi değil");

    const t = await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "CNS → HLL", steps });
    expect(t.status).toBe(200);
    templateId = t.body.id;
    const list = await semih.get(`${P()}/workflow-templates?kind=review`);
    expect(list.body.map((x: { name: string }) => x.name)).toEqual(["CNS → HLL"]);
  });

  it("checks rights when a review starts", async () => {
    const body = { name: "Mimari set", templateId, versionIds: [versionA, versionB], targetFolderId: sharedId };
    // Semih cannot see the WIP files.
    expect((await semih.post(`${P()}/reviews`, body)).status).toBe(404);
    // Eve can see WIP but cannot upload to the target.
    await admin.put(`${P()}/folders/${wipId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: ids.eve, level: "view" }],
    });
    // Eve's company edits SHARED, so use a target folder she can only view.
    const viewOnly = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Salt okunur" })).body.id;
    const r = await eve.post(`${P()}/reviews`, { ...body, targetFolderId: viewOnly });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("Hedef klasöre");
  });

  it("starts a review on pinned versions and notifies the first step", async () => {
    const r = await murat.post(`${P()}/reviews`, {
      name: "Mimari set",
      note: "Lütfen inceleyin",
      templateId,
      versionIds: [versionA, versionB],
      targetFolderId: sharedId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    reviewId = r.body.id;
    expect(r.body).toMatchObject({ number: 1, status: "running", stepIndex: 0, stepName: "CNS inceleme", fileCount: 2 });
    expect(r.body.stepDueAt).toBeTruthy();
    expect(r.body.targetFolderPath).toBe("Proje Dosyaları / 02-SHARED (Paylaşılan)");

    // A template edit later must not change the running review.
    const tpl = (await admin.get(`${P()}/workflow-templates`)).body[0];
    await admin.put(`${P()}/workflow-templates/${templateId}`, {
      ...tpl,
      steps: tpl.steps.map((s: WorkflowStep, i: number) => (i === 0 ? { ...s, name: "Değişti" } : s)),
    });
    expect((await murat.get(`${P()}/reviews/${reviewId}`)).body.steps[0].name).toBe("CNS inceleme");

    const n = await semih.get("/notifications");
    expect(n.body[0]).toMatchObject({ kind: "review.assigned", link: `/projects/${pid}/reviews/${reviewId}` });
    expect((await semih.get("/notifications/count")).body.unread).toBe(1);
    const tasks = await semih.get("/my-tasks");
    expect(tasks.body).toHaveLength(1);
    expect(tasks.body[0]).toMatchObject({ number: 1, stepName: "CNS inceleme", projectCode: "WF" });
    expect((await aytug.get("/my-tasks")).body).toHaveLength(0);

    // Files in a running review show as "in review".
    const ap = await murat.get(`${P()}/folders/${designId}/approvals`);
    expect(ap.body.map((x: { status: string }) => x.status)).toEqual(["in_review", "in_review"]);
  });

  it("lets only assignees act on the current step", async () => {
    const detail = (await semih.get(`${P()}/reviews/${reviewId}`)).body;
    expect(detail.canAct).toBe(true);
    const files = detail.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" }));
    // Not involved at all: the review is invisible.
    expect((await eve.post(`${P()}/reviews/${reviewId}/submit`, { files })).status).toBe(404);
    // The starter sees it but is not an assignee.
    expect((await murat.post(`${P()}/reviews/${reviewId}/submit`, { files })).status).toBe(403);
    // A later step's assignee cannot act yet.
    expect((await aytug.post(`${P()}/reviews/${reviewId}/submit`, { files })).status).toBe(403);
    // Every file needs an outcome.
    expect((await semih.post(`${P()}/reviews/${reviewId}/submit`, { files: files.slice(0, 1) })).status).toBe(400);
    // Reviewers can download pinned versions without folder rights.
    const dl = await semih.get(`${P()}/reviews/${reviewId}/files/${detail.files[0].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.raw.body).toBe("A içerik");
  });

  it("completes an 'any' step with one answer and moves on", async () => {
    const detail = (await semih.get(`${P()}/reviews/${reviewId}`)).body;
    const [fa, fb] = detail.files;
    const r = await semih.post(`${P()}/reviews/${reviewId}/submit`, {
      comment: "CNS görüşü",
      files: [
        { reviewFileId: fa.id, outcome: "approved" },
        { reviewFileId: fb.id, outcome: "approved_with_comments", comment: "Akslar kontrol edilsin" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ stepIndex: 1, stepName: "HLL onay", status: "running" });
    expect(r.body.files.map((f: { stepResults: Record<string, string> }) => f.stepResults["0"])).toEqual([
      "approved",
      "approved_with_comments",
    ]);
    expect((await semih.get("/my-tasks")).body).toHaveLength(0);
    expect((await aytug.get("/my-tasks")).body).toHaveLength(1);
    expect((await hamza.get("/notifications")).body[0].kind).toBe("review.assigned");
    expect((await murat.get("/notifications")).body.map((x: { kind: string }) => x.kind)).toContain("review.step_completed");
  });

  it("waits for every assignee in an 'all' step, then completes and copies approved files", async () => {
    const files = (await aytug.get(`${P()}/reviews/${reviewId}`)).body.files;
    const [fa, fb] = files;
    // "reviewed" is not allowed in this step.
    const notAllowed = await aytug.post(`${P()}/reviews/${reviewId}/submit`, {
      files: [
        { reviewFileId: fa.id, outcome: "reviewed" },
        { reviewFileId: fb.id, outcome: "approved" },
      ],
    });
    expect(notAllowed.status).toBe(400);

    const first = await aytug.post(`${P()}/reviews/${reviewId}/submit`, {
      files: [
        { reviewFileId: fa.id, outcome: "approved" },
        { reviewFileId: fb.id, outcome: "approved" },
      ],
    });
    expect(first.body).toMatchObject({ stepIndex: 1, status: "running", submittedBy: [ids.aytug], canAct: false });
    expect((await aytug.post(`${P()}/reviews/${reviewId}/submit`, { files: [{ reviewFileId: fa.id, outcome: "approved" }, { reviewFileId: fb.id, outcome: "approved" }] })).status).toBe(409);

    const done = await hamza.post(`${P()}/reviews/${reviewId}/submit`, {
      comment: "B uygun değil",
      files: [
        { reviewFileId: fa.id, outcome: "approved_with_comments" },
        { reviewFileId: fb.id, outcome: "rejected" },
      ],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("completed");
    const byName = Object.fromEntries(done.body.files.map((f: { fileName: string }) => [f.fileName, f]));
    expect(byName["A.pdf"]).toMatchObject({ finalStatus: "approved_with_comments", copyError: null });
    expect(byName["A.pdf"].copiedVersionId).toBeTruthy();
    expect(byName["B.pdf"]).toMatchObject({ finalStatus: "rejected", copiedVersionId: null });
    expect(done.body.actions.map((x: { kind: string }) => x.kind)).toEqual([
      "start",
      "submit",
      "step_completed",
      "submit",
      "submit",
      "step_completed",
      "completed",
    ]);

    // The approved copy is in SHARED and reuses the stored content; the rejected file is not.
    const shared = (await murat.get(`${P()}/folders/${sharedId}/contents`)).body.files;
    expect(shared.map((f: { name: string }) => f.name)).toEqual(["A.pdf"]);
    expect(shared[0].latest.comment).toContain("İnceleme #1");
    const original = (await murat.get(`${P()}/folders/${designId}/contents`)).body.files[0];
    expect(shared[0].latest.sha256).toBe(original.latest.sha256);
    const dl = await murat.get(`${P()}/versions/${shared[0].latest.id}/download`);
    expect(dl.raw.body).toBe("A içerik");

    // Approval status per version (source and copy).
    const ap = (await murat.get(`${P()}/folders/${designId}/approvals`)).body;
    const status = Object.fromEntries(ap.map((x: { versionId: string; status: string }) => [x.versionId, x.status]));
    expect(status[versionA]).toBe("approved_with_comments");
    expect(status[versionB]).toBe("rejected");
    expect(status[versionC]).toBeUndefined();
    const apShared = (await murat.get(`${P()}/folders/${sharedId}/approvals`)).body;
    expect(apShared[0]).toMatchObject({ status: "approved_with_comments", isCopy: true, reviewNumber: 1 });
    const history = (await murat.get(`${P()}/files/${original.id}/approvals`)).body;
    expect(history[0]).toMatchObject({ status: "approved_with_comments", reviewName: "Mimari set" });

    // Notifications and audit trail.
    expect((await murat.get("/notifications")).body[0]).toMatchObject({ kind: "review.completed" });
    expect((await aytug.get("/notifications")).body.map((x: { kind: string }) => x.kind)).toContain("review.completed");
    const activity = (await admin.get(`${P()}/activity`)).body.map((e: { action: string }) => e.action);
    expect(activity).toEqual(expect.arrayContaining(["review.started", "review.completed", "review.file_copied"]));
    expect((await hamza.post(`${P()}/reviews/${reviewId}/submit`, { files: [] })).status).toBe(400);
  });

  it("marks notifications read", async () => {
    const list = (await semih.get("/notifications")).body;
    expect((await semih.post(`/notifications/${list[0].id}/read`)).body.readAt).toBeTruthy();
    expect((await aytug.post(`/notifications/${list[0].id}/read`)).status).toBe(404);
    // Assigned + completed; one is read now.
    expect(list.map((x: { kind: string }) => x.kind).sort()).toEqual(["review.assigned", "review.completed"]);
    expect((await semih.get("/notifications/count")).body.unread).toBe(1);
    await aytug.post("/notifications/read-all");
    expect((await aytug.get("/notifications/count")).body.unread).toBe(0);
  });

  it("lets project admins reassign and cancel; reports copy failures by naming standard", async () => {
    const r = await murat.post(`${P()}/reviews`, { name: "İkinci", templateId, versionIds: [versionC] });
    const rid = r.body.id;
    expect((await murat.post(`${P()}/reviews/${rid}/reassign`, { assignees: [{ type: "user", id: ids.aytug }] })).status).toBe(403);
    const re = await admin.post(`${P()}/reviews/${rid}/reassign`, { assignees: [{ type: "user", id: ids.aytug }] });
    expect(re.status).toBe(200);
    expect((await semih.get("/my-tasks")).body).toHaveLength(0);
    expect((await aytug.get("/my-tasks")).body).toHaveLength(1);
    expect((await eve.post(`${P()}/reviews/${rid}/cancel`, {})).status).toBe(404);
    const c = await admin.post(`${P()}/reviews/${rid}/cancel`, { comment: "Yanlış set" });
    expect(c.body.status).toBe("cancelled");
    expect((await aytug.get("/my-tasks")).body).toHaveLength(0);
    // Cancelled reviews don't set an approval status.
    const ap = (await murat.get(`${P()}/folders/${designId}/approvals`)).body;
    expect(ap.find((x: { versionId: string }) => x.versionId === versionC)).toBeUndefined();

    // One-step template for project admins; PUBLISHED requires a naming standard C.pdf fails.
    const std = await admin.post(`${P()}/naming-standards`, {
      name: "WF",
      delimiter: "-",
      fields: [
        { name: "Proje", type: "list", values: [{ code: "WF" }] },
        { name: "Numara", type: "number", digits: 4 },
      ],
    });
    await admin.patch(`${P()}/folders/${publishedId}`, { namingStandardId: std.body.id });
    const quick = await admin.post(`${P()}/workflow-templates`, {
      name: "Hızlı onay",
      steps: [{ name: "Yönetici", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 0, outcomes: ["approved"] }],
    });
    const r3 = await murat.post(`${P()}/reviews`, {
      name: "Yayın",
      templateId: quick.body.id,
      versionIds: [versionC],
      targetFolderId: publishedId,
    });
    expect(r3.body.stepDueAt).toBeNull();
    const rf = r3.body.files[0].id;
    const done = await admin.post(`${P()}/reviews/${r3.body.id}/submit`, { files: [{ reviewFileId: rf, outcome: "approved" }] });
    expect(done.body.status).toBe("completed");
    expect(done.body.files[0].finalStatus).toBe("approved");
    expect(done.body.files[0].copyError).toContain("isimlendirme standardına uymuyor");
    expect((await admin.get(`${P()}/folders/${publishedId}/contents`)).body.files).toHaveLength(0);
    expect((await murat.get("/notifications")).body[0].body).toContain("1 kopyalama başarısız");
  });

  it("lists reviews for participants only", async () => {
    expect((await murat.get(`${P()}/reviews`)).body.map((r: { number: number }) => r.number)).toEqual([3, 2, 1]);
    // Review 2 was reassigned away from CNS, review 3 is for project admins.
    expect((await semih.get(`${P()}/reviews`)).body.map((r: { number: number }) => r.number)).toEqual([1]);
    expect((await eve.get(`${P()}/reviews`)).body).toEqual([]);
    expect((await admin.get(`${P()}/reviews?status=cancelled`)).body.map((r: { number: number }) => r.number)).toEqual([2]);
  });
});
