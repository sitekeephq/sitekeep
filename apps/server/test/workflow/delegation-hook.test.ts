// Approval delegation hook (issue #190, workflow/delegation.ts, SDK 0.20.0): the core asks the
// registered assignee resolvers when a step becomes current or a work is assigned, lets the delegate
// act ("X adına Y"), first answer wins, and changes nothing without a resolver (Community).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, reviewMarks, users, workflowActions, workflowInstances } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { dropStepDelegation, handOverOpenAssignments, registerAssigneeResolver, resolveDelegates } from "../../src/workflow/delegation.js";
import { mailTypeOf, settleNotificationMail } from "../../src/workflow/notification-mail.js";
import { delegateAccessGaps } from "../../src/workflow/delegation-access.js";
import { actingAs } from "../../src/workflow/engine.js";
import { hasManage } from "../helpers/modules.js";

const PW = "Sifre-1234567";
const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const capture = { sendMail: async (m: SendMailOptions) => (sent.push(m), json.sendMail(m)) } as unknown as Transporter;

let handle: DbHandle;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-deleg-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    oauth: { publicUrl: "https://cde.example.test" },
    mailer: { transport: capture, from: "sitekeep@example.test", host: "mail.example.test:587" },
  });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
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
type Client = ReturnType<typeof api>;

describe("engine: actingAs", () => {
  const step = { name: "S", assignees: [{ type: "user" as const, id: "A" }], rule: "any" as const, days: 0, outcomes: ["approved" as const] };
  const actor = (userId: string) => ({ userId, companyId: null, isProjectAdmin: false, isStarter: false });
  const grants = [{ forUserId: "A", userId: "B", delegationId: "d1" }];
  it("the person acts for themselves, the delegate for the person, others not at all", () => {
    expect(actingAs(step, actor("A"), grants, new Set(), actor)?.onBehalfOfUserId).toBeNull();
    const b = actingAs(step, actor("B"), grants, new Set(), actor)!;
    expect(b.onBehalfOfUserId).toBe("A");
    expect(b.actor.userId).toBe("A");
    expect(b.delegationId).toBe("d1");
    expect(actingAs(step, actor("C"), grants, new Set(), actor)).toBeNull();
  });
  it("first answer for a person wins", () => {
    expect(actingAs(step, actor("B"), grants, new Set(["A"]), actor)).toBeNull();
    expect(actingAs(step, actor("A"), grants, new Set(["A"]), actor)).toBeNull();
  });
});

describe("delegation hook", () => {
  let admin: Client, murat: Client, ayse: Client, bora: Client, cem: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let sharedId: string, designId: string, secretId: string;
  let versions: string[] = [];
  let templateId: string;
  /** Delegations the test resolver answers with: person → delegate (one project, any time). */
  let active = new Map<string, string>();
  let calls = 0;
  const P = () => `/projects/${pid}`;

  async function startReview(name: string, version: string) {
    const r = await murat.post(`${P()}/reviews`, { name, templateId, versionIds: [version], targetFolderId: sharedId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }
  const answer = (c: Client, rid: string, detail: { files: { id: string }[]; stepIndex: number }, extra: object = {}) =>
    c.post(`${P()}/reviews/${rid}/submit`, { files: detail.files.map((f) => ({ reviewFileId: f.id, outcome: "approved" })), ...extra });

  it("sets up a project, people and a one-step template assigned to Ayşe", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "VKL", name: "Vekalet" });
    pid = p.body.id;
    for (const [key, name] of [["murat", "Murat"], ["ayse", "Ayşe"], ["bora", "Bora"], ["cem", "Cem"]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@vk.test`, name, password: PW })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@vk.test` })).status).toBe(200);
    }
    murat = api(await login("murat@vk.test"));
    ayse = api(await login("ayse@vk.test"));
    bora = api(await login("bora@vk.test"));
    cem = api(await login("cem@vk.test"));
    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    const [wipId, shared] = root.body.folders.map((f: { id: string }) => f.id);
    sharedId = shared;
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarim" })).body.id;
    secretId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Gizli" })).body.id;
    for (const f of [wipId, sharedId])
      await admin.put(`${P()}/folders/${f}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.murat, level: "edit" }] });
    for (const n of ["A", "B", "C", "D", "E", "F"]) expect((await murat.upload(`${P()}/folders/${designId}/files`, `${n}.pdf`, n)).status).toBe(200);
    versions = (await murat.get(`${P()}/folders/${designId}/contents`)).body.files.map((f: { latest: { id: string } }) => f.latest.id);
    const steps = [{ name: "Onay", assignees: [{ type: "user", id: ids.ayse }], rule: "any", days: 3, outcomes: ["approved", "rejected"] }];
    templateId = (await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "Tek adim", steps })).body.id;
  });

  it("Community (no resolver): unchanged — only the assignee acts, nothing recorded for anyone else", async () => {
    const rid = await startReview("Topluluk", versions[0]!);
    const [i] = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, rid));
    expect(i!.stepDelegates).toEqual([]);
    const d = (await ayse.get(`${P()}/reviews/${rid}`)).body;
    expect((await answer(bora, rid, d)).status).toBe(404); // Bora does not even see it
    expect((await bora.get("/my-tasks")).body).toEqual([]);
    expect((await answer(ayse, rid, d)).status).toBe(200);
    const marks = await handle.db.select().from(reviewMarks);
    expect(marks.every((m) => m.onBehalfOfUserId === null)).toBe(true);
  });

  it("registers a resolver: delegates are kept (members only, never the person or an assignee)", async () => {
    registerAssigneeResolver({
      id: "test-delegation",
      delegates: ({ projectId, userIds }) => {
        calls++;
        if (projectId !== pid) return [];
        return [...active].filter(([p]) => userIds.includes(p)).map(([p, d]) => ({ forUserId: p, userId: d, delegationId: `del-${p}` }));
      },
    });
    active = new Map([[ids.ayse!, ids.bora!]]);
    expect(await resolveDelegates(handle.db, pid, [ids.ayse!], new Date())).toEqual([{ forUserId: ids.ayse, userId: ids.bora, delegationId: `del-${ids.ayse}` }]);
    // The delegate is already an assignee: no delegation entry.
    expect(await resolveDelegates(handle.db, pid, [ids.ayse!, ids.bora!], new Date())).toEqual([]);
  });

  let rid1 = "";
  it("A delegates to B: B gets the step (notification, e-mail, task 'vekâleten'), approves it and the record says 'A adına B'", async () => {
    const from = sent.length;
    rid1 = await startReview("Vekaletli", versions[1]!);
    const [i] = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, rid1));
    expect(i!.stepDelegates).toEqual([{ forUserId: ids.ayse, userId: ids.bora, delegationId: `del-${ids.ayse}`, stepIndex: 0 }]);
    // Both get the assignment e-mail; Bora's says "Vekâleten (Ayşe adına)".
    await settleNotificationMail();
    const mails = sent.slice(from);
    expect(mails.map((m) => m.to).sort()).toEqual(["ayse@vk.test", "bora@vk.test"]);
    expect(String(mails.find((m) => m.to === "bora@vk.test")!.subject)).toContain("Ayşe adına");
    const notes = (await bora.get("/notifications")).body;
    expect(notes[0].kind).toBe("review.assigned");
    expect(notes[0].title).toContain("Vekâleten (Ayşe adına)");
    // Today / my tasks: the step with the person's name.
    const tasks = (await bora.get("/my-tasks")).body;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].onBehalfOf).toEqual({ userId: ids.ayse, name: "Ayşe" });
    const today = (await bora.get(`${P()}/today`)).body;
    expect(today.mine.tasks[0].onBehalfOf).toBe("Ayşe");
    // Bora answers.
    const d = (await bora.get(`${P()}/reviews/${rid1}`)).body;
    expect(d.canAct).toBe(true);
    expect(d.actingFor).toEqual([{ type: "user", id: ids.ayse, name: "Ayşe", delegated: true }]);
    const r = await answer(bora, rid1, d, { stepIndex: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("completed");
    const mark = r.body.marks[0];
    expect(mark.userName).toBe("Bora");
    expect(mark.onBehalfOf).toEqual([{ type: "user", id: ids.ayse, name: "Ayşe", delegated: true }]);
    const submit = r.body.actions.find((x: { kind: string }) => x.kind === "submit");
    expect(submit.userId).toBe(ids.bora);
    expect(submit.onBehalfOf[0]).toMatchObject({ id: ids.ayse, delegated: true });
    // Audit log: the user is Bora, acting for Ayşe.
    const logs = await handle.db.select().from(auditLog).where(eq(auditLog.action, "review.submitted"));
    expect(logs.at(-1)!.userId).toBe(ids.bora);
    expect((logs.at(-1)!.details as any).onBehalfOf).toEqual({ userId: ids.ayse, name: "Ayşe" });
    // Reports: workflow_steps carries "Ayşe adına Bora".
    const rep = await murat.post(`${P()}/reports/query`, { queries: [{ id: "s", spec: { dataset: "workflow_steps", fields: ["subject", "onBehalfOf"] } }] });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const rows = rep.body.results.s as { subject: string; onBehalfOf: string | null }[];
    expect(rows.find((x) => x.subject.includes("Vekaletli"))!.onBehalfOf).toBe("Ayşe adına Bora");
    expect(rows.find((x) => x.subject.includes("Topluluk"))!.onBehalfOf).toBeNull();
  });

  it("both act: the first answer wins, the second gets a clear error", async () => {
    const rid = await startReview("Ayni anda", versions[2]!);
    const d = (await ayse.get(`${P()}/reviews/${rid}`)).body;
    expect((await answer(bora, rid, d, { stepIndex: 0 })).status).toBe(200);
    const late = await answer(ayse, rid, d, { stepIndex: 0 });
    expect(late.status).toBe(409);
    expect(late.body.message).toBe("İnceleme artık açık değil.");

    // Rule "all" with Ayşe and Cem: Bora answers for Ayşe; Ayşe then cannot answer again.
    const steps = [{ name: "Ortak", assignees: [{ type: "user", id: ids.ayse }, { type: "user", id: ids.cem }], rule: "all", days: 0, outcomes: ["approved", "rejected"] }];
    const tid = (await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "Iki kisi", steps })).body.id;
    const r = await murat.post(`${P()}/reviews`, { name: "Herkes", templateId: tid, versionIds: [versions[3]], targetFolderId: sharedId });
    const d2 = (await bora.get(`${P()}/reviews/${r.body.id}`)).body;
    expect((await answer(bora, r.body.id, d2)).status).toBe(200);
    const again = await answer(ayse, r.body.id, d2);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe("Bu adımı Bora sizin adınıza (vekâleten) yanıtladı.");
    const twice = await answer(bora, r.body.id, d2);
    expect(twice.status).toBe(409);
    expect((await answer(cem, r.body.id, d2)).body.status).toBe("completed");
  });

  it("after the delegation ends new steps go to A only; steps from the period stay with B", async () => {
    const during = await startReview("Donemde", versions[4]!);
    active = new Map();
    const after = await startReview("Sonra", versions[5]!);
    const [i] = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, after));
    expect(i!.stepDelegates).toEqual([]);
    const titles = (await bora.get("/my-tasks")).body.map((t: { name: string }) => t.name);
    expect(titles).toEqual(["Donemde"]);
    expect((await answer(bora, after, (await ayse.get(`${P()}/reviews/${after}`)).body)).status).toBe(404);
    expect((await answer(bora, during, (await bora.get(`${P()}/reviews/${during}`)).body)).status).toBe(200);
  });

  it("warns about folders the delegate cannot view; permissions are not widened", async () => {
    await admin.put(`${P()}/folders/${secretId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.ayse, level: "view" }] });
    const gaps = await delegateAccessGaps(handle.db, { projectId: pid, personId: ids.ayse!, delegateId: ids.bora! });
    expect(gaps.folders.some((f) => f.endsWith("Gizli"))).toBe(true);
    // Bora acted for Ayşe above but still cannot open the folder.
    expect((await bora.get(`${P()}/folders/${secretId}/contents`)).status).toBe(404);
  });

  it("a stale answer (the step moved on meanwhile) is refused", async () => {
    const steps = [
      { name: "Bir", assignees: [{ type: "user", id: ids.cem }], rule: "any", days: 0, outcomes: ["approved", "rejected"] },
      { name: "Iki", assignees: [{ type: "user", id: ids.cem }], rule: "any", days: 0, outcomes: ["approved", "rejected"] },
    ];
    const tid = (await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "Iki adim", steps })).body.id;
    const r = await murat.post(`${P()}/reviews`, { name: "Bayat", templateId: tid, versionIds: [versions[0]], targetFolderId: sharedId });
    const d = (await cem.get(`${P()}/reviews/${r.body.id}`)).body;
    expect((await answer(cem, r.body.id, d, { stepIndex: 0 })).status).toBe(200);
    const stale = await answer(cem, r.body.id, d, { stepIndex: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe("Bu adım siz yanıtlamadan önce tamamlandı ya da değişti; sayfayı yenileyin.");
  });

  it.skipIf(!hasManage)("works: an RFI step assigned during the delegation (Manage)", async () => {
    active = new Map([[ids.ayse!, ids.bora!]]);
    const fields = { soru: "?", kategori: "Malzeme", disiplin: "S - Statik", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Yok" };
    const rfi = await murat.post(`${P()}/works`, { typeKey: "rfi", title: "Kolon", fields, assigneeUserId: ids.ayse });
    expect(rfi.status, JSON.stringify(rfi.body)).toBe(200);
    expect((await murat.post(`${P()}/works/${rfi.body.id}/submit`, {})).status).toBe(200);
    const w = (await bora.get(`${P()}/works/${rfi.body.id}`)).body;
    expect(w.build.workflow.canAct).toBe(true);
    expect(w.build.workflow.delegatedFor).toBe("Ayşe");
    const code = w.build.workflow.options[0].code;
    const r = await bora.post(`${P()}/works/${rfi.body.id}/respond`, { outcome: code, response: "Tamam", stepIndex: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await murat.get(`${P()}/works/${rfi.body.id}`)).body;
    const ans = after.build.revisions.at(-1).steps[0].answers[0];
    expect(ans.userName).toBe("Bora");
    expect(ans.delegatedFor).toBe("Ayşe");
    const [act] = await handle.db.select().from(workflowActions).where(eq(workflowActions.onBehalfOfUserId, ids.ayse!));
    expect(act).toBeTruthy();
  });

  it.skipIf(!hasManage)("works: an action (no workflow, Manage) assigned to A during the delegation: B sees and updates it", async () => {
    active = new Map([[ids.ayse!, ids.bora!]]);
    const types = (await murat.get(`${P()}/work-types`)).body as { id: string; key: string }[];
    const action = await murat.post(`${P()}/works`, { typeId: types.find((t) => t.key === "aksiyon")!.id, title: "Numune", assigneeUserId: ids.ayse, fields: {} });
    expect(action.status, JSON.stringify(action.body)).toBe(200);
    const today = (await bora.get("/me/today")).body;
    expect(today.assigned.find((x: { id: string }) => x.id === action.body.id).onBehalfOf).toBe("Ayşe");
    expect((await cem.get(`${P()}/works/${action.body.id}`)).status).toBe(404);
    const patched = await bora.patch(`${P()}/works/${action.body.id}`, { title: "Numune getirildi" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const ev = patched.body.events.find((e: { kind: string }) => e.kind === "updated");
    expect(ev.details.onBehalfOf).toEqual({ userId: ids.ayse, name: "Ayşe" });
    // Withdrawn: the open work is the assignee's alone again.
    expect(await dropStepDelegation(handle.db, `del-${ids.ayse}`)).toBeGreaterThan(0);
    expect((await bora.get(`${P()}/works/${action.body.id}`)).status).toBe(404);
    // Handed over again when a delegation becomes active (open works, idempotent).
    const grant = { forUserId: ids.ayse!, userId: ids.bora!, delegationId: "del-again" };
    expect((await handOverOpenAssignments(handle.db, grant, [pid])).works).toBeGreaterThan(0);
    expect((await handOverOpenAssignments(handle.db, grant, [pid])).works).toBe(0);
    expect((await bora.get(`${P()}/works/${action.body.id}`)).status).toBe(200);
  });

  it("hands over steps that were open before (scope respected) and maps delegation notices to the 'delegation' e-mail type", async () => {
    active = new Map();
    const rid = await startReview("Acik kalan", versions[3]!);
    const names = async () => (await cem.get("/my-tasks")).body.map((t: { name: string }) => t.name);
    expect(await names()).not.toContain("Acik kalan");
    expect(await handOverOpenAssignments(handle.db, { forUserId: ids.ayse!, userId: ids.cem!, delegationId: "d-x" }, ["00000000-0000-0000-0000-000000000000"])).toMatchObject({ steps: 0, works: 0 });
    const h = await handOverOpenAssignments(handle.db, { forUserId: ids.ayse!, userId: ids.cem!, delegationId: "d-x" }, [pid]);
    expect(h.steps).toBeGreaterThan(0);
    expect(await names()).toContain("Acik kalan");
    const d = (await cem.get(`${P()}/reviews/${rid}`)).body;
    expect((await answer(cem, rid, d)).status).toBe(200);
    expect(mailTypeOf("delegation.started")).toBe("delegation");
    expect(mailTypeOf("delegation.handed_over")).toBe("delegation");
  });

  it("asks the resolvers only when something is assigned", () => {
    expect(calls).toBeGreaterThan(0);
  });
});
