/**
 * Migration 0060_project_companies on data that existed before it: every company a project refers to
 * goes on that project (a company used by two projects is linked to both, not copied); a company used
 * nowhere stays on no project (system administrators only). syncProjectCompanies uses the same sources.
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
import { syncProjectCompanies } from "../../src/projects/companies.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const TAG = "0060_project_companies";

let client: PGlite;
let db: Db;
const dirs: string[] = [];

/** The migrations folder without 0060 (and anything after it). */
function migrationsBefore(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-mig-"));
  dirs.push(dir);
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };
  const at = journal.entries.find((e) => e.tag === TAG)!.idx;
  journal.entries = journal.entries.filter((e) => e.idx < at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = { a: id(1), b: id(2), admin: id(3) };
const P = { one: id(11), two: id(12), three: id(13) };
const C = {
  memberDefault: id(21), // only as a member's own company (no project company set)
  member: id(22), // project_members.company_id in P1 and P2: linked to both, not copied
  slot: id(23),
  team: id(24),
  issue: id(25),
  worksTo: id(26),
  worksCc: id(27),
  grant: id(28),
  assignee: id(29), // workflow step assignee
  unused: id(30),
  invitation: id(31),
};

async function links(): Promise<string[]> {
  const rows = await q<{ p: string; c: string }>(`select project_id as p, company_id as c from project_companies order by 1, 2`);
  return rows.map((r) => `${r.p}:${r.c}`);
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client, { schema }), { migrationsFolder: migrationsBefore() });

  for (const [cid, n] of Object.entries(C)) await q(`insert into companies (id, name) values ($1, $2)`, [n, cid]);
  await q(`insert into users (id, email, name, password_hash, company_id) values ($1, 'a@x.test', 'A', 'x', $2), ($3, 'b@x.test', 'B', 'x', null), ($4, 'admin@x.test', 'Admin', 'x', null)`, [
    U.a,
    C.memberDefault,
    U.b,
    U.admin,
  ]);
  await q(`insert into projects (id, code, name) values ($1, 'P1', 'P1'), ($2, 'P2', 'P2'), ($3, 'P3', 'P3')`, [P.one, P.two, P.three]);
  await q(`insert into project_members (project_id, user_id, company_id) values ($1, $2, null), ($1, $3, $4), ($5, $3, $4)`, [P.one, U.a, U.b, C.member, P.two]);
  await q(`insert into project_slots (project_id, key, label, company_id) values ($1, 'yuk', 'Yüklenici', $2)`, [P.one, C.slot]);
  await q(`insert into project_roles (project_id, name, kind, company_id) values ($1, 'Ekip', 'task_team', $2)`, [P.two, C.team]);
  await q(`insert into issues (project_id, number, title, assignee_company_id, created_by) values ($1, 1, 'S', $2, $3)`, [P.two, C.issue, U.b]);
  const [type] = await q<{ id: string }>(
    `insert into work_types (project_id, key, name, category, numbering_pattern, statuses) values ($1, 'yazi', 'Yazı', 'correspondence', '{Seq}', '[]') returning id`,
    [P.three],
  );
  await q(
    `insert into works (project_id, type_id, number, seq, title, status, to_company_ids, cc_company_ids, created_by) values ($1, $2, 'YZ-1', 1, 'Y', 'taslak', $3, $4, $5)`,
    [P.three, type!.id, [C.worksTo], [C.worksCc], U.admin],
  );
  const [folder] = await q<{ id: string }>(`insert into folders (project_id, name) values ($1, 'Kök') returning id`, [P.three]);
  await q(`insert into folder_grants (folder_id, subject_type, subject_id, level) values ($1, 'company', $2, 'view')`, [folder!.id, C.grant]);
  await q(`insert into workflow_templates (project_id, name, kind, steps) values ($1, 'Onay', 'review', $2)`, [
    P.three,
    JSON.stringify([{ name: "Adım", assignees: [{ type: "company", id: C.assignee }, { type: "user", id: U.a }] }]),
  ]);
  await q(`insert into invitations (token_hash, email, language, user_id, project_id, company_id, invited_by, expires_at) values ('h', 'b@x.test', 'tr', $1, $2, $3, $4, now())`, [
    U.b,
    P.one,
    C.invitation,
    U.admin,
  ]);

  await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
});

afterAll(async () => {
  await client.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe(`migration ${TAG}`, () => {
  it("puts every referenced company on its project and nothing else", async () => {
    expect(await links()).toEqual(
      [
        `${P.one}:${C.memberDefault}`,
        `${P.one}:${C.member}`,
        `${P.one}:${C.slot}`,
        `${P.one}:${C.invitation}`,
        `${P.two}:${C.member}`,
        `${P.two}:${C.team}`,
        `${P.two}:${C.issue}`,
        `${P.three}:${C.worksTo}`,
        `${P.three}:${C.worksCc}`,
        `${P.three}:${C.grant}`,
        `${P.three}:${C.assignee}`,
      ].sort(),
    );
    // One company row per company: the shared one is linked twice, never copied.
    expect((await q<{ n: number }>(`select count(*)::int as n from companies`))[0]!.n).toBe(Object.keys(C).length);
  });

  it("syncProjectCompanies finds the same companies and is re-runnable", async () => {
    const before = await links();
    await q(`delete from project_companies`);
    for (const p of Object.values(P)) await syncProjectCompanies(db, p);
    for (const p of Object.values(P)) await syncProjectCompanies(db, p);
    expect(await links()).toEqual(before);
  });
});
