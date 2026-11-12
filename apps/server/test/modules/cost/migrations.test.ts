/**
 * Cost's own migration journal (docs/modules/cost.md): installs from before the module split already
 * have every Cost table (core migrations 0025, 0042–0047) but no Cost journal. Opening them with the
 * module must apply the Cost migrations without errors and without touching the data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../../../src/db/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "cde-cost-mig-"));
const handles: DbHandle[] = [];
afterAll(async () => {
  for (const h of handles) await h.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const COST_TABLES = [
  "contracts",
  "contract_items",
  "contract_variations",
  "contract_guarantee_reminders",
  "progress_payments",
  "progress_payment_lines",
  "takeoff_items",
  "takeoff_scales",
  "quantity_approvals",
  "quantity_bindings",
  "cost_items",
  "cost_rules",
  "poz_mappings",
];

async function rows<T>(h: DbHandle, q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await h.db.execute(q)) as unknown as { rows: T[] };
  return r.rows;
}

describe("Cost migrations", () => {
  it("create every Cost table on a new install, journalled apart from the core", async () => {
    const h = await openDb(dir);
    handles.push(h);
    const tables = await rows<{ t: string }>(h, sql`select table_name as t from information_schema.tables where table_schema = 'public'`);
    expect(tables.map((r) => r.t)).toEqual(expect.arrayContaining(COST_TABLES));
    const journal = await rows<{ n: number }>(h, sql`select count(*)::int as n from drizzle.__drizzle_migrations_cost`);
    expect(journal[0]!.n).toBe(7);
    // Manage is part of this build: the variation → work key exists.
    const fk = await rows<{ n: number }>(h, sql`select count(*)::int as n from pg_constraint where conname = 'contract_variations_work_id_fkey'`);
    expect(fk[0]!.n).toBe(1);
    await h.db.execute(sql`insert into poz_mappings (ifc_class, poz_code, poz_key, description, unit) values ('IfcWall', '15.1', '151', 'Duvar', 'm²')`);
    await h.close();
    handles.pop();
  });

  it("apply cleanly on an install whose Cost tables came from the core (no Cost journal yet)", async () => {
    // An older install: the tables are there, the module's journal is not.
    let h = await openDb(dir);
    handles.push(h);
    await h.db.execute(sql`drop table drizzle.__drizzle_migrations_cost`);
    await h.close();
    handles.pop();

    h = await openDb(dir);
    handles.push(h);
    const journal = await rows<{ n: number }>(h, sql`select count(*)::int as n from drizzle.__drizzle_migrations_cost`);
    expect(journal[0]!.n).toBe(7);
    const kept = await rows<{ n: number }>(h, sql`select count(*)::int as n from poz_mappings where poz_code = '15.1'`);
    expect(kept[0]!.n).toBe(1);
    const fk = await rows<{ n: number }>(h, sql`select count(*)::int as n from pg_constraint where conname = 'contract_variations_work_id_fkey'`);
    expect(fk[0]!.n).toBe(1);
  });
});
