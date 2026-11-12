import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

describe("provision password change", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-provision-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
    await handle.db.insert(users).values({
      email: "kors@7d.test",
      name: "Kors User",
      passwordHash: await hashPassword(PROVISION_PASSWORD),
    });
    await handle.db.insert(users).values({
      email: "normal@7d.test",
      name: "Normal User",
      passwordHash: await hashPassword("Sifre-1234567"),
    });
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function cookie(res: { cookies: Array<{ name: string; value: string }> }) {
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  it("flags a login with the temporary password and clears it after change", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "kors@7d.test", password: PROVISION_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().mustChangePassword).toBe(true);
    const headers = { cookie: cookie(login) };

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(me.json().mustChangePassword).toBe(true);

    const same = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers,
      payload: { currentPassword: PROVISION_PASSWORD, newPassword: PROVISION_PASSWORD },
    });
    expect(same.statusCode).toBe(400);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers,
      payload: { currentPassword: PROVISION_PASSWORD, newPassword: "Kendi-sifrem-1" },
    });
    expect(changed.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(after.json().mustChangePassword).toBe(false);
  });

  it("does not flag a normal password", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "normal@7d.test", password: "Sifre-1234567" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().mustChangePassword).toBe(false);
  });
});
