/**
 * Report builder → Platform module (docs/modules/platform.md): the upgrade path of an installation
 * whose dashboards were created by the core before the split. Without the module the core's 0046
 * leaves the tables and rows untouched; with it the module's migrations adopt them and the
 * dashboards open as before.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { loadedModules } from "../../src/app/modules.js";
import { installed } from "../helpers/modules.js";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const hasPlatform = installed("platform");
const temp: string[] = [];
const clients: PGlite[] = [];

/** The core's migrations as they were before the split (up to 0044). */
function migrationsBeforeSplit(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sk-mig-"));
  temp.push(dir);
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === "0046_reports_to_platform");
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const ids = {
  user: "00000000-0000-4000-8000-0000000000f1",
  project: "00000000-0000-4000-8000-0000000000f2",
  dash: "00000000-0000-4000-8000-0000000000f3",
};
const PW = "Sifre-1234567";
const QUERIES = [{ id: "open", spec: { dataset: "issues", groupBy: ["status"], metrics: [{ op: "count" }] } }];
const HTML = '<div id="t"></div><script>CDE.onData(function (d) { CDE.table("#t", d.open); });</script>';

/** A database as the current core leaves it: dashboards with two versions. */
async function oldInstallation() {
  const client = new PGlite();
  clients.push(client);
  await migrate(drizzle(client, { schema }), { migrationsFolder: migrationsBeforeSplit() });
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  await q(`insert into users (id, email, name, password_hash, is_admin) values ($1, 'eski@7d.test', 'Eski', $2, true)`, [ids.user, await hashPassword(PW)]);
  await q(`insert into projects (id, code, name) values ($1, 'ESK', 'Eski Proje')`, [ids.project]);
  await q(`insert into project_members (project_id, user_id) values ($1, $2)`, [ids.project, ids.user]);
  await q(
    `insert into dashboards (id, project_id, owner_id, name, queries, html, sharing, version) values ($1, $2, $3, 'Açık Sorunlar', $4, $5, 'project', 2)`,
    [ids.dash, ids.project, ids.user, JSON.stringify(QUERIES), HTML],
  );
  for (const v of [1, 2])
    await q(
      `insert into dashboard_versions (dashboard_id, version, name, queries, html, sharing, created_by) values ($1, $2, $3, $4, $5, 'project', $6)`,
      [ids.dash, v, v === 1 ? "Taslak" : "Açık Sorunlar", JSON.stringify(QUERIES), HTML, ids.user],
    );
  const rows = async () => ({
    dashboards: (await client.query(`select id, name, html, version from dashboards order by id`)).rows,
    versions: (await client.query(`select dashboard_id, version, name from dashboard_versions order by version`)).rows,
  });
  return { client, rows, before: await rows() };
}

afterAll(async () => {
  for (const c of clients) await c.close();
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

describe("report dashboards: upgrade to the Platform module", () => {
  it("the core's migration 0046 drops nothing: without the module the tables and rows stay untouched", async () => {
    expect(readFileSync(path.join(MIGRATIONS, "0046_reports_to_platform.sql"), "utf8")).not.toMatch(/^\s*(DROP|ALTER|DELETE|TRUNCATE)\b/im);
    const { client, rows, before } = await oldInstallation();
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    expect(await rows()).toEqual(before);
    const cols = (await client.query(`select column_name from information_schema.columns where table_name = 'dashboards' order by column_name`)).rows;
    expect(cols.length).toBe(11);
  });

  it.skipIf(!hasPlatform)("with the module its migrations adopt the tables: rows intact, dashboards open and save as before", async () => {
    const platform = loadedModules.find((m) => m.id === "platform")!;
    const { client, rows, before } = await oldInstallation();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: platform.migrations!, migrationsTable: "__drizzle_migrations_platform" });
    // Idempotent: a second run (or a fresh install, where the core created the tables) changes nothing.
    await migrate(db, { migrationsFolder: platform.migrations!, migrationsTable: "__drizzle_migrations_platform" });
    expect(await rows()).toEqual(before);

    const dir = mkdtempSync(path.join(os.tmpdir(), "sk-up-"));
    temp.push(dir);
    const storage = new LocalStorage(path.join(dir, "storage"));
    const app = await buildApp({ db: db as unknown as Db, storage, jobs: new JobQueue(db as unknown as Db, storage) });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "eski@7d.test", password: PW } });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
      const call = async (method: "GET" | "PATCH", url: string, payload?: object) => {
        const r = await app.inject({ method, url: `/api/v1/projects/${ids.project}${url}`, headers: { cookie }, payload });
        return { status: r.statusCode, body: r.json() };
      };
      expect((await call("GET", "/reports")).body.map((d: { id: string }) => d.id)).toEqual([ids.dash]);
      const d = await call("GET", `/reports/${ids.dash}`);
      expect(d.body).toMatchObject({ name: "Açık Sorunlar", html: HTML, version: 2, sharing: "project" });
      const data = await call("GET", `/reports/${ids.dash}/data`);
      expect(data.status).toBe(200);
      expect(data.body.errors).toEqual({});
      expect((await call("GET", `/reports/${ids.dash}/versions`)).body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const saved = await call("PATCH", `/reports/${ids.dash}`, { name: "Açık Sorunlar (yeni)", baseVersion: 2 });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.version).toBe(3);
    } finally {
      await app.close();
    }
  });
});
