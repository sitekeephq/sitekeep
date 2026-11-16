/** A server with an administrator and four companies, for creating projects from templates (module template tests). */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

export interface TemplateServer {
  handle: DbHandle;
  /** POST /api/v1/projects/from-template as the administrator. */
  create(body: Record<string, unknown>): Promise<{ status: number; body: any }>;
  /** slot key → company id for the four parties. */
  slotCompanies: Record<string, string>;
  close(): Promise<void>;
}

export async function templateServer(): Promise<TemplateServer> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-tplmod-"));
  const handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const app: FastifyInstance = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
  const post = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.json() as any };
  };
  const slotCompanies: Record<string, string> = {};
  for (const slot of ["idare", "musavir", "tasarimci", "yuklenici"]) slotCompanies[slot] = (await post("/companies", { name: `Co ${slot}` })).body.id;
  return {
    handle,
    slotCompanies,
    create: (body) => post("/projects/from-template", body),
    async close() {
      await app.close();
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
