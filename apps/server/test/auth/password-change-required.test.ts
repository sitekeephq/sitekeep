import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { adminMustChangePassword, adminPasswordProblem, adminPrefs } from "../../src/auth/bootstrap-admin.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { render } from "../../src/i18n/index.js";

describe("server-side change of the temporary password", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let dataDir: string;
  const URL = "/api/v1";

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-pwchange-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
    await handle.db.insert(users).values({
      email: "first@sk.test",
      name: "First Admin",
      isAdmin: true,
      passwordHash: await hashPassword("Gecici-Sifre-9876"),
      prefs: { mustChangePassword: true },
    });
    await handle.db.insert(users).values({
      email: "normal@sk.test",
      name: "Normal User",
      isAdmin: true,
      passwordHash: await hashPassword("Sifre-1234567"),
    });
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function login(email: string, password: string) {
    const res = await app.inject({ method: "POST", url: `${URL}/auth/login`, payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return { cookie: `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}` };
  }

  it("refuses every route but the change and sign-out ones, with a code and a translated message", async () => {
    const headers = (await login("first@sk.test", "Gecici-Sifre-9876")).cookie;
    for (const [method, url] of [
      ["GET", `${URL}/projects`],
      ["GET", `${URL}/users`],
      ["GET", `${URL}/auth/tokens`],
      ["POST", `${URL}/auth/tokens`],
      ["GET", `${URL}/modules`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: headers }, payload: method === "POST" ? { name: "x" } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("password_change_required");
    }
    const tr = await app.inject({ method: "GET", url: `${URL}/projects`, headers: { cookie: headers, "accept-language": "tr" } });
    expect(tr.json().message).toContain("geçici şifrenizi");
    const en = await app.inject({ method: "GET", url: `${URL}/projects`, headers: { cookie: headers, "accept-language": "en" } });
    expect(en.json().message).toContain("temporary password");

    for (const url of [`${URL}/auth/me`, `${URL}/app-info`, `${URL}/health`]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: headers } })).statusCode, url).toBe(200);
    }
  });

  it("opens everything again after the password is changed", async () => {
    const headers = { cookie: (await login("first@sk.test", "Gecici-Sifre-9876")).cookie };
    const change = await app.inject({
      method: "POST",
      url: `${URL}/auth/password`,
      headers,
      payload: { currentPassword: "Gecici-Sifre-9876", newPassword: "Yeni-Sifre-2026-x" },
    });
    expect(change.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${URL}/projects`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${URL}/auth/me`, headers })).json().mustChangePassword).toBe(false);
  });

  it("lets the person sign out", async () => {
    const headers = { cookie: (await login("first@sk.test", "Gecici-Sifre-9876")).cookie };
    expect((await app.inject({ method: "POST", url: `${URL}/auth/logout`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${URL}/auth/me`, headers })).statusCode).toBe(401);
  });

  it("does not limit users without the flag", async () => {
    const headers = { cookie: (await login("normal@sk.test", "Sifre-1234567")).cookie };
    expect((await app.inject({ method: "GET", url: `${URL}/projects`, headers })).statusCode).toBe(200);
  });

  it("refuses API access keys of a user who must still change the password", async () => {
    const headers = { cookie: (await login("normal@sk.test", "Sifre-1234567")).cookie };
    const created = await app.inject({ method: "POST", url: `${URL}/auth/tokens`, headers, payload: { name: "script" } });
    expect(created.statusCode).toBe(200);
    const token = created.json().token as string;
    const bearer = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: `${URL}/projects`, headers: bearer })).statusCode).toBe(200);

    // An administrator ticks "must change" later (or the password is reset to the temporary one).
    await handle.db.update(users).set({ prefs: { mustChangePassword: true } }).where(eq(users.email, "normal@sk.test"));
    for (const url of [`${URL}/projects`, `${URL}/auth/me`]) {
      const res = await app.inject({ method: "GET", url, headers: bearer });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toBe("password_change_required");
    }
  });
});

describe("first administrator from ADMIN_PASSWORD", () => {
  it("refuses the temporary password and passwords the normal rules refuse", () => {
    expect(adminPasswordProblem(PROVISION_PASSWORD, "a@b.test")).not.toBeNull();
    expect(render("en", adminPasswordProblem(PROVISION_PASSWORD, "a@b.test")!)).toContain("temporary password");
    expect(adminPasswordProblem("short", "a@b.test")).not.toBeNull();
    expect(adminPasswordProblem("password123", "a@b.test")).not.toBeNull();
    expect(adminPasswordProblem("admin-account-pass", "admin-account@b.test")).not.toBeNull();
    expect(adminPasswordProblem("Gunes-Kar-Bulut-81", "a@b.test")).toBeNull();
  });

  it("must change the password unless ADMIN_MUST_CHANGE_PASSWORD turns it off", () => {
    expect(adminMustChangePassword({})).toBe(true);
    expect(adminMustChangePassword({ ADMIN_MUST_CHANGE_PASSWORD: "1" })).toBe(true);
    for (const off of ["0", "false", "No", " off "]) expect(adminMustChangePassword({ ADMIN_MUST_CHANGE_PASSWORD: off })).toBe(false);
    expect(adminPrefs({})).toEqual({ mustChangePassword: true });
    expect(adminPrefs({ ADMIN_MUST_CHANGE_PASSWORD: "0" })).toEqual({});
  });
});
