import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { putGoogleAuthSettings } from "../../src/auth/google-settings.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

describe("Google OAuth login", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-google-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({
      db: handle.db,
      storage,
      jobs: new JobQueue(handle.db, storage),
      googleAuth: {
        clientId: "google-client",
        clientSecret: "google-secret",
        callbackUrl: "http://localhost:5173/api/v1/auth/google/callback",
      },
    });
    await handle.db.insert(users).values([
      {
        email: "user@ornek-insaat.com.tr",
        name: "Google User",
        passwordHash: await hashPassword("Sifre-1234567"),
      },
      {
        email: "admin@7d.test",
        name: "Admin",
        passwordHash: await hashPassword("Sifre-1234567"),
        isAdmin: true,
      },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a callback whose state does not match the signed-in browser", async () => {
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    const stateCookie = start.cookies.find((cookie) => cookie.name === "cde_google_state");
    expect(start.statusCode).toBe(302);
    expect(stateCookie?.value).toBeTruthy();

    const callback = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?code=code&state=wrong",
      headers: { cookie: `cde_google_state=${stateCookie!.value}` },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/login?authError=invalid_state");
  });

  it("creates a session only for an existing verified Google account", async () => {
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    const stateCookie = start.cookies.find((cookie) => cookie.name === "cde_google_state")!;
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: "user@ornek-insaat.com.tr", email_verified: true }), { status: 200 }),
      );

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `cde_google_state=${stateCookie.value}` },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    expect(callback.cookies.some((cookie) => cookie.name === "cde_session")).toBe(true);
  });

  it("rejects an unknown Google account while the allowlist is off", async () => {
    const location = await googleCallback(app, "ayse@ornek-insaat.com.tr");
    expect(location).toBe("/login?authError=account_not_allowed");
  });

  it("opens a non-admin user when the allowlist matches", async () => {
    await putGoogleAuthSettings(handle.db, { domainAllowlistEnabled: true, domains: ["ornek-insaat.com.tr"] }, null);
    const location = await googleCallback(app, "ayse@ornek-insaat.com.tr", "Ayşe Yılmaz");
    expect(location).toBe("/");
    const [created] = await handle.db.select().from(users).where(eq(users.email, "ayse@ornek-insaat.com.tr"));
    expect(created?.name).toBe("Ayşe Yılmaz");
    expect(created?.isAdmin).toBe(false);
    expect(created?.disabled).toBe(false);
  });

  it("does not open a user when the domain is listed but the switch is off", async () => {
    await putGoogleAuthSettings(handle.db, { domainAllowlistEnabled: false, domains: ["ornek-insaat.com.tr"] }, null);
    const location = await googleCallback(app, "yeni@ornek-insaat.com.tr");
    expect(location).toBe("/login?authError=account_not_allowed");
  });

  it("still blocks a disabled account even if the domain is allowed", async () => {
    await handle.db.insert(users).values({
      email: "kapali@ornek-insaat.com.tr",
      name: "Kapalı",
      passwordHash: await hashPassword("Sifre-1234567"),
      disabled: true,
    });
    await putGoogleAuthSettings(handle.db, { domainAllowlistEnabled: true, domains: ["ornek-insaat.com.tr"] }, null);
    const location = await googleCallback(app, "kapali@ornek-insaat.com.tr");
    expect(location).toBe("/login?authError=account_not_allowed");
  });

  it("lets only a system administrator change the allowlist", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/v1/admin/google-auth" });
    expect(denied.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@7d.test", password: "Sifre-1234567" },
    });
    const cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/google-auth",
      headers: { cookie },
      payload: { domainAllowlistEnabled: true, domains: ["@Ornek-Insaat.COM.TR", "ornek-insaat.com.tr"] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ domainAllowlistEnabled: true, domains: ["ornek-insaat.com.tr"] });

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/google-auth",
      headers: { cookie },
      payload: { domainAllowlistEnabled: true, domains: ["not a domain"] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

async function googleCallback(app: FastifyInstance, email: string, name = "Google User") {
  const start = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
  const stateCookie = start.cookies.find((cookie) => cookie.name === "cde_google_state")!;
  const state = new URL(start.headers.location!).searchParams.get("state")!;
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ email, email_verified: true, name }), { status: 200 }));
  const callback = await app.inject({
    method: "GET",
    url: `/api/v1/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
    headers: { cookie: `cde_google_state=${stateCookie.value}` },
  });
  return callback.headers.location;
}
