import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { hasConnect } from "../helpers/modules.js"; // Forma Eşitleme is the Connect module's
import { JobQueue } from "../../src/jobs/queue.js";
import { editionName, moduleIds } from "../../src/app/module-ids.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-status-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), dbKind: "pglite" });
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
    { email: "uye@7d.test", name: "Üye", passwordHash: await hashPassword(PW), isAdmin: false },
  ]);
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

describe("GET /admin/status", () => {
  it("is only for system administrators and reports liveness, jobs and backup", async () => {
    const member = await login("uye@7d.test");
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/status", headers: { cookie: member } })).statusCode).toBe(403);

    const admin = await login("admin@7d.test");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/status", headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.database.ok).toBe(true);
    expect(body.database.kind).toBe("pglite");
    expect(body.app.ok).toBe(true);
    expect(body.jobs).toEqual({ queued: 0, running: 0, failed: 0, done: 0 });
    expect(body.backup.scheduled).toBe(false);
    expect(["ok", "warn", "danger"]).toContain(body.level);
  });
});

describe.skipIf(!hasConnect)("GET /admin/forma-sync", () => {
  it("is only for system administrators and returns the sample file-sync overlay", async () => {
    const member = await login("uye@7d.test");
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/forma-sync", headers: { cookie: member } })).statusCode).toBe(403);

    const admin = await login("admin@7d.test");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/forma-sync", headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.demo).toBe(true);
    expect(body.connection.name).toBe("Örnek Metro Hattı");
    expect(body.mappings).toHaveLength(3);
    expect(body.recentFiles.length).toBeGreaterThan(0);
    expect(body.files.pending).toBe(6);
  });
});

describe("GET /modules", () => {
  it("lists the installed SiteKeep modules to signed-in users only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/modules" })).statusCode).toBe(401);
    const member = await login("uye@7d.test");
    const res = await app.inject({ method: "GET", url: "/api/v1/modules", headers: { cookie: member } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().modules).toEqual(moduleIds());
    expect(res.json().edition).toBe(moduleIds().length ? "SiteKeep Enterprise" : "SiteKeep Community");
  });

  it("tells anyone the product, edition and modules, without signing in (the web app's start)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/app-info" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ product: "SiteKeep", edition: editionName(), modules: moduleIds() });
  });

  it("names the edition after the installed modules", () => {
    expect(editionName([])).toBe("SiteKeep Community");
    expect(editionName(["cost"])).toBe("SiteKeep Enterprise");
  });
});
