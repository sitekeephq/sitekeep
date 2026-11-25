import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_PROJECT_ROLES, EMAIL_NOTIFY_TYPES, PROJECT_MODULES, type EmailNotifyPrefs, type FolderState, type ProjectModule } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireProjectAdmin, tokenAllowsProject, userNames } from "../core/security/access.js";
import { joinCompanyTeam } from "../cde/teams.js";
import { toAuditDtos } from "../audit/query.js";
import { audit } from "../core/platform/audit.js";
import { ensureCdeSettings } from "../cde/settings.js";
import { auditLog, companies, folders, invitations, memberRoles, projectCompanies, projectMembers, projectRoles, projects, users } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { companyUsedInProject, linkProjectCompanies, listProjectCompanies, projectCompanyIds, requireProjectCompanies } from "./companies.js";
import { msg, tReq } from "../i18n/index.js";
import { projectModules } from "./modules.js";
import { toProjectDto } from "./dto.js";
import { assertProjectCodeFree } from "./project-templates.js";
import { ensureDefaultProjectRoles, ensureProjectAdminsHoldAdminRole } from "../core/security/default-roles.js";

/** ISO 19650 container states as top-level folders (folder names are data, written once in the creator's language). */
const ISO_TEMPLATE: { key: "wip" | "shared" | "published" | "archived"; state: FolderState }[] = [
  { key: "wip", state: "wip" },
  { key: "shared", state: "shared" },
  { key: "published", state: "published" },
  { key: "archived", state: "archived" },
];

export async function projectRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get("/projects", async (req) => {
    const user = req.user!;
    const rows = user.isAdmin
      ? (await db.select().from(projects).orderBy(asc(projects.code))).map((p) => ({ p, admin: true }))
      : (
          await db
            .select({ p: projects, admin: projectMembers.isProjectAdmin })
            .from(projectMembers)
            .innerJoin(projects, eq(projects.id, projectMembers.projectId))
            .where(eq(projectMembers.userId, user.id))
            .orderBy(asc(projects.code))
        );
    return rows.filter(({ p }) => !p.archived && tokenAllowsProject(user, p.id)).map(({ p, admin }) => toProjectDto(p, admin));
  });

  api.post("/projects", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("projects:errors.createAdminOnly"));
    const body = z
      .object({
        code: z.string().trim().min(1).max(40),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
        template: z.enum(["empty", "iso19650"]).default("iso19650"),
      })
      .parse(req.body);
    await assertProjectCodeFree(db, body.code);
    const seedText = tReq(req);
    const project = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({ code: body.code, name: body.name, description: body.description ?? null, createdBy: req.user!.id })
        .returning();
      const [root] = await tx
        .insert(folders)
        .values({ projectId: p!.id, parentId: null, name: seedText("projects:seed.rootFolder"), createdBy: req.user!.id })
        .returning();
      if (body.template === "iso19650") {
        await tx.insert(folders).values(
          ISO_TEMPLATE.map((f) => ({
            projectId: p!.id,
            parentId: root!.id,
            name: seedText(`projects:seed.isoFolders.${f.key}`),
            state: f.state,
            createdBy: req.user!.id,
          })),
        );
      }
      const [updated] = await tx
        .update(projects)
        .set({ rootFolderId: root!.id })
        .where(eq(projects.id, p!.id))
        .returning();
      await tx.insert(projectMembers).values({
        projectId: p!.id,
        userId: req.user!.id,
        companyId: req.user!.companyId,
        isProjectAdmin: true,
      });
      return updated!;
    });
    await ensureCdeSettings(db, project.id);
    await linkProjectCompanies(db, project.id, [req.user!.companyId]);
    await audit(db, { projectId: project.id, userId: req.user!.id, action: "project.created", details: body });
    const roleIds = await ensureDefaultProjectRoles(db, project.id, project.rootFolderId);
    const adminRoleId = roleIds["Yönetici"];  // i18n-ok: data (default role name)
    if (adminRoleId) await ensureProjectAdminsHoldAdminRole(db, project.id, adminRoleId);
    return toProjectDto(project, true);
  });

  api.get<{ Params: { pid: string } }>("/projects/:pid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return toProjectDto(a.project, a.isProjectAdmin);
  });

  api.patch<{ Params: { pid: string } }>("/projects/:pid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.archived === false && a.project.archived) await assertProjectCodeFree(db, a.project.code, a.project.id);
    const [p] = await db.update(projects).set(body).where(eq(projects.id, a.project.id)).returning();
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "project.updated", details: body });
    return toProjectDto(p!, true);
  });

  /** Removes a project from active use without destroying its records. Only system admins may do this. */
  api.delete<{ Params: { pid: string } }>("/projects/:pid", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("projects:errors.deleteAdminOnly"));
    const a = await projectAccess(db, req.params.pid, req.user!);
    if (a.project.archived) throw notFound(msg("projects:entities.project"));
    await db.update(projects).set({ archived: true }).where(eq(projects.id, a.project.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "project.deleted",
      targetType: "project",
      targetId: a.project.id,
      details: { softDelete: true },
    });
    return { ok: true };
  });

  // ---- Module switches -----------------------------------------------------------------

  /** Effective module switches (every module on unless turned off). */
  api.get<{ Params: { pid: string } }>("/projects/:pid/modules", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return projectModules(a.project);
  });

  /** Turns modules on or off. Data of an off module is kept; only new records are refused. */
  api.put<{ Params: { pid: string } }>("/projects/:pid/modules", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z
      .object({ modules: z.partialRecord(z.enum(PROJECT_MODULES), z.boolean()) })
      .parse(req.body);
    const before = projectModules(a.project);
    const modules = { ...before, ...body.modules } as Record<ProjectModule, boolean>;
    const settings = { ...(a.project.settings ?? {}), modules };
    await db.update(projects).set({ settings }).where(eq(projects.id, a.project.id));
    const changed = PROJECT_MODULES.filter((m) => before[m] !== modules[m]);
    if (changed.length)
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "project.modules_updated",
        targetType: "project",
        targetId: a.project.id,
        details: { on: changed.filter((m) => modules[m]), off: changed.filter((m) => !modules[m]) },
      });
    return modules;
  });

  // ---- Workflow e-mail default (docs/features/WORKFLOW_EMAIL.md) -----------------------

  /** The project's default for who gets workflow e-mail (every type on unless turned off). */
  api.get<{ Params: { pid: string } }>("/projects/:pid/email-notifications", async (req): Promise<EmailNotifyPrefs> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return a.project.settings?.emailNotifications ?? {};
  });

  /** Sets the default for members without a choice of their own. Project administrators only. */
  api.put<{ Params: { pid: string } }>("/projects/:pid/email-notifications", async (req): Promise<EmailNotifyPrefs> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.partialRecord(z.enum(EMAIL_NOTIFY_TYPES), z.boolean()).parse(req.body);
    const emailNotifications = { ...(a.project.settings?.emailNotifications ?? {}), ...body };
    await db.update(projects).set({ settings: { ...(a.project.settings ?? {}), emailNotifications } }).where(eq(projects.id, a.project.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "project.email_notifications_updated",
      targetType: "project",
      targetId: a.project.id,
      details: { emailNotifications },
    });
    return emailNotifications;
  });

  // ---- Companies on the project (docs/features/COMPANIES.md) ----------------------------

  /** The companies on the project: what every picker inside the project offers. */
  api.get<{ Params: { pid: string } }>("/projects/:pid/companies", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return listProjectCompanies(db, a.project.id);
  });

  /** Puts a company the caller can see on the project (project administrators). */
  api.post<{ Params: { pid: string } }>("/projects/:pid/companies", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ companyId: z.string().uuid() }).parse(req.body);
    const before = await projectCompanyIds(db, a.project.id);
    await requireProjectCompanies(db, a, [body.companyId]);
    if (!before.has(body.companyId))
      await audit(db, { projectId: a.project.id, userId: a.user.id, action: "project.company_added", targetType: "company", targetId: body.companyId });
    return listProjectCompanies(db, a.project.id);
  });

  /** Takes a company off the project; refused while members, roles, permissions or records use it. */
  api.delete<{ Params: { pid: string; cid: string } }>("/projects/:pid/companies/:cid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const companyId = z.string().uuid().parse(req.params.cid);
    if (await companyUsedInProject(db, a.project.id, companyId)) throw conflict(msg("projects:errors.companyInUse"));
    const rows = await db
      .delete(projectCompanies)
      .where(and(eq(projectCompanies.projectId, a.project.id), eq(projectCompanies.companyId, companyId)))
      .returning();
    if (rows.length)
      await audit(db, { projectId: a.project.id, userId: a.user.id, action: "project.company_removed", targetType: "company", targetId: companyId });
    return { ok: true };
  });

  // ---- Members -------------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/members", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        companyId: projectMembers.companyId,
        companyName: companies.name,
        isProjectAdmin: projectMembers.isProjectAdmin,
        pending: users.pending,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(companies, eq(companies.id, projectMembers.companyId))
      .where(eq(projectMembers.projectId, a.project.id))
      .orderBy(asc(users.name));
    const links = await db.select().from(memberRoles).where(eq(memberRoles.projectId, a.project.id));
    return rows.map((r) => ({ ...r, roleIds: links.filter((l) => l.userId === r.userId).map((l) => l.roleId) }));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/members", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        companyId: z.string().uuid().nullable().optional(),
        isProjectAdmin: z.boolean().default(false),
        roleId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!user) throw notFound(msg("projects:entities.userCreateFirst"));
    // A chosen company must be on the project (or be put on it); the person's own company comes with them.
    if (body.companyId) await requireProjectCompanies(db, a, [body.companyId]);
    else await linkProjectCompanies(db, a.project.id, [user.companyId]);
    await ensureDefaultProjectRoles(db, a.project.id, a.project.rootFolderId);
    let roleId = body.roleId ?? null;
    let chosenName: string | undefined;
    if (roleId) {
      const [role] = await db
        .select({ id: projectRoles.id, name: projectRoles.name })
        .from(projectRoles)
        .where(and(eq(projectRoles.id, roleId), eq(projectRoles.projectId, a.project.id)));
      if (!role) throw notFound(msg("projects:entities.role"));
      roleId = role.id;
      chosenName = role.name;
    }
    const isProjectAdmin =
      body.isProjectAdmin || chosenName === DEFAULT_PROJECT_ROLES.find((r) => r.projectAdmin)?.name;
    await db
      .insert(projectMembers)
      .values({
        projectId: a.project.id,
        userId: user.id,
        companyId: body.companyId ?? user.companyId,
        isProjectAdmin,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { companyId: body.companyId ?? user.companyId, isProjectAdmin },
      });
    if (roleId) {
      await db
        .insert(memberRoles)
        .values({ projectId: a.project.id, userId: user.id, roleId })
        .onConflictDoNothing();
    }
    await joinCompanyTeam(db, a.project.id, user.id, body.companyId ?? user.companyId);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "member.added",
      targetType: "user",
      targetId: user.id,
      details: { ...body, isProjectAdmin, roleId: roleId ?? null },
    });
    return { ok: true, userId: user.id, roleId: roleId ?? null };
  });

  api.patch<{ Params: { pid: string; uid: string } }>("/projects/:pid/members/:uid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z
      .object({ companyId: z.string().uuid().nullable().optional(), isProjectAdmin: z.boolean().optional() })
      .parse(req.body);
    if (body.companyId) await requireProjectCompanies(db, a, [body.companyId]);
    const rows = await db
      .update(projectMembers)
      .set(body)
      .where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, req.params.uid)))
      .returning();
    if (!rows.length) throw notFound(msg("projects:entities.member"));
    if (body.companyId) await joinCompanyTeam(db, a.project.id, req.params.uid, body.companyId);
    if (body.isProjectAdmin === true) {
      const roleIds = await ensureDefaultProjectRoles(db, a.project.id, a.project.rootFolderId);
      const adminRoleId = roleIds["Yönetici"];  // i18n-ok: data (default role name)
      if (adminRoleId) {
        await db
          .insert(memberRoles)
          .values({ projectId: a.project.id, userId: req.params.uid, roleId: adminRoleId })
          .onConflictDoNothing();
      }
    }
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "member.updated",
      targetType: "user",
      targetId: req.params.uid,
      details: body,
    });
    return { ok: true };
  });

  api.delete<{ Params: { pid: string; uid: string } }>("/projects/:pid/members/:uid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    if (req.params.uid === a.user.id) throw badRequest(msg("projects:errors.cannotRemoveSelf"));
    const rows = await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, req.params.uid)))
      .returning();
    if (!rows.length) throw notFound(msg("projects:entities.member"));
    // A removed invited member's open invitation to this project ends too (docs/features/INVITATIONS.md).
    await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.projectId, a.project.id), eq(invitations.userId, req.params.uid), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "member.removed",
      targetType: "user",
      targetId: req.params.uid,
    });
    return { ok: true };
  });

  // ---- Activity ------------------------------------------------------------------------

  api.get<{ Params: { pid: string }; Querystring: { limit?: string; before?: string } }>(
    "/projects/:pid/activity",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      requireProjectAdmin(a);
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
      const before = Number(req.query.before);
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.projectId, a.project.id), Number.isFinite(before) ? lt(auditLog.id, before) : undefined),
        )
        .orderBy(desc(auditLog.id))
        .limit(limit);
      const names = await userNames(db, rows.map((r) => r.userId));
      // ISO-5: rows about a task team's WIP closed to this administrator keep only their action.
      const viewer = { tree: await FolderTree.load(db, a.project.id), principal: a.principal };
      const withheld = new Set(
        (await toAuditDtos(db, rows, { client: false, viewer })).filter((e) => e.details?.withheld === "task_team_wip").map((e) => e.id),
      );
      return rows.map((r) => ({
        ...r,
        ...(withheld.has(r.id) && { details: { withheld: "task_team_wip" } }),
        at: r.at.toISOString(),
        userName: r.userId ? names.get(r.userId) : undefined,
      }));
    },
  );
}
