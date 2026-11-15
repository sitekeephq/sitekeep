/**
 * Migration 0042 (CDE foundation) on data that existed before it: container ids along review copy
 * chains, settings rows, the container default trigger; and the re-runnable backfill
 * (src/cde/backfill.ts). ISO 19650-1 §12 (information container), docs/features/CDE_STATES.md.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { runCdeBackfill } from "../../src/cde/backfill.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

let client: PGlite;
let db: Db;
let before: string;

/** The migrations folder as it was before 0042. */
function migrationsBefore0042(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-mig-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < 42);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000002",
  project2: "00000000-0000-4000-8000-000000000003",
  wip: "00000000-0000-4000-8000-000000000010",
  shared: "00000000-0000-4000-8000-000000000011",
  published: "00000000-0000-4000-8000-000000000012",
  a: "00000000-0000-4000-8000-0000000000a1", // WIP original
  b: "00000000-0000-4000-8000-0000000000b1", // Shared copy of a
  c: "00000000-0000-4000-8000-0000000000c1", // Published copy of b
  d: "00000000-0000-4000-8000-0000000000d1", // another WIP original
  e: "00000000-0000-4000-8000-0000000000e1", // copied from a (review 4) and later from d (review 3)
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  before = migrationsBefore0042();
  await migrate(drizzle(client, { schema }), { migrationsFolder: before });

  await q(`insert into users (id, email, name, password_hash) values ($1, 'a@7d.test', 'A', 'x')`, [ids.user]);
  await q(`insert into projects (id, code, name) values ($1, 'P1', 'P1'), ($2, 'P2', 'P2')`, [ids.project, ids.project2]);
  for (const [id, name, state] of [
    [ids.wip, "01-WIP", "wip"],
    [ids.shared, "02-SHARED", "shared"],
    [ids.published, "03-PUBLISHED", "published"],
  ])
    await q(`insert into folders (id, project_id, name, state) values ($1, $2, $3, $4)`, [id, ids.project, name, state]);
  const file = async (id: string, folder: string, name: string, at: string) => {
    await q(`insert into files (id, project_id, folder_id, name, created_at) values ($1, $2, $3, $4, $5)`, [id, ids.project, folder, name, at]);
    await q(`insert into file_versions (file_id, version, storage_key, size, sha256) values ($1, 1, $2, 1, 'x')`, [id, `k-${id}`]);
  };
  // Inserted out of order on purpose: the chain is walked by review, not by row order.
  await file(ids.c, ids.published, "DOC-1.pdf", "2026-03-01");
  await file(ids.a, ids.wip, "DOC-1.pdf", "2026-01-01");
  await file(ids.b, ids.shared, "DOC-1.pdf", "2026-02-01");
  await file(ids.d, ids.wip, "DOC-2.pdf", "2026-01-02");
  await file(ids.e, ids.shared, "DOC-3.pdf", "2026-02-02");
  const review = async (n: number, at: string, rows: [source: string, copy: string][]) => {
    const [r] = await q<{ id: string }>(
      `insert into reviews (project_id, number, name, created_by, created_at) values ($1, $2, $3, $4, $5) returning id`,
      [ids.project, n, `R${n}`, ids.user, at],
    );
    for (const [source, copy] of rows) {
      const [v] = await q<{ id: string }>(`select id from file_versions where file_id = $1`, [source]);
      await q(
        `insert into review_files (review_id, file_id, file_version_id, source_folder_id, final_status, copied_file_id) values ($1, $2, $3, $4, 'approved', $5)`,
        [r!.id, source, v!.id, ids.wip, copy],
      );
    }
  };
  await review(2, "2026-02-20", [[ids.b, ids.c]]);
  await review(1, "2026-01-20", [[ids.a, ids.b]]);
  await review(3, "2026-03-20", [[ids.d, ids.e]]);
  await review(4, "2026-01-25", [[ids.a, ids.e]]);

  await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

async function containers(): Promise<Record<string, string>> {
  const rows = await q<{ id: string; container_id: string }>(`select id, container_id from files`);
  return Object.fromEntries(rows.map((r) => [r.id, r.container_id]));
}

describe("migration 0042 (ISO 19650 information containers)", () => {
  it("puts review copies in their source's container, along chains", async () => {
    const c = await containers();
    expect(c[ids.a]).toBe(ids.a);
    expect(c[ids.b]).toBe(ids.a);
    expect(c[ids.c]).toBe(ids.a);
    expect(c[ids.d]).toBe(ids.d);
    // Two sources: the earliest review wins.
    expect(c[ids.e]).toBe(ids.a);
  });

  it("creates settings rows for existing projects with enforcement off (D-8)", async () => {
    const rows = await q<{ project_id: string; enforce_transitions: boolean; code_scheme: string; wip_policy: string; admin_sees_wip: boolean }>(
      `select * from project_cde_settings order by project_id`,
    );
    expect(rows.map((r) => r.project_id)).toEqual([ids.project, ids.project2]);
    for (const r of rows) {
      expect(r.enforce_transitions).toBe(false);
      expect(r.code_scheme).toBe("iso_uk_na");
      expect(r.wip_policy).toBe("grants");
      expect(r.admin_sees_wip).toBe(true);
    }
  });

  it("gives a new file its own container unless one is set", async () => {
    const [own] = await q<{ id: string; container_id: string }>(
      `insert into files (project_id, folder_id, name) values ($1, $2, 'NEW.pdf') returning id, container_id`,
      [ids.project, ids.wip],
    );
    expect(own!.container_id).toBe(own!.id);
    const [joined] = await q<{ container_id: string }>(
      `insert into files (project_id, folder_id, name, container_id) values ($1, $2, 'NEW.pdf', $3) returning container_id`,
      [ids.project, ids.shared, ids.a],
    );
    expect(joined!.container_id).toBe(ids.a);
    // Through drizzle (the application's insert paths) as well.
    const [row] = await db.insert(schema.files).values({ projectId: ids.project, folderId: ids.published, name: "NEW.pdf" }).returning();
    expect(row!.containerId).toBe(row!.id);
  });

  it("keeps one transition per (from, to), counting a direct upload (null) as one state", async () => {
    await q(`insert into cde_transitions (project_id, from_state, to_state, mode) values ($1, null, 'wip', 'direct')`, [ids.project]);
    await expect(q(`insert into cde_transitions (project_id, from_state, to_state, mode) values ($1, null, 'wip', 'review')`, [ids.project])).rejects.toThrow();
    await q(`insert into cde_transitions (project_id, from_state, to_state, mode) values ($1, null, 'wip', 'direct')`, [ids.project2]);
    await q(`insert into cde_transitions (project_id, from_state, to_state, mode) values ($1, 'wip', 'shared', 'review')`, [ids.project]);
  });

  it("adds the audit, code and task-team columns", async () => {
    const cols = async (table: string) =>
      (await q<{ column_name: string }>(`select column_name from information_schema.columns where table_name = $1`, [table])).map((r) => r.column_name);
    expect(await cols("audit_log")).toEqual(expect.arrayContaining(["prev_hash", "hash", "ip", "user_agent"]));
    expect(await cols("file_versions")).toEqual(expect.arrayContaining(["suitability_code", "revision_code", "codes_set_by", "codes_set_at"]));
    expect(await cols("files")).toEqual(expect.arrayContaining(["container_id", "document_code", "cde_status"]));
    expect(await cols("project_roles")).toEqual(expect.arrayContaining(["kind", "company_id", "code", "is_lead"]));
    expect(await cols("folders")).toContain("owner_team_id");
    expect(await cols("document_codes")).toEqual(expect.arrayContaining(["project_id", "code_norm", "container_id", "first_file_id", "created_at"]));
    const [role] = await q<{ kind: string; is_lead: boolean }>(
      `insert into project_roles (project_id, name) values ($1, 'X') returning kind, is_lead`,
      [ids.project],
    );
    expect(role).toEqual({ kind: "role", is_lead: false });
    // Append-only since 0043 (ISO-4, test/audit/audit-chain.test.ts).
    await q(`insert into audit_log (action) values ('x')`);
    await expect(q(`update audit_log set action = 'y' where action = 'x'`)).rejects.toThrow(/append-only/);
  });

  it("backfill is idempotent and repairs a broken chain in batches", async () => {
    expect(await runCdeBackfill(db, { batchSize: 2 })).toEqual({ containersLinked: 0, settingsCreated: 0 });
    await q(`update files set container_id = id where id in ($1, $2)`, [ids.b, ids.c]);
    await q(`delete from project_cde_settings where project_id = $1`, [ids.project2]);
    expect(await runCdeBackfill(db, { batchSize: 1 })).toEqual({ containersLinked: 2, settingsCreated: 1 });
    const c = await containers();
    expect([c[ids.b], c[ids.c]]).toEqual([ids.a, ids.a]);
    expect(await runCdeBackfill(db)).toEqual({ containersLinked: 0, settingsCreated: 0 });
  });
});
