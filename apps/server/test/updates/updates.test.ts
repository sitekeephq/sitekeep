/**
 * New-version notice (docs/features/PRIVACY.md → Update Check): off by default, one GET to a local stand-in for
 * GitHub (SITEKEEP_UPDATE_URL), nothing else sent, the Privacy Centre switches respected, the daily tick.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { startUpdateCheck } from "../../src/updates/check.js";
import { getUpdateState, saveUpdateState } from "../../src/updates/state.js";

const PW = "Guncelleme-Denetimi-Parola-1";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Stand-in for api.github.com/repos/…/releases/latest. */
class FakeGithub {
  seen: Seen[] = [];
  release: Record<string, unknown> | string = { tag_name: "v1.0.2", html_url: "https://github.com/sitekeephq/sitekeep/releases/tag/v1.0.2", published_at: "2026-11-20T10:00:00Z", draft: false, prerelease: false };
  status = 200;
  /** Bytes of padding in the reply (the size limit). */
  padding = 0;
  server!: Server;
  url = "";

  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const payload = typeof this.release === "string" ? this.release : JSON.stringify({ ...this.release, body: "x".repeat(this.padding) });
        res.writeHead(this.status, { "content-type": "application/json" }).end(payload);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/repos/sitekeephq/sitekeep/releases/latest`;
  }
}

describe("update check", () => {
  let dataDir: string;
  let handle: DbHandle;
  let app: FastifyInstance;
  let admin: string;
  let member: string;
  const github = new FakeGithub();
  const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown, cookie = admin) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, ...(payload !== undefined && { payload: payload as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  };

  beforeAll(async () => {
    await github.start();
    process.env.SITEKEEP_UPDATE_URL = github.url;
    process.env.SITEKEEP_VERSION = "1.0.1";
    dataDir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-updates-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), devTools: false });
    const hash = await hashPassword(PW);
    await handle.db.insert(users).values([
      { email: "admin@7d.test", name: "Admin", passwordHash: hash, isAdmin: true },
      { email: "member@7d.test", name: "Member", passwordHash: hash, isAdmin: false },
    ]);
    admin = await login("admin@7d.test");
    member = await login("member@7d.test");
  });

  beforeEach(() => {
    github.status = 200;
    github.padding = 0;
    process.env.SITEKEEP_UPDATE_URL = github.url;
    process.env.SITEKEEP_VERSION = "1.0.1";
  });

  afterAll(async () => {
    delete process.env.SITEKEEP_UPDATE_URL;
    delete process.env.SITEKEEP_VERSION;
    await app.close();
    await handle.close();
    await new Promise((r) => github.server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is for administrators only and off by default: nothing is sent until someone asks", async () => {
    for (const [m, u] of [["GET", "/admin/updates"], ["PUT", "/admin/updates"], ["POST", "/admin/updates/check"]] as const)
      expect((await call(m, u, m === "PUT" ? { enabled: true } : undefined, member)).status).toBe(403);
    const first = await call("GET", "/admin/updates");
    expect(first.body).toEqual({
      enabled: false,
      promptDismissed: false,
      current: { version: "1.0.1", development: false },
      latest: null,
      updateAvailable: false,
      lastCheckAt: null,
      lastError: null,
      blockedReason: null,
    });
    expect(github.seen).toHaveLength(0);
    expect((await call("PUT", "/admin/updates", {})).status).toBe(400);
  });

  it("lists the connection in the Privacy Centre", async () => {
    const list = (await call("GET", "/admin/privacy/connections")).body as { id: string; kind: string; enabled: boolean; host: string; notes: string[] }[];
    expect(list.find((c) => c.id === "updates")).toMatchObject({ kind: "updates", enabled: true, host: expect.stringContaining("127.0.0.1") });
  });

  it("a manual check works while the daily check is off, and sends one plain GET and nothing else", async () => {
    const r = await call("POST", "/admin/updates/check");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      enabled: false,
      latest: { version: "1.0.2", url: "https://github.com/sitekeephq/sitekeep/releases/tag/v1.0.2", publishedAt: "2026-11-20T10:00:00.000Z", source: "github" },
      updateAvailable: true,
      lastError: null,
    });
    expect(r.body.lastCheckAt).toEqual(expect.any(String));
    expect(github.seen).toHaveLength(1);
    const sent = github.seen[0]!;
    expect(sent.method).toBe("GET");
    expect(sent.body).toBe("");
    expect(sent.headers["user-agent"]).toBe("SiteKeep/1.0.1");
    expect(sent.headers.accept).toBe("application/vnd.github+json");
    // Nothing that identifies the installation or the administrator: no cookie, token, id or query string.
    for (const h of ["cookie", "authorization", "x-forwarded-for", "referer", "content-length"]) expect(sent.headers[h]).toBeUndefined();
    expect(sent.url).toBe("/repos/sitekeephq/sitekeep/releases/latest");
  });

  it("compares versions properly and never offers a pre-release or a draft", async () => {
    github.release = { tag_name: "v1.0.10", html_url: "https://example.test/r", published_at: "2026-12-01T00:00:00Z" };
    process.env.SITEKEEP_VERSION = "1.0.9";
    expect((await call("POST", "/admin/updates/check")).body).toMatchObject({ latest: { version: "1.0.10" }, updateAvailable: true });
    process.env.SITEKEEP_VERSION = "1.0.10";
    expect((await call("GET", "/admin/updates")).body.updateAvailable).toBe(false);
    for (const rel of [{ tag_name: "v2.0.0-rc1" }, { tag_name: "v3.0.0", prerelease: true }, { tag_name: "v3.0.0", draft: true }, { tag_name: "nightly" }]) {
      github.release = { html_url: "https://example.test/r", ...rel };
      const r = await call("POST", "/admin/updates/check");
      expect(r.status).toBe(200);
      expect(r.body.latest.version, JSON.stringify(rel)).toBe("1.0.10");
    }
  });

  it("a development build says so and never claims an update", async () => {
    github.release = { tag_name: "v9.9.9", html_url: "https://example.test/r" };
    delete process.env.SITEKEEP_VERSION;
    expect((await call("POST", "/admin/updates/check")).body).toMatchObject({ current: { version: null, development: true }, latest: { version: "9.9.9" }, updateAvailable: false });
    process.env.SITEKEEP_VERSION = "1.0.1-4-g1a2b3c4"; // git describe
    expect((await call("GET", "/admin/updates")).body).toMatchObject({ current: { version: null, development: true }, updateAvailable: false });
  });

  it("records a failure and keeps what it knew; refuses a reply that is too large", async () => {
    github.release = { tag_name: "v1.0.10", html_url: "https://example.test/r" };
    const known = (await call("GET", "/admin/updates")).body.latest;
    github.status = 503;
    expect(await call("POST", "/admin/updates/check")).toMatchObject({ status: 502, body: { error: "updates_unreachable" } });
    expect((await call("GET", "/admin/updates")).body).toMatchObject({ latest: known, lastError: "HTTP 503" });
    github.status = 200;
    github.padding = 1_200_000;
    expect((await call("POST", "/admin/updates/check")).status).toBe(502);
    expect((await call("GET", "/admin/updates")).body.lastError).toMatch(/too large/);
    github.padding = 0;
    expect((await call("POST", "/admin/updates/check")).body).toMatchObject({ lastError: null });
  });

  it("the connection switch stops both the manual and the daily check, with the reason", async () => {
    expect((await call("PUT", "/admin/privacy/connections/updates", { enabled: false })).status).toBe(200);
    const before = github.seen.length;
    const r = await call("POST", "/admin/updates/check");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "updates_blocked" });
    expect(r.body.message).toMatch(/turned off in the Privacy Centre/);
    expect((await call("GET", "/admin/updates")).body.blockedReason).toMatch(/Privacy Centre/);
    expect(github.seen.length).toBe(before);
    expect((await call("PUT", "/admin/privacy/connections/updates", { enabled: true })).status).toBe(200);
    expect((await call("GET", "/admin/updates")).body.blockedReason).toBeNull();
  });

  it("the kill switch stops it for a host outside the network", async () => {
    process.env.SITEKEEP_UPDATE_URL = "https://updates.example.invalid/releases/latest";
    expect((await call("PUT", "/admin/privacy/kill-switch", { on: true })).status).toBe(200);
    try {
      const before = github.seen.length;
      const r = await call("POST", "/admin/updates/check");
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "updates_blocked" });
      expect(r.body.message).toMatch(/All external connections are off/);
      expect((await call("GET", "/admin/updates")).body.blockedReason).toMatch(/All external connections are off/);
      expect(github.seen.length).toBe(before);
    } finally {
      expect((await call("PUT", "/admin/privacy/kill-switch", { on: false })).status).toBe(200);
    }
  });

  it("turning the daily check on checks at once, answers the card and is audited; turning it off is audited too", async () => {
    github.release = { tag_name: "v9.9.10", html_url: "https://example.test/r11" };
    const before = github.seen.length;
    const on = await call("PUT", "/admin/updates", { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, promptDismissed: true, latest: { version: "9.9.10" } });
    expect(github.seen.length).toBe(before + 1);
    expect((await call("PUT", "/admin/updates", { enabled: true })).status).toBe(200); // no change: no second audit row, no new call
    expect(github.seen.length).toBe(before + 1);
    expect((await call("PUT", "/admin/updates", { enabled: false })).body).toMatchObject({ enabled: false });
    const rows = await handle.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, "updates.enabled"));
    const off = await handle.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, "updates.disabled"));
    expect(rows).toHaveLength(1);
    expect(off).toHaveLength(1);
  });

  it("\"Not now\" is remembered without turning anything on", async () => {
    await saveUpdateState(handle.db, { promptDismissed: false, enabled: false });
    const r = await call("PUT", "/admin/updates", { promptDismissed: true });
    expect(r.body).toMatchObject({ enabled: false, promptDismissed: true });
  });

  it("the daily tick does nothing while off, asks once when on and due, then waits a day", async () => {
    await saveUpdateState(handle.db, { enabled: false, lastCheckAt: null });
    const quiet = github.seen.length;
    let stop = startUpdateCheck(handle.db, { intervalMs: 15, jitterMs: 0 });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(github.seen.length).toBe(quiet);

    await saveUpdateState(handle.db, { enabled: true, lastCheckAt: null });
    stop = startUpdateCheck(handle.db, { intervalMs: 15, jitterMs: 0 });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(github.seen.length).toBe(quiet + 1);
    expect((await getUpdateState(handle.db)).lastCheckAt).not.toBeNull();

    // Not due yet: the last check is recent (and the jitter pushes it further).
    stop = startUpdateCheck(handle.db, { intervalMs: 15, jitterMs: 3_600_000 });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(github.seen.length).toBe(quiet + 1);

    // Due again after a day and a jitter.
    await saveUpdateState(handle.db, { lastCheckAt: new Date(Date.now() - 86_400_000 - 1000).toISOString() });
    stop = startUpdateCheck(handle.db, { intervalMs: 15, jitterMs: 0 });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(github.seen.length).toBe(quiet + 2);
  });

  it("the daily tick respects the connection switch", async () => {
    await saveUpdateState(handle.db, { enabled: true, lastCheckAt: null });
    await call("PUT", "/admin/privacy/connections/updates", { enabled: false });
    const before = github.seen.length;
    const stop = startUpdateCheck(handle.db, { intervalMs: 15, jitterMs: 0 });
    await new Promise((r) => setTimeout(r, 150));
    stop();
    await call("PUT", "/admin/privacy/connections/updates", { enabled: true });
    expect(github.seen.length).toBe(before);
  });
});
