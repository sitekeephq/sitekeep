/**
 * Project roles (teams), role packages and "who can see this folder / file?".
 *
 * - Roles: CRUD by project admins; members may hold several roles. Roles are folder-permission
 *   subjects and workflow step assignees.
 * - Role packages: explicit, previewable company-level folder grants per party (KONSEPT §4).
 * - Who can see: every member with their effective level and the grants behind it.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_PROJECT_ROLES,
  rolePackage,
  ROLE_PACKAGE_KEYS,
  WRITING_ACTIONS,
  can,
  explainAccess,
  rank,
  type ProjectRoleDto,
  type RolePackagePlanDto,
  type WhoCanSeeDto,
  type WhoCanSeeEntryDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, requireProjectAdmin, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import {
  companies,
  files,
  folderGrants,
  memberRoles,
  projectMembers,
  projectRoles,
  users,
  workflowInstances,
  workflowTemplates,
} from "../db/schema.js";
import { badRequest, conflict, notFound } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, requestLanguage } from "../i18n/index.js";
import { ensureDefaultProjectRoles, ensureProjectAdminsHoldAdminRole } from "../core/security/default-roles.js";
import { explainFolderAccess, folderPath, planRolePackage } from "../core/security/roles.js";

const roleBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Renk #rrggbb biçiminde olmalı.") // i18n-ok: zod issue detail (validation details stay untranslated)
    .nullable()
    .optional(),
});

const packageBody = z.object({
  companyId: z.string().uuid(),
  package: z.enum(ROLE_PACKAGE_KEYS),
  areaFolderId: z.string().uuid().nullable().optional(),
});

export async function roleRoutes(api: FastifyInstance, { db }: AppDeps) {
  // ---- Roles -------------------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/roles", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const ids = await ensureDefaultProjectRoles(db, a.project.id, a.project.rootFolderId);
    const adminRoleId = ids["Yönetici"]; // i18n-ok: default role name stored as data
    if (adminRoleId) await ensureProjectAdminsHoldAdminRole(db, a.project.id, adminRoleId);
    return listRoles(db, a.project.id);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/roles", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = roleBody.parse(req.body);
    const [row] = await db
      .insert(projectRoles)
      .values({ projectId: a.project.id, name: body.name, description: body.description ?? null, color: body.color ?? null })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role.created",
      targetType: "role",
      targetId: row!.id,
      details: { name: body.name },
    });
    return { ...toRoleDto(row!), memberIds: [] };
  });

  api.patch<{ Params: { pid: string; rid: string } }>("/projects/:pid/roles/:rid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const role = await loadRole(db, a, req.params.rid);
    const body = roleBody.partial().parse(req.body);
    await db.update(projectRoles).set(body).where(eq(projectRoles.id, role.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role.updated",
      targetType: "role",
      targetId: role.id,
      details: { name: body.name ?? role.name, ...body },
    });
    return (await listRoles(db, a.project.id)).find((r) => r.id === role.id)!;
  });

  /**
   * Deleting a role removes its memberships and folder grants. A role still used by a workflow
   * template or a running workflow cannot be deleted (reassign those steps first).
   */
  api.delete<{ Params: { pid: string; rid: string } }>("/projects/:pid/roles/:rid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const role = await loadRole(db, a, req.params.rid);
    const usedBy = (steps: { assignees: { type: string; id: string }[] }[]) =>
      steps.some((s) => s.assignees.some((x) => x.type === "role" && x.id === role.id));
    const templates = (
      await db
        .select({ name: workflowTemplates.name, steps: workflowTemplates.steps })
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.projectId, a.project.id), isNull(workflowTemplates.archivedAt)))
    ).filter((t) => usedBy(t.steps));
    const running = (
      await db
        .select({ template: workflowInstances.template })
        .from(workflowInstances)
        .where(and(eq(workflowInstances.projectId, a.project.id), eq(workflowInstances.status, "running")))
    ).filter((i) => usedBy(i.template.steps));
    if (templates.length || running.length)
      throw conflict(
        templates.length && running.length
          ? msg("access:errors.roleInUseBoth", { name: role.name, templates: templates.map((t) => t.name).join(", "), count: running.length })
          : templates.length
            ? msg("access:errors.roleInUseTemplates", { name: role.name, templates: templates.map((t) => t.name).join(", ") })
            : msg("access:errors.roleInUseRunning", { name: role.name, count: running.length }),
      );
    const removed = await db.transaction(async (tx) => {
      const grants = await tx
        .delete(folderGrants)
        .where(and(eq(folderGrants.subjectType, "role"), eq(folderGrants.subjectId, role.id)))
        .returning();
      await tx.delete(projectRoles).where(eq(projectRoles.id, role.id));
      return grants.length;
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role.deleted",
      targetType: "role",
      targetId: role.id,
      details: { name: role.name, removedGrants: removed },
    });
    return { ok: true, removedGrants: removed };
  });

  api.post<{ Params: { pid: string; rid: string; uid: string } }>("/projects/:pid/roles/:rid/members/:uid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const role = await loadRole(db, a, req.params.rid);
    await requireMember(db, a, req.params.uid);
    await db
      .insert(memberRoles)
      .values({ projectId: a.project.id, userId: req.params.uid, roleId: role.id })
      .onConflictDoNothing();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role.member_added",
      targetType: "user",
      targetId: req.params.uid,
      details: { name: role.name, roleId: role.id },
    });
    return (await listRoles(db, a.project.id)).find((r) => r.id === role.id)!;
  });

  api.delete<{ Params: { pid: string; rid: string; uid: string } }>("/projects/:pid/roles/:rid/members/:uid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const role = await loadRole(db, a, req.params.rid);
    if (!isUuid(req.params.uid)) throw notFound(msg("access:entities.member"));
    await db.delete(memberRoles).where(and(eq(memberRoles.roleId, role.id), eq(memberRoles.userId, req.params.uid)));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role.member_removed",
      targetType: "user",
      targetId: req.params.uid,
      details: { name: role.name, roleId: role.id },
    });
    return (await listRoles(db, a.project.id)).find((r) => r.id === role.id)!;
  });

  /** Replaces the roles of one member. */
  api.put<{ Params: { pid: string; uid: string } }>("/projects/:pid/members/:uid/roles", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ roleIds: z.array(z.string().uuid()).max(200) }).parse(req.body);
    await requireMember(db, a, req.params.uid);
    const roleIds = [...new Set(body.roleIds)];
    if (roleIds.length) {
      const rows = await db
        .select({ id: projectRoles.id })
        .from(projectRoles)
        .where(and(eq(projectRoles.projectId, a.project.id), inArray(projectRoles.id, roleIds)));
      if (rows.length !== roleIds.length) throw notFound(msg("access:entities.role"));
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(memberRoles)
        .where(and(eq(memberRoles.projectId, a.project.id), eq(memberRoles.userId, req.params.uid)));
      if (roleIds.length)
        await tx
          .insert(memberRoles)
          .values(roleIds.map((roleId) => ({ projectId: a.project.id, userId: req.params.uid, roleId })));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "member.roles_set",
      targetType: "user",
      targetId: req.params.uid,
      details: { roleIds },
    });
    return { ok: true, roleIds };
  });

  // ---- Role packages -----------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/role-packages", async (req) => {
    await projectAccess(db, req.params.pid, req.user!);
    return ROLE_PACKAGE_KEYS.map((k) => rolePackage(k, requestLanguage(req)));
  });

  /** The grants applying a package would write; nothing is changed. */
  api.get<{ Params: { pid: string }; Querystring: Record<string, string | undefined> }>(
    "/projects/:pid/role-packages/preview",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      requireProjectAdmin(a);
      const body = packageBody.parse({
        companyId: req.query.companyId,
        package: req.query.package,
        areaFolderId: req.query.areaFolderId || null,
      });
      return rolePackagePlan(db, a, body, false);
    },
  );

  api.post<{ Params: { pid: string } }>("/projects/:pid/role-packages/apply", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = packageBody.parse(req.body);
    const plan = await rolePackagePlan(db, a, body, true);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "role_package.applied",
      targetType: "company",
      targetId: body.companyId,
      details: {
        name: `${rolePackage(body.package, DEFAULT_LANGUAGE).label} → ${plan.companyName}`,
        package: body.package,
        areaFolderId: plan.areaFolderId,
        count: plan.writes,
        results: plan.entries.map((e) => ({ folderId: e.folderId, level: e.level, action: e.action })),
      },
    });
    return plan;
  });

  // ---- Who can see? ------------------------------------------------------------------------

  api.get<{ Params: { pid: string; fid: string }; Querystring: { fileId?: string } }>(
    "/projects/:pid/folders/:fid/who-can-see",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const tree = await FolderTree.load(db, a.project.id);
      const fid = req.params.fid;
      if (!isUuid(fid) || !tree.byId.has(fid)) throw notFound(msg("access:entities.folder"));
      requireAction(tree, a, fid, "view");
      let file: { id: string; name: string; createdBy: string | null } | null = null;
      if (req.query.fileId) {
        if (!isUuid(req.query.fileId)) throw notFound(msg("access:entities.file"));
        const [row] = await db
          .select({ id: files.id, name: files.name, createdBy: files.createdBy })
          .from(files)
          .where(and(eq(files.id, req.query.fileId), eq(files.folderId, fid), isNull(files.deletedAt)));
        if (!row) throw notFound(msg("access:entities.file"));
        file = row;
      }
      return whoCanSee(db, a, tree, fid, file, requestLanguage(req));
    },
  );
}

// ---- Helpers --------------------------------------------------------------------------------

function toRoleDto(r: typeof projectRoles.$inferSelect): Omit<ProjectRoleDto, "memberIds"> {
  return { id: r.id, projectId: r.projectId, name: r.name, description: r.description, color: r.color };
}

export async function listRoles(db: Db, projectId: string): Promise<ProjectRoleDto[]> {
  const rows = await db
    .select()
    .from(projectRoles)
    .where(eq(projectRoles.projectId, projectId))
    .orderBy(asc(projectRoles.name));
  const links = await db.select().from(memberRoles).where(eq(memberRoles.projectId, projectId));
  const rankDefault = (name: string) => DEFAULT_PROJECT_ROLES.findIndex((r) => r.name === name);
  return rows
    .map((r) => ({ ...toRoleDto(r), memberIds: links.filter((l) => l.roleId === r.id).map((l) => l.userId) }))
    .sort((a, b) => {
      const da = rankDefault(a.name);
      const db_ = rankDefault(b.name);
      if (da >= 0 && db_ >= 0) return da - db_;
      if (da >= 0) return -1;
      if (db_ >= 0) return 1;
      return a.name.localeCompare(b.name, "tr");
    });
}

async function loadRole(db: Db, a: ProjectAccess, rid: string) {
  if (!isUuid(rid)) throw notFound(msg("access:entities.role"));
  const [row] = await db
    .select()
    .from(projectRoles)
    .where(and(eq(projectRoles.id, rid), eq(projectRoles.projectId, a.project.id)));
  if (!row) throw notFound(msg("access:entities.role"));
  return row;
}

async function requireMember(db: Db, a: ProjectAccess, uid: string) {
  if (!isUuid(uid)) throw notFound(msg("access:entities.member"));
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, uid)));
  if (!m) throw notFound(msg("access:entities.member"));
  return m;
}

/** Members with their effective company (project membership first, then the user's company). */
async function memberPrincipals(db: Db, projectId: string) {
  const rows = await db
    .select({ m: projectMembers, u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  const links = await db.select().from(memberRoles).where(eq(memberRoles.projectId, projectId));
  return rows.map(({ m, u }) => ({
    user: u,
    companyId: m.companyId ?? u.companyId,
    roleIds: links.filter((l) => l.userId === u.id).map((l) => l.roleId),
    projectAdmin: m.isProjectAdmin || u.isAdmin,
    systemAdmin: u.isAdmin && !m.isProjectAdmin,
  }));
}

async function rolePackagePlan(
  db: Db,
  a: ProjectAccess,
  body: z.infer<typeof packageBody>,
  apply: boolean,
): Promise<RolePackagePlanDto> {
  const [company] = await db.select().from(companies).where(eq(companies.id, body.companyId));
  if (!company) throw notFound(msg("access:entities.company"));
  const tree = await FolderTree.load(db, a.project.id);
  const areaFolderId = body.areaFolderId ?? null;
  if (areaFolderId) {
    if (!tree.byId.has(areaFolderId)) throw notFound(msg("access:entities.areaFolder"));
    if (!tree.get(areaFolderId).parentId) throw badRequest(msg("access:errors.areaFolderIsRoot"));
  }
  const entries = planRolePackage(tree, company.id, rolePackage(body.package), areaFolderId);
  const writes = entries.filter((e) => WRITING_ACTIONS.includes(e.action));
  if (apply && writes.length) {
    await db.transaction(async (tx) => {
      for (const e of writes)
        await tx
          .insert(folderGrants)
          .values({ folderId: e.folderId, subjectType: "company", subjectId: company.id, level: e.level })
          .onConflictDoUpdate({
            target: [folderGrants.folderId, folderGrants.subjectType, folderGrants.subjectId],
            set: { level: e.level },
          });
    });
  }
  const members = await memberPrincipals(db, a.project.id);
  return {
    package: body.package,
    companyId: company.id,
    companyName: company.name,
    memberCount: members.filter((m) => m.companyId === company.id).length,
    areaFolderId,
    entries,
    writes: writes.length,
    applied: apply,
  };
}

async function whoCanSee(
  db: Db,
  a: ProjectAccess,
  tree: FolderTree,
  folderId: string,
  file: { id: string; name: string; createdBy: string | null } | null,
  lang: string,
): Promise<WhoCanSeeDto> {
  const members = await memberPrincipals(db, a.project.id);
  const roles = await db
    .select({ id: projectRoles.id, name: projectRoles.name })
    .from(projectRoles)
    .where(eq(projectRoles.projectId, a.project.id));
  const roleNames = new Map(roles.map((r) => [r.id, r.name]));
  const companyIds = [
    ...new Set([
      ...members.map((m) => m.companyId).filter((x): x is string => !!x),
      ...tree.grants.filter((g) => g.subjectType === "company").map((g) => g.subjectId),
    ]),
  ];
  const companyRows = companyIds.length ? await db.select().from(companies).where(inArray(companies.id, companyIds)) : [];
  const companyNames = new Map(companyRows.map((c) => [c.id, c.name]));

  const entries: WhoCanSeeEntryDto[] = members.map((m) => {
    const ex = explainFolderAccess(tree, { userId: m.user.id, companyId: m.companyId, roleIds: m.roleIds, projectAdmin: m.projectAdmin, systemAdmin: m.systemAdmin }, folderId);
    for (const r of ex.reasons)
      r.subjectName =
        r.via === "company" ? companyNames.get(r.subjectId!) : r.via === "role" ? roleNames.get(r.subjectId!) : undefined;
    const canSee =
      ex.level !== "none" && (can(ex.level, "view") || (ex.level === "upload_only" && (!file || file.createdBy === m.user.id)));
    const entry = {
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      companyName: m.companyId ? (companyNames.get(m.companyId) ?? null) : null,
      roleNames: m.roleIds.map((r) => roleNames.get(r)).filter((x): x is string => !!x),
      disabled: m.user.disabled,
      level: ex.level,
      canUpload: ex.canUpload,
      canSee,
      reasons: ex.reasons,
    };
    return { ...entry, explanation: explainAccess(entry, lang) };
  });
  entries.sort(
    (x, y) => Number(y.canSee) - Number(x.canSee) || rank(y.level) - rank(x.level) || x.name.localeCompare(y.name, "tr"),
  );
  return {
    folderId,
    folderPath: folderPath(tree, folderId),
    fileId: file?.id ?? null,
    fileName: file?.name ?? null,
    entries,
  };
}
