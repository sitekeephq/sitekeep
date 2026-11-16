// Sign-in security (docs/features/SIGN_IN_SECURITY.md): failed-attempt limits (G-1), two-factor
// authentication (G-2), session lifetimes (G-4) and the password rules (G-5).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword, isCommonPassword, passwordProblem } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, auditPersonal, invitations, tokens, users, userTwoFactor } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { SignInSecurity } from "../../src/auth/sign-in-security.js";
import { runRetention } from "../../src/privacy/retention.js";
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from "../../src/auth/totp.js";

const PW = "Sifre-1234567";

interface Ctx {
  app: FastifyInstance;
  handle: DbHandle;
  dir: string;
  clock: { now: number };
  security: SignInSecurity;
}

let c: Ctx;

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-signin-"));
  const handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  const clock = { now: Date.now() };
  const security = new SignInSecurity(handle.db, () => clock.now);
  const app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), signInSecurity: security });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin Person", passwordHash, isAdmin: true },
    { email: "member@7d.test", name: "Member Person", passwordHash },
  ]);
  c = { app, handle, dir, clock, security };
});

afterEach(async () => {
  await c.app.close();
  await c.handle.close();
  rmSync(c.dir, { recursive: true, force: true });
});

type Res = { status: number; body: any; cookies: { name: string; value: string }[]; headers: Record<string, unknown> };

async function call(method: string, url: string, opts: { payload?: unknown; cookie?: string; ip?: string } = {}): Promise<Res> {
  const res = await c.app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), "accept-language": "en" },
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    payload: (opts.payload ?? (method === "GET" ? undefined : {})) as object,
  });
  return { status: res.statusCode, body: res.body ? res.json() : null, cookies: res.cookies, headers: res.headers };
}

const cookieOf = (res: Res, name: string) => res.cookies.find((k) => k.name === name && k.value)?.value;
const session = (res: Res) => `cde_session=${cookieOf(res, "cde_session")}`;

async function login(email: string, password = PW, ip?: string) {
  return call("POST", "/auth/login", { payload: { email, password }, ip });
}

async function auditActions(action: string) {
  return c.handle.db.select().from(auditLog).where(eq(auditLog.action, action));
}

describe("G-1 failed sign-in limits", () => {
  it("locks an account after 10 failures in 15 minutes: 429 with Retry-After, even with the right password", async () => {
    for (let i = 0; i < 10; i++) expect((await login("member@7d.test", "wrong-password-1", `10.0.0.${i}`)).status).toBe(401);
    const locked = await login("member@7d.test", PW, "10.0.1.1");
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("too_many_attempts");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
    // Audited once, as auth.locked, with the account (the address only in the personal part).
    const rows = await auditActions("auth.locked");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ scope: "account", attempt: "password", failures: 10, windowMinutes: 15 });
    expect(JSON.stringify(rows[0]!.details)).not.toContain("member@7d.test");
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    expect(rows[0]!.userId).toBe(member!.id);
    // The lock ends when the window has passed.
    c.clock.now += 15 * 60_000 + 1000;
    expect((await login("member@7d.test", PW, "10.0.1.1")).status).toBe(200);
  });

  it("treats unknown addresses the same way (no account enumeration)", async () => {
    const unknown = await login("nobody@7d.test", "wrong-password-1");
    const wrong = await login("member@7d.test", "wrong-password-1");
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    for (let i = 0; i < 9; i++) await login("nobody@7d.test", "wrong-password-1", `10.1.0.${i}`);
    const locked = await login("nobody@7d.test", "wrong-password-1", "10.1.1.1");
    expect(locked.status).toBe(429);
    expect((await auditActions("auth.locked"))[0]!.userId).toBeNull();
  });

  it("locks a client IP across addresses at its own limit", async () => {
    await call("PUT", "/admin/sign-in-security", { cookie: session(await login("admin@7d.test")), payload: { ipFailureLimit: 10 } });
    for (let i = 0; i < 10; i++) await login(`guess${i}@7d.test`, "wrong-password-1", "192.0.2.7");
    expect((await login("member@7d.test", PW, "192.0.2.7")).status).toBe(429);
    expect((await login("member@7d.test", PW, "192.0.2.8")).status).toBe(200);
    expect((await auditActions("auth.locked")).map((r) => (r.details as { scope: string }).scope)).toContain("ip");
  });

  it("counts wrong current passwords on the password change", async () => {
    const cookie = session(await login("member@7d.test"));
    for (let i = 0; i < 10; i++)
      expect((await call("POST", "/auth/password", { cookie, payload: { currentPassword: "nope-nope-nope", newPassword: "Yeni-Sifre-2026x" } })).status).toBe(400);
    const locked = await call("POST", "/auth/password", { cookie, payload: { currentPassword: PW, newPassword: "Yeni-Sifre-2026x" } });
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("counts bad invitation tokens against the client IP", async () => {
    await call("PUT", "/admin/sign-in-security", { cookie: session(await login("admin@7d.test")), payload: { ipFailureLimit: 10 } });
    for (let i = 0; i < 10; i++)
      expect((await call("POST", "/invitations/accept", { ip: "198.51.100.1", payload: { token: `7dcde_invite_bad${i}`, name: "X", password: "Kabul-12345678" } })).status).toBe(404);
    const locked = await call("POST", "/invitations/accept", { ip: "198.51.100.1", payload: { token: "7dcde_invite_bad", name: "X", password: "Kabul-12345678" } });
    expect(locked.status).toBe(429);
  });

  it("lets a system administrator lift the locks and change the limits (audited)", async () => {
    const admin = session(await login("admin@7d.test"));
    expect((await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { failureLimit: 3, failureWindowMinutes: 5 } })).body).toMatchObject({
      failureLimit: 3,
      failureWindowMinutes: 5,
    });
    expect((await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { failureLimit: 1 } })).status).toBe(400);
    for (let i = 0; i < 3; i++) await login("member@7d.test", "wrong-password-1");
    expect((await login("member@7d.test")).status).toBe(429);
    expect((await call("POST", "/admin/sign-in-security/unlock", { cookie: admin })).status).toBe(200);
    expect((await login("member@7d.test")).status).toBe(200);
    expect(await auditActions("auth.security_settings")).toHaveLength(1);
    expect(await auditActions("auth.locks_cleared")).toHaveLength(1);
    expect((await call("GET", "/admin/sign-in-security", { cookie: session(await login("member@7d.test")) })).status).toBe(403);
  });
});

describe("G-4 sessions", () => {
  it("ends a session after the idle limit (12 hours by default) and the absolute limit (14 days)", async () => {
    const cookie = session(await login("member@7d.test"));
    c.clock.now += 11 * 3_600_000;
    expect((await call("GET", "/auth/me", { cookie })).status).toBe(200);
    c.clock.now += 13 * 3_600_000;
    expect((await call("GET", "/auth/me", { cookie })).status).toBe(401);

    // Idle limit off: the absolute limit still ends it.
    c.clock.now = Date.now();
    await call("PUT", "/admin/sign-in-security", { cookie: session(await login("admin@7d.test")), payload: { sessionIdleHours: 0, sessionAbsoluteDays: 2 } });
    const second = session(await login("member@7d.test"));
    c.clock.now += 47 * 3_600_000;
    expect((await call("GET", "/auth/me", { cookie: second })).status).toBe(200);
    c.clock.now += 2 * 3_600_000;
    expect((await call("GET", "/auth/me", { cookie: second })).status).toBe(401);
  });

  it("cleans up ended sessions", async () => {
    await login("member@7d.test");
    await login("member@7d.test");
    expect(await c.security.cleanupSessions()).toBe(0);
    c.clock.now += 13 * 3_600_000;
    expect(await c.security.cleanupSessions()).toBe(2);
  });

  it("the daily retention job deletes sessions past the idle limit", async () => {
    await login("member@7d.test");
    const storage = new LocalStorage(path.join(c.dir, "storage"));
    expect((await runRetention(c.handle.db, storage)).entries.find((e) => e.category === "sessions")).toBeUndefined();
    const r = await runRetention(c.handle.db, storage, new Date(Date.now() + 13 * 3_600_000));
    expect(r.entries.find((e) => e.category === "sessions")?.count).toBe(1);
    expect(await c.handle.db.select().from(tokens).where(eq(tokens.kind, "session"))).toHaveLength(0);
  });

  it("ends the other sessions when the password changes", async () => {
    const a = session(await login("member@7d.test"));
    const b = session(await login("member@7d.test"));
    const changed = await call("POST", "/auth/password", { cookie: a, payload: { currentPassword: PW, newPassword: "Yeni-Sifre-2026x" } });
    expect(changed.body).toEqual({ ok: true, otherSessionsEnded: 1 });
    expect((await call("GET", "/auth/me", { cookie: a })).status).toBe(200);
    expect((await call("GET", "/auth/me", { cookie: b })).status).toBe(401);
  });

  it("signs out everywhere (the user, and a system administrator for another user)", async () => {
    const a = session(await login("member@7d.test"));
    const b = session(await login("member@7d.test"));
    const list = await call("GET", "/auth/sessions", { cookie: a });
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await call("POST", "/auth/sessions/end-all", { cookie: a })).body).toEqual({ ended: 2 });
    expect((await call("GET", "/auth/me", { cookie: a })).status).toBe(401);
    expect((await call("GET", "/auth/me", { cookie: b })).status).toBe(401);

    const m = session(await login("member@7d.test"));
    const admin = session(await login("admin@7d.test"));
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    expect((await call("POST", `/admin/users/${member!.id}/sessions/end`, { cookie: m })).status).toBe(403);
    expect((await call("POST", `/admin/users/${member!.id}/sessions/end`, { cookie: admin })).body).toEqual({ ended: 1 });
    expect((await call("GET", "/auth/me", { cookie: m })).status).toBe(401);
    expect((await auditActions("auth.sessions_ended")).map((r) => r.targetId)).toEqual([member!.id, member!.id]);
  });

  it("an administrator's new password for someone ends their sessions", async () => {
    const m = session(await login("member@7d.test"));
    const admin = session(await login("admin@7d.test"));
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    expect((await call("PATCH", `/users/${member!.id}`, { cookie: admin, payload: { password: "Yeni-Sifre-2026x" } })).status).toBe(200);
    expect((await call("GET", "/auth/me", { cookie: m })).status).toBe(401);
    expect((await call("GET", "/auth/me", { cookie: admin })).status).toBe(200);
  });
});

describe("G-5 password rules", () => {
  it("refuses common passwords, the person's name or address, and short ones", () => {
    expect(isCommonPassword("Password123")).toBe(true);
    expect(isCommonPassword("qwertyuiop")).toBe(true);
    expect(passwordProblem("short")?.key).toBe("errors:passwordTooShort");
    expect(passwordProblem("password123")?.key).toBe("errors:passwordCommon");
    expect(passwordProblem("Hasan-Kuzey-2026", { name: "Hasan Kuzey" })?.key).toBe("errors:passwordPersonal");
    expect(passwordProblem("ozdemir.ofis-71", { email: "Ozdemir@7d.test" })?.key).toBe("errors:passwordPersonal");
    expect(passwordProblem("Mavi-Kule-Yapi-71", { email: "ozdemir@7d.test", name: "Ali Öz" })).toBeNull();
    // The provisioning password stays possible for administrators ("change at first sign-in").
    expect(passwordProblem(PROVISION_PASSWORD)).toBeNull();
  });

  it("applies them on the password change, user creation and invitation accept", async () => {
    const cookie = session(await login("member@7d.test"));
    const common = await call("POST", "/auth/password", { cookie, payload: { currentPassword: PW, newPassword: "basketball" } });
    expect(common.status).toBe(400);
    expect(common.body.message).toContain("common");
    const personal = await call("POST", "/auth/password", { cookie, payload: { currentPassword: PW, newPassword: "Member-Gizli-77" } });
    expect(personal.status).toBe(400);
    const admin = session(await login("admin@7d.test"));
    expect((await call("POST", "/users", { cookie: admin, payload: { email: "new@7d.test", name: "New Person", password: "1qaz2wsx3edc" } })).status).toBe(400);
    expect((await call("POST", "/users", { cookie: admin, payload: { email: "new@7d.test", name: "New Person", password: PROVISION_PASSWORD } })).status).toBe(200);
  });
});

describe("G-2 two-factor authentication", () => {
  const codeAt = (secret: string, offsetSteps = 0) => totpCode(secret, totpStep() + offsetSteps);

  async function enable(cookie: string) {
    const setup = await call("POST", "/auth/two-factor/setup", { cookie });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/SiteKeep:/);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const enabled = await call("POST", "/auth/two-factor/enable", { cookie, payload: { code: codeAt(setup.body.secret) } });
    expect(enabled.status).toBe(200);
    return { secret: setup.body.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[] };
  }

  it("TOTP matches RFC 6238 test vectors (SHA-1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    // RFC 6238 Appendix B, T = 59 s → 94287082 (8 digits); the last 6 digits are the 6-digit code.
    expect(totpCode(secret, 1)).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(verifyTotp(secret, "287082", null, 59_000)).toBe(1);
    expect(verifyTotp(secret, "287082", 1, 59_000)).toBeNull();
  });

  it("enrols with a QR code, then signs in with a code or a recovery code as a second step", async () => {
    const cookie = session(await login("member@7d.test"));
    const { secret, recoveryCodes } = await enable(cookie);
    expect(recoveryCodes).toHaveLength(10);
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    const [row] = await c.handle.db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, member!.id));
    expect(row!.secret.startsWith("aesgcm1:")).toBe(true);
    expect(row!.secret).not.toContain(secret);
    expect(row!.recoveryCodes).not.toContain(recoveryCodes[0]);
    expect((await call("GET", "/auth/two-factor", { cookie })).body).toMatchObject({ enabled: true, required: false, recoveryCodesLeft: 10 });

    // Password alone gives no session, only the second step.
    const first = await login("member@7d.test");
    expect(first.body).toEqual({ twoFactor: "verify" });
    expect(cookieOf(first, "cde_session")).toBeUndefined();
    const challenge = `cde_2fa=${cookieOf(first, "cde_2fa")}`;
    expect((await call("GET", "/auth/two-factor/challenge", { cookie: challenge })).body).toEqual({ twoFactor: "verify" });
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code: "000000" } })).status).toBe(401);
    // The enrolment code's step was used: the next step's code works, once.
    const code = codeAt(secret, 1);
    const ok = await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code } });
    expect(ok.status).toBe(200);
    expect(ok.body.email).toBe("member@7d.test");
    expect((await call("GET", "/auth/me", { cookie: session(ok) })).status).toBe(200);
    const replay = await call("POST", "/auth/two-factor/challenge/verify", { cookie: `cde_2fa=${cookieOf(await login("member@7d.test"), "cde_2fa")}`, payload: { code } });
    expect(replay.status).toBe(401);

    // A recovery code works once.
    const again = `cde_2fa=${cookieOf(await login("member@7d.test"), "cde_2fa")}`;
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: again, payload: { recoveryCode: recoveryCodes[0]!.toUpperCase() } })).status).toBe(200);
    const reuse = `cde_2fa=${cookieOf(await login("member@7d.test"), "cde_2fa")}`;
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: reuse, payload: { recoveryCode: recoveryCodes[0] } })).status).toBe(401);
    expect((await call("GET", "/auth/two-factor", { cookie })).body.recoveryCodesLeft).toBe(9);

    const logins = await auditActions("auth.login");
    expect(logins.map((r) => (r.details as { twoFactor?: string } | null)?.twoFactor).filter(Boolean)).toEqual(["totp", "recovery"]);
  });

  it("refuses a forged or missing second-step cookie", async () => {
    const cookie = session(await login("member@7d.test"));
    await enable(cookie);
    const first = await login("member@7d.test");
    const value = cookieOf(first, "cde_2fa")!;
    const [payload, mac] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), userId: "00000000-0000-0000-0000-000000000000" })).toString("base64url");
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: `cde_2fa=${forged}.${mac}`, payload: { code: "123456" } })).body.error).toBe("two_factor_no_challenge");
    expect((await call("POST", "/auth/two-factor/challenge/verify", { payload: { code: "123456" } })).status).toBe(401);
  });

  it("locks the second step after 10 wrong codes", async () => {
    await enable(session(await login("member@7d.test")));
    const challenge = `cde_2fa=${cookieOf(await login("member@7d.test"), "cde_2fa")}`;
    for (let i = 0; i < 10; i++) await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code: "000000" } });
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code: "000000" } })).status).toBe(429);
    // The right password does not clear the account's count while a second step follows.
    expect((await login("member@7d.test")).status).toBe(429);
  });

  it("requires two-factor for administrators: enrol at the next sign-in, cannot turn it off", async () => {
    const admin = session(await login("admin@7d.test"));
    expect((await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { requireTwoFactor: "admins" } })).status).toBe(200);
    // Members are not affected.
    expect(cookieOf(await login("member@7d.test"), "cde_session")).toBeDefined();

    const first = await login("admin@7d.test");
    expect(first.body).toEqual({ twoFactor: "enrol" });
    const challenge = `cde_2fa=${cookieOf(first, "cde_2fa")}`;
    // A "verify" step does not exist yet; codes before the set-up fail.
    expect((await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code: "123456" } })).status).toBe(401);
    const setup = await call("POST", "/auth/two-factor/challenge/enrol", { cookie: challenge });
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    const done = await call("POST", "/auth/two-factor/challenge/verify", { cookie: challenge, payload: { code: codeAt(setup.body.secret) } });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    const cookie = session(done);
    expect((await call("GET", "/auth/two-factor", { cookie })).body).toMatchObject({ enabled: true, required: true });
    const off = await call("POST", "/auth/two-factor/disable", { cookie, payload: { code: codeAt(setup.body.secret, 1) } });
    expect(off.status).toBe(403);
    expect(await auditActions("auth.two_factor_enabled")).toHaveLength(1);
  });

  it("requires it for everyone, including a person accepting an invitation", async () => {
    const admin = session(await login("admin@7d.test"));
    await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { requireTwoFactor: "all" } });
    const [pending] = await c.handle.db.insert(users).values({ email: "invited@7d.test", name: "Invited", passwordHash: await hashPassword(PW), pending: true, disabled: true }).returning();
    const token = "7dcde_invite_" + "x".repeat(43);
    const { hashToken } = await import("../../src/core/security/auth.js");
    await c.handle.db.insert(invitations).values({ userId: pending!.id, email: "invited@7d.test", tokenHash: hashToken(token), language: "en", expiresAt: new Date(Date.now() + 86_400_000) });
    const accepted = await call("POST", "/invitations/accept", { payload: { token, name: "Ivy Newcomer", password: "Mavi-Kule-Yapi-71" } });
    expect(accepted.body).toEqual({ twoFactor: "enrol" });
    expect(cookieOf(accepted, "cde_session")).toBeUndefined();
    expect(cookieOf(accepted, "cde_2fa")).toBeDefined();
  });

  it("disables with a code, regenerates recovery codes; an administrator resets someone's two-factor (audited)", async () => {
    const cookie = session(await login("member@7d.test"));
    const { secret } = await enable(cookie);
    expect((await call("POST", "/auth/two-factor/recovery-codes", { cookie, payload: { code: "000000" } })).status).toBe(400);
    const codes = await call("POST", "/auth/two-factor/recovery-codes", { cookie, payload: { code: codeAt(secret, 1) } });
    expect(codes.body.recoveryCodes).toHaveLength(10);
    expect((await call("POST", "/auth/two-factor/disable", { cookie, payload: { recoveryCode: codes.body.recoveryCodes[0] } })).status).toBe(200);
    expect((await call("GET", "/auth/two-factor", { cookie })).body.enabled).toBe(false);
    expect(await auditActions("auth.two_factor_disabled")).toHaveLength(1);

    await enable(cookie);
    const admin = session(await login("admin@7d.test"));
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    const list = await call("GET", "/users", { cookie: admin });
    expect(list.body.find((u: { id: string }) => u.id === member!.id).twoFactor).toBe(true);
    expect((await call("DELETE", `/admin/users/${member!.id}/two-factor`, { cookie })).status).toBe(403);
    expect((await call("DELETE", `/admin/users/${member!.id}/two-factor`, { cookie: admin })).body).toEqual({ ok: true, removed: true });
    expect((await call("GET", "/auth/me", { cookie })).status).toBe(401);
    const reset = await auditActions("auth.two_factor_reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]!.targetId).toBe(member!.id);
    expect(cookieOf(await login("member@7d.test"), "cde_session")).toBeDefined();
  });

  it("anonymising a user deletes their TOTP secret and recovery codes", async () => {
    await enable(session(await login("member@7d.test")));
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    expect(await c.handle.db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, member!.id))).toHaveLength(1);
    const admin = session(await login("admin@7d.test"));
    const res = await call("POST", `/admin/users/${member!.id}/anonymise`, { cookie: admin, payload: { confirmEmail: "member@7d.test" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await c.handle.db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, member!.id))).toHaveLength(0);
  });

  it("does not affect API tokens", async () => {
    const cookie = session(await login("admin@7d.test"));
    const token = await call("POST", "/auth/tokens", { cookie, payload: { name: "script", scope: "read" } });
    expect(token.status).toBe(200);
    await enable(cookie);
    const res = await c.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token.body.token}` } });
    expect(res.statusCode).toBe(200);
    // …and API tokens cannot manage two-factor or sessions.
    const setup = await c.app.inject({ method: "POST", url: "/api/v1/auth/sessions/end-all", headers: { authorization: `Bearer ${token.body.token}` } });
    expect(setup.statusCode).toBe(403);
  });

  it("keeps personal data of failed attempts out of the chained row", async () => {
    await login("someone@7d.test", "wrong-password-1");
    const [row] = await auditActions("auth.login_failed");
    expect(JSON.stringify(row!.details)).not.toContain("someone@7d.test");
    const personal = await c.handle.db.select().from(auditPersonal).where(eq(auditPersonal.auditId, row!.id));
    expect(personal[0]?.email).toBe("someone@7d.test");
  });
});
