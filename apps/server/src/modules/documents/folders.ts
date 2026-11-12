import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PERMISSION_LEVELS,
  can,
  effectivePermission,
  isDowngrade,
  type FolderDto,
  type GrantDto,
  type Principal,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, projectAccess, requireAction, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { companies, fileVersions, files, folderGrants, folders, namingStandards, projectRoles } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";
import { toFileDto } from "./mapper.js";
import { virtualFolderDtos } from "../../projects/project-templates.js";

export const folderName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((n) => !/[\\/:*?"<>|]/.test(n), "Klasör adında \\ / : * ? \" < > | kullanılamaz."); // i18n-ok: zod issue detail (validation details stay untranslated)

export async function folderRoutes(api: FastifyInstance, { db }: AppDeps) {
  /** Folder with the caller's level, plus the visible path from the root (breadcrumb). */
  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.visible(a.principal, req.params.fid)) throw notFound(msg("documents:entities.folder"));
    const path = tree
      .ancestry(req.params.fid)
      .filter((id) => tree.visible(a.principal, id))
      .map((id) => toFolderDto(tree, a.principal, id));
    return { ...toFolderDto(tree, a.principal, req.params.fid), path };
  });

  /** Visible subfolders and the files the caller may see. */
  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/contents", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const fid = req.params.fid;
    if (!tree.visible(a.principal, fid)) throw notFound(msg("documents:entities.folder"));
    const subfolders = (tree.children.get(fid) ?? [])
      .filter((f) => tree.visible(a.principal, f.id))
      .map((f) => toFolderDto(tree, a.principal, f.id));
    const perm = tree.permission(a.principal, fid);
    let fileDtos: Awaited<ReturnType<typeof toFileDto>>[] = [];
    if (perm.level !== "none") {
      const rows = await db
        .select()
        .from(files)
        .innerJoin(
          fileVersions,
          and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)),
        )
        .where(and(eq(files.folderId, fid), isNull(files.deletedAt)));
      // Upload-only users see just their own files.
      const visible = can(perm.level, "view") ? rows : rows.filter((r) => r.files.createdBy === a.user.id);
      const names = await userNames(db, visible.map((r) => r.file_versions.uploadedBy));
      fileDtos = visible
        .map((r) => toFileDto(r.files, r.file_versions, names))
        .sort((x, y) => x.name.localeCompare(y.name, "tr"));
    }
    // Folders a project template planned here but created only when their first file arrives.
    const virtualFolders = perm.level !== "none" ? await virtualFolderDtos(db, tree, fid) : [];
    return { folder: toFolderDto(tree, a.principal, fid), folders: subfolders, files: fileDtos, virtualFolders };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/folders", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ parentId: z.string().uuid(), name: folderName }).parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    requireAction(tree, a, body.parentId, "manage");
    const [row] = await db
      .insert(folders)
      .values({ projectId: a.project.id, parentId: body.parentId, name: body.name, createdBy: a.user.id })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.created",
      targetType: "folder",
      targetId: row!.id,
      details: { name: body.name, parentId: body.parentId },
    });
    const fresh = await FolderTree.load(db, a.project.id);
    return toFolderDto(fresh, a.principal, row!.id);
  });

  api.patch<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({
        name: folderName.optional(),
        state: z.enum(["wip", "shared", "published", "archived"]).nullable().optional(),
        stateLabel: z.string().trim().max(80).nullable().optional(),
        namingStandardId: z.string().uuid().nullable().optional(),
        parentId: z.string().uuid().optional(),
        description: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    const folder = tree.get(req.params.fid);
    const descriptionOnly = Object.keys(body).every((k) => k === "description");
    requireAction(tree, a, folder.id, descriptionOnly ? "edit" : "manage");
    if (body.parentId !== undefined) {
      if (!folder.parentId) throw badRequest(msg("documents:errors.rootFolderMove"));
      requireAction(tree, a, body.parentId, "manage");
      if (body.parentId === folder.id || tree.descendants(folder.id).includes(body.parentId))
        throw badRequest(msg("documents:errors.folderIntoItself"));
    }
    if (body.name !== undefined && !folder.parentId) throw badRequest(msg("documents:errors.rootFolderRename"));
    if (body.namingStandardId) {
      const [std] = await db
        .select({ id: namingStandards.id })
        .from(namingStandards)
        .where(and(eq(namingStandards.id, body.namingStandardId), eq(namingStandards.projectId, a.project.id)));
      if (!std) throw notFound(msg("documents:entities.namingStandard"));
    }
    const { stateLabel, description, ...rest } = body;
    await db
      .update(folders)
      .set({
        ...rest,
        ...(stateLabel !== undefined ? { stateLabel: stateLabel || null } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
      })
      .where(eq(folders.id, folder.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.updated",
      targetType: "folder",
      targetId: folder.id,
      details: body,
    });
    const fresh = await FolderTree.load(db, a.project.id);
    return toFolderDto(fresh, a.principal, folder.id);
  });

  /** Soft delete of the folder, its subfolders and their files. */
  api.delete<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const folder = tree.get(req.params.fid);
    if (!folder.parentId) throw badRequest(msg("documents:errors.rootFolderDelete"));
    requireAction(tree, a, folder.id, "manage");
    const ids = [folder.id, ...tree.descendants(folder.id)];
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(files).set({ deletedAt: now }).where(and(inArray(files.folderId, ids), isNull(files.deletedAt)));
      await tx.update(folders).set({ deletedAt: now }).where(inArray(folders.id, ids));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.deleted",
      targetType: "folder",
      targetId: folder.id,
      details: { name: folder.name, folders: ids.length },
    });
    return { ok: true, deletedFolders: ids.length };
  });

  // ---- Permissions -----------------------------------------------------------------------

  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/permissions", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    requireAction(tree, a, req.params.fid, "manage");
    return listGrants(db, tree, req.params.fid);
  });

  const entrySchema = z.object({
    subjectType: z.enum(["user", "company", "role"]),
    subjectId: z.string().uuid(),
    level: z.enum(PERMISSION_LEVELS),
  });

  /**
   * mode "add" (default) only sets subjects that have no direct grant on this folder yet;
   * "replace" overwrites direct grants. A subfolder grant may not be lower than what the
   * subject already inherits (as in Forma).
   */
  api.put<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/permissions", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({ entries: z.array(entrySchema).min(1).max(500), mode: z.enum(["add", "replace"]).default("add") })
      .parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    const folder = tree.get(req.params.fid);
    requireAction(tree, a, folder.id, "manage");
    const roleSubjects = [...new Set(body.entries.filter((e) => e.subjectType === "role").map((e) => e.subjectId))];
    if (roleSubjects.length) {
      const rows = await db
        .select({ id: projectRoles.id })
        .from(projectRoles)
        .where(and(eq(projectRoles.projectId, a.project.id), inArray(projectRoles.id, roleSubjects)));
      if (rows.length !== roleSubjects.length) throw notFound(msg("documents:entities.role"));
    }
    const parentChain = folder.parentId ? tree.ancestry(folder.parentId) : [];
    const direct = new Set(
      tree.grants.filter((g) => g.folderId === folder.id).map((g) => `${g.subjectType}:${g.subjectId}`),
    );
    const results: { subjectType: string; subjectId: string; level: string; status: string }[] = [];
    for (const e of body.entries) {
      const key = `${e.subjectType}:${e.subjectId}`;
      if (body.mode === "add" && direct.has(key)) {
        results.push({ ...e, status: "skipped_existing" });
        continue;
      }
      const inherited = inheritedLevel(tree, parentChain, e.subjectType, e.subjectId);
      if (e.level !== "none" && isDowngrade(inherited, e.level)) {
        results.push({ ...e, status: `rejected_lower_than_inherited:${inherited}` });
        continue;
      }
      if (e.level === "none") {
        await db
          .delete(folderGrants)
          .where(
            and(
              eq(folderGrants.folderId, folder.id),
              eq(folderGrants.subjectType, e.subjectType),
              eq(folderGrants.subjectId, e.subjectId),
            ),
          );
      } else {
        await db
          .insert(folderGrants)
          .values({ folderId: folder.id, ...e })
          .onConflictDoUpdate({
            target: [folderGrants.folderId, folderGrants.subjectType, folderGrants.subjectId],
            set: { level: e.level },
          });
      }
      results.push({ ...e, status: "ok" });
    }
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.permissions_set",
      targetType: "folder",
      targetId: folder.id,
      details: { mode: body.mode, results },
    });
    return { results, grants: await listGrants(db, await FolderTree.load(db, a.project.id), folder.id) };
  });
}

function inheritedLevel(tree: FolderTree, chain: string[], subjectType: string, subjectId: string) {
  // Level the subject gets from the parent chain through this exact subject only.
  const principal: Principal =
    subjectType === "user"
      ? { userId: subjectId }
      : subjectType === "company"
        ? { userId: "", companyId: subjectId }
        : { userId: "", roleIds: [subjectId] };
  return effectivePermission(principal, chain, tree.grants).level;
}

async function listGrants(db: Db, tree: FolderTree, folderId: string): Promise<GrantDto[]> {
  const chain = tree.ancestry(folderId);
  const own = tree.grants.filter((g) => g.folderId === folderId);
  const inheritedOnly = tree.grants.filter(
    (g) =>
      g.folderId !== folderId &&
      chain.includes(g.folderId) &&
      !own.some((o) => o.subjectType === g.subjectType && o.subjectId === g.subjectId),
  );
  // Keep the strongest inherited grant per subject.
  const best = new Map<string, (typeof inheritedOnly)[number]>();
  for (const g of inheritedOnly) {
    const key = `${g.subjectType}:${g.subjectId}`;
    const cur = best.get(key);
    if (!cur || PERMISSION_LEVELS.indexOf(g.level) > PERMISSION_LEVELS.indexOf(cur.level)) best.set(key, g);
  }
  const all = [
    ...own.map((g) => ({ ...g, inherited: false })),
    ...[...best.values()].map((g) => ({ ...g, inherited: true })),
  ];
  const userIds = all.filter((g) => g.subjectType === "user").map((g) => g.subjectId);
  const companyIds = all.filter((g) => g.subjectType === "company").map((g) => g.subjectId);
  const names = await userNames(db, userIds);
  const companyRows = companyIds.length
    ? await db.select().from(companies).where(inArray(companies.id, companyIds))
    : [];
  const cnames = new Map(companyRows.map((c) => [c.id, c.name]));
  const roleIds = all.filter((g) => g.subjectType === "role").map((g) => g.subjectId);
  const roleRows = roleIds.length
    ? await db.select({ id: projectRoles.id, name: projectRoles.name }).from(projectRoles).where(inArray(projectRoles.id, roleIds))
    : [];
  const rnames = new Map(roleRows.map((r) => [r.id, r.name]));
  return all.map((g) => ({
    folderId: g.folderId,
    subjectType: g.subjectType,
    subjectId: g.subjectId,
    level: g.level,
    inherited: g.inherited,
    subjectName:
      g.subjectType === "user" ? names.get(g.subjectId) : g.subjectType === "company" ? cnames.get(g.subjectId) : rnames.get(g.subjectId),
  }));
}

export function toFolderDto(tree: FolderTree, principal: Principal, id: string): FolderDto {
  const f = tree.get(id);
  const perm = tree.permission(principal, id);
  return {
    id: f.id,
    projectId: f.projectId,
    parentId: f.parentId,
    name: f.name,
    description: f.description ?? null,
    state: f.state,
    stateLabel: f.stateLabel ?? null,
    namingStandardId: f.namingStandardId,
    myLevel: perm.level,
    canUpload: perm.canUpload,
    hasChildren: (tree.children.get(id) ?? []).some((c) => tree.visible(principal, c.id)),
  };
}
