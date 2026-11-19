/**
 * Companies on a project (docs/features/COMPANIES.md). The company registry is server-wide and kept
 * by system administrators; `project_companies` says which projects each company is on.
 *
 * - A project's pickers offer only the companies on the project.
 * - A non-administrator sees a company only through the projects they are a member of, plus their
 *   own company. System administrators and auditors see every company.
 * - Records of a project may refer only to companies on the project. Project administrators put a
 *   company on the project, and only one they can see (system administrators: any).
 *
 * Companies have no organisation of their own: SiteKeep has no hub/tenant entity, a project is the
 * unit of separation, so a company shared by two projects is one row linked twice (no copies).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { companies, projectCompanies, projectMembers, projects } from "../db/schema.js";
import type { AuthUser } from "../core/security/access.js";
import { badRequest } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

const unique = (ids: readonly (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))];

/** Ids of the companies on a project. */
export async function projectCompanyIds(db: Db, projectId: string): Promise<Set<string>> {
  const rows = await db.select({ id: projectCompanies.companyId }).from(projectCompanies).where(eq(projectCompanies.projectId, projectId));
  return new Set(rows.map((r) => r.id));
}

/** The companies on a project, by name. */
export async function listProjectCompanies(db: Db, projectId: string) {
  return db
    .select({ id: companies.id, name: companies.name, code: companies.code, address: companies.address, email: companies.email })
    .from(projectCompanies)
    .innerJoin(companies, eq(companies.id, projectCompanies.companyId))
    .where(eq(projectCompanies.projectId, projectId))
    .orderBy(companies.name);
}

/** Puts companies on a project (no checks: callers have done them). */
export async function linkProjectCompanies(db: Db, projectId: string, ids: readonly (string | null | undefined)[]) {
  const list = unique(ids);
  if (!list.length) return;
  await db
    .insert(projectCompanies)
    .values(list.map((companyId) => ({ projectId, companyId })))
    .onConflictDoNothing();
}

/**
 * Companies the user may see outside a project: null = every company (system administrator,
 * auditor); otherwise the companies on the user's active projects (within an API token's project
 * limit) and the user's own company.
 */
export async function visibleCompanyIds(db: Db, user: AuthUser): Promise<Set<string> | null> {
  if (user.isAdmin || user.isAuditor) return null;
  const rows = await db
    .selectDistinct({ id: projectCompanies.companyId, projectId: projectCompanies.projectId })
    .from(projectCompanies)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projectCompanies.projectId), eq(projectMembers.userId, user.id)))
    .innerJoin(projects, and(eq(projects.id, projectCompanies.projectId), eq(projects.archived, false)));
  const limit = user.token?.projectIds;
  const out = new Set(rows.filter((r) => !limit || limit.includes(r.projectId)).map((r) => r.id));
  if (user.companyId) out.add(user.companyId);
  return out;
}

/**
 * People the user may see in the user directory (GET /users): the members of the user's active
 * projects (within an API token's project limit) and the user. Callers handle administrators.
 */
export async function visibleUserIds(db: Db, user: AuthUser): Promise<Set<string>> {
  const mine = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, and(eq(projects.id, projectMembers.projectId), eq(projects.archived, false)))
    .where(eq(projectMembers.userId, user.id));
  const limit = user.token?.projectIds;
  const projectIds = mine.map((r) => r.projectId).filter((id) => !limit || limit.includes(id));
  const out = new Set([user.id]);
  if (!projectIds.length) return out;
  const rows = await db.selectDistinct({ id: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, projectIds));
  for (const r of rows) out.add(r.id);
  return out;
}

/** Who writes to the project: the caller and whether they administer the project. */
export interface ProjectCompanyActor {
  project: { id: string };
  user: AuthUser;
  isProjectAdmin: boolean;
}

/**
 * Companies a project write refers to must be on the project. Missing ones are put on the project
 * when the caller is a project administrator who can see them (system administrator: any existing
 * company); otherwise 400. The same answer for an unknown and a foreign company (no existence leak).
 */
export async function requireProjectCompanies(
  db: Db,
  a: ProjectCompanyActor,
  ids: readonly (string | null | undefined)[],
  /** `dryRun`: check only (previews), put nothing on the project. */
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const list = unique(ids);
  if (!list.length) return;
  const on = await db
    .select({ id: projectCompanies.companyId })
    .from(projectCompanies)
    .where(and(eq(projectCompanies.projectId, a.project.id), inArray(projectCompanies.companyId, list)));
  const onIds = new Set(on.map((r) => r.id));
  const missing = list.filter((id) => !onIds.has(id));
  if (!missing.length) return;
  if (!a.isProjectAdmin) throw badRequest(msg("projects:errors.companyNotInProject"));
  const visible = await visibleCompanyIds(db, a.user);
  if (visible && missing.some((id) => !visible.has(id))) throw badRequest(msg("projects:errors.companyNotInProject"));
  const existing = await db.select({ id: companies.id }).from(companies).where(inArray(companies.id, missing));
  if (existing.length !== missing.length) throw badRequest(msg("projects:errors.companyNotInProject"));
  if (!opts.dryRun) await linkProjectCompanies(db, a.project.id, missing);
}

/**
 * Puts every company the project already refers to on the project: members (or their own company),
 * template slots, task teams, invitations, issues, works, receipts, transmittal recipients, folder
 * permissions and workflow assignees. Same sources as migration 0060_project_companies. Run after
 * internal writes that bring companies in (project from a template, template parts).
 */
export async function syncProjectCompanies(db: Db, projectId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_companies (project_id, company_id)
    SELECT DISTINCT ${projectId}::uuid, u.company_id
    FROM (
      SELECT coalesce(pm.company_id, us.company_id) AS company_id FROM project_members pm JOIN users us ON us.id = pm.user_id WHERE pm.project_id = ${projectId}
      UNION SELECT company_id FROM project_slots WHERE project_id = ${projectId}
      UNION SELECT company_id FROM project_roles WHERE project_id = ${projectId}
      UNION SELECT company_id FROM invitations WHERE project_id = ${projectId}
      UNION SELECT assignee_company_id FROM issues WHERE project_id = ${projectId}
      UNION SELECT owner_company_id FROM works WHERE project_id = ${projectId}
      UNION SELECT from_company_id FROM works WHERE project_id = ${projectId}
      UNION SELECT unnest(to_company_ids) FROM works WHERE project_id = ${projectId}
      UNION SELECT unnest(cc_company_ids) FROM works WHERE project_id = ${projectId}
      UNION SELECT r.company_id FROM work_receipts r JOIN works w ON w.id = r.work_id WHERE w.project_id = ${projectId}
      UNION SELECT unnest(recipient_company_ids) FROM workflow_template_work_options WHERE project_id = ${projectId}
      UNION SELECT g.subject_id FROM folder_grants g JOIN folders f ON f.id = g.folder_id WHERE f.project_id = ${projectId} AND g.subject_type = 'company'
      UNION SELECT c.id FROM workflow_templates t
        CROSS JOIN LATERAL jsonb_path_query(t.steps, 'lax $.**.assignees[*] ? (@.type == "company").id') AS a(v)
        JOIN companies c ON c.id::text = (a.v #>> '{}')
        WHERE t.project_id = ${projectId}
    ) u
    JOIN companies c ON c.id = u.company_id
    ON CONFLICT DO NOTHING`);
}

/** Is the company still used in the project (blocks taking it off)? */
export async function companyUsedInProject(db: Db, projectId: string, companyId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM (
      SELECT coalesce(pm.company_id, us.company_id) AS company_id FROM project_members pm JOIN users us ON us.id = pm.user_id WHERE pm.project_id = ${projectId}
      UNION ALL SELECT company_id FROM project_slots WHERE project_id = ${projectId}
      UNION ALL SELECT company_id FROM project_roles WHERE project_id = ${projectId}
      UNION ALL SELECT assignee_company_id FROM issues WHERE project_id = ${projectId}
      UNION ALL SELECT owner_company_id FROM works WHERE project_id = ${projectId}
      UNION ALL SELECT from_company_id FROM works WHERE project_id = ${projectId}
      UNION ALL SELECT unnest(to_company_ids) FROM works WHERE project_id = ${projectId}
      UNION ALL SELECT unnest(cc_company_ids) FROM works WHERE project_id = ${projectId}
      UNION ALL SELECT g.subject_id FROM folder_grants g JOIN folders f ON f.id = g.folder_id WHERE f.project_id = ${projectId} AND g.subject_type = 'company'
    ) u WHERE u.company_id = ${companyId} LIMIT 1`);
  const r = res as unknown as { rows?: unknown[] } | unknown[];
  return (Array.isArray(r) ? r : (r.rows ?? [])).length > 0;
}
