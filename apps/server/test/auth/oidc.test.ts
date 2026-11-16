/**
 * Sign-in with OpenID Connect (docs/features/OIDC_SIGN_IN.md) against a local mock provider
 * (test/helpers/mock-oidc.ts; fetch is routed to it, no network): discovery, PKCE, state and nonce,
 * ID token validation, account linking and creation, the domain list, two-factor after the provider,
 * the Privacy Centre switch and the administrator's API.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { amrShowsMfa, emailAllowedForOidc, normalizeIssuer, normalizeOidcScopes } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { encryptSecret } from "../../src/core/platform/secrets.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, companies, invitations, outboundLog, privacyNoticeAcceptances, users, userTwoFactor } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { forgetOidcCache } from "../../src/auth/oidc.js";
import { getOidcProviders } from "../../src/auth/oidc-settings.js";
import { newTotpSecret, totpCode, totpStep } from "../../src/auth/totp.js";
import { MockOidcProvider } from "../helpers/mock-oidc.js";

const PW = "Sifre-1234567";
const ISSUER = "https://login.example.test/realms/site";
const BASE = "http://localhost:5173";

let app: FastifyInstance;
let handle: DbHandle;
let dataDir: string;
let idp: MockOidcProvider;
let admin: string;
const secretKey = randomBytes(32);

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, opts: { cookie?: string; payload?: unknown } = {}) {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: opts.payload as never, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), host: "localhost:5173" } });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body, res };
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;

const provider = (over: Record<string, unknown> = {}) => ({
  id: "keycloak",
  name: "Site Keycloak",
  issuer: `${ISSUER}/`,
  clientId: idp.clientId,
  clientSecret: idp.clientSecret,
  buttonLabel: "Sign in with Keycloak",
  buttonColor: "#123ABC",
  ...over,
});

async function addProvider(over: Record<string, unknown> = {}) {
  const res = await call("POST", "/admin/oidc-providers", { cookie: admin, payload: provider(over) });
  expect(res.status, res.raw).toBe(200);
  return res.body;
}

/** The whole browser round trip: start → provider → callback. Returns the callback's answer. */
async function signIn(id = "keycloak", opts: { state?: string; dropCookie?: boolean } = {}) {
  const start = await app.inject({ method: "GET", url: `/api/v1/auth/oidc/${id}/start`, headers: { host: "localhost:5173" } });
  expect(start.statusCode, start.body).toBe(302);
  const flow = cookieOf(start, "cde_oidc");
  const back = new URL(idp.authorize(start.headers.location!));
  if (opts.state) back.searchParams.set("state", opts.state);
  const res = await app.inject({
    method: "GET",
    url: `${back.pathname}${back.search}`,
    headers: { host: "localhost:5173", ...(flow && !opts.dropCookie ? { cookie: `cde_oidc=${flow}` } : {}) },
  });
  return { start, res, location: res.headers.location as string, session: cookieOf(res, "cde_session"), challenge: cookieOf(res, "cde_2fa") };
}

async function lastAudit(action: string) {
  const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1);
  return row;
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-oidc-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey });
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
    { email: "ayse@site.example", name: "Ayşe", passwordHash: await hashPassword(PW) },
  ]);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  admin = `cde_session=${cookieOf(login, "cde_session")}`;
  idp = await MockOidcProvider.create({ issuer: ISSUER });
  idp.user = { sub: "kc-ayse", email: "Ayse@Site.example", email_verified: true, name: "Ayşe Yılmaz" };
  forgetOidcCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(ISSUER)) return idp.handle(input as string, init);
    throw new Error(`unexpected network call: ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("shared rules", () => {
  it("issuer, scopes, domains and amr", () => {
    expect(normalizeIssuer("https://idp.example.com/realms/a/")).toBe("https://idp.example.com/realms/a");
    expect(normalizeIssuer("http://idp.example.com")).toBeNull();
    expect(normalizeIssuer("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(normalizeIssuer("https://idp.example.com/?x=1")).toBeNull();
    expect(normalizeOidcScopes("email profile groups email")).toBe("openid email profile groups");
    expect(emailAllowedForOidc("a@mail.site.example", ["site.example"])).toBe(true);
    expect(emailAllowedForOidc("a@notsite.example", ["site.example"])).toBe(false);
    expect(emailAllowedForOidc("a@any.example", [])).toBe(true);
    expect(amrShowsMfa(["pwd", "mfa"])).toBe(true);
    expect(amrShowsMfa(["pwd", "otp"])).toBe(true);
    expect(amrShowsMfa(["pwd"])).toBe(false);
    expect(amrShowsMfa(["pwd", "kba"])).toBe(false);
    expect(amrShowsMfa(undefined)).toBe(false);
  });
});

describe("administration", () => {
  it("adds a provider with an encrypted secret, never returns the secret, and audits the change", async () => {
    const list = await addProvider();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "keycloak",
      issuer: ISSUER,
      hasClientSecret: true,
      scopes: "openid email profile",
      buttonColor: "#123abc",
      createAccounts: false,
      trustUnverifiedEmail: false,
      trustProviderMfa: false,
      adminGroup: null,
      redirectUri: `${BASE}/api/v1/auth/oidc/keycloak/callback`,
    });
    expect(JSON.stringify(list)).not.toContain(idp.clientSecret!);
    const [stored] = await getOidcProviders(handle.db);
    expect(stored!.clientSecretEnc).toMatch(/^aesgcm1:/);
    expect((await lastAudit("auth.oidc_provider_created"))!.details).toMatchObject({ id: "keycloak", issuer: ISSUER });

    // Editing without a secret keeps it; the id cannot change.
    const edited = await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: { ...provider({ id: "other", name: "Renamed" }), clientSecret: undefined } });
    expect(edited.status, edited.raw).toBe(200);
    expect(edited.body[0]).toMatchObject({ id: "keycloak", name: "Renamed", hasClientSecret: true });

    expect((await call("POST", "/admin/oidc-providers", { cookie: admin, payload: provider() })).status).toBe(409);
    expect((await call("POST", "/admin/oidc-providers", { cookie: admin, payload: provider({ id: "x", issuer: "http://idp.example.com" }) })).status).toBe(400);
    expect((await call("POST", "/admin/oidc-providers", { cookie: admin, payload: provider({ id: "y", buttonColor: "red" }) })).status).toBe(400);

    const test = await call("POST", "/admin/oidc-providers/keycloak/test", { cookie: admin });
    expect(test.status, test.raw).toBe(200);
    expect(test.body).toMatchObject({ ok: true, issuer: ISSUER, algorithms: ["RS256"] });

    expect((await call("DELETE", "/admin/oidc-providers/keycloak", { cookie: admin })).body).toEqual([]);
    expect(await lastAudit("auth.oidc_provider_deleted")).toBeTruthy();
  });

  it("is for system administrators only", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ayse@site.example", password: PW } });
    const user = `cde_session=${cookieOf(login, "cde_session")}`;
    expect((await call("GET", "/admin/oidc-providers", { cookie: user })).status).toBe(403);
    expect((await call("POST", "/admin/oidc-providers", { cookie: user, payload: provider() })).status).toBe(403);
  });
});

describe("the sign-in flow", () => {
  it("offers the button, sends PKCE, state and nonce, and signs an existing user in (auth.oidc_login)", async () => {
    await addProvider();
    expect((await call("GET", "/auth/methods")).body.oidc).toEqual([{ id: "keycloak", label: "Sign in with Keycloak", color: "#123abc" }]);

    const { start, location, session } = await signIn();
    const auth = new URL(start.headers.location!);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("state")).toHaveLength(43);
    expect(auth.searchParams.get("nonce")).toHaveLength(43);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${BASE}/api/v1/auth/oidc/keycloak/callback`);
    expect(location).toBe("/");
    expect(session).toBeTruthy();
    const me = await call("GET", "/auth/me", { cookie: `cde_session=${session}` });
    expect(me.body.email).toBe("ayse@site.example");
    const [u] = await handle.db.select().from(users).where(eq(users.email, "ayse@site.example"));
    expect((await lastAudit("auth.oidc_login"))).toMatchObject({ userId: u!.id, details: { provider: "keycloak" } });

    // Each call went through the provider's own connection; discovery and keys are cached.
    const logged = await handle.db.select().from(outboundLog).where(eq(outboundLog.connection, "oidc:keycloak"));
    expect(logged.map((r) => r.purpose)).toEqual(expect.arrayContaining(["giris:oidc"]));
    const before = idp.requests.length;
    await signIn();
    expect(idp.requests.slice(before).map((r) => new URL(r).pathname)).toEqual(["/realms/site/token"]);
  });

  it("refuses a wrong or missing state", async () => {
    await addProvider();
    expect((await signIn("keycloak", { state: "forged" })).location).toBe("/login?authError=oidc_invalid_state");
    expect((await signIn("keycloak", { dropCookie: true })).location).toBe("/login?authError=oidc_invalid_state");
  });

  it("refuses an ID token with a wrong nonce, issuer, audience, signature, algorithm or expiry", async () => {
    await addProvider();
    const cases = [
      [{ nonce: "replayed" }, "id_token_nonce"],
      [{ iss: "https://evil.example.test" }, "id_token_invalid"],
      [{ aud: "another-client" }, "id_token_invalid"],
      [{ aud: [idp.clientId, "another"], azp: "another" }, "id_token_azp"],
      [{ foreignKey: true }, "id_token_invalid"],
      [{ alg: "none" }, "id_token_invalid"],
      [{ alg: "HS256" }, "id_token_invalid"],
      [{ expiresIn: -600 }, "id_token_invalid"],
    ] as const;
    for (const [tamper, reason] of cases) {
      idp.tamper = { ...tamper } as never;
      const r = await signIn();
      expect(r.location, JSON.stringify(tamper)).toBe("/login?authError=oidc_failed");
      expect(r.session).toBeUndefined();
      expect((await lastAudit("auth.login_failed"))!.details, JSON.stringify(tamper)).toMatchObject({ provider: "oidc:keycloak", reason });
    }
  });

  it("downloads the keys again when the provider rotated them", async () => {
    await addProvider();
    expect((await signIn()).session).toBeTruthy();
    await idp.rotateKeys();
    expect((await signIn()).session).toBeTruthy();
    expect(idp.requests.filter((r) => r.endsWith("/jwks"))).toHaveLength(2);
  });

  it("reads the address from userinfo when the ID token has none (same subject)", async () => {
    await addProvider();
    idp.tamper = { emailOnlyInUserinfo: true };
    const r = await signIn();
    expect(r.location, JSON.stringify((await lastAudit("auth.login_failed"))?.details)).toBe("/");
    expect(idp.requests.some((r) => r.endsWith("/userinfo"))).toBe(true);
  });

  it("works with a public client (PKCE only, no secret)", async () => {
    idp = await MockOidcProvider.create({ issuer: ISSUER, clientSecret: null, authMethods: ["none"] });
    idp.user = { sub: "kc-ayse", email: "ayse@site.example", email_verified: true };
    const list = await addProvider();
    expect(list[0].hasClientSecret).toBe(false);
    expect((await signIn()).session).toBeTruthy();
  });

  it("refuses an address the provider has not verified, unless the administrator trusts it", async () => {
    await addProvider();
    idp.user = { ...idp.user, email_verified: false };
    const r = await signIn();
    expect(r.location).toBe("/login?authError=oidc_email_not_verified");
    const row = await lastAudit("auth.login_failed");
    // The address is kept only as its hash in the row (personal part of the log).
    expect(row!.details).toMatchObject({ provider: "oidc:keycloak", reason: "email_not_verified", emailHash: expect.any(String) });
    expect(JSON.stringify(row!.details)).not.toContain("ayse@site.example");

    await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: provider({ trustUnverifiedEmail: true }) });
    expect((await signIn()).session).toBeTruthy();
  });

  it("applies the allowed domains", async () => {
    await addProvider({ allowedDomains: ["@Other.example"] });
    expect((await signIn()).location).toBe("/login?authError=oidc_domain_not_allowed");
    await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: provider({ allowedDomains: ["site.example"] }) });
    expect((await signIn()).session).toBeTruthy();
  });

  it("does not create accounts by default; with creation on, the new account gets the default company (and admin by group)", async () => {
    await addProvider();
    idp.user = { sub: "kc-new", email: "new@site.example", email_verified: true, name: "Yeni Kişi", groups: ["staff", "sitekeep-admins"] };
    expect((await signIn()).location).toBe("/login?authError=oidc_account_not_allowed");
    expect(await handle.db.select().from(users).where(eq(users.email, "new@site.example"))).toHaveLength(0);
    expect((await lastAudit("auth.login_failed"))!.details).toMatchObject({ reason: "no_account" });

    const [company] = await handle.db.insert(companies).values({ name: "Saha A.Ş.", code: "SAH" }).returning();
    await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: provider({ createAccounts: true, defaultCompanyId: company!.id }) });
    const r = await signIn();
    expect(r.session).toBeTruthy();
    const [created] = await handle.db.select().from(users).where(eq(users.email, "new@site.example"));
    expect(created).toMatchObject({ name: "Yeni Kişi", companyId: company!.id, isAdmin: false });
    expect((await lastAudit("auth.oidc_login"))!.details).toMatchObject({ provider: "keycloak", provisioned: true });

    // The admin group: off by default; when set, members become system administrators at sign-in.
    await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: provider({ createAccounts: true, adminGroup: "sitekeep-admins" }) });
    await signIn();
    const [promoted] = await handle.db.select().from(users).where(eq(users.email, "new@site.example"));
    expect(promoted!.isAdmin).toBe(true);
  });

  it("accepts the open invitation of an invited person", async () => {
    await addProvider();
    const [pending] = await handle.db
      .insert(users)
      .values({ email: "davetli@site.example", name: "davetli", passwordHash: await hashPassword(PW), pending: true, disabled: false })
      .returning();
    const [adminRow] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    await handle.db.insert(invitations).values({
      userId: pending!.id,
      email: pending!.email,
      tokenHash: "x".repeat(64),
      invitedBy: adminRow!.id,
      language: "tr",
      expiresAt: new Date(Date.now() + 86400_000),
    } as never);
    idp.user = { sub: "kc-davetli", email: "davetli@site.example", email_verified: true, name: "Davetli Kişi" };
    const r = await signIn();
    expect(r.session).toBeTruthy();
    const [active] = await handle.db.select().from(users).where(eq(users.id, pending!.id));
    expect(active).toMatchObject({ pending: false, name: "Davetli Kişi" });
    const [inv] = await handle.db.select().from(invitations).where(eq(invitations.userId, pending!.id));
    expect(inv!.acceptedAt).toBeTruthy();
    expect((await lastAudit("auth.oidc_login"))!.details).toMatchObject({ invitation: true });
  });

  it("refuses a disabled account", async () => {
    await addProvider();
    await handle.db.update(users).set({ disabled: true }).where(eq(users.email, "ayse@site.example"));
    expect((await signIn()).location).toBe("/login?authError=oidc_account_not_allowed");
  });
});

describe("two-factor after the provider", () => {
  async function enableTwoFactor(email: string) {
    const [u] = await handle.db.select().from(users).where(eq(users.email, email));
    const secret = newTotpSecret();
    await handle.db.insert(userTwoFactor).values({ userId: u!.id, secret: encryptSecret(secretKey, secret), enabledAt: new Date(), recoveryCodes: [] });
    return { user: u!, secret };
  }

  it("asks for the code after the provider, then audits auth.oidc_login with the second factor", async () => {
    await addProvider();
    const { user, secret } = await enableTwoFactor("ayse@site.example");
    const r = await signIn();
    expect(r.location).toBe("/login?twoFactor=1");
    expect(r.session).toBeUndefined();
    expect(r.challenge).toBeTruthy();
    const ok = await call("POST", "/auth/two-factor/challenge/verify", { cookie: `cde_2fa=${r.challenge}`, payload: { code: totpCode(secret, totpStep()) } });
    expect(ok.status, ok.raw).toBe(200);
    expect(await lastAudit("auth.oidc_login")).toMatchObject({ userId: user.id, details: { provider: "keycloak", twoFactor: "totp" } });
  });

  it("an administrator rule (everyone) makes the person enrol after the provider", async () => {
    await addProvider();
    expect((await call("PUT", "/admin/sign-in-security", { cookie: admin, payload: { requireTwoFactor: "all" } })).status).toBe(200);
    const r = await signIn();
    expect(r.location).toBe("/login?twoFactor=1");
    expect((await call("GET", "/auth/two-factor/challenge", { cookie: `cde_2fa=${r.challenge}` })).body).toEqual({ twoFactor: "enrol" });
  });

  it("skips the step only when the provider asserts MFA (amr) and the administrator trusts it", async () => {
    await addProvider();
    await enableTwoFactor("ayse@site.example");
    idp.user = { ...idp.user, amr: ["pwd", "mfa"] };
    expect((await signIn()).location).toBe("/login?twoFactor=1");

    await call("PUT", "/admin/oidc-providers/keycloak", { cookie: admin, payload: provider({ trustProviderMfa: true }) });
    const trusted = await signIn();
    expect(trusted.session).toBeTruthy();
    expect((await lastAudit("auth.oidc_login"))!.details).toMatchObject({ providerMfa: true });

    idp.user = { ...idp.user, amr: ["pwd"] };
    expect((await signIn()).location).toBe("/login?twoFactor=1");
  });
});

describe("the Privacy Centre", () => {
  it("lists each provider as its own connection; switched off, the button goes and every step is refused", async () => {
    await addProvider();
    const list = await call("GET", "/admin/privacy/connections", { cookie: admin });
    const c = list.body.find((x: any) => x.id === "oidc:keycloak");
    expect(c).toMatchObject({ kind: "auth", host: "login.example.test", location: "external", enabled: true, toggleable: true });

    expect((await call("PUT", "/admin/privacy/connections/oidc:keycloak", { cookie: admin, payload: { enabled: false } })).status).toBe(200);
    expect((await call("GET", "/auth/methods")).body.oidc).toEqual([]);
    const before = idp.requests.length;
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/keycloak/start" });
    expect(start.headers.location).toBe("/login?authError=oidc_disabled");
    const cb = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/keycloak/callback?code=x&state=y" });
    expect(cb.headers.location).toBe("/login?authError=oidc_disabled");
    expect(idp.requests.length).toBe(before);

    // An unknown provider id cannot be switched.
    expect((await call("PUT", "/admin/privacy/connections/oidc:nope", { cookie: admin, payload: { enabled: false } })).status).toBe(400);
    expect((await call("PUT", "/admin/privacy/connections/oidc:keycloak", { cookie: admin, payload: { enabled: true } })).status).toBe(200);
    expect((await signIn()).session).toBeTruthy();
  });

  it("a provider turned off in the administration has no button and refuses the flow", async () => {
    await addProvider({ enabled: false });
    expect((await call("GET", "/auth/methods")).body.oidc).toEqual([]);
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/keycloak/start" });
    expect(start.headers.location).toBe("/login?authError=oidc_disabled");
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/oidc/missing/start" })).statusCode).toBe(404);
  });
});

describe("the privacy notice (docs/features/PRIVACY_NOTICE.md)", () => {
  /** start (optionally with the ticked version) → provider → callback, carrying every cookie the start set. */
  async function signInWithNotice(notice?: number) {
    const start = await app.inject({ method: "GET", url: `/api/v1/auth/oidc/keycloak/start${notice ? `?notice=${notice}` : ""}`, headers: { host: "localhost:5173" } });
    expect(start.statusCode, start.body).toBe(302);
    const cookies = start.cookies.filter((k) => k.value).map((k) => `${k.name}=${k.value}`).join("; ");
    const back = new URL(idp.authorize(start.headers.location!));
    const res = await app.inject({ method: "GET", url: `${back.pathname}${back.search}`, headers: { host: "localhost:5173", cookie: cookies } });
    return { location: res.headers.location as string, session: cookieOf(res, "cde_session") };
  }

  it("is required before an OpenID Connect sign-in when the administrator asks for it, and recorded once", async () => {
    await addProvider();
    const saved = await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { enabled: true, requireAck: true, text: { en: "Notice", tr: "" } } });
    expect(saved.status, saved.raw).toBe(200);

    const refused = await signInWithNotice();
    expect(refused.location).toBe("/login?authError=privacy_notice_required");
    expect(refused.session).toBeFalsy();

    const ok = await signInWithNotice(1);
    expect(ok.location).toBe("/");
    expect(ok.session).toBeTruthy();
    const [u] = await handle.db.select().from(users).where(eq(users.email, "ayse@site.example"));
    expect(await handle.db.select().from(privacyNoticeAcceptances)).toEqual([expect.objectContaining({ userId: u!.id, version: 1, via: "oidc" })]);
    expect((await lastAudit("privacy.notice_accepted"))!.details).toEqual({ version: 1, via: "oidc" });
  });
});
