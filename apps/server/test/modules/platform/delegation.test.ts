// Approval delegation ("vekâlet", issue #190) with the Platform module: the Kabul list of the issue
// against the real module (delegations API, its assignee resolver, notifications) and the core hook.
// Runs when the installed Platform package has the feature (0.4.0 and later).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { cdeParseArgs, cdeResult, cdeToolDefinitions, type CdeCall } from "@sitekeep/cde-tools";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, users, workflowInstances } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { settleNotificationMail } from "../../../src/workflow/notification-mail.js";
import { runDueReminders } from "../../../src/workflow/reminders.js";
import { handOverOpenAssignments } from "../../../src/workflow/delegation.js";
import { todayIso, addDaysIso } from "../../../src/works/service.js";

// Platform 0.4.0 has the delegations (SDK 0.20.0); an older installed package skips this file.
const mod = await import("@sitekeephq/sitekeep-ee-platform/internal/delegation/service.js").catch(() => null);
const hasDelegation = !!mod;

const PW = "Sifre-1234567";
const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const capture = { sendMail: async (m: SendMailOptions) => (sent.push(m), json.sendMail(m)) } as unknown as Transporter;

let handle: DbHandle;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-vekalet-"));
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
    cookie,
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
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

describe.skipIf(!hasDelegation)("approval delegation (Platform)", () => {
  let admin: Client, pm: Client, ayse: Client, bora: Client, cem: Client;
  const ids: Record<string, string> = {};
  let pid: string, pid2: string;
  let sharedId: string, designId: string, secretId: string;
  let versions: string[] = [];
  let templateId: string;
  let delegationId = "";
  const today = todayIso();
  const P = () => `/projects/${pid}`;

  async function startReview(name: string, version: string) {
    const r = await pm.post(`${P()}/reviews`, { name, templateId, versionIds: [version], targetFolderId: sharedId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }
  const answer = (c: Client, rid: string, d: { files: { id: string }[]; stepIndex: number }) =>
    c.post(`${P()}/reviews/${rid}/submit`, { stepIndex: d.stepIndex, files: d.files.map((f) => ({ reviewFileId: f.id, outcome: "approved" })) });

  it("sets up two projects, people, folders and a review template assigned to Ayşe", async () => {
    admin = api(await login("admin@7d.test"));
    pid = (await admin.post("/projects", { code: "TRS", name: "Raylı Sistem" })).body.id;
    pid2 = (await admin.post("/projects", { code: "DGR", name: "Diğer" })).body.id;
    for (const [key, name] of [["pm", "Proje Yöneticisi"], ["ayse", "Ayşe"], ["bora", "Bora"], ["cem", "Cem"]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@vk.test`, name, password: PW })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@vk.test`, isProjectAdmin: key === "pm" })).status).toBe(200);
    }
    expect((await admin.post(`/projects/${pid2}/members`, { email: "ayse@vk.test" })).status).toBe(200);
    pm = api(await login("pm@vk.test"));
    ayse = api(await login("ayse@vk.test"));
    bora = api(await login("bora@vk.test"));
    cem = api(await login("cem@vk.test"));
    const p = (await admin.get(`/projects/${pid}`)).body;
    const top = await admin.get(`${P()}/folders/${p.rootFolderId}/contents`);
    const [wipId, shared] = top.body.folders.map((f: { id: string }) => f.id);
    sharedId = shared;
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarim" })).body.id;
    secretId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Gizli Hesaplar" })).body.id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.pm, level: "edit" }] });
    await admin.put(`${P()}/folders/${designId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids.ayse, level: "view" },
        { subjectType: "user", subjectId: ids.bora, level: "view" },
      ],
    });
    // Ayşe sees "Gizli Hesaplar", Bora does not.
    await admin.put(`${P()}/folders/${secretId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.ayse, level: "view" }] });
    await admin.put(`${P()}/folders/${sharedId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.pm, level: "edit" }] });
    for (const n of ["A", "B", "C", "D", "E", "F"]) expect((await pm.upload(`${P()}/folders/${designId}/files`, `${n}.pdf`, n)).status).toBe(200);
    versions = (await pm.get(`${P()}/folders/${designId}/contents`)).body.files.map((f: { latest: { id: string } }) => f.latest.id);
    const steps = [{ name: "Teknik Onay", assignees: [{ type: "user", id: ids.ayse }], rule: "any", days: 5, outcomes: ["approved", "rejected"] }];
    templateId = (await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "Onay", steps })).body.id;
  });

  it("rules: own delegation; a project admin for a member of their project only; not to oneself", async () => {
    const base = { delegateId: ids.bora, startsOn: today, endsOn: addDaysIso(today, 14) };
    expect((await ayse.post("/delegations", { ...base, delegateId: ids.ayse })).status).toBe(400);
    expect((await ayse.post("/delegations", { ...base, startsOn: addDaysIso(today, 3), endsOn: addDaysIso(today, 1) })).status).toBe(400);
    // Cem is no administrator: not for Ayşe.
    expect((await cem.post("/delegations", { ...base, personId: ids.ayse, projectIds: [pid] })).status).toBe(403);
    // The PM: only with their projects named (Ayşe's other project is not theirs).
    expect((await pm.post("/delegations", { ...base, personId: ids.ayse })).status).toBe(403);
    expect((await pm.post("/delegations", { ...base, personId: ids.ayse, projectIds: [pid2] })).status).toBe(403);
    // Listing a project's delegations: its administrators only.
    expect((await cem.get(`/delegations?projectId=${pid}`)).status).toBe(403);
  });

  it("A delegates to B (today + 14 days): saved with a warning about the folder B cannot see, both notified", async () => {
    const check = await ayse.post("/delegations/check", { delegateId: ids.bora, startsOn: today, endsOn: addDaysIso(today, 14), projectIds: [pid] });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.folders.some((f: string) => f.startsWith("TRS: ") && f.endsWith("Gizli Hesaplar"))).toBe(true);
    expect((await ayse.get("/delegations")).body).toEqual([]); // nothing saved by the check
    const r = await ayse.post("/delegations", { delegateId: ids.bora, startsOn: today, endsOn: addDaysIso(today, 14), projectIds: [pid], note: "Yıllık izin" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    delegationId = r.body.delegation.id;
    expect(r.body.delegation).toMatchObject({ personName: "Ayşe", delegateName: "Bora", status: "active", allProjects: false, canEnd: true });
    expect(r.body.warnings.folders.length).toBeGreaterThan(0);
    // No widening: Bora still cannot open the folder.
    expect((await bora.get(`${P()}/folders/${secretId}/contents`)).status).toBe(404);
    // Start notification to both.
    for (const c of [ayse, bora]) expect((await c.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("delegation.started");
    // Same pair overlapping: refused.
    expect((await ayse.post("/delegations", { delegateId: ids.bora, startsOn: today, endsOn: today, projectIds: [pid] })).status).toBe(409);
    // Listed for both and for the PM of the project.
    expect((await bora.get("/delegations")).body.map((d: { id: string }) => d.id)).toEqual([delegationId]);
    expect((await pm.get(`/delegations?projectId=${pid}`)).body.map((d: { id: string }) => d.id)).toEqual([delegationId]);
    expect((await cem.get(`/delegations/${delegationId}`)).status).toBe(404);
    const logs = await handle.db.select().from(auditLog).where(eq(auditLog.action, "delegation.created"));
    expect(logs).toHaveLength(1);
  });

  let during = "";
  it("Kabul: during the period B approves A's review step; the record says 'A adına B' (history, audit, report)", async () => {
    await settleNotificationMail();
    const from = sent.length;
    during = await startReview("Ray bağlantı detayı", versions[0]!);
    await settleNotificationMail();
    expect(sent.slice(from).map((m) => m.to).sort()).toEqual(["ayse@vk.test", "bora@vk.test"]);
    const tasks = (await bora.get("/my-tasks")).body;
    expect(tasks.map((t: { name: string; onBehalfOf?: { name: string } }) => [t.name, t.onBehalfOf?.name])).toEqual([["Ray bağlantı detayı", "Ayşe"]]);
    const d = (await bora.get(`${P()}/reviews/${during}`)).body;
    const r = await answer(bora, during, d);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.marks[0]).toMatchObject({ userName: "Bora", onBehalfOf: [{ id: ids.ayse, name: "Ayşe", delegated: true }] });
    const [log] = (await handle.db.select().from(auditLog).where(eq(auditLog.action, "review.submitted"))).slice(-1);
    expect(log!.userId).toBe(ids.bora);
    expect(log!.details).toMatchObject({ onBehalfOf: { userId: ids.ayse, name: "Ayşe" } });
    const rep = await pm.post(`${P()}/reports/query`, { queries: [{ id: "s", spec: { dataset: "workflow_steps", fields: ["subject", "onBehalfOf"] } }] });
    expect(rep.body.results.s.find((x: { subject: string }) => x.subject.includes("Ray bağlantı")).onBehalfOf).toBe("Ayşe adına Bora");
  });

  it("both act at once: the first answer wins, the second gets a clear error", async () => {
    const rid = await startReview("Makas", versions[1]!);
    const d = (await ayse.get(`${P()}/reviews/${rid}`)).body;
    const [first, second] = await Promise.all([answer(bora, rid, d), answer(ayse, rid, d)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.message).toMatch(/İnceleme artık açık değil|tamamlandı ya da değişti|sizin adınıza/);
  });

  let open = "";
  it("after the end new steps go to A only; the step from the period stays with B", async () => {
    open = await startReview("Katener", versions[2]!);
    const end = await ayse.post(`/delegations/${delegationId}/end`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(end.body.status).toBe("ended");
    for (const c of [ayse, bora]) expect((await c.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("delegation.ended");
    const after = await startReview("Sinyal", versions[3]!);
    const [i] = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, after));
    expect(i!.stepDelegates).toEqual([]);
    expect((await bora.get("/my-tasks")).body.map((t: { name: string }) => t.name)).toEqual(["Katener"]);
    expect((await bora.post(`/delegations/${delegationId}/end`)).status).toBe(409);
  });

  it("withdrawing an ended-early delegation's open steps is the person's choice (end with withdraw)", async () => {
    const r = await pm.post("/delegations", { personId: ids.ayse, delegateId: ids.cem, startsOn: today, endsOn: today, projectIds: [pid] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rid = await startReview("Enerji", versions[4]!);
    // Katener and Sinyal were already open for Ayşe when this delegation started: handed over to Cem as well.
    expect((await cem.get("/my-tasks")).body.map((t: { name: string }) => t.name).sort()).toEqual(["Enerji", "Katener", "Sinyal"]);
    expect((await pm.post(`/delegations/${r.body.delegation.id}/end`, { withdraw: true })).status).toBe(200);
    expect((await cem.get("/my-tasks")).body).toEqual([]);
    expect((await ayse.get(`${P()}/reviews/${rid}`)).body.canAct).toBe(true);
    // The Katener step from Bora's period is untouched.
    expect((await bora.get(`${P()}/reviews/${open}`)).body.canAct).toBe(true);
  });

  it("period boundaries: 1–15 December covers the 1st and the 15th, not the 30th of November or the 16th", async () => {
    const r = await ayse.post("/delegations", { delegateId: ids.bora, startsOn: "2026-12-01", endsOn: "2026-12-15", projectIds: [pid] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.delegation.status).toBe(today < "2026-12-01" ? "planned" : "active");
    const ask = (at: string, projectId = pid) => mod!.assigneeResolver.delegates({ db: handle.db, projectId, userIds: [ids.ayse!], at: new Date(at) });
    expect(await ask("2026-11-30T23:30:00")).toEqual([]);
    expect(await ask("2026-12-01T00:00:01")).toEqual([{ forUserId: ids.ayse, userId: ids.bora, delegationId: r.body.delegation.id }]);
    expect((await ask("2026-12-15T23:59:00")).length).toBe(1);
    expect(await ask("2026-12-16T00:00:01")).toEqual([]);
    expect(await ask("2026-12-05T10:00:00", pid2)).toEqual([]); // other project: out of scope
    // The reminder round tells both when it starts (once).
    const starts = async () => (await bora.get("/notifications")).body.filter((n: { kind: string }) => n.kind === "delegation.started").length;
    const before = await starts();
    await runDueReminders(handle.db, new Date("2026-12-01T08:00:00"));
    await runDueReminders(handle.db, new Date("2026-12-01T09:00:00"));
    expect(await starts()).toBe(before + 1);
    // The step from Bora's earlier period is overdue by then: the reminder reaches the delegate too.
    expect((await bora.get("/notifications")).body.some((n: { kind: string; title: string }) => n.kind === "review.overdue" && n.title.includes("Ayşe adına"))).toBe(true);
  });

  it("open items before the start: handed over when it becomes active (future start: on that day), scope kept, e-mailed", async () => {
    // A review in the other project, assigned to Ayşe as well; Cem is a member there too.
    expect((await admin.post(`/projects/${pid2}/members`, { email: "cem@vk.test" })).status).toBe(200);
    const p2 = (await admin.get(`/projects/${pid2}`)).body;
    const wip2 = (await admin.get(`/projects/${pid2}/folders/${p2.rootFolderId}/contents`)).body.folders[0].id;
    expect((await admin.upload(`/projects/${pid2}/folders/${wip2}/files`, "Z.pdf", "z")).status).toBe(200);
    const v2 = (await admin.get(`/projects/${pid2}/folders/${wip2}/contents`)).body.files[0].latest.id;
    const steps = [{ name: "Onay", assignees: [{ type: "user", id: ids.ayse }], rule: "any", days: 5, outcomes: ["approved", "rejected"] }];
    const t2 = (await admin.post(`/projects/${pid2}/workflow-templates`, { kind: "review", name: "Onay", steps })).body.id;
    expect((await admin.post(`/projects/${pid2}/reviews`, { name: "Diğer proje", templateId: t2, versionIds: [v2] })).status).toBe(200);
    const before = await startReview("Önceden", versions[5]!);

    // Starts in three days, this project only: nothing yet.
    const summaries = async () => ((await cem.get("/notifications")).body as { kind: string; title: string }[]).filter((n) => n.kind === "delegation.handed_over");
    const earlier = (await summaries()).length;
    await settleNotificationMail();
    const from = sent.length;
    const startsOn = addDaysIso(today, 3);
    const r = await ayse.post("/delegations", { delegateId: ids.cem, startsOn, endsOn: addDaysIso(today, 5), projectIds: [pid] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.delegation.status).toBe("planned");
    expect((await cem.get("/my-tasks")).body).toEqual([]);
    expect((await answer(cem, before, (await ayse.get(`${P()}/reviews/${before}`)).body)).status).toBe(404);

    // Its first day: the open steps of this project go to Cem as well, with one summary.
    await runDueReminders(handle.db, new Date(`${startsOn}T08:00:00`));
    await settleNotificationMail();
    const tasks = (await cem.get("/my-tasks")).body as { name: string; projectCode: string; onBehalfOf?: { name: string } }[];
    expect(tasks.map((t) => t.name)).toContain("Önceden");
    expect(tasks.every((t) => t.projectCode === "TRS" && t.onBehalfOf?.name === "Ayşe")).toBe(true);
    const summary = await summaries();
    expect(summary).toHaveLength(earlier + 1);
    expect(summary[0]!.title).toContain(`açık ${tasks.length} kaydı`);
    // E-mails (type "delegation"): the start to both, the summary to Cem, with the Delegations page link.
    const mails = sent.slice(from);
    expect(mails.filter((m) => m.to === "cem@vk.test").map((m) => String(m.subject))).toEqual(
      expect.arrayContaining([expect.stringContaining("Vekâlet başladı"), expect.stringContaining("vekâleten size de verildi")]),
    );
    expect(mails.some((m) => m.to === "ayse@vk.test" && String(m.subject).includes("Vekâlet başladı"))).toBe(true);
    expect(String(mails.find((m) => m.to === "cem@vk.test")!.text)).toContain(`https://cde.example.test/projects/${pid}/delegations`);
    // Cem acts for Ayşe on the step that was open before.
    const d = (await cem.get(`${P()}/reviews/${before}`)).body;
    expect(d.actingFor[0]).toMatchObject({ id: ids.ayse, delegated: true });
    expect((await answer(cem, before, d)).status).toBe(200);
    // Idempotent: a second hand-over adds nothing; another round sends no second summary.
    expect(await handOverOpenAssignments(handle.db, { forUserId: ids.ayse!, userId: ids.cem!, delegationId: r.body.delegation.id }, [pid])).toMatchObject({ steps: 0, works: 0 });
    await runDueReminders(handle.db, new Date(`${startsOn}T09:00:00`));
    expect(await summaries()).toHaveLength(earlier + 1);
    // Ended with withdraw: the handed-over steps are Ayşe's alone again.
    expect((await ayse.post(`/delegations/${r.body.delegation.id}/end`, { withdraw: true })).status).toBe(200);
    expect((await cem.get("/my-tasks")).body).toEqual([]);
  });

  it("e-mail preference: the delegation type can be turned off per person", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/me/prefs", headers: { cookie: bora.cookie }, payload: { emailNotifications: { delegation: false } } });
    expect(res.statusCode, res.body).toBe(200);
    await settleNotificationMail();
    const from = sent.length;
    const r = await bora.post("/delegations", { delegateId: ids.cem, startsOn: today, endsOn: today, projectIds: [pid] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await settleNotificationMail();
    expect(sent.slice(from).map((m) => m.to)).toEqual(["cem@vk.test"]);
    expect((await bora.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("delegation.started");
  });

  it("MCP: create, list and end", async () => {
    const call: CdeCall = async <T,>(method: string, url: string, body?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie: cem.cookie }, payload: body as object });
      return cdeResult<T>(res.statusCode, res.body, false);
    };
    const defs = new Map(cdeToolDefinitions(call).map((d) => [d.name, d]));
    const run = (name: string, args: Record<string, unknown>) => defs.get(name)!.run(cdeParseArgs(defs.get(name)!, args)) as Promise<any>;
    const made = await run("cde_delegation_create", { delegateId: ids.bora, startsOn: today, endsOn: addDaysIso(today, 2), projectIds: [pid] });
    expect(made.delegation).toMatchObject({ person: "Cem", delegate: "Bora", status: "active", projects: ["TRS"] });
    const list = await run("cde_delegations_list", { status: "active" });
    expect(list.filter((d: any) => d.person === "Cem").map((d: any) => d.id)).toEqual([made.delegation.id]);
    const ended = await run("cde_delegation_end", { delegationId: made.delegation.id });
    expect(ended.status).toBe("ended");
    // Read-only connections do not offer the write tools.
    const ro = cdeToolDefinitions(call, { readOnly: true }).map((d) => d.name);
    expect(ro).toContain("cde_delegations_list");
    expect(ro).not.toContain("cde_delegation_create");
  });
});
