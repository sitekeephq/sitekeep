/**
 * Gizlilik Merkezi lists EVERY outbound connection, each with its own switch (docs/features/PRIVACY.md,
 * issue #85 P0-1): Google sign-in, the connections modules declare with registerPrivacyConnection()
 * (Autodesk when Connect is installed) and a guard that fails when an outboundFetch/outboundCall
 * names a connection the list does not have (in the core's source and in the installed modules).
 * No real network: fetch is mocked.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { loadedModules } from "../../src/app/modules.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, outboundLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { msg } from "../../src/i18n/index.js";
import { OutboundBlockedError, outboundRefusal } from "../../src/privacy/outbound.js";
import { registerPrivacyConnection, unregisterPrivacyConnection } from "../../src/privacy/connections.js";
import { UndeclaredConnectionError, moduleOutboundCall, moduleOutboundFetch } from "../../src/sdk/privacy.js";
import * as sdk from "../../src/sdk/index.js";
import { hasConnect } from "../helpers/modules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../src");
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let cookie: string;

async function call(method: "GET" | "PUT" | "POST", url: string, payload?: unknown, auth = true) {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: auth ? { cookie } : {} });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body, headers: res.headers };
}

async function connections(): Promise<Record<string, any>> {
  const c = await call("GET", "/admin/privacy/connections");
  expect(c.status, c.raw).toBe(200);
  return Object.fromEntries(c.body.map((x: any) => [x.id, x]));
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-privacy-conn-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    googleAuth: { clientId: "google-client", clientSecret: "google-secret", callbackUrl: "http://localhost:5173/api/v1/auth/google/callback" },
    // The report model (ai:env) is listed only when configured.
    reportLlm: { baseUrl: "http://llm.local:8080/v1", complete: async () => "" },
  });
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
    { email: "user@ornek.com.tr", name: "Google User", passwordHash: await hashPassword(PW) },
  ]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---- Every connection id an outbound call names has an entry in the list ---------------------------

/** The text of each outboundFetch( / outboundCall( call, from its opening to its closing parenthesis. */
function outboundCalls(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w.$])outbound(?:Fetch|Call)\s*(?:<[^>(]*>)?\(/g;
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    out.push(text.slice(m.index!, i + 1));
  }
  return out;
}

function walk(dir: string, ext: RegExp, files: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, files);
    else if (ext.test(p)) files.push(p);
  }
  return files;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** `const NAME = "value"` constants of the core's source (GOOGLE_CONNECTION…). */
function constants(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) map.set(m[1]!, m[2]!);
  return map;
}

/** Connection ids (literal) and id families (template prefix, "ai:") in a piece of code. */
function connectionRefs(code: string, consts: Map<string, string> = new Map()): { ids: string[]; prefixes: string[]; unresolved: string[] } {
  const ids: string[] = [];
  const prefixes: string[] = [];
  const unresolved: string[] = [];
  for (const m of code.matchAll(/\bconnection\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`$]*)\$\{|`([^`$]*)`|([A-Za-z_$][\w$]*))/g)) {
    const literal = m[1] ?? m[2] ?? m[4];
    if (literal !== undefined) ids.push(literal);
    else if (m[3] !== undefined) prefixes.push(m[3]);
    else if (m[5] && consts.has(m[5])) ids.push(consts.get(m[5])!);
    else if (m[5]) unresolved.push(m[5]);
  }
  return { ids, prefixes, unresolved };
}

/** A template-built id ("ai:${provider.id}") is fine when its family is listed per item: AI providers. */
const LISTED_FAMILIES = ["ai:"];

describe("every outbound connection has an entry in the Privacy Centre", () => {
  it("the core: each outboundFetch/outboundCall in src/ names a listed connection", async () => {
    const files = walk(SRC, /\.ts$/).filter((f) => !f.endsWith(path.join("privacy", "outbound.ts")));
    const consts = constants(files);
    const listed = await connections();
    const problems: string[] = [];
    let seen = 0;
    for (const f of files) {
      const text = stripComments(readFileSync(f, "utf8"));
      for (const c of outboundCalls(text)) {
        seen++;
        const where = `${path.relative(SRC, f)}: ${c.slice(0, 60).replace(/\s+/g, " ")}…`;
        const refs = connectionRefs(c, consts);
        if (!refs.ids.length && !refs.prefixes.length) problems.push(`${where} names no connection${refs.unresolved.length ? ` (${refs.unresolved.join(", ")})` : ""}`);
        for (const id of refs.ids) if (!listed[id]) problems.push(`${where} uses "${id}", not in the Privacy Centre list`);
        for (const p of refs.prefixes) if (!LISTED_FAMILIES.includes(p)) problems.push(`${where} builds "${p}…", not a listed family`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(6); // smtp ×2, office ×3, google ×2: the scan finds the calls
    expect(problems).toEqual([]);
  });

  it("the installed modules: each connection their outbound calls name is listed (via the registry)", async () => {
    const listed = await connections();
    const problems: string[] = [];
    const found = new Set<string>();
    for (const m of loadedModules) {
      let dir = here;
      while (!existsSync(path.join(dir, "node_modules/@7dimensions-project", `sitekeep-ee-${m.id}`, "package.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const pkg = path.join(dir, "node_modules/@7dimensions-project", `sitekeep-ee-${m.id}`);
      const dist = path.join(pkg, "dist/server");
      if (!existsSync(dist)) continue;
      for (const f of walk(dist, /\.js$/)) {
        const text = readFileSync(f, "utf8");
        if (!/\boutbound(?:Fetch|Call)\b/.test(text)) continue;
        const refs = connectionRefs(text);
        refs.ids.forEach((id) => found.add(id));
        for (const id of refs.ids) if (!listed[id]) problems.push(`${m.id} ${path.relative(pkg, f)} uses "${id}", not in the Privacy Centre list`);
        for (const p of refs.prefixes) if (!LISTED_FAMILIES.includes(p)) problems.push(`${m.id} ${path.relative(pkg, f)} builds "${p}…", not a listed family`);
      }
    }
    if (hasConnect) expect([...found]).toContain("autodesk"); // the scan reads the modules' calls
    expect(problems).toEqual([]);
  });

  it("the SDK's outboundFetch / outboundCall refuse a connection that is not declared, before connecting", async () => {
    expect(sdk.outboundFetch).toBe(moduleOutboundFetch);
    expect(sdk.outboundCall).toBe(moduleOutboundCall);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await expect(moduleOutboundFetch("entegrasyon:x", "https://api.example.com/x", {}, { connection: "undeclared-x" })).rejects.toBeInstanceOf(UndeclaredConnectionError);
    await expect(moduleOutboundFetch("entegrasyon:x", "https://api.example.com/x")).rejects.toBeInstanceOf(UndeclaredConnectionError);
    const fn = vi.fn(async () => 1);
    await expect(moduleOutboundCall("x", "smtp://mail.example.com", { connection: "undeclared-x" }, fn)).rejects.toBeInstanceOf(UndeclaredConnectionError);
    expect(fn).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    // Core connections are known to modules too (the AI module calls "ai:<providerId>", the Platform module "ai:env").
    await expect(moduleOutboundFetch("yapay_zeka:rapor", "http://llm.local:8080/v1/x", {}, { connection: "ai:env" })).resolves.toBeInstanceOf(Response);
  });
});

// ---- Module connections (registerPrivacyConnection) -------------------------------------------------

describe("registerPrivacyConnection", () => {
  afterEach(() => unregisterPrivacyConnection("test-sync"));

  it("rejects ids of the core and declarations without hosts", () => {
    expect(() => registerPrivacyConnection({ id: "google", name: "x", hosts: ["a.com"] })).toThrow(/core/);
    expect(() => registerPrivacyConnection({ id: "ai:abc", name: "x", hosts: ["a.com"] })).toThrow(/core/);
    expect(() => registerPrivacyConnection({ id: "test-sync", name: "x", hosts: [] })).toThrow(/hosts/);
    expect(() => registerPrivacyConnection({ id: "Bad Id", name: "x", hosts: ["a.com"] })).toThrow(/invalid id/);
  });

  it("lists a declared connection with its hosts, last use and switch; defaultEnabled: false keeps it off until turned on", async () => {
    registerPrivacyConnection({
      id: "test-sync",
      name: msg("privacy:connections.autodesk"),
      description: "Test sync",
      hosts: ["sync.example.com"],
      defaultEnabled: false,
    });
    let c = (await connections())["test-sync"];
    expect(c).toMatchObject({ kind: "module", name: "Autodesk (APS / ACC)", host: "sync.example.com", location: "external", enabled: false, toggleable: true, lastUsedAt: null, notes: ["Test sync"] });

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    await expect(moduleOutboundFetch("entegrasyon:test", "https://sync.example.com/a", {}, { connection: "test-sync" })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(spy).not.toHaveBeenCalled();

    expect((await call("PUT", "/admin/privacy/connections/test-sync", { enabled: true })).status).toBe(200);
    const res = await moduleOutboundFetch("entegrasyon:test", "https://files.example.net/b", {}, { connection: "test-sync" });
    await res.text();
    expect(spy).toHaveBeenCalledTimes(1);
    c = (await connections())["test-sync"];
    expect(c.enabled).toBe(true);
    expect(c.lastUsedAt).toBeTruthy();
    // Hosts the log saw are added to the declared ones.
    expect(c.host).toBe("sync.example.com, files.example.net");

    expect((await call("PUT", "/admin/privacy/connections/test-sync", { enabled: false })).status).toBe(200);
    expect((await connections())["test-sync"].enabled).toBe(false);
    expect(outboundRefusal("https://sync.example.com", "test-sync")).toBeTruthy();
  });
});

describe.skipIf(!hasConnect)("Connect: Autodesk APS / ACC", () => {
  it("is listed with its host and can be switched off on its own", async () => {
    const c = (await connections()).autodesk;
    expect(c).toMatchObject({ kind: "module", location: "external", enabled: true, toggleable: true });
    expect(c.host).toContain("developer.api.autodesk.com");
    expect(c.name).toMatch(/Autodesk/);
    expect((await call("PUT", "/admin/privacy/connections/autodesk", { enabled: false })).status).toBe(200);
    expect(outboundRefusal("https://developer.api.autodesk.com", "autodesk", "entegrasyon:autodesk")).toBeTruthy();
    expect((await call("PUT", "/admin/privacy/connections/autodesk", { enabled: true })).status).toBe(200);
    expect(outboundRefusal("https://developer.api.autodesk.com", "autodesk", "entegrasyon:autodesk")).toBeNull();
  });
});

// ---- Google sign-in -----------------------------------------------------------------------------------

describe("Google sign-in in the Privacy Centre", () => {
  it("is listed with its hosts and the time of the last sign-in", async () => {
    const before = (await connections()).google;
    expect(before).toMatchObject({
      kind: "auth",
      host: "oauth2.googleapis.com, openidconnect.googleapis.com",
      location: "external",
      enabled: true,
      toggleable: true,
      lastUsedAt: null,
    });

    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const stateCookie = start.cookies.find((x) => x.name === "cde_google_state")!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: "user@ornek.com.tr", email_verified: true }), { status: 200 }));
    const cb = await app.inject({ method: "GET", url: `/api/v1/auth/google/callback?code=c&state=${state}`, headers: { cookie: `cde_google_state=${stateCookie.value}` } });
    expect(cb.headers.location).toBe("/");
    const rows = await handle.db.select().from(outboundLog).where(eq(outboundLog.connection, "google"));
    expect(rows.map((r) => r.host).sort()).toEqual(["oauth2.googleapis.com", "openidconnect.googleapis.com"]);
    expect((await connections()).google.lastUsedAt).toBeTruthy();
  });

  it("switched off: the sign-in page gets no Google button, every step is refused, and the switch is audited", async () => {
    expect((await call("GET", "/auth/methods", undefined, false)).body).toEqual({ password: true, google: true });

    const off = await call("PUT", "/admin/privacy/connections/google", { enabled: false });
    expect(off.status, off.raw).toBe(200);
    expect(off.body.find((x: any) => x.id === "google").enabled).toBe(false);
    const [row] = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "privacy.connection_updated"))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(row?.details).toEqual({ id: "google", enabled: false });

    expect((await call("GET", "/auth/methods", undefined, false)).body).toEqual({ password: true, google: false });
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe("/login?authError=google_disabled");
    expect(start.cookies.find((x) => x.name === "cde_google_state")).toBeUndefined();

    // A flow started before the switch went off ends without calling Google.
    const spy = vi.spyOn(globalThis, "fetch");
    const cb = await app.inject({ method: "GET", url: "/api/v1/auth/google/callback?code=c&state=s", headers: { cookie: "cde_google_state=s" } });
    expect(cb.headers.location).toBe("/login?authError=google_disabled");
    expect(spy).not.toHaveBeenCalled();

    const inv = await call("POST", "/invitations/google", { token: "x".repeat(43) }, false);
    expect(inv.status).toBe(403);
    expect(inv.body.error).toBe("outbound_blocked");

    expect((await call("PUT", "/admin/privacy/connections/google", { enabled: true })).status).toBe(200);
    expect((await call("GET", "/auth/methods", undefined, false)).body.google).toBe(true);
  });

  it("the kill switch also hides the Google button", async () => {
    expect((await call("PUT", "/admin/privacy/kill-switch", { on: true })).status).toBe(200);
    expect((await call("GET", "/auth/methods", undefined, false)).body.google).toBe(false);
    expect((await call("PUT", "/admin/privacy/kill-switch", { on: false })).status).toBe(200);
    expect((await call("GET", "/auth/methods", undefined, false)).body.google).toBe(true);
  });
});

it("a Google install without credentials still lists the connection as not configured", async () => {
  const h = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage-2"));
  const plain = await buildApp({ db: h.db, storage, jobs: new JobQueue(h.db, storage) });
  try {
    await h.db.insert(users).values({ email: "a2@7d.test", name: "A", passwordHash: await hashPassword(PW), isAdmin: true });
    const login = await plain.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a2@7d.test", password: PW } });
    const ck = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
    const res = await plain.inject({ method: "GET", url: "/api/v1/admin/privacy/connections", headers: { cookie: ck, "accept-language": "en" } });
    const google = res.json().find((x: any) => x.id === "google");
    expect(google).toMatchObject({ name: "Sign-in with Google", toggleable: true, notes: ["Not configured (GOOGLE_CLIENT_ID)"] });
    expect((await plain.inject({ method: "GET", url: "/api/v1/auth/methods" })).json()).toEqual({ password: true, google: false });
  } finally {
    await plain.close();
    await h.close();
  }
});
