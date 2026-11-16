// Security log (G-7), security alerts (G-8) and the read-only auditor (G-10):
// docs/features/SECURITY_LOG.md.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { AuditPageDto, SecurityAlertDto, SecurityAlertSettingsDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { audit } from "../../src/core/platform/audit.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, securityAlerts, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { expireAuditPersonal } from "../../src/audit/personal.js";
import { loadPrivacyState } from "../../src/privacy/settings.js";
import { checkAuditChainForAlert, scanSecurityEvents } from "../../src/audit/security-alerts.js";

const PW = "Sifre-1234567";
const IP = "10.20.30.40";
const UA = "SecurityLogTest/1.0";

const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const capture = {
  sendMail: async (m: SendMailOptions) => {
    sent.push(m);
    return json.sendMail(m);
  },
} as unknown as Transporter;

let app: FastifyInstance;
let handle: DbHandle;
let dir: string;
let ids: Record<"admin" | "auditor" | "member", string>;

beforeEach(async () => {
  sent.length = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-seclog-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), mailer: { transport: capture, from: "cde@7d.test" } });
  const passwordHash = await hashPassword(PW);
  const rows = await handle.db
    .insert(users)
    .values([
      { email: "admin@7d.test", name: "Admin Person", passwordHash, isAdmin: true },
      { email: "auditor@7d.test", name: "Auditor Person", passwordHash, isAuditor: true },
      { email: "member@7d.test", name: "Member Person", passwordHash },
    ])
    .returning({ id: users.id, email: users.email });
  ids = {
    admin: rows.find((r) => r.email === "admin@7d.test")!.id,
    auditor: rows.find((r) => r.email === "auditor@7d.test")!.id,
    member: rows.find((r) => r.email === "member@7d.test")!.id,
  };
  await loadPrivacyState(handle.db);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

type Res = { status: number; body: any; text: string };

async function call(method: string, url: string, opts: { cookie?: string; payload?: unknown; ip?: string } = {}): Promise<Res> {
  const res = await app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: { ...(opts.cookie && { cookie: opts.cookie }), "user-agent": UA, "accept-language": "en" },
    remoteAddress: opts.ip ?? IP,
    payload: (opts.payload ?? (method === "GET" ? undefined : {})) as object,
  });
  const ct = String(res.headers["content-type"] ?? "");
  return { status: res.statusCode, body: ct.includes("json") && res.body ? res.json() : null, text: res.body };
}

async function login(email: string, password = PW, ip = IP): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { "user-agent": UA }, remoteAddress: ip });
  const c = res.cookies.find((k) => k.name === "cde_session" && k.value);
  if (!c) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  return `cde_session=${c.value}`;
}

const actions = (page: AuditPageDto) => page.entries.map((e) => e.action);

describe("G-7 security log", () => {
  it("lists security events of the whole installation, outside projects too, and leaves other events out", async () => {
    const admin = await login("admin@7d.test");
    await call("POST", "/auth/login", { payload: { email: "member@7d.test", password: "wrong-password-1" }, ip: "10.9.9.9" });
    await call("POST", "/auth/login", { payload: { email: "nobody@7d.test", password: "wrong-password-1" }, ip: "10.9.9.9" });
    const p = await call("POST", "/projects", { cookie: admin, payload: { code: "SEC1", name: "Security", template: "iso19650" } });
    expect(p.status, p.text).toBe(200);
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { isAdmin: true } });
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { disabled: true } });
    await call("PUT", "/admin/privacy/kill-switch", { cookie: admin, payload: { on: true } });
    await audit(handle.db, { projectId: p.body.id, userId: ids.admin, action: "file.uploaded", targetType: "file", targetId: "x" });

    const page = (await call("GET", "/admin/security-log?limit=100", { cookie: admin })).body as AuditPageDto;
    const all = actions(page);
    expect(all).toEqual(expect.arrayContaining(["auth.login", "auth.login_failed", "user.updated", "privacy.kill_switch_on"]));
    expect(all).not.toContain("file.uploaded");
    expect(all).not.toContain("project.created");
    // Failed sign-ins are written outside a project; the client is shown while it is kept.
    const failed = page.entries.filter((e) => e.action === "auth.login_failed");
    expect(failed).toHaveLength(2);
    expect(failed.every((e) => e.projectId === null && e.ip === "10.9.9.9" && e.userAgent === UA)).toBe(true);
    // A row about a user names the user.
    expect(page.entries.find((e) => e.action === "user.updated")).toMatchObject({ targetType: "user", targetId: ids.member, targetName: "Member Person" });

    // Type: an admin flag change is a permission change; the disabled flag is not.
    const perms = (await call("GET", "/admin/security-log?type=permissions", { cookie: admin })).body as AuditPageDto;
    expect(perms.entries.filter((e) => e.action === "user.updated").map((e) => e.details)).toEqual([{ isAdmin: true }]);
    const signIn = actions((await call("GET", "/admin/security-log?type=sign_in", { cookie: admin })).body);
    expect(new Set(signIn)).toEqual(new Set(["auth.login", "auth.login_failed"]));
    expect(actions((await call("GET", "/admin/security-log?type=connections", { cookie: admin })).body)).toEqual(["privacy.kill_switch_on"]);

    // Person: by the person or about them.
    const member = (await call("GET", `/admin/security-log?userId=${ids.member}`, { cookie: admin })).body as AuditPageDto;
    expect(new Set(actions(member))).toEqual(new Set(["auth.login_failed", "user.updated"]));

    // IP: exact or its beginning.
    expect(actions((await call("GET", "/admin/security-log?ip=10.9.9.9", { cookie: admin })).body)).toEqual(["auth.login_failed", "auth.login_failed"]);
    expect(actions((await call("GET", "/admin/security-log?ip=10.9.", { cookie: admin })).body)).toHaveLength(2);
    expect(actions((await call("GET", "/admin/security-log?ip=10.8.", { cookie: admin })).body)).toEqual([]);
    expect((await call("GET", "/admin/security-log?ip=10.9.9.9%25", { cookie: admin })).status).toBe(400);

    // Dates.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(actions((await call("GET", `/admin/security-log?from=${tomorrow}`, { cookie: admin })).body)).toEqual([]);

    // Members may not read it.
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { disabled: false, isAdmin: false } });
    const m = await login("member@7d.test");
    expect((await call("GET", "/admin/security-log", { cookie: m })).status).toBe(403);
  });

  it("exports CSV with the client while kept, 'deleted (retention)' afterwards, and records the export", async () => {
    await call("POST", "/auth/login", { payload: { email: "member@7d.test", password: "wrong-password-1" }, ip: "10.9.9.9" });
    const admin = await login("admin@7d.test");
    const csv = await call("GET", "/admin/security-log.csv?type=sign_in&lang=en", { cookie: admin });
    expect(csv.status).toBe(200);
    expect(csv.text.split("\r\n")[0]).toContain("IP Address");
    expect(csv.text).toContain(`10.9.9.9;${UA}`);
    const [exported] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "audit.exported"));
    expect(exported).toMatchObject({ projectId: null, userId: ids.admin, details: { log: "security", query: { type: "sign_in", lang: "en" } } });

    const later = new Date(Date.now() + 400 * 86_400_000);
    expect(await expireAuditPersonal(handle.db, later)).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    const cookie = await login("admin@7d.test");
    const after = await call("GET", "/admin/security-log.csv?type=sign_in&lang=en", { cookie });
    expect(after.text).toContain("auth.login_failed");
    expect(after.text).toContain("deleted (retention);deleted (retention)");
  });
});

describe("G-10 auditor", () => {
  it("reads the security log, every audit log, the chain check and the Privacy Centre", async () => {
    const admin = await login("admin@7d.test");
    const p = await call("POST", "/projects", { cookie: admin, payload: { code: "AUD2", name: "Audited", template: "iso19650" } });
    await audit(handle.db, { projectId: p.body.id, userId: ids.admin, action: "file.uploaded", targetType: "file", targetId: "x" });
    const auditor = await login("auditor@7d.test");

    const me = await call("GET", "/auth/me", { cookie: auditor });
    expect(me.body).toMatchObject({ isAdmin: false, isAuditor: true });
    expect((await call("GET", "/admin/security-log", { cookie: auditor })).status).toBe(200);
    expect((await call("GET", "/admin/security-log.csv", { cookie: auditor })).status).toBe(200);
    const all = (await call("GET", `/admin/audit?projectId=${p.body.id}`, { cookie: auditor })).body as AuditPageDto;
    expect(actions(all)).toContain("file.uploaded");
    expect((await call("GET", "/admin/audit.csv", { cookie: auditor })).status).toBe(200);
    expect((await call("GET", "/admin/audit/verify", { cookie: auditor })).body).toMatchObject({ ok: true });
    expect((await call("GET", "/admin/audit/projects", { cookie: auditor })).body).toEqual([{ id: p.body.id, code: "AUD2", name: "Audited" }]);
    for (const url of ["/admin/privacy", "/admin/privacy/connections", "/admin/privacy/outbound", "/admin/security-alerts", "/admin/security-alerts/settings"])
      expect((await call("GET", url, { cookie: auditor })).status, url).toBe(200);
    // The user list with every account (security log's person filter).
    const list = (await call("GET", "/users", { cookie: auditor })).body as { id: string; twoFactor?: boolean }[];
    expect(list.every((u) => typeof u.twoFactor === "boolean")).toBe(true);
  });

  it("changes nothing and gets no project or file access from the role", async () => {
    const admin = await login("admin@7d.test");
    const p = await call("POST", "/projects", { cookie: admin, payload: { code: "AUD3", name: "Closed", template: "iso19650" } });
    const auditor = await login("auditor@7d.test");
    const refused: [string, string, unknown][] = [
      ["PUT", "/admin/privacy/settings", { logRetentionDays: 30 }],
      ["PUT", "/admin/privacy/kill-switch", { on: true }],
      ["PUT", "/admin/privacy/connections/smtp", { enabled: false }],
      ["PUT", "/admin/security-alerts/settings", { failedSignInsAccount: 5 }],
      ["PUT", "/admin/sign-in-security", { failureLimit: 5 }],
      ["PATCH", `/users/${ids.member}`, { isAdmin: true }],
      ["PATCH", `/users/${ids.auditor}`, { isAuditor: false }],
      ["POST", "/users", { email: "x@7d.test", name: "X", password: PW }],
      ["POST", `/admin/users/${ids.member}/anonymise`, {}],
      ["GET", "/admin/status", undefined],
    ];
    for (const [method, url, payload] of refused) expect((await call(method, url, { cookie: auditor, payload })).status, `${method} ${url}`).toBe(403);
    // Not a member: the project, its files and its own audit route stay closed.
    expect((await call("GET", `/projects/${p.body.id}`, { cookie: auditor })).status).toBe(404);
    expect((await call("GET", `/projects/${p.body.id}/audit`, { cookie: auditor })).status).toBe(404);
    expect((await call("GET", `/projects/${p.body.id}/folders`, { cookie: auditor })).status).toBe(404);
  });

  it("is assigned by a system administrator, and that is audited", async () => {
    const admin = await login("admin@7d.test");
    const r = await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { isAuditor: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ isAuditor: true, isAdmin: false });
    const row = (await handle.db.select().from(auditLog).where(eq(auditLog.action, "user.updated")))[0];
    expect(row).toMatchObject({ userId: ids.admin, targetId: ids.member, details: { isAuditor: true } });
    const perms = (await call("GET", "/admin/security-log?type=permissions", { cookie: admin })).body as AuditPageDto;
    expect(perms.entries.map((e) => e.details)).toContainEqual({ isAuditor: true });
    const created = await call("POST", "/users", { cookie: admin, payload: { email: "aud2@7d.test", name: "Second Auditor", password: PW, isAuditor: true } });
    expect(created.body).toMatchObject({ isAuditor: true });
    const [c] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "user.created"));
    expect(c!.details).toEqual({ isAuditor: true });
  });
});

describe("G-8 security alerts", () => {
  const alerts = async (cookie: string, status = "open") => (await call("GET", `/admin/security-alerts?status=${status}`, { cookie })).body as SecurityAlertDto[];

  it("raises one alert for many failed sign-ins of an account, counts up while open, audits it", async () => {
    const admin = await login("admin@7d.test");
    expect(await alerts(admin)).toEqual([]);
    for (let i = 0; i < 9; i++) await call("POST", "/auth/login", { payload: { email: "member@7d.test", password: "wrong-password-1" }, ip: `10.1.0.${i}` });
    expect(await alerts(admin)).toEqual([]);
    await call("POST", "/auth/login", { payload: { email: "member@7d.test", password: "wrong-password-1" }, ip: "10.1.0.99" });
    const [a] = await alerts(admin);
    expect(a).toMatchObject({ rule: "failed_sign_ins_account", status: "open", userId: ids.member, userName: "Member Person", occurrences: 1, details: { count: 10, threshold: 10, minutes: 15 } });
    // No IP address or e-mail address in the alert.
    expect(JSON.stringify(a)).not.toMatch(/10\.1\.0|member@7d/);
    const [raised] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "security.alert_raised"));
    expect(raised).toMatchObject({ targetType: "security_alert", targetId: a!.id, details: { rule: "failed_sign_ins_account", subjectUserId: ids.member } });

    // The account is locked now (429, no row); a failure of an unknown address is its own subject.
    for (let i = 0; i < 10; i++) await call("POST", "/auth/login", { payload: { email: "ghost@7d.test", password: "wrong-password-1" }, ip: `10.2.0.${i}` });
    const open = await alerts(admin);
    expect(open.map((x) => x.rule)).toEqual(["failed_sign_ins_account", "failed_sign_ins_account"]);
    expect(open[0]!.userId).toBeNull();
  });

  it("installation-wide failed sign-ins, bulk downloads, a new administrator, the kill switch and two-factor turned off", async () => {
    const admin = await login("admin@7d.test");
    const s = await call("PUT", "/admin/security-alerts/settings", { cookie: admin, payload: { failedSignInsGlobal: 5, bulkDownloadFiles: 10 } });
    expect(s.status, s.text).toBe(200);
    expect(s.body).toMatchObject({ failedSignInsGlobal: 5, bulkDownloadFiles: 10, failedSignInsAccount: 10, mail: null });
    await scanSecurityEvents({ db: handle.db });
    for (let i = 0; i < 5; i++) await call("POST", "/auth/login", { payload: { email: `x${i}@7d.test`, password: "wrong-password-1" }, ip: `10.3.0.${i}` });
    // 6 single downloads and a ZIP of 4 files by one person.
    for (let i = 0; i < 6; i++) await audit(handle.db, { userId: ids.member, action: "file.downloaded", targetType: "file", targetId: `f${i}` });
    await audit(handle.db, { userId: ids.member, action: "file.zip_downloaded", targetType: "project", targetId: "p", details: { count: 4 } });
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { isAdmin: true } });
    await call("PUT", "/admin/privacy/kill-switch", { cookie: admin, payload: { on: true } });
    await call("PUT", "/admin/privacy/kill-switch", { cookie: admin, payload: { on: false } });
    await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { requireTwoFactor: "admins" } });
    await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { requireTwoFactor: "off" } });

    const open = await alerts(admin);
    expect(new Set(open.map((a) => a.rule))).toEqual(new Set(["failed_sign_ins_global", "bulk_download", "new_admin", "kill_switch_off", "two_factor_off"]));
    expect(open.find((a) => a.rule === "bulk_download")).toMatchObject({ userId: ids.member, details: { count: 10, threshold: 10, minutes: 60 } });
    expect(open.find((a) => a.rule === "new_admin")).toMatchObject({ userId: ids.member, details: { byUserId: ids.admin } });
    expect(open.find((a) => a.rule === "two_factor_off")).toMatchObject({ details: { from: "admins" } });
    // The settings change is audited; e-mail addresses only as a count.
    const [settingsRow] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "security.alert_settings"));
    expect(settingsRow!.details).toEqual({ failedSignInsGlobal: { from: 50, to: 5 }, bulkDownloadFiles: { from: 200, to: 10 } });
  });

  it("acknowledge and dismiss: administrators only, audited, the card goes away", async () => {
    const admin = await login("admin@7d.test");
    await call("PUT", "/admin/privacy/kill-switch", { cookie: admin, payload: { on: false } });
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { isAdmin: true } });
    const open = await alerts(admin);
    expect(open).toHaveLength(2);
    const auditor = await login("auditor@7d.test");
    expect(await alerts(auditor)).toHaveLength(2);
    expect((await call("POST", `/admin/security-alerts/${open[0]!.id}/acknowledge`, { cookie: auditor })).status).toBe(403);
    expect((await call("POST", `/admin/security-alerts/${open[0]!.id}/acknowledge`, { cookie: admin })).status).toBe(200);
    expect((await call("POST", `/admin/security-alerts/${open[1]!.id}/dismiss`, { cookie: admin })).status).toBe(200);
    expect((await call("POST", `/admin/security-alerts/${open[1]!.id}/dismiss`, { cookie: admin })).status).toBe(404);
    expect(await alerts(admin)).toEqual([]);
    const handled = await alerts(admin, "all");
    expect(handled.map((a) => [a.status, a.handledByName])).toEqual(
      expect.arrayContaining([
        ["acknowledged", "Admin Person"],
        ["dismissed", "Admin Person"],
      ]),
    );
    const rows = await handle.db.select().from(auditLog).where(sql`${auditLog.action} in ('security.alert_acknowledged', 'security.alert_dismissed')`).orderBy(asc(auditLog.id));
    expect(rows.map((r) => [r.action, r.userId, r.targetId])).toEqual([
      ["security.alert_acknowledged", ids.admin, open[0]!.id],
      ["security.alert_dismissed", ids.admin, open[1]!.id],
    ]);
    const log = (await call("GET", "/admin/security-log?type=alerts", { cookie: admin })).body as AuditPageDto;
    expect(actions(log)).toEqual(["security.alert_dismissed", "security.alert_acknowledged", "security.alert_raised", "security.alert_raised"]);
    // A new match after handling raises a new one-off alert.
    await call("PATCH", `/users/${ids.auditor}`, { cookie: admin, payload: { isAdmin: true } });
    expect((await alerts(admin)).map((a) => a.rule)).toEqual(["new_admin"]);
  });

  it("switched-off rules raise nothing", async () => {
    const admin = await login("admin@7d.test");
    await call("PUT", "/admin/security-alerts/settings", { cookie: admin, payload: { disabledRules: ["kill_switch_off"] } });
    await call("PUT", "/admin/privacy/kill-switch", { cookie: admin, payload: { on: false } });
    expect(await alerts(admin)).toEqual([]);
  });

  it("e-mails the configured addresses only when SMTP is allowed; no personal data in the mail", async () => {
    const admin = await login("admin@7d.test");
    const bad = await call("PUT", "/admin/security-alerts/settings", { cookie: admin, payload: { emailTo: ["not-an-address"] } });
    expect(bad.status).toBe(400);
    await call("PUT", "/admin/security-alerts/settings", { cookie: admin, payload: { emailTo: ["SOC@7d.test", "dpo@7d.test"] } });
    // SMTP switched off in the Privacy Centre: the alert is raised, no e-mail.
    await call("PUT", "/admin/privacy/connections/smtp", { cookie: admin, payload: { enabled: false } });
    expect(((await call("GET", "/admin/security-alerts/settings", { cookie: admin })).body as SecurityAlertSettingsDto).mail).toBe("smtp_disabled");
    await call("PATCH", `/users/${ids.member}`, { cookie: admin, payload: { isAdmin: true } });
    const [first] = await alerts(admin);
    expect(first).toMatchObject({ rule: "new_admin", mailedAt: null });
    expect(sent).toEqual([]);

    await call("PUT", "/admin/privacy/connections/smtp", { cookie: admin, payload: { enabled: true } });
    await call("PATCH", `/users/${ids.auditor}`, { cookie: admin, payload: { isAdmin: true } });
    const mailed = (await alerts(admin)).find((a) => a.userId === ids.auditor)!;
    expect(mailed.mailedAt).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["soc@7d.test", "dpo@7d.test"], from: "cde@7d.test" });
    expect(String(sent[0]!.text)).not.toMatch(/auditor@7d|Auditor Person|10\.20\.30\.40/);
    expect(String(sent[0]!.text)).toMatch(/72/);
    const [settingsRow] = (await handle.db.select().from(auditLog).where(eq(auditLog.action, "security.alert_settings")));
    expect(settingsRow!.details).toEqual({ emailTo: { from: 0, to: 2 } });
    expect(JSON.stringify(settingsRow)).not.toContain("soc@7d.test");
  });

  it("the daily chain check raises an alert when the chain is broken", async () => {
    for (const n of [1, 2, 3]) await audit(handle.db, { action: `t.${n}`, details: { n } });
    expect(await checkAuditChainForAlert({ db: handle.db })).toBe(true);
    expect(await handle.db.select().from(securityAlerts)).toEqual([]);
    const [row] = await handle.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "t.2"));
    await handle.db.execute(sql.raw(`alter table audit_log disable trigger audit_log_immutable`));
    await handle.db.execute(sql.raw(`update audit_log set details = '{"n": 99}' where id = ${row!.id}`));
    await handle.db.execute(sql.raw(`alter table audit_log enable trigger audit_log_immutable`));
    expect(await checkAuditChainForAlert({ db: handle.db })).toBe(false);
    expect(await checkAuditChainForAlert({ db: handle.db })).toBe(false);
    const list = await handle.db.select().from(securityAlerts);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule: "audit_chain_broken", occurrences: 2, details: { id: row!.id, reason: "hash_mismatch" } });
  });
});
