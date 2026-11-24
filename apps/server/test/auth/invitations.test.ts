// Invitations of people without an account (docs/features/INVITATIONS.md): invite from the project
// members screen and from the set-up wizard, the accept page (password or Google), expiry, single
// use, revoke, resend, who may invite, no e-mail while SMTP is switched off, audit, people files.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, invitations, memberRoles, projectMembers, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { writeXlsx } from "../../src/core/formats/xlsx.js";

const PW = "Sifre-1234567";
const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const capture = {
  sendMail: async (m: SendMailOptions) => {
    sent.push(m);
    return json.sendMail(m);
  },
} as unknown as Transporter;

interface Ctx {
  app: FastifyInstance;
  handle: DbHandle;
  dir: string;
}

async function start(opts: { mailer?: boolean; google?: boolean } = {}): Promise<Ctx> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-invite-"));
  const handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  const app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    oauth: { publicUrl: "https://cde.example.test" },
    ...(opts.mailer ? { mailer: { transport: capture, from: "cde@7d.test" } } : {}),
    ...(opts.google
      ? { googleAuth: { clientId: "google-client", clientSecret: "google-secret", callbackUrl: "http://localhost/api/v1/auth/google/callback" } }
      : {}),
  });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash, isAdmin: true },
    { email: "padmin@7d.test", name: "Project Admin", passwordHash },
    { email: "member@7d.test", name: "Member", passwordHash },
    { email: "existing@7d.test", name: "Existing", passwordHash },
    { email: "off@7d.test", name: "Switched Off", passwordHash, disabled: true },
  ]);
  return { app, handle, dir };
}

async function stop(c: Ctx) {
  await c.app.close();
  await c.handle.close();
  rmSync(c.dir, { recursive: true, force: true });
}

function client(app: FastifyInstance, cookie?: string) {
  const call = async (method: string, url: string, payload?: unknown, lang = "en") => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      headers: { ...(cookie ? { cookie } : {}), "accept-language": lang },
      payload: payload as object,
    });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null, cookies: res.cookies };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown, lang?: string) => call("POST", u, p ?? {}, lang),
    put: (u: string, p?: unknown) => call("PUT", u, p ?? {}),
    del: (u: string) => call("DELETE", u),
  };
}

async function login(app: FastifyInstance, email: string, password = PW) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return client(app, `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`);
}

const tokenOf = (url: string) => url.slice(url.indexOf("#") + 1);
const actions = async (c: Ctx) => (await c.handle.db.select().from(auditLog)).map((r) => r.action);

describe("invitations from the project members screen (no SMTP)", () => {
  let c: Ctx;
  let admin: Awaited<ReturnType<typeof login>>;
  let pid: string;
  let companyId: string;

  beforeAll(async () => {
    c = await start();
    admin = await login(c.app, "admin@7d.test");
    pid = (await admin.post("/projects", { code: "INV", name: "Invite Project" })).body.id;
    companyId = (await admin.post("/companies", { name: "Guest Co" })).body.id;
    const [padmin] = await c.handle.db.select().from(users).where(eq(users.email, "padmin@7d.test"));
    expect((await admin.post(`/projects/${pid}/members`, { email: "padmin@7d.test", isProjectAdmin: true })).status).toBe(200);
    expect((await admin.post(`/projects/${pid}/members`, { email: "member@7d.test" })).status).toBe(200);
    expect(padmin).toBeTruthy();
  });
  afterAll(() => stop(c));

  it("invites an address without an account: pending user, membership, link for the inviter, audit", async () => {
    const roles = (await admin.get(`/projects/${pid}/roles`)).body as { id: string; name: string; kind: string }[];
    const role = roles.find((r) => r.kind !== "task_team")!;
    const res = await admin.post(`/projects/${pid}/invitations`, {
      email: "New.Person@Example.com",
      name: "New Person",
      companyId,
      roleIds: [role.id],
      language: "tr",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("invited");
    expect(res.body.invitation.mailed).toBe(false);
    expect(res.body.invitation.mailSkipped).toBe("smtp_not_configured");
    expect(res.body.invitation.url).toMatch(/^https:\/\/cde\.example\.test\/invite#sitekeep_invite_/);

    const [user] = await c.handle.db.select().from(users).where(eq(users.email, "new.person@example.com"));
    expect(user).toMatchObject({ pending: true, disabled: true, name: "New Person", companyId });
    const [membership] = await c.handle.db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, pid), eq(projectMembers.userId, user!.id)));
    expect(membership?.companyId).toBe(companyId);
    const held = await c.handle.db.select().from(memberRoles).where(and(eq(memberRoles.projectId, pid), eq(memberRoles.userId, user!.id)));
    expect(held.map((r) => r.roleId)).toContain(role.id);

    // Only the hash is stored.
    const [row] = await c.handle.db.select().from(invitations).where(eq(invitations.userId, user!.id));
    expect(row!.tokenHash).not.toContain("sitekeep_invite_");
    expect(row!.language).toBe("tr");

    const members = (await admin.get(`/projects/${pid}/members`)).body as { email: string; pending: boolean }[];
    expect(members.find((m) => m.email === "new.person@example.com")?.pending).toBe(true);
    const list = (await admin.get(`/projects/${pid}/invitations`)).body;
    expect(list.canInvite).toBe(true);
    expect(list.mail).toEqual({ configured: false, enabled: false });
    expect(list.invitations[0]).toMatchObject({ email: "new.person@example.com", status: "open", invitedByName: "Admin", companyName: "Guest Co" });
    expect(await actions(c)).toContain("invitation.created");

    // A pending account cannot sign in, and other people do not see it in the directory.
    const failed = await c.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "new.person@example.com", password: PW } });
    expect(failed.statusCode).toBe(401);
    const member = await login(c.app, "member@7d.test");
    expect(((await member.get("/users")).body as { email: string }[]).some((u) => u.email === "new.person@example.com")).toBe(false);
    expect(((await admin.get("/users")).body as { email: string; pending?: boolean }[]).find((u) => u.email === "new.person@example.com")?.pending).toBe(true);
  });

  it("accepts once: name and password activate the account, the project is visible; the link cannot be reused", async () => {
    const res = await admin.post(`/projects/${pid}/invitations`, { email: "accept@example.com" });
    const token = tokenOf(res.body.invitation.url);
    const anon = client(c.app);

    const info = await anon.post("/invitations/lookup", { token });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ email: "accept@example.com", name: "accept", invitedBy: "Admin", google: false });
    expect(info.body.projects).toEqual([{ code: "INV", name: "Invite Project" }]);

    expect((await anon.post("/invitations/accept", { token, name: "Ada Accept", password: "short" })).status).toBe(400);
    expect((await anon.post("/invitations/accept", { token, name: "Ada Accept", password: "1234567890" })).status).toBe(400);
    const accepted = await anon.post("/invitations/accept", { token, name: "Ada Accept", password: "Kabul-12345678" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    // The account takes the language the person accepted in.
    expect(accepted.body).toMatchObject({ email: "accept@example.com", name: "Ada Accept", language: "en" });
    expect(accepted.cookies.some((k) => k.name === "cde_session")).toBe(true);

    const person = await login(c.app, "accept@example.com", "Kabul-12345678");
    const projects = (await person.get("/projects")).body as { id: string }[];
    expect(projects.map((p) => p.id)).toContain(pid);

    const again = await anon.post("/invitations/accept", { token, name: "X", password: "Kabul-12345678" });
    expect(again.status).toBe(410);
    expect(again.body.error).toBe("invitation_used");
    expect((await anon.post("/invitations/lookup", { token })).status).toBe(410);
    expect(await actions(c)).toContain("invitation.accepted");
    const list = (await admin.get(`/projects/${pid}/invitations`)).body.invitations as { email: string; status: string }[];
    expect(list.find((i) => i.email === "accept@example.com")?.status).toBe("accepted");
  });

  it("refuses an expired link; resending gives a new link and the old one stops working", async () => {
    const res = await admin.post(`/projects/${pid}/invitations`, { email: "late@example.com" });
    const token = tokenOf(res.body.invitation.url);
    await c.handle.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, res.body.invitation.id));
    const anon = client(c.app);
    const expired = await anon.post("/invitations/lookup", { token });
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe("invitation_expired");
    expect((await anon.post("/invitations/accept", { token, name: "Late", password: "Kabul-12345678" })).body.error).toBe("invitation_expired");
    expect((await admin.get(`/projects/${pid}/invitations`)).body.invitations.find((i: { email: string }) => i.email === "late@example.com").status).toBe("expired");

    const resent = await admin.post(`/projects/${pid}/invitations/${res.body.invitation.id}/resend`, { language: "tr" });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    const fresh = tokenOf(resent.body.url);
    expect(fresh).not.toBe(token);
    expect((await anon.post("/invitations/lookup", { token })).status).toBe(404);
    expect((await anon.post("/invitations/lookup", { token: fresh })).body.language).toBe("tr");
    expect((await anon.post("/invitations/accept", { token: fresh, name: "Late Comer", password: "Kabul-12345678" })).status).toBe(200);
    expect(await actions(c)).toContain("invitation.resent");
  });

  it("revokes: the membership of the pending person is removed and the link is refused", async () => {
    const res = await admin.post(`/projects/${pid}/invitations`, { email: "revoked@example.com" });
    const token = tokenOf(res.body.invitation.url);
    expect((await admin.del(`/projects/${pid}/invitations/${res.body.invitation.id}`)).status).toBe(200);
    const members = (await admin.get(`/projects/${pid}/members`)).body as { email: string }[];
    expect(members.some((m) => m.email === "revoked@example.com")).toBe(false);
    const refused = await client(c.app).post("/invitations/accept", { token, name: "R", password: "Kabul-12345678" });
    expect(refused.status).toBe(410);
    expect(refused.body.error).toBe("invitation_revoked");
    expect((await admin.del(`/projects/${pid}/invitations/${res.body.invitation.id}`)).status).toBe(400);
    expect(await actions(c)).toContain("invitation.revoked");

    // Removing an invited member from the project ends the invitation too.
    const removed = await admin.post(`/projects/${pid}/invitations`, { email: "removed@example.com" });
    expect((await admin.del(`/projects/${pid}/members/${removed.body.userId}`)).status).toBe(200);
    const gone = await client(c.app).post("/invitations/lookup", { token: tokenOf(removed.body.invitation.url) });
    expect(gone.body.error).toBe("invitation_revoked");
  });

  it("adds an existing account at once; refuses disabled accounts and shared mailboxes", async () => {
    const added = await admin.post(`/projects/${pid}/invitations`, { email: "existing@7d.test" });
    expect(added.body).toMatchObject({ status: "added" });
    expect(added.body.invitation).toBeUndefined();
    expect((await admin.post(`/projects/${pid}/invitations`, { email: "off@7d.test" })).status).toBe(400);
    expect((await admin.post(`/projects/${pid}/invitations`, { email: "info@example.com" })).status).toBe(400);
    expect((await admin.post(`/projects/${pid}/invitations`, { email: "not-an-address" })).status).toBe(400);
  });

  it("project administrators invite only when the system setting allows it (default off); members never", async () => {
    const padmin = await login(c.app, "padmin@7d.test");
    const member = await login(c.app, "member@7d.test");
    expect((await admin.get("/admin/invitations")).body).toEqual({ projectAdminsMayInvite: false });
    expect((await padmin.get(`/projects/${pid}/invitations`)).body.canInvite).toBe(false);
    const refused = await padmin.post(`/projects/${pid}/invitations`, { email: "by-padmin@example.com" });
    expect(refused.status).toBe(403);
    // An existing account is still added by a project administrator (as on the members screen).
    expect((await padmin.post(`/projects/${pid}/invitations`, { email: "existing@7d.test" })).body.status).toBe("added");
    expect((await member.post(`/projects/${pid}/invitations`, { email: "by-member@example.com" })).status).toBe(403);
    expect((await member.get(`/projects/${pid}/invitations`)).status).toBe(403);
    expect((await padmin.put("/admin/invitations", { projectAdminsMayInvite: true })).status).toBe(403);

    expect((await admin.put("/admin/invitations", { projectAdminsMayInvite: true })).body).toEqual({ projectAdminsMayInvite: true });
    expect((await padmin.get(`/projects/${pid}/invitations`)).body.canInvite).toBe(true);
    expect((await padmin.post(`/projects/${pid}/invitations`, { email: "by-padmin@example.com" })).body.status).toBe("invited");
    expect((await member.post(`/projects/${pid}/invitations`, { email: "by-member@example.com" })).status).toBe(403);
    await admin.put("/admin/invitations", { projectAdminsMayInvite: false });
  });

  it("limits unknown tokens per client address", async () => {
    const anon = client(c.app);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await anon.post("/invitations/lookup", { token: `7dcde_invite_wrong${i}` })).status;
    expect(last).toBe(429);
  });
});

describe("invitation e-mails", () => {
  let c: Ctx;
  let admin: Awaited<ReturnType<typeof login>>;
  let pid: string;

  beforeAll(async () => {
    c = await start({ mailer: true });
    admin = await login(c.app, "admin@7d.test");
    pid = (await admin.post("/projects", { code: "MAIL", name: "Mail Project" })).body.id;
  });
  afterAll(() => stop(c));
  afterEach(() => {
    sent.length = 0;
  });

  it("sends the e-mail in the chosen language with the link; the inviter does not get the link", async () => {
    const res = await admin.post(`/projects/${pid}/invitations`, { email: "mailed@example.com", name: "Mehmet", language: "tr" });
    expect(res.body.invitation).toMatchObject({ mailed: true });
    expect(res.body.invitation.url).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("mailed@example.com");
    expect(String(sent[0]!.subject)).toContain("Mail Project");
    expect(String(sent[0]!.subject)).toContain("davet etti");
    expect(String(sent[0]!.text)).toMatch(/https:\/\/cde\.example\.test\/invite#sitekeep_invite_/);
    const list = (await admin.get(`/projects/${pid}/invitations`)).body;
    expect(list.mail).toEqual({ configured: true, enabled: true });
    expect(list.invitations[0].mailedAt).toBeTruthy();

    const english = await admin.post(`/projects/${pid}/invitations`, { email: "english@example.com", language: "en" });
    expect(english.body.invitation.mailed).toBe(true);
    expect(String(sent[1]!.subject)).toBe("Admin invited you to Mail Project on SiteKeep");
  });

  it("never sends while e-mail is switched off in the Privacy Centre: the inviter gets the link", async () => {
    expect((await admin.put("/admin/privacy/connections/smtp", { enabled: false })).status).toBe(200);
    try {
      const res = await admin.post(`/projects/${pid}/invitations`, { email: "quiet@example.com" });
      expect(res.body.invitation).toMatchObject({ mailed: false, mailSkipped: "smtp_disabled" });
      expect(res.body.invitation.url).toContain("/invite#");
      const resent = await admin.post(`/projects/${pid}/invitations/${res.body.invitation.id}/resend`);
      expect(resent.body.mailed).toBe(false);
      expect(sent).toHaveLength(0);
      expect((await admin.get(`/projects/${pid}/invitations`)).body.mail).toEqual({ configured: true, enabled: false });
    } finally {
      await admin.put("/admin/privacy/connections/smtp", { enabled: true });
    }
  });
});

describe("accepting with Google", () => {
  let c: Ctx;
  let admin: Awaited<ReturnType<typeof login>>;
  let pid: string;

  beforeAll(async () => {
    c = await start({ google: true });
    admin = await login(c.app, "admin@7d.test");
    pid = (await admin.post("/projects", { code: "GGL", name: "Google Project" })).body.id;
  });
  afterAll(() => stop(c));
  afterEach(() => vi.restoreAllMocks());

  async function viaGoogle(token: string, email: string) {
    const start = await c.app.inject({ method: "POST", url: "/api/v1/invitations/google", payload: { token } });
    expect(start.statusCode, start.body).toBe(200);
    const invite = start.cookies.find((k) => k.name === "cde_invitation")!;
    const begin = await c.app.inject({ method: "GET", url: "/api/v1/auth/google" });
    const stateCookie = begin.cookies.find((k) => k.name === "cde_google_state")!;
    const state = new URL(begin.headers.location!).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email, email_verified: true, name: "Gül Google" }), { status: 200 }));
    return c.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `cde_google_state=${stateCookie.value}; cde_invitation=${invite.value}` },
    });
  }

  it("accepts for the same address and signs in; another Google address is refused", async () => {
    const other = await admin.post(`/projects/${pid}/invitations`, { email: "someone@example.com" });
    const refused = await viaGoogle(tokenOf(other.body.invitation.url), "intruder@example.com");
    expect(refused.headers.location).toBe("/login?authError=invitation_email_mismatch");
    const [still] = await c.handle.db.select().from(users).where(eq(users.email, "someone@example.com"));
    expect(still?.pending).toBe(true);

    const res = await admin.post(`/projects/${pid}/invitations`, { email: "gul@example.com" });
    const token = tokenOf(res.body.invitation.url);
    expect((await client(c.app).post("/invitations/lookup", { token })).body.google).toBe(true);
    const callback = await viaGoogle(token, "gul@example.com");
    expect(callback.headers.location).toBe("/");
    expect(callback.cookies.some((k) => k.name === "cde_session")).toBe(true);
    const [user] = await c.handle.db.select().from(users).where(eq(users.email, "gul@example.com"));
    expect(user).toMatchObject({ pending: false, disabled: false, name: "Gül Google" });
    expect((await client(c.app).post("/invitations/lookup", { token })).status).toBe(410);
  });
});

describe("set-up wizard invitations and people files", () => {
  let c: Ctx;
  let admin: Awaited<ReturnType<typeof login>>;
  let slotCompanies: Record<string, string>;

  beforeAll(async () => {
    c = await start();
    admin = await login(c.app, "admin@7d.test");
    const co: Record<string, string> = {};
    for (const name of ["Client Co", "Consult Co", "Design Co", "Build Co"]) co[name] = (await admin.post("/companies", { name })).body.id;
    slotCompanies = { idare: co["Client Co"]!, musavir: co["Consult Co"]!, tasarimci: co["Design Co"]!, yuklenici: co["Build Co"]! };
  });
  afterAll(() => stop(c));

  const request = (code: string, invite: boolean) => ({
    templateId: "iso19650-yapim-en",
    language: "en",
    code,
    name: `Wizard ${code}`,
    slotCompanies,
    people: [
      { email: "existing@7d.test", slot: "yuklenici" },
      { email: "wizard-new@example.com", name: "Wiz New", slot: "tasarimci", roles: ["tasarimci-yetki"] },
      { email: "info@example.com" },
    ],
    ...(invite ? { invite: { language: "tr" } } : {}),
  });

  it("dry run: without invite people without an account are only reported; with invite they will be invited", async () => {
    const plain = await admin.post("/projects/setup/preview", request("WZA", false));
    expect(plain.body.people.map((p: { status: string }) => p.status)).toEqual(["added", "no_account", "group_address"]);
    const invite = await admin.post("/projects/setup/preview", request("WZA", true));
    expect(invite.body.people.map((p: { status: string }) => p.status)).toEqual(["added", "invite", "group_address"]);
    expect(invite.body.people[1].name).toBe("Wiz New");
    expect(invite.body.warnings.some((w: string) => w.includes("wizard-new@example.com"))).toBe(false);
    expect(await c.handle.db.select().from(invitations)).toHaveLength(0);
  });

  it("create: the invited person is a pending member of the party's company and team with the roles; accepting opens the project", async () => {
    const res = await admin.post("/projects/from-template", request("WZB", true));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const person = res.body.people.find((p: { email: string }) => p.email === "wizard-new@example.com");
    expect(person).toMatchObject({ status: "invited", name: "Wiz New" });
    expect(person.invitation.url).toMatch(/\/invite#sitekeep_invite_/);
    const pid = res.body.id as string;

    const members = (await admin.get(`/projects/${pid}/members`)).body as { email: string; companyId: string; pending?: boolean; roleIds: string[] }[];
    const pending = members.find((m) => m.email === "wizard-new@example.com")!;
    expect(pending).toMatchObject({ companyId: slotCompanies.tasarimci, pending: true });
    const roles = (await admin.get(`/projects/${pid}/roles`)).body as { id: string; kind: string; companyId: string | null; name: string }[];
    const team = roles.find((r) => r.kind === "task_team" && r.companyId === slotCompanies.tasarimci)!;
    expect(pending.roleIds).toContain(team.id);
    expect(pending.roleIds.length).toBeGreaterThanOrEqual(2);
    const created = (await c.handle.db.select().from(auditLog)).find((r) => r.action === "project.created_from_template" && r.projectId === pid);
    expect((created!.details as { people: { status: string }[] }).people.map((p) => p.status)).toEqual(["added", "invited", "group_address"]);
    expect((await c.handle.db.select().from(auditLog)).filter((r) => r.action === "invitation.created" && r.projectId === pid)).toHaveLength(1);

    const token = tokenOf(person.invitation.url);
    expect((await client(c.app).post("/invitations/lookup", { token })).body.language).toBe("tr");
    expect((await client(c.app).post("/invitations/accept", { token, name: "Wiz New", password: "Kabul-12345678" }, "tr")).status).toBe(200);
    const signedIn = await login(c.app, "wizard-new@example.com", "Kabul-12345678");
    expect(((await signedIn.get("/projects")).body as { id: string }[]).map((p) => p.id)).toContain(pid);
    expect(((await signedIn.get("/auth/me")).body as { language: string }).language).toBe("tr");
  });

  it("reads a people file: CSV (Turkish encoding, semicolons) and Excel", async () => {
    const csv = Buffer.from("E-posta;Ad Soyad;Firma\nayse@example.com;Ayşe Yılmaz;Design Co\n", "utf8");
    const fromCsv = await admin.post("/projects/setup/people-file", { fileName: "people.csv", content: csv.toString("base64") });
    expect(fromCsv.status, JSON.stringify(fromCsv.body)).toBe(200);
    expect(fromCsv.body.table).toEqual([
      ["E-posta", "Ad Soyad", "Firma"],
      ["ayse@example.com", "Ayşe Yılmaz", "Design Co"],
    ]);
    const xlsx = await writeXlsx([{ name: "People", columns: [{ title: "Email" }, { title: "Name" }], rows: [["bob@example.com", "Bob"]] }]);
    const fromXlsx = await admin.post("/projects/setup/people-file", { fileName: "people.xlsx", content: xlsx.toString("base64") });
    expect(fromXlsx.body.table).toEqual([
      ["Email", "Name"],
      ["bob@example.com", "Bob"],
    ]);
    expect((await admin.post("/projects/setup/people-file", { fileName: "people.pdf", content: "AAAA" })).status).toBe(400);
    expect((await admin.post("/projects/setup/people-file", { fileName: "broken.xlsx", content: "AAAA" })).status).toBe(400);
    const member = await login(c.app, "member@7d.test");
    expect((await member.post("/projects/setup/people-file", { fileName: "people.csv", content: csv.toString("base64") })).status).toBe(403);
  });
});
