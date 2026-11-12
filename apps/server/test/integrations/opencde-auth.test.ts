/**
 * OpenCDE Foundation API 1.1 and the built-in OAuth2 authorization server (docs/features/OPENCDE.md).
 */
import { hasAi } from "../helpers/modules.js"; // the MCP endpoint is the AI module's
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp, redactUrl } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, oauthCodes, tokens, users } from "../../src/db/schema.js";
import { redactSecrets } from "../../src/core/platform/error-ring.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { FailureLimiter } from "../../src/oauth/rate-limit.js";
import { matchRegisteredRedirect, redirectUriProblem } from "../../src/oauth/redirect.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

// ---- Small JSON Schema check (draft-03 style, as the Foundation API schemas are written) ---------

type Schema = { type?: string | string[]; required?: boolean; properties?: Record<string, Schema>; items?: Schema };

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function validate(schema: Schema, value: unknown, at = "$"): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!allowed.includes(t) && !(t === "integer" && allowed.includes("number"))) return [`${at}: ${t} is not ${allowed.join("|")}`];
  }
  if (schema.properties && value && typeof value === "object") {
    for (const [k, s] of Object.entries(schema.properties)) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) {
        if (s.required) errors.push(`${at}.${k}: required`);
      } else errors.push(...validate(s, v, `${at}.${k}`));
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${at}[${i}]`)));
  return errors;
}

/** Shapes from foundation-API release_1_1/schemas (versions_GET, auth_GET, user_GET, error). */
const SCHEMAS = {
  versions: {
    type: "object",
    properties: {
      versions: {
        type: "array",
        required: true,
        items: {
          type: ["object", "null"],
          properties: {
            api_id: { type: "string", required: true },
            version_id: { type: "string", required: true },
            detailed_version: { type: "string" },
            api_base_url: { type: "string" },
          },
        },
      },
    },
  },
  auth: {
    type: "object",
    properties: {
      oauth2_auth_url: { type: ["string", "null"] },
      oauth2_token_url: { type: ["string", "null"] },
      oauth2_dynamic_client_reg_url: { type: ["string", "null"] },
      http_basic_supported: { type: ["boolean", "null"] },
      // "required: true" in the README table.
      supported_oauth2_flows: { type: ["array", "null"], required: true, items: { type: "string" } },
    },
  },
  user: { type: "object", properties: { id: { type: "string", required: true }, name: { type: ["string", "null"] } } },
  error: { type: "object", properties: { message: { type: "string", required: true } } },
} satisfies Record<string, Schema>;

// ---- Test app ---------------------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const logLines: string[] = [];
const PW = "Sifre-1234567";
const BASE = "http://localhost:80";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-oauth-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    oauth: { publicUrl: null, authUrl: null, tokenUrl: null, apis: [], tokenFailureLimit: 10_000 },
    logger: true,
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    }),
  });
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

type Auth = { cookie: string } | { bearer: string };
function api(auth: Auth) {
  const headers = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.bearer}` };
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p: unknown = {}) => call("POST", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(params: Record<string, string>, cookie?: string) {
  const res = await app.inject({ method: "GET", url: `/oauth2/authorize?${new URLSearchParams(params)}`, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, location: res.headers.location as string | undefined, body: res.body };
}

/** Decision on the consent page; returns where the browser goes next. */
async function decide(cookie: string, consentLocation: string, approve = true): Promise<string> {
  const params = Object.fromEntries(new URL(consentLocation, BASE).searchParams);
  const res = await api({ cookie }).post("/oauth/consent", { params, approve });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.redirectTo;
}

/** Full browser part: authorize, consent when asked, and the code from the redirect. */
async function getCode(cookie: string, params: Record<string, string>): Promise<{ code: string; redirect: URL }> {
  const a = await authorize(params, cookie);
  expect(a.status, a.body).toBe(302);
  let target = a.location!;
  if (target.startsWith("/oauth/consent?")) target = await decide(cookie, target);
  const redirect = new URL(target);
  const code = redirect.searchParams.get("code");
  expect(code, target).toBeTruthy();
  return { code: code!, redirect };
}

async function tokenRequest(
  params: Record<string, string>,
  opts: { basic?: [string, string]; inQuery?: boolean; app?: FastifyInstance } = {},
) {
  const form = new URLSearchParams(params).toString();
  const res = await (opts.app ?? app).inject({
    method: "POST",
    url: opts.inQuery ? `/oauth2/token?${form}` : "/oauth2/token",
    headers: {
      ...(opts.inQuery ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      ...(opts.basic ? { authorization: `Basic ${Buffer.from(`${opts.basic[0]}:${opts.basic[1]}`).toString("base64")}` } : {}),
    },
    payload: opts.inQuery ? undefined : form,
  });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

async function currentUser(token: string) {
  const res = await app.inject({ url: "/foundation/1.1/current-user", headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
}

// ---- Shared state across the ordered tests ------------------------------------------------------------

let adminCookie: string;
let aliceCookie: string;
let admin: ReturnType<typeof api>;
let projectP: string;
let projectQ: string;
/** Public desktop client (PKCE), loopback redirect. */
let solibri: { id: string; clientId: string };
/** Confidential web client. */
let portal: { id: string; clientId: string; secret: string };
const LOOP = "http://127.0.0.1/callback";
const PORTAL_CB = "https://portal.example.test/oauth/callback";

describe("OpenCDE Foundation API 1.1", () => {
  it("lists the available APIs (data-driven: Documents is live, a flag hides BCF)", async () => {
    const res = await app.inject({ url: "/foundation/versions" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const body = res.json();
    expect(validate(SCHEMAS.versions, body)).toEqual([]);
    expect(body.versions).toEqual([
      {
        api_id: "foundation",
        version_id: "1.1",
        detailed_version: "https://github.com/buildingSMART/foundation-API/tree/release_1_1",
        api_base_url: `${BASE}/foundation/1.1`,
      },
      {
        api_id: "documents",
        version_id: "1.0",
        detailed_version: "https://github.com/buildingSMART/documents-API/tree/release_1_0",
        api_base_url: `${BASE}/documents/1.0`,
      },
    ]);
  });

  it("uses CDE_PUBLIC_URL for absolute URLs and advertises flagged APIs", async () => {
    const storage = new LocalStorage(path.join(dataDir, "storage2"));
    const other = await buildApp({
      db: handle.db,
      storage,
      jobs: new JobQueue(handle.db, storage),
      oauth: { publicUrl: "https://cde.musteri.local/", apis: ["bcf"] },
    });
    try {
      const versions = (await other.inject({ url: "/foundation/versions" })).json();
      expect(validate(SCHEMAS.versions, versions)).toEqual([]);
      expect(versions.versions.map((v: { api_id: string; version_id: string; api_base_url: string }) => [v.api_id, v.version_id, v.api_base_url])).toEqual([
        ["foundation", "1.1", "https://cde.musteri.local/foundation/1.1"],
        ["bcf", "3.0", "https://cde.musteri.local/bcf/3.0"],
        ["documents", "1.0", "https://cde.musteri.local/documents/1.0"],
      ]);
      const auth = (await other.inject({ url: "/foundation/1.1/auth" })).json();
      expect(auth.oauth2_auth_url).toBe("https://cde.musteri.local/oauth2/authorize");
      expect(auth.oauth2_token_url).toBe("https://cde.musteri.local/oauth2/token");
    } finally {
      await other.close();
    }
  });

  it("describes the OAuth2 endpoints: authorization code only, no Basic, no dynamic registration", async () => {
    const res = await app.inject({ url: "/foundation/1.1/auth" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validate(SCHEMAS.auth, body)).toEqual([]);
    expect(body).toEqual({
      oauth2_auth_url: `${BASE}/oauth2/authorize`,
      oauth2_token_url: `${BASE}/oauth2/token`,
      http_basic_supported: false,
      supported_oauth2_flows: ["authorization_code_grant"],
    });
    expect("oauth2_dynamic_client_reg_url" in body).toBe(false);
  });

  it("answers CORS preflights and unknown versions with JSON errors", async () => {
    const pre = await app.inject({ method: "OPTIONS", url: "/foundation/1.1/current-user" });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toMatch(/Authorization/);
    const old = await app.inject({ url: "/foundation/1.0/auth" });
    expect(old.statusCode).toBe(404);
    expect(validate(SCHEMAS.error, old.json())).toEqual([]);
  });

  it("current-user needs a token and returns e-mail as id", async () => {
    const anon = await app.inject({ url: "/foundation/1.1/current-user" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect(validate(SCHEMAS.error, anon.json())).toEqual([]);
    expect((await currentUser("7dcde_oauth_nope")).status).toBe(401);

    adminCookie = await login("admin@7d.test");
    admin = api({ cookie: adminCookie });
    const t = await admin.post("/auth/tokens", { name: "betik" });
    expect(t.status).toBe(200);
    const me = await currentUser(t.body.token);
    expect(me.status).toBe(200);
    expect(validate(SCHEMAS.user, me.body)).toEqual([]);
    expect(me.body).toEqual({ id: "admin@7d.test", name: "Admin" });
  });
});

describe("redirect URI rules", () => {
  it("accepts https, loopback http and reverse-domain app schemes only", () => {
    expect(redirectUriProblem("https://portal.example.test/cb")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/callback")).toBeNull();
    expect(redirectUriProblem("http://localhost:8080/cb")).toBeNull();
    expect(redirectUriProblem("com.solibri.office:/oauth")).toBeNull();
    expect(redirectUriProblem("http://intranet.local/cb")).toMatch(/https/);
    expect(redirectUriProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectUriProblem("https://a.test/cb#x")).toMatch(/#/);
    expect(redirectUriProblem("https://u:p@a.test/cb")).not.toBeNull();
    expect(redirectUriProblem("yok")).not.toBeNull();
  });

  it("matches exactly, except the port of loopback URIs (RFC 8252)", () => {
    const reg = [LOOP, "https://a.test/cb"];
    expect(matchRegisteredRedirect(reg, "https://a.test/cb")).toBe(true);
    expect(matchRegisteredRedirect(reg, "https://a.test/cb/")).toBe(false);
    expect(matchRegisteredRedirect(reg, "https://a.test:8443/cb")).toBe(false);
    expect(matchRegisteredRedirect(reg, "https://evil.test/cb")).toBe(false);
    expect(matchRegisteredRedirect(reg, "http://127.0.0.1:53682/callback")).toBe(true);
    expect(matchRegisteredRedirect(reg, "http://127.0.0.1:53682/other")).toBe(false);
    expect(matchRegisteredRedirect(reg, "http://127.0.0.1:53682/callback?x=1")).toBe(false);
    expect(matchRegisteredRedirect(reg, "http://localhost:53682/callback")).toBe(false);
    expect(matchRegisteredRedirect(reg, "https://127.0.0.1:53682/callback")).toBe(false);
  });
});

describe("Yönetim → OAuth Uygulamaları", () => {
  it("sets up users and projects", async () => {
    await admin.post("/users", { email: "alice@7d.test", name: "Alice", password: PW });
    await admin.post("/users", { email: "bob@7d.test", name: "Bob", password: PW });
    projectP = (await admin.post("/projects", { code: "PRJP", name: "Proje P" })).body.id;
    projectQ = (await admin.post("/projects", { code: "PRJQ", name: "Proje Q" })).body.id;
    expect((await admin.post(`/projects/${projectP}/members`, { email: "alice@7d.test" })).status).toBe(200);
    aliceCookie = await login("alice@7d.test");
  });

  it("registers clients; the secret is shown once and stored hashed", async () => {
    const pub = await admin.post("/admin/oauth-clients", {
      name: "Solibri Office",
      type: "public",
      redirectUris: [LOOP],
      scopes: ["write", "bcf", "read"],
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.clientSecret).toBeNull();
    expect(pub.body.client).toMatchObject({ name: "Solibri Office", type: "public", scopes: ["bcf", "read", "write"], enabled: true, redirectUris: [LOOP] });
    expect(pub.body.client.clientId).toMatch(/^cde-[0-9a-f]{20}$/);
    solibri = { id: pub.body.client.id, clientId: pub.body.client.clientId };

    const conf = await admin.post("/admin/oauth-clients", {
      name: "Portal",
      description: "Firma portalı",
      type: "confidential",
      redirectUris: [PORTAL_CB, PORTAL_CB],
      scopes: ["read", "documents"],
    });
    expect(conf.status).toBe(200);
    expect(conf.body.clientSecret).toMatch(/^7dcde_secret_/);
    expect(conf.body.client.redirectUris).toEqual([PORTAL_CB]);
    portal = { id: conf.body.client.id, clientId: conf.body.client.clientId, secret: conf.body.clientSecret };

    const list = await admin.get("/admin/oauth-clients");
    expect(list.status).toBe(200);
    expect(list.body.clients.map((c: { name: string }) => c.name)).toEqual(["Portal", "Solibri Office"]);
    expect(JSON.stringify(list.body)).not.toContain(portal.secret);
    expect(JSON.stringify(list.body)).not.toMatch(/secretHash|secret_hash/);
    expect(list.body.endpoints).toMatchObject({
      baseUrl: BASE,
      versionsUrl: `${BASE}/foundation/versions`,
      authUrl: `${BASE}/oauth2/authorize`,
      tokenUrl: `${BASE}/oauth2/token`,
      configured: false,
    });
  });

  it("validates input and is admin-only", async () => {
    const bad = (body: object) => admin.post("/admin/oauth-clients", { name: "X", type: "public", redirectUris: [LOOP], scopes: ["read"], ...body });
    expect((await bad({ redirectUris: ["http://intranet.local/cb"] })).status).toBe(400);
    expect((await bad({ redirectUris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await bad({ redirectUris: [] })).status).toBe(400);
    expect((await bad({ scopes: ["admin"] })).status).toBe(400);
    expect((await bad({ type: "implicit" })).status).toBe(400);
    const alice = api({ cookie: aliceCookie });
    expect((await alice.get("/admin/oauth-clients")).status).toBe(403);
    expect((await alice.post("/admin/oauth-clients", { name: "X", type: "public", redirectUris: [LOOP], scopes: ["read"] })).status).toBe(403);
  });

  it("updates, rotates the secret and deletes", async () => {
    const temp = await admin.post("/admin/oauth-clients", { name: "Geçici", type: "confidential", redirectUris: ["https://t.test/cb"], scopes: ["read"] });
    const id = temp.body.client.id;
    const patched = await admin.patch(`/admin/oauth-clients/${id}`, { name: "Geçici 2", scopes: ["read", "bcf"], redirectUris: ["https://t.test/cb2"] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Geçici 2", scopes: ["bcf", "read"], redirectUris: ["https://t.test/cb2"] });
    const rotated = await admin.post(`/admin/oauth-clients/${id}/secret`);
    expect(rotated.body.clientSecret).toMatch(/^7dcde_secret_/);
    expect(rotated.body.clientSecret).not.toBe(temp.body.clientSecret);
    expect((await admin.post(`/admin/oauth-clients/${solibri.id}/secret`)).status).toBe(400);
    expect((await admin.del(`/admin/oauth-clients/${id}`)).status).toBe(200);
    expect((await admin.patch(`/admin/oauth-clients/${id}`, { name: "X" })).status).toBe(404);
    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["oauth.client_created", "oauth.client_updated", "oauth.client_secret_rotated", "oauth.client_deleted"]));
  });
});

describe("Authorization code + PKCE", () => {
  let accessToken: string;
  let refreshToken: string;

  it("sends the user to the login page first and back to authorize afterwards", async () => {
    const { challenge } = pkce();
    const params = { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, state: "s1", code_challenge: challenge, code_challenge_method: "S256" };
    const a = await authorize(params);
    expect(a.status).toBe(302);
    expect(a.location).toMatch(/^\/login\?next=/);
    const next = decodeURIComponent(a.location!.slice("/login?next=".length));
    expect(next.startsWith("/oauth2/authorize?")).toBe(true);
    expect(new URL(next, BASE).searchParams.get("code_challenge")).toBe(challenge);
    // A Bearer token is not a browser session: no code for it either.
    const t = await admin.post("/auth/tokens", { name: "x" });
    const viaToken = await app.inject({ url: `/oauth2/authorize?${new URLSearchParams(params)}`, headers: { authorization: `Bearer ${t.body.token}` } });
    expect(viaToken.headers.location).toMatch(/^\/login\?next=/);
  });

  it("shows the consent page, issues a code and exchanges it for tokens", async () => {
    const { verifier, challenge } = pkce();
    const params = { response_type: "code", client_id: solibri.clientId, redirect_url: LOOP, state: "xyz", scope: "bcf read", code_challenge: challenge, code_challenge_method: "S256" };
    const a = await authorize(params, aliceCookie);
    expect(a.status).toBe(302);
    expect(a.location).toMatch(/^\/oauth\/consent\?/);

    const info = await api({ cookie: aliceCookie }).get(`/oauth/authorize-info?${new URL(a.location!, BASE).searchParams}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ client: { name: "Solibri Office", type: "public" }, scopes: ["bcf", "read"], redirectUri: LOOP });
    expect(info.body.redirectTarget).toContain("127.0.0.1");

    const back = new URL(await decide(aliceCookie, a.location!));
    expect(back.origin + back.pathname).toBe(LOOP);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;
    expect(code).toMatch(/^7dcde_code_/);
    // Stored hashed and short-lived.
    const [row] = await handle.db.select().from(oauthCodes);
    expect(row!.codeHash).not.toBe(code);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThanOrEqual(61_000);

    const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: LOOP, client_id: solibri.clientId, code_verifier: verifier });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.headers["cache-control"]).toBe("no-store");
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "bcf read" });
    expect(t.body.access_token).toMatch(/^7dcde_oauth_/);
    expect(t.body.refresh_token).toMatch(/^7dcde_refresh_/);
    accessToken = t.body.access_token;
    refreshToken = t.body.refresh_token;

    const [stored] = await handle.db.select().from(tokens).where(eq(tokens.kind, "oauth"));
    expect(stored).toMatchObject({ scope: "read", oauthScopes: ["bcf", "read"], oauthClientId: solibri.id, name: "Solibri Office" });
    expect(stored!.tokenHash).not.toBe(accessToken);
    expect(stored!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(3500_000);

    const me = await currentUser(accessToken);
    expect(me.body).toEqual({ id: "alice@7d.test", name: "Alice" });

    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, solibri.id))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["oauth.consent_granted", "oauth.authorize", "oauth.token_issued"]));
  });

  it("uses the OAuth token with the user's own permissions on the existing API", async () => {
    const viaOAuth = api({ bearer: accessToken });
    const list = await viaOAuth.get("/projects");
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([projectP]);
    expect((await viaOAuth.get(`/projects/${projectQ}`)).status).toBe(404);
    expect((await viaOAuth.get("/admin/oauth-clients")).status).toBe(403);
    // read scope: no writes; token, password and consent routes need a browser session.
    expect((await viaOAuth.post("/projects", { code: "NEW", name: "Yeni" })).status).toBe(403);
    expect((await viaOAuth.get("/auth/tokens")).status).toBe(403);
    expect((await viaOAuth.post("/auth/tokens", { name: "kaçak" })).status).toBe(403);
    expect((await viaOAuth.get("/oauth/authorize-info?client_id=x")).status).toBe(403);
    expect((await viaOAuth.post("/oauth/consent", { params: {}, approve: true })).status).toBe(403);
    // MCP stays for personal API tokens.
    const mcp = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, payload: {} });
    expect(mcp.statusCode).toBe(hasAi ? 401 : 404); // the MCP endpoint is the AI module's
  });

  it("gives write tokens the user's write rights, and OpenCDE-only tokens no /api/v1 access", async () => {
    // The administrator authorizes Solibri with write scope (admin may create projects).
    const { verifier, challenge } = pkce();
    const { code } = await getCode(adminCookie, { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, scope: "write bcf", code_challenge: challenge, code_challenge_method: "S256" });
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: verifier });
    expect(t.body.scope).toBe("bcf write");
    const created = await api({ bearer: t.body.access_token }).post("/projects", { code: "OAUTHW", name: "OAuth ile" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // Admin changes still need a browser session.
    expect((await api({ bearer: t.body.access_token }).post("/admin/oauth-clients", {})).status).toBe(403);

    const p2 = pkce();
    const only = await getCode(adminCookie, { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, scope: "bcf", code_challenge: p2.challenge, code_challenge_method: "S256" });
    const t2 = await tokenRequest({ grant_type: "authorization_code", code: only.code, client_id: solibri.clientId, code_verifier: p2.verifier });
    expect(t2.body.scope).toBe("bcf");
    expect((await api({ bearer: t2.body.access_token }).get("/projects")).status).toBe(403);
    expect((await currentUser(t2.body.access_token)).status).toBe(200);
  });

  it("remembers consent and skips the page next time (unless prompt=consent)", async () => {
    const { challenge } = pkce();
    const params = { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, scope: "read", state: "again", code_challenge: challenge, code_challenge_method: "S256" };
    const a = await authorize(params, aliceCookie);
    expect(a.status).toBe(302);
    const back = new URL(a.location!);
    expect(back.searchParams.get("code")).toMatch(/^7dcde_code_/);
    expect(back.searchParams.get("state")).toBe("again");
    // A scope not consented yet (write) asks again.
    const more = await authorize({ ...params, scope: "read write" }, aliceCookie);
    expect(more.location).toMatch(/^\/oauth\/consent\?/);
    const forced = await authorize({ ...params, prompt: "consent" }, aliceCookie);
    expect(forced.location).toMatch(/^\/oauth\/consent\?/);
  });

  it("rotates refresh tokens and revokes the family when an old one comes back", async () => {
    const r1 = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: solibri.clientId });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.refresh_token).not.toBe(refreshToken);
    expect(r1.body.scope).toBe("bcf read");
    // Narrowing on refresh is allowed, widening is not.
    const r2 = await tokenRequest({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: solibri.clientId, scope: "read" });
    expect(r2.body.scope).toBe("read");
    const wide = await tokenRequest({ grant_type: "refresh_token", refresh_token: r2.body.refresh_token, client_id: solibri.clientId, scope: "read write" });
    expect(wide.body.error).toBe("invalid_scope");
    // The refused widening did not spend r2's refresh token; now the first one comes back:
    expect((await currentUser(r2.body.access_token)).status).toBe(200);
    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: solibri.clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    // Every token of the family is gone.
    expect((await currentUser(accessToken)).status).toBe(401);
    expect((await currentUser(r1.body.access_token)).status).toBe(401);
    expect((await currentUser(r2.body.access_token)).status).toBe(401);
    const latest = await tokenRequest({ grant_type: "refresh_token", refresh_token: r2.body.refresh_token, client_id: solibri.clientId });
    expect(latest.body.error).toBe("invalid_grant");
    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.action, "oauth.refresh_reused"))).length;
    expect(actions).toBe(1);
  });
});

describe("Authorization and token errors", () => {
  const base = () => {
    const p = pkce();
    return { p, params: { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, code_challenge: p.challenge, code_challenge_method: "S256" } };
  };

  it("rejects a wrong PKCE verifier", async () => {
    const { params } = base();
    const { code } = await getCode(aliceCookie, params);
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: pkce().verifier });
    expect(t.status).toBe(400);
    expect(t.body).toMatchObject({ error: "invalid_grant" });
    expect(typeof t.body.error_description).toBe("string");
    // The code is spent after a failed attempt.
    const again = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: params.code_challenge });
    expect(again.body.error).toBe("invalid_grant");
    // Missing verifier.
    const second = await getCode(aliceCookie, base().params);
    expect((await tokenRequest({ grant_type: "authorization_code", code: second.code, client_id: solibri.clientId })).body.error).toBe("invalid_grant");
  });

  it("rejects a reused code and revokes the tokens issued for it", async () => {
    const { p, params } = base();
    const { code } = await getCode(aliceCookie, params);
    const first = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier });
    expect(first.status).toBe(200);
    const second = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier });
    expect(second.body.error).toBe("invalid_grant");
    expect((await currentUser(first.body.access_token)).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: solibri.clientId })).body.error).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const { p, params } = base();
    const { code } = await getCode(aliceCookie, params);
    await handle.db.update(oauthCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthCodes.redirectUri, LOOP));
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier });
    expect(t.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/expired/) });
  });

  it("binds the code to the redirect URI and the client", async () => {
    const { p, params } = base();
    const { code } = await getCode(aliceCookie, params);
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier, redirect_uri: "http://127.0.0.1:9/callback" });
    expect(t.body.error).toBe("invalid_grant");

    const other = base();
    const c2 = await getCode(aliceCookie, other.params);
    const stolen = await tokenRequest({ grant_type: "authorization_code", code: c2.code, code_verifier: other.p.verifier }, { basic: [portal.clientId, portal.secret] });
    expect(stolen.body.error).toBe("invalid_grant");
  });

  it("never redirects to an unregistered URI or for an unknown client", async () => {
    const { params } = base();
    for (const bad of [
      { ...params, redirect_uri: "https://evil.test/cb" },
      { ...params, redirect_uri: "http://localhost:5000/callback" },
      { ...params, redirect_uri: "http://127.0.0.1:5000/elsewhere" },
      { ...params, client_id: "cde-unknown" },
      { ...params, client_id: "" },
    ]) {
      const a = await authorize(bad, aliceCookie);
      expect(a.status, JSON.stringify(bad)).toBe(400);
      expect(a.location).toBeUndefined();
      expect(a.body).toContain("Uygulama Bağlanamadı");
    }
    const unknown = await tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "cde-unknown" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_client");
  });

  it("returns protocol errors to the registered redirect URI", async () => {
    const { params } = base();
    const err = async (p: Record<string, string>) => {
      const a = await authorize(p, aliceCookie);
      expect(a.status).toBe(302);
      const u = new URL(a.location!);
      expect(u.origin + u.pathname).toBe(LOOP);
      return u.searchParams;
    };
    // No implicit grant.
    expect((await err({ ...params, response_type: "token", state: "st" })).get("error")).toBe("unsupported_response_type");
    expect((await err({ ...params, response_type: "token", state: "st" })).get("state")).toBe("st");
    // PKCE is mandatory for public clients, and only S256.
    const { code_challenge: _c, code_challenge_method: _m, ...noPkce } = params;
    expect((await err(noPkce)).get("error")).toBe("invalid_request");
    expect((await err({ ...params, code_challenge_method: "plain" })).get("error")).toBe("invalid_request");
    expect((await err({ ...params, scope: "documents" })).get("error")).toBe("invalid_scope");
    // Denied consent.
    const consentPage = (await authorize({ ...params, prompt: "consent", state: "deny" }, aliceCookie)).location!;
    const denied = new URL(await decide(aliceCookie, consentPage, false));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("deny");
  });

  it("supports only the authorization_code and refresh_token grants", async () => {
    for (const grant of ["password", "client_credentials", "implicit"]) {
      const t = await tokenRequest({ grant_type: grant, client_id: solibri.clientId, username: "alice@7d.test", password: PW });
      expect(t.body.error, grant).toBe("unsupported_grant_type");
    }
    expect((await tokenRequest({ client_id: solibri.clientId })).body.error).toBe("invalid_request");
  });

  it("accepts loopback redirects on any port and binds the code to that port", async () => {
    const { p, params } = base();
    const port = { ...params, redirect_uri: "http://127.0.0.1:53682/callback" };
    const { code, redirect } = await getCode(aliceCookie, port);
    expect(redirect.port).toBe("53682");
    const wrongPort = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier, redirect_uri: "http://127.0.0.1:53683/callback" });
    expect(wrongPort.body.error).toBe("invalid_grant");
    const q = base();
    const c2 = await getCode(aliceCookie, { ...q.params, redirect_uri: "http://127.0.0.1:61000/callback" });
    const ok = await tokenRequest({ grant_type: "authorization_code", code: c2.code, client_id: solibri.clientId, code_verifier: q.p.verifier, redirect_uri: "http://127.0.0.1:61000/callback" });
    expect(ok.status).toBe(200);
  });
});

describe("Confidential clients", () => {
  it("authenticate with HTTP Basic, also with parameters in the query string (bSI example)", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "p1" });
    // POST .../token?grant_type=authorization_code&code=... with Basic, no redirect_uri, no PKCE.
    const t = await tokenRequest({ grant_type: "authorization_code", code }, { basic: [portal.clientId, portal.secret], inQuery: true });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.scope).toBe("documents read");
    expect((await currentUser(t.body.access_token)).body.id).toBe("alice@7d.test");
  });

  it("authenticate with client_secret_post and accept redirect_url", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_url: PORTAL_CB, state: "p2" });
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: portal.clientId, client_secret: portal.secret, redirect_url: PORTAL_CB });
    expect(t.status).toBe(200);
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: portal.clientId, client_secret: portal.secret });
    expect(r.status).toBe(200);
  });

  it("reject wrong or missing secrets and mixed methods", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "p3" });
    const wrong = await tokenRequest({ grant_type: "authorization_code", code }, { basic: [portal.clientId, "7dcde_secret_wrong"] });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_client");
    expect(wrong.headers["www-authenticate"]).toMatch(/^Basic/);
    expect((await tokenRequest({ grant_type: "authorization_code", code, client_id: portal.clientId })).status).toBe(401);
    const mixed = await tokenRequest({ grant_type: "authorization_code", code, client_secret: portal.secret }, { basic: [portal.clientId, portal.secret] });
    expect(mixed.body.error).toBe("invalid_request");
  });

  it("need state when they skip PKCE, and accept PKCE optionally", async () => {
    const a = await authorize({ response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB }, aliceCookie);
    expect(new URL(a.location!).searchParams.get("error")).toBe("invalid_request");
    const p = pkce();
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, code_challenge: p.challenge, code_challenge_method: "S256" });
    expect((await tokenRequest({ grant_type: "authorization_code", code, code_verifier: p.verifier }, { basic: [portal.clientId, portal.secret] })).status).toBe(200);
  });

  it("stop working with the old secret after rotation", async () => {
    const rotated = await admin.post(`/admin/oauth-clients/${portal.id}/secret`);
    const fresh = rotated.body.clientSecret as string;
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "p4" });
    expect((await tokenRequest({ grant_type: "authorization_code", code }, { basic: [portal.clientId, portal.secret] })).status).toBe(401);
    const c2 = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "p5" });
    expect((await tokenRequest({ grant_type: "authorization_code", code: c2.code }, { basic: [portal.clientId, fresh] })).status).toBe(200);
    portal.secret = fresh;
  });

  it("revoke tokens through /oauth2/revoke (RFC 7009)", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "p6" });
    const t = await tokenRequest({ grant_type: "authorization_code", code }, { basic: [portal.clientId, portal.secret] });
    const res = await app.inject({
      method: "POST",
      url: "/oauth2/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${portal.clientId}:${portal.secret}`).toString("base64")}` },
      payload: new URLSearchParams({ token: t.body.refresh_token }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect((await currentUser(t.body.access_token)).status).toBe(401);
  });
});

describe("Hesabım → Bağlı Uygulamalar", () => {
  it("lists connected apps with scopes and last use, and revokes access", async () => {
    const alice = api({ cookie: aliceCookie });
    const p = pkce();
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, scope: "read", code_challenge: p.challenge, code_challenge_method: "S256" });
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: solibri.clientId, code_verifier: p.verifier });
    expect((await api({ bearer: t.body.access_token }).get("/projects")).status).toBe(200);

    const apps = await alice.get("/auth/oauth-apps");
    expect(apps.status).toBe(200);
    const sol = apps.body.find((a: { id: string }) => a.id === solibri.id);
    // Earlier requests without a scope asked for (and got) everything the client may use.
    expect(sol).toMatchObject({ name: "Solibri Office", active: true, scopes: ["bcf", "read", "write"] });
    expect(sol.lastUsedAt).toBeTruthy();
    expect(apps.body.map((a: { name: string }) => a.name)).toEqual(["Portal", "Solibri Office"]);
    // Bob sees nothing of Alice's.
    expect((await api({ cookie: await login("bob@7d.test") }).get("/auth/oauth-apps")).body).toEqual([]);
    // Tokens cannot revoke (session only).
    expect((await api({ bearer: t.body.access_token }).del(`/auth/oauth-apps/${solibri.id}`)).status).toBe(403);

    expect((await alice.del(`/auth/oauth-apps/${solibri.id}`)).status).toBe(200);
    expect((await currentUser(t.body.access_token)).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: solibri.clientId })).body.error).toBe("invalid_grant");
    expect((await alice.get("/auth/oauth-apps")).body.map((a: { name: string }) => a.name)).toEqual(["Portal"]);
    // The consent is gone: the page is shown again.
    const again = await authorize({ response_type: "code", client_id: solibri.clientId, redirect_uri: LOOP, scope: "read", code_challenge: p.challenge, code_challenge_method: "S256" }, aliceCookie);
    expect(again.location).toMatch(/^\/oauth\/consent\?/);
    const audit = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "oauth.revoked"), eq(auditLog.targetId, solibri.id)));
    expect(audit[0]!.details).toMatchObject({ via: "user" });
  });
});

describe("Disabled clients", () => {
  it("cannot authorize, exchange or use tokens until enabled again", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "d1" });
    const t = await tokenRequest({ grant_type: "authorization_code", code }, { basic: [portal.clientId, portal.secret] });
    expect(t.status).toBe(200);
    const pending = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "d2" });

    expect((await admin.patch(`/admin/oauth-clients/${portal.id}`, { enabled: false })).body.enabled).toBe(false);
    const a = await authorize({ response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "d3" }, aliceCookie);
    expect(a.status).toBe(400);
    expect(a.body).toContain("devre dışı");
    expect((await tokenRequest({ grant_type: "authorization_code", code: pending.code }, { basic: [portal.clientId, portal.secret] })).body.error).toBe("invalid_client");
    expect((await currentUser(t.body.access_token)).status).toBe(401);

    await admin.patch(`/admin/oauth-clients/${portal.id}`, { enabled: true });
    expect((await currentUser(t.body.access_token)).status).toBe(200);
    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, portal.id))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["oauth.client_disabled", "oauth.client_enabled"]));
  });
});

describe("Rate limiting and log redaction", () => {
  it("limits failed token requests per client address", async () => {
    const limiter = new FailureLimiter(2, 60_000, () => 1000);
    expect(limiter.retryAfter("ip")).toBe(0);
    limiter.fail("ip");
    limiter.fail("ip");
    expect(limiter.retryAfter("ip")).toBe(60);
    expect(limiter.retryAfter("other")).toBe(0);

    const storage = new LocalStorage(path.join(dataDir, "storage3"));
    const strict = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), oauth: { tokenFailureLimit: 3 } });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "cde-unknown" }, { app: strict });
        expect(r.status).toBe(401);
      }
      const blocked = await tokenRequest({ grant_type: "authorization_code", code: "x", client_id: solibri.clientId }, { app: strict });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.body.error).toBe("temporarily_unavailable");
    } finally {
      await strict.close();
    }
    const failures = await handle.db.select().from(auditLog).where(eq(auditLog.action, "oauth.token_failed"));
    expect(failures.length).toBeGreaterThan(3);
    expect(JSON.stringify(failures.map((f) => f.details))).not.toContain("7dcde_");
  });

  it("never writes codes, tokens or client secrets to the request log", async () => {
    const { code } = await getCode(aliceCookie, { response_type: "code", client_id: portal.clientId, redirect_uri: PORTAL_CB, state: "log" });
    logLines.length = 0;
    const t = await tokenRequest({ grant_type: "authorization_code", code, client_id: portal.clientId, client_secret: portal.secret }, { inQuery: true });
    expect(t.status).toBe(200);
    await tokenRequest({ grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: portal.clientId, client_secret: portal.secret }, { inQuery: true });
    const log = logLines.join("\n");
    expect(log).toContain("/oauth2/token?grant_type=authorization_code&code=***&client_id=");
    expect(log).toContain("client_secret=***");
    expect(log).toContain("refresh_token=***");
    for (const secret of [code, portal.secret, t.body.refresh_token, t.body.access_token]) expect(log).not.toContain(secret);

    expect(redactUrl("/oauth2/token?grant_type=refresh_token&refresh_token=abc&client_secret=s3&code_verifier=v")).toBe(
      "/oauth2/token?grant_type=refresh_token&refresh_token=***&client_secret=***&code_verifier=***",
    );
    expect(redactUrl("/oauth2/authorize?client_id=cde-1&code_challenge=abc")).toBe("/oauth2/authorize?client_id=cde-1&code_challenge=abc");
    expect(redactSecrets("token 7dcde_oauth_abc-DEF and 7dcde_refresh_x_y and 7dcde_secret_zz")).toBe("token 7dcde_oauth_*** and 7dcde_refresh_*** and 7dcde_secret_***");
    expect(redactSecrets('{"authorization":"Basic Y2RlLTE6czNjcjN0"}')).toBe('{"authorization":"Basic ***"}');
  });

  it("stores no plain codes or tokens", async () => {
    const rows = await handle.db.select({ hash: tokens.tokenHash }).from(tokens).where(eq(tokens.kind, "oauth"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
  });
});
