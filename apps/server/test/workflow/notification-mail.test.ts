// Workflow e-mail (docs/features/WORKFLOW_EMAIL.md, issue #189): who is mailed when a review starts,
// a step is overdue or a review ends; preferences (user, project default); the outbound registry;
// a failing SMTP server; and the SDK notification channel hook.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { outboundLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { runDueReminders } from "../../src/workflow/reminders.js";
import { mailTypeOf, registerNotificationChannel, settleNotificationMail, type NotificationEvent } from "../../src/workflow/notification-mail.js";

const PW = "Sifre-1234567";
const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
let failSending = false;
const capture = {
  sendMail: async (m: SendMailOptions) => {
    if (failSending) throw new Error("smtp down");
    sent.push(m);
    return json.sendMail(m);
  },
} as unknown as Transporter;

let handle: DbHandle;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-wfmail-"));
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
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null, raw: res };
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

/** Mails to an address since `from`, after the background sending settled. */
async function mailsTo(email: string, from = 0): Promise<SendMailOptions[]> {
  await settleNotificationMail();
  return sent.slice(from).filter((m) => m.to === email);
}

describe("workflow e-mail", () => {
  let admin: Client, murat: Client, semih: Client, aytug: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let designId: string, sharedId: string;
  let templateId: string;
  let versions: string[] = [];
  let reviewId = "";
  const P = () => `/projects/${pid}`;

  async function startReview(name: string, version: string) {
    const r = await murat.post(`${P()}/reviews`, { name, templateId, versionIds: [version], targetFolderId: sharedId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }

  it("maps the notification kinds to the preference types", () => {
    expect(mailTypeOf("review.assigned")).toBe("assigned");
    expect(mailTypeOf("work.sent")).toBe("assigned");
    expect(mailTypeOf("review.overdue")).toBe("overdue");
    expect(mailTypeOf("work.due_soon")).toBe("due_soon");
    expect(mailTypeOf("review.completed")).toBe("outcome");
    expect(mailTypeOf("review.step_completed")).toBeNull();
  });

  it("sets up a project, a two-step template and uploads", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "WFM", name: "Mail testi" });
    pid = p.body.id;
    for (const [key, name] of [["murat", "Murat"], ["semih", "Semih"], ["aytug", "Aytug"]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@wf.test`, name, password: PW })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@wf.test` })).status).toBe(200);
    }
    murat = api(await login("murat@wf.test"));
    semih = api(await login("semih@wf.test"));
    aytug = api(await login("aytug@wf.test"));
    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    const [wipId, shared] = root.body.folders.map((f: { id: string }) => f.id);
    sharedId = shared;
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarim" })).body.id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.murat, level: "edit" }] });
    await admin.put(`${P()}/folders/${sharedId}/permissions`, { entries: [{ subjectType: "user", subjectId: ids.murat, level: "edit" }] });
    for (const n of ["A", "B", "C", "D"]) expect((await murat.upload(`${P()}/folders/${designId}/files`, `${n}.pdf`, `${n} icerik`)).status).toBe(200);
    const files = (await murat.get(`${P()}/folders/${designId}/contents`)).body.files;
    versions = files.map((f: { latest: { id: string } }) => f.latest.id);
    const steps = [
      { name: "Birinci", assignees: [{ type: "user", id: ids.semih }], rule: "any", days: 2, outcomes: ["approved", "rejected"] },
      { name: "Ikinci", assignees: [{ type: "user", id: ids.aytug }], rule: "any", days: 2, outcomes: ["approved", "rejected"] },
    ];
    templateId = (await admin.post(`${P()}/workflow-templates`, { kind: "review", name: "Iki adim", steps })).body.id;
    // Semih reads his mail in Turkish.
    expect((await semih.patch("/me/prefs", { language: "tr" })).status).toBe(200);
  });

  it("mails the first step's assignee when a review starts (not the starter), with link, project code and due date", async () => {
    const from = sent.length;
    reviewId = await startReview("Mimari set", versions[0]!);
    const mails = await mailsTo("semih@wf.test", from);
    expect(mails).toHaveLength(1);
    expect(sent.slice(from)).toHaveLength(1); // nobody else, the starter included
    const m = mails[0]!;
    expect(m.from).toBe("sitekeep@example.test");
    expect(String(m.subject)).toMatch(/^\[WFM\] /);
    const text = String(m.text);
    expect(text).toContain(`https://cde.example.test/projects/${pid}/reviews/${reviewId}`);
    expect(text).toContain("Proje: WFM"); // Turkish template (profile language)
    expect(text).toContain("Termin:");
    // The in-app notification is still written.
    expect((await semih.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("review.assigned");
    // The outbound registry has the row (no content, no address).
    const rows = await handle.db.select().from(outboundLog).where(eq(outboundLog.connection, "smtp"));
    expect(rows.some((r) => r.host === "mail.example.test:587" && (r.details as any)?.kind === "workflow_notification" && (r.details as any)?.type === "assigned")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("semih@wf.test");
  });

  it("respects the user's choice and the project default (user beats project)", async () => {
    // Aytug turned "assigned" off: the next step moves to him without a mail, but with the in-app row.
    expect((await aytug.patch("/me/prefs", { emailNotifications: { assigned: false } })).status).toBe(200);
    const detail = (await semih.get(`${P()}/reviews/${reviewId}`)).body;
    const from = sent.length;
    const r = await semih.post(`${P()}/reviews/${reviewId}/submit`, { files: detail.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" })) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await mailsTo("aytug@wf.test", from)).toHaveLength(0);
    expect((await aytug.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("review.assigned");

    // Project default: only administrators set it, and it applies to members without a choice.
    expect((await murat.put(`${P()}/email-notifications`, { assigned: false })).status).toBe(403);
    expect((await admin.put(`${P()}/email-notifications`, { assigned: false })).body).toEqual({ assigned: false });
    expect((await murat.get(`${P()}/email-notifications`)).body).toEqual({ assigned: false });
    const from2 = sent.length;
    await startReview("Statik set", versions[1]!);
    expect(await mailsTo("semih@wf.test", from2)).toHaveLength(0);
    // Semih's own choice wins over the project default.
    expect((await semih.patch("/me/prefs", { emailNotifications: { assigned: true } })).body.emailNotifications).toEqual({ assigned: true });
    const from3 = sent.length;
    await startReview("Elektrik set", versions[2]!);
    expect(await mailsTo("semih@wf.test", from3)).toHaveLength(1);
    expect((await admin.put(`${P()}/email-notifications`, { assigned: true })).body).toEqual({ assigned: true });
  });

  it("mails an overdue step once (assignee and starter), and 'due soon' once", async () => {
    const now = Date.now();
    const from = sent.length;
    // Review 1 is at Aytug's step (due in 2 days): one day before the due date -> "due soon".
    const r1 = await runDueReminders(handle.db, new Date(now + 1.5 * 86_400_000));
    expect(r1.dueSoon).toBeGreaterThan(0);
    await settleNotificationMail();
    const soon = sent.slice(from).filter((m) => m.to === "aytug@wf.test");
    expect(soon).toHaveLength(1);
    expect(String(soon[0]!.text)).toContain("Proje: WFM");
    const from2 = sent.length;
    const r2 = await runDueReminders(handle.db, new Date(now + 5 * 86_400_000));
    expect(r2.overdue).toBeGreaterThan(0);
    await settleNotificationMail();
    expect(sent.slice(from2).filter((m) => m.to === "aytug@wf.test")).toHaveLength(1); // review 1's overdue
    expect(sent.slice(from2).filter((m) => m.to === "murat@wf.test").length).toBeGreaterThan(0); // starter gets overdue
    const after = sent.length;
    expect(await runDueReminders(handle.db, new Date(now + 6 * 86_400_000))).toEqual({ dueSoon: 0, overdue: 0 });
    await settleNotificationMail();
    expect(sent).toHaveLength(after);
  });

  it("mails the review outcome to the initiator, not to the person who decided", async () => {
    const detail = (await aytug.get(`${P()}/reviews/${reviewId}`)).body;
    const from = sent.length;
    const r = await aytug.post(`${P()}/reviews/${reviewId}/submit`, { files: detail.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" })) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mine = await mailsTo("murat@wf.test", from);
    expect(mine).toHaveLength(1);
    expect(String(mine[0]!.subject)).toContain("[WFM]");
    expect(await mailsTo("aytug@wf.test", from)).toHaveLength(0);
  });

  it("sends nothing while SMTP is switched off in the Privacy Centre, and again after switching it on", async () => {
    expect((await admin.put("/admin/privacy/connections/smtp", { enabled: false })).status).toBe(200);
    const from = sent.length;
    await startReview("Peyzaj set", versions[3]!);
    await settleNotificationMail();
    expect(sent).toHaveLength(from);
    expect((await admin.put("/admin/privacy/connections/smtp", { enabled: true })).status).toBe(200);
  });

  it("does not break the step when sending fails; it is only logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failSending = true;
    try {
      const from = sent.length;
      const id = await startReview("Hata set", versions[0]!);
      await settleNotificationMail();
      expect(sent).toHaveLength(from);
      expect((await murat.get(`${P()}/reviews/${id}`)).body).toMatchObject({ status: "running", stepName: "Birinci" });
      expect((await semih.get("/notifications")).body.some((n: { title: string }) => n.title.includes("Hata set"))).toBe(true);
      expect(log).toHaveBeenCalled();
    } finally {
      failSending = false;
      log.mockRestore();
    }
  });

  it("gives the same event to channels modules register (SDK hook); a channel can claim a person", async () => {
    const seen: NotificationEvent[] = [];
    const off = registerNotificationChannel({
      id: "test-digest",
      claims: (r) => r.name === "Semih", // Semih chose a digest: no immediate mail
      deliver: (e) => void seen.push(e),
    });
    try {
      expect(() => registerNotificationChannel({ id: "test-digest", deliver: () => undefined })).toThrow(/already registered/);
      const from = sent.length;
      await startReview("Kanal seti", versions[1]!);
      await settleNotificationMail();
      expect(seen).toHaveLength(1);
      const e = seen[0]!;
      expect(e).toMatchObject({ kind: "review.assigned", type: "assigned", projectId: pid, projectCode: "WFM" });
      expect(e.url).toContain(`/projects/${pid}/reviews/`);
      expect(e.dueDate).toBeTruthy();
      expect(e.recipients.map((r) => r.name)).toEqual(["Semih"]);
      expect(e.recipients[0]).toMatchObject({ language: "tr", emailEnabled: true });
      expect(e.text("en").title).toContain("Kanal seti");
      expect(sent).toHaveLength(from); // claimed: the core did not mail Semih
    } finally {
      off();
    }
    const from = sent.length;
    await startReview("Kanalsiz", versions[2]!);
    expect(await mailsTo("semih@wf.test", from)).toHaveLength(1); // channel removed: mail again
  });
});
