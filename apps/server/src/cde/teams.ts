/**
 * ISO 19650 task teams (ISO-5, D-4; docs/features/TASK_TEAMS.md): a task team is a project role of
 * kind 'task_team', one per company in the project; a person may belong to several teams. A WIP
 * folder may be owned by one team (`folders.owner_team_id`); under `wip_policy = 'team_only'`
 * FolderTree closes it to everyone outside the team.
 *
 * Seeding is idempotent and never undoes an administrator's choice: teams are created only for
 * companies that have none, and only projects without any task team are seeded at server start.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { companies, folders, memberRoles, projectMembers, projectRoles, projectSlots, projects, users } from "../db/schema.js";
import { FolderTree } from "../core/security/access.js";
import { cdeStateOf } from "./state.js";

/** Default team colour (chips). */
const TEAM_COLOR = "#8a5a00";

export interface TeamSeedCompany {
  companyId: string;
  /** Team code; else the company's code. */
  code?: string | null;
}

/** Task team id of every company that has one in the project. */
export async function teamsByCompany(db: Db, projectId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: projectRoles.id, companyId: projectRoles.companyId })
    .from(projectRoles)
    .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.kind, "task_team"), isNotNull(projectRoles.companyId)))
    .orderBy(asc(projectRoles.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.companyId && !out.has(r.companyId)) out.set(r.companyId, r.id);
  return out;
}

/** Companies present in the project: members' companies and the companies of template slots. */
async function projectCompanies(db: Db, projectId: string): Promise<TeamSeedCompany[]> {
  const members = await db
    .select({ companyId: sql<string | null>`coalesce(${projectMembers.companyId}, ${users.companyId})` })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  const slots = await db
    .select({ companyId: projectSlots.companyId, code: projectSlots.code })
    .from(projectSlots)
    .where(and(eq(projectSlots.projectId, projectId), isNotNull(projectSlots.companyId)))
    .orderBy(asc(projectSlots.position));
  const out = new Map<string, TeamSeedCompany>();
  for (const s of slots) if (s.companyId && !out.has(s.companyId)) out.set(s.companyId, { companyId: s.companyId, code: s.code });
  for (const m of members) if (m.companyId && !out.has(m.companyId)) out.set(m.companyId, { companyId: m.companyId });
  return [...out.values()];
}

/**
 * Creates a task team for every given company (default: every company in the project) that has
 * none yet, and puts the company's members in it. Existing teams are left as they are.
 * Returns the team of every company (existing and new) and how many were created.
 */
export async function ensureCompanyTeams(
  db: Db,
  projectId: string,
  given?: readonly TeamSeedCompany[],
): Promise<{ teams: Map<string, string>; created: number }> {
  const teams = await teamsByCompany(db, projectId);
  const wanted = (given ?? (await projectCompanies(db, projectId))).filter((c) => !teams.has(c.companyId));
  if (!wanted.length) return { teams, created: 0 };
  const companyRows = await db
    .select()
    .from(companies)
    .where(inArray(companies.id, [...new Set(wanted.map((c) => c.companyId))]));
  const byId = new Map(companyRows.map((c) => [c.id, c]));
  const taken = new Set(
    (await db.select({ name: projectRoles.name }).from(projectRoles).where(eq(projectRoles.projectId, projectId))).map((r) =>
      r.name.toLocaleLowerCase("tr"),
    ),
  );
  let created = 0;
  for (const c of wanted) {
    const company = byId.get(c.companyId);
    if (!company || teams.has(company.id)) continue;
    const code = c.code?.trim() || company.code || null;
    const name = freeName(taken, company.name, code);
    taken.add(name.toLocaleLowerCase("tr"));
    const [row] = await db
      .insert(projectRoles)
      .values({ projectId, name, kind: "task_team", companyId: company.id, code, color: TEAM_COLOR })
      .onConflictDoNothing({ target: [projectRoles.projectId, projectRoles.name] })
      .returning({ id: projectRoles.id });
    if (!row) continue;
    teams.set(company.id, row.id);
    created++;
    const members = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          sql`coalesce(${projectMembers.companyId}, ${users.companyId}) = ${company.id}`,
        ),
      );
    if (members.length)
      await db
        .insert(memberRoles)
        .values(members.map((m) => ({ projectId, userId: m.userId, roleId: row.id })))
        .onConflictDoNothing();
  }
  return { teams, created };
}

/** A role name not used in the project: the company name, then "name (CODE)", then "name 2", … */
function freeName(taken: ReadonlySet<string>, base: string, code: string | null): string {
  const free = (n: string) => !taken.has(n.toLocaleLowerCase("tr"));
  if (free(base)) return base;
  if (code && free(`${base} (${code})`)) return `${base} (${code})`;
  for (let i = 2; ; i++) if (free(`${base} ${i}`)) return `${base} ${i}`;
}

/** Puts a member in their company's task team, when the project has one (new member, company change). */
export async function joinCompanyTeam(db: Db, projectId: string, userId: string, companyId: string | null | undefined) {
  if (!companyId) return;
  const teamId = (await teamsByCompany(db, projectId)).get(companyId);
  if (!teamId) return;
  await db.insert(memberRoles).values({ projectId, userId, roleId: teamId }).onConflictDoNothing();
}

/**
 * Owner teams of WIP folders made from template slots: a WIP folder (not yet owned, no owned
 * ancestor) whose direct grants name exactly one company, that company being a slot company with
 * a team, belongs to that team. Folders are visited root first, so subfolders inherit instead.
 * Returns the number of folders that got an owner.
 */
export async function assignWipOwnerTeams(db: Db, projectId: string, teams: ReadonlyMap<string, string>): Promise<number> {
  if (!teams.size) return 0;
  const slotCompanies = new Set(
    (
      await db
        .select({ companyId: projectSlots.companyId })
        .from(projectSlots)
        .where(and(eq(projectSlots.projectId, projectId), isNotNull(projectSlots.companyId)))
    ).map((s) => s.companyId!),
  );
  if (!slotCompanies.size) return 0;
  const tree = await FolderTree.load(db, projectId);
  const owned = new Set<string>();
  const updates = new Map<string, string>();
  const visit = (parentId: string | null) => {
    for (const f of tree.children.get(parentId) ?? []) {
      const ownerAbove = (f.parentId && owned.has(f.parentId)) || false;
      if (f.ownerTeamId || ownerAbove) {
        owned.add(f.id);
      } else if (f.parentId && cdeStateOf(tree, f.id) === "wip") {
        const companyGrants = tree.grants.filter((g) => g.folderId === f.id && g.subjectType === "company" && g.level !== "none");
        const only = companyGrants.length === 1 ? companyGrants[0]!.subjectId : null;
        const teamId = only && slotCompanies.has(only) ? teams.get(only) : undefined;
        if (teamId) {
          updates.set(f.id, teamId);
          owned.add(f.id);
        }
      }
      visit(f.id);
    }
  };
  visit(null);
  for (const [folderId, teamId] of updates)
    await db.update(folders).set({ ownerTeamId: teamId }).where(and(eq(folders.id, folderId), isNull(folders.ownerTeamId)));
  return updates.size;
}

export interface TaskTeamSeedReport {
  projectsSeeded: number;
  teamsCreated: number;
  foldersOwned: number;
}

/**
 * Seeds task teams in every project that has none yet (one per company, members joined, owner
 * teams on WIP folders made from template slots). Idempotent: a project with any task team is
 * skipped, so teams an administrator deleted or renamed are not brought back. Batched.
 */
export async function seedTaskTeams(
  db: Db,
  opts: { batchSize?: number; log?: (line: string) => void } = {},
): Promise<TaskTeamSeedReport> {
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const log = opts.log ?? (() => undefined);
  const report: TaskTeamSeedReport = { projectsSeeded: 0, teamsCreated: 0, foldersOwned: 0 };
  const pending = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      sql`not exists (select 1 from ${projectRoles} r where r.project_id = ${projects.id} and r.kind = 'task_team')`,
    )
    .orderBy(asc(projects.createdAt));
  for (let i = 0; i < pending.length; i += batchSize) {
    for (const p of pending.slice(i, i + batchSize)) {
      const { teams, created } = await ensureCompanyTeams(db, p.id);
      if (!created) continue;
      report.projectsSeeded++;
      report.teamsCreated += created;
      report.foldersOwned += await assignWipOwnerTeams(db, p.id, teams);
    }
    log(`task teams: ${Math.min(i + batchSize, pending.length)}/${pending.length} projects`);
  }
  return report;
}

/** Is a grant subject inside the team? Users by membership, companies by the team's company, roles by id. */
export async function subjectInTeam(
  db: Db,
  team: { id: string; companyId: string | null },
  subjectType: "user" | "company" | "role",
  subjectId: string,
): Promise<boolean> {
  if (subjectType === "role") return subjectId === team.id;
  if (subjectType === "company") return !!team.companyId && subjectId === team.companyId;
  const [row] = await db
    .select({ userId: memberRoles.userId })
    .from(memberRoles)
    .where(and(eq(memberRoles.roleId, team.id), eq(memberRoles.userId, subjectId)));
  return !!row;
}
